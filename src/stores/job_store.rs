//! In-memory records for burst grab jobs.
//!
//! Jobs live only as long as the process, same as [`CameraStore`](super::camera_store::CameraStore)
//! and [`StreamErrorStore`](crate::models::stream_errors::StreamErrorStore). A finished job is kept
//! for [`JOB_TTL`] so a client that polled slowly can still collect its images, then dropped by
//! [`JobStore::sweep_expired`].
//!
//! Unlike the other stores this one uses a plain [`std::sync::Mutex`]. Its methods are called both
//! from async handlers *and* from the burst capture loop, which runs on a blocking thread inside
//! [`CameraStore::with_camera`](super::camera_store::CameraStore::with_camera) — no async context,
//! so no `.await`. The lock is only ever held for the duration of one `HashMap` operation and never
//! across an await point, which is exactly the case a sync mutex is for.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::burst_job::{BurstJobInfo, BurstParams, ImageEntryInfo, JobStatus};
use crate::models::pixel::PixelLayout;

/// How long a finished job (and its images) is kept before being swept.
pub const JOB_TTL: Duration = Duration::from_secs(600);

/// One captured index. `data` is `None` exactly when the grab for that index failed.
struct JobImage {
    /// Shared rather than copied when served: a frame can be megabytes, and it is read while the
    /// store is locked.
    data: Option<Bytes>,
    error: Option<String>,
}

impl JobImage {
    fn ok(data: Vec<u8>) -> Self {
        Self { data: Some(Bytes::from(data)), error: None }
    }

    fn failed(error: String) -> Self {
        Self { data: None, error: Some(error) }
    }
}

/// What every frame of a job looks like, recorded from the first one captured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobGeometry {
    pub width: u32,
    pub height: u32,
    pub layout: PixelLayout,
}

struct JobRecord {
    device_id: u32,
    params: BurstParams,
    status: JobStatus,
    geometry: Option<JobGeometry>,
    /// One entry per *attempted* index, in order, so an entry's position is its wire `index`.
    images: Vec<JobImage>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    cancel: Arc<AtomicBool>,
}

impl JobRecord {
    fn captured_count(&self) -> u32 {
        self.images.iter().filter(|i| i.data.is_some()).count() as u32
    }

    fn failed_count(&self) -> u32 {
        self.images.iter().filter(|i| i.data.is_none()).count() as u32
    }

    fn info(&self, job_id: Uuid) -> BurstJobInfo {
        BurstJobInfo {
            job_id,
            device_id: self.device_id,
            status: self.status,
            format: self.params.format,
            requested_count: self.params.count,
            captured_count: self.captured_count(),
            failed_count: self.failed_count(),
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            expires_at: self.expires_at,
            error: self.error.clone(),
            width: self.geometry.as_ref().map(|g| g.width),
            height: self.geometry.as_ref().map(|g| g.height),
            pixel_format: self.geometry.as_ref().map(|g| g.layout.pixel_format.clone()),
            bit_depth: self.geometry.as_ref().map(|g| g.layout.bit_depth),
        }
    }
}

/// Everything the capture loop needs, so it can run without touching the store's lock per frame.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub job_id: Uuid,
    pub device_id: u32,
    pub params: BurstParams,
    /// Set by `DELETE`; the capture loop checks it between buffer pops.
    pub cancel: Arc<AtomicBool>,
}

impl JobSpec {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// How a burst run ended, as reported back to the store by the capture loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

/// The result of asking for one image of a job.
pub enum ImageLookup {
    /// No such job, or that index has not been attempted (yet).
    Missing,
    /// That index was attempted and failed. Only reachable with `on_failure = skip`.
    Failed(String),
    Found(Bytes),
}

#[derive(Default)]
pub struct JobStore {
    jobs: Mutex<HashMap<Uuid, JobRecord>>,
}

impl JobStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A panic while the map was locked would otherwise poison it permanently and take every
    /// later job request down with it. The map itself is a plain `HashMap` with no invariant a
    /// half-finished mutation could break, so recovering the data is safe and strictly better
    /// than failing every request from then on.
    fn jobs(&self) -> MutexGuard<'_, HashMap<Uuid, JobRecord>> {
        self.jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a new job as `Pending`. Fast and in-memory only — the capture starts separately,
    /// so the `POST` handler can answer before the camera is even taken.
    pub fn create(&self, device_id: u32, params: BurstParams) -> Uuid {
        let job_id = Uuid::new_v4();
        self.jobs().insert(
            job_id,
            JobRecord {
                device_id,
                params,
                status: JobStatus::Pending,
                geometry: None,
                images: Vec::new(),
                error: None,
                created_at: Utc::now(),
                started_at: None,
                completed_at: None,
                expires_at: None,
                cancel: Arc::new(AtomicBool::new(false)),
            },
        );
        job_id
    }

    /// Move a job to `Running` and hand back what the capture loop needs.
    ///
    /// `None` when the job is already gone — deleted between the `POST` returning and the
    /// background task getting to run — in which case there is nothing to capture.
    pub fn start(&self, job_id: Uuid) -> Option<JobSpec> {
        let mut jobs = self.jobs();
        let record = jobs.get_mut(&job_id)?;
        record.status = JobStatus::Running;
        record.started_at = Some(Utc::now());
        Some(JobSpec {
            job_id,
            device_id: record.device_id,
            params: record.params,
            cancel: record.cancel.clone(),
        })
    }

    /// Record what the job's frames look like. Called once, on the first captured frame, so raw
    /// images can be decoded without a separate trip to the camera (which the job holds busy).
    ///
    /// `false` means the job has been deleted, exactly as for [`JobStore::push_ok`].
    pub fn set_geometry(&self, job_id: Uuid, geometry: JobGeometry) -> bool {
        match self.jobs().get_mut(&job_id) {
            Some(record) => {
                record.geometry = Some(geometry);
                true
            }
            None => false,
        }
    }

    /// Append a successfully captured frame.
    ///
    /// `false` means the job has been deleted underneath the capture loop, which is the loop's
    /// signal to stop and let go of the camera.
    pub fn push_ok(&self, job_id: Uuid, data: Vec<u8>) -> bool {
        self.push(job_id, JobImage::ok(data))
    }

    /// Append a failed index, recording why.
    pub fn push_failed(&self, job_id: Uuid, error: String) -> bool {
        self.push(job_id, JobImage::failed(error))
    }

    fn push(&self, job_id: Uuid, image: JobImage) -> bool {
        let mut jobs = self.jobs();
        match jobs.get_mut(&job_id) {
            Some(record) => {
                record.images.push(image);
                true
            }
            None => false,
        }
    }

    /// Put a job into its terminal state and start its TTL clock.
    pub fn finish(&self, job_id: Uuid, outcome: JobOutcome) {
        let mut jobs = self.jobs();
        let Some(record) = jobs.get_mut(&job_id) else { return };
        let now = Utc::now();
        record.status = match outcome {
            JobOutcome::Completed => JobStatus::Completed,
            JobOutcome::Cancelled => JobStatus::Cancelled,
            JobOutcome::Failed(error) => {
                record.error = Some(error);
                JobStatus::Failed
            }
        };
        record.completed_at = Some(now);
        record.expires_at = Some(now + chrono::Duration::seconds(JOB_TTL.as_secs() as i64));
    }

    /// Job status, or `None` if `job_id` is unknown or belongs to a different device.
    pub fn info(&self, device_id: u32, job_id: Uuid) -> Option<BurstJobInfo> {
        let jobs = self.jobs();
        let record = jobs.get(&job_id).filter(|r| r.device_id == device_id)?;
        Some(record.info(job_id))
    }

    /// Metadata for every index attempted so far. Grows while the job runs.
    pub fn images(&self, device_id: u32, job_id: Uuid) -> Option<Vec<ImageEntryInfo>> {
        let jobs = self.jobs();
        let record = jobs.get(&job_id).filter(|r| r.device_id == device_id)?;
        Some(
            record
                .images
                .iter()
                .enumerate()
                .map(|(index, image)| {
                    let index = index as u32;
                    match (&image.data, &image.error) {
                        (Some(data), _) => ImageEntryInfo::Ok { index, size_bytes: data.len() as u32 },
                        (None, error) => ImageEntryInfo::Failed {
                            index,
                            error: error.clone().unwrap_or_else(|| "unknown error".to_string()),
                        },
                    }
                })
                .collect(),
        )
    }

    pub fn image(&self, device_id: u32, job_id: Uuid, index: u32) -> ImageLookup {
        let jobs = self.jobs();
        let Some(record) = jobs.get(&job_id).filter(|r| r.device_id == device_id) else {
            return ImageLookup::Missing;
        };
        match record.images.get(index as usize) {
            Some(JobImage { data: Some(data), .. }) => ImageLookup::Found(data.clone()),
            Some(JobImage { error, .. }) => {
                ImageLookup::Failed(error.clone().unwrap_or_else(|| "unknown error".to_string()))
            }
            // Either past the end of the burst, or simply not reached yet — indistinguishable to
            // the client either way, since a running job may still fill it in.
            None => ImageLookup::Missing,
        }
    }

    /// Cancel and/or forget a job. `false` if it was not there to begin with.
    ///
    /// A running job's record goes immediately rather than after the TTL: the client asked for it
    /// explicitly, so there is nothing left to collect. The cancel flag is set first so the
    /// capture loop stops at its next check even though its record is already gone.
    pub fn delete(&self, device_id: u32, job_id: Uuid) -> bool {
        let mut jobs = self.jobs();
        if jobs.get(&job_id).filter(|r| r.device_id == device_id).is_none() {
            return false;
        }
        if let Some(record) = jobs.remove(&job_id) {
            record.cancel.store(true, Ordering::Relaxed);
        }
        true
    }

    /// Cancel every running job on `device_id` because the device is being closed, recording
    /// `reason` as the job's error. Unlike [`JobStore::delete`] the records stay: the job ends as
    /// `cancelled` once its loop has stopped, and the images taken so far stay collectable until
    /// the TTL. Pending jobs are left alone; they find the camera gone when they start. Returns how
    /// many were cancelled.
    pub fn cancel_running(&self, device_id: u32, reason: &str) -> usize {
        let mut jobs = self.jobs();
        let mut cancelled = 0;
        for record in jobs.values_mut() {
            if record.device_id == device_id && record.status == JobStatus::Running {
                record.error = Some(reason.to_string());
                record.cancel.store(true, Ordering::Relaxed);
                cancelled += 1;
            }
        }
        cancelled
    }

    /// Drop every job whose TTL has run out. Returns how many went.
    ///
    /// Only terminal jobs ever have an `expires_at`, so a running job can never be swept out from
    /// under its own capture loop.
    pub fn sweep_expired(&self) -> usize {
        let now = Utc::now();
        let mut jobs = self.jobs();
        let before = jobs.len();
        jobs.retain(|_, record| !matches!(record.expires_at, Some(at) if at <= now));
        before - jobs.len()
    }

    #[cfg(test)]
    fn set_expiry(&self, job_id: Uuid, at: DateTime<Utc>) {
        if let Some(record) = self.jobs().get_mut(&job_id) {
            record.expires_at = Some(at);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::burst_job::{BurstFormat, OnFailure};

    fn params(count: u32) -> BurstParams {
        BurstParams {
            count,
            format: BurstFormat::Raw,
            quality: 80,
            on_failure: OnFailure::Abort,
            max_failures: None,
            pixel_depth: Default::default(),
        }
    }

    #[test]
    fn a_new_job_is_pending_with_no_expiry() {
        let store = JobStore::new();
        let job_id = store.create(3, params(5));

        let info = store.info(3, job_id).unwrap();
        assert_eq!(info.status, JobStatus::Pending);
        assert_eq!(info.requested_count, 5);
        assert_eq!(info.captured_count, 0);
        assert!(info.started_at.is_none());
        // Only a finished job has a TTL; an unstarted one must never be swept.
        assert!(info.expires_at.is_none());
    }

    #[test]
    fn a_job_is_scoped_to_its_device() {
        let store = JobStore::new();
        let job_id = store.create(3, params(1));
        // The same id under another device is a 404, not another device's job.
        assert!(store.info(4, job_id).is_none());
        assert!(store.images(4, job_id).is_none());
        assert!(!store.delete(4, job_id));
        assert!(store.info(3, job_id).is_some(), "the wrong-device lookup must not consume it");
    }

    #[test]
    fn capturing_advances_the_counts_and_finishing_sets_the_ttl() {
        let store = JobStore::new();
        let job_id = store.create(0, params(3));

        let spec = store.start(job_id).unwrap();
        assert_eq!(spec.params.count, 3);
        assert_eq!(store.info(0, job_id).unwrap().status, JobStatus::Running);
        assert!(store.info(0, job_id).unwrap().started_at.is_some());

        assert!(store.push_ok(job_id, vec![1, 2, 3]));
        assert!(store.push_failed(job_id, "no frame".to_string()));
        assert!(store.push_ok(job_id, vec![4]));

        let info = store.info(0, job_id).unwrap();
        assert_eq!(info.captured_count, 2);
        assert_eq!(info.failed_count, 1);

        store.finish(job_id, JobOutcome::Completed);
        let info = store.info(0, job_id).unwrap();
        assert_eq!(info.status, JobStatus::Completed);
        assert!(info.completed_at.is_some());
        assert!(info.expires_at.is_some(), "a finished job must be reclaimable");
        assert!(info.error.is_none());
    }

    #[test]
    fn a_failed_job_reports_why() {
        let store = JobStore::new();
        let job_id = store.create(0, params(2));
        store.start(job_id);
        store.finish(job_id, JobOutcome::Failed("camera 0 is currently in use".to_string()));

        let info = store.info(0, job_id).unwrap();
        assert_eq!(info.status, JobStatus::Failed);
        assert_eq!(info.error.as_deref(), Some("camera 0 is currently in use"));
    }

    #[test]
    fn image_entries_are_indexed_by_position_and_distinguish_failures() {
        let store = JobStore::new();
        let job_id = store.create(0, params(3));
        store.start(job_id);
        store.push_ok(job_id, vec![9; 42]);
        store.push_failed(job_id, "timed out".to_string());

        let entries = store.images(0, job_id).unwrap();
        assert!(matches!(entries[0], ImageEntryInfo::Ok { index: 0, size_bytes: 42 }));
        assert!(matches!(&entries[1], ImageEntryInfo::Failed { index: 1, error } if error == "timed out"));

        assert!(matches!(store.image(0, job_id, 0), ImageLookup::Found(d) if d.len() == 42));
        assert!(matches!(store.image(0, job_id, 1), ImageLookup::Failed(_)));
        // Not captured yet, and past the end of the burst: both are simply "not there".
        assert!(matches!(store.image(0, job_id, 2), ImageLookup::Missing));
        assert!(matches!(store.image(0, job_id, 99), ImageLookup::Missing));
    }

    #[test]
    fn deleting_a_running_job_cancels_it_and_removes_it_at_once() {
        let store = JobStore::new();
        let job_id = store.create(0, params(100));
        let spec = store.start(job_id).unwrap();
        assert!(!spec.cancelled());

        assert!(store.delete(0, job_id));
        // The loop still holds the spec, and this is how it finds out — the record is already gone.
        assert!(spec.cancelled());
        assert!(store.info(0, job_id).is_none(), "a cancelled job waits for no TTL");
        // A push from the still-winding-down loop must report the job is gone rather than resurrect it.
        assert!(!store.push_ok(job_id, vec![1]));
        assert!(!store.delete(0, job_id), "deleting twice is a 404 the second time");
    }

    #[test]
    fn cancelling_a_devices_running_jobs_keeps_their_records() {
        let store = JobStore::new();
        let running = store.create(0, params(100));
        let spec = store.start(running).unwrap();
        store.push_ok(running, vec![7; 4]);
        let pending = store.create(0, params(1));
        let other = store.create(1, params(100));
        let other_spec = store.start(other).unwrap();

        assert_eq!(store.cancel_running(0, "device disconnected"), 1);
        assert!(spec.cancelled());
        assert!(!other_spec.cancelled(), "another device's job is not touched");
        assert_eq!(store.info(0, pending).unwrap().status, JobStatus::Pending);

        // The loop winds down and reports itself cancelled; the record and its images remain.
        store.finish(running, JobOutcome::Cancelled);
        let info = store.info(0, running).unwrap();
        assert_eq!(info.status, JobStatus::Cancelled);
        assert_eq!(info.error.as_deref(), Some("device disconnected"));
        assert!(info.expires_at.is_some());
        assert!(matches!(store.image(0, running, 0), ImageLookup::Found(d) if d.len() == 4));
    }

    #[test]
    fn the_sweep_takes_expired_jobs_and_leaves_everything_else() {
        let store = JobStore::new();
        let running = store.create(0, params(10));
        store.start(running);
        let fresh = store.create(0, params(1));
        store.finish(fresh, JobOutcome::Completed);
        let stale = store.create(0, params(1));
        store.finish(stale, JobOutcome::Completed);
        store.set_expiry(stale, Utc::now() - chrono::Duration::seconds(1));

        assert_eq!(store.sweep_expired(), 1);
        assert!(store.info(0, stale).is_none());
        // A job still inside its TTL is still collectable, and a running one has no expiry at all.
        assert!(store.info(0, fresh).is_some());
        assert!(store.info(0, running).is_some());
    }

    #[test]
    fn geometry_is_null_until_recorded() {
        let store = JobStore::new();
        let job_id = store.create(3, params(2));
        let info = store.info(3, job_id).unwrap();
        assert!(info.width.is_none() && info.bit_depth.is_none() && info.pixel_format.is_none());

        let geometry = JobGeometry {
            width: 16,
            height: 8,
            layout: PixelLayout::from_pixel_format("Mono12"),
        };
        assert!(store.set_geometry(job_id, geometry));
        let info = store.info(3, job_id).unwrap();
        assert_eq!((info.width, info.height), (Some(16), Some(8)));
        assert_eq!(info.pixel_format.as_deref(), Some("Mono12"));
        assert_eq!(info.bit_depth, Some(12));

        store.delete(3, job_id);
        assert!(!store.set_geometry(job_id, JobGeometry { width: 1, height: 1, layout: PixelLayout::mono8() }));
    }
}
