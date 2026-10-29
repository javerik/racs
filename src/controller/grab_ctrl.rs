//! Burst grab jobs: capture `count` frames in the background, decoupled from the request.
//!
//! The camera side follows the same shape as
//! [`StreamCtrl::stream_live`](crate::controller::stream_ctrl::StreamCtrl::stream_live) — one
//! blocking loop inside [`CameraStore::with_camera`](crate::stores::camera_store::CameraStore::with_camera)
//! that starts the stream once and keeps the camera checked out for the whole run. That is also
//! what makes a burst exclusive: every other request for the device gets
//! [`StoreError::Busy`](crate::stores::camera_store::StoreError::Busy) until it finishes.
//!
//! The difference from a live stream is where the frames go. There is no client attached to hand
//! them to, so each one ends up on the job's record in the
//! [`JobStore`](crate::stores::job_store::JobStore). The capture loop hands every attempt, in
//! order, to the [`encode_stage`], which encodes several frames at once and stores them in that
//! order; the loop itself only records the geometry, which is why that store's methods are
//! synchronous: this loop is not an async context.

use std::pin::pin;
use std::sync::Arc;
use std::time::Instant;

use aravis_port::memory::{BufferPoolHandle, BufferStatus};
use futures::StreamExt;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::app_context::ArcBoxedCameraStore;
use crate::controller::encode_stage::{self, Staged};
use crate::controller::frame_codec::{self, FrameEncoding};
use crate::controller::transport;
use crate::models::burst_job::{BurstParams, JobStatus, OnFailure};
use crate::models::pixel::PixelLayout;
use crate::rcs_erros::RcsError;
use crate::stores::client_store::{Admission, ClientStore, HoldKind};
use crate::stores::conn_camera::{CamHandle, Hold};
use crate::stores::job_store::{JobGeometry, JobOutcome, JobSpec, JobStore};
use crate::thread_stream::{DEFAULT_GRAB_TIMEOUT, POP_INTERVAL};

/// One attempt of a burst, as the capture loop hands it on: the frame (encoded by the stage), or
/// why there is none.
#[derive(Debug)]
enum Attempt {
    Image(Vec<u8>),
    Failed(String),
}

/// What to do after a frame in the middle of a burst failed.
#[derive(Debug, PartialEq, Eq)]
enum FailureAction {
    Continue,
    /// Stop the burst; the string is the job's reported error.
    Stop(String),
}

pub struct GrabCtrl {
    camera_store: ArcBoxedCameraStore,
    job_store: Arc<JobStore>,
    /// Where a running burst registers itself as the device's holder.
    clients: Arc<ClientStore>,
}

impl GrabCtrl {
    pub fn new(camera_store: ArcBoxedCameraStore, job_store: Arc<JobStore>, clients: Arc<ClientStore>) -> Self {
        Self { camera_store, job_store, clients }
    }

    /// Register a job and return its id. Purely in-memory, so the `POST` handler can answer
    /// `202` without waiting on the camera — [`GrabCtrl::run_job`] does the actual work.
    pub fn create_job(&self, adm: &Admission, params: BurstParams) -> Uuid {
        self.job_store.create(adm.device(), params)
    }

    /// Cancel or discard a job. `false` if there was no such job for this device.
    ///
    /// A job that is still capturing holds the camera until its loop notices, so that is announced
    /// as a release: whatever the client asks for next on this device waits for the camera rather
    /// than being refused as busy.
    pub fn cancel(&self, adm: &Admission, job_id: Uuid) -> bool {
        let device_id = adm.device();
        let capturing = self
            .job_store
            .info(device_id, job_id)
            // A pending job has not taken the camera yet, so there is nothing to wait for.
            .is_some_and(|info| info.status == JobStatus::Running);
        if !self.job_store.delete(device_id, job_id) {
            return false;
        }
        if capturing {
            self.camera_store.begin_release(device_id);
        }
        true
    }

    /// Run a job to completion. Meant to be `spawn`ed and never awaited by the request that
    /// created the job; every outcome, including failure, is reported through the job record.
    ///
    /// Note that this is where the camera is taken, not in the handler. A device that is already
    /// busy therefore surfaces as a job that fails immediately rather than as a rejected `POST` —
    /// the price of the endpoint not blocking.
    /// `adm` is the request that started it: its client is the device's holder while it
    /// captures, and must still be allowed to write when the capture starts.
    pub async fn run_job(&self, job_id: Uuid, adm: Admission) {
        // Gone already: deleted between the POST answering and this task being scheduled. Return
        // before taking the camera — there is nothing left to report progress to.
        let Some(spec) = self.job_store.start(job_id) else {
            debug!("burst job {job_id} was deleted before it started");
            return;
        };

        let store = self.job_store.clone();
        let loop_spec = spec.clone();
        let clients = self.clients.clone();
        // Room for the whole burst, so the capture loop never waits for an encoder and the burst
        // stays consecutive frames. At worst that holds what a raw burst of the same count does.
        let (staged_tx, staged_rx) = mpsc::channel(spec.params.count.max(1) as usize);
        let capture = self.camera_store.with_camera(spec.device_id, Hold::Long, move |handle| {
            Self::run_capture(handle, &loop_spec, &store, staged_tx, &clients, &adm)
        });
        let (captured, stored) =
            tokio::join!(capture, Self::store_attempts(staged_rx, job_id, &self.job_store));
        let outcome = match (captured, stored) {
            // An encoder failed, or the job was deleted while frames were still being stored.
            (_, Err(outcome)) => outcome,
            (Ok(outcome), Ok(())) => outcome,
            (Err(e), Ok(())) => JobOutcome::Failed(format!("{:?}", e)),
        };

        if spec.cancelled() {
            // The release `GrabCtrl::cancel` announced is over.
            self.camera_store.end_release(spec.device_id);
        }
        if let JobOutcome::Failed(ref reason) = outcome {
            warn!("burst job {job_id} on device {} failed => {reason}", spec.device_id);
        }
        self.job_store.finish(job_id, outcome);
    }

    /// Store the capture loop's attempts in order, encoding frames on the way. `Err` when the job
    /// has to end differently than the capture loop says.
    async fn store_attempts(
        staged: Receiver<Staged<Attempt>>,
        job_id: Uuid,
        store: &JobStore,
    ) -> Result<(), JobOutcome> {
        let mut encoded = pin!(encode_stage::ordered(staged));
        while let Some(attempt) = encoded.next().await {
            let kept = match attempt {
                Ok(Attempt::Image(bytes)) => store.push_ok(job_id, bytes),
                Ok(Attempt::Failed(reason)) => store.push_failed(job_id, reason),
                // Doesn't happen in practice: the capture loop checked the frame's size. Should
                // it, the index records why and the job ends whatever `on_failure` says, since
                // the loop that applies it has moved on. Returning stops that loop too.
                Err(e) => {
                    let reason = e.to_string();
                    store.push_failed(job_id, reason.clone());
                    return Err(JobOutcome::Failed(reason));
                }
            };
            // The record is gone: the job was deleted.
            if !kept {
                return Err(JobOutcome::Cancelled);
            }
        }
        Ok(())
    }

    /// The blocking body of a burst run.
    fn run_capture(
        handle: &CamHandle,
        spec: &JobSpec,
        store: &JobStore,
        tx: Sender<Staged<Attempt>>,
        clients: &Arc<ClientStore>,
        adm: &Admission,
    ) -> Result<JobOutcome, RcsError> {
        // The device's holder until this returns, after the stop. Taken before anything is
        // written to the camera: the access mode may have changed since the job was created.
        let _hold = clients.hold(adm, HoldKind::Burst { job_id: spec.job_id })?;
        let layout = frame_codec::prepare_pixel_format(handle, spec.params.pixel_depth);

        // Started once for the whole burst, not once per frame: a start/stop per frame costs a
        // full acquisition setup each time, which is the whole reason this is not a loop over
        // `ThreadStream::grab_frame`.
        let (stream, pool) = handle
            .camera
            .start_stream_channel_with_config(transport::stream_config(&handle.camera))?;
        let outcome = Self::capture_loop(handle, spec, store, &tx, &layout, &pool);

        // Stop the stream on every exit path, or the camera keeps acquiring into a pool nobody
        // drains — and the next connect inherits a device that is still streaming.
        if let Err(e) = handle.camera.stop_stream(stream) {
            warn!("failed to stop burst stream cleanly => {e}");
        }
        Ok(outcome)
    }

    fn capture_loop(
        handle: &CamHandle,
        spec: &JobSpec,
        store: &JobStore,
        tx: &Sender<Staged<Attempt>>,
        layout: &PixelLayout,
        pool: &BufferPoolHandle,
    ) -> JobOutcome {
        let params = spec.params;
        let encoding = params.encoding();
        let mut recorded: Option<(u32, u32)> = None;
        let mut captured: u32 = 0;
        let mut failures: u32 = 0;
        // Per-frame budget, reset after every attempt that resolves. Same threshold the one-shot
        // grab endpoints use, so "this frame failed" means the same thing everywhere.
        let mut deadline = Instant::now() + DEFAULT_GRAB_TIMEOUT;
        let mut rejected = 0usize;

        // One index per *attempt*: a skipped failure still occupies its index, which is what keeps
        // indices inside `0..requested_count`.
        while captured + failures < params.count {
            // Checked between pops, so a DELETE or a close of the device is noticed within one
            // POP_INTERVAL at worst.
            if spec.cancelled() || handle.stop.is_raised() {
                return JobOutcome::Cancelled;
            }

            let now = Instant::now();
            if now >= deadline {
                let reason = format!(
                    "no complete frame received before timeout ({rejected} incomplete frame(s) discarded)"
                );
                if let Some(outcome) = Self::record_failure(tx, spec, reason, &mut failures) {
                    return outcome;
                }
                rejected = 0;
                deadline = Instant::now() + DEFAULT_GRAB_TIMEOUT;
                continue;
            }

            let remaining = deadline.saturating_duration_since(now).min(POP_INTERVAL);
            let Some(buffer) = pool.timeout_pop_buffer(remaining) else {
                continue;
            };

            if buffer.status != BufferStatus::Success {
                debug!("discarding burst frame with status {:?}", buffer.status);
                rejected += 1;
                pool.push_buffer(buffer);
                continue;
            }

            let (width, height) = match buffer.image.as_ref().map(|i| (i.width, i.height)) {
                Some((w, h)) if w > 0 && h > 0 => (w, h),
                _ => frame_codec::feature_dimensions(handle),
            };
            // A frame that closed complete but lacks bytes is retried like an incomplete one
            // instead of becoming a failed index.
            if frame_codec::is_short(buffer.data().len(), width, height, layout) {
                debug!(
                    "discarding burst frame {} of {} bytes, short of {width}x{height}",
                    buffer.frame_id,
                    buffer.data().len()
                );
                rejected += 1;
                pool.push_buffer(buffer);
                continue;
            }

            let image = frame_codec::copy_image(buffer.data(), width, height, layout);
            // Recycle at once: the pool is the reassembler's only source of buffers.
            pool.push_buffer(buffer);

            match recorded {
                None => {
                    let geometry = JobGeometry { width, height, layout: layout.clone() };
                    if !store.set_geometry(spec.job_id, geometry) {
                        return JobOutcome::Cancelled;
                    }
                    recorded = Some((width, height));
                }
                // Clients decode every raw image against the one recorded geometry, so a change
                // mid-burst would silently corrupt the rest — the same rule the live stream has.
                Some(dims) if dims != (width, height) => {
                    return JobOutcome::Failed(format!(
                        "frame size changed from {}x{} to {width}x{height} mid-burst",
                        dims.0, dims.1
                    ));
                }
                Some(_) => {}
            }

            match image {
                Ok(image) => {
                    let item = match encoding {
                        FrameEncoding::Raw => Staged::Ready(Attempt::Image(image)),
                        _ => {
                            let layout = layout.clone();
                            Staged::work(move || {
                                frame_codec::encode(image, width, height, &layout, encoding).map(Attempt::Image)
                            })
                        }
                    };
                    // The stage is gone: the job was deleted, or an encoder failed.
                    if tx.blocking_send(item).is_err() {
                        return JobOutcome::Cancelled;
                    }
                    captured += 1;
                }
                Err(e) => {
                    if let Some(outcome) = Self::record_failure(tx, spec, format!("{e}"), &mut failures) {
                        return outcome;
                    }
                }
            }
            rejected = 0;
            deadline = Instant::now() + DEFAULT_GRAB_TIMEOUT;
        }

        JobOutcome::Completed
    }

    /// Record a failed index and decide whether the burst carries on. `Some` means stop.
    fn record_failure(
        tx: &Sender<Staged<Attempt>>,
        spec: &JobSpec,
        reason: String,
        failures: &mut u32,
    ) -> Option<JobOutcome> {
        *failures += 1;
        // The stage is gone: the job was deleted while this loop was mid-frame.
        if tx.blocking_send(Staged::Ready(Attempt::Failed(reason.clone()))).is_err() {
            return Some(JobOutcome::Cancelled);
        }
        match Self::failure_action(&spec.params, *failures, reason) {
            FailureAction::Continue => None,
            FailureAction::Stop(error) => Some(JobOutcome::Failed(error)),
        }
    }

    /// The `on_failure` policy, given the number of failures *including* the one just recorded.
    fn failure_action(params: &BurstParams, failures: u32, reason: String) -> FailureAction {
        match params.on_failure {
            OnFailure::Abort => FailureAction::Stop(reason),
            OnFailure::Skip => match params.max_failures {
                Some(max) if failures > max => {
                    FailureAction::Stop(format!("too many failed frames ({failures}/{max})"))
                }
                // Unlimited, or still within budget.
                _ => FailureAction::Continue,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    use crate::models::burst_job::BurstFormat;
    use crate::stores::job_store::ImageLookup;

    fn params(on_failure: OnFailure, max_failures: Option<u32>) -> BurstParams {
        BurstParams {
            count: 10,
            format: BurstFormat::Raw,
            quality: 80,
            on_failure,
            max_failures,
            pixel_depth: Default::default(),
        }
    }

    fn spec(params: BurstParams) -> JobSpec {
        JobSpec {
            job_id: Uuid::new_v4(),
            device_id: 0,
            params,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn abort_stops_on_the_first_failure_and_keeps_its_reason() {
        let action =
            GrabCtrl::failure_action(&params(OnFailure::Abort, None), 1, "camera hiccup".into());
        // The default: a partial burst is reported as a failure, with the reason the frame gave.
        assert_eq!(action, FailureAction::Stop("camera hiccup".to_string()));
    }

    #[test]
    fn abort_ignores_max_failures_rather_than_rejecting_it() {
        // Documented as "ignored, not rejected" — a max_failures sent alongside abort must not
        // quietly turn the job into a skipping one.
        let action =
            GrabCtrl::failure_action(&params(OnFailure::Abort, Some(5)), 1, "boom".into());
        assert!(matches!(action, FailureAction::Stop(_)));
    }

    #[test]
    fn skip_without_a_budget_never_stops() {
        let p = params(OnFailure::Skip, None);
        for failures in [1, 7, 999] {
            assert_eq!(GrabCtrl::failure_action(&p, failures, "boom".into()), FailureAction::Continue);
        }
    }

    #[test]
    fn skip_stops_only_once_the_budget_is_exceeded() {
        let p = params(OnFailure::Skip, Some(3));
        // Three failures are exactly what was allowed for, so the burst carries on.
        for failures in 1..=3 {
            assert_eq!(GrabCtrl::failure_action(&p, failures, "boom".into()), FailureAction::Continue);
        }
        let action = GrabCtrl::failure_action(&p, 4, "boom".into());
        assert_eq!(action, FailureAction::Stop("too many failed frames (4/3)".to_string()));
    }

    #[test]
    fn a_zero_budget_skip_stops_at_the_first_failure() {
        let action = GrabCtrl::failure_action(&params(OnFailure::Skip, Some(0)), 1, "boom".into());
        assert!(matches!(action, FailureAction::Stop(_)));
    }

    #[test]
    fn a_failure_is_recorded_at_its_own_index_before_the_policy_runs() {
        // Even an aborting job keeps the failed index, so `GET .../images` can show where it died.
        let (tx, mut rx) = mpsc::channel(4);
        let mut failures = 0;
        let outcome = GrabCtrl::record_failure(&tx, &spec(params(OnFailure::Abort, None)), "no frame".into(), &mut failures);
        assert_eq!(outcome, Some(JobOutcome::Failed("no frame".to_string())));
        assert_eq!(failures, 1);
        assert!(matches!(rx.try_recv(), Ok(Staged::Ready(Attempt::Failed(r))) if r == "no frame"));
    }

    #[test]
    fn a_deleted_job_cancels_the_loop_instead_of_failing_it() {
        // The stage going away under the loop is a cancellation, not an error: the client asked
        // for the job to go away.
        let (tx, rx) = mpsc::channel(4);
        drop(rx);
        let mut failures = 0;
        assert_eq!(
            GrabCtrl::record_failure(&tx, &spec(params(OnFailure::Skip, None)), "no frame".into(), &mut failures),
            Some(JobOutcome::Cancelled)
        );
    }

    #[tokio::test]
    async fn attempts_are_stored_in_order_with_their_frames_encoded() {
        let store = JobStore::new();
        let job_id = store.create(0, params(OnFailure::Skip, None));
        store.start(job_id).unwrap();
        let (tx, rx) = mpsc::channel(4);
        tx.send(Staged::work(|| {
            frame_codec::encode(vec![9u8; 16 * 8], 16, 8, &PixelLayout::mono8(), FrameEncoding::Zstd).map(Attempt::Image)
        }))
        .await
        .unwrap();
        tx.send(Staged::Ready(Attempt::Failed("timeout".into()))).await.unwrap();
        tx.send(Staged::Ready(Attempt::Image(vec![1, 2, 3]))).await.unwrap();
        drop(tx);

        assert_eq!(GrabCtrl::store_attempts(rx, job_id, &store).await, Ok(()));
        let ImageLookup::Found(first) = store.image(0, job_id, 0) else { panic!("no image 0") };
        let decoded = frame_codec::decode_zstd(&first, 16, 8, &PixelLayout::mono8()).unwrap();
        assert_eq!(decoded, vec![9u8; 16 * 8]);
        assert!(matches!(store.image(0, job_id, 1), ImageLookup::Failed(r) if r == "timeout"));
        assert!(matches!(store.image(0, job_id, 2), ImageLookup::Found(d) if d[..] == [1, 2, 3]));
    }

    #[tokio::test]
    async fn a_deleted_job_stops_storing() {
        let store = JobStore::new();
        let job_id = store.create(0, params(OnFailure::Skip, None));
        store.start(job_id).unwrap();
        assert!(store.delete(0, job_id));
        let (tx, rx) = mpsc::channel(1);
        tx.send(Staged::Ready(Attempt::Image(vec![1]))).await.unwrap();
        assert_eq!(GrabCtrl::store_attempts(rx, job_id, &store).await, Err(JobOutcome::Cancelled));
    }
}
