//! One live capture per device, fanned out to any number of viewers.
//!
//! A [`LiveHub`] is the device's running capture: its supervisor task is the only
//! [`with_camera`](crate::stores::camera_store::CameraStore::with_camera) holder for the live
//! stream and the only [`LiveOps::register`](crate::stores::live_ops::LiveOps::register) caller.
//! `GET /devices/{id}/stream/live` joins the device's hub (a read) or starts one (a write) and gets
//! a [`Viewer`].
//!
//! The capture loop ([`StreamCtrl`](crate::controller::stream_ctrl::StreamCtrl)'s `run_live`) copies
//! each frame once into a [`Bytes`] and hands it to [`LiveHub::fan_out`]. Per viewer, its own
//! [`FrameRateLimiter`] decides, and the frame is `try_send`ed into the viewer's bounded
//! [`Staged`] channel, so a full channel is a drop for that viewer only. Each viewer has its own
//! frame number, dropped counter and encoding, runs its own [`encode_stage::ordered`] and is sent a
//! [`StreamInfo`] whenever the geometry differs from what it was last told, so a late joiner gets
//! one first.
//!
//! Lock order: the hubs map, then a hub's viewers, then the [`ClientStore`]. A leave that empties a
//! hub marks it `closing`, takes it out of the map under both locks and announces the release; a
//! joiner then finds no hub and starts a new one, whose checkout waits for the old one's check-in.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use bytes::Bytes;
use futures::Stream;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::watch;
use tracing::warn;

use crate::app_context::ArcBoxedCameraStore;
use crate::controller::encode_stage::{self, Staged};
use crate::controller::frame_codec::{self, FrameEncoding};
use crate::controller::stream_ctrl::{FrameRateLimiter, LiveEnd, StreamCtrl, StreamCtrlError};
use crate::models::access::Perm;
use crate::models::live_stream::{LiveFormat, LiveMsg, LiveOptions, StreamInfo};
use crate::models::pixel::{PixelDepth, PixelLayout};
use crate::models::stream_errors::StreamErrorStore;
use crate::rcs_erros::RcsError;
use crate::stores::client_store::{Admission, Client, ClientStore, HoldKind, ViewerGuard};
use crate::stores::conn_camera::Hold;

/// How many items may wait for a viewer's encoders. Small on purpose: the capture loop drops a
/// frame that finds it full, so a slow encoder or client costs that viewer frame rate rather than
/// latency, and costs the other viewers nothing.
const VIEWER_QUEUE: usize = 2;

/// How a hub's capture ended: a [`LiveEnd`], or the error it failed with, as the socket reports it.
pub type HubEnd = Result<LiveEnd, String>;

/// What a frame was captured as: what a viewer's [`StreamInfo`] describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub layout: PixelLayout,
    pub packet_size: u16,
}

impl Geometry {
    fn info(&self, format: LiveFormat) -> StreamInfo {
        StreamInfo {
            width: self.width,
            height: self.height,
            format: format.as_str().to_string(),
            pixel_format: self.layout.pixel_format.clone(),
            bit_depth: self.layout.bit_depth,
            packet_size: self.packet_size,
        }
    }
}

/// A viewer as the capture loop sees it. Only the capture thread changes it, under the viewers
/// lock.
struct ViewerSlot {
    id: u64,
    format: LiveFormat,
    encoding: FrameEncoding,
    limiter: FrameRateLimiter,
    frame_number: u32,
    dropped: u32,
    /// What the last [`StreamInfo`] sent to it said.
    announced: Option<Arc<Geometry>>,
    tx: Sender<Staged<LiveMsg>>,
}

impl ViewerSlot {
    fn drop_one(&mut self) {
        self.dropped = self.dropped.saturating_add(1);
    }

    /// Hand `image` on, announcing `geometry` first if it is new to this viewer. A viewer without
    /// room drops the frame, and the frame doesn't count against its rate.
    fn offer(&mut self, image: &Bytes, geometry: &Arc<Geometry>) {
        // The announced geometry is what a raw consumer decodes against, so a change (a forwarded
        // Width write, say) is announced before the first frame it applies to. Without room for
        // it, the frame waits too: the next one carries the announcement.
        if self.announced.as_ref().is_none_or(|a| **a != **geometry) {
            match self.tx.try_send(Staged::Ready(LiveMsg::Info(geometry.info(self.format)))) {
                Ok(()) => self.announced = Some(geometry.clone()),
                Err(_) => {
                    self.drop_one();
                    self.limiter.refund();
                    return;
                }
            }
        }

        let (frame_number, dropped) = (self.frame_number, self.dropped);
        let item = match self.encoding {
            FrameEncoding::Raw => Staged::Ready(LiveMsg::Frame { frame_number, dropped, payload: image.clone() }),
            encoding => {
                let (image, geometry) = (image.clone(), geometry.clone());
                Staged::work(move || {
                    let g = &*geometry;
                    let payload = frame_codec::encode_slice(&image, g.width, g.height, &g.layout, encoding)?;
                    Ok(LiveMsg::Frame { frame_number, dropped, payload: payload.into() })
                })
            }
        };
        match self.tx.try_send(item) {
            Ok(()) => self.frame_number = self.frame_number.saturating_add(1),
            // The encoders or the client are slower than the camera. Dropping is the whole point
            // of the bounded channel: the alternative is unbounded latency and memory.
            Err(TrySendError::Full(_)) => {
                self.drop_one();
                self.limiter.refund();
            }
            // The viewer is leaving.
            Err(TrySendError::Closed(_)) => {}
        }
    }
}

#[derive(Default)]
struct HubViewers {
    slots: Vec<ViewerSlot>,
    /// Set once the hub is on its way out (its last viewer left, or the capture ended). It is out
    /// of the map by then.
    closing: bool,
}

/// A device's running live capture and its viewers.
pub struct LiveHub {
    device: u32,
    /// Decided by whoever started the capture.
    depth: PixelDepth,
    viewers: Mutex<HubViewers>,
    /// Raised when the last viewer left: the capture loop stops.
    stop: AtomicBool,
    /// Set when the capture has ended.
    end: watch::Sender<Option<HubEnd>>,
}

impl LiveHub {
    fn new(device: u32, depth: PixelDepth) -> Self {
        Self {
            device,
            depth,
            viewers: Mutex::default(),
            stop: AtomicBool::new(false),
            end: watch::Sender::new(None),
        }
    }

    /// Same poisoning policy as the stores: nothing here is left half-changed by a panic.
    fn viewers(&self) -> MutexGuard<'_, HubViewers> {
        self.viewers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn depth(&self) -> PixelDepth {
        self.depth
    }

    /// Whether the capture should stop: its last viewer has left.
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// A frame nobody gets (incomplete, short): every viewer counts it as dropped.
    pub fn drop_frame(&self) {
        self.viewers().slots.iter_mut().for_each(ViewerSlot::drop_one);
    }

    /// Hand a complete frame to every viewer whose frame rate admits it now. `copy` takes the
    /// image out of the buffer, once, and only if some viewer wants it.
    pub fn fan_out(
        &self,
        now: Instant,
        geometry: &Arc<Geometry>,
        copy: impl FnOnce() -> Result<Vec<u8>, StreamCtrlError>,
    ) -> Result<(), StreamCtrlError> {
        let mut viewers = self.viewers();
        let mut admitted = Vec::with_capacity(viewers.slots.len());
        for (i, slot) in viewers.slots.iter_mut().enumerate() {
            // Throttling drops frames instead of sleeping on purpose: the pool holds only a
            // handful of buffers and the reassembler discards whole frames when it runs dry.
            if slot.limiter.admit(now) {
                admitted.push(i);
            } else {
                slot.drop_one();
            }
        }
        if admitted.is_empty() {
            return Ok(());
        }
        let image = Bytes::from(copy()?);
        for i in admitted {
            viewers.slots[i].offer(&image, geometry);
        }
        Ok(())
    }
}

/// Every device's hub. Owned by [`StreamCtrl`].
pub struct LiveHubs {
    map: Mutex<HashMap<u32, Arc<LiveHub>>>,
    camera_store: ArcBoxedCameraStore,
    clients: Arc<ClientStore>,
    stream_errors: Arc<StreamErrorStore>,
    next_viewer: AtomicU64,
}

impl LiveHubs {
    pub fn new(camera_store: ArcBoxedCameraStore, clients: Arc<ClientStore>, stream_errors: Arc<StreamErrorStore>) -> Self {
        Self { map: Mutex::default(), camera_store, clients, stream_errors, next_viewer: AtomicU64::new(0) }
    }

    fn map(&self) -> MutexGuard<'_, HashMap<u32, Arc<LiveHub>>> {
        self.map.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Admit `client` to `device`'s live stream: joining a running capture is a read, starting
    /// one a write.
    pub fn admit(&self, client: &Client, device: u32, now: Instant) -> Result<Admission, RcsError> {
        let perm = if self.map().contains_key(&device) { Perm::Read } else { Perm::Write };
        Ok(self.clients.admit(client, device, perm, now)?)
    }

    /// Join `adm`'s device's running capture, or start one with `opts.pixel_depth`. A capture
    /// that ended since `adm` was admitted as a reader is started anew, which needs write
    /// permission after all.
    pub fn join(self: &Arc<Self>, adm: &Admission, opts: LiveOptions) -> Result<Viewer, RcsError> {
        let id = adm.device();
        let mut map = self.map();
        let (hub, starter) = match map.get(&id) {
            Some(hub) => (hub.clone(), None),
            None => {
                let starter = if adm.role().allows(Perm::Write) {
                    adm.clone()
                } else {
                    self.clients.admit(adm.client(), id, Perm::Write, Instant::now())?
                };
                let hub = Arc::new(LiveHub::new(id, opts.pixel_depth));
                map.insert(id, hub.clone());
                (hub, Some(starter))
            }
        };
        let (tx, rx) = mpsc::channel(VIEWER_QUEUE);
        let viewer = self.next_viewer.fetch_add(1, Ordering::Relaxed);
        hub.viewers().slots.push(ViewerSlot {
            id: viewer,
            format: opts.format,
            encoding: opts.encoding(),
            limiter: FrameRateLimiter::new(opts.fps),
            frame_number: 0,
            dropped: 0,
            announced: None,
            tx,
        });
        let guard = self.clients.view(adm);
        let end = hub.end.subscribe();
        drop(map);

        if let Some(starter) = starter {
            tokio::spawn(self.clone().supervise(hub.clone(), starter));
        }
        Ok(Viewer { hubs: self.clone(), hub, id: viewer, rx: Some(rx), end, guard })
    }

    /// Run `hub`'s capture, then retire the hub and tell its viewers how it ended.
    async fn supervise(self: Arc<Self>, hub: Arc<LiveHub>, starter: Admission) {
        let id = hub.device;
        let had_camera = Arc::new(AtomicBool::new(false));
        let result = {
            let (hub, had_camera) = (hub.clone(), had_camera.clone());
            let live_ops = self.camera_store.live_ops();
            let clients = self.clients.clone();
            self.camera_store
                .with_camera(id, Hold::Long, move |handle| {
                    had_camera.store(true, Ordering::Relaxed);
                    // The device's holder from here on, before anything is written to the
                    // camera; the access mode may have changed since the request was admitted.
                    // Dropped when `run_live` returns, after the stop.
                    let hold = clients.hold(&starter, HoldKind::Live)?;
                    // Registered before acquisition starts, so requests arriving meanwhile queue
                    // for the loop instead of failing as busy.
                    let (guard, ops) = live_ops.register(id);
                    StreamCtrl::run_live(handle, &hub, guard, ops, hold)
                })
                .await
        };
        let end: HubEnd = result.map_err(|e| format!("{e:?}"));
        {
            let mut map = self.map();
            let mut viewers = hub.viewers();
            viewers.closing = true;
            if map.get(&id).is_some_and(|h| Arc::ptr_eq(h, &hub)) {
                map.remove(&id);
            }
            // Before the channels close, so a viewer that sees its channel end finds the reason.
            hub.end.send_replace(Some(end.clone()));
            viewers.slots.clear();
        }
        if let Err(msg) = &end {
            warn!("live stream {id} failed => {msg}");
            self.stream_errors.record(id, msg.clone()).await;
        }
        // Whoever stopped the capture (its last viewer, a forced lease) announced the release.
        // Not when the camera was never ours: the announcement is somebody else's then.
        if had_camera.load(Ordering::Relaxed) {
            self.camera_store.end_release(id);
        }
    }

    /// `viewer` left `hub`. The last one stops the capture.
    fn leave(&self, hub: &Arc<LiveHub>, viewer: u64) {
        let mut map = self.map();
        let mut viewers = hub.viewers();
        viewers.slots.retain(|s| s.id != viewer);
        if !viewers.slots.is_empty() || viewers.closing {
            return;
        }
        viewers.closing = true;
        if map.get(&hub.device).is_some_and(|h| Arc::ptr_eq(h, hub)) {
            map.remove(&hub.device);
        }
        // The capture loop notices between buffer pops and hands the camera back. That takes a
        // moment, so announce it first: a client reopening the stream right away (to change a
        // setting, say) then waits for the camera instead of being refused as busy.
        self.camera_store.begin_release(hub.device);
        hub.stop.store(true, Ordering::Relaxed);
    }
}

/// One live-stream socket's share of its device's capture. Dropping it leaves.
pub struct Viewer {
    hubs: Arc<LiveHubs>,
    hub: Arc<LiveHub>,
    id: u64,
    rx: Option<Receiver<Staged<LiveMsg>>>,
    end: watch::Receiver<Option<HubEnd>>,
    guard: ViewerGuard,
}

impl Viewer {
    /// This viewer's messages, encoded and in order. Ends when the capture does. Taken once.
    pub fn messages(&mut self) -> impl Stream<Item = Result<LiveMsg, StreamCtrlError>> {
        encode_stage::ordered(self.rx.take().expect("a viewer's messages are taken once"))
    }

    /// How the capture ended, once it has.
    pub async fn end(&mut self) -> HubEnd {
        match self.end.wait_for(Option::is_some).await {
            Ok(end) => end.clone().expect("waited for it"),
            // The hub, and with it the sender, lives as long as this viewer.
            Err(_) => Ok(LiveEnd::Stopped),
        }
    }

    /// Resolves once a forced `exclusive` lease of another session took the device from this
    /// viewer.
    pub async fn revoked(&mut self) {
        self.guard.revoked().await;
    }

    /// Leave, and if the capture is ending (this was its last viewer, or it ended by itself),
    /// wait until it has handed the camera back. `None` when other viewers keep it running.
    pub async fn leave(self) -> Option<HubEnd> {
        let mut end = self.end.clone();
        let hub = self.hub.clone();
        drop(self);
        if !hub.viewers().closing {
            return None;
        }
        let end = end.wait_for(Option::is_some).await.ok()?.clone();
        end
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.hubs.leave(&self.hub, self.id);
    }
}
