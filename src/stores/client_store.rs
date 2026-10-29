//! Who uses the server: sessions, the devices they are members of, what holds each device, and
//! who owns its lease (the access modes).
//!
//! One store behind one std `Mutex`, so a session can't end between being looked up and being
//! recorded on a device. The API is synchronous like [`JobStore`](super::job_store::JobStore)'s:
//! the capture loops register themselves as holders from their blocking threads.
//!
//! State events (`device_state`, `session_ended`) are sent under the same lock, so their `seq`s
//! agree with [`ClientStore::snapshot`]: a snapshot taken at `seq` N includes exactly the state
//! changes numbered up to N. Methods that depend on time take `now`, so the tests set the clock.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::{ready, Ready};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use actix_web::dev::Payload;
use actix_web::{FromRequest, HttpMessage, HttpRequest};
use chrono::{DateTime, Utc};
use tokio::sync::watch;
use uuid::Uuid;

use crate::events::{AccessState, BurstState, DeviceState, EventBus, EventKind, StateCause, StreamState};
use crate::models::access::{self, AccessError, DeviceAccess, HolderKind, HolderRef, Mode, Perm, Role};
use crate::models::device_models::CloseReason;
use crate::models::session::{ClientRef, EndReason, SessionInfo};
use crate::server_config::RuntimeConfig;

/// A client that identified itself with `POST /sessions`.
#[derive(Debug)]
pub struct Session {
    /// The secret id the client sends with its requests.
    pub id: Uuid,
    /// The public id other clients see.
    pub client_id: String,
    /// Changed by `PATCH /sessions/{id}`; read through [`Session::name`].
    name: Mutex<Option<String>>,
    pub timeout: Duration,
    pub since: DateTime<Utc>,
    /// Set once, when the session ends. The sockets that carry the session wait on it.
    ended: watch::Sender<Option<EndReason>>,
}

impl Session {
    pub fn client_ref(&self) -> ClientRef {
        ClientRef { client_id: self.client_id.clone(), name: self.name() }
    }

    pub fn name(&self) -> Option<String> {
        self.name.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// How often the client should send a heartbeat, and how often the server pings its sockets.
    pub fn heartbeat_interval(&self) -> Duration {
        self.timeout / 3
    }

    pub fn timeout_s(&self) -> u64 {
        self.timeout.as_secs()
    }

    /// Resolves to `Some` once the session has ended.
    pub fn ended(&self) -> watch::Receiver<Option<EndReason>> {
        self.ended.subscribe()
    }
}

/// Who sent a request. Put into the request extensions by the session middleware; a handler takes
/// it as an extractor.
#[derive(Debug, Clone)]
pub enum Client {
    Session(Arc<Session>),
    /// No session: the 0.3 behaviour.
    Anonymous,
}

impl Client {
    /// How events name this client: `null` for an anonymous one.
    pub fn by(&self) -> Option<ClientRef> {
        match self {
            Client::Session(s) => Some(s.client_ref()),
            Client::Anonymous => None,
        }
    }

    pub fn session(&self) -> Option<&Arc<Session>> {
        match self {
            Client::Session(s) => Some(s),
            Client::Anonymous => None,
        }
    }
}

impl FromRequest for Client {
    type Error = Infallible;
    type Future = Ready<Result<Self, Infallible>>;

    /// Without the middleware (a route mounted outside it) the request is anonymous.
    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        ready(Ok(req.extensions().get::<Client>().cloned().unwrap_or(Client::Anonymous)))
    }
}

/// A request admitted to a device, handed to the controllers. Only [`ClientStore`] makes one,
/// after checking the client's role against what the route needs, so no route reaches a camera
/// without that check. Getting one records the client as a member of the device (or its
/// anonymous activity).
#[derive(Debug, Clone)]
pub struct Admission {
    device: u32,
    client: Client,
    role: Role,
}

impl Admission {
    /// The server's own work on a device, done for no client (connecting the fake cameras, say).
    pub fn server(device: u32) -> Self {
        Self { device, client: Client::Anonymous, role: Role::Writer }
    }

    pub fn device(&self) -> u32 {
        self.device
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// The client's role on the device when it was admitted.
    pub fn role(&self) -> Role {
        self.role
    }

    pub fn by(&self) -> Option<ClientRef> {
        self.client.by()
    }
}

/// What a holder does with a device's camera.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldKind {
    Live,
    Burst { job_id: Uuid },
}

/// What has a device's camera checked out for a long time, and who started it.
#[derive(Debug)]
struct Holder {
    /// The token of the guard that registered it.
    token: u64,
    kind: HoldKind,
    /// A live capture's pixel format and bit depth, once acquisition runs.
    stream: Option<(String, u8)>,
    by: Option<ClientRef>,
    /// The session that started it, for the permission checks.
    session: Option<Uuid>,
    /// Raised when a forced `exclusive` lease evicts it.
    revoked: Arc<AtomicBool>,
}

impl Holder {
    fn cause(&self) -> StateCause {
        match self.kind {
            HoldKind::Live => StateCause::Stream,
            HoldKind::Burst { .. } => StateCause::Burst,
        }
    }

    /// Whether the device state shows it: a burst at once, a live capture once it streams.
    fn announced(&self) -> bool {
        matches!(self.kind, HoldKind::Burst { .. }) || self.stream.is_some()
    }

    fn revoked(&self) -> bool {
        self.revoked.load(Ordering::Relaxed)
    }

    fn as_ref(&self) -> HolderRef {
        HolderRef {
            kind: match self.kind {
                HoldKind::Live => HolderKind::Live,
                HoldKind::Burst { .. } => HolderKind::Burst,
            },
            client_id: self.by.as_ref().map(|b| b.client_id.clone()),
        }
    }
}

/// An open live-stream socket on a device, registered by [`ClientStore::view`].
#[derive(Debug)]
struct Viewer {
    token: u64,
    /// The session watching, `None` for an anonymous viewer.
    session: Option<Uuid>,
    /// Raised when a forced `exclusive` lease evicts this viewer.
    revoked: watch::Sender<bool>,
}

impl Viewer {
    fn revoked(&self) -> bool {
        *self.revoked.borrow()
    }
}

/// What a forced lease took away from other clients, for [`DeviceCtrl`](crate::controller::device_ctrl::DeviceCtrl)
/// to finish outside the store: the revoked live capture stops by itself, a burst has to be
/// cancelled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Eviction {
    pub live: bool,
    pub burst: bool,
}

/// What `PUT /devices/{id}/disconnect` should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisconnectDecision {
    /// Close the device now.
    pub close: bool,
    /// The sessions still members.
    pub members: u32,
}

struct SessionEntry {
    session: Arc<Session>,
    last_seen: Instant,
    last_seen_at: DateTime<Utc>,
}

impl SessionEntry {
    fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last_seen) >= self.session.timeout
    }
}

/// A `ro-shared` or `exclusive` device's owner.
struct Lease {
    owner: Uuid,
    mode: Mode,
}

struct DeviceEntry {
    connected: bool,
    /// Member sessions, in the order they joined.
    members: Vec<Uuid>,
    holder: Option<Holder>,
    /// Open live-stream sockets, in the order they joined. Counted in the stream state while a
    /// live capture streams.
    viewers: Vec<Viewer>,
    /// `None` on a `shared` device.
    lease: Option<Lease>,
    /// The last anonymous request, connect, leave or holder end: what the idle timeout counts
    /// from once nothing else keeps the device in use.
    last_active: Instant,
}

impl DeviceEntry {
    fn new(now: Instant) -> Self {
        Self { connected: false, members: Vec::new(), holder: None, viewers: Vec::new(), lease: None, last_active: now }
    }

    fn mode(&self) -> Mode {
        self.lease.as_ref().map_or(Mode::Shared, |l| l.mode)
    }

    /// The live capture's viewers, once it streams; 0 otherwise.
    fn stream_viewers(&self) -> u32 {
        match &self.holder {
            Some(h) if h.kind == HoldKind::Live && h.stream.is_some() => self.viewers.len() as u32,
            _ => 0,
        }
    }
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<Uuid, SessionEntry>,
    devices: HashMap<u32, DeviceEntry>,
    next_hold: u64,
}

impl Inner {
    fn client_ref(&self, id: &Uuid) -> Option<ClientRef> {
        self.sessions.get(id).map(|e| e.session.client_ref())
    }

    fn owner(&self, device: u32) -> Option<ClientRef> {
        let lease = self.devices.get(&device)?.lease.as_ref()?;
        self.client_ref(&lease.owner)
    }

    /// `client`'s mode and role on `device`.
    fn role(&self, device: u32, client: &Client) -> (Mode, Role) {
        let lease = self.devices.get(&device).and_then(|d| d.lease.as_ref());
        let mode = lease.map_or(Mode::Shared, |l| l.mode);
        let session = client.session().map(|s| s.id);
        let is_owner = lease.is_some_and(|l| Some(l.owner) == session);
        (mode, Role::of(mode, is_owner, session.is_some()))
    }

    /// `client`'s role on `device` if it allows `perm`.
    fn authorize(&self, device: u32, client: &Client, perm: Perm) -> Result<Role, AccessError> {
        let (mode, role) = self.role(device, client);
        access::check(mode, role, perm, self.owner(device).as_ref())?;
        Ok(role)
    }

    fn members(&self, device: u32) -> Vec<ClientRef> {
        self.devices
            .get(&device)
            .map(|d| d.members.iter().filter_map(|id| self.client_ref(id)).collect())
            .unwrap_or_default()
    }

    fn access(&self, device: u32, client: &Client) -> DeviceAccess {
        let entry = self.devices.get(&device);
        let holder = entry.and_then(|d| d.holder.as_ref());
        let (mode, you) = self.role(device, client);
        DeviceAccess {
            device,
            mode,
            owner: self.owner(device),
            members: self.members(device),
            holder: holder.map(Holder::as_ref),
            viewers: entry.map_or(0, DeviceEntry::stream_viewers),
            you,
        }
    }
}

pub struct ClientStore {
    inner: Mutex<Inner>,
    events: Arc<EventBus>,
    default_timeout: Duration,
    min_timeout: Duration,
    max_timeout: Duration,
}

impl ClientStore {
    pub fn new(events: Arc<EventBus>, config: &RuntimeConfig) -> Self {
        Self {
            inner: Mutex::default(),
            events,
            default_timeout: config.session_timeout,
            min_timeout: config.session_timeout_min,
            max_timeout: config.session_timeout_max,
        }
    }

    /// See `JobStore::jobs`: nothing here is left half-changed by a panic, so recovering beats
    /// failing every later request.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // -----------------------------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------------------------

    /// `POST /sessions`. The timeout defaults to the server's and is clamped to its range.
    pub fn create(&self, name: Option<String>, timeout_s: Option<u64>, now: Instant) -> Arc<Session> {
        let timeout = timeout_s
            .map(Duration::from_secs)
            .unwrap_or(self.default_timeout)
            .clamp(self.min_timeout, self.max_timeout);
        let mut inner = self.lock();
        let client_id = loop {
            let candidate = format!("{:08x}", Uuid::new_v4().as_u128() as u32);
            if !inner.sessions.values().any(|e| e.session.client_id == candidate) {
                break candidate;
            }
        };
        let session = Arc::new(Session {
            id: Uuid::new_v4(),
            client_id,
            name: Mutex::new(name),
            timeout,
            since: Utc::now(),
            ended: watch::Sender::new(None),
        });
        inner.sessions.insert(
            session.id,
            SessionEntry { session: session.clone(), last_seen: now, last_seen_at: Utc::now() },
        );
        session
    }

    /// The live session `id`, refreshed as a heartbeat. `None` for an unknown id and for one past
    /// its timeout that the sweep hasn't ended yet.
    pub fn resolve(&self, id: &Uuid, now: Instant) -> Option<Arc<Session>> {
        let mut inner = self.lock();
        let entry = inner.sessions.get_mut(id)?;
        if entry.expired(now) {
            return None;
        }
        entry.last_seen = now;
        entry.last_seen_at = Utc::now();
        Some(entry.session.clone())
    }

    /// A heartbeat. `false` if the session is gone.
    pub fn touch(&self, id: &Uuid, now: Instant) -> bool {
        self.resolve(id, now).is_some()
    }

    /// `PATCH /sessions/{id}`: a new name, also a heartbeat. The devices the session is a member
    /// of send `device_state` (`cause: access`), so other clients show the new name. `false` if
    /// the session is gone.
    pub fn rename(&self, id: &Uuid, name: Option<String>, now: Instant) -> bool {
        let mut inner = self.lock();
        let Some(entry) = inner.sessions.get_mut(id).filter(|e| !e.expired(now)) else {
            return false;
        };
        entry.last_seen = now;
        entry.last_seen_at = Utc::now();
        let session = entry.session.clone();
        *session.name.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = name;
        let mut changed: Vec<u32> = inner
            .devices
            .iter()
            .filter(|(_, d)| d.connected && d.members.contains(id))
            .map(|(device, _)| *device)
            .collect();
        changed.sort_unstable();
        let by = session.client_ref();
        for device in changed {
            self.emit_state(&inner, device, StateCause::Access, None, Some(by.clone()));
        }
        true
    }

    /// End session `id`: it leaves every device and gives up its leases, its sockets are told,
    /// and `session_ended` is sent. Its bursts run on. `false` if there was no such session.
    pub fn end(&self, id: &Uuid, reason: EndReason, now: Instant) -> bool {
        let ended = {
            let mut inner = self.lock();
            self.end_locked(&mut inner, id, reason, now)
        };
        match ended {
            Some(session) => {
                session.ended.send_replace(Some(reason));
                true
            }
            None => false,
        }
    }

    /// End every session whose timeout has passed. Returns how many.
    pub fn expire(&self, now: Instant) -> usize {
        let ended: Vec<Arc<Session>> = {
            let mut inner = self.lock();
            let expired: Vec<Uuid> =
                inner.sessions.iter().filter(|(_, e)| e.expired(now)).map(|(id, _)| *id).collect();
            expired
                .iter()
                .filter_map(|id| self.end_locked(&mut inner, id, EndReason::Expired, now))
                .collect()
        };
        for session in &ended {
            session.ended.send_replace(Some(EndReason::Expired));
        }
        ended.len()
    }

    fn end_locked(&self, inner: &mut Inner, id: &Uuid, reason: EndReason, now: Instant) -> Option<Arc<Session>> {
        let entry = inner.sessions.remove(id)?;
        let by = entry.session.client_ref();
        let mut changed: Vec<u32> = Vec::new();
        for (device, dev) in inner.devices.iter_mut() {
            let before = dev.members.len();
            dev.members.retain(|m| m != id);
            let left = dev.members.len() != before;
            if left {
                dev.last_active = now;
            }
            // The lease ends with its owner's session; the device is `shared` again.
            let released = dev.lease.as_ref().is_some_and(|l| l.owner == *id);
            if released {
                dev.lease = None;
            }
            if (left || released) && dev.connected {
                changed.push(*device);
            }
        }
        changed.sort_unstable();
        for device in changed {
            self.emit_state(inner, device, StateCause::Access, None, Some(by.clone()));
        }
        self.events.emit(EventKind::SessionEnded { client_id: by.client_id, reason });
        Some(entry.session)
    }

    /// `GET /sessions`, oldest first.
    pub fn list(&self) -> Vec<SessionInfo> {
        let inner = self.lock();
        let devices_where = |pred: &dyn Fn(&DeviceEntry) -> bool| {
            let mut ids: Vec<u32> = inner.devices.iter().filter(|(_, d)| pred(d)).map(|(id, _)| *id).collect();
            ids.sort_unstable();
            ids
        };
        let mut list: Vec<SessionInfo> = inner
            .sessions
            .values()
            .map(|e| {
                let id = e.session.id;
                SessionInfo {
                    client_id: e.session.client_id.clone(),
                    name: e.session.name(),
                    since: e.session.since,
                    last_seen: e.last_seen_at,
                    devices: devices_where(&|d| d.members.contains(&id)),
                    owns: devices_where(&|d| d.lease.as_ref().is_some_and(|l| l.owner == id)),
                }
            })
            .collect();
        list.sort_by_key(|s| s.since);
        list
    }

    // -----------------------------------------------------------------------------------------
    // Devices
    // -----------------------------------------------------------------------------------------

    /// Admit `client` to `device` for a route that needs `perm`, or refuse it. An admitted session
    /// that may read becomes a member (a meta-only one doesn't), and any admitted request counts
    /// as activity for the idle timeout.
    pub fn admit(&self, client: &Client, device: u32, perm: Perm, now: Instant) -> Result<Admission, AccessError> {
        let mut inner = self.lock();
        self.admit_locked(&mut inner, client, device, perm, now)
    }

    /// Check `client` against `perm` on `device` without making it a member or counting
    /// activity: for leaving a device, which must not join it first.
    pub fn admit_without_joining(&self, client: &Client, device: u32, perm: Perm) -> Result<Admission, AccessError> {
        let role = self.lock().authorize(device, client, perm)?;
        Ok(Admission { device, client: client.clone(), role })
    }

    fn admit_locked(
        &self,
        inner: &mut Inner,
        client: &Client,
        device: u32,
        perm: Perm,
        now: Instant,
    ) -> Result<Admission, AccessError> {
        let role = inner.authorize(device, client, perm)?;
        // A session that ended after the middleware resolved it doesn't join anything, and
        // neither does one that may only see the meta routes.
        let joining = client
            .session()
            .filter(|s| role.allows(Perm::Read) && inner.sessions.contains_key(&s.id))
            .cloned();
        let entry = inner.devices.entry(device).or_insert_with(|| DeviceEntry::new(now));
        entry.last_active = now;
        if let Some(session) = joining {
            if !entry.members.contains(&session.id) {
                entry.members.push(session.id);
                if entry.connected {
                    self.emit_state(inner, device, StateCause::Access, None, Some(session.client_ref()));
                }
            }
        }
        Ok(Admission { device, client: client.clone(), role })
    }

    /// `GET /devices/{id}/access`, as `client` sees it.
    pub fn access(&self, client: &Client, device: u32) -> DeviceAccess {
        self.lock().access(device, client)
    }

    /// `PUT /devices/{id}/access`: take, change or (with `shared`) give up `device`'s lease. The
    /// client needs a session. Taking a lease another session owns is refused (`423`) unless
    /// `force`, and so is going `exclusive` while other sessions are members or another client
    /// holds the camera (`409`). With `force` those clients are evicted: they leave the device,
    /// a live capture of theirs is revoked, and `access_revoked` tells each session. The
    /// [`Eviction`] says what is left to do outside the store.
    pub fn set_access(
        &self,
        client: &Client,
        device: u32,
        mode: Mode,
        force: bool,
        now: Instant,
    ) -> Result<(DeviceAccess, Eviction), AccessError> {
        let session = client.session().ok_or(AccessError::SessionRequired)?;
        let me = session.id;
        let mut inner = self.lock();
        if !inner.sessions.contains_key(&me) {
            return Err(AccessError::SessionRequired);
        }
        let owner = inner.owner(device);
        let inner = &mut *inner;
        let entry = inner.devices.entry(device).or_insert_with(|| DeviceEntry::new(now));
        let current = entry.mode();

        let previous_owner = entry.lease.as_ref().map(|l| l.owner).filter(|o| *o != me);
        if previous_owner.is_some() && !force {
            return Err(AccessError::DeviceLocked { mode: current, owner });
        }
        let mut evicted: Vec<Uuid> = previous_owner.into_iter().collect();
        let mut eviction = Eviction::default();

        if mode == Mode::Exclusive {
            let others: Vec<Uuid> = entry.members.iter().copied().filter(|m| *m != me).collect();
            // Viewers evicted before are on their way out, and so is a revoked holder.
            let other_viewers: Vec<u64> = entry
                .viewers
                .iter()
                .filter(|v| v.session != Some(me) && !v.revoked())
                .map(|v| v.token)
                .collect();
            let my_viewer = entry.viewers.iter().any(|v| v.session == Some(me) && !v.revoked());
            // A live capture is used by its viewers, whoever started it. One without viewers is
            // stopping, or stands for its starter.
            let has_viewers = !entry.viewers.is_empty();
            let other_holder = entry.holder.as_ref().filter(|h| {
                !h.revoked()
                    && match h.kind {
                        HoldKind::Live if has_viewers => !other_viewers.is_empty(),
                        _ => h.session != Some(me),
                    }
            });
            if !force && (!others.is_empty() || other_holder.is_some()) {
                let members = others
                    .iter()
                    .filter_map(|id| inner.sessions.get(id).map(|e| e.session.client_ref()))
                    .collect();
                return Err(AccessError::DeviceInUse {
                    mode: current,
                    owner,
                    members,
                    holder: other_holder.map(Holder::as_ref),
                });
            }
            let holder_in_use = other_holder.is_some();
            // Every other viewer loses the stream: its socket closes with 4003.
            for viewer in entry.viewers.iter().filter(|v| other_viewers.contains(&v.token)) {
                viewer.revoked.send_replace(true);
                evicted.extend(viewer.session);
            }
            if let Some(holder) = entry.holder.as_mut().filter(|_| holder_in_use) {
                if holder.kind == HoldKind::Live && my_viewer {
                    // This client watches the capture too: it keeps running, now held by it.
                    holder.session = Some(me);
                    holder.by = Some(session.client_ref());
                } else {
                    holder.revoked.store(true, Ordering::Relaxed);
                    match holder.kind {
                        HoldKind::Live => eviction.live = true,
                        HoldKind::Burst { .. } => eviction.burst = true,
                    }
                    evicted.extend(holder.session);
                }
            }
            entry.members.retain(|m| *m == me);
            evicted.extend(others);
        }

        entry.lease = (mode != Mode::Shared).then_some(Lease { owner: me, mode });
        if !entry.members.contains(&me) {
            entry.members.push(me);
        }
        entry.last_active = now;
        let connected = entry.connected;

        let by = session.client_ref();
        let mut told: Vec<Uuid> = Vec::new();
        for id in evicted {
            if id == me || told.contains(&id) {
                continue;
            }
            told.push(id);
            if let Some(lost) = inner.client_ref(&id) {
                self.events.emit(EventKind::AccessRevoked { device, client_id: lost.client_id, by: Some(by.clone()) });
            }
        }
        if connected {
            self.emit_state(inner, device, StateCause::Access, None, Some(by));
        }
        Ok((inner.access(device, client), eviction))
    }

    /// `DELETE /devices/{id}/access`: the owner gives up the lease, or anyone breaks it with
    /// `force` (the owner gets `access_revoked`). The device is `shared` again. Nothing to do
    /// without a lease.
    pub fn release_access(&self, client: &Client, device: u32, force: bool) -> Result<DeviceAccess, AccessError> {
        let session = client.session().ok_or(AccessError::SessionRequired)?;
        let mut inner = self.lock();
        let owner = inner.owner(device);
        let Some(entry) = inner.devices.get_mut(&device) else {
            return Ok(inner.access(device, client));
        };
        let Some(lease) = entry.lease.as_ref() else {
            return Ok(inner.access(device, client));
        };
        let previous = lease.owner;
        if previous != session.id && !force {
            return Err(AccessError::DeviceLocked { mode: lease.mode, owner });
        }
        entry.lease = None;
        let connected = entry.connected;
        let by = session.client_ref();
        if previous != session.id {
            if let Some(lost) = owner {
                self.events.emit(EventKind::AccessRevoked { device, client_id: lost.client_id, by: Some(by.clone()) });
            }
        }
        if connected {
            self.emit_state(&inner, device, StateCause::Access, None, Some(by));
        }
        Ok(inner.access(device, client))
    }

    /// A lease was taken for a device that then failed to open: a closed device has none.
    pub fn drop_lease(&self, device: u32) {
        if let Some(entry) = self.lock().devices.get_mut(&device) {
            entry.lease = None;
        }
    }

    /// `PUT /devices/{id}/disconnect` without `force`. A session leaves the device, which closes
    /// when no member and no holder is left. An anonymous client closes it unless a session is a
    /// member or holds it: its own stream or burst (or another anonymous one) doesn't stop it,
    /// as in 0.3.
    pub fn disconnect_decision(&self, client: &Client, device: u32, now: Instant) -> DisconnectDecision {
        let mut inner = self.lock();
        let Some(entry) = inner.devices.get_mut(&device) else {
            return DisconnectDecision { close: true, members: 0 };
        };
        match client {
            Client::Session(session) => {
                let before = entry.members.len();
                entry.members.retain(|m| *m != session.id);
                let left = entry.members.len() != before;
                if left {
                    entry.last_active = now;
                }
                let decision = DisconnectDecision {
                    close: entry.members.is_empty() && entry.holder.is_none(),
                    members: entry.members.len() as u32,
                };
                if left && entry.connected {
                    self.emit_state(&inner, device, StateCause::Access, None, Some(session.client_ref()));
                }
                decision
            }
            Client::Anonymous => DisconnectDecision {
                close: entry.members.is_empty() && entry.holder.as_ref().is_none_or(|h| h.session.is_none()),
                members: entry.members.len() as u32,
            },
        }
    }

    /// The members of `device`, as others see them.
    pub fn members(&self, device: u32) -> u32 {
        self.lock().devices.get(&device).map_or(0, |d| d.members.len() as u32)
    }

    /// `device` was opened. Sends `device_state` (`connected`).
    pub fn device_opened(&self, device: u32, by: Option<ClientRef>, now: Instant) {
        let mut inner = self.lock();
        let entry = inner.devices.entry(device).or_insert_with(|| DeviceEntry::new(now));
        entry.connected = true;
        entry.last_active = now;
        self.emit_state(&inner, device, StateCause::Connected, None, by);
    }

    /// `device` was closed: its members and its lease are gone with it. Sends `device_state`
    /// (`disconnected`) if it was open.
    pub fn device_closed(&self, device: u32, reason: CloseReason, by: Option<ClientRef>, now: Instant) {
        let mut inner = self.lock();
        let Some(entry) = inner.devices.get_mut(&device) else { return };
        let was_connected = entry.connected;
        entry.connected = false;
        entry.members.clear();
        entry.lease = None;
        entry.last_active = now;
        if was_connected {
            self.emit_state(&inner, device, StateCause::Disconnected, Some(reason), by);
        }
    }

    /// Register the admitted client as `adm`'s device's holder until the guard drops. Called by
    /// the capture loops right after they took the camera and before acquisition starts, and
    /// checked again here: the device may have gone `exclusive` or `ro-shared` for someone else
    /// since the request was admitted. The check and the registration are one step, so a lease
    /// request either sees this holder or refuses it.
    ///
    /// A burst sends `device_state` (`burst`) now, a live capture once [`HoldGuard::streaming`]
    /// says how it streams; each sends another when its guard drops.
    pub fn hold(self: &Arc<Self>, adm: &Admission, kind: HoldKind) -> Result<HoldGuard, AccessError> {
        let mut inner = self.lock();
        let device = adm.device;
        inner.authorize(device, &adm.client, Perm::Write)?;
        inner.next_hold += 1;
        let token = inner.next_hold;
        let revoked = Arc::new(AtomicBool::new(false));
        let holder = Holder {
            token,
            kind,
            stream: None,
            by: adm.by(),
            session: adm.client.session().map(|s| s.id),
            revoked: revoked.clone(),
        };
        let announce = holder.announced().then(|| (holder.cause(), holder.by.clone()));
        let now = Instant::now();
        inner.devices.entry(device).or_insert_with(|| DeviceEntry::new(now)).holder = Some(holder);
        if let Some((cause, by)) = announce {
            self.emit_state(&inner, device, cause, None, by);
        }
        Ok(HoldGuard { store: self.clone(), device, token, revoked })
    }

    /// Register an open live-stream socket of the admitted client on `adm`'s device until the
    /// guard drops. Counted in `stream.viewers`; a forced `exclusive` lease of another session
    /// revokes it ([`ViewerGuard::revoked`]).
    pub fn view(self: &Arc<Self>, adm: &Admission) -> ViewerGuard {
        let mut inner = self.lock();
        inner.next_hold += 1;
        let token = inner.next_hold;
        let (revoked, rx) = watch::channel(false);
        let now = Instant::now();
        let entry = inner.devices.entry(adm.device).or_insert_with(|| DeviceEntry::new(now));
        entry.viewers.push(Viewer { token, session: adm.client.session().map(|s| s.id), revoked });
        if entry.stream_viewers() > 0 {
            self.emit_state(&inner, adm.device, StateCause::Stream, None, adm.by());
        }
        ViewerGuard { store: self.clone(), device: adm.device, token, by: adm.by(), revoked: rx }
    }

    fn unview(&self, device: u32, token: u64, by: Option<ClientRef>) {
        let mut inner = self.lock();
        let Some(entry) = inner.devices.get_mut(&device) else { return };
        let before = entry.viewers.len();
        entry.viewers.retain(|v| v.token != token);
        // The last viewer's leave stops the capture, whose end is announced instead.
        if entry.viewers.len() != before && entry.stream_viewers() > 0 {
            self.emit_state(&inner, device, StateCause::Stream, None, by);
        }
    }

    fn streaming(&self, device: u32, token: u64, pixel_format: String, bit_depth: u8) {
        let mut inner = self.lock();
        let Some(holder) =
            inner.devices.get_mut(&device).and_then(|d| d.holder.as_mut()).filter(|h| h.token == token)
        else {
            return;
        };
        holder.stream = Some((pixel_format, bit_depth));
        let (cause, by) = (holder.cause(), holder.by.clone());
        self.emit_state(&inner, device, cause, None, by);
    }

    fn release_hold(&self, device: u32, token: u64, now: Instant) {
        let mut inner = self.lock();
        let Some(entry) = inner.devices.get_mut(&device) else { return };
        if !entry.holder.as_ref().is_some_and(|h| h.token == token) {
            return;
        }
        let holder = entry.holder.take().expect("checked above");
        entry.last_active = now;
        if holder.announced() {
            self.emit_state(&inner, device, holder.cause(), None, holder.by.clone());
        }
    }

    /// Whether `device` is open but unused: no member, no holder and no activity for `timeout`.
    pub fn is_idle(&self, device: u32, now: Instant, timeout: Duration) -> bool {
        self.lock().devices.get(&device).is_some_and(|d| Self::idle(d, now, timeout))
    }

    /// Every device [`ClientStore::is_idle`] would close.
    pub fn idle_devices(&self, now: Instant, timeout: Duration) -> Vec<u32> {
        let inner = self.lock();
        let mut idle: Vec<u32> =
            inner.devices.iter().filter(|(_, d)| Self::idle(d, now, timeout)).map(|(id, _)| *id).collect();
        idle.sort_unstable();
        idle
    }

    fn idle(d: &DeviceEntry, now: Instant, timeout: Duration) -> bool {
        d.connected
            && d.members.is_empty()
            && d.holder.is_none()
            && now.saturating_duration_since(d.last_active) >= timeout
    }

    /// Every connected device's state, and the `seq` of the last event it includes.
    pub fn snapshot(&self) -> (u64, Vec<DeviceState>) {
        let inner = self.lock();
        let mut ids: Vec<u32> = inner.devices.iter().filter(|(_, d)| d.connected).map(|(id, _)| *id).collect();
        ids.sort_unstable();
        let states = ids.into_iter().map(|id| Self::state(&inner, id)).collect();
        (self.events.seq(), states)
    }

    fn state(inner: &Inner, device: u32) -> DeviceState {
        let entry = inner.devices.get(&device);
        let holder = entry.and_then(|d| d.holder.as_ref());
        DeviceState {
            device,
            connected: entry.is_some_and(|d| d.connected),
            access: AccessState {
                mode: entry.map_or(Mode::Shared, DeviceEntry::mode),
                owner: inner.owner(device),
                members: inner.members(device),
            },
            stream: match holder {
                Some(Holder { kind: HoldKind::Live, stream: Some((pixel_format, bit_depth)), .. }) => {
                    Some(StreamState {
                        viewers: entry.map_or(0, DeviceEntry::stream_viewers),
                        pixel_format: pixel_format.clone(),
                        bit_depth: *bit_depth,
                    })
                }
                _ => None,
            },
            burst: match holder {
                Some(Holder { kind: HoldKind::Burst { job_id }, by, .. }) => {
                    Some(BurstState { job_id: *job_id, client_id: by.as_ref().map(|b| b.client_id.clone()) })
                }
                _ => None,
            },
        }
    }

    /// Send `device`'s state. Called with the lock held, so the event's `seq` orders it with the
    /// snapshots.
    fn emit_state(
        &self,
        inner: &Inner,
        device: u32,
        cause: StateCause,
        reason: Option<CloseReason>,
        by: Option<ClientRef>,
    ) {
        let state = Self::state(inner, device);
        self.events.emit(EventKind::DeviceState { state, cause, reason, by });
    }
}

/// Keeps a holder registered on its device. Dropping it (on the capture loop's thread) ends the
/// hold.
pub struct HoldGuard {
    store: Arc<ClientStore>,
    device: u32,
    token: u64,
    revoked: Arc<AtomicBool>,
}

impl HoldGuard {
    /// The live capture runs, with this pixel format: the device state shows the stream now.
    pub fn streaming(&self, pixel_format: String, bit_depth: u8) {
        self.store.streaming(self.device, self.token, pixel_format, bit_depth);
    }

    /// A forced `exclusive` lease took the device from this holder: stop.
    pub fn revoked(&self) -> bool {
        self.revoked.load(Ordering::Relaxed)
    }
}

impl Drop for HoldGuard {
    fn drop(&mut self) {
        self.store.release_hold(self.device, self.token, Instant::now());
    }
}

/// Keeps a live-stream socket registered as a viewer of its device. Dropping it unregisters.
pub struct ViewerGuard {
    store: Arc<ClientStore>,
    device: u32,
    token: u64,
    by: Option<ClientRef>,
    revoked: watch::Receiver<bool>,
}

impl ViewerGuard {
    /// Resolves once a forced `exclusive` lease of another session took the device from this
    /// viewer.
    pub async fn revoked(&mut self) {
        // The sender goes only with the registration, i.e. with this guard.
        if self.revoked.wait_for(|r| *r).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.store.unview(self.device, self.token, self.by.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Event;
    use tokio::sync::broadcast::Receiver;

    const SECOND: Duration = Duration::from_secs(1);
    const IDLE: Duration = Duration::from_secs(300);

    fn store() -> (Arc<ClientStore>, Receiver<Arc<Event>>) {
        let bus = Arc::new(EventBus::new(64));
        let rx = bus.subscribe();
        let config = RuntimeConfig::default();
        (Arc::new(ClientStore::new(bus, &config)), rx)
    }

    fn drain(rx: &mut Receiver<Arc<Event>>) -> Vec<Arc<Event>> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn session(store: &ClientStore, now: Instant) -> Client {
        Client::Session(store.create(Some("test".into()), None, now))
    }

    #[test]
    fn a_session_expires_without_heartbeats_and_a_heartbeat_extends_it() {
        let (store, mut rx) = store();
        let t0 = Instant::now();
        let s = store.create(None, Some(10), t0);
        assert_eq!(s.timeout, 10 * SECOND);
        assert_eq!(s.heartbeat_interval().as_secs(), 3);

        assert!(store.touch(&s.id, t0 + 9 * SECOND), "a heartbeat within the timeout");
        assert_eq!(store.expire(t0 + 18 * SECOND), 0, "counted from the heartbeat");
        assert!(store.resolve(&s.id, t0 + 19 * SECOND).is_none(), "past its timeout, not yet swept");

        let mut ended = s.ended();
        assert_eq!(store.expire(t0 + 19 * SECOND), 1);
        assert!(ended.has_changed().unwrap());
        assert_eq!(*ended.borrow_and_update(), Some(EndReason::Expired));
        let events = drain(&mut rx);
        assert!(matches!(
            &events.last().unwrap().kind,
            EventKind::SessionEnded { client_id, reason: EndReason::Expired } if *client_id == s.client_id
        ));
        assert!(store.list().is_empty());
        assert!(!store.end(&s.id, EndReason::Closed, t0), "already gone");
    }

    #[test]
    fn the_timeout_is_clamped() {
        let (store, _rx) = store();
        let now = Instant::now();
        assert_eq!(store.create(None, Some(1), now).timeout, 5 * SECOND);
        assert_eq!(store.create(None, Some(100_000), now).timeout, 600 * SECOND);
        assert_eq!(store.create(None, None, now).timeout, 30 * SECOND);
    }

    #[test]
    fn client_ids_are_short_hex_and_unique() {
        let (store, _rx) = store();
        let now = Instant::now();
        let ids: std::collections::HashSet<String> =
            (0..200).map(|_| store.create(None, None, now).client_id.clone()).collect();
        assert_eq!(ids.len(), 200);
        assert!(ids.iter().all(|id| id.len() == 8 && id.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn using_a_device_makes_a_session_a_member_until_it_leaves() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let a = session(&store, now);
        let b = session(&store, now);
        store.admit(&a, 0, Perm::Read, now).unwrap();
        store.admit(&a, 0, Perm::Read, now).unwrap();
        store.admit(&b, 0, Perm::Read, now).unwrap();
        assert_eq!(store.members(0), 2);
        let (_, devices) = store.snapshot();
        assert_eq!(devices[0].access.members.len(), 2, "each session once, in join order");
        assert_eq!(devices[0].access.members[0], a.by().unwrap());
        assert_eq!(store.list()[0].devices, vec![0]);

        let events = drain(&mut rx);
        let causes: Vec<_> = events
            .iter()
            .filter_map(|e| match &e.kind {
                EventKind::DeviceState { cause, .. } => Some(*cause),
                _ => None,
            })
            .collect();
        assert_eq!(causes, vec![StateCause::Connected, StateCause::Access, StateCause::Access]);

        assert_eq!(store.disconnect_decision(&a, 0, now), DisconnectDecision { close: false, members: 1 });
        assert_eq!(store.disconnect_decision(&b, 0, now), DisconnectDecision { close: true, members: 0 });
    }

    #[test]
    fn an_ended_session_leaves_its_devices() {
        let (store, _rx) = store();
        let now = Instant::now();
        store.device_opened(3, None, now);
        let a = session(&store, now);
        store.admit(&a, 3, Perm::Read, now).unwrap();
        store.end(&a.session().unwrap().id, EndReason::Closed, now + SECOND);
        assert_eq!(store.members(3), 0);
        // The idle timeout counts from the leave, not from the last request.
        assert!(!store.is_idle(3, now + IDLE, IDLE));
        assert!(store.is_idle(3, now + SECOND + IDLE, IDLE));
    }

    #[test]
    fn an_ended_session_that_was_resolved_before_does_not_join() {
        let (store, _rx) = store();
        let now = Instant::now();
        let a = session(&store, now);
        store.end(&a.session().unwrap().id, EndReason::Closed, now);
        store.admit(&a, 0, Perm::Read, now).unwrap();
        assert_eq!(store.members(0), 0);
    }

    #[test]
    fn the_idle_decision() {
        let (store, _rx) = store();
        let t0 = Instant::now();
        assert!(!store.is_idle(0, t0 + IDLE, IDLE), "not connected");
        store.device_opened(0, None, t0);
        assert!(!store.is_idle(0, t0 + IDLE - SECOND, IDLE));
        assert!(store.is_idle(0, t0 + IDLE, IDLE));
        assert_eq!(store.idle_devices(t0 + IDLE, IDLE), vec![0]);

        // Anonymous activity counts.
        store.admit(&Client::Anonymous, 0, Perm::Read, t0 + 100 * SECOND).unwrap();
        assert!(!store.is_idle(0, t0 + IDLE, IDLE));
        assert!(store.is_idle(0, t0 + 100 * SECOND + IDLE, IDLE));

        // A member keeps it open forever.
        let a = session(&store, t0);
        store.admit(&a, 0, Perm::Read, t0).unwrap();
        assert!(!store.is_idle(0, t0 + 100 * IDLE, IDLE));
        store.disconnect_decision(&a, 0, t0 + 200 * SECOND);

        // So does a holder.
        let guard = store.hold(&Admission::server(0), HoldKind::Burst { job_id: Uuid::new_v4() }).unwrap();
        assert!(!store.is_idle(0, t0 + 100 * IDLE, IDLE));
        drop(guard);
        assert!(!store.is_idle(0, Instant::now() + IDLE - SECOND, IDLE), "counted from the holder's end");
        assert!(store.is_idle(0, Instant::now() + IDLE, IDLE));

        store.device_closed(0, CloseReason::Idle, None, t0);
        assert!(store.idle_devices(t0 + 100 * IDLE, IDLE).is_empty());
    }

    #[test]
    fn anonymous_disconnects_are_held_back_only_by_sessions() {
        let (store, _rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let anon = Client::Anonymous;
        assert_eq!(store.disconnect_decision(&anon, 0, now), DisconnectDecision { close: true, members: 0 });
        assert!(store.disconnect_decision(&anon, 9, now).close, "unknown device");

        // An anonymous stream doesn't stop an anonymous disconnect (the 0.3 behaviour)...
        let guard = store.hold(&Admission::server(0), HoldKind::Live).unwrap();
        assert!(store.disconnect_decision(&anon, 0, now).close);
        drop(guard);

        // ...but a session's stream does, and so does a member.
        let a = session(&store, now);
        let guard = store.hold(&store.admit_without_joining(&a, 0, Perm::Write).unwrap(), HoldKind::Live).unwrap();
        assert_eq!(store.disconnect_decision(&anon, 0, now), DisconnectDecision { close: false, members: 0 });
        // A session leaving while a stream holds the device doesn't close it either.
        assert!(!store.disconnect_decision(&a, 0, now).close);
        drop(guard);
        store.admit(&a, 0, Perm::Read, now).unwrap();
        assert_eq!(store.disconnect_decision(&anon, 0, now), DisconnectDecision { close: false, members: 1 });
    }

    #[test]
    fn a_hold_shows_in_the_state_and_only_its_own_guard_ends_it() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let a = session(&store, now);
        let adm = store.admit_without_joining(&a, 0, Perm::Write).unwrap();
        let first = store.hold(&adm, HoldKind::Live).unwrap();
        let view = store.view(&adm);
        assert_eq!(store.snapshot().1[0].stream, None, "not streaming yet");
        first.streaming("Mono12".into(), 12);
        let (_, states) = store.snapshot();
        assert_eq!(
            states[0].stream,
            Some(StreamState { viewers: 1, pixel_format: "Mono12".into(), bit_depth: 12 })
        );
        let job_id = Uuid::new_v4();
        let second = store.hold(&Admission::server(0), HoldKind::Burst { job_id }).unwrap();
        drop((first, view));
        let (seq, states) = store.snapshot();
        assert_eq!(states[0].burst, Some(BurstState { job_id, client_id: None }), "a stale guard is ignored");
        assert_eq!(states[0].stream, None);
        drop(second);
        assert_eq!(store.snapshot().1[0].burst, None);

        let events = drain(&mut rx);
        assert!(events.iter().any(|e| e.seq == seq), "the snapshot's seq is a sent event");
    }

    #[test]
    fn closing_a_device_clears_its_members() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let a = session(&store, now);
        store.admit(&a, 0, Perm::Read, now).unwrap();
        drain(&mut rx);
        store.device_closed(0, CloseReason::Forced, a.by(), now);
        assert_eq!(store.members(0), 0);
        assert!(store.snapshot().1.is_empty());
        let events = drain(&mut rx);
        assert_eq!(events.len(), 1);
        match &events[0].kind {
            EventKind::DeviceState { state, cause, reason, by } => {
                assert!(!state.connected);
                assert_eq!(*cause, StateCause::Disconnected);
                assert_eq!(*reason, Some(CloseReason::Forced));
                assert_eq!(*by, a.by());
            }
            other => panic!("unexpected {other:?}"),
        }
        // A second close of a closed device says nothing.
        store.device_closed(0, CloseReason::Request, None, now);
        assert!(drain(&mut rx).is_empty());
    }

    fn access_events(rx: &mut Receiver<Arc<Event>>) -> Vec<EventKind> {
        drain(rx)
            .into_iter()
            .filter(|e| matches!(e.kind, EventKind::AccessRevoked { .. } | EventKind::DeviceState { .. }))
            .map(|e| e.kind.clone())
            .collect()
    }

    fn status(e: AccessError) -> u16 {
        e.status().as_u16()
    }

    #[test]
    fn a_lease_sets_the_roles_and_a_meta_admission_does_not_join() {
        let (store, _rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let (a, b, anon) = (session(&store, now), session(&store, now), Client::Anonymous);

        let (access, eviction) = store.set_access(&a, 0, Mode::RoShared, false, now).unwrap();
        assert_eq!(eviction, Eviction::default());
        assert_eq!((access.mode, access.you), (Mode::RoShared, Role::Owner));
        assert_eq!(access.owner, a.by());
        assert_eq!(store.list()[0].owns, vec![0]);

        // ro-shared: another session reads, but doesn't write; anonymous gets meta.
        assert_eq!(store.admit(&b, 0, Perm::Read, now).unwrap().role(), Role::Reader);
        assert_eq!(status(store.admit(&b, 0, Perm::Write, now).unwrap_err()), 403);
        assert_eq!(status(store.admit(&anon, 0, Perm::Read, now).unwrap_err()), 423);
        assert_eq!(store.admit(&anon, 0, Perm::Meta, now).unwrap().role(), Role::Meta);
        assert_eq!(store.members(0), 2, "the owner and the reader");
        assert_eq!(store.access(&b, 0).you, Role::Reader);

        // exclusive (b left first): b gets meta only, and that doesn't make it a member.
        store.disconnect_decision(&b, 0, now);
        store.set_access(&a, 0, Mode::Exclusive, false, now).unwrap();
        assert_eq!(status(store.admit(&b, 0, Perm::Read, now).unwrap_err()), 423);
        assert_eq!(store.admit(&b, 0, Perm::Meta, now).unwrap().role(), Role::Meta);
        assert_eq!(store.members(0), 1);
        assert_eq!(store.access(&anon, 0).you, Role::Meta);
    }

    #[test]
    fn taking_an_owned_lease_needs_force_and_revokes_it() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let (a, b) = (session(&store, now), session(&store, now));
        store.set_access(&a, 0, Mode::RoShared, false, now).unwrap();
        drain(&mut rx);

        let refused = store.set_access(&b, 0, Mode::RoShared, false, now).unwrap_err();
        assert_eq!(refused, AccessError::DeviceLocked { mode: Mode::RoShared, owner: a.by() });
        assert_eq!(status(store.set_access(&b, 0, Mode::Shared, false, now).unwrap_err()), 423);
        assert_eq!(status(store.release_access(&b, 0, false).unwrap_err()), 423);
        assert!(drain(&mut rx).is_empty(), "a refusal changes nothing");

        let (access, _) = store.set_access(&b, 0, Mode::RoShared, true, now).unwrap();
        assert_eq!(access.owner, b.by());
        assert_eq!(store.members(0), 2, "ro-shared evicts nobody: a stays, as a reader");
        let events = access_events(&mut rx);
        assert!(matches!(&events[0], EventKind::AccessRevoked { device: 0, client_id, by }
            if *client_id == a.by().unwrap().client_id && *by == b.by()));
        assert!(matches!(&events[1], EventKind::DeviceState { cause: StateCause::Access, state, .. }
            if state.access.mode == Mode::RoShared && state.access.owner == b.by()));
        assert_eq!(events.len(), 2);

        // The owner changes the mode, then gives the lease up; releasing nothing is a no-op.
        assert_eq!(store.set_access(&b, 0, Mode::Exclusive, true, now).unwrap().0.mode, Mode::Exclusive);
        assert_eq!(store.release_access(&b, 0, false).unwrap().mode, Mode::Shared);
        assert_eq!(store.release_access(&b, 0, false).unwrap().mode, Mode::Shared);
        assert_eq!(status(store.release_access(&Client::Anonymous, 0, false).unwrap_err()), 400);
        assert_eq!(status(store.set_access(&Client::Anonymous, 0, Mode::Exclusive, false, now).unwrap_err()), 400);

        // Breaking someone's lease tells them.
        store.set_access(&a, 0, Mode::Exclusive, true, now).unwrap();
        drain(&mut rx);
        assert_eq!(store.release_access(&b, 0, true).unwrap().owner, None);
        assert!(matches!(&access_events(&mut rx)[0], EventKind::AccessRevoked { client_id, .. }
            if *client_id == a.by().unwrap().client_id));
    }

    #[test]
    fn going_exclusive_with_others_present_needs_force_which_evicts_them() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let (a, b) = (session(&store, now), session(&store, now));
        store.admit(&b, 0, Perm::Read, now).unwrap();

        match store.set_access(&a, 0, Mode::Exclusive, false, now).unwrap_err() {
            AccessError::DeviceInUse { members, holder, .. } => {
                assert_eq!(members, vec![b.by().unwrap()]);
                assert_eq!(holder, None);
            }
            other => panic!("unexpected {other:?}"),
        }
        // Becoming ro-shared doesn't need anyone gone.
        store.set_access(&a, 0, Mode::RoShared, false, now).unwrap();
        store.release_access(&a, 0, false).unwrap();

        // An anonymous stream holds the device too.
        store.disconnect_decision(&b, 0, now);
        let stream = store.hold(&Admission::server(0), HoldKind::Live).unwrap();
        match store.set_access(&a, 0, Mode::Exclusive, false, now).unwrap_err() {
            AccessError::DeviceInUse { holder, .. } => {
                assert_eq!(holder, Some(HolderRef { kind: HolderKind::Live, client_id: None }));
            }
            other => panic!("unexpected {other:?}"),
        }

        store.admit(&b, 0, Perm::Read, now).unwrap();
        drain(&mut rx);
        let (access, eviction) = store.set_access(&a, 0, Mode::Exclusive, true, now).unwrap();
        assert_eq!(eviction, Eviction { live: true, burst: false });
        assert!(stream.revoked());
        assert_eq!(access.members, vec![a.by().unwrap()], "b was evicted");
        let revoked: Vec<String> = access_events(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                EventKind::AccessRevoked { client_id, .. } => Some(client_id),
                _ => None,
            })
            .collect();
        assert_eq!(revoked, vec![b.by().unwrap().client_id], "only sessions are told");

        // The revoked stream is on its way out: it doesn't block asking again.
        assert!(store.set_access(&a, 0, Mode::Exclusive, false, now).is_ok());
        drop(stream);

        // Another session's burst is cancelled by a force.
        store.release_access(&a, 0, false).unwrap();
        let burst = store
            .hold(&store.admit(&b, 0, Perm::Write, now).unwrap(), HoldKind::Burst { job_id: Uuid::new_v4() })
            .unwrap();
        let (_, eviction) = store.set_access(&a, 0, Mode::Exclusive, true, now).unwrap();
        assert_eq!(eviction, Eviction { live: false, burst: true });
        assert!(burst.revoked());
    }

    #[test]
    fn a_hold_is_checked_again_when_the_capture_starts() {
        let (store, _rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let (a, b) = (session(&store, now), session(&store, now));
        // Admitted while shared...
        let b_adm = store.admit(&b, 0, Perm::Write, now).unwrap();
        let anon_adm = store.admit(&Client::Anonymous, 0, Perm::Write, now).unwrap();
        // ...but a took the device before the capture got the camera.
        store.set_access(&a, 0, Mode::RoShared, true, now).unwrap();
        assert_eq!(status(store.hold(&b_adm, HoldKind::Live).err().unwrap()), 403);
        assert_eq!(status(store.hold(&anon_adm, HoldKind::Burst { job_id: Uuid::new_v4() }).err().unwrap()), 423);
        assert!(store.snapshot().1[0].stream.is_none() && store.access(&a, 0).holder.is_none());

        // The owner's own capture is fine, and a reader may watch it.
        let a_adm = store.admit(&a, 0, Perm::Write, now).unwrap();
        let guard = store.hold(&a_adm, HoldKind::Live).unwrap();
        let _a_view = store.view(&a_adm);
        assert_eq!(store.access(&b, 0).viewers, 0, "not streaming yet");
        guard.streaming("Mono8".into(), 8);
        assert_eq!(store.access(&b, 0).viewers, 1);
        let b_adm = store.admit(&b, 0, Perm::Read, now).unwrap();
        assert_eq!(b_adm.role(), Role::Reader);
        let b_view = store.view(&b_adm);
        assert_eq!(store.access(&b, 0).viewers, 2);
        assert_eq!(store.snapshot().1[0].stream.as_ref().unwrap().viewers, 2);
        drop(b_view);
        assert_eq!(store.access(&b, 0).viewers, 1);
    }

    #[test]
    fn viewers_join_and_leave_the_stream_state() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let a = session(&store, now);
        let adm = store.admit(&a, 0, Perm::Write, now).unwrap();
        let first = store.view(&adm);
        let hold = store.hold(&adm, HoldKind::Live).unwrap();
        drain(&mut rx);
        hold.streaming("Mono8".into(), 8);
        let second = store.view(&Admission::server(0));
        drop(first);
        let viewers: Vec<u32> = access_events(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                EventKind::DeviceState { cause: StateCause::Stream, state, .. } => state.stream.map(|s| s.viewers),
                _ => None,
            })
            .collect();
        assert_eq!(viewers, vec![1, 2, 1], "streaming, a join, a leave");
        drop(second);
        drop(hold);
        let stream: Vec<_> = access_events(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                EventKind::DeviceState { cause: StateCause::Stream, state, .. } => Some(state.stream),
                _ => None,
            })
            .collect();
        assert_eq!(stream, vec![None], "the last leave isn't announced, the capture's end is");
    }

    #[tokio::test]
    async fn going_exclusive_revokes_other_viewers_and_keeps_a_shared_capture_running_for_the_forcer() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let (a, b) = (session(&store, now), session(&store, now));
        // b started the capture; a, and an anonymous client, watch it too.
        let b_adm = store.admit(&b, 0, Perm::Write, now).unwrap();
        let hold = store.hold(&b_adm, HoldKind::Live).unwrap();
        hold.streaming("Mono8".into(), 8);
        let mut b_view = store.view(&b_adm);
        let mut a_view = store.view(&store.admit(&a, 0, Perm::Read, now).unwrap());
        let mut anon_view = store.view(&store.admit(&Client::Anonymous, 0, Perm::Read, now).unwrap());

        // An anonymous viewer alone already makes it in use.
        store.disconnect_decision(&b, 0, now);
        drop(b_view);
        match store.set_access(&a, 0, Mode::Exclusive, false, now).unwrap_err() {
            AccessError::DeviceInUse { members, holder, .. } => {
                assert!(members.is_empty());
                assert_eq!(holder.map(|h| h.kind), Some(HolderKind::Live));
            }
            other => panic!("unexpected {other:?}"),
        }
        b_view = store.view(&store.admit(&b, 0, Perm::Read, now).unwrap());

        drain(&mut rx);
        let (access, eviction) = store.set_access(&a, 0, Mode::Exclusive, true, now).unwrap();
        assert_eq!(eviction, Eviction::default(), "the capture runs on for a");
        assert!(!hold.revoked());
        assert_eq!(access.holder.unwrap().client_id, Some(a.by().unwrap().client_id), "now a's");
        tokio::time::timeout(SECOND, b_view.revoked()).await.expect("b's viewer is revoked");
        tokio::time::timeout(SECOND, anon_view.revoked()).await.expect("so is the anonymous one");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), a_view.revoked()).await.is_err(),
            "a's viewer keeps watching"
        );
        let revoked: Vec<String> = access_events(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                EventKind::AccessRevoked { client_id, .. } => Some(client_id),
                _ => None,
            })
            .collect();
        assert_eq!(revoked, vec![b.by().unwrap().client_id]);

        // Without a viewer of the forcer's own, the whole capture is revoked.
        drop((a_view, b_view, anon_view));
        store.release_access(&a, 0, false).unwrap();
        let _b_view = store.view(&store.admit(&b, 0, Perm::Read, now).unwrap());
        let (_, eviction) = store.set_access(&a, 0, Mode::Exclusive, true, now).unwrap();
        assert_eq!(eviction, Eviction { live: true, burst: false });
        assert!(hold.revoked());
    }

    #[test]
    fn a_lease_ends_with_its_owners_session_and_with_the_device() {
        let (store, mut rx) = store();
        let now = Instant::now();
        store.device_opened(0, None, now);
        let a = session(&store, now);
        store.set_access(&a, 0, Mode::Exclusive, false, now).unwrap();
        drain(&mut rx);
        store.end(&a.session().unwrap().id, EndReason::Expired, now);
        let events = access_events(&mut rx);
        assert!(matches!(&events[..], [EventKind::DeviceState { cause: StateCause::Access, state, .. }]
            if state.access.mode == Mode::Shared && state.access.owner.is_none()));
        assert_eq!(store.access(&Client::Anonymous, 0).mode, Mode::Shared);

        let b = session(&store, now);
        store.set_access(&b, 0, Mode::RoShared, false, now).unwrap();
        store.device_closed(0, CloseReason::Request, None, now);
        assert_eq!(store.access(&b, 0).mode, Mode::Shared);
        assert!(store.list()[0].owns.is_empty());
    }
}
