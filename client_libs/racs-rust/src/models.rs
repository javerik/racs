//! Wire types of the RACS HTTP API.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenICamAccessMode {
    Undefined,
    ReadOnly,
    WriteOnly,
    ReadWrite,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenICamNodeType {
    NotImplemented,
    Integer,
    Float,
    String,
    Enum,
    Boolean,
    /// Executed with [`Camera::execute`](crate::Camera::execute), not read or written.
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenICamVisibility {
    Beginner,
    Expert,
    Guru,
    Invisible,
    Undefined,
}

/// How a frame is encoded: the `format` of live streams, burst jobs and frames.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    /// Width*height pixels: one byte each at 8 bit, otherwise a little-endian u16 each.
    #[default]
    Raw,
    /// A JPEG file holding the top 8 significant bits.
    Jpeg,
    /// The raw pixels losslessly compressed. [`Frame::to_u16`](crate::Frame::to_u16) and
    /// [`Frame::to_raw`](crate::Frame::to_raw) decode them.
    Zstd,
}

impl ImageFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            ImageFormat::Raw => "raw",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Zstd => "zstd",
        }
    }
}

/// Requested depth of live and burst frames. The camera's answer is reported as `bit_depth`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PixelDepth {
    #[default]
    Mono8,
    /// The deepest unpacked mono format the camera accepts: Mono16, 14, 12, then 10
    /// (Coord3D_C16 on a 3D camera in Linescan3D).
    Mono16,
}

impl PixelDepth {
    pub fn as_str(&self) -> &'static str {
        match self {
            PixelDepth::Mono8 => "mono8",
            PixelDepth::Mono16 => "mono16",
        }
    }
}

/// What a burst job does when a frame cannot be captured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnFailure {
    /// Fail the job. The server's default.
    #[default]
    Abort,
    /// Record the failure at that index and carry on, up to `max_failures`.
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Created, but the capture has not taken the camera yet.
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    /// Whether the job has stopped for good.
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceDiscoverInfo {
    pub id: u32,
    pub dev_id: String,
    pub serial_number: String,
    pub vendor: String,
    pub model: String,
    pub manufacturer_info: String,
    pub ip: String,
    pub mac: String,
    /// Who may use the device and who does, as this client sees it. Only in
    /// [`get_connected_devices`](crate::RacsClient::get_connected_devices); `None` from servers
    /// before 0.4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<DeviceAccess>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceConnections {
    pub available: Vec<DeviceDiscoverInfo>,
    pub connected: Vec<DeviceDiscoverInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenICamEnumInfo {
    pub display_name: String,
    pub value: i64,
    pub string_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenICamNodeInfo {
    pub name: String,
    pub display_name: String,
    pub node_type: GenICamNodeType,
    pub visibility: GenICamVisibility,
    pub access_mode: GenICamAccessMode,
    pub enums: Option<Vec<GenICamEnumInfo>>,
    /// For a selector (e.g. GainSelector): the features whose value depends on it.
    #[serde(default)]
    pub selected: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenICamNodeCategory {
    pub name: String,
    pub display_name: String,
    pub nodes: Vec<GenICamNodeInfo>,
}

/// Live state of a feature, from `POST /devices/{id}/gc/features/state`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureState {
    pub name: String,
    /// `None` when the feature isn't known (see `error`).
    pub node_type: Option<GenICamNodeType>,
    /// Formatted as by the single-feature GET. `None` for a command, a write-only or unavailable
    /// feature, or a failed read. [`FeatureState::typed_value`] parses it.
    pub value: Option<String>,
    pub available: bool,
    /// The feature can be read but not written right now.
    pub locked: bool,
    /// Bounds of an Integer/Float feature, kept exact for 64-bit integers.
    pub min: Option<serde_json::Number>,
    pub max: Option<serde_json::Number>,
    pub inc: Option<serde_json::Number>,
    pub unit: Option<String>,
    pub representation: Option<String>,
    /// For an enum: the integer values of the entries the device currently offers.
    pub available_entries: Option<Vec<i64>>,
    /// Why this state is incomplete, e.g. `Feature not found`.
    pub error: Option<String>,
}

/// Why the last live stream on a device ended, and whether one runs now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamErrorInfo {
    pub last_error: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
    pub active_stream: bool,
    /// The open live-stream sockets on the device. `0` from servers before 0.4.
    #[serde(default)]
    pub viewers: u32,
}

/// Describes every live-stream frame after it, until the next one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamInfo {
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
    pub pixel_format: String,
    /// Significant bits per pixel. Above 8, raw frames are little-endian u16s.
    pub bit_depth: u8,
    /// `GevSCPSPacketSize` the stream runs with. `None` from servers that don't report it.
    #[serde(default)]
    pub packet_size: Option<u16>,
}

/// A camera's stream packet size, what it may be set to, and the link it travels over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PacketSizeInfo {
    /// `GevSCPSPacketSize`: bytes per stream packet, IP and UDP headers included.
    pub packet_size: u16,
    /// Allowed sizes are the multiples of `inc` from `min` to `max`.
    pub min: u16,
    pub max: u16,
    pub inc: u16,
    /// MTU of the local interface the camera is reached over; `None` when unknown. A larger
    /// packet size never arrives.
    pub link_mtu: Option<u32>,
    pub interface: Option<String>,
    pub local_ip: Option<String>,
}

/// The outcome of a test-packet search for the largest packet size that arrives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoPacketSize {
    /// The packet size now set.
    pub packet_size: u16,
    pub previous: u16,
    /// `false` when the camera answered no test packet; the size is then left as it was.
    pub test_packets: bool,
    pub link_mtu: Option<u32>,
    pub interface: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurstJobCreated {
    pub job_id: Uuid,
    pub device_id: u32,
    pub status: JobStatus,
}

/// A burst job's status and progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurstJobInfo {
    pub job_id: Uuid,
    pub device_id: u32,
    pub status: JobStatus,
    pub format: ImageFormat,
    pub requested_count: u32,
    pub captured_count: u32,
    pub failed_count: u32,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    /// When the finished job is dropped from the server. `None` until it finishes.
    pub expires_at: Option<DateTime<Utc>>,
    /// Why the job failed. `None` unless `status` is `Failed`.
    pub error: Option<String>,
    /// Frame geometry, `None` until the first frame is captured.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<u8>,
}

/// One entry of a burst job's image list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ImageEntry {
    Ok { index: u32, size_bytes: u32 },
    /// Only with [`OnFailure::Skip`].
    Failed { index: u32, error: String },
}

impl ImageEntry {
    pub fn index(&self) -> u32 {
        match self {
            ImageEntry::Ok { index, .. } | ImageEntry::Failed { index, .. } => *index,
        }
    }
}

/// Options of the live stream. Unset values use the server's defaults.
///
/// ```
/// use racs_client::{LiveOptions, PixelDepth};
/// let options = LiveOptions::raw().pixel_depth(PixelDepth::Mono16).fps(10.0);
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct LiveOptions {
    pub format: ImageFormat,
    pub pixel_depth: Option<PixelDepth>,
    /// JPEG quality 1-100 (server default 80).
    pub quality: Option<u8>,
    /// Target frame rate. `None` sends every frame the camera delivers.
    pub fps: Option<f32>,
    /// How long [`LiveStream::next_frame`](crate::LiveStream::next_frame) waits for a message.
    pub receive_timeout: std::time::Duration,
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self {
            format: ImageFormat::Jpeg,
            pixel_depth: None,
            quality: None,
            fps: None,
            receive_timeout: std::time::Duration::from_secs(10),
        }
    }
}

impl LiveOptions {
    /// JPEG frames, the server's default.
    pub fn jpeg() -> Self {
        Self::default()
    }

    /// Raw frames.
    pub fn raw() -> Self {
        Self { format: ImageFormat::Raw, ..Self::default() }
    }

    /// Raw frames losslessly compressed, about half the bytes.
    pub fn zstd() -> Self {
        Self { format: ImageFormat::Zstd, ..Self::default() }
    }

    pub fn pixel_depth(mut self, depth: PixelDepth) -> Self {
        self.pixel_depth = Some(depth);
        self
    }

    pub fn quality(mut self, quality: u8) -> Self {
        self.quality = Some(quality);
        self
    }

    pub fn fps(mut self, fps: f32) -> Self {
        self.fps = Some(fps);
        self
    }

    pub fn receive_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.receive_timeout = timeout;
        self
    }
}

/// Body of `POST /devices/{id}/grab/jobs`. Unset values use the server's defaults.
///
/// ```
/// use racs_client::{BurstRequest, ImageFormat};
/// let request = BurstRequest::new(20).format(ImageFormat::Jpeg).quality(90);
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurstRequest {
    /// How many frames to grab, 1 to 500.
    pub count: u32,
    pub format: ImageFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_depth: Option<PixelDepth>,
    /// JPEG quality 1-100 (server default 80).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_failure: Option<OnFailure>,
    /// With [`OnFailure::Skip`], how many failed frames to tolerate. `None` for unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_failures: Option<u32>,
}

impl BurstRequest {
    /// `count` raw frames.
    pub fn new(count: u32) -> Self {
        Self { count, format: ImageFormat::Raw, pixel_depth: None, quality: None, on_failure: None, max_failures: None }
    }

    pub fn format(mut self, format: ImageFormat) -> Self {
        self.format = format;
        self
    }

    pub fn pixel_depth(mut self, depth: PixelDepth) -> Self {
        self.pixel_depth = Some(depth);
        self
    }

    pub fn quality(mut self, quality: u8) -> Self {
        self.quality = Some(quality);
        self
    }

    pub fn on_failure(mut self, on_failure: OnFailure) -> Self {
        self.on_failure = Some(on_failure);
        self
    }

    pub fn max_failures(mut self, max_failures: u32) -> Self {
        self.max_failures = Some(max_failures);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_entries_are_told_apart_by_status() {
        let entries: Vec<ImageEntry> = serde_json::from_str(
            r#"[{"status":"ok","index":0,"size_bytes":12},{"status":"failed","index":1,"error":"timeout"}]"#,
        )
        .unwrap();
        assert_eq!(entries[0], ImageEntry::Ok { index: 0, size_bytes: 12 });
        assert_eq!(entries[1], ImageEntry::Failed { index: 1, error: "timeout".into() });
        assert_eq!(entries[1].index(), 1);
    }

    #[test]
    fn burst_job_info_parses_server_timestamps() {
        let info: BurstJobInfo = serde_json::from_str(
            r#"{"job_id":"27bb2837-6279-4cdc-8936-233185be172d","device_id":0,"status":"running","format":"raw",
                "requested_count":5,"captured_count":1,"failed_count":0,"created_at":"2026-10-04T09:19:08.123456789Z",
                "started_at":"2026-10-04T09:19:08.2Z","completed_at":null,"expires_at":null,"error":null,
                "width":64,"height":32,"pixel_format":"Mono8","bit_depth":8}"#,
        )
        .unwrap();
        assert_eq!(info.status, JobStatus::Running);
        assert!(!info.status.is_terminal());
        assert_eq!(info.width, Some(64));
    }

    #[test]
    fn stream_error_timestamps_carry_an_offset() {
        let info: StreamErrorInfo = serde_json::from_str(
            r#"{"last_error":"gone","timestamp":"2026-10-04T09:19:08.123+00:00","active_stream":false}"#,
        )
        .unwrap();
        assert!(info.timestamp.is_some());
    }

    #[test]
    fn a_burst_request_leaves_out_unset_options() {
        let json = serde_json::to_string(&BurstRequest::new(3).pixel_depth(PixelDepth::Mono16)).unwrap();
        assert_eq!(json, r#"{"count":3,"format":"raw","pixel_depth":"mono16"}"#);
    }
}

// --- SESSIONS AND ACCESS ---

/// `201` answer of `POST /sessions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreated {
    /// Secret: sent as `X-Racs-Session` or `?session=` with every request of this client.
    pub session_id: Uuid,
    /// Public: how other clients see this one (8 hex characters).
    pub client_id: String,
    pub name: Option<String>,
    /// Seconds without a heartbeat before the session ends.
    pub timeout_s: u64,
    /// How often to send a heartbeat: a third of the timeout.
    pub heartbeat_interval_s: u64,
}

/// An entry of `GET /sessions`. Never carries a `session_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub client_id: String,
    pub name: Option<String>,
    pub since: DateTime<Utc>,
    /// The last heartbeat or request carrying the session.
    pub last_seen: DateTime<Utc>,
    /// The devices this session is a member of.
    pub devices: Vec<u32>,
    /// The devices whose lease this session holds.
    pub owns: Vec<u32>,
}

/// A client as the others see it: the members and owner of a device, `by` in events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientRef {
    pub client_id: String,
    pub name: Option<String>,
}

/// A device's access mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Every client may read and write. No owner.
    #[default]
    Shared,
    /// The owner reads and writes, other sessions read, anonymous clients get meta routes only.
    RoShared,
    /// The owner reads and writes, everyone else gets meta routes only.
    Exclusive,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Shared => "shared",
            Mode::RoShared => "ro-shared",
            Mode::Exclusive => "exclusive",
        }
    }
}

/// A client's role on a device, following from the mode and the lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Holds the device's lease.
    Owner,
    /// May read and write (everyone on a `shared` device).
    Writer,
    /// May read.
    Reader,
    /// May only use the meta routes: the XML, the categories, the stream error, the access state.
    Meta,
}

/// What holds a device's camera for a long time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HolderKind {
    Live,
    Burst,
}

/// The live capture or burst holding a device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolderRef {
    pub kind: HolderKind,
    /// The session that started it; `None` for an anonymous client.
    pub client_id: Option<String>,
}

/// Who may use a device and who does, and what this client may do: `GET /devices/{id}/access`,
/// and the answer of the connect and lease routes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceAccess {
    pub device: u32,
    pub mode: Mode,
    /// The session holding the lease; `None` on a `shared` device.
    pub owner: Option<ClientRef>,
    /// The sessions that connected to or used the device, in the order they joined.
    pub members: Vec<ClientRef>,
    pub holder: Option<HolderRef>,
    /// Open live-stream sockets.
    pub viewers: u32,
    /// This client's role.
    pub you: Role,
}

/// `200` answer of `PUT /devices/{id}/disconnect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisconnectResult {
    /// Whether the device is closed after the request (also `true` if it wasn't connected).
    pub closed: bool,
    /// The sessions still members of the device.
    pub members: u32,
}

/// The JSON body of a refusal: `{"error": "read_only", "mode": …, "owner": …}`. Read it from an
/// error with [`Error::refusal`](crate::Error::refusal).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRefusal {
    /// `session_expired`, `session_required`, `read_only`, `device_in_use` or `device_locked`.
    pub error: String,
    /// The device's mode.
    #[serde(default)]
    pub mode: Option<Mode>,
    /// Who holds the device's lease.
    #[serde(default)]
    pub owner: Option<ClientRef>,
    /// `device_in_use`: the other member sessions.
    #[serde(default)]
    pub members: Vec<ClientRef>,
    /// `device_in_use`: another client's live capture or burst.
    #[serde(default)]
    pub holder: Option<HolderRef>,
}

// --- EVENTS ---

/// One message of [`RacsClient::events`](crate::RacsClient::events).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Event {
    /// Global and increasing; a gap means events were lost.
    pub seq: u64,
    pub time: DateTime<Utc>,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// What happened, tagged by the message's `type`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    /// The first message: who this client is and the state of every connected device. Its `seq`
    /// is the last one the snapshot includes.
    Hello { session: HelloSession, devices: Vec<DeviceState> },
    /// A device's complete state after it changed.
    DeviceState {
        #[serde(flatten)]
        state: DeviceState,
        cause: StateCause,
        /// Why a device was closed; `None` for every other cause.
        reason: Option<CloseReason>,
        /// Who made the change; `None` for anonymous clients and the server itself.
        by: Option<ClientRef>,
    },
    /// A feature was written. Read again what you show: a write changes dependent features too.
    FeatureChanged { device: u32, feature: String, by: Option<ClientRef> },
    CommandExecuted { device: u32, command: String, by: Option<ClientRef> },
    /// `client_id` lost its lease, membership, stream or burst to another session's `force`.
    AccessRevoked { device: u32, client_id: String, by: Option<ClientRef> },
    SessionEnded { client_id: String, reason: EndReason },
    /// This socket fell behind and lost events: read the state again.
    Resync,
    /// An event type this client doesn't know.
    #[serde(other)]
    Unknown,
}

/// `hello.session`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HelloSession {
    pub client_id: String,
    pub timeout_s: u64,
}

/// Everything about a device another client may want to show.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DeviceState {
    pub device: u32,
    pub connected: bool,
    pub access: AccessState,
    /// The running live capture.
    pub stream: Option<StreamState>,
    /// The running burst job.
    pub burst: Option<BurstState>,
}

/// A device's mode, owner and members in a [`DeviceState`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AccessState {
    pub mode: Mode,
    pub owner: Option<ClientRef>,
    pub members: Vec<ClientRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamState {
    pub viewers: u32,
    pub pixel_format: String,
    pub bit_depth: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BurstState {
    pub job_id: Uuid,
    /// The session that started it; `None` for an anonymous one.
    pub client_id: Option<String>,
}

/// What a `device_state` event reports a change of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateCause {
    Connected,
    Disconnected,
    /// Membership or the lease changed.
    Access,
    Stream,
    Burst,
    #[serde(other)]
    Other,
}

/// Why a device was closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// `PUT /devices/{id}/disconnect`.
    Request,
    /// Nobody used it for the server's idle timeout.
    Idle,
    /// A session forced it closed.
    Forced,
    Error,
    #[serde(other)]
    Other,
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// No heartbeat within its timeout.
    Expired,
    /// `DELETE /sessions/{session_id}`.
    Closed,
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn events_parse_by_type() {
        let hello: Event = serde_json::from_str(
            r#"{"seq":3,"time":"2026-10-08T19:30:00.123Z","type":"hello","session":{"client_id":"3f2a9c1e","timeout_s":30},
                "devices":[{"device":0,"connected":true,"access":{"mode":"ro-shared","owner":{"client_id":"3f2a9c1e","name":null},
                "members":[]},"stream":{"viewers":2,"pixel_format":"Mono8","bit_depth":8},"burst":null}]}"#,
        )
        .unwrap();
        assert_eq!(hello.seq, 3);
        let EventKind::Hello { session, devices } = hello.kind else { panic!("{hello:?}") };
        assert_eq!(session.client_id, "3f2a9c1e");
        assert_eq!((devices[0].access.mode, devices[0].stream.as_ref().unwrap().viewers), (Mode::RoShared, 2));

        let state: Event = serde_json::from_str(
            r#"{"seq":4,"time":"2026-10-08T19:30:01.000Z","type":"device_state","device":1,"connected":false,
                "access":{"mode":"shared","owner":null,"members":[]},"stream":null,"burst":null,
                "cause":"disconnected","reason":"idle","by":null}"#,
        )
        .unwrap();
        let EventKind::DeviceState { state, cause, reason, by } = state.kind else { panic!() };
        assert_eq!((state.device, state.connected, cause, reason, by), (1, false, StateCause::Disconnected, Some(CloseReason::Idle), None));

        let changed: Event = serde_json::from_str(
            r#"{"seq":5,"time":"2026-10-08T19:30:02.000Z","type":"feature_changed","device":0,"feature":"ExposureTime",
                "by":{"client_id":"77d0aa12","name":"line-script"}}"#,
        )
        .unwrap();
        assert!(matches!(changed.kind, EventKind::FeatureChanged { ref feature, by: Some(ref by), .. }
            if feature == "ExposureTime" && by.client_id == "77d0aa12"));

        let ended: Event = serde_json::from_str(
            r#"{"seq":6,"time":"2026-10-08T19:30:03.000Z","type":"session_ended","client_id":"77d0aa12","reason":"expired"}"#,
        )
        .unwrap();
        assert_eq!(ended.kind, EventKind::SessionEnded { client_id: "77d0aa12".into(), reason: EndReason::Expired });

        let resync: Event = serde_json::from_str(r#"{"seq":7,"time":"2026-10-08T19:30:04.000Z","type":"resync"}"#).unwrap();
        assert_eq!(resync.kind, EventKind::Resync);
        let unknown: Event =
            serde_json::from_str(r#"{"seq":8,"time":"2026-10-08T19:30:05.000Z","type":"something_new","x":1}"#).unwrap();
        assert_eq!(unknown.kind, EventKind::Unknown);
    }

    #[test]
    fn modes_use_the_wire_names() {
        assert_eq!(serde_json::to_string(&Mode::RoShared).unwrap(), r#""ro-shared""#);
        assert_eq!(Mode::RoShared.as_str(), "ro-shared");
        let access: DeviceAccess = serde_json::from_str(
            r#"{"device":0,"mode":"exclusive","owner":{"client_id":"3f2a9c1e","name":"x"},"members":[],
                "holder":{"kind":"burst","client_id":"3f2a9c1e"},"viewers":0,"you":"owner"}"#,
        )
        .unwrap();
        assert_eq!((access.you, access.holder.unwrap().kind), (Role::Owner, HolderKind::Burst));
    }
}
