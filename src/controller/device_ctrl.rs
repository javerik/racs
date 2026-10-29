use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aravis_port::net::{DiscoveredDevice, DiscoveryOptions};
use aravis_port::Camera;
use tracing::{debug, warn};

use crate::app_context::ArcBoxedCameraStore;
use crate::controller::discovery_net::{discovery_bind_addrs, discovery_timeout};
use crate::controller::transport::{self, LinkInfo, PACKET_SIZE_FEATURE};
use crate::events::{EventBus, EventKind};
use crate::models::access::{DeviceAccess, Mode};
use crate::models::device_models::{CloseReason, ConnectedDevice, DeviceConnections, DeviceDiscoverInfo};
use crate::models::session::{ClientRef, DisconnectResult};
use crate::models::genicam_models::{FeatureState, GenICamAccessMode, GenICamNodeCategory, GenICamNodeType};
use crate::models::transport::{AutoPacketSize, PacketSizeInfo};
use crate::processor::genicam_proc::GcMeta;
use crate::rcs_erros::RcsError;
use crate::stores::camera_store::{ConnectTarget, StoreError};
use crate::stores::client_store::{Admission, Client, ClientStore};
use crate::stores::conn_camera::{CamHandle, ConnCamera};
use crate::stores::job_store::JobStore;
use crate::stores::live_ops::OpKind;

/// GVCP's fixed control port.
const GVCP_PORT: u16 = 3956;

/// Features read per camera access by [`DeviceCtrl::genicam_feature_states`].
const STATE_CHUNK: usize = 16;

/// The error a burst cancelled by a close reports, and the reason a live socket is closed with.
pub const DEVICE_DISCONNECTED: &str = "device disconnected";

/// The error a burst cancelled by another session's forced `exclusive` lease reports, and the
/// reason its live socket is closed with.
pub const ACCESS_REVOKED: &str = "access revoked";

#[derive(Debug)]
pub enum DeviceCtrlError {
    ConnectError(String),
    DeviceError(String),
    DeviceAccess,
    GenICamAccess,
    /// The id was never seen by a discovery round, so there's no address to connect to.
    NotDiscovered(u32),
}

impl std::fmt::Display for DeviceCtrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeviceCtrlError::ConnectError(msg) => {
                write!(f, "Device connection error: {}", msg)
            }
            DeviceCtrlError::DeviceError(msg) => {
                write!(f, "Device access error => {}", msg)
            }
            DeviceCtrlError::DeviceAccess => {
                write!(f, "Failed to access device")
            }
            DeviceCtrlError::GenICamAccess => {
                write!(f, "Failed to access genicam nodes")
            }
            DeviceCtrlError::NotDiscovered(id) => {
                write!(f, "Device {} has not been discovered; run GET /devices first or connect with ?ip=", id)
            }
        }
    }
}

pub struct DeviceCtrl {
    cam_store: ArcBoxedCameraStore,
    /// For cancelling a device's running bursts when it is closed.
    job_store: Arc<JobStore>,
    /// Told when a device opens or closes, and asked who still uses one.
    clients: Arc<ClientStore>,
    /// Where feature writes and commands are announced.
    events: Arc<EventBus>,
}

impl DeviceCtrl {
    pub async fn new(
        cam_store: ArcBoxedCameraStore,
        job_store: Arc<JobStore>,
        clients: Arc<ClientStore>,
        events: Arc<EventBus>,
    ) -> Result<Self, RcsError> {
        Ok(Self { cam_store, job_store, clients, events })
    }

    /// The devices currently connected, without a discovery round, each with its access state as
    /// `client` sees it.
    pub async fn connected(&self, client: &Client) -> Vec<ConnectedDevice> {
        self.cam_store
            .get_connected_camera_info()
            .await
            .into_iter()
            .map(|info| {
                let access = self.clients.access(client, info.id);
                ConnectedDevice { info, access }
            })
            .collect()
    }

    pub async fn discover(&self) -> Result<DeviceConnections, RcsError> {
        let bind_addrs = discovery_bind_addrs();
        let timeout = discovery_timeout();

        // One blocking probe per interface, run concurrently: aravis-port applies its timeout per
        // bind address, so probing them in a single call would cost one timeout per interface.
        let probes = bind_addrs.into_iter().map(|bind| {
            tokio::task::spawn_blocking(move || {
                let opts = DiscoveryOptions {
                    bind_addrs: vec![bind],
                    timeout,
                };
                aravis_port::net::discover(&opts)
            })
        });

        let mut found: Vec<DiscoveredDevice> = Vec::new();
        for result in futures::future::join_all(probes).await {
            match result {
                Ok(Ok(devices)) => {
                    for device in devices {
                        if !found.iter().any(|d| d.mac == device.mac) {
                            found.push(device);
                        }
                    }
                }
                Ok(Err(e)) => debug!("discovery probe failed on one interface => {e}"),
                Err(e) => warn!("discovery task panicked => {e}"),
            }
        }

        let mut available = Vec::with_capacity(found.len());
        for device in found {
            let mac = device.mac.to_string().to_uppercase();
            let id = self.cam_store.assign_id(&mac).await;
            available.push(Self::discover_info(&device, id, &mac));
            self.cam_store.record_discovery(id, device).await;
        }

        let connected = self.cam_store.get_connected_camera_info().await;
        Ok(DeviceConnections::new(available, connected))
    }

    /// Connect to a camera by id: at the address the last discovery round saw it at, or else where
    /// it was last connected (so a camera connected with `?ip=` or [`DeviceCtrl::connect_by_addr`]
    /// can be reconnected by id after a disconnect).
    pub async fn connect(&self, adm: &Admission) -> Result<(), RcsError> {
        let id = adm.device();
        if self.cam_store.is_connected(id).await {
            return Ok(());
        }
        let _lifecycle = self.cam_store.lifecycle(id).await;
        self.connect_locked(id, adm.by()).await
    }

    /// [`DeviceCtrl::connect`] with `id`'s lifecycle lock held.
    async fn connect_locked(&self, id: u32, by: Option<ClientRef>) -> Result<(), RcsError> {
        // Someone else may have opened it while this request waited for the lock.
        if self.cam_store.is_connected(id).await {
            return Ok(());
        }
        let target = match self.cam_store.discovered(id).await {
            Some(device) => {
                let mac = device.mac.to_string().to_uppercase();
                ConnectTarget {
                    addr: SocketAddrV4::new(device.current_ip, GVCP_PORT),
                    known: Some(Self::discover_info(&device, id, &mac)),
                }
            }
            None => self.cam_store.target(id).await.ok_or(DeviceCtrlError::NotDiscovered(id))?,
        };
        self.open(id, target, by).await
    }

    pub async fn connect_by_ip(&self, adm: &Admission, ip: String) -> Result<(), RcsError> {
        let id = adm.device();
        if self.cam_store.camera_exists_by_ip(ip.clone()).await {
            return Ok(());
        }
        let _lifecycle = self.cam_store.lifecycle(id).await;
        self.connect_by_ip_locked(id, ip, adm.by()).await
    }

    /// [`DeviceCtrl::connect_by_ip`] with `id`'s lifecycle lock held.
    async fn connect_by_ip_locked(&self, id: u32, ip: String, by: Option<ClientRef>) -> Result<(), RcsError> {
        let parsed: Ipv4Addr = ip
            .parse()
            .map_err(|e| DeviceCtrlError::ConnectError(format!("invalid ip {ip:?} => {e}")))?;
        if self.cam_store.camera_exists_by_ip(ip.clone()).await {
            return Ok(());
        }
        // The caller picked this id, so make sure discovery can't later hand it to a different
        // camera.
        self.cam_store.reserve_id(id).await;
        self.open_unless_connected(id, ConnectTarget { addr: SocketAddrV4::new(parsed, GVCP_PORT), known: None }, by)
            .await
    }

    /// `PUT /devices/{id}/access`, and `PUT /devices/{id}/connect?mode=`: take, change or give
    /// up the device's lease and connect it (at `ip`, if given), in one step. Both happen under
    /// the lifecycle lock, so a concurrent connect either joined before the lease was taken
    /// (`409` for `exclusive`) or is refused after it. If the device can't be opened, the lease
    /// goes with it: a closed device has none.
    ///
    /// Clients a forced `exclusive` lease evicted lose their camera: a live capture stops by
    /// itself (its socket closes with `4003`), a running burst is cancelled here. Either way the
    /// release is announced, so this client's next request waits for the camera.
    pub async fn set_access(
        &self,
        client: &Client,
        id: u32,
        mode: Mode,
        force: bool,
        ip: Option<String>,
    ) -> Result<DeviceAccess, RcsError> {
        let _lifecycle = self.cam_store.lifecycle(id).await;
        let (_, eviction) = self.clients.set_access(client, id, mode, force, Instant::now())?;
        if eviction.burst {
            self.job_store.cancel_running(id, ACCESS_REVOKED);
        }
        if eviction.live || eviction.burst {
            self.cam_store.begin_release(id);
        }
        let opened = match ip {
            Some(ip) => self.connect_by_ip_locked(id, ip, client.by()).await,
            None => self.connect_locked(id, client.by()).await,
        };
        if let Err(e) = opened {
            if !self.cam_store.is_connected(id).await {
                self.clients.drop_lease(id);
            }
            return Err(e);
        }
        Ok(self.clients.access(client, id))
    }

    /// `DELETE /devices/{id}/access`: give up the lease, or break it with `force`.
    pub fn release_access(&self, client: &Client, id: u32, force: bool) -> Result<DeviceAccess, RcsError> {
        Ok(self.clients.release_access(client, id, force)?)
    }

    /// `GET /devices/{id}/access`. Doesn't open the device.
    pub fn access(&self, adm: &Admission) -> DeviceAccess {
        self.clients.access(adm.client(), adm.device())
    }

    /// Open a camera at an explicit socket address.
    ///
    /// Public because it's the only way to reach a camera that isn't on the standard GVCP port,
    /// which is what the in-process fake camera used by the tests does.
    pub async fn connect_by_addr(
        &self,
        id: u32,
        addr: SocketAddrV4,
        known: Option<DeviceDiscoverInfo>,
    ) -> Result<(), RcsError> {
        let _lifecycle = self.cam_store.lifecycle(id).await;
        self.open_unless_connected(id, ConnectTarget { addr, known }, None).await
    }

    /// [`DeviceCtrl::open`], but an id that already has a camera is refused before a second
    /// connection to anything is opened. Called with the lifecycle lock held.
    async fn open_unless_connected(&self, id: u32, target: ConnectTarget, by: Option<ClientRef>) -> Result<(), RcsError> {
        if self.cam_store.is_connected(id).await {
            return Err(StoreError::Exists(id).into());
        }
        self.open(id, target, by).await
    }

    /// Open the camera at `target` and put it into the store as `id`, remembering the target for
    /// a reconnect by id, and announce it. Called with `id`'s lifecycle lock held.
    async fn open(&self, id: u32, target: ConnectTarget, by: Option<ClientRef>) -> Result<(), RcsError> {
        let ConnectTarget { addr, known } = target.clone();
        // Connect, fetch/parse the XML and read identity in a single blocking hop. The XML fetch
        // alone is hundreds of sequential 512-byte GVCP reads, which would otherwise stall every
        // other request on this worker.
        let handle = tokio::task::spawn_blocking(move || -> Result<CamHandle, RcsError> {
            let camera = Camera::connect_addr(addr)
                .map_err(|e| DeviceCtrlError::ConnectError(format!("failed to open camera at {addr} => {e}")))?;

            let meta = GcMeta::from_xml(camera.genicam_xml().to_string(), |name| camera.feature_kind(name))?;

            let link = LinkInfo::to(*addr.ip());
            transport::settle_on_connect(&camera, &link);

            let info = match known {
                Some(mut info) => {
                    // Discovery doesn't carry manufacturer info; fill it in now that we're connected.
                    if info.manufacturer_info.is_empty() {
                        info.manufacturer_info = camera.read::<String>("DeviceManufacturerInfo").unwrap_or_default();
                    }
                    info
                }
                None => Self::info_from_camera(&camera, id, *addr.ip()),
            };

            Ok(CamHandle {
                camera,
                meta: Arc::new(meta),
                info,
                link,
                stop: Arc::default(),
            })
        })
        .await
        .map_err(|e| RcsError::Blocking(format!("connect task failed: {e}")))??;

        self.cam_store.add_camera(ConnCamera::new_with_camera(handle)).await?;
        self.cam_store.remember_target(id, target).await;
        self.clients.device_opened(id, by, Instant::now());
        Ok(())
    }

    /// `PUT /devices/{id}/disconnect`. With `force` the device closes for everyone. Otherwise a
    /// session leaves it, and it closes once no member and no stream or burst is left; an
    /// anonymous request closes it unless a session is a member or holds it. Nothing to do for a
    /// device that isn't connected.
    pub async fn disconnect(&self, adm: &Admission, force: bool) -> Result<DisconnectResult, RcsError> {
        let id = adm.device();
        if force {
            self.close(id, CloseReason::Forced, adm.by()).await?;
            return Ok(DisconnectResult { closed: true, members: 0 });
        }
        let decision = self.clients.disconnect_decision(adm.client(), id, Instant::now());
        if decision.close {
            self.close(id, CloseReason::Request, adm.by()).await?;
        }
        Ok(DisconnectResult {
            closed: decision.close || !self.cam_store.is_connected(id).await,
            members: decision.members,
        })
    }

    /// Close `id` for the idle sweep, if it is still unused now that its lifecycle lock is held:
    /// a request may have come in since the sweep looked. `true` if it was closed.
    pub async fn close_if_idle(&self, id: u32, timeout: Duration) -> Result<bool, RcsError> {
        let lifecycle = self.cam_store.lifecycle(id).await;
        if !self.clients.is_idle(id, Instant::now(), timeout) {
            return Ok(false);
        }
        self.close_locked(id, CloseReason::Idle, None, lifecycle).await?;
        Ok(true)
    }

    /// Close `id`, the only way a device is closed: a disconnect, a force, the idle sweep. A live
    /// stream holding the camera stops and closes its socket with `1001`; a running burst is
    /// cancelled but keeps its record. Requests that arrive meanwhile wait for the close and then
    /// connect the device again. `by` is who asked, for the `device_state` event.
    pub async fn close(&self, id: u32, reason: CloseReason, by: Option<ClientRef>) -> Result<(), RcsError> {
        // Connects wait here until the device is gone.
        let lifecycle = self.cam_store.lifecycle(id).await;
        self.close_locked(id, reason, by, lifecycle).await
    }

    async fn close_locked(
        &self,
        id: u32,
        reason: CloseReason,
        by: Option<ClientRef>,
        _lifecycle: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<(), RcsError> {
        // Before the stop is raised, so a burst that notices the stop first still ends with this
        // error on its record.
        let bursts = self.job_store.cancel_running(id, DEVICE_DISCONNECTED);
        if bursts > 0 {
            debug!("closing camera {id} cancels {bursts} running burst(s)");
        }
        // Dropping a handle releases the control-channel privilege with a blocking register
        // write, so it has to happen off the runtime worker.
        let handle = self.cam_store.close_slot(id, reason).await;
        // Even without a handle back (it was never connected, or its holder never returned it),
        // the slot is gone; the store only announces a device it saw open.
        self.clients.device_closed(id, reason, by, Instant::now());
        if let Some(handle) = handle {
            tokio::task::spawn_blocking(move || drop(handle))
                .await
                .map_err(|e| RcsError::Blocking(format!("disconnect task failed: {e}")))?;
        }
        Ok(())
    }

    pub async fn genicam_xml(&self, adm: &Admission) -> Result<String, RcsError> {
        Ok(self.meta(adm).await?.xml.clone())
    }

    pub async fn genicam_categories_json(
        &self,
        adm: &Admission,
    ) -> Result<Vec<GenICamNodeCategory>, RcsError> {
        Ok(self.meta(adm).await?.categories.clone())
    }

    pub async fn genicam_get_feature_value(
        &self,
        adm: &Admission,
        feature_name: &str,
    ) -> Result<String, RcsError> {
        let name = feature_name.to_string();
        self.on_camera(adm, OpKind::Read, move |handle| read_value(handle, &name)).await
    }

    /// Write a feature, and announce it with `feature_changed`. Inside a live stream too: the
    /// stream ran the write by the time this returns.
    pub async fn genicam_set_feature_value(
        &self,
        adm: &Admission,
        feature_name: &str,
        value: &str,
    ) -> Result<(), RcsError> {
        let name = feature_name.to_string();
        let value = value.to_string();
        let write_name = name.clone();
        self.on_camera(adm, OpKind::Write(name.clone()), move |handle| write_value(handle, &write_name, &value))
            .await?;
        self.feature_changed(adm, name);
        Ok(())
    }

    /// Execute GenICam command `command_name` (`TriggerSoftware`, `UserSetLoad`, ...), and announce
    /// it with `command_executed`.
    pub async fn genicam_execute_command(&self, adm: &Admission, command_name: &str) -> Result<(), RcsError> {
        let name = command_name.to_string();
        let run_name = name.clone();
        self.on_camera(adm, OpKind::Command(name.clone()), move |handle| run_command(handle, &run_name))
            .await?;
        self.events.emit(EventKind::CommandExecuted { device: adm.device(), command: name, by: adm.by() });
        Ok(())
    }

    fn feature_changed(&self, adm: &Admission, feature: String) {
        self.events.emit(EventKind::FeatureChanged { device: adm.device(), feature, by: adm.by() });
    }

    /// Live state (value, availability, lock, bounds) of each of `names`, in order. A problem with
    /// one feature is reported in its entry rather than failing the whole request.
    pub async fn genicam_feature_states(&self, adm: &Admission, names: Vec<String>) -> Result<Vec<FeatureState>, RcsError> {
        let mut states = Vec::with_capacity(names.len());
        // In chunks, so that inside a live stream a large request doesn't hold up frame delivery
        // long enough for the small buffer pool to run dry.
        for chunk in names.chunks(STATE_CHUNK) {
            let chunk = chunk.to_vec();
            let part = self
                .on_camera(adm, OpKind::Read, move |handle| {
                    Ok(chunk.iter().map(|name| feature_state(handle, name)).collect::<Vec<_>>())
                })
                .await?;
            states.extend(part);
        }
        Ok(states)
    }

    /// The stream packet size, its bounds and the link MTU. Answered by a running live stream too.
    pub async fn packet_size(&self, adm: &Admission) -> Result<PacketSizeInfo, RcsError> {
        self.on_camera(adm, OpKind::Read, transport::info).await
    }

    /// Find and set the largest stream packet size that reaches this host, with test packets.
    /// During a live stream this runs with acquisition paused, like any packet-size write, and the
    /// stream carries on with the new size. Announced as a `GevSCPSPacketSize` change.
    pub async fn auto_packet_size(&self, adm: &Admission) -> Result<AutoPacketSize, RcsError> {
        let outcome = self.on_camera(adm, OpKind::Write(PACKET_SIZE_FEATURE.to_string()), transport::auto).await?;
        self.feature_changed(adm, PACKET_SIZE_FEATURE.to_string());
        Ok(outcome)
    }

    /// Run `f` against `id`'s camera (or inside its live stream), connecting first if needed.
    ///
    /// A close that lands between the connect check and the checkout refuses the checkout (or
    /// has removed the slot already). That request is retried once: its connect waits for the
    /// close to finish and opens the device again.
    async fn on_camera<T, F>(&self, adm: &Admission, kind: OpKind, f: F) -> Result<T, RcsError>
    where
        F: Fn(&CamHandle) -> Result<T, RcsError> + Clone + Send + 'static,
        T: Send + 'static,
    {
        let id = adm.device();
        self.ensure_connected(adm).await?;
        match self.cam_store.with_camera_or_live(id, kind.clone(), f.clone()).await {
            Err(RcsError::StoreError(StoreError::Closing(_) | StoreError::NotFound(_))) => {
                debug!("camera {id} was closed under a request; connecting again");
                self.ensure_connected(adm).await?;
                self.cam_store.with_camera_or_live(id, kind, f).await
            }
            other => other,
        }
    }

    /// Cached GenICam metadata, connecting first if needed. Served without checking the camera
    /// out, so it never waits on an in-flight frame grab.
    async fn meta(&self, adm: &Admission) -> Result<Arc<GcMeta>, RcsError> {
        self.ensure_connected(adm).await?;
        self.cam_store
            .meta(adm.device())
            .await
            .ok_or(RcsError::DevCtrlError(DeviceCtrlError::GenICamAccess))
    }

    /// Connect `id` unless it already is. The check here is only the fast path: [`DeviceCtrl::connect`]
    /// checks again once it holds the lifecycle lock.
    async fn ensure_connected(&self, adm: &Admission) -> Result<(), RcsError> {
        if !self.cam_store.is_connected(adm.device()).await {
            debug!("Camera is not connected yet, going to connect and add to store");
            self.connect(adm).await?;
        }
        Ok(())
    }

    fn discover_info(device: &DiscoveredDevice, id: u32, mac: &str) -> DeviceDiscoverInfo {
        DeviceDiscoverInfo {
            id,
            dev_id: device.id.clone(),
            model: device.model.clone(),
            // Not carried in a GVCP discovery ack; filled in on connect.
            manufacturer_info: String::new(),
            vendor: device.manufacturer.clone(),
            serial_number: device.serial.clone(),
            ip: device.current_ip.to_string(),
            mac: mac.to_string(),
        }
    }

    /// Identity for a camera reached by address rather than discovery, read from the standard
    /// SFNC feature nodes.
    fn info_from_camera(camera: &Camera, id: u32, ip: Ipv4Addr) -> DeviceDiscoverInfo {
        let read = |name: &str| camera.read::<String>(name).unwrap_or_default();
        let model = read("DeviceModelName");
        let vendor = read("DeviceVendorName");
        let serial_number = read("DeviceSerialNumber");
        // Mirrors aravis-port's own discovery id, so both paths agree on the format.
        let dev_id = format!("{vendor}-{model}-{serial_number}")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
            .collect();

        DeviceDiscoverInfo {
            id,
            dev_id,
            model,
            manufacturer_info: read("DeviceManufacturerInfo"),
            vendor,
            serial_number,
            ip: ip.to_string(),
            // Only a discovery ack reports the MAC; leave it empty rather than inventing one.
            mac: String::new(),
        }
    }
}

fn feature_meta<'a>(handle: &'a CamHandle, name: &str) -> Result<&'a crate::models::genicam_models::GenICamNodeInfo, RcsError> {
    handle
        .meta
        .feature(name)
        .ok_or_else(|| RcsError::GenICamError("Feature not found".to_string()))
}

fn command_not_a_value(name: &str) -> RcsError {
    RcsError::GenICamError(format!(
        "{name} is a Command and has no value; execute it with POST /devices/{{id}}/gc/command/{name}"
    ))
}

/// A feature's value as the REST API spells it. Blocking.
fn read_value(handle: &CamHandle, name: &str) -> Result<String, RcsError> {
    let feature = feature_meta(handle, name)?;
    Ok(match feature.node_type {
        GenICamNodeType::NotImplemented => {
            return Err(RcsError::GenICamError("Value type not implemented".to_string()))
        }
        GenICamNodeType::Command => return Err(command_not_a_value(name)),
        // Enums are read as their integer value, not their symbolic name — that is the
        // long-standing shape of this endpoint's response.
        GenICamNodeType::Integer | GenICamNodeType::Enum => handle.camera.read::<i64>(name)?.to_string(),
        GenICamNodeType::Float => handle.camera.read::<f64>(name)?.to_string(),
        GenICamNodeType::String => handle.camera.read::<String>(name)?,
        GenICamNodeType::Boolean => handle.camera.read::<bool>(name)?.to_string(),
    })
}

/// Write a feature from its REST spelling. Blocking.
fn write_value(handle: &CamHandle, name: &str, value: &str) -> Result<(), RcsError> {
    let feature = feature_meta(handle, name)?;
    if !feature.access_mode.is_writable() {
        return Err(RcsError::GenICamError("AccessMode invalid".to_string()));
    }
    if name == PACKET_SIZE_FEATURE {
        return transport::write_packet_size(handle, value);
    }
    let value_error = |e: &dyn std::fmt::Debug| RcsError::ValueError(Some(format!("{e:?}")));
    match feature.node_type {
        GenICamNodeType::NotImplemented => return Err(RcsError::GenICamError("Not implemented".to_string())),
        GenICamNodeType::Command => return Err(command_not_a_value(name)),
        GenICamNodeType::String => handle.camera.write::<String>(name, value.to_string())?,
        GenICamNodeType::Integer => {
            let parsed: i64 = value.parse().map_err(|e| value_error(&e))?;
            handle.camera.write::<i64>(name, parsed)?;
        }
        GenICamNodeType::Enum => {
            // Integer form is the documented contract, but accept a symbolic entry name too
            // rather than rejecting something the camera would understand.
            match value.parse::<i64>() {
                Ok(parsed) => handle.camera.write::<i64>(name, parsed)?,
                Err(_) => handle.camera.write::<String>(name, value.to_string())?,
            }
        }
        GenICamNodeType::Float => {
            let parsed: f64 = value.parse().map_err(|e| value_error(&e))?;
            handle.camera.write::<f64>(name, parsed)?;
        }
        GenICamNodeType::Boolean => {
            let parsed = parse_bool(value)
                .ok_or_else(|| RcsError::ValueError(Some(format!("expected true/false or 1/0, got {value:?}"))))?;
            handle.camera.write::<bool>(name, parsed)?;
        }
    }
    Ok(())
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim() {
        v if v.eq_ignore_ascii_case("true") || v == "1" => Some(true),
        v if v.eq_ignore_ascii_case("false") || v == "0" => Some(false),
        _ => None,
    }
}

/// Execute a command feature. Blocking.
fn run_command(handle: &CamHandle, name: &str) -> Result<(), RcsError> {
    let feature = feature_meta(handle, name)?;
    if feature.node_type != GenICamNodeType::Command {
        return Err(RcsError::GenICamError(format!("{name} is not a Command")));
    }
    handle.camera.execute_command(name)?;
    Ok(())
}

/// Everything `POST /gc/features/state` reports for one feature. Blocking.
fn feature_state(handle: &CamHandle, name: &str) -> FeatureState {
    let mut state = FeatureState {
        name: name.to_string(),
        ..Default::default()
    };
    let feature = match feature_meta(handle, name) {
        Ok(f) => f,
        Err(_) => {
            state.error = Some("Feature not found".to_string());
            return state;
        }
    };
    state.node_type = Some(feature.node_type.clone());

    match handle.camera.feature_info(name) {
        Ok(info) => {
            state.available = info.available;
            state.locked = info.locked;
            state.min = info.min.and_then(json_number);
            state.max = info.max.and_then(json_number);
            state.inc = info.inc.and_then(json_number);
            state.unit = info.unit;
            state.representation = info.representation;
            state.available_entries = info
                .entries
                .map(|entries| entries.into_iter().filter(|e| e.available).map(|e| e.value).collect());
        }
        Err(e) => {
            // Still worth trying the read: the value is what most callers are after.
            state.available = true;
            state.error = Some(e.to_string());
        }
    }

    let readable = state.available
        && feature.node_type != GenICamNodeType::Command
        && feature.access_mode != GenICamAccessMode::WriteOnly;
    if readable {
        match read_value(handle, name) {
            Ok(v) => state.value = Some(v),
            Err(e) => state.error = Some(e.to_string()),
        }
    }
    state
}

fn json_number(v: aravis_port::genicam::Value) -> Option<serde_json::Number> {
    match v {
        aravis_port::genicam::Value::Int(i) => Some(i.into()),
        aravis_port::genicam::Value::Float(f) => serde_json::Number::from_f64(f),
    }
}

impl From<StoreError> for DeviceCtrlError {
    fn from(value: StoreError) -> Self {
        DeviceCtrlError::DeviceError(value.to_string())
    }
}
