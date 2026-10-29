//! Client sessions at `/sessions`.

use std::time::Instant;

use actix_web::{web, HttpResponse, Result};
use uuid::Uuid;

use crate::app_context::AppContext;
use crate::endpoints::session_mw::session_expired;
use crate::models::session::{
    ApiError, CreateSessionRequest, EndReason, RenameSessionRequest, SessionCreated, SessionInfo,
};

#[utoipa::path(
    post,
    path = "/sessions",
    tag = "sessions",
    description = "\
Starts a client session. Clients without one keep working as before (anonymously); a session gives \
a client an identity other clients see (`client_id`, `name`), makes it a member of the devices it \
uses, and lets it subscribe to `GET /events`.

Send `session_id` with every request, as the header `X-Racs-Session` or the query parameter \
`?session=` (WebSockets need the query parameter). It is a secret; `client_id` is public. Each \
request carrying it is a heartbeat, and so is `POST /sessions/{session_id}/heartbeat` and every \
pong or message on a WebSocket carrying it. A session without a heartbeat for `timeout_s` ends; \
send one every `heartbeat_interval_s`. The body is optional: `timeout_s` defaults to the server's \
`--session-timeout` and is clamped to 5..=600.",
    request_body(content = Option<CreateSessionRequest>, content_type = "application/json"),
    responses(
        (status = 201, description = "The session", body = SessionCreated)
    )
)]
#[actix_web::post("/sessions")]
pub async fn create_session(
    ctx: web::Data<AppContext>,
    body: Option<web::Json<CreateSessionRequest>>,
) -> Result<HttpResponse> {
    let request = body.map(web::Json::into_inner).unwrap_or_default();
    let session = ctx.clients.create(request.name, request.timeout_s, Instant::now());
    Ok(HttpResponse::Created().json(SessionCreated {
        session_id: session.id,
        client_id: session.client_id.clone(),
        name: session.name(),
        timeout_s: session.timeout_s(),
        heartbeat_interval_s: session.heartbeat_interval().as_secs(),
    }))
}

#[utoipa::path(
    post,
    path = "/sessions/{session_id}/heartbeat",
    tag = "sessions",
    description = "Keeps a session alive. `401` once it has ended: create a new one.",
    params(
        ("session_id" = Uuid, Path, description = "The secret session id")
    ),
    responses(
        (status = 204, description = "The session lives on"),
        (status = 401, description = "Unknown or expired session", body = ApiError)
    )
)]
#[actix_web::post("/sessions/{session_id}/heartbeat")]
pub async fn heartbeat(ctx: web::Data<AppContext>, session_id: web::Path<String>) -> Result<HttpResponse> {
    let alive = Uuid::parse_str(&session_id).is_ok_and(|id| ctx.clients.touch(&id, Instant::now()));
    Ok(if alive { HttpResponse::NoContent().finish() } else { session_expired() })
}

#[utoipa::path(
    patch,
    path = "/sessions/{session_id}",
    tag = "sessions",
    description = "\
Renames a session; it is a heartbeat too. Other clients see the new name from then on: the devices \
the session is a member of send `device_state` (`cause: access`). `401` once it has ended.",
    params(
        ("session_id" = Uuid, Path, description = "The secret session id")
    ),
    request_body(content = RenameSessionRequest, content_type = "application/json"),
    responses(
        (status = 204, description = "Renamed"),
        (status = 401, description = "Unknown or expired session", body = ApiError)
    )
)]
#[actix_web::patch("/sessions/{session_id}")]
pub async fn rename_session(
    ctx: web::Data<AppContext>,
    session_id: web::Path<String>,
    body: web::Json<RenameSessionRequest>,
) -> Result<HttpResponse> {
    let name = body.into_inner().name;
    let renamed = Uuid::parse_str(&session_id).is_ok_and(|id| ctx.clients.rename(&id, name, Instant::now()));
    Ok(if renamed { HttpResponse::NoContent().finish() } else { session_expired() })
}

#[utoipa::path(
    delete,
    path = "/sessions/{session_id}",
    tag = "sessions",
    description = "\
Ends a session now, as an expiry would: it leaves every device (which then closes after the idle \
timeout if nobody else uses it), its WebSockets are closed with `4001`, and `session_ended` is \
sent. Its burst jobs run to completion. `204` for an unknown session too.",
    params(
        ("session_id" = Uuid, Path, description = "The secret session id")
    ),
    responses(
        (status = 204, description = "The session has ended")
    )
)]
#[actix_web::delete("/sessions/{session_id}")]
pub async fn end_session(ctx: web::Data<AppContext>, session_id: web::Path<String>) -> Result<HttpResponse> {
    if let Ok(id) = Uuid::parse_str(&session_id) {
        ctx.clients.end(&id, EndReason::Closed, Instant::now());
    }
    Ok(HttpResponse::NoContent().finish())
}

#[utoipa::path(
    get,
    path = "/sessions",
    tag = "sessions",
    description = "The live sessions, oldest first, as other clients see them: never with a `session_id`.",
    responses(
        (status = 200, description = "Live sessions", body = Vec<SessionInfo>)
    )
)]
#[actix_web::get("/sessions")]
pub async fn list_sessions(ctx: web::Data<AppContext>) -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().json(ctx.clients.list()))
}
