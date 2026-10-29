//! Types for the GVSP transport endpoints under `/devices/{id}/stream/packet-size`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A camera's stream packet size, what it may be set to, and the link it travels over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PacketSizeInfo {
    /// `GevSCPSPacketSize`: the size of each stream packet as a whole IP datagram (IP and UDP
    /// headers included), in bytes. Every grab, live stream and burst uses it as it is.
    pub packet_size: u16,
    /// Smallest and largest allowed packet size, both multiples of `inc`.
    pub min: u16,
    pub max: u16,
    /// Packet sizes are multiples of this.
    pub inc: u16,
    /// MTU of the local interface the camera is reached over. A larger packet size never
    /// arrives. `null` when it can't be determined (only Linux hosts report it).
    pub link_mtu: Option<u32>,
    /// Name of that interface, e.g. `enp9s0f0`.
    pub interface: Option<String>,
    /// This host's address on that interface.
    pub local_ip: Option<String>,
}

/// The result of `POST /devices/{id}/stream/packet-size/auto`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AutoPacketSize {
    /// The packet size now set: the largest that reached this host.
    pub packet_size: u16,
    /// The packet size before the search.
    pub previous: u16,
    /// Whether the camera answered test packets at all. When it doesn't, nothing could be
    /// measured and `packet_size` equals `previous`.
    pub test_packets: bool,
    /// MTU of the local interface the camera is reached over; the search doesn't go above it.
    pub link_mtu: Option<u32>,
    pub interface: Option<String>,
}
