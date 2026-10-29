//! Forwarding GenICam requests into a running live stream.
//!
//! A live stream keeps its camera checked out of the store for the whole session (see
//! [`StreamCtrl::stream_live`](crate::controller::stream_ctrl::StreamCtrl::stream_live)), so a
//! feature read or write that tried to check it out would only ever get `Busy`. Instead the stream
//! registers a queue here, and [`CameraStore::with_camera_or_live`](super::camera_store::CameraStore::with_camera_or_live)
//! hands such requests to it. The capture loop runs them on its own blocking thread between buffer
//! pops (a `Camera` is `Send` but not `Sync`, so that thread is the only place they can run) and
//! answers each over a oneshot channel.
//!
//! Burst jobs never register: a burst is a measurement, and changing the camera under it would
//! make its frames inconsistent, so requests during a burst still fail as busy.

use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{mpsc, oneshot};

use crate::rcs_erros::RcsError;
use crate::stores::conn_camera::CamHandle;

/// Ops that may wait for a live loop at once. A full queue makes a request fall back to checking
/// the camera out, which reports it busy.
const QUEUE: usize = 16;

/// Features a live stream owns while it runs. Writing them would change what the stream is
/// decoding (`PixelFormat` is set from the stream's `pixel_depth`) or tear down its transport.
/// `GevSCPSPacketSize` is not one: the stream applies it by reopening its channel.
pub const LIVE_RESERVED_FEATURES: &[&str] = &[
    "PixelFormat",
    "GevSCDA",
    "GevSCPHostPort",
    "AcquisitionStart",
    "AcquisitionStop",
    "TLParamsLocked",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpKind {
    Read,
    /// Writes `feature`; the loop restarts acquisition if that changed the payload geometry.
    Write(String),
    /// Executes command `feature`; handled like a write.
    Command(String),
}

impl OpKind {
    pub fn mutates(&self) -> bool {
        !matches!(self, OpKind::Read)
    }

    /// The feature this op changes, if it is one a live stream reserves for itself.
    pub fn reserved_feature(&self) -> Option<&str> {
        match self {
            OpKind::Write(f) | OpKind::Command(f) => LIVE_RESERVED_FEATURES.iter().copied().find(|r| r == f),
            OpKind::Read => None,
        }
    }
}

/// A queued request: what it does, and the type-erased work plus its reply channel.
pub struct LiveOp {
    pub kind: OpKind,
    job: Box<dyn LiveJob>,
}

impl Debug for LiveOp {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveOp").field("kind", &self.kind).finish_non_exhaustive()
    }
}

impl LiveOp {
    pub fn new<T, F>(kind: OpKind, f: F, reply: oneshot::Sender<Result<T, RcsError>>) -> Self
    where
        F: Fn(&CamHandle) -> Result<T, RcsError> + Send + 'static,
        T: Send + 'static,
    {
        Self {
            kind,
            job: Box::new(Job { f, result: None, reply }),
        }
    }

    /// Run the op, keeping its result for [`LiveOp::reply`]. Returns `true` when the device
    /// itself refused it (a GVCP error ack), which for a write usually means "not while
    /// acquiring" and is worth one retry with the stream paused. Running again replaces the
    /// earlier result.
    pub fn run(&mut self, handle: &CamHandle) -> bool {
        self.job.run(handle)
    }

    /// Send the result of the last [`LiveOp::run`]. An op dropped without running drops its reply
    /// channel instead, which tells the caller to fall back to a checkout.
    pub fn reply(self) {
        self.job.reply()
    }
}

trait LiveJob: Send {
    fn run(&mut self, handle: &CamHandle) -> bool;
    fn reply(self: Box<Self>);
}

struct Job<T, F> {
    f: F,
    result: Option<Result<T, RcsError>>,
    reply: oneshot::Sender<Result<T, RcsError>>,
}

impl<T, F> LiveJob for Job<T, F>
where
    F: Fn(&CamHandle) -> Result<T, RcsError> + Send,
    T: Send,
{
    fn run(&mut self, handle: &CamHandle) -> bool {
        let result = (self.f)(handle);
        let rejected = matches!(&result, Err(e) if is_device_rejection(e));
        self.result = Some(result);
        rejected
    }

    fn reply(self: Box<Self>) {
        if let Some(result) = self.result {
            // The caller may have timed out and gone; nothing left to tell it.
            let _ = self.reply.send(result);
        }
    }
}

/// Whether `e` is the device refusing an access, as opposed to a bad value or a missing feature.
/// aravis-port flattens register I/O errors into the GenICam error text, so this matches on it.
fn is_device_rejection(e: &RcsError) -> bool {
    match e {
        RcsError::AravisError(aravis_port::Error::GvcpError(_)) => true,
        RcsError::AravisError(e) => e.to_string().contains("gvcp error ack"),
        _ => false,
    }
}

/// The live streams currently accepting ops, by device id.
#[derive(Default)]
pub struct LiveOps {
    /// Device id -> (session, queue). The session id lets a guard tell its own registration from a
    /// newer stream's on the same device.
    inner: Mutex<HashMap<u32, (u64, mpsc::Sender<LiveOp>)>>,
    next_session: AtomicU64,
}

impl LiveOps {
    /// Start accepting ops for `id`, replacing any earlier registration. The guard unregisters
    /// when closed or dropped.
    pub fn register(self: &Arc<Self>, id: u32) -> (LiveOpsGuard, mpsc::Receiver<LiveOp>) {
        let (tx, rx) = mpsc::channel(QUEUE);
        let session = self.next_session.fetch_add(1, Ordering::Relaxed);
        self.map().insert(id, (session, tx));
        let guard = LiveOpsGuard {
            ops: self.clone(),
            id,
            session,
            open: true,
        };
        (guard, rx)
    }

    pub fn sender(&self, id: u32) -> Option<mpsc::Sender<LiveOp>> {
        self.map().get(&id).map(|(_, tx)| tx.clone())
    }

    /// Same poisoning policy as the store's other std mutexes: the map has no invariant a panic
    /// could break.
    fn map(&self) -> MutexGuard<'_, HashMap<u32, (u64, mpsc::Sender<LiveOp>)>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct LiveOpsGuard {
    ops: Arc<LiveOps>,
    id: u32,
    session: u64,
    open: bool,
}

impl LiveOpsGuard {
    /// Stop accepting ops. Only removes this session's registration: a stream reopened on the same
    /// device in the meantime keeps its own.
    pub fn close(&mut self) {
        if !self.open {
            return;
        }
        self.open = false;
        let mut map = self.ops.map();
        if map.get(&self.id).is_some_and(|(session, _)| *session == self.session) {
            map.remove(&self.id);
        }
    }
}

impl Drop for LiveOpsGuard {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_is_found_until_its_guard_closes() {
        let ops = Arc::new(LiveOps::default());
        assert!(ops.sender(1).is_none());
        let (guard, _rx) = ops.register(1);
        assert!(ops.sender(1).is_some());
        assert!(ops.sender(2).is_none());
        drop(guard);
        assert!(ops.sender(1).is_none());
    }

    #[test]
    fn a_stale_guard_leaves_a_newer_registration_alone() {
        let ops = Arc::new(LiveOps::default());
        let (mut old, _old_rx) = ops.register(1);
        let (_new, mut new_rx) = ops.register(1);
        old.close();
        let sender = ops.sender(1).expect("the newer stream must stay registered");
        let (tx, _rx) = oneshot::channel::<Result<(), RcsError>>();
        sender.try_send(LiveOp::new(OpKind::Read, |_| Ok(()), tx)).unwrap();
        assert!(new_rx.try_recv().is_ok(), "ops reach the newer stream");
    }

    #[test]
    fn reserved_features_are_only_reserved_for_changes() {
        assert_eq!(OpKind::Write("PixelFormat".into()).reserved_feature(), Some("PixelFormat"));
        assert_eq!(OpKind::Command("AcquisitionStop".into()).reserved_feature(), Some("AcquisitionStop"));
        assert_eq!(OpKind::Write("ExposureTime".into()).reserved_feature(), None);
        assert_eq!(OpKind::Read.reserved_feature(), None);
    }

    #[tokio::test]
    async fn an_op_dropped_without_running_closes_its_reply() {
        let (tx, rx) = oneshot::channel::<Result<(), RcsError>>();
        let op = LiveOp::new(OpKind::Read, |_| Ok(()), tx);
        // Replying without having run is the same as dropping: the caller must fall back.
        op.reply();
        assert!(rx.await.is_err());
    }

    #[test]
    fn device_rejections_are_told_apart_from_other_errors() {
        assert!(is_device_rejection(&RcsError::AravisError(aravis_port::Error::GvcpError(0x06))));
        assert!(is_device_rejection(&RcsError::AravisError(aravis_port::Error::GenIcam(
            "io: gvcp error ack: code=0x06".into()
        ))));
        assert!(!is_device_rejection(&RcsError::AravisError(aravis_port::Error::FeatureNotFound("X".into()))));
        assert!(!is_device_rejection(&RcsError::ValueError(None)));
    }
}
