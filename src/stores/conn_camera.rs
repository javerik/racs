use std::sync::{Arc, OnceLock};

use aravis_port::Camera;

use crate::controller::transport::LinkInfo;
use crate::models::device_models::{CloseReason, DeviceDiscoverInfo};
use crate::processor::genicam_proc::GcMeta;

pub enum ConnectionState {
    Discovered,
    Connected,
    /// Checked out, and by what kind of holder.
    InUse(Hold),
    Error
}

/// What a checkout holds the camera for. It decides how a request that finds the camera taken
/// behaves: a short hold is waited for, a long one is busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// One request's worth of work: a GenICam read, write or command, a feature-state chunk, the
    /// packet size or its search, a single-frame grab. Queued behind each other in order.
    Short,
    /// A capture that keeps the camera until it is stopped: a live stream or a burst.
    Long,
}

impl ConnectionState {

    pub fn is_connected(&self) -> bool {
        match self {
            ConnectionState::Discovered | ConnectionState::Error => false,
            ConnectionState::Connected | ConnectionState::InUse(_) => true
        }
    }

}

/// Raised once when a device is being closed. One per connect, shared by the slot and its handle:
/// the closer raises it through the slot while the camera is checked out, and the live and burst
/// capture loops check it through the handle between buffer pops. A raised signal is also what
/// marks the slot as closing. The first reason raised is the one kept.
#[derive(Debug, Default)]
pub struct StopSignal(OnceLock<CloseReason>);

impl StopSignal {
    pub fn raise(&self, reason: CloseReason) {
        let _ = self.0.set(reason);
    }

    pub fn is_raised(&self) -> bool {
        self.0.get().is_some()
    }

    pub fn reason(&self) -> Option<CloseReason> {
        self.0.get().copied()
    }
}

/// An open camera plus everything derived from it at connect time.
///
/// Owned rather than borrowed so it can move into `spawn_blocking` and back: every aravis-port
/// call is blocking, and `Camera` is `Send` but not `Sync` (its `Device` holds a `GenApiTree` with
/// interior mutability), so a single owner passed between threads is the only sound arrangement.
///
/// Dropping this performs network I/O — aravis-port's `Device::drop` releases the control-channel
/// privilege with a blocking register write — so it must be dropped on a blocking thread, never on
/// a runtime worker.
pub struct CamHandle {
    pub camera: Camera,
    /// GenICam metadata, built once here rather than re-parsed per request. Shared by `Arc` so
    /// `/xml` and `/gc/categories` can be served without checking the camera out.
    pub meta: Arc<GcMeta>,
    pub info: DeviceDiscoverInfo,
    /// The local interface the camera is reached over, found once at connect: it bounds the
    /// stream packet size.
    pub link: LinkInfo,
    /// Raised when the device is being closed; capture loops holding this handle stop on it.
    pub stop: Arc<StopSignal>,
}

pub struct ConnCamera {
    pub state: ConnectionState,
    pub info: DeviceDiscoverInfo,
    /// `None` while the camera is checked out to a caller, or if it was never connected.
    pub camera: Option<CamHandle>,
    /// Retained even while the camera is checked out, so metadata reads never block on a frame
    /// grab holding the camera.
    pub meta: Option<Arc<GcMeta>>,
    /// Stamped by `CameraStore::add_camera`, new for every connect. A checkout remembers it, so a
    /// handle that comes back after its slot was removed (and maybe reconnected) is recognised as
    /// stale instead of being put into a slot it doesn't belong to.
    pub generation: u64,
    /// The handle's stop signal, kept here so a close can raise it while the camera is out. Raised
    /// means the slot is closing: checkouts are refused and it no longer counts as connected.
    pub stop: Arc<StopSignal>,
}


impl ConnCamera {

    pub fn new(info: DeviceDiscoverInfo) -> Self {
        Self {
            state: ConnectionState::Discovered,
            info,
            camera: None,
            meta: None,
            generation: 0,
            stop: Arc::default(),
        }
    }

    pub fn new_with_camera(handle: CamHandle) -> Self {
        Self {
            state: ConnectionState::Connected,
            info: handle.info.clone(),
            meta: Some(handle.meta.clone()),
            stop: handle.stop.clone(),
            camera: Some(handle),
            generation: 0,
        }
    }

}
