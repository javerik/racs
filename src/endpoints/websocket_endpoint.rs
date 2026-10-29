//! The live-stream WebSocket.
//!
//! The camera side of this is the device's [`LiveHub`](crate::controller::live_hub::LiveHub): one
//! capture loop that keeps the camera checked out for as long as it has viewers (and runs
//! forwarded GenICam requests in between frames), fanned out to every socket. This module owns one
//! viewer's socket: forwarding what the hub hands it, noticing when the client leaves or loses
//! its access, and recording why a stream ended so `GET /devices/{id}/stream/error` can report it
//! afterwards.

use std::time::Instant;

use actix_web::{web, Error, HttpRequest, HttpResponse, Result};
use actix_ws::{CloseCode, CloseReason, Message};
use futures::StreamExt;
use tracing::{debug, warn};

use crate::app_context::AppContext;
use crate::controller::device_ctrl::{ACCESS_REVOKED, DEVICE_DISCONNECTED};
use crate::controller::stream_ctrl::LiveEnd;
use crate::endpoints::device_endpoint::{LOCKED, READ_ONLY};
use crate::endpoints::errors;
use crate::endpoints::events_endpoint::{ping_interval, session_ended_close};
use crate::stores::client_store::Client;
use crate::models::access::AccessError;
use crate::models::live_stream::LiveMsg;
use crate::models::pixel::PixelDepth;
use crate::models::queries::LiveStreamQuery;
use crate::rcs_erros::RcsError;

/// The close code of a live socket whose stream another session's forced lease took away.
const ACCESS_REVOKED_CODE: u16 = 4003;

#[utoipa::path(
    get,
    path = "/devices/{id}/stream/live",
    description = "\
Opens a WebSocket that streams frames continuously until the client disconnects. This is not an \
ordinary HTTP request: the response is a `101 Switching Protocols` upgrade, and clients must use a \
WebSocket implementation rather than a REST call.

The server sends one text message first, describing the stream:
`{\"width\":1280,\"height\":1024,\"format\":\"jpeg\",\"pixel_format\":\"Mono8\",\"bit_depth\":8,\"packet_size\":1500}`. \
Raw consumers need it, because the binary messages carry no dimensions. `packet_size` is the \
GevSCPSPacketSize the stream runs with. With `bit_depth` above 8, raw \
images are width*height little-endian u16s in the range `0..2^bit_depth`; JPEG images always hold \
the top 8 significant bits.

`zstd` images are the raw pixels, losslessly compressed (about half the size of raw on a camera \
image, at a few ms of server CPU per frame). Each is one zstd frame with its content size in the \
header. Decompressed, it holds a residual per pixel, row by row: the pixel minus the one above \
it (minus 0 in the first row), wrapping at the pixel width. At 8 bit that is width*height bytes. \
Above 8 bit each residual `d` (taken as i16) is zigzagged to `z = (d << 1) ^ (d >> 15)`, and the \
data is every low byte of `z` followed by every high byte. To decode, un-zigzag \
(`d = (z >> 1) ^ -(z & 1)`) and add the decoded pixel above, wrapping at 8 or 16 bits: a \
cumulative sum down each column.

Every message after that is binary: `[4 bytes frame_number (u32 LE)][4 bytes frames_dropped (u32 \
LE)][image data]`. Frame numbers start at 0 and count messages actually sent to this socket; the \
dropped counter is cumulative for the socket and never resets, covering incomplete frames, frames \
skipped by its fps limit, and frames dropped because this client could not keep up.

The text message is repeated whenever the geometry or the packet size changes mid-stream (a Width \
or GevSCPSPacketSize written while streaming, say): it describes every binary message after it, \
until the next one. Frame numbers and \
the dropped counter carry on across it.

Several clients can watch a device at once. The first socket starts the capture, later ones join \
it, and each has its own `format`, `quality`, `fps`, frame numbers and dropped counter; a slow \
client drops frames without slowing the others down. `pixel_depth` is decided by whoever started \
the capture: a socket asking for another depth gets the running one, announced in `bit_depth`. \
The capture stops when its last socket closes. The camera is held while it runs, so frame grabs \
and burst jobs for that device fail meanwhile. GenICam feature reads, writes and commands are carried \
out inside the running stream instead, between frames. Features the camera locks during \
acquisition (`pIsLocked` on `TLParamsLocked`, e.g. ExposureTime, AcquisitionFrameRate, Width) are \
written with acquisition paused for a moment, since a camera may otherwise store them but keep \
using the old value; the request answers once acquisition runs again. GevSCPSPacketSize and \
`POST /devices/{id}/stream/packet-size/auto` take the same pause, and the stream reopens its \
channel with the new size. A change that alters the payload size or pixel format also restarts \
acquisition, and so does a write the device refuses while acquiring. PixelFormat (set from \
`pixel_depth`), the stream destination (GevSCDA, GevSCPHostPort) and AcquisitionStart/Stop are \
refused while streaming. Every socket is closed on any \
acquisition error; ask `GET /devices/{id}/stream/error` for the reason. When the device is \
disconnected (`PUT /devices/{id}/disconnect`), the capture stops and every socket is closed with \
`1001` (going away) and the reason `device disconnected`.

A viewer that carries a session (`?session=`) is one of its heartbeats: the server pings it every \
`heartbeat_interval_s` and every pong or message keeps the session alive. When the session ends \
its socket is closed with `4001` (`session expired`); the capture runs on for the other sockets.

Starting a capture needs write permission on the device, joining a running one read permission. A refused request is answered with its status before the upgrade (browsers only see a failed connection, so the reason is also recorded for `GET /devices/{id}/stream/error`). When another session takes the device `exclusive` with `force`, the sockets of every other client are closed with `4003` (`access revoked`); the capture keeps running for that session's own sockets, if it has any.",
    params(
        ("id" = u32, Path, description = "The ID of the device to stream from"),
        ("format" = Option<String>, Query, description = "`jpeg` (default), `raw` (width*height pixels, 1 or 2 bytes each per `bit_depth`) or `zstd` (the raw pixels, losslessly compressed as described above)"),
        ("pixel_depth" = Option<PixelDepth>, Query, description = "`mono8` (default) or `mono16`: the deepest unpacked mono format the camera accepts (Mono16, 14, 12, then 10; Coord3D_C16 on a 3D camera in Linescan3D)"),
        ("quality" = Option<u8>, Query, description = "JPEG quality 1-100, default 80. Ignored for raw and zstd"),
        ("fps" = Option<f32>, Query, description = "Target frame rate. Omit to send every frame the camera delivers")
    ),
    tag = "stream",
    responses(
        (status = 101, description = "WebSocket upgrade accepted; frames follow on the socket"),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (
            status = 500,
            description = "The device could not be connected or the upgrade failed",
            body = String
        )
    )
)]
#[actix_web::get("/devices/{id}/stream/live")]
pub async fn stream_live(
    req: HttpRequest,
    body: web::Payload,
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    query_data: web::Query<LiveStreamQuery>,
) -> Result<HttpResponse, Error> {
    let id = id.into_inner();
    let opts = query_data.0.to_options();
    let adm = match ctx.stream_ctrl.admit_live(&client, id, Instant::now()) {
        Ok(adm) => adm,
        Err(e) => {
            // Recorded like a failed connect: the browser sees only a failed upgrade.
            ctx.stream_errors.record(id, format!("{:?}", e)).await;
            return Ok(errors::respond("", &e));
        }
    };

    if let Err(e) = ctx.dev_ctrl.connect(&adm).await {
        // Recorded as well as returned: a browser sees only "connection failed" for a rejected
        // upgrade, so the reason has to be fetchable afterwards.
        ctx.stream_errors.record(id, format!("{:?}", e)).await;
        return Ok(errors::respond("", &e));
    }

    // Before the upgrade, so a reader that would have to start a capture after all (the one it
    // was admitted to join has ended) is still refused with a status.
    let mut viewer = match ctx.stream_ctrl.join(&adm, opts) {
        Ok(viewer) => viewer,
        Err(e) => {
            ctx.stream_errors.record(id, format!("{:?}", e)).await;
            return Ok(errors::respond("", &e));
        }
    };

    // A failed upgrade drops the viewer, which leaves.
    let (response, mut session, mut msg_stream) = actix_ws::handle(&req, body)?;
    ctx.stream_errors.mark_active(id).await;

    let ctx = ctx.into_inner();
    actix_web::rt::spawn(async move {
        let mut messages = Box::pin(viewer.messages());
        let viewer_session = adm.client().session().cloned();

        // Only a viewer carrying a session is pinged and watches for the session's end, so an
        // anonymous one behaves exactly as before sessions existed.
        let mut ping = viewer_session.as_ref().map(|s| ping_interval(s));
        let mut ended = viewer_session.as_ref().map(|s| s.ended());
        let heartbeat = || {
            if let Some(s) = &viewer_session {
                ctx.clients.touch(&s.id, Instant::now());
            }
        };

        let outcome = loop {
            tokio::select! {
                // The viewer's session ended: it leaves, and the socket says why.
                _ = async { ended.as_mut().unwrap().wait_for(Option::is_some).await }, if ended.is_some() => {
                    break Outcome::SessionEnded;
                }
                // Another session took the device `exclusive` with `force`.
                () = viewer.revoked() => break Outcome::Revoked,
                _ = async { ping.as_mut().unwrap().tick().await }, if ping.is_some() => {
                    if session.ping(b"").await.is_err() {
                        break Outcome::ClientLeft;
                    }
                }
                msg = messages.next() => {
                    let sent = match msg {
                        // The capture ended (or never started): its end says why.
                        None => break Outcome::CaptureEnded,
                        // This viewer's encoding failed; the others carry on.
                        Some(Err(e)) => break Outcome::Failed(format!("{:?}", RcsError::from(e))),
                        Some(Ok(LiveMsg::Info(info))) => match serde_json::to_string(&info) {
                            Ok(json) => session.text(json).await,
                            Err(e) => break Outcome::Failed(format!("could not serialise stream info => {e}")),
                        },
                        Some(Ok(LiveMsg::Frame { frame_number, dropped, payload })) => {
                            session.binary(LiveMsg::frame_bytes(frame_number, dropped, &payload)).await
                        }
                    };
                    if sent.is_err() {
                        debug!("live stream {id}: session closed while sending");
                        break Outcome::ClientLeft;
                    }
                }
                incoming = msg_stream.next() => {
                    match incoming {
                        Some(Ok(Message::Ping(bytes))) => {
                            heartbeat();
                            if session.pong(&bytes).await.is_err() {
                                break Outcome::ClientLeft;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break Outcome::ClientLeft,
                        Some(Err(e)) => {
                            debug!("live stream {id}: protocol error => {e}");
                            break Outcome::ClientLeft;
                        }
                        // Nothing the client sends drives the stream; parameters are query-only.
                        // But pongs and messages are its session's heartbeats.
                        Some(Ok(_)) => heartbeat(),
                    }
                }
            }
        };

        let close_reason = match outcome {
            Outcome::ClientLeft => CloseReason::from(CloseCode::Normal),
            Outcome::SessionEnded => session_ended_close(),
            Outcome::Revoked => {
                debug!("live viewer of {id} ended: access revoked");
                access_revoked_close()
            }
            Outcome::Failed(msg) => {
                warn!("live stream {id} failed => {msg}");
                ctx.stream_errors.record(id, msg.clone()).await;
                CloseReason { code: CloseCode::Error, description: Some(msg) }
            }
            Outcome::CaptureEnded => match viewer.end().await {
                // The device was closed under the stream. Not an error, so nothing is recorded.
                Ok(LiveEnd::DeviceClosed(closed)) => {
                    debug!("live stream {id} ended: the device was closed ({closed:?})");
                    CloseReason { code: CloseCode::Away, description: Some(DEVICE_DISCONNECTED.to_string()) }
                }
                // Another session forced an exclusive lease, and no viewer of its own was left.
                Ok(LiveEnd::Revoked) => {
                    debug!("live stream {id} ended: access revoked");
                    access_revoked_close()
                }
                // The capture ended on its own without an error: the camera stopped delivering.
                Ok(LiveEnd::Stopped) => CloseReason::from(CloseCode::Away),
                // Recorded once, by the capture.
                Err(msg) => CloseReason { code: CloseCode::Error, description: Some(msg) },
            },
        };
        // Leaving: the last viewer stops the capture, which hands the camera back.
        drop(messages);
        drop(viewer);
        ctx.stream_errors.mark_inactive(id).await;
        let _ = session.close(Some(close_reason)).await;
    });

    Ok(response)
}

/// Why a viewer's loop ended.
enum Outcome {
    ClientLeft,
    SessionEnded,
    Revoked,
    /// The capture ended; [`Viewer::end`](crate::controller::live_hub::Viewer::end) says how.
    CaptureEnded,
    /// This viewer failed, with the message its socket closes with.
    Failed(String),
}

fn access_revoked_close() -> CloseReason {
    CloseReason { code: CloseCode::Other(ACCESS_REVOKED_CODE), description: Some(ACCESS_REVOKED.to_string()) }
}
