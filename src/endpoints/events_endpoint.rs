//! The events WebSocket at `/events`.
//!
//! Subscribes to the [`EventBus`](crate::events::EventBus) before it takes the `hello` snapshot,
//! so nothing between the two is lost; events the snapshot already includes (`seq` at or below
//! `hello`'s) are skipped. The socket is also its session's heartbeat: the server pings it every
//! `heartbeat_interval_s`, and every pong or message refreshes the session.

use std::sync::Arc;
use std::time::Instant;

use actix_web::{web, Error, HttpRequest, HttpResponse, Result};
use actix_ws::{CloseCode, CloseReason, Message};
use futures::StreamExt;
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, warn};

use crate::app_context::AppContext;
use crate::events::{Event, EventKind, HelloSession};
use crate::models::session::{ApiError, SESSION_REQUIRED};
use crate::stores::client_store::{Client, Session};

/// The close code of a socket whose session ended.
pub const SESSION_ENDED_CODE: u16 = 4001;
pub const SESSION_ENDED_REASON: &str = "session expired";

/// How a socket carrying `session` is closed when the session ends.
pub fn session_ended_close() -> CloseReason {
    CloseReason { code: CloseCode::Other(SESSION_ENDED_CODE), description: Some(SESSION_ENDED_REASON.to_string()) }
}

/// The interval a socket carrying `session` pings at, starting one interval from now.
pub fn ping_interval(session: &Session) -> tokio::time::Interval {
    let every = session.heartbeat_interval().max(std::time::Duration::from_millis(10));
    tokio::time::interval_at(tokio::time::Instant::now() + every, every)
}

#[utoipa::path(
    get,
    path = "/events",
    tag = "sessions",
    description = "\
A WebSocket of what happens on the server; requires a session (`?session=<session_id>`, since a \
browser can't set headers on a WebSocket). It is the session's heartbeat too: the server pings \
every `heartbeat_interval_s`, and every pong or message keeps the session alive.

Every message is JSON text with a global `seq`, an RFC 3339 `time` and a `type`:
- `hello` first: `session` (`client_id`, `timeout_s`) and `devices`, the state of every connected \
device. Its `seq` is the last event the snapshot includes.
- `device_state`: a device's complete state (`device`, `connected`, `access` = `{mode, owner, \
members}`, `stream` = `{viewers, pixel_format, bit_depth}` or null, `burst` = `{job_id, client_id}` \
or null), with `cause` (`connected`, `disconnected`, `access`, `stream`, `burst`), `reason` (for a \
disconnect: `request`, `idle`, `forced`, `error`) and `by`.
- `feature_changed` (`device`, `feature`, `by`): no value, since a write changes dependent features \
too; read again what you show. Includes writes made during a live stream and the \
GevSCPSPacketSize set by `POST /devices/{id}/stream/packet-size/auto`.
- `command_executed` (`device`, `command`, `by`).
- `session_ended` (`client_id`, `reason`: `expired` or `closed`).
- `resync`: this socket fell behind and lost events; read the state again.

`by` is `{client_id, name}`, or null for anonymous clients and the server itself. Clients use `seq` \
only to notice gaps. When the session ends the socket is closed with `4001` (`session expired`).",
    params(
        ("session" = String, Query, description = "The secret session id")
    ),
    responses(
        (status = 101, description = "WebSocket upgrade accepted; events follow", body = Event),
        (status = 400, description = "No session (`session_required`)", body = ApiError)
    )
)]
#[actix_web::get("/events")]
pub async fn events(
    req: HttpRequest,
    body: web::Payload,
    ctx: web::Data<AppContext>,
    client: Client,
) -> Result<HttpResponse, Error> {
    let Client::Session(session) = client else {
        return Ok(HttpResponse::BadRequest().json(ApiError::new(SESSION_REQUIRED)));
    };
    let (response, ws, incoming) = actix_ws::handle(&req, body)?;

    // Subscribe first, then snapshot: whatever happens in between is in the channel.
    let rx = ctx.events.subscribe();
    let (seq, devices) = ctx.clients.snapshot();
    let hello = Event::new(
        seq,
        EventKind::Hello {
            session: HelloSession { client_id: session.client_id.clone(), timeout_s: session.timeout_s() },
            devices,
        },
    );
    let ctx = ctx.into_inner();
    actix_web::rt::spawn(serve(ctx, session, hello, rx, ws, incoming));
    Ok(response)
}

async fn serve(
    ctx: Arc<AppContext>,
    session: Arc<Session>,
    hello: Event,
    mut rx: tokio::sync::broadcast::Receiver<Arc<Event>>,
    mut ws: actix_ws::Session,
    mut incoming: actix_ws::MessageStream,
) {
    let snapshot_seq = hello.seq;
    if send(&mut ws, &hello).await.is_err() {
        return;
    }
    let mut ping = ping_interval(&session);
    let mut ended = session.ended();
    let close = loop {
        tokio::select! {
            // Events before the end, so a session's own `session_ended` reaches it.
            biased;
            event = rx.recv() => match event {
                Ok(event) if event.seq <= snapshot_seq => {}
                Ok(event) => {
                    if send(&mut ws, &event).await.is_err() {
                        break None;
                    }
                }
                Err(RecvError::Lagged(lost)) => {
                    debug!("events socket of {} lost {lost} events", session.client_id);
                    if send(&mut ws, &Event::new(ctx.events.seq(), EventKind::Resync)).await.is_err() {
                        break None;
                    }
                }
                Err(RecvError::Closed) => break Some(CloseReason::from(CloseCode::Away)),
            },
            _ = ended.wait_for(Option::is_some) => break Some(session_ended_close()),
            msg = incoming.next() => match msg {
                Some(Ok(Message::Ping(bytes))) => {
                    ctx.clients.touch(&session.id, Instant::now());
                    if ws.pong(&bytes).await.is_err() {
                        break None;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break None,
                Some(Err(e)) => {
                    debug!("events socket of {}: protocol error => {e}", session.client_id);
                    break None;
                }
                // Pongs and anything else the client sends are heartbeats.
                Some(Ok(_)) => {
                    ctx.clients.touch(&session.id, Instant::now());
                }
            },
            _ = ping.tick() => {
                if ws.ping(b"").await.is_err() {
                    break None;
                }
            }
        }
    };
    let _ = ws.close(close).await;
}

async fn send(ws: &mut actix_ws::Session, event: &Event) -> Result<(), ()> {
    let json = serde_json::to_string(event).map_err(|e| warn!("could not serialise an event => {e}"))?;
    ws.text(json).await.map_err(|_| ())
}
