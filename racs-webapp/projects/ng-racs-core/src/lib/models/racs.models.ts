export interface DeviceDiscoverInfo {
  id: number;
  dev_id: string;
  serial_number: string;
  vendor: string;
  model: string;
  manufacturer_info: string;
  ip: string;
  mac: string;
}

export interface DeviceConnections {
  available: DeviceDiscoverInfo[];
  connected: DeviceDiscoverInfo[];
}

export type GenICamAccessMode = 'Undefined' | 'ReadOnly' | 'WriteOnly' | 'ReadWrite' | 'Unknown';

/** `Boolean` values read and write as `true`/`false`; a `Command` has no value and is executed. */
export type GenICamNodeType =
  | 'NotImplemented'
  | 'Integer'
  | 'Float'
  | 'String'
  | 'Enum'
  | 'Boolean'
  | 'Command';

export type GenICamVisibility = 'Beginner' | 'Expert' | 'Guru' | 'Invisible' | 'Undefined';

export interface GenICamEnumInfo {
  display_name: string;
  string_value: string | null;
  value: number;
}

export interface GenICamNodeInfo {
  name: string;
  display_name: string;
  node_type: GenICamNodeType;
  visibility: GenICamVisibility;
  access_mode: GenICamAccessMode;
  enums: GenICamEnumInfo[] | null;
  /**
   * For a selector (e.g. `GainSelector`): the features whose value depends on it, from its
   * `<pSelected>` elements. Missing from servers older than this field.
   */
  selected?: string[];
}

export interface GenICamNodeCategory {
  name: string;
  display_name: string;
  nodes: GenICamNodeInfo[];
}

/** A feature's live state, from `POST /devices/{id}/gc/features/state`. */
export interface FeatureState {
  name: string;
  /** `null` when the feature isn't known (see `error`). */
  node_type: GenICamNodeType | null;
  /** As `GET /gc/feature/{name}` returns it; `null` for commands, unavailable or unreadable features. */
  value: string | null;
  /** The device's availability conditions hold; an unavailable feature can't be read or written. */
  available: boolean;
  /** Readable, but must not be written right now. */
  locked: boolean;
  min: number | null;
  max: number | null;
  inc: number | null;
  unit: string | null;
  /** GenICam representation: `Linear`, `Logarithmic`, `HexNumber`, `IPV4Address`, `MACAddress`, … */
  representation: string | null;
  /** Integer values of the enum entries the device currently offers. */
  available_entries: number[] | null;
  error: string | null;
}

/** `zstd` is the raw pixels losslessly compressed; see `decodeZstd`. */
export type LiveFormat = 'jpeg' | 'raw' | 'zstd';

/** Whether frames of this format carry every pixel exactly, at any depth (raw and zstd). */
export function isLossless(format: LiveFormat | BurstFormat): boolean {
  return format !== 'jpeg';
}

/**
 * Requested pixel depth. `mono16` gets the deepest unpacked mono format the camera accepts
 * (Mono16/14/12/10, or Coord3D_C16 on a 3D camera in Linescan3D); what it actually granted comes
 * back as `bit_depth`.
 */
export type PixelDepth = 'mono8' | 'mono16';

/** The opening text message of a live stream, sent before any frame. */
export interface StreamInfo {
  width: number;
  height: number;
  format: LiveFormat;
  pixel_format: string;
  /** Significant bits per pixel. Above 8, raw frames are little-endian u16s. Missing from older servers. */
  bit_depth?: number;
  /** GevSCPSPacketSize the stream runs with. Missing from older servers. */
  packet_size?: number;
}

/** A camera's stream packet size, what it may be set to, and the link it travels over. */
export interface PacketSizeInfo {
  /** GevSCPSPacketSize: bytes per stream packet, IP and UDP headers included. */
  packet_size: number;
  /** Allowed sizes are the multiples of `inc` from `min` to `max`. */
  min: number;
  max: number;
  inc: number;
  /** MTU of the local interface the camera is reached over; null when unknown. */
  link_mtu: number | null;
  interface: string | null;
  local_ip: string | null;
}

/** The outcome of the server's test-packet search for the largest packet size that arrives. */
export interface AutoPacketSize {
  packet_size: number;
  previous: number;
  /** False when the camera answered no test packet; the size is then left as it was. */
  test_packets: boolean;
  link_mtu: number | null;
  interface: string | null;
}

/** One binary message from the live stream. */
export interface LiveFrame {
  /** Counts frames actually sent, from 0. */
  frameNumber: number;
  /** Cumulative for the session: incomplete frames, fps-limited frames, and frames the client was too slow for. */
  dropped: number;
  /** The image: JPEG bytes, raw pixels, or zstd-compressed ones, as described by the stream's {@link StreamInfo}. */
  payload: Uint8Array;
}

export type BurstFormat = 'raw' | 'jpeg' | 'zstd';

export type OnFailure = 'abort' | 'skip';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StartBurstJobRequest {
  count: number;
  format: BurstFormat;
  pixel_depth?: PixelDepth;
  quality?: number;
  on_failure?: OnFailure;
  max_failures?: number;
}

export interface BurstJobCreated {
  job_id: string;
  device_id: number;
  status: JobStatus;
}

export interface BurstJobInfo {
  job_id: string;
  device_id: number;
  status: JobStatus;
  format: BurstFormat;
  requested_count: number;
  captured_count: number;
  failed_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  error: string | null;
  /** `null` until the first frame is captured; shared by every frame of the job. */
  width: number | null;
  height: number | null;
  pixel_format: string | null;
  bit_depth: number | null;
}

export type ImageEntryInfo =
  | { status: 'ok'; index: number; size_bytes: number }
  | { status: 'failed'; index: number; error: string };

export interface StreamErrorInfo {
  last_error: string | null;
  timestamp: string | null;
  active_stream: boolean;
  /** Open live sockets of the device's capture. */
  viewers?: number;
}

// ---------------------------------------------------------------------------------------------
// Multi-user: sessions, access modes, events (specs/multi-user.md)
// ---------------------------------------------------------------------------------------------

/** `POST /sessions`. `session_id` is the secret, `client_id` what other clients see. */
export interface SessionCreated {
  session_id: string;
  client_id: string;
  name: string | null;
  timeout_s: number;
  heartbeat_interval_s: number;
}

/** A client as the others see it: `by` in events, the members and owner of a device. */
export interface ClientRef {
  client_id: string;
  name: string | null;
}

export type AccessMode = 'shared' | 'ro-shared' | 'exclusive';

/** This client's role on a device: what it may do there. */
export type Role = 'owner' | 'writer' | 'reader' | 'meta';

export interface HolderRef {
  kind: 'live' | 'burst';
  client_id: string | null;
}

/** `GET /devices/{id}/access`, also the answer of connect and the lease routes. */
export interface DeviceAccess {
  device: number;
  mode: AccessMode;
  owner: ClientRef | null;
  members: ClientRef[];
  holder: HolderRef | null;
  /** Open sockets of the running live capture. */
  viewers: number;
  you: Role;
}

/** An entry of `GET /devices/connected`. `GET /devices` lists the same devices without `access`. */
export interface ConnectedDevice extends DeviceDiscoverInfo {
  access?: DeviceAccess;
}

export interface DisconnectResult {
  closed: boolean;
  members: number;
}

/** The JSON body of a refusal (`400`/`401`/`403`/`409`/`423`). Other errors stay text. */
export interface AccessRefusal {
  error: 'session_required' | 'session_expired' | 'session_conflict' | 'read_only' | 'device_in_use' | 'device_locked';
  mode?: AccessMode;
  owner?: ClientRef | null;
  members?: ClientRef[];
  holder?: HolderRef | null;
}

export type CloseReason = 'request' | 'idle' | 'forced' | 'error';

/** A device's state as events carry it (the access part without `you`, holder and viewers). */
export interface DeviceState {
  device: number;
  connected: boolean;
  access: { mode: AccessMode; owner: ClientRef | null; members: ClientRef[] };
  stream: { viewers: number; pixel_format: string; bit_depth: number } | null;
  burst: { job_id: string; client_id: string | null } | null;
}

interface EventBase {
  seq: number;
  time: string;
}

/** A message of `GET /events`. */
export type ServerEvent = EventBase &
  (
    | { type: 'hello'; session: { client_id: string; timeout_s: number }; devices: DeviceState[] }
    | (DeviceState & {
        type: 'device_state';
        cause: 'connected' | 'disconnected' | 'access' | 'stream' | 'burst';
        reason: CloseReason | null;
        by: ClientRef | null;
      })
    | { type: 'feature_changed'; device: number; feature: string; by: ClientRef | null }
    | { type: 'command_executed'; device: number; command: string; by: ClientRef | null }
    | { type: 'access_revoked'; device: number; client_id: string; by: ClientRef | null }
    | { type: 'session_ended'; client_id: string; reason: 'expired' | 'closed' }
    | { type: 'resync' }
  );
