//! How a failed request is rendered.
//!
//! A refusal by the device's access mode (`RcsError::Access`) is its JSON body with its status
//! (`400`, `403`, `409`, `423`). Every other error a handler gets from a controller is a `500` with a `text/plain` body of the error's
//! `Debug` form, behind a prefix that depends on the route (`Error: `, `Connect error: `, ... or
//! none on the stream endpoints). Clients match on these bodies — the client libraries detect a busy
//! camera by `Busy` in a 500, and their unit tests pin `Error: StoreError(Busy(0))` — so they stay
//! byte for byte what the handlers have always sent.

use actix_web::{HttpResponse, ResponseError};

use crate::rcs_erros::RcsError;

/// An access refusal as JSON, anything else as `500 text/plain` with `{prefix}{e:?}`.
pub fn respond(prefix: &str, e: &RcsError) -> HttpResponse {
    match e {
        RcsError::Access(refusal) => refusal.error_response(),
        _ => HttpResponse::InternalServerError().body(format!("{prefix}{e:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::camera_store::StoreError;
    use actix_web::body::to_bytes;

    #[actix_web::test]
    async fn the_body_is_the_prefix_and_the_debug_form() {
        let res = respond("Error: ", &RcsError::StoreError(StoreError::Busy(0)));
        assert_eq!(res.status(), 500);
        let body = to_bytes(res.into_body()).await.unwrap();
        assert_eq!(&body[..], b"Error: StoreError(Busy(0))");

        let res = respond("", &RcsError::StoreError(StoreError::NotFound(3)));
        let body = to_bytes(res.into_body()).await.unwrap();
        assert_eq!(&body[..], b"StoreError(NotFound(3))");
    }

    #[actix_web::test]
    async fn an_access_refusal_is_json_with_its_status() {
        use crate::models::access::{AccessError, Mode};
        let res = respond("Error: ", &RcsError::Access(AccessError::DeviceLocked { mode: Mode::Exclusive, owner: None }));
        assert_eq!(res.status(), 423);
        let body = to_bytes(res.into_body()).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json, serde_json::json!({"error": "device_locked", "mode": "exclusive", "owner": null}));
    }
}
