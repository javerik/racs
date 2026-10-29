use std::fmt::{Display, Formatter};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aravis_port::memory::{BufferPoolHandle, BufferStatus};
use aravis_port::StreamHandle;
use jpeg_encoder::EncodingError as JpegError;
use futures::StreamExt;
use tokio::sync::mpsc::{Receiver, Sender};
use tracing::{debug, warn};

use crate::app_context::ArcBoxedCameraStore;
use crate::controller::frame_codec;
use crate::controller::live_hub::{Geometry, LiveHub, LiveHubs, Viewer};
use crate::controller::transport::{self, PACKET_SIZE_FEATURE};
use crate::controller::stream_ctrl::StreamCtrlError::EncodingError;
use crate::models::device_models::CloseReason;
use crate::models::live_stream::{LiveMsg, LiveOptions};
use crate::models::pixel::{PixelDepth, PixelLayout};
use crate::models::stream_errors::StreamErrorStore;
use crate::rcs_erros::RcsError;
use crate::stores::client_store::{Admission, Client, ClientStore, HoldGuard};
use crate::stores::conn_camera::{CamHandle, Hold};
use crate::stores::live_ops::{LiveOp, LiveOpsGuard, OpKind};
use crate::thread_stream::{ThreadStream, DEFAULT_GRAB_TIMEOUT};

/// How long a live stream tolerates receiving no complete frame before giving up. Longer than the
/// one-shot grab timeout: a running stream that briefly stalls is worth waiting out, but a camera
/// that has silently stopped delivering must close the socket rather than hang forever.
const LIVE_STALL_TIMEOUT: Duration = Duration::from_secs(10);

/// The live loop's buffer pop timeout. Shorter than the one-shot grab's
/// [`POP_INTERVAL`](crate::thread_stream::POP_INTERVAL): it bounds how long a forwarded GenICam
/// request waits at a low frame rate, and a pop that times out costs nothing.
const LIVE_POP_INTERVAL: Duration = Duration::from_millis(50);

/// How long the live loop spends on forwarded requests before it pops the next buffer.
const LIVE_OP_BUDGET: Duration = Duration::from_millis(100);

/// How long a (re)started acquisition may take to deliver its first frame before it is started
/// again. Generous enough for long exposures; a triggered camera that is never triggered still
/// ends in the stall timeout after its retries.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const START_RETRIES: u32 = 2;

/// The GenTL node a host sets while acquiring; features whose `pIsLocked` depends on it may only
/// be changed with acquisition stopped.
const ACQUISITION_LOCK: &str = "TLParamsLocked";

#[derive(Debug)]
pub enum StreamCtrlError {
    Error(String),
    InvalidFrame,
    EncodingError(String),
    CameraAccess,
}

impl Display for StreamCtrlError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            StreamCtrlError::Error(msg) => write!(f, "Stream control error: {}", msg),
            StreamCtrlError::InvalidFrame => write!(f, "Frame is invalid"),
            StreamCtrlError::EncodingError(msg) => write!(f, "Encoding failed => {}", msg),
            StreamCtrlError::CameraAccess => write!(f, "Failed to access camera")
        }
    }
}

impl From<JpegError> for StreamCtrlError {
    fn from(value: JpegError) -> Self {
        EncodingError(format!("JPEG: {value}"))
    }
}

/// Why a live capture ended without an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveEnd {
    /// The last viewer left, or the camera stopped delivering.
    Stopped,
    /// The device was closed under the stream.
    DeviceClosed(CloseReason),
    /// Another session's forced `exclusive` lease took the device.
    Revoked,
}

pub struct StreamCtrl {
    camera_store: ArcBoxedCameraStore,
    /// Each device's live capture and its viewers.
    hubs: Arc<LiveHubs>,
}

impl StreamCtrl {
    pub fn new(
        camera_store: ArcBoxedCameraStore,
        clients: Arc<ClientStore>,
        stream_errors: Arc<StreamErrorStore>,
    ) -> Self {
        Self {
            hubs: Arc::new(LiveHubs::new(camera_store.clone(), clients, stream_errors)),
            camera_store,
        }
    }

    pub async fn grab_raw_frame(&self, adm: &Admission) -> Result<Vec<u8>, RcsError> {
        self.camera_store
            .with_camera(adm.device(), Hold::Short, move |handle| {
                let layout = frame_codec::prepare_pixel_format(handle, PixelDepth::Mono8);
                let ts = ThreadStream::new(&handle.camera);
                let ((width, height), data) = ts.grab_frame(DEFAULT_GRAB_TIMEOUT)?;
                Ok(frame_codec::copy_image(&data, width, height, &layout)?)
            })
            .await
    }

    pub async fn grab_jpeg_frame(&self, adm: &Admission, quality: u8) -> Result<Vec<u8>, RcsError> {
        self.camera_store
            .with_camera(adm.device(), Hold::Short, move |handle| {
                let layout = frame_codec::prepare_pixel_format(handle, PixelDepth::Mono8);
                let ts = ThreadStream::new(&handle.camera);
                let ((width, height), data) = ts.grab_frame(DEFAULT_GRAB_TIMEOUT)?;
                let image = frame_codec::copy_image(&data, width, height, &layout)?;
                Ok(frame_codec::encode_jpeg(&image, width, height, &layout, quality)?)
            })
            .await
    }

    /// Admit `client` to `GET /devices/{id}/stream/live`: joining the device's running capture is
    /// a read, starting one a write.
    pub fn admit_live(&self, client: &Client, id: u32, now: Instant) -> Result<Admission, RcsError> {
        self.hubs.admit(client, id, now)
    }

    /// Join the device's running live capture, or start one, as a new viewer with its own
    /// format, quality and frame rate. The pixel depth is the starter's: a joiner gets the
    /// running one, announced in its `StreamInfo`.
    ///
    /// The capture is deliberately *not* built on [`ThreadStream::grab_frame`]: that starts and
    /// stops a stream per frame, which costs a full acquisition setup each time. Here the stream
    /// is started once and the capture keeps the camera checked out of the store for as long as
    /// it has viewers. GenICam requests for the device are not refused meanwhile but forwarded
    /// into the loop (see [`crate::stores::live_ops`]), which runs them between buffer pops.
    /// Dropping the [`Viewer`] leaves; the last one to leave stops the capture.
    pub fn join(&self, adm: &Admission, opts: LiveOptions) -> Result<Viewer, RcsError> {
        self.hubs.join(adm, opts)
    }

    /// A single viewer's stream over a channel: [`StreamCtrl::join`], with the viewer's messages
    /// passed on to `tx` until its receiver is dropped or the capture ends. Then it leaves, and
    /// waits for the camera to be handed back if that stopped the capture. The result says how
    /// the capture ended (`Stopped` when other viewers keep it running).
    pub async fn stream_live(&self, adm: &Admission, opts: LiveOptions, tx: Sender<LiveMsg>) -> Result<LiveEnd, RcsError> {
        let mut viewer = self.join(adm, opts)?;
        let mut messages = Box::pin(viewer.messages());
        loop {
            let msg = tokio::select! {
                msg = messages.next() => msg,
                // The receiver left while no frame was coming (a stalled camera, say).
                () = tx.closed() => None,
            };
            match msg {
                Some(Ok(msg)) => {
                    if tx.send(msg).await.is_ok() {
                        continue;
                    }
                }
                Some(Err(e)) => return Err(e.into()),
                None => {}
            }
            drop(messages);
            return match viewer.leave().await {
                Some(Err(msg)) => Err(StreamCtrlError::Error(msg).into()),
                Some(Ok(end)) => Ok(end),
                None => Ok(LiveEnd::Stopped),
            };
        }
    }

    /// The blocking body of a [`LiveHub`]'s capture, run inside its `with_camera`: until the last
    /// viewer leaves, the device is closed, or another session's forced `exclusive` lease revokes
    /// it. The result says which.
    pub(crate) fn run_live(
        handle: &CamHandle,
        hub: &LiveHub,
        mut guard: LiveOpsGuard,
        mut ops: Receiver<LiveOp>,
        hold: HoldGuard,
    ) -> Result<LiveEnd, RcsError> {
        let depth = hub.depth();
        let mut session = LiveSession::start(handle, depth);
        if let Ok(session) = &session {
            hold.streaming(session.layout.pixel_format.clone(), session.layout.bit_depth);
        }
        let result = match &mut session {
            Ok(session) => Self::live_loop(handle, hub, depth, session, &mut ops, &hold),
            Err(_) => Ok(()),
        };

        // Stop taking requests, then stop the stream on every exit path, or the camera keeps
        // acquiring into a pool nobody drains — and the next connect inherits a device that is
        // still streaming.
        guard.close();
        ops.close();
        let start_error = match session {
            Ok(mut session) => {
                session.stop(handle);
                None
            }
            Err(e) => Some(e),
        };
        // Requests that were already queued still get a real answer, now with acquisition
        // stopped so no write is refused for it.
        while let Ok(mut op) = ops.try_recv() {
            op.run(handle);
            op.reply();
        }
        match start_error {
            Some(e) => Err(e),
            None => result.map(|()| match handle.stop.reason() {
                Some(reason) => LiveEnd::DeviceClosed(reason),
                None if hold.revoked() => LiveEnd::Revoked,
                None => LiveEnd::Stopped,
            }),
        }
    }

    fn live_loop(
        handle: &CamHandle,
        hub: &LiveHub,
        depth: PixelDepth,
        session: &mut LiveSession,
        ops: &mut Receiver<LiveOp>,
        hold: &HoldGuard,
    ) -> Result<(), RcsError> {
        // Counted for the stall error only; each viewer counts its own drops.
        let mut dropped: u32 = 0;
        // The geometry of the last frame, shared by the viewers' announcements and encoders.
        let mut geometry: Option<Arc<Geometry>> = None;
        let mut last_good = Instant::now();
        // When acquisition was last (re)started and has not delivered a frame since, with how
        // many times it was started again for it.
        let mut started: Option<(Instant, u32)> = Some((Instant::now(), 0));

        // The last viewer leaving stops the hub, a close raises the stop signal, a forced lease
        // revokes the hold: the loop ends here, and `run_live` stops the stream.
        while !hub.stopped() && !handle.stop.is_raised() && !hold.revoked() {
            // Forwarded GenICam requests, within a budget so frames keep flowing under a burst of
            // them.
            let budget = Instant::now() + LIVE_OP_BUDGET;
            while Instant::now() < budget {
                let Ok(op) = ops.try_recv() else { break };
                if Self::run_op(handle, depth, session, op, ops)? {
                    // A restarted stream gets a fresh stall window.
                    last_good = Instant::now();
                    started = Some((Instant::now(), 0));
                }
            }

            // A start the device silently refused (aravis-port treats AcquisitionStart as best
            // effort) leaves a stream that never delivers. Try again before giving up on it.
            if let Some((at, retries)) = started {
                if retries < START_RETRIES && at.elapsed() > FIRST_FRAME_TIMEOUT {
                    warn!(
                        "no frame {}s after starting acquisition; starting it again",
                        FIRST_FRAME_TIMEOUT.as_secs()
                    );
                    session.stop(handle);
                    session.restart(handle, depth)?;
                    started = Some((Instant::now(), retries + 1));
                }
            }

            if last_good.elapsed() > LIVE_STALL_TIMEOUT {
                return Err(StreamCtrlError::Error(format!(
                    "no complete frame for {}s ({dropped} frame(s) dropped so far)",
                    LIVE_STALL_TIMEOUT.as_secs()
                ))
                .into());
            }

            // A short pop is what makes the loop cancellable and responsive to requests: both
            // are only noticed between pops.
            let Some(buffer) = session.pool.timeout_pop_buffer(LIVE_POP_INTERVAL) else {
                continue;
            };

            if buffer.status != BufferStatus::Success {
                debug!("discarding live frame with status {:?}", buffer.status);
                dropped = dropped.saturating_add(1);
                hub.drop_frame();
                session.pool.push_buffer(buffer);
                continue;
            }
            started = None;

            let (width, height) = match buffer.image.as_ref().map(|i| (i.width, i.height)) {
                Some((w, h)) if w > 0 && h > 0 => (w, h),
                _ => frame_codec::feature_dimensions(handle),
            };
            // A frame that closed complete but lacks bytes is dropped like an incomplete one: one
            // bad frame must not end the stream. It doesn't count as a good frame for the stall
            // check either, so a stream of nothing but short frames still ends with that error.
            if frame_codec::is_short(buffer.data().len(), width, height, &session.layout) {
                debug!(
                    "discarding live frame {} of {} bytes, short of {width}x{height}",
                    buffer.frame_id,
                    buffer.data().len()
                );
                dropped = dropped.saturating_add(1);
                hub.drop_frame();
                session.pool.push_buffer(buffer);
                continue;
            }
            last_good = Instant::now();

            let current = Geometry {
                width,
                height,
                layout: session.layout.clone(),
                packet_size: session.packet_size,
            };
            let geometry = match &geometry {
                Some(g) if **g == current => g.clone(),
                _ => geometry.insert(Arc::new(current)).clone(),
            };
            let layout = &session.layout;
            let fanned = hub.fan_out(Instant::now(), &geometry, || {
                frame_codec::copy_image(buffer.data(), width, height, layout)
            });
            // Recycle at once: the pool is the reassembler's only source of buffers.
            session.pool.push_buffer(buffer);
            fanned?;
        }

        Ok(())
    }

    /// Run one forwarded request. Returns whether acquisition was restarted, which happens when
    /// the feature is one the device locks while acquiring or the packet size (it is written with
    /// the stream paused), the device refused a change while acquiring (retried the same way), or
    /// the change altered the payload layout the stream's buffers were sized for.
    fn run_op(
        handle: &CamHandle,
        depth: PixelDepth,
        session: &mut LiveSession,
        mut op: LiveOp,
        queue: &mut Receiver<LiveOp>,
    ) -> Result<bool, RcsError> {
        let feature = match &op.kind {
            OpKind::Read => {
                op.run(handle);
                op.reply();
                return Ok(false);
            }
            OpKind::Write(f) | OpKind::Command(f) => f.clone(),
        };
        let kind = op.kind.clone();

        // Features locked on `TLParamsLocked` are, by GenICam's contract, only to be changed
        // with acquisition stopped. A device may take the write mid-acquisition anyway and only
        // apply it at the next start (the AT C6 does exactly that with ExposureTime), so pause.
        // The packet size always goes this way: the receiver, its pool (the C6's PayloadSize
        // depends on it) and a test-packet search all need the stream channel to themselves, and
        // the restart reopens it with the new size.
        if feature == PACKET_SIZE_FEATURE || handle.camera.lock_depends_on(&feature, ACQUISITION_LOCK).unwrap_or(false) {
            debug!("{kind:?} needs acquisition stopped; writing with the stream paused");
            session.stop(handle);
            op.run(handle);
            // Whatever queued up meanwhile (a slider being dragged, a refresh) is carried out in
            // the same pause, so a burst of changes costs one restart rather than one each.
            let mut batch = vec![op];
            while let Ok(mut next) = queue.try_recv() {
                next.run(handle);
                batch.push(next);
            }
            // Answered once acquisition runs again, i.e. once the changes are in effect.
            let restarted = session.restart(handle, depth);
            for op in batch {
                op.reply();
            }
            restarted?;
            return Ok(true);
        }

        let before = payload_layout(handle);
        if op.run(handle) {
            debug!("{kind:?} refused while acquiring; retrying with the stream paused");
            session.stop(handle);
            op.run(handle);
            op.reply();
            session.restart(handle, depth)?;
            return Ok(true);
        }
        op.reply();

        if payload_layout(handle) != before {
            debug!("{kind:?} changed the payload layout; restarting acquisition");
            session.stop(handle);
            session.restart(handle, depth)?;
            return Ok(true);
        }
        Ok(false)
    }
}

/// Paces a live stream to its `fps` limit by credit, not by the gap since the last frame sent.
///
/// A gap rule drops every frame that comes a hair early, which is half of them when the camera
/// runs at a multiple of the limit: at 30 fps under a 15 fps limit, the frame 66.6 ms after a sent
/// one misses the 66.7 ms interval and only every third frame goes out (10 fps). Here credit
/// accrues at the limit and a frame goes out once half a frame's worth is there, so the rate
/// sent averages min(camera rate, limit) however the arrivals jitter.
#[derive(Debug)]
pub(crate) struct FrameRateLimiter {
    /// `None` sends everything.
    fps: Option<f64>,
    /// Frames' worth of sending allowed, in `[-0.5, 1]` once running.
    credit: f64,
    last_arrival: Option<Instant>,
}

impl FrameRateLimiter {
    pub(crate) fn new(fps: Option<f32>) -> Self {
        Self {
            fps: fps.filter(|f| f.is_finite() && *f > 0.0).map(f64::from),
            // Just enough for the first frame, so the second waits a full interval.
            credit: 0.5,
            last_arrival: None,
        }
    }

    /// Whether a frame arriving `now` goes out. One that does is charged a frame of credit.
    pub(crate) fn admit(&mut self, now: Instant) -> bool {
        let Some(fps) = self.fps else { return true };
        if let Some(last) = self.last_arrival {
            // Capped at one frame: a slow spell must not bank a burst for when the camera speeds up.
            self.credit = (self.credit + now.duration_since(last).as_secs_f64() * fps).min(1.0);
        }
        self.last_arrival = Some(now);
        if self.credit >= 0.5 {
            self.credit -= 1.0;
            true
        } else {
            false
        }
    }

    /// An admitted frame that couldn't be sent after all gives its credit back.
    pub(crate) fn refund(&mut self) {
        if self.fps.is_some() {
            self.credit = (self.credit + 1.0).min(1.0);
        }
    }
}

/// `PayloadSize` and `PixelFormat`: what the pool's buffers and the stream's decoding were set up
/// for. `None` parts when unreadable, which compares equal and so never forces a restart alone.
fn payload_layout(handle: &CamHandle) -> (Option<i64>, Option<i64>) {
    (
        handle.camera.read::<i64>("PayloadSize").ok(),
        handle.camera.read::<i64>("PixelFormat").ok(),
    )
}

/// A running acquisition: the GVSP stream, its buffer pool, the pixel layout it delivers and the
/// packet size it was opened with.
struct LiveSession {
    /// `None` only while stopped for a restart.
    stream: Option<StreamHandle>,
    pool: BufferPoolHandle,
    layout: PixelLayout,
    packet_size: u16,
}

impl LiveSession {
    fn start(handle: &CamHandle, depth: PixelDepth) -> Result<Self, RcsError> {
        let layout = frame_codec::prepare_pixel_format(handle, depth);
        let config = transport::stream_config(&handle.camera);
        let (stream, pool) = handle.camera.start_stream_channel_with_config(config)?;
        Ok(Self {
            stream: Some(stream),
            pool,
            layout,
            packet_size: config.packet_size,
        })
    }

    fn stop(&mut self, handle: &CamHandle) {
        if let Some(stream) = self.stream.take() {
            if let Err(e) = handle.camera.stop_stream(stream) {
                warn!("failed to stop live stream cleanly => {e}");
            }
        }
    }

    /// Start acquiring again after [`LiveSession::stop`], with a pool sized for the current
    /// payload. `PixelFormat` is reapplied, since whatever stopped the stream may have changed it.
    fn restart(&mut self, handle: &CamHandle, depth: PixelDepth) -> Result<(), RcsError> {
        *self = Self::start(handle, depth)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How many of the frames arriving at `fps_in` for `seconds` (each up to `jitter_ms` early or
    /// late) a limit of `limit` sends.
    fn sent(limit: Option<f32>, fps_in: f64, seconds: f64, jitter_ms: f64) -> usize {
        let mut limiter = FrameRateLimiter::new(limit);
        let start = Instant::now();
        let n = (fps_in * seconds) as usize;
        (0..n)
            .filter(|&i| {
                // Deterministic jitter, alternating early and late.
                let offset = if i % 2 == 0 { -jitter_ms } else { jitter_ms };
                let at_ms = (i as f64 * 1000.0 / fps_in + offset).max(0.0);
                limiter.admit(start + Duration::from_secs_f64(at_ms / 1000.0))
            })
            .count()
    }

    #[test]
    fn the_limit_is_reached_when_the_camera_runs_at_a_multiple_of_it() {
        // The case a gap rule gets wrong: 30 fps in, 15 out, not 10.
        assert!((44..=46).contains(&sent(Some(15.0), 30.0, 3.0, 0.5)), "{}", sent(Some(15.0), 30.0, 3.0, 0.5));
        // At the camera's own rate nothing is lost to jitter.
        assert!(sent(Some(30.0), 30.0, 3.0, 1.0) >= 89, "{}", sent(Some(30.0), 30.0, 3.0, 1.0));
        assert!((29..=31).contains(&sent(Some(10.0), 32.0, 3.0, 1.0)), "{}", sent(Some(10.0), 32.0, 3.0, 1.0));
    }

    #[test]
    fn a_camera_slower_than_the_limit_sends_everything() {
        assert_eq!(sent(Some(15.0), 10.0, 3.0, 2.0), 30);
        assert_eq!(sent(None, 100.0, 1.0, 0.0), 100);
        // Nonsense limits mean no limit rather than an endless wait.
        assert_eq!(sent(Some(0.0), 50.0, 1.0, 0.0), 50);
        assert_eq!(sent(Some(f32::NAN), 50.0, 1.0, 0.0), 50);
    }

    #[test]
    fn the_first_frame_goes_out_at_once_and_the_second_a_full_interval_later() {
        let mut limiter = FrameRateLimiter::new(Some(10.0));
        let t0 = Instant::now();
        assert!(limiter.admit(t0));
        assert!(!limiter.admit(t0 + Duration::from_millis(60)));
        assert!(limiter.admit(t0 + Duration::from_millis(100)));
    }

    #[test]
    fn an_idle_spell_does_not_bank_a_burst() {
        let mut limiter = FrameRateLimiter::new(Some(10.0));
        let t0 = Instant::now();
        assert!(limiter.admit(t0));
        // Two seconds without frames, then a fast camera: one frame at once, then the limit.
        let later = t0 + Duration::from_secs(2);
        let sent = (0..10).filter(|&i| limiter.admit(later + Duration::from_millis(i * 10))).count();
        assert_eq!(sent, 2, "10 frames in 90 ms at a 10 fps limit");
    }

    #[test]
    fn a_frame_the_client_had_no_room_for_does_not_count() {
        let mut limiter = FrameRateLimiter::new(Some(10.0));
        let t0 = Instant::now();
        assert!(limiter.admit(t0));
        limiter.refund();
        assert!(limiter.admit(t0 + Duration::from_millis(10)));
    }
}
