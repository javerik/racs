//! Client sessions: the bodies of the `/sessions` routes, how a client is named to the others, and
//! the JSON body of the refusals that come with sessions.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// `POST /sessions`. Both fields are optional, and so is the body.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct CreateSessionRequest {
    /// Shown to other clients, e.g. `webapp · Firefox` or `line-script`.
    pub name: Option<String>,
    /// Seconds without a heartbeat before the session ends. Defaults to the server's
    /// `--session-timeout` and is clamped to 5..=600.
    pub timeout_s: Option<u64>,
}

/// `PATCH /sessions/{session_id}`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct RenameSessionRequest {
    /// The new name other clients see; `null` or missing removes it.
    pub name: Option<String>,
}

/// `201` answer of `POST /sessions`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SessionCreated {
    /// Secret: send it as `X-Racs-Session` or `?session=` with every request of this client.
    pub session_id: Uuid,
    /// Public: how other clients see this one (8 hex characters).
    pub client_id: String,
    pub name: Option<String>,
    pub timeout_s: u64,
    /// How often to send a heartbeat: a third of the timeout.
    pub heartbeat_interval_s: u64,
}

/// A client as the others see it. `by` in events, the members of a device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ClientRef {
    pub client_id: String,
    pub name: Option<String>,
}

/// An entry of `GET /sessions`. Never carries a `session_id`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SessionInfo {
    pub client_id: String,
    pub name: Option<String>,
    /// When the session was created, RFC 3339.
    pub since: DateTime<Utc>,
    /// The last heartbeat or request carrying the session, RFC 3339.
    pub last_seen: DateTime<Utc>,
    /// The devices this session is a member of.
    pub devices: Vec<u32>,
    /// The devices whose lease this session holds.
    pub owns: Vec<u32>,
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// No heartbeat within its timeout.
    Expired,
    /// `DELETE /sessions/{session_id}`.
    Closed,
}

/// `200` answer of `PUT /devices/{id}/disconnect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DisconnectResult {
    /// Whether the device is closed after this request (also `true` if it wasn't connected).
    pub closed: bool,
    /// The sessions still members of the device.
    pub members: u32,
}

/// The JSON body of the refusals that came with sessions (`400`, `401`). Existing errors keep
/// their `500 text/plain` bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    /// `session_expired`, `session_required` or `session_conflict`.
    pub error: String,
}

impl ApiError {
    pub fn new(error: &str) -> Self {
        Self { error: error.to_string() }
    }
}

/// An unknown or expired session id.
pub const SESSION_EXPIRED: &str = "session_expired";
/// A route that needs a session got none.
pub const SESSION_REQUIRED: &str = "session_required";
/// `X-Racs-Session` and `?session=` name different sessions.
pub const SESSION_CONFLICT: &str = "session_conflict";
