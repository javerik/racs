from datetime import datetime
from enum import Enum
from typing import Annotated, List, Literal, Optional, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

# --- ENUMS ---

class GenICamAccessMode(str, Enum):
    UNDEFINED = "Undefined"
    READ_ONLY = "ReadOnly"
    WRITE_ONLY = "WriteOnly"
    READ_WRITE = "ReadWrite"
    UNKNOWN = "Unknown"

class GenICamNodeType(str, Enum):
    NOT_IMPLEMENTED = "NotImplemented"
    INTEGER = "Integer"
    FLOAT = "Float"
    STRING = "String"
    ENUM = "Enum"
    BOOLEAN = "Boolean"
    COMMAND = "Command"

class GenICamVisibility(str, Enum):
    BEGINNER = "Beginner"
    EXPERT = "Expert"
    GURU = "Guru"
    INVISIBLE = "Invisible"
    UNDEFINED = "Undefined"

class PixelDepth(str, Enum):
    """Requested depth of live and burst frames. The camera's answer is in ``bit_depth``."""
    MONO8 = "mono8"
    # The deepest unpacked mono format the camera accepts: Mono16, 14, 12, then 10
    # (Coord3D_C16 on a 3D camera in Linescan3D).
    MONO16 = "mono16"

class LiveFormat(str, Enum):
    JPEG = "jpeg"
    RAW = "raw"
    # The raw pixels losslessly compressed; Frame.to_numpy()/to_raw() decode them.
    ZSTD = "zstd"

class BurstFormat(str, Enum):
    RAW = "raw"
    JPEG = "jpeg"
    ZSTD = "zstd"

class OnFailure(str, Enum):
    ABORT = "abort"
    SKIP = "skip"

class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)

class Mode(str, Enum):
    """A device's access mode."""
    # Every client reads and writes. No owner.
    SHARED = "shared"
    # The owner reads and writes, other sessions read, clients without a session get meta only.
    RO_SHARED = "ro-shared"
    # The owner reads and writes, everyone else gets meta routes only.
    EXCLUSIVE = "exclusive"

class Role(str, Enum):
    """A client's role on a device, from its mode and lease."""
    OWNER = "owner"
    WRITER = "writer"
    READER = "reader"
    # Only the meta routes: the XML, the categories, the stream error, the access state.
    META = "meta"

class HolderKind(str, Enum):
    LIVE = "live"
    BURST = "burst"

class EventType(str, Enum):
    """The ``type`` of a server event. Compares equal to the plain string."""
    HELLO = "hello"
    DEVICE_STATE = "device_state"
    FEATURE_CHANGED = "feature_changed"
    COMMAND_EXECUTED = "command_executed"
    ACCESS_REVOKED = "access_revoked"
    SESSION_ENDED = "session_ended"
    RESYNC = "resync"

# --- SESSIONS AND ACCESS ---

class SessionCreated(BaseModel):
    """A new session, from ``POST /sessions``. ``session_id`` is the secret sent with requests."""
    session_id: UUID
    # How other clients see this one.
    client_id: str
    name: Optional[str] = None
    # The session ends after this long without a heartbeat.
    timeout_s: int
    heartbeat_interval_s: int

class SessionInfo(BaseModel):
    """A session as ``GET /sessions`` lists it (never with its ``session_id``)."""
    client_id: str
    name: Optional[str] = None
    since: datetime
    last_seen: datetime
    # The devices it is a member of, and those whose lease it holds.
    devices: List[int]
    owns: List[int]

class ClientRef(BaseModel):
    """Another client, as the server shows it."""
    client_id: str
    name: Optional[str] = None

class HolderRef(BaseModel):
    """What holds a device's camera: a live stream or a burst, and who started it."""
    kind: HolderKind
    # None for a client without a session.
    client_id: Optional[str] = None

class DeviceAccess(BaseModel):
    """Who may use a device and who does, and what this client may do (``you``)."""
    device: int
    mode: Mode
    # The session holding the lease; None on a shared device.
    owner: Optional[ClientRef] = None
    # The sessions that use the device, in the order they joined.
    members: List[ClientRef] = Field(default_factory=list)
    holder: Optional[HolderRef] = None
    # Open live-stream sockets.
    viewers: int = 0
    you: Role

class DisconnectResult(BaseModel):
    """The answer to a disconnect: whether the device is closed now, and how many sessions still use it."""
    closed: bool
    members: int

class AccessRefusal(BaseModel):
    """The JSON body of a refused request (400, 401, 403, 409, 423)."""
    model_config = ConfigDict(extra="allow")
    # session_expired, session_required, session_conflict, read_only, device_in_use, device_locked
    error: str
    mode: Optional[Mode] = None
    owner: Optional[ClientRef] = None
    # 409: the other member sessions and another client's holder.
    members: List[ClientRef] = Field(default_factory=list)
    holder: Optional[HolderRef] = None

# --- MODELS ---

class GenICamEnumInfo(BaseModel):
    display_name: str
    value: int
    # "string_value" can be a string or null (None)
    string_value: Optional[str] = None

class GenICamNodeInfo(BaseModel):
    name: str
    display_name: str
    access_mode: GenICamAccessMode
    node_type: GenICamNodeType
    visibility: GenICamVisibility
    # "enums" can be a list or null. Default to None if missing.
    enums: Optional[List[GenICamEnumInfo]] = None
    # For a selector (e.g. GainSelector): the features whose value depends on it.
    selected: List[str] = Field(default_factory=list)

class GenICamNodeCategory(BaseModel):
    name: str
    display_name: str
    nodes: List[GenICamNodeInfo]

class DeviceDiscoverInfo(BaseModel):
    id: int
    dev_id: str
    serial_number: str
    vendor: str
    model: str
    manufacturer_info: str
    ip: str
    mac: str
    # Who may use the device and who does. Only on entries of ``GET /devices/connected``.
    access: Optional[DeviceAccess] = None

class DeviceConnections(BaseModel):
    available: List[DeviceDiscoverInfo]
    connected: List[DeviceDiscoverInfo]

class FeatureState(BaseModel):
    """Live state of a feature, from ``POST /devices/{id}/gc/features/state``."""
    name: str
    # None when the feature isn't known (see `error`).
    node_type: Optional[GenICamNodeType] = None
    # Formatted as by the single-feature GET. None for a command, a write-only or unavailable
    # feature, or a failed read.
    value: Optional[str] = None
    available: bool
    # The feature can be read but not written right now.
    locked: bool
    # int stays exact for 64-bit integer bounds.
    min: Optional[Union[int, float]] = None
    max: Optional[Union[int, float]] = None
    inc: Optional[Union[int, float]] = None
    unit: Optional[str] = None
    representation: Optional[str] = None
    # For an enum: the integer values of the entries the device currently offers.
    available_entries: Optional[List[int]] = None
    error: Optional[str] = None

class StreamErrorInfo(BaseModel):
    """Why the last live stream on a device ended, and whether one runs now."""
    last_error: Optional[str] = None
    timestamp: Optional[datetime] = None
    active_stream: bool

class StreamInfo(BaseModel):
    """Describes every live-stream frame after it, until the next one."""
    width: int
    height: int
    format: LiveFormat
    pixel_format: str
    # Significant bits per pixel. Above 8, raw frames are little-endian u16s.
    bit_depth: int
    # GevSCPSPacketSize the stream runs with. None from servers that don't report it.
    packet_size: Optional[int] = None

class PacketSizeInfo(BaseModel):
    """A camera's stream packet size, what it may be set to, and the link it travels over."""
    # GevSCPSPacketSize: bytes per stream packet, IP and UDP headers included.
    packet_size: int
    # Allowed sizes are the multiples of `inc` from `min` to `max`.
    min: int
    max: int
    inc: int
    # MTU of the local interface the camera is reached over; None when unknown. A larger packet
    # size never arrives.
    link_mtu: Optional[int] = None
    interface: Optional[str] = None
    local_ip: Optional[str] = None

class AutoPacketSize(BaseModel):
    """The outcome of a test-packet search for the largest packet size that arrives."""
    packet_size: int
    previous: int
    # False when the camera answered no test packet; the size is then left as it was.
    test_packets: bool
    link_mtu: Optional[int] = None
    interface: Optional[str] = None

class BurstJobCreated(BaseModel):
    job_id: UUID
    device_id: int
    status: JobStatus

class BurstJobInfo(BaseModel):
    job_id: UUID
    device_id: int
    status: JobStatus
    format: BurstFormat
    requested_count: int
    captured_count: int
    failed_count: int
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    # When the finished job is dropped from the server. None until it finishes.
    expires_at: Optional[datetime] = None
    # Why the job failed. None unless `status` is failed.
    error: Optional[str] = None
    # Frame geometry, None until the first frame is captured.
    width: Optional[int] = None
    height: Optional[int] = None
    pixel_format: Optional[str] = None
    bit_depth: Optional[int] = None

class ImageEntryOk(BaseModel):
    status: Literal["ok"] = "ok"
    index: int
    size_bytes: int

class ImageEntryFailed(BaseModel):
    status: Literal["failed"] = "failed"
    index: int
    error: str

ImageEntry = Annotated[Union[ImageEntryOk, ImageEntryFailed], Field(discriminator="status")]

image_entries = TypeAdapter(List[ImageEntry])

# --- EVENTS ---

class AccessState(BaseModel):
    """A device's mode, lease owner and members, as events report them."""
    mode: Mode
    owner: Optional[ClientRef] = None
    members: List[ClientRef] = Field(default_factory=list)

class StreamState(BaseModel):
    """A device's running live capture."""
    viewers: int
    pixel_format: str
    bit_depth: int

class BurstState(BaseModel):
    """A device's running burst job."""
    job_id: UUID
    # None for a client without a session.
    client_id: Optional[str] = None

class DeviceState(BaseModel):
    """Everything about a device another client may want to show."""
    device: int
    connected: bool
    access: AccessState
    stream: Optional[StreamState] = None
    burst: Optional[BurstState] = None

class HelloSession(BaseModel):
    client_id: str
    timeout_s: int

class Event(BaseModel):
    """
    A message from ``GET /events``. ``type`` says which of the optional fields are set (see
    :class:`EventType`); a type this version doesn't know arrives with its fields as extras.
    """
    model_config = ConfigDict(extra="allow")
    # Global and increasing; only for noticing gaps.
    seq: int
    time: datetime
    type: str
    # hello: this client, and every connected device's state.
    session: Optional[HelloSession] = None
    devices: Optional[List[DeviceState]] = None
    # device_state, feature_changed, command_executed, access_revoked.
    device: Optional[int] = None
    # device_state: the device's complete state, why it changed (connected, disconnected,
    # access, stream, burst), and for a disconnect why (request, idle, forced, error).
    connected: Optional[bool] = None
    access: Optional[AccessState] = None
    stream: Optional[StreamState] = None
    burst: Optional[BurstState] = None
    cause: Optional[str] = None
    # device_state: why a device closed; session_ended: expired or closed.
    reason: Optional[str] = None
    feature: Optional[str] = None
    command: Optional[str] = None
    # access_revoked: who lost the device; session_ended: whose session ended.
    client_id: Optional[str] = None
    # Who made the change; None for clients without a session and the server itself.
    by: Optional[ClientRef] = None

    @property
    def state(self) -> Optional[DeviceState]:
        """A ``device_state`` event's state, else None."""
        if self.type != EventType.DEVICE_STATE or self.device is None or self.access is None:
            return None
        return DeviceState(device=self.device, connected=bool(self.connected), access=self.access,
                           stream=self.stream, burst=self.burst)
