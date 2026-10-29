use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::net::SocketAddrV4;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aravis_port::net::DiscoveredDevice;
use tokio::sync::{oneshot, Mutex, Notify, OwnedMutexGuard};
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::models::device_models::{CloseReason, DeviceDiscoverInfo};
use crate::processor::genicam_proc::GcMeta;
use crate::rcs_erros::RcsError;
use crate::stores::conn_camera::{CamHandle, ConnCamera, ConnectionState, Hold};
use crate::stores::live_ops::{LiveOp, LiveOps, OpKind};

#[derive(Debug)]
pub enum StoreError {
    NotFound(u32),
    Exists(u32),
    /// The camera exists but another request currently holds it.
    Busy(u32),
    /// The device is being closed: no new checkouts. A connect waits for the close to finish.
    Closing(u32),
}

impl Display for StoreError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(id) => write!(f, "Camera not found {}", id),
            StoreError::Exists(id) => write!(f, "Camera already exists {}", id),
            StoreError::Busy(id) => write!(f, "Camera {} is currently in use", id),
            StoreError::Closing(id) => write!(f, "Camera {} is being disconnected", id),
        }
    }
}

/// The longest a checkout waits for a camera that is being handed back. Generous: on real hardware
/// a release includes the capture loop noticing it should stop (up to one buffer pop) plus
/// `AcquisitionStop` and tearing the stream down.
const RELEASE_WAIT: Duration = Duration::from_secs(3);

/// How long a checkout that finds the camera held waits for a release to be *announced*.
///
/// Closing a stream and immediately opening another (or starting a burst, or grabbing a frame)
/// arrive on different connections, so the request for the camera can be handled a moment before
/// the close that is about to free it. Without this grace that ordering is a spurious `Busy`; the
/// cost is that a genuinely busy camera answers `Busy` this much later.
const RELEASE_ANNOUNCE_GRACE: Duration = Duration::from_millis(100);

/// The longest a request waits for its turn at the camera, from when it arrived: queued in the
/// device's lane behind other requests, then for a short operation holding the camera to finish.
/// One deadline for both, so requests queued behind a camera that never comes back all give up
/// together rather than one after another.
const OP_QUEUE_WAIT: Duration = Duration::from_secs(5);

/// How long a request waits for room in a live stream's op queue before falling back to a
/// checkout (which then reports the camera busy).
const LIVE_OP_SEND_TIMEOUT: Duration = Duration::from_secs(1);

/// How long a request forwarded into a live stream waits for its answer. Generous: an op that
/// changes the payload restarts acquisition before the loop takes the next one.
const LIVE_OP_REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// Assigns each physical camera a stable `u32` id for the REST API.
///
/// The API has always used small integer ids, but they used to be raw discovery indices, which
/// reshuffle whenever the device list is refreshed — so the same id could mean a different camera
/// between a `GET /devices` and the `PUT /connect` that followed it. Keying on MAC (which is also
/// what aravis-port deduplicates discovery results on) makes an id mean one camera for the
/// lifetime of the process.
#[derive(Default)]
struct IdMap {
    by_mac: HashMap<String, u32>,
    next: u32,
    /// The most recent discovery round, so `connect(id)` knows where to reach the camera.
    snapshot: HashMap<u32, DiscoveredDevice>,
    /// Where each id was last connected, however that happened (discovery, `?ip=`,
    /// `connect_by_addr`), so `connect(id)` can reopen a camera discovery has never seen.
    targets: HashMap<u32, ConnectTarget>,
}

/// The address an id was last connected at, and the identity the connect was given for it.
#[derive(Clone)]
pub struct ConnectTarget {
    pub addr: SocketAddrV4,
    /// What the original connect knew about the camera up front (from discovery), or `None` when it
    /// was read from the camera itself.
    pub known: Option<DeviceDiscoverInfo>,
}

impl IdMap {
    fn id_for(&mut self, mac: &str) -> u32 {
        if let Some(&id) = self.by_mac.get(mac) {
            return id;
        }
        let id = self.next;
        self.next += 1;
        self.by_mac.insert(mac.to_string(), id);
        id
    }

    /// Reserve `id` so a later discovery round can't hand it to a different camera. Used by
    /// connect-by-IP, where the caller picks the id.
    fn reserve(&mut self, id: u32) {
        self.next = self.next.max(id + 1);
    }
}

/// The slots and the signal that one of them may have changed, shared with the task that hands a
/// camera back (see [`CameraStore::with_camera`]).
struct Slots {
    cameras: Mutex<Vec<ConnCamera>>,
    /// Woken whenever a camera might have become available, or a release was announced.
    returned: Notify,
}

pub struct CameraStore {
    slots: Arc<Slots>,
    ids: Mutex<IdMap>,
    /// Devices whose current holder has been told to stop and will check the camera back in
    /// shortly, each with the deadline after which that is no longer believed. See
    /// [`CameraStore::begin_release`].
    releasing: std::sync::Mutex<HashMap<u32, Instant>>,
    /// Live streams accepting GenICam requests while they hold their camera.
    live_ops: Arc<LiveOps>,
    /// Source of [`ConnCamera::generation`].
    next_generation: AtomicU64,
    /// Per-id locks that serialise opening and closing a device. See
    /// [`CameraStore::lifecycle`].
    lifecycles: std::sync::Mutex<HashMap<u32, Arc<Mutex<()>>>>,
    /// Per-id queues in front of the checkout. See [`CameraStore::with_camera`].
    lanes: std::sync::Mutex<HashMap<u32, Arc<Mutex<()>>>>,
}

impl CameraStore {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(Slots { cameras: Mutex::new(vec![]), returned: Notify::new() }),
            ids: Mutex::new(IdMap::default()),
            releasing: std::sync::Mutex::new(HashMap::new()),
            live_ops: Arc::new(LiveOps::default()),
            next_generation: AtomicU64::new(1),
            lifecycles: std::sync::Mutex::new(HashMap::new()),
            lanes: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Take `id`'s lifecycle lock: whoever opens the device holds it from the "is it connected?"
    /// check until the camera is in the store, so two requests that both find the device closed
    /// don't both open it. The second one waits, then finds it connected.
    pub async fn lifecycle(&self, id: u32) -> OwnedMutexGuard<()> {
        let lock = self
            .lifecycles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(id)
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    /// `id`'s lane: a fair (FIFO) lock that requests for the camera queue on. Short operations hold
    /// it until they have handed the camera back, long ones only until they have it.
    fn lane(&self, id: u32) -> Arc<Mutex<()>> {
        self.lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(id)
            .or_default()
            .clone()
    }

    /// Where a live stream registers to take GenICam requests while it holds its camera.
    pub fn live_ops(&self) -> Arc<LiveOps> {
        self.live_ops.clone()
    }

    /// Announce that whoever holds `id` has been told to stop — a live stream whose client left, or
    /// a cancelled burst — so the camera will be checked back in soon.
    ///
    /// Stopping is not instant: the capture loop only notices between buffer pops, then stops the
    /// stream. Until it is done the camera is still checked out, and without this a client that
    /// closes a stream and reopens it straight away (to change a setting, say) would be refused as
    /// busy. Checkouts that find the camera held during a release wait for it instead, up to
    /// [`RELEASE_WAIT`]; a camera that is simply in use still fails fast.
    pub fn begin_release(&self, id: u32) {
        self.releasing_map().insert(id, Instant::now() + RELEASE_WAIT);
        self.slots.returned.notify_waiters();
    }

    /// The release announced by [`CameraStore::begin_release`] is over, whether or not the camera
    /// came back. Optional — the announcement expires on its own — but it stops later checkouts
    /// waiting on a release that has already happened.
    pub fn end_release(&self, id: u32) {
        self.releasing_map().remove(&id);
        self.slots.returned.notify_waiters();
    }

    fn release_deadline(&self, id: u32) -> Option<Instant> {
        let mut releasing = self.releasing_map();
        match releasing.get(&id) {
            Some(&deadline) if deadline > Instant::now() => Some(deadline),
            Some(_) => {
                releasing.remove(&id);
                None
            }
            None => None,
        }
    }

    /// Same poisoning policy as everywhere else: the map has no invariant a panic could break.
    fn releasing_map(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Instant>> {
        self.releasing.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `true` when `id` has a usable camera — either idle in the store or checked out. A slot
    /// left behind by a failed connect reports `false`, so callers retry the connect rather than
    /// treating the id as permanently live. So does a closing one: the connect then waits on the
    /// lifecycle lock until the close is done, and opens the device again.
    pub async fn is_connected(&self, id: u32) -> bool {
        let cameras = self.slots.cameras.lock().await;
        cameras.iter().any(|c| {
            c.info.id == id
                && !c.stop.is_raised()
                && (c.camera.is_some() || matches!(c.state, ConnectionState::InUse(_)))
        })
    }

    pub async fn camera_exists_by_ip(&self, ip: String) -> bool {
        let cameras = self.slots.cameras.lock().await;
        cameras.iter().any(|c| c.info.ip == ip && c.camera.is_some() && !c.stop.is_raised())
    }

    pub async fn find_id_by_ip(&self, ip: &str) -> Option<u32> {
        let cameras = self.slots.cameras.lock().await;
        cameras.iter().find(|c| c.info.ip == ip).map(|c| c.info.id)
    }

    pub async fn get_connected_camera_info(&self) -> Vec<DeviceDiscoverInfo> {
        let cameras = self.slots.cameras.lock().await;
        cameras.iter().filter(|c| c.state.is_connected() && !c.stop.is_raised())
            .map(|c| c.info.clone()).collect()
    }

    /// Put a slot into the store under a fresh generation. A rejected camera (the id is taken) is
    /// dropped on a blocking thread, since dropping a handle does network I/O.
    pub async fn add_camera(&self, mut camera: ConnCamera) -> Result<(), StoreError> {
        let mut cameras = self.slots.cameras.lock().await;
        let id = camera.info.id;
        camera.generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        if let Some(existing) = cameras.iter_mut().find(|x| x.info.id == id) {
            // A slot with no camera is a leftover from discovery or a previous failure; adopt it
            // rather than rejecting the connect. A checked-out one is very much in use.
            if existing.camera.is_some() || matches!(existing.state, ConnectionState::InUse(_)) {
                drop(cameras);
                discard(camera.camera.take()).await;
                return Err(StoreError::Exists(id));
            }
            *existing = camera;
            return Ok(());
        }
        cameras.push(camera);
        Ok(())
    }

    /// The cached GenICam metadata for `id`, without checking the camera out — so metadata
    /// requests don't serialize behind a frame grab.
    pub async fn meta(&self, id: u32) -> Option<Arc<GcMeta>> {
        let cameras = self.slots.cameras.lock().await;
        cameras.iter().find(|c| c.info.id == id).and_then(|c| c.meta.clone())
    }

    pub async fn assign_id(&self, mac: &str) -> u32 {
        self.ids.lock().await.id_for(mac)
    }

    pub async fn reserve_id(&self, id: u32) {
        self.ids.lock().await.reserve(id);
    }

    pub async fn record_discovery(&self, id: u32, device: DiscoveredDevice) {
        self.ids.lock().await.snapshot.insert(id, device);
    }

    pub async fn discovered(&self, id: u32) -> Option<DiscoveredDevice> {
        self.ids.lock().await.snapshot.get(&id).cloned()
    }

    /// Remember where `id` was connected, so it can be reconnected by id after a disconnect.
    pub async fn remember_target(&self, id: u32, target: ConnectTarget) {
        self.ids.lock().await.targets.insert(id, target);
    }

    /// Where `id` was last connected, if it ever was.
    pub async fn target(&self, id: u32) -> Option<ConnectTarget> {
        self.ids.lock().await.targets.get(&id).cloned()
    }

    /// Take the camera out of the store for exclusive use, as a `hold`. `started` is when the
    /// request arrived: its waits are measured from then, whatever it already spent in the lane.
    /// Returns the slot's generation with the handle, which [`Slots::checkin`] needs.
    ///
    /// A camera held by a short operation is waited for, up to [`OP_QUEUE_WAIT`]. One held by a
    /// live stream or a burst is busy after [`RELEASE_ANNOUNCE_GRACE`], unless its release has been
    /// announced: then the wait lasts until the release's deadline.
    async fn checkout(&self, id: u32, hold: Hold, started: Instant) -> Result<(CamHandle, u64), StoreError> {
        let queue_deadline = started + OP_QUEUE_WAIT;
        let grace = started + RELEASE_ANNOUNCE_GRACE;
        loop {
            // Registered before looking, so a check-in between the look and the wait still wakes us.
            let returned = self.slots.returned.notified();
            tokio::pin!(returned);
            returned.as_mut().enable();

            let holder = match self.try_checkout(id, hold).await {
                Ok(taken) => return Ok(taken),
                Err(Unavailable::Held(holder)) => holder,
                Err(Unavailable::Refused(e)) => return Err(e),
            };
            let wait_until = match holder {
                Hold::Short => queue_deadline,
                Hold::Long => self.release_deadline(id).unwrap_or(grace).min(queue_deadline),
            };
            if Instant::now() >= wait_until {
                return Err(StoreError::Busy(id));
            }
            // Either way, look again: woken means something changed, timed out means the next
            // pass reports Busy unless a release has been announced meanwhile.
            let _ = tokio::time::timeout_at(wait_until, returned).await;
        }
    }

    async fn try_checkout(&self, id: u32, hold: Hold) -> Result<(CamHandle, u64), Unavailable> {
        let mut cameras = self.slots.cameras.lock().await;
        let slot = cameras
            .iter_mut()
            .find(|x| x.info.id == id)
            .ok_or(Unavailable::Refused(StoreError::NotFound(id)))?;
        if slot.stop.is_raised() {
            return Err(Unavailable::Refused(StoreError::Closing(id)));
        }
        match slot.camera.take() {
            None => Err(match slot.state {
                ConnectionState::InUse(holder) => Unavailable::Held(holder),
                _ => Unavailable::Refused(StoreError::NotFound(id)),
            }),
            Some(handle) => {
                slot.state = ConnectionState::InUse(hold);
                Ok((handle, slot.generation))
            }
        }
    }

    /// Close `id`'s slot and hand back its camera, for the caller to drop on a blocking thread.
    /// Called by [`DeviceCtrl::close`](crate::controller::device_ctrl::DeviceCtrl::close) with the
    /// lifecycle lock held. `None` when there was no slot, or no camera came back.
    ///
    /// Raising the slot's stop signal marks it closing (checkouts get [`StoreError::Closing`]) and
    /// tells a live stream or burst holding the camera to stop; the wait for it to check the camera
    /// back in is announced as a release. A holder that doesn't return it within [`RELEASE_WAIT`]
    /// loses its slot anyway: the generation check in [`CameraStore::checkin`] then drops the late
    /// handle on a blocking thread, so no separate "drop on check-in" mark is needed.
    pub async fn close_slot(&self, id: u32, reason: CloseReason) -> Option<CamHandle> {
        let generation = {
            let cameras = self.slots.cameras.lock().await;
            let slot = cameras.iter().find(|c| c.info.id == id)?;
            slot.stop.raise(reason);
            slot.generation
        };
        // Wakes checkouts sitting out the busy grace, so they see the slot closing at once.
        self.begin_release(id);
        let deadline = Instant::now() + RELEASE_WAIT;
        loop {
            let returned = self.slots.returned.notified();
            tokio::pin!(returned);
            returned.as_mut().enable();

            let held = self.slots.cameras.lock().await.iter().any(|c| {
                c.info.id == id && c.generation == generation && matches!(c.state, ConnectionState::InUse(_))
            });
            if !held {
                break;
            }
            if tokio::time::timeout_at(deadline, returned).await.is_err() {
                warn!(
                    "camera {id} was not handed back within {}s of its close; dropping it when it is",
                    RELEASE_WAIT.as_secs()
                );
                break;
            }
        }
        let handle = self.remove(id).await;
        self.end_release(id);
        handle
    }

    /// Remove `id` entirely and hand back its camera so the caller can drop it on a blocking
    /// thread.
    pub async fn remove(&self, id: u32) -> Option<CamHandle> {
        let mut cameras = self.slots.cameras.lock().await;
        // Deliberately a positional remove: `Vec::pop_if` only tests the last element, which
        // silently left non-last cameras in the store with no handle and no way to reconnect.
        let idx = cameras.iter().position(|c| c.info.id == id)?;
        let camera = cameras.remove(idx).camera;
        drop(cameras);
        self.slots.returned.notify_waiters();
        camera
    }

    /// Run `f` against the camera on a blocking thread, then return the camera to the store.
    ///
    /// Every aravis-port call blocks, and each actix worker runs a current-thread runtime, so
    /// doing this work inline would stall every other in-flight request on that worker — a
    /// connect's XML fetch alone is hundreds of sequential GVCP round trips. Routing all camera
    /// access through here is also what makes the blocking safe to begin with: `Camera` is
    /// `Send` but not `Sync`, so it has to be moved rather than shared.
    ///
    /// `hold` says what the camera is taken for. Requests queue in the device's lane, in order of
    /// arrival, and a short operation keeps its place until it has handed the camera back, so short
    /// operations run one after the other instead of failing as busy. A long one (a live stream or
    /// a burst) leaves the lane once it has the camera: whoever comes next finds it held for good,
    /// and is told it's busy. See [`CameraStore::checkout`] for the waits.
    ///
    /// The work and the check-in run in a task of their own, so the camera comes back to its slot
    /// even if this future is dropped meanwhile (the client hung up): otherwise the slot would stay
    /// checked out with no handle, and the device busy until it is disconnected.
    pub async fn with_camera<T, F>(&self, id: u32, hold: Hold, f: F) -> Result<T, RcsError>
    where
        F: FnOnce(&CamHandle) -> Result<T, RcsError> + Send + 'static,
        T: Send + 'static,
    {
        let started = Instant::now();
        let Ok(lane) = tokio::time::timeout_at(started + OP_QUEUE_WAIT, self.lane(id).lock_owned()).await else {
            return Err(StoreError::Busy(id).into());
        };
        let (handle, generation) = self.checkout(id, hold, started).await?;
        let lane = match hold {
            Hold::Short => Some(lane),
            Hold::Long => {
                drop(lane);
                None
            }
        };
        // No await between the checkout and this spawn: from here the task owns the camera.
        let slots = self.slots.clone();
        let task = tokio::spawn(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                let result = f(&handle);
                (handle, result)
            })
            .await;
            let result = match outcome {
                Ok((handle, result)) => {
                    // The work happened either way, so its result stands even if the slot is gone.
                    slots.checkin(id, generation, handle).await;
                    result
                }
                Err(join_err) => {
                    // The camera moved into the blocking task and went down with it; dropping it
                    // there also put its blocking privilege-release write on the right thread.
                    warn!("camera {id} task panicked, marking slot as errored => {join_err}");
                    slots.fail(id, generation).await;
                    Err(RcsError::Blocking(format!("camera task failed: {join_err}")))
                }
            };
            // The next in line goes once the camera is back.
            drop(lane);
            result
        });
        task.await.unwrap_or_else(|e| Err(RcsError::Blocking(format!("camera task failed: {e}"))))
    }
}

impl CameraStore {
    /// Like [`CameraStore::with_camera`], but while a live stream holds the camera `f` runs inside
    /// that stream instead of failing as busy (see [`crate::stores::live_ops`]). `kind` tells the
    /// stream whether `f` changes the camera; reserved features can't be changed while live.
    ///
    /// The live stream is asked first, so requests during a stream don't each sit out the
    /// checkout's busy grace. Otherwise `f` is a short operation: it queues in the device's lane
    /// for a checkout. Forwarding into the stream takes no lock, so operations queued there still
    /// run together in one pause. `f` is `Clone` because an op the stream drops unexecuted (it
    /// ended first) is retried as a checkout.
    pub async fn with_camera_or_live<T, F>(&self, id: u32, kind: OpKind, f: F) -> Result<T, RcsError>
    where
        F: Fn(&CamHandle) -> Result<T, RcsError> + Clone + Send + 'static,
        T: Send + 'static,
    {
        if let Some(result) = self.run_live(id, &kind, f.clone()).await {
            return result;
        }
        match self.with_camera(id, Hold::Short, f.clone()).await {
            // A stream may have started between the two looks.
            Err(RcsError::StoreError(StoreError::Busy(_))) => match self.run_live(id, &kind, f).await {
                Some(result) => result,
                None => Err(StoreError::Busy(id).into()),
            },
            other => other,
        }
    }

    /// Run `f` inside the live stream holding `id`, or `None` when there is none to take it.
    async fn run_live<T, F>(&self, id: u32, kind: &OpKind, f: F) -> Option<Result<T, RcsError>>
    where
        F: Fn(&CamHandle) -> Result<T, RcsError> + Send + 'static,
        T: Send + 'static,
    {
        let sender = self.live_ops.sender(id)?;
        if let Some(feature) = kind.reserved_feature() {
            return Some(Err(RcsError::GenICamError(format!(
                "{feature} is managed by the running live stream and can't be changed while it runs; \
                 close the stream first (PixelFormat follows the stream's pixel_depth)"
            ))));
        }
        let (tx, rx) = oneshot::channel();
        let op = LiveOp::new(kind.clone(), f, tx);
        match tokio::time::timeout(LIVE_OP_SEND_TIMEOUT, sender.send(op)).await {
            Ok(Ok(())) => {}
            // Closed (the stream is ending) or full: let the checkout path decide.
            _ => return None,
        }
        match tokio::time::timeout(LIVE_OP_REPLY_TIMEOUT, rx).await {
            Ok(Ok(result)) => Some(result),
            // Dropped without running: the stream ended first and the camera is on its way back.
            Ok(Err(_)) => None,
            Err(_) => Some(Err(RcsError::Blocking(format!(
                "the live stream on camera {id} did not answer within {}s",
                LIVE_OP_REPLY_TIMEOUT.as_secs()
            )))),
        }
    }
}

/// Why a checkout found no camera to take.
enum Unavailable {
    /// Checked out, and by what kind of holder: worth waiting for, or not.
    Held(Hold),
    Refused(StoreError),
}

impl Slots {
    /// Hand a checked-out camera back to the slot it came from. `false` when that slot is gone —
    /// removed while the camera was out, and perhaps replaced by a reconnect under the same id. The
    /// handle is then stale and is dropped (on a blocking thread) rather than put into a slot it
    /// doesn't belong to. A closing slot takes it back too: the close is waiting for it.
    async fn checkin(&self, id: u32, generation: u64, handle: CamHandle) -> bool {
        let mut cameras = self.cameras.lock().await;
        let Some(slot) = cameras.iter_mut().find(|x| x.info.id == id && x.generation == generation) else {
            drop(cameras);
            debug!("camera {id}: dropping a handle whose slot is gone");
            discard(Some(handle)).await;
            return false;
        };
        slot.state = ConnectionState::Connected;
        slot.meta = Some(handle.meta.clone());
        slot.camera = Some(handle);
        drop(cameras);
        self.returned.notify_waiters();
        true
    }

    /// Mark the slot as failed. Used when a camera operation panicked, so the handle is gone but
    /// the id should remain reconnectable. A newer slot under the same id is left alone.
    async fn fail(&self, id: u32, generation: u64) {
        let mut cameras = self.cameras.lock().await;
        if let Some(slot) = cameras.iter_mut().find(|x| x.info.id == id && x.generation == generation) {
            // Checked out, so there is no handle here to drop.
            slot.state = ConnectionState::Error;
        }
        drop(cameras);
        // Waiters must not sit out their whole deadline for a camera that is not coming back.
        self.returned.notify_waiters();
    }
}

/// Drop a handle on a blocking thread: its `Drop` releases the control privilege with a blocking
/// register write.
async fn discard(handle: Option<CamHandle>) {
    if let Some(handle) = handle {
        if let Err(e) = tokio::task::spawn_blocking(move || drop(handle)).await {
            warn!("dropping a camera handle failed => {e}");
        }
    }
}

impl Default for CameraStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl CameraStore {
        /// A checkout as a live stream or a burst makes it, outside the lane.
        async fn take(&self, id: u32) -> Result<(CamHandle, u64), StoreError> {
            self.checkout(id, Hold::Long, Instant::now()).await
        }

        async fn try_take(&self, id: u32) -> Result<(CamHandle, u64), StoreError> {
            self.try_checkout(id, Hold::Long).await.map_err(|e| match e {
                Unavailable::Held(_) => StoreError::Busy(id),
                Unavailable::Refused(e) => e,
            })
        }
    }

    fn info(id: u32, mac: &str) -> DeviceDiscoverInfo {
        DeviceDiscoverInfo {
            id,
            dev_id: format!("dev-{id}"),
            serial_number: String::new(),
            vendor: String::new(),
            model: String::new(),
            manufacturer_info: String::new(),
            ip: format!("10.0.0.{id}"),
            mac: mac.to_string(),
        }
    }

    #[tokio::test]
    async fn removing_a_non_last_camera_frees_its_id() {
        let store = CameraStore::new();
        for id in 0..3 {
            store.add_camera(ConnCamera::new(info(id, &format!("mac{id}")))).await.unwrap();
        }

        // Removing the middle entry must actually remove it. A `pop_if`-style removal tests only
        // the last element, leaving the slot behind and permanently bricking the id.
        assert!(store.remove(1).await.is_none(), "no camera was ever attached");
        assert!(!store.is_connected(1).await);
        // The id is reusable: adding it back succeeds rather than reporting Exists.
        store.add_camera(ConnCamera::new(info(1, "mac1"))).await.unwrap();
        let cameras = store.slots.cameras.lock().await;
        assert_eq!(cameras.len(), 3);
    }

    #[tokio::test]
    async fn a_slot_without_a_camera_is_not_reported_connected() {
        let store = CameraStore::new();
        store.add_camera(ConnCamera::new(info(7, "mac7"))).await.unwrap();
        // Discovered-but-not-connected must not look connected, or the connect path gets skipped
        // and the id can never be opened.
        assert!(!store.is_connected(7).await);
    }

    #[tokio::test]
    async fn checkout_of_a_cameraless_slot_reports_not_found() {
        let store = CameraStore::new();
        store.add_camera(ConnCamera::new(info(1, "mac1"))).await.unwrap();
        assert!(matches!(store.take(1).await, Err(StoreError::NotFound(1))));
        assert!(matches!(store.take(99).await, Err(StoreError::NotFound(99))));
    }

    /// A slot that looks checked out by a live stream or a burst, without needing a real camera.
    async fn held(store: &CameraStore, id: u32) {
        held_as(store, id, Hold::Long).await;
    }

    async fn held_as(store: &CameraStore, id: u32, hold: Hold) {
        store.add_camera(ConnCamera::new(info(id, &format!("mac{id}")))).await.unwrap();
        store.slots.cameras.lock().await.iter_mut().find(|c| c.info.id == id).unwrap().state =
            ConnectionState::InUse(hold);
    }

    #[tokio::test]
    async fn a_held_camera_is_busy_after_only_the_short_grace() {
        let store = CameraStore::new();
        held(&store, 1).await;
        let started = std::time::Instant::now();
        assert!(matches!(store.take(1).await, Err(StoreError::Busy(1))));
        assert!(started.elapsed() < Duration::from_millis(500), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_checkout_waits_while_a_release_is_announced() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        store.begin_release(1);

        let waiter = {
            let store = store.clone();
            tokio::spawn(async move { store.take(1).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "must wait for the release, not fail at once");

        // The release ends without a camera coming back (e.g. the holder failed): the waiter must
        // be woken and answer instead of sitting out the full deadline.
        let started = std::time::Instant::now();
        store.end_release(1);
        let result = waiter.await.unwrap();
        assert!(matches!(result, Err(StoreError::Busy(1))));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn a_release_announced_during_the_grace_is_waited_for() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        let waiter = {
            let store = store.clone();
            tokio::spawn(async move { store.take(1).await })
        };
        // The request for the camera beat the close that frees it.
        tokio::time::sleep(Duration::from_millis(20)).await;
        store.begin_release(1);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "the announcement must extend the wait");
        store.end_release(1);
        assert!(matches!(waiter.await.unwrap(), Err(StoreError::Busy(1))));
    }

    #[tokio::test]
    async fn a_live_op_is_answered_by_the_registered_stream() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        let (_guard, mut ops) = store.live_ops().register(1);
        // Stands in for the capture loop. There is no camera to run against here, so it answers
        // without running the op — which the caller must take as "fall back to a checkout".
        let answered = tokio::spawn(async move {
            let op = ops.recv().await.unwrap();
            assert_eq!(op.kind, OpKind::Write("ExposureTime".into()));
            op.reply();
        });
        let started = std::time::Instant::now();
        let result = store
            .with_camera_or_live(1, OpKind::Write("ExposureTime".into()), |_| Ok(()))
            .await;
        answered.await.unwrap();
        // The fallback finds the camera held and no stream left to ask: busy.
        assert!(matches!(result, Err(RcsError::StoreError(StoreError::Busy(1)))), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_reserved_feature_is_refused_without_reaching_the_stream() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        let (_guard, mut ops) = store.live_ops().register(1);
        let result = store
            .with_camera_or_live(1, OpKind::Write("PixelFormat".into()), |_| Ok(()))
            .await;
        assert!(matches!(&result, Err(RcsError::GenICamError(m)) if m.contains("PixelFormat")), "{result:?}");
        assert!(ops.try_recv().is_err(), "nothing must be queued");
    }

    #[tokio::test]
    async fn without_a_stream_a_held_camera_is_still_busy() {
        let store = CameraStore::new();
        held(&store, 1).await;
        let result = store.with_camera_or_live(1, OpKind::Read, |_| Ok(())).await;
        assert!(matches!(result, Err(RcsError::StoreError(StoreError::Busy(1)))));
    }

    /// A fake camera on loopback, opened through `DeviceCtrl` so the slot holds a real handle.
    async fn connect_fake(store: &Arc<Box<CameraStore>>, id: u32, mac_tail: u8) -> aravis_port_fakecamera::FakeCamera {
        use aravis_port_fakecamera::{FakeCamera, FakeCameraConfig};
        let camera = FakeCamera::start(FakeCameraConfig {
            mac: aravis_port::core::MacAddress::new([0x02, 0, 0, 0, 0, mac_tail]),
            ..Default::default()
        })
        .unwrap();
        let config = crate::server_config::RuntimeConfig::default();
        let events = Arc::new(crate::events::EventBus::new(config.event_capacity));
        let clients = Arc::new(crate::stores::client_store::ClientStore::new(events.clone(), &config));
        let jobs = Arc::new(crate::stores::job_store::JobStore::new());
        let dev = crate::controller::device_ctrl::DeviceCtrl::new(store.clone(), jobs, clients, events).await.unwrap();
        dev.connect_by_addr(id, camera.local_addr(), None).await.unwrap();
        camera
    }

    #[tokio::test]
    async fn a_stale_checkin_never_replaces_a_newer_slot() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        let (old, old_generation) = store.take(1).await.unwrap();

        // Disconnected while the camera is out (a stream or a burst holding it), then reconnected
        // under the same id to a different camera.
        assert!(store.remove(1).await.is_none(), "the handle is checked out");
        let _b = connect_fake(&store, 1, 2).await;
        // Tells the two handles apart: each connect builds its own metadata.
        let new_meta = store.meta(1).await.unwrap();
        assert!(!Arc::ptr_eq(&old.meta, &new_meta));

        // The old holder finishes and hands its camera back: it must not land in the new slot.
        assert!(!store.slots.checkin(1, old_generation, old).await);
        let (current, generation) = store.take(1).await.unwrap();
        assert!(Arc::ptr_eq(&current.meta, &new_meta), "the new slot must keep its own camera");
        assert!(Arc::ptr_eq(&store.meta(1).await.unwrap(), &new_meta));
        assert_ne!(generation, old_generation);

        // Nor may a late failure report for the old generation touch the new slot.
        store.slots.fail(1, old_generation).await;
        assert!(store.slots.checkin(1, generation, current).await);
        assert!(store.is_connected(1).await);
        assert_eq!(store.get_connected_camera_info().await.len(), 1);
        if let Some(handle) = store.remove(1).await {
            tokio::task::spawn_blocking(move || drop(handle)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_checked_out_slot_is_not_overwritten_by_a_connect() {
        let store = CameraStore::new();
        held(&store, 1).await;
        assert!(matches!(store.add_camera(ConnCamera::new(info(1, "mac1"))).await, Err(StoreError::Exists(1))));
    }

    #[tokio::test]
    async fn a_close_refuses_checkouts_and_waits_for_the_holder() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        // A stream or a burst holding the camera.
        let (handle, generation) = store.take(1).await.unwrap();
        let stop = handle.stop.clone();

        let close = {
            let store = store.clone();
            tokio::spawn(async move { store.close_slot(1, CloseReason::Request).await })
        };
        while store.is_connected(1).await {
            tokio::task::yield_now().await;
        }
        assert_eq!(stop.reason(), Some(CloseReason::Request), "the holder is told to stop");
        assert!(matches!(store.try_take(1).await, Err(StoreError::Closing(1))));
        assert!(store.get_connected_camera_info().await.is_empty());
        assert!(!close.is_finished(), "the close waits for the camera to come back");

        // The holder notices and hands the camera back; the close takes it from there.
        assert!(store.slots.checkin(1, generation, handle).await);
        let handle = close.await.unwrap().expect("the close returns the handle");
        tokio::task::spawn_blocking(move || drop(handle)).await.unwrap();
        assert!(matches!(store.try_take(1).await, Err(StoreError::NotFound(1))), "the slot is gone");
    }

    #[tokio::test]
    async fn a_close_gives_up_on_a_holder_that_never_returns() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        let (late, generation) = store.take(1).await.unwrap();

        let started = std::time::Instant::now();
        assert!(store.close_slot(1, CloseReason::Request).await.is_none());
        assert!(started.elapsed() >= RELEASE_WAIT, "returned after {:?}", started.elapsed());
        assert!(!store.is_connected(1).await);
        // The late handle finds no slot and is dropped rather than resurrecting it.
        assert!(!store.slots.checkin(1, generation, late).await);
        assert!(matches!(store.try_take(1).await, Err(StoreError::NotFound(1))));
    }

    #[tokio::test]
    async fn closing_an_unknown_id_is_a_no_op() {
        let store = CameraStore::new();
        assert!(store.close_slot(9, CloseReason::Request).await.is_none());
    }

    /// Hands a test's camera back to the store's slot and drops it on a blocking thread.
    async fn disconnect(store: &CameraStore, id: u32) {
        if let Some(handle) = store.remove(id).await {
            tokio::task::spawn_blocking(move || drop(handle)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn short_ops_run_fifo() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        // A short operation in progress.
        let (handle, generation) = store.checkout(1, Hold::Short, Instant::now()).await.unwrap();

        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut ops = Vec::new();
        for i in 0..5 {
            let (store, order) = (store.clone(), order.clone());
            ops.push(tokio::spawn(async move {
                store
                    .with_camera(1, Hold::Short, move |_| {
                        order.lock().unwrap().push(i);
                        Ok(())
                    })
                    .await
            }));
            // Queued before the next one arrives.
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Held well past the busy grace: they keep waiting rather than fail.
        tokio::time::sleep(RELEASE_ANNOUNCE_GRACE * 3).await;
        assert!(order.lock().unwrap().is_empty(), "they wait for the camera");

        assert!(store.slots.checkin(1, generation, handle).await);
        for op in ops {
            op.await.unwrap().expect("a short op waits its turn instead of failing as busy");
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3, 4]);
        disconnect(&store, 1).await;
    }

    #[tokio::test(start_paused = true)]
    async fn long_hold_still_fails_fast() {
        let store = CameraStore::new();
        held(&store, 1).await;
        let started = Instant::now();
        let result = store.with_camera(1, Hold::Short, |_| Ok(())).await;
        assert!(matches!(result, Err(RcsError::StoreError(StoreError::Busy(1)))), "{result:?}");
        assert!(started.elapsed() <= RELEASE_ANNOUNCE_GRACE, "took {:?}", started.elapsed());
    }

    /// Spawns `n` short operations on `id` at once and waits for all of them.
    async fn queue_short_ops(store: &Arc<CameraStore>, id: u32, n: usize) -> Vec<Result<(), RcsError>> {
        let ops: Vec<_> = (0..n)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(async move { store.with_camera(id, Hold::Short, |_| Ok(())).await })
            })
            .collect();
        let mut results = Vec::new();
        for op in ops {
            results.push(op.await.unwrap());
        }
        results
    }

    fn all_busy(results: &[Result<(), RcsError>]) -> bool {
        results.iter().all(|r| matches!(r, Err(RcsError::StoreError(StoreError::Busy(_)))))
    }

    #[tokio::test(start_paused = true)]
    async fn queued_ops_behind_a_long_hold_cost_one_grace() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        let started = Instant::now();
        let results = queue_short_ops(&store, 1, 10).await;
        assert!(all_busy(&results), "{results:?}");
        // Each waits the grace from its own arrival, not from its turn in the lane.
        assert!(started.elapsed() < 2 * RELEASE_ANNOUNCE_GRACE, "took {:?}", started.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn a_lane_timeout_behind_a_long_hold_costs_one_deadline_not_n() {
        let store = Arc::new(CameraStore::new());
        held(&store, 1).await;
        // A stream told to stop that never hands the camera back.
        store.begin_release(1);
        let started = Instant::now();
        let results = queue_short_ops(&store, 1, 5).await;
        assert!(all_busy(&results), "{results:?}");
        let took = started.elapsed();
        assert!(took >= RELEASE_WAIT && took < RELEASE_WAIT + RELEASE_ANNOUNCE_GRACE, "took {took:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stranded_short_hold_costs_one_deadline_not_n() {
        let store = Arc::new(CameraStore::new());
        held_as(&store, 1, Hold::Short).await;
        let started = Instant::now();
        let results = queue_short_ops(&store, 1, 5).await;
        assert!(all_busy(&results), "{results:?}");
        let took = started.elapsed();
        assert!(took >= OP_QUEUE_WAIT && took < OP_QUEUE_WAIT + RELEASE_ANNOUNCE_GRACE, "took {took:?}");
    }

    #[tokio::test]
    async fn a_long_checkout_waits_for_a_short_hold() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        let (handle, generation) = store.checkout(1, Hold::Short, Instant::now()).await.unwrap();

        // A burst asked for while a feature read holds the camera (B4).
        let burst = {
            let store = store.clone();
            tokio::spawn(async move { store.with_camera(1, Hold::Long, |_| Ok(())).await })
        };
        tokio::time::sleep(RELEASE_ANNOUNCE_GRACE * 3).await;
        assert!(!burst.is_finished(), "must wait for the short op, not fail as busy");

        assert!(store.slots.checkin(1, generation, handle).await);
        burst.await.unwrap().expect("the burst gets the camera");
        disconnect(&store, 1).await;
    }

    #[tokio::test]
    async fn a_dropped_request_still_checks_the_camera_in() {
        let store = Arc::new(Box::new(CameraStore::new()));
        let _a = connect_fake(&store, 1, 1).await;
        let request = {
            let store = store.clone();
            tokio::spawn(async move {
                store
                    .with_camera(1, Hold::Short, |_| {
                        std::thread::sleep(Duration::from_millis(200));
                        Ok(())
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        // The client hung up while its operation was running.
        request.abort();

        store.with_camera(1, Hold::Short, |_| Ok(())).await.expect("the camera came back");
        assert!(store.slots.cameras.lock().await[0].camera.is_some());
        disconnect(&store, 1).await;
    }

    #[tokio::test]
    async fn ids_are_stable_per_mac_and_never_reused() {
        let store = CameraStore::new();
        let a = store.assign_id("aa:bb:cc:dd:ee:01").await;
        let b = store.assign_id("aa:bb:cc:dd:ee:02").await;
        assert_ne!(a, b);
        // Same camera, later round: same id, regardless of discovery order.
        assert_eq!(store.assign_id("aa:bb:cc:dd:ee:01").await, a);

        // A caller-chosen id from connect-by-IP must not later be handed to another camera.
        store.reserve_id(50).await;
        assert!(store.assign_id("aa:bb:cc:dd:ee:03").await > 50);
    }
}
