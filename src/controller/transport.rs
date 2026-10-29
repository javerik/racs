//! The GVSP transport of a connected camera: the link it is reached over and its stream packet
//! size (`GevSCPSPacketSize`).
//!
//! The camera's register is the setting. Every acquisition streams with the packet size the
//! camera holds ([`stream_config`]) rather than forcing one, so a size written through the
//! GenICam endpoints ([`write_packet_size`]) or found with test packets ([`auto`]) stays in effect.
//! The only time the server changes it unasked is at connect ([`settle_on_connect`]), and only
//! when the camera's size doesn't reach this host.
//!
//! Everything here blocks on camera I/O, so it runs on a blocking thread like all camera work.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

use aravis_port::core::gvsp::MINIMUM_PACKET_SIZE;
use aravis_port::{Camera, PacketSizeOutcome, PacketSizeSearch, StreamConfig};
use tracing::{info, warn};

use crate::models::transport::{AutoPacketSize, PacketSizeInfo};
use crate::rcs_erros::RcsError;
use crate::stores::conn_camera::CamHandle;

/// The GenICam name of the stream packet size.
pub const PACKET_SIZE_FEATURE: &str = "GevSCPSPacketSize";

/// What a stream uses when the camera's packet size can't be read: safely under a 1500 MTU.
const FALLBACK_PACKET_SIZE: u16 = 1400;

/// Bounds for a camera whose XML has no `GevSCPSPacketSize` node: GigE Vision's 576-byte minimum
/// datagram up to a 9000-byte jumbo frame, in steps of 4.
const DEFAULT_BOUNDS: PacketSizeBounds = PacketSizeBounds {
    min: 576,
    max: 9000,
    inc: 4,
};

/// GVCP's fixed control port; only used to ask the OS for a route, nothing is sent.
const GVCP_PORT: u16 = 3956;

/// The local end of the path to a camera. Whatever can't be found out stays `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkInfo {
    pub local_ip: Option<Ipv4Addr>,
    pub interface: Option<String>,
    pub mtu: Option<u32>,
}

impl LinkInfo {
    /// The link this host reaches `camera_ip` over: the source address the OS routes through, the
    /// interface holding it, and that interface's MTU.
    pub fn to(camera_ip: Ipv4Addr) -> Self {
        let Some(local_ip) = local_route_to(camera_ip) else {
            return Self::default();
        };
        let interface = if_addrs::get_if_addrs()
            .ok()
            .and_then(|ifaces| ifaces.into_iter().find(|i| i.ip() == IpAddr::V4(local_ip)))
            .map(|i| i.name);
        let mtu = interface.as_deref().and_then(interface_mtu);
        Self {
            local_ip: Some(local_ip),
            interface,
            mtu,
        }
    }

    fn describe(&self) -> String {
        match (&self.interface, self.mtu) {
            (Some(name), Some(mtu)) => format!("MTU {mtu} of {name}"),
            (None, Some(mtu)) => format!("MTU {mtu}"),
            _ => "link MTU unknown".to_string(),
        }
    }
}

/// The source address for `peer`, from a UDP `connect` (which only resolves the route).
fn local_route_to(peer: Ipv4Addr) -> Option<Ipv4Addr> {
    let probe = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    probe.connect((peer, GVCP_PORT)).ok()?;
    match probe.local_addr().ok()?.ip() {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(_) => None,
    }
}

#[cfg(target_os = "linux")]
fn interface_mtu(name: &str) -> Option<u32> {
    // Not a path component from outside: `name` comes from the OS's own interface list.
    parse_mtu(&std::fs::read_to_string(format!("/sys/class/net/{name}/mtu")).ok()?)
}

#[cfg(not(target_os = "linux"))]
fn interface_mtu(_name: &str) -> Option<u32> {
    None
}

fn parse_mtu(text: &str) -> Option<u32> {
    text.trim().parse().ok().filter(|mtu| *mtu > 0)
}

/// The packet sizes a camera accepts: multiples of `inc` from `min` to `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacketSizeBounds {
    pub min: u16,
    pub max: u16,
    pub inc: u16,
}

impl PacketSizeBounds {
    /// Bounds from the feature's declared range, moved inwards onto multiples of `inc`. Cameras
    /// accept multiples of the increment rather than GenICam's `min + k * inc`: the AT
    /// C6-S7-3070 declares Min 86, Inc 4, Max 7960 and uses 1400 and 1500 itself.
    fn aligned(min: i64, max: i64, inc: i64) -> Option<Self> {
        let inc = inc.max(1);
        let min = (min.max(MINIMUM_PACKET_SIZE as i64) + inc - 1) / inc * inc;
        let max = max.min(u16::MAX as i64) / inc * inc;
        (min <= max).then_some(Self {
            min: min as u16,
            max: max as u16,
            inc: inc as u16,
        })
    }

    /// The largest allowed size not above `limit`, or `None` when even `min` is.
    fn largest_up_to(&self, limit: u32) -> Option<u16> {
        let top = limit.min(self.max as u32) / self.inc as u32 * self.inc as u32;
        (top >= self.min as u32).then_some(top as u16)
    }
}

/// The camera's packet size bounds, or [`DEFAULT_BOUNDS`] when its XML doesn't say.
pub fn bounds(camera: &Camera) -> PacketSizeBounds {
    let Ok(info) = camera.feature_info(PACKET_SIZE_FEATURE) else {
        return DEFAULT_BOUNDS;
    };
    let get = |v: Option<aravis_port::genicam::Value>, default: u16| v.map(|v| v.as_i64()).unwrap_or(default as i64);
    PacketSizeBounds::aligned(
        get(info.min, DEFAULT_BOUNDS.min),
        get(info.max, DEFAULT_BOUNDS.max),
        get(info.inc, DEFAULT_BOUNDS.inc),
    )
    .unwrap_or(DEFAULT_BOUNDS)
}

/// The stream config for an acquisition on `camera`: its own packet size, so starting a stream
/// doesn't change it.
pub fn stream_config(camera: &Camera) -> StreamConfig {
    let packet_size = match camera.stream_packet_size() {
        Ok(size) if size as usize >= MINIMUM_PACKET_SIZE => size,
        other => {
            warn!("can't use the camera's packet size ({other:?}); streaming with {FALLBACK_PACKET_SIZE}");
            FALLBACK_PACKET_SIZE
        }
    };
    StreamConfig {
        packet_size,
        ..StreamConfig::default()
    }
}

/// `value` as a packet size this camera may be set to over `link`, or why not.
pub fn check_packet_size(value: i64, bounds: &PacketSizeBounds, link: &LinkInfo) -> Result<u16, RcsError> {
    let refuse = |why: String| Err(RcsError::ValueError(Some(format!("{PACKET_SIZE_FEATURE} {value}: {why}"))));
    if value < bounds.min as i64 || value > bounds.max as i64 {
        return refuse(format!("must be between {} and {}", bounds.min, bounds.max));
    }
    if value % bounds.inc as i64 != 0 {
        return refuse(format!("must be a multiple of {}", bounds.inc));
    }
    if let Some(mtu) = link.mtu {
        if value > mtu as i64 {
            return refuse(format!(
                "exceeds the {} towards the camera, so no packet would arrive",
                link.describe()
            ));
        }
    }
    Ok(value as u16)
}

/// Write a new packet size from its REST spelling. Goes to the register directly rather than
/// through the GenICam node: that also drops the GenICam cache, whose `PayloadSize` depends on the
/// packet size on the C6 without saying so.
pub fn write_packet_size(handle: &CamHandle, value: &str) -> Result<(), RcsError> {
    let parsed: i64 = value
        .trim()
        .parse()
        .map_err(|e| RcsError::ValueError(Some(format!("{PACKET_SIZE_FEATURE} {value:?}: {e}"))))?;
    let size = check_packet_size(parsed, &bounds(&handle.camera), &handle.link)?;
    handle.camera.device().set_stream_packet_size(size)?;
    Ok(())
}

/// The packet size and what it may be set to.
pub fn info(handle: &CamHandle) -> Result<PacketSizeInfo, RcsError> {
    let b = bounds(&handle.camera);
    Ok(PacketSizeInfo {
        packet_size: handle.camera.stream_packet_size()?,
        min: b.min,
        max: b.max,
        inc: b.inc,
        link_mtu: handle.link.mtu,
        interface: handle.link.interface.clone(),
        local_ip: handle.link.local_ip.map(|ip| ip.to_string()),
    })
}

/// Search the camera's bounds, capped at the link MTU, with test packets.
fn search(camera: &Camera, link: &LinkInfo, exit_early: bool) -> Result<PacketSizeOutcome, RcsError> {
    let b = bounds(camera);
    let max = link.mtu.and_then(|mtu| b.largest_up_to(mtu)).unwrap_or(b.max);
    Ok(camera.auto_packet_size(&PacketSizeSearch {
        min: b.min,
        max,
        inc: b.inc,
        exit_early,
    })?)
}

/// Find and set the largest packet size that reaches this host. Must not run while acquiring.
pub fn auto(handle: &CamHandle) -> Result<AutoPacketSize, RcsError> {
    let outcome = search(&handle.camera, &handle.link, false)?;
    info!(
        "auto packet size: {} (was {}, test packets {}, {})",
        outcome.packet_size,
        outcome.previous,
        if outcome.test_packets { "answered" } else { "not answered" },
        handle.link.describe()
    );
    Ok(AutoPacketSize {
        packet_size: outcome.packet_size,
        previous: outcome.previous,
        test_packets: outcome.test_packets,
        link_mtu: handle.link.mtu,
        interface: handle.link.interface.clone(),
    })
}

/// Make sure a freshly connected camera's packet size reaches this host, as Aravis does before a
/// first stream: a size that passes a test packet is kept, one that doesn't is replaced by the
/// largest that does. A camera without test packets is only brought under a known link MTU.
/// Never fails the connect; problems are logged.
pub fn settle_on_connect(camera: &Camera, link: &LinkInfo) {
    match search(camera, link, true) {
        Ok(o) if o.test_packets && o.packet_size != o.previous => {
            info!("packet size {} doesn't reach this host ({}); set {}", o.previous, link.describe(), o.packet_size);
        }
        Ok(o) if o.test_packets => info!("packet size {} reaches this host ({})", o.packet_size, link.describe()),
        Ok(o) => {
            let fitted = link.mtu.and_then(|mtu| bounds(camera).largest_up_to(mtu));
            match fitted {
                Some(size) if (o.previous as u32) > link.mtu.unwrap_or(u32::MAX) => {
                    warn!("no test packets; packet size {} exceeds the {}, set {size}", o.previous, link.describe());
                    if let Err(e) = camera.device().set_stream_packet_size(size) {
                        warn!("failed to set packet size {size} => {e}");
                    }
                }
                _ => info!("no test packets; keeping packet size {} ({})", o.previous, link.describe()),
            }
        }
        Err(e) => warn!("couldn't check the packet size => {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C6: PacketSizeBounds = PacketSizeBounds {
        min: 88,
        max: 7960,
        inc: 4,
    };

    #[test]
    fn bounds_move_onto_multiples_of_inc() {
        // The AT C6-S7-3070's declared range.
        assert_eq!(PacketSizeBounds::aligned(86, 7960, 4), Some(C6));
        assert_eq!(
            PacketSizeBounds::aligned(0, 70000, 0),
            Some(PacketSizeBounds {
                min: MINIMUM_PACKET_SIZE as u16,
                max: u16::MAX,
                inc: 1
            })
        );
        assert_eq!(PacketSizeBounds::aligned(1001, 1003, 4), None);
    }

    #[test]
    fn largest_up_to_stays_on_the_grid() {
        assert_eq!(C6.largest_up_to(9000), Some(7960));
        assert_eq!(C6.largest_up_to(1500), Some(1500));
        assert_eq!(C6.largest_up_to(1499), Some(1496));
        assert_eq!(C6.largest_up_to(50), None);
    }

    #[test]
    fn check_refuses_sizes_off_the_grid_or_above_the_mtu() {
        let link = LinkInfo {
            local_ip: None,
            interface: Some("enp9s0f0".to_string()),
            mtu: Some(1500),
        };
        assert_eq!(check_packet_size(1500, &C6, &link).unwrap(), 1500);
        assert_eq!(check_packet_size(88, &C6, &link).unwrap(), 88);

        let message = |v| check_packet_size(v, &C6, &link).unwrap_err().to_string();
        assert!(message(1504).contains("MTU 1500 of enp9s0f0"), "{}", message(1504));
        assert!(message(1498).contains("multiple of 4"), "{}", message(1498));
        assert!(message(84).contains("between 88 and 7960"), "{}", message(84));

        // An unknown MTU limits nothing.
        assert_eq!(check_packet_size(7960, &C6, &LinkInfo::default()).unwrap(), 7960);
    }

    #[test]
    fn mtu_parses_the_sysfs_text() {
        assert_eq!(parse_mtu("9000\n"), Some(9000));
        assert_eq!(parse_mtu("0\n"), None);
        assert_eq!(parse_mtu("eth"), None);
    }

    #[test]
    fn the_loopback_link_is_found() {
        let link = LinkInfo::to(Ipv4Addr::LOCALHOST);
        assert_eq!(link.local_ip, Some(Ipv4Addr::LOCALHOST));
        assert!(link.interface.is_some());
        if cfg!(target_os = "linux") {
            assert!(link.mtu.is_some_and(|mtu| mtu >= 1500), "{link:?}");
        }
    }
}
