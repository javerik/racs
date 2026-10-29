//! Who may do what on a device: the access mode, a client's role in it, what a route needs, and
//! the refusals (phase 3 of `specs/multi-user.md`).
//!
//! | mode        | owner        | other sessions | anonymous    |
//! |-------------|--------------|----------------|--------------|
//! | `shared`    | –            | read + write   | read + write |
//! | `ro-shared` | read + write | read           | meta         |
//! | `exclusive` | read + write | meta           | meta         |

use std::fmt;

use actix_web::http::StatusCode;
use actix_web::{HttpResponse, ResponseError};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::models::session::ClientRef;

/// A device's access mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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

/// A client's role on a device, following from the mode and the lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Holds the device's lease.
    Owner,
    /// May read and write (everyone on a `shared` device).
    Writer,
    /// May read.
    Reader,
    /// May only use the meta routes.
    Meta,
}

/// What a route needs. Ordered: a write needs more than a read, a read more than meta.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Perm {
    /// The GenICam XML and categories, the stream error, the access state.
    Meta,
    /// Feature reads, the packet size, joining a running live capture, burst-job reads.
    Read,
    /// Feature writes and commands, grabs, starting a capture or burst, cancelling a burst, a
    /// forced disconnect.
    Write,
}

impl Role {
    /// The role of a client in a device in `mode`: whether it owns the lease, and whether it has a
    /// session at all.
    pub fn of(mode: Mode, is_owner: bool, has_session: bool) -> Role {
        match mode {
            Mode::Shared => Role::Writer,
            _ if is_owner => Role::Owner,
            Mode::RoShared if has_session => Role::Reader,
            Mode::RoShared | Mode::Exclusive => Role::Meta,
        }
    }

    pub fn allows(self, perm: Perm) -> bool {
        match self {
            Role::Owner | Role::Writer => true,
            Role::Reader => perm <= Perm::Read,
            Role::Meta => perm == Perm::Meta,
        }
    }
}

/// Whether `role` may do what `perm` asks on a device in `mode` owned by `owner`.
pub fn check(mode: Mode, role: Role, perm: Perm, owner: Option<&ClientRef>) -> Result<(), AccessError> {
    if role.allows(perm) {
        return Ok(());
    }
    let owner = owner.cloned();
    Err(match role {
        Role::Reader => AccessError::ReadOnly { mode, owner },
        _ => AccessError::DeviceLocked { mode, owner },
    })
}

/// A refused request. Rendered as `application/json`, `{"error": …}` plus context.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum AccessError {
    /// `400`: a lease route without a session.
    SessionRequired,
    /// `403`: a write on a `ro-shared` device by a session that doesn't own it.
    ReadOnly { mode: Mode, owner: Option<ClientRef> },
    /// `409`: changing to `exclusive` while other sessions are members or other clients hold the
    /// camera, without `force`.
    DeviceInUse {
        mode: Mode,
        owner: Option<ClientRef>,
        /// The other member sessions.
        members: Vec<ClientRef>,
        /// Another client's live capture or burst.
        holder: Option<HolderRef>,
    },
    /// `423`: above meta on an `exclusive` device (or anonymous on `ro-shared`), or taking a
    /// lease another session owns, without `force`.
    DeviceLocked { mode: Mode, owner: Option<ClientRef> },
}

impl AccessError {
    pub fn status(&self) -> StatusCode {
        match self {
            AccessError::SessionRequired => StatusCode::BAD_REQUEST,
            AccessError::ReadOnly { .. } => StatusCode::FORBIDDEN,
            AccessError::DeviceInUse { .. } => StatusCode::CONFLICT,
            AccessError::DeviceLocked { .. } => StatusCode::LOCKED,
        }
    }
}

impl fmt::Display for AccessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AccessError::SessionRequired => write!(f, "a session is required"),
            AccessError::ReadOnly { .. } => write!(f, "the device is read-only for this client"),
            AccessError::DeviceInUse { .. } => write!(f, "the device is in use by other clients"),
            AccessError::DeviceLocked { .. } => write!(f, "the device is locked by another client"),
        }
    }
}

impl ResponseError for AccessError {
    fn status_code(&self) -> StatusCode {
        self.status()
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status()).json(self)
    }
}

/// What holds a device's camera for a long time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum HolderKind {
    Live,
    Burst,
}

/// The holder of a device, as others see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct HolderRef {
    pub kind: HolderKind,
    /// The session that started it; `null` for an anonymous client.
    pub client_id: Option<String>,
}

/// `GET /devices/{id}/access`: who may use the device and who does, and what the asking client
/// may do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DeviceAccess {
    pub device: u32,
    pub mode: Mode,
    /// The session holding the lease; `null` on a `shared` device.
    pub owner: Option<ClientRef>,
    /// The sessions that connected to or used the device, in the order they joined.
    pub members: Vec<ClientRef>,
    /// The running live capture or burst, or `null`.
    pub holder: Option<HolderRef>,
    /// Open live-stream sockets.
    pub viewers: u32,
    /// The asking client's role.
    pub you: Role,
}

/// `PUT /devices/{id}/access`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetAccessRequest {
    pub mode: Mode,
    /// Take the lease from another session, or evict other clients for `exclusive`.
    #[serde(default)]
    pub force: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_follow_the_mode_and_the_lease() {
        use Mode::*;
        use Role::*;
        // (mode, owner, session) -> role
        let table = [
            (Shared, false, false, Writer),
            (Shared, false, true, Writer),
            (RoShared, true, true, Owner),
            (RoShared, false, true, Reader),
            (RoShared, false, false, Meta),
            (Exclusive, true, true, Owner),
            (Exclusive, false, true, Meta),
            (Exclusive, false, false, Meta),
        ];
        for (mode, owner, session, role) in table {
            assert_eq!(Role::of(mode, owner, session), role, "{mode:?} owner={owner} session={session}");
        }
    }

    #[test]
    fn the_permission_matrix() {
        use Perm::*;
        // (mode, owner, session) -> what meta, read, write give: None = allowed, else the status.
        let table: [(Mode, bool, bool, [Option<u16>; 3]); 7] = [
            (Mode::Shared, false, false, [None, None, None]),
            (Mode::Shared, false, true, [None, None, None]),
            (Mode::RoShared, true, true, [None, None, None]),
            (Mode::RoShared, false, true, [None, None, Some(403)]),
            (Mode::RoShared, false, false, [None, Some(423), Some(423)]),
            (Mode::Exclusive, true, true, [None, None, None]),
            (Mode::Exclusive, false, true, [None, Some(423), Some(423)]),
        ];
        for (mode, owner, session, expected) in table {
            let role = Role::of(mode, owner, session);
            for (perm, want) in [Meta, Read, Write].into_iter().zip(expected) {
                let got = check(mode, role, perm, None).err().map(|e| e.status().as_u16());
                assert_eq!(got, want, "{mode:?} {role:?} {perm:?}");
            }
        }
        // Anonymous on exclusive, too.
        assert_eq!(
            check(Mode::Exclusive, Role::of(Mode::Exclusive, false, false), Read, None).unwrap_err().status(),
            StatusCode::LOCKED
        );
    }

    #[test]
    fn refusals_serialise_with_their_error_code() {
        let owner = ClientRef { client_id: "3f2a9c1e".into(), name: Some("webapp".into()) };
        let json = |e: &AccessError| serde_json::to_value(e).unwrap();

        assert_eq!(json(&AccessError::SessionRequired), serde_json::json!({"error": "session_required"}));
        assert_eq!(
            json(&AccessError::ReadOnly { mode: Mode::RoShared, owner: Some(owner.clone()) }),
            serde_json::json!({"error": "read_only", "mode": "ro-shared",
                               "owner": {"client_id": "3f2a9c1e", "name": "webapp"}})
        );
        assert_eq!(
            json(&AccessError::DeviceLocked { mode: Mode::Exclusive, owner: None }),
            serde_json::json!({"error": "device_locked", "mode": "exclusive", "owner": null})
        );
        let in_use = AccessError::DeviceInUse {
            mode: Mode::Shared,
            owner: None,
            members: vec![owner],
            holder: Some(HolderRef { kind: HolderKind::Live, client_id: None }),
        };
        assert_eq!(in_use.status(), StatusCode::CONFLICT);
        let body = json(&in_use);
        assert_eq!(body["error"], "device_in_use");
        assert_eq!(body["members"][0]["client_id"], "3f2a9c1e");
        assert_eq!(body["holder"], serde_json::json!({"kind": "live", "client_id": null}));
    }
}
