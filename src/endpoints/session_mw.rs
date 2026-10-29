//! Resolves the session a request carries, once, before any handler runs.
//!
//! The session travels as the header `X-Racs-Session` or the query parameter `?session=`
//! (WebSockets can only use the latter). A request carrying one counts as its heartbeat. The
//! handlers take the outcome as a [`Client`] extractor.

use std::time::Instant;

use actix_web::body::{EitherBody, MessageBody};
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::middleware::Next;
use actix_web::{web, Error, HttpMessage, HttpResponse};
use serde::Deserialize;
use uuid::Uuid;

use crate::app_context::AppContext;
use crate::models::session::{ApiError, SESSION_CONFLICT, SESSION_EXPIRED};
use crate::stores::client_store::Client;

/// The header a session id travels in.
pub const SESSION_HEADER: &str = "X-Racs-Session";

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
}

/// Put the request's [`Client`] into its extensions:
/// - no session: [`Client::Anonymous`], exactly the 0.3 behaviour
/// - an unknown or expired one: `401 {"error":"session_expired"}`
/// - header and query naming different sessions: `400 {"error":"session_conflict"}`
pub async fn resolve_session(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<EitherBody<impl MessageBody>>, Error> {
    let header = req
        .headers()
        .get(SESSION_HEADER)
        .map(|v| v.to_str().unwrap_or_default().trim().to_string());
    let query = web::Query::<SessionQuery>::from_query(req.query_string())
        .ok()
        .and_then(|q| q.into_inner().session);

    let id = match (header, query) {
        (Some(h), Some(q)) if h != q => {
            let response = HttpResponse::BadRequest().json(ApiError::new(SESSION_CONFLICT));
            return Ok(req.into_response(response).map_into_right_body());
        }
        (Some(id), _) | (None, Some(id)) => Some(id),
        (None, None) => None,
    };

    let client = match id {
        None => Client::Anonymous,
        Some(id) => {
            let session = req.app_data::<web::Data<AppContext>>().and_then(|ctx| {
                let id = Uuid::parse_str(&id).ok()?;
                ctx.clients.resolve(&id, Instant::now())
            });
            match session {
                Some(session) => Client::Session(session),
                None => return Ok(req.into_response(session_expired()).map_into_right_body()),
            }
        }
    };
    req.extensions_mut().insert(client);
    next.call(req).await.map(ServiceResponse::map_into_left_body)
}

/// `401 {"error":"session_expired"}`.
pub fn session_expired() -> HttpResponse {
    HttpResponse::Unauthorized().json(ApiError::new(SESSION_EXPIRED))
}
