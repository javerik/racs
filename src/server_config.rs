//! Listener and optional website configuration, shared by native, Windows and AppImage launches.
use clap::Parser;
use std::time::Duration;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, Parser)]
#[command(
    version,
    about = "RACS camera API and optional integrated webapp server"
)]
pub struct ServerConfig {
    /// Listener IP address or hostname (IPv6 addresses without brackets)
    #[arg(long, env = "RACS_HOST", default_value = "0.0.0.0", value_parser = parse_host)]
    pub host: String,
    /// Listener TCP port
    #[arg(long, env = "RACS_PORT", default_value_t = 8742, value_parser = clap::value_parser!(u16).range(1..))]
    pub port: u16,
    /// Directory containing the built website; defaults to a `web` folder next to the executable if present
    #[arg(long, env = "RACS_WEB_ROOT")]
    pub web_root: Option<PathBuf>,
    /// Seconds a client session lives without a heartbeat, unless it asks for its own (clamped
    /// to 5..=600)
    #[arg(long, env = "RACS_SESSION_TIMEOUT_S", default_value_t = 30)]
    pub session_timeout: u64,
    /// Seconds a connected device may go unused (no member session, no stream or burst, no
    /// anonymous request) before it is disconnected; 0 never disconnects
    #[arg(long, env = "RACS_DEVICE_IDLE_TIMEOUT_S", default_value_t = 300)]
    pub device_idle_timeout: u64,
}

/// Every duration the multi-user machinery runs on, plus the event bus's size. One struct, so the
/// tests can run sessions and idle timeouts in milliseconds.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// A session's timeout when it asks for none.
    pub session_timeout: Duration,
    /// The range a session's timeout is clamped to.
    pub session_timeout_min: Duration,
    pub session_timeout_max: Duration,
    /// How long a device may go unused before it is closed; `None` never closes one.
    pub device_idle_timeout: Option<Duration>,
    /// How often expired sessions, idle devices and expired burst jobs are swept.
    pub sweep_interval: Duration,
    /// Events a subscriber may fall behind before it gets `resync`.
    pub event_capacity: usize,
}

impl Default for RuntimeConfig {
    /// The server's defaults, with the idle timeout off (the 0.3 behaviour).
    fn default() -> Self {
        Self {
            session_timeout: Duration::from_secs(30),
            session_timeout_min: Duration::from_secs(5),
            session_timeout_max: Duration::from_secs(600),
            device_idle_timeout: None,
            sweep_interval: Duration::from_secs(1),
            event_capacity: 256,
        }
    }
}

impl RuntimeConfig {
    /// From the `--session-timeout` and `--device-idle-timeout` seconds; an idle timeout of 0
    /// never closes a device.
    pub fn from_secs(session_timeout_s: u64, device_idle_timeout_s: u64) -> Self {
        let defaults = Self::default();
        Self {
            session_timeout: Duration::from_secs(session_timeout_s)
                .clamp(defaults.session_timeout_min, defaults.session_timeout_max),
            device_idle_timeout: (device_idle_timeout_s > 0).then(|| Duration::from_secs(device_idle_timeout_s)),
            ..defaults
        }
    }
}

fn parse_host(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value != value.trim() {
        return Err(
            "host must be a non-empty IP address or hostname without surrounding whitespace".into(),
        );
    }
    Ok(value.to_owned())
}

impl ServerConfig {
    /// Validate before initializing camera discovery or binding the listener.
    pub fn validate(&mut self) -> io::Result<()> {
        self.validate_with_exe(std::env::current_exe().ok().as_deref())
    }

    pub fn validate_with_exe(&mut self, exe: Option<&Path>) -> io::Result<()> {
        if self.web_root.is_none() {
            if let Some(bundled) = exe
                .and_then(|p| p.parent())
                .map(|dir| dir.join("web"))
                .filter(|dir| dir.is_dir())
            {
                self.web_root = Some(bundled);
            }
        }
        if let Some(root) = &self.web_root {
            let canonical = root.canonicalize().map_err(|e| {
                io::Error::new(
                    e.kind(),
                    format!("invalid web root {}: {e}", root.display()),
                )
            })?;
            let index = canonical.join("index.html").canonicalize().map_err(|e| {
                io::Error::new(
                    e.kind(),
                    format!("web root {} requires index.html: {e}", root.display()),
                )
            })?;
            if !canonical.is_dir() || !index.is_file() || !index.starts_with(&canonical) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "web root must contain an index.html file within that directory",
                ));
            }
            self.web_root = Some(canonical);
        }
        Ok(())
    }

    pub fn runtime(&self) -> RuntimeConfig {
        RuntimeConfig::from_secs(self.session_timeout, self.device_idle_timeout)
    }

    pub fn base_url(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("http://{host}:{}", self.port)
    }
}
