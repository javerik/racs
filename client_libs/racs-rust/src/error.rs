use std::fmt;

use crate::models::{AccessRefusal, BurstJobInfo};

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// An error response from the server.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    /// The response body: the server's error message.
    pub body: String,
    pub url: String,
}

impl ApiError {
    /// The body as a refusal (`{"error": …, "mode": …, "owner": …}`), if it is one.
    pub fn refusal(&self) -> Option<AccessRefusal> {
        serde_json::from_str(&self.body).ok()
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} for {}: {}", self.status, self.url, self.body)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The camera is held by another request: a live stream, a burst job or a frame grab.
    #[error("camera busy: {0}")]
    CameraBusy(ApiError),
    /// 404: no such burst job, or a burst image that has not been captured (yet).
    #[error("not found: {0}")]
    NotFound(ApiError),
    /// 410: that burst image was attempted and failed. The body holds the reason.
    #[error("image failed: {0}")]
    ImageFailed(ApiError),
    /// 401: the session is unknown or has expired. Requests renew the session and retry once
    /// before this reaches the caller.
    #[error("session expired: {0}")]
    SessionExpired(ApiError),
    /// 403: a write on a `ro-shared` device by a client that doesn't hold its lease.
    /// [`refusal`](Self::refusal) names the owner.
    #[error("read-only: {0}")]
    ReadOnly(ApiError),
    /// 409: going `exclusive` while other clients use the device. [`refusal`](Self::refusal)
    /// names them; `force` evicts them.
    #[error("device in use: {0}")]
    DeviceInUse(ApiError),
    /// 423: the device is locked by another session's lease (`exclusive`, or `ro-shared` for an
    /// anonymous client), or its lease is owned by another session. [`refusal`](Self::refusal)
    /// names the owner.
    #[error("device locked: {0}")]
    DeviceLocked(ApiError),
    /// Any other error status.
    #[error("{0}")]
    Api(ApiError),
    /// A GenICam feature could not be read or has no value of the requested type.
    #[error("{name}: {error}")]
    Feature { name: String, error: String },
    /// A burst job ended in `failed`; `error` in the info holds the reason.
    #[error("burst job {} failed: {}", .0.job_id, .0.error.as_deref().unwrap_or("unknown error"))]
    BurstJobFailed(Box<BurstJobInfo>),
    /// The server closed the live stream because of an error.
    #[error("live stream failed: {reason}")]
    LiveStream { reason: String, code: Option<u16> },
    /// The server closed a live stream or the events socket with `4001`: this client's session
    /// ended. The next request starts a new one.
    #[error("session ended: {reason}")]
    SessionEnded { reason: String },
    /// The server closed a live stream with `4003`: another session took the device `exclusive`
    /// with `force`.
    #[error("access revoked: {reason}")]
    AccessRevoked { reason: String },
    #[error("timed out: {0}")]
    Timeout(String),
    /// The server sent something this client cannot interpret.
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("invalid URL: {0}")]
    Url(#[from] url::ParseError),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    WebSocket(#[from] Box<tokio_tungstenite::tungstenite::Error>),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl Error {
    /// The error for an error response, picked by status and body.
    pub(crate) fn from_response(status: u16, body: String, url: String) -> Self {
        let api = ApiError { status, body, url };
        match status {
            401 => Error::SessionExpired(api),
            403 => Error::ReadOnly(api),
            404 => Error::NotFound(api),
            409 => Error::DeviceInUse(api),
            410 => Error::ImageFailed(api),
            423 => Error::DeviceLocked(api),
            // The server reports a held camera as a 500 whose body names the `Busy` store error.
            500 if api.body.contains("Busy") => Error::CameraBusy(api),
            _ => Error::Api(api),
        }
    }

    /// The HTTP status, for errors that come from an error response.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Http(e) => e.status().map(|s| s.as_u16()),
            _ => self.api().map(|e| e.status),
        }
    }

    /// The error response, for errors that come from one.
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::CameraBusy(e)
            | Error::NotFound(e)
            | Error::ImageFailed(e)
            | Error::SessionExpired(e)
            | Error::ReadOnly(e)
            | Error::DeviceInUse(e)
            | Error::DeviceLocked(e)
            | Error::Api(e) => Some(e),
            _ => None,
        }
    }

    /// The parsed body of a refusal ([`ReadOnly`](Self::ReadOnly), [`DeviceInUse`](Self::DeviceInUse),
    /// [`DeviceLocked`](Self::DeviceLocked), [`SessionExpired`](Self::SessionExpired), or a `400
    /// session_required`): the device's mode, its owner, the other members.
    pub fn refusal(&self) -> Option<AccessRefusal> {
        self.api()?.refusal()
    }

    /// The error for a WebSocket the server closed with `code`, or `None` for a normal end (`1000`:
    /// the client left, `1001`: the device stopped delivering or was disconnected).
    pub(crate) fn from_close(code: u16, reason: &str) -> Option<Self> {
        let reason = if reason.is_empty() { format!("stream closed with code {code}") } else { reason.to_string() };
        match code {
            1000 | 1001 => None,
            4001 => Some(Error::SessionEnded { reason }),
            4003 => Some(Error::AccessRevoked { reason }),
            _ => Some(Error::LiveStream { reason, code: Some(code) }),
        }
    }

    pub(crate) fn feature(name: &str, error: impl Into<String>) -> Self {
        Error::Feature { name: name.to_string(), error: error.into() }
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        Error::WebSocket(Box::new(e))
    }
}
