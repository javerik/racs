//! Choosing which interfaces to send GigE Vision discovery probes on.
//!
//! aravis-port's `discover` takes explicit bind addresses — it has no interface enumeration of its
//! own, and its default (bind `0.0.0.0`, follow the OS default route) never reaches a camera on a
//! link-local address such as 169.254.x. The previous aravis-based implementation got enumeration
//! for free from `GvInterface`, so RACS supplies it here.

use std::net::Ipv4Addr;
use std::time::Duration;

use tracing::debug;

/// Interfaces to skip by name prefix. Container and VPN bridges have no cameras behind them and
/// each one otherwise costs a full discovery timeout.
const DEFAULT_SKIP_PREFIXES: &[&str] = &["lo", "docker", "br-", "veth", "virbr", "wg", "tun", "tap", "zt"];

const DEFAULT_TIMEOUT_MS: u64 = 1000;

/// `(bind address, directed broadcast)` for every plausible IPv4 interface.
///
/// `RACS_DISCOVERY_BIND` overrides enumeration entirely: a comma-separated list of
/// `bind_ip[/broadcast_ip]`, e.g. `169.254.1.1/169.254.255.255,192.168.10.102`.
pub fn discovery_bind_addrs() -> Vec<(Ipv4Addr, Option<Ipv4Addr>)> {
    if let Ok(spec) = std::env::var("RACS_DISCOVERY_BIND") {
        let parsed = parse_bind_spec(&spec);
        if parsed.is_empty() {
            debug!("RACS_DISCOVERY_BIND={spec:?} yielded no usable addresses, falling back to enumeration");
        } else {
            debug!("using {} bind address(es) from RACS_DISCOVERY_BIND", parsed.len());
            return parsed;
        }
    }
    enumerate_bind_addrs()
}

/// Per-interface listen window. aravis-port applies its timeout to each bind address, and RACS
/// probes interfaces concurrently, so this is the wall-clock cost of a discovery round.
pub fn discovery_timeout() -> Duration {
    let ms = std::env::var("RACS_DISCOVERY_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

fn parse_bind_spec(spec: &str) -> Vec<(Ipv4Addr, Option<Ipv4Addr>)> {
    spec.split(',')
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }
            let (bind, broadcast) = match entry.split_once('/') {
                Some((b, bc)) => (b.trim(), Some(bc.trim())),
                None => (entry, None),
            };
            let bind: Ipv4Addr = bind.parse().ok()?;
            let broadcast = match broadcast {
                Some(bc) => Some(bc.parse().ok()?),
                None => None,
            };
            Some((bind, broadcast))
        })
        .collect()
}

fn enumerate_bind_addrs() -> Vec<(Ipv4Addr, Option<Ipv4Addr>)> {
    let interfaces = match if_addrs::get_if_addrs() {
        Ok(ifs) => ifs,
        Err(e) => {
            debug!("interface enumeration failed ({e}), falling back to the default route");
            return vec![(Ipv4Addr::UNSPECIFIED, None)];
        }
    };

    let mut addrs = Vec::new();
    for iface in interfaces {
        if should_skip(&iface.name) {
            continue;
        }
        let if_addrs::IfAddr::V4(v4) = iface.addr else { continue };
        if v4.ip.is_loopback() || v4.ip.is_unspecified() {
            continue;
        }
        let broadcast = v4.broadcast.or_else(|| derive_broadcast(v4.ip, v4.netmask));
        debug!("discovery will probe {} via {} (broadcast {:?})", iface.name, v4.ip, broadcast);
        addrs.push((v4.ip, broadcast));
    }

    if addrs.is_empty() {
        // Better to try the default route than to report no interfaces at all.
        return vec![(Ipv4Addr::UNSPECIFIED, None)];
    }
    addrs
}

fn should_skip(name: &str) -> bool {
    let skips = std::env::var("RACS_DISCOVERY_SKIP_PREFIXES").ok();
    match &skips {
        Some(spec) => spec.split(',').map(str::trim).filter(|p| !p.is_empty()).any(|p| name.starts_with(p)),
        None => DEFAULT_SKIP_PREFIXES.iter().any(|p| name.starts_with(p)),
    }
}

/// The directed broadcast for an address/netmask pair: host bits all set.
fn derive_broadcast(ip: Ipv4Addr, netmask: Ipv4Addr) -> Option<Ipv4Addr> {
    let ip = u32::from(ip);
    let mask = u32::from(netmask);
    if mask == 0 || mask == u32::MAX {
        return None;
    }
    Some(Ipv4Addr::from(ip | !mask))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_directed_broadcast_from_netmask() {
        assert_eq!(
            derive_broadcast(Ipv4Addr::new(169, 254, 1, 1), Ipv4Addr::new(255, 255, 0, 0)),
            Some(Ipv4Addr::new(169, 254, 255, 255))
        );
        assert_eq!(
            derive_broadcast(Ipv4Addr::new(192, 168, 10, 102), Ipv4Addr::new(255, 255, 255, 0)),
            Some(Ipv4Addr::new(192, 168, 10, 255))
        );
        // A /32 has no meaningful broadcast address.
        assert_eq!(derive_broadcast(Ipv4Addr::new(10, 0, 0, 1), Ipv4Addr::new(255, 255, 255, 255)), None);
    }

    #[test]
    fn parses_bind_spec_with_and_without_broadcast() {
        let parsed = parse_bind_spec("169.254.1.1/169.254.255.255, 192.168.10.102 ,, garbage");
        assert_eq!(
            parsed,
            vec![
                (Ipv4Addr::new(169, 254, 1, 1), Some(Ipv4Addr::new(169, 254, 255, 255))),
                (Ipv4Addr::new(192, 168, 10, 102), None),
            ]
        );
    }

    #[test]
    fn skips_container_and_vpn_interfaces_by_default() {
        for name in ["lo", "docker0", "br-0b3fea515389", "veth123", "wg0"] {
            assert!(should_skip(name), "{name} should be skipped");
        }
        for name in ["eth0", "enp9s0f0", "enp0s31f6"] {
            assert!(!should_skip(name), "{name} should not be skipped");
        }
    }
}
