//! Access modes, leases and force (phase 3 of `specs/multi-user.md`), through the real router
//! against the in-process fake camera.

use std::time::Duration;

#[macro_use]
mod common;
use common::*;

use actix_web::test;
use aravis_port_fakecamera::FakeCameraConfig;
use awc::ws;
use futures::SinkExt;
use rust_cam_serve::server_config::RuntimeConfig;
use serde_json::{json, Value};

const SESSION: &str = "X-Racs-Session";

/// `(status, JSON body)` of a request on an in-process service, sent with session `$session`
/// (`None` for an anonymous one).
macro_rules! call_as {
    ($app:expr, $session:expr, $req:expr) => {{
        let mut req = $req;
        if let Some(id) = $session {
            req = req.insert_header((SESSION, id));
        }
        let resp = test::call_service(&$app, req.to_request()).await;
        let status = resp.status().as_u16();
        let json_body = resp.headers().get("content-type").is_some_and(|c| c == "application/json");
        let body = test::read_body(resp).await;
        let body: Value = if json_body { serde_json::from_slice(&body).unwrap() } else { Value::Null };
        (status, body)
    }};
}

fn put_access(mode: &str, force: bool) -> test::TestRequest {
    test::TestRequest::put().uri("/api/v1/devices/0/access").set_json(json!({"mode": mode, "force": force}))
}

#[actix_web::test]
async fn every_refusal_has_its_status_and_json_body() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let a = session!(app);
    let b = session!(app);
    let anon: Option<&str> = None;
    let feature = "/api/v1/devices/0/gc/feature/Width";

    // Lease routes need a session.
    let (status, body) = call_as!(app, anon, put_access("exclusive", false));
    assert_eq!((status, body), (400, json!({"error": "session_required"})));
    let (status, body) =
        call_as!(app, anon, test::TestRequest::put().uri("/api/v1/devices/0/connect?mode=exclusive"));
    assert_eq!((status, body), (400, json!({"error": "session_required"})));
    let (status, _) = call_as!(app, anon, test::TestRequest::delete().uri("/api/v1/devices/0/access"));
    assert_eq!(status, 400);

    // a takes ro-shared.
    let (status, access) = call_as!(app, Some(a.as_str()), put_access("ro-shared", false));
    assert_eq!(status, 200, "{access}");
    assert_eq!(access["mode"], "ro-shared");
    assert_eq!(access["you"], "owner");
    assert_eq!(access["device"], 0);
    let owner = access["owner"].clone();
    assert!(owner["client_id"].is_string(), "{access}");

    // Another session reads but doesn't write: 403.
    let (status, _) = call_as!(app, Some(b.as_str()), test::TestRequest::get().uri(feature));
    assert_eq!(status, 200);
    let (status, body) = call_as!(app, Some(b.as_str()), test::TestRequest::put().uri(&format!("{feature}?value=64")));
    assert_eq!((status, body), (403, json!({"error": "read_only", "mode": "ro-shared", "owner": owner})));

    // Anonymous gets meta routes only: 423.
    let (status, body) = call_as!(app, anon, test::TestRequest::get().uri(feature));
    assert_eq!((status, body), (423, json!({"error": "device_locked", "mode": "ro-shared", "owner": owner})));
    let (status, _) = call_as!(app, anon, test::TestRequest::get().uri("/api/v1/devices/0/gc/categories"));
    assert_eq!(status, 200, "a meta route");
    let (status, access) = call_as!(app, anon, test::TestRequest::get().uri("/api/v1/devices/0/access"));
    assert_eq!((status, access["you"].clone()), (200, json!("meta")));
    let (status, _) =
        call_as!(app, anon, test::TestRequest::get().uri("/api/v1/devices/0/grab/jobs/00000000-0000-0000-0000-000000000000"));
    assert_eq!(status, 423, "burst-job reads are reads");
    let (status, _) = call_as!(app, anon, test::TestRequest::put().uri("/api/v1/devices/0/disconnect?force=true"));
    assert_eq!(status, 423, "a forced disconnect is a write");

    // Taking a lease someone else owns: 423; breaking it needs force.
    let (status, body) = call_as!(app, Some(b.as_str()), put_access("exclusive", false));
    assert_eq!((status, body), (423, json!({"error": "device_locked", "mode": "ro-shared", "owner": owner})));
    let (status, _) = call_as!(app, Some(b.as_str()), test::TestRequest::delete().uri("/api/v1/devices/0/access"));
    assert_eq!(status, 423);

    // Exclusive while b is a member: 409, naming it.
    let (status, body) = call_as!(app, Some(a.as_str()), put_access("exclusive", false));
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "device_in_use");
    assert_eq!(body["mode"], "ro-shared");
    assert_eq!(body["members"].as_array().unwrap().len(), 1);
    assert_eq!(body["holder"], Value::Null);

    // Exclusive by force: b is out, and gets 423 for a read.
    let (status, access) = call_as!(app, Some(a.as_str()), put_access("exclusive", true));
    assert_eq!(status, 200);
    assert_eq!(access["members"], json!([owner]));
    let (status, body) = call_as!(app, Some(b.as_str()), test::TestRequest::get().uri(feature));
    assert_eq!((status, body["error"].clone()), (423, json!("device_locked")));

    // Released: shared again, and everyone writes.
    let (status, access) = call_as!(app, Some(a.as_str()), test::TestRequest::delete().uri("/api/v1/devices/0/access"));
    assert_eq!((status, access["mode"].clone(), access["owner"].clone()), (200, json!("shared"), Value::Null));
    let (status, _) = call_as!(app, anon, test::TestRequest::put().uri(&format!("{feature}?value=64")));
    assert_eq!(status, 200);
}

#[actix_web::test]
async fn connect_with_a_mode_is_atomic_against_a_concurrent_connect() {
    let (_cam, _ctx, srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let mut outcomes = std::collections::HashSet::new();
    for round in 0..8 {
        // Start from a closed device, so both requests race to open it.
        let resp = srv.put("/api/v1/devices/0/disconnect").send().await.unwrap();
        assert_eq!(resp.status(), 200);
        let (a, a_client) = open_session(&srv, "a").await;
        let (b, b_client) = open_session(&srv, "b").await;

        let ((a_status, a_body), (b_status, b_body)) = tokio::join!(
            async { send_as!(srv.put("/api/v1/devices/0/connect?mode=exclusive"), a.as_str()) },
            async { send_as!(srv.put("/api/v1/devices/0/connect"), b.as_str()) },
        );
        assert_eq!(b_status, 200, "round {round}: a plain connect only joins: {b_body}");
        let access: Value = srv.get("/api/v1/devices/0/access").send().await.unwrap().json().await.unwrap();
        let members: Vec<&str> =
            access["members"].as_array().unwrap().iter().map(|m| m["client_id"].as_str().unwrap()).collect();
        match a_status {
            // The lease came first: b was let in as meta only, and isn't a member.
            200 => {
                assert_eq!(access["mode"], "exclusive", "round {round}: {access}");
                assert_eq!(members, vec![a_client.as_str()], "round {round}");
                assert_eq!(b_body["you"], "meta", "round {round}: {b_body}");
                outcomes.insert("lease first");
            }
            // b joined first: going exclusive needs force.
            409 => {
                assert_eq!(a_body["error"], "device_in_use");
                assert_eq!(access["mode"], "shared", "round {round}: {access}");
                assert!(members.contains(&b_client.as_str()), "round {round}: {access}");
                outcomes.insert("member first");
            }
            other => panic!("round {round}: connect?mode=exclusive answered {other}: {a_body}"),
        }

        for id in [&a, &b] {
            assert_eq!(srv.delete(format!("/api/v1/sessions/{id}")).send().await.unwrap().status(), 204);
        }
    }
    eprintln!("outcomes seen: {outcomes:?}");
}

#[actix_web::test]
async fn ro_shared_readers_read_and_are_admitted_to_a_running_stream_but_cannot_write() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, _) = open_session(&srv, "owner").await;
    let (b, _) = open_session(&srv, "reader").await;
    let (status, _) = send_as!(srv.put("/api/v1/devices/0/connect?mode=ro-shared"), a.as_str());
    assert_eq!(status, 200);

    // Starting a capture is a write: refused before the upgrade, and recorded.
    let refused = srv.ws_at(&format!("/api/v1/devices/0/stream/live?session={b}")).await;
    assert!(
        matches!(refused, Err(awc::error::WsClientError::InvalidResponseStatus(s)) if s == 403),
        "{:?}",
        refused.err()
    );
    let error: Value = srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
    assert!(error["last_error"].as_str().unwrap().contains("ReadOnly"), "{error}");
    let refused = srv.ws_at("/api/v1/devices/0/stream/live").await;
    assert!(matches!(refused, Err(awc::error::WsClientError::InvalidResponseStatus(s)) if s == 423));

    // The owner streams.
    let mut owner = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={a}")).await.unwrap();
    assert!(matches!(next_frame!(owner), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(owner), ws::Frame::Binary(_)));

    // The reader reads (inside the stream) and can't write.
    let (status, _) = send_as!(srv.get("/api/v1/devices/0/gc/feature/Width"), b.as_str());
    assert_eq!(status, 200);
    let (status, body) = send_as!(srv.put("/api/v1/devices/0/gc/feature/Width?value=64"), b.as_str());
    assert_eq!((status, body["error"].clone()), (403, json!("read_only")));
    let (status, access) = send_as!(srv.get("/api/v1/devices/0/access"), b.as_str());
    assert_eq!(status, 200);
    assert_eq!(access["you"], "reader");
    assert_eq!(access["holder"]["kind"], "live");
    assert_eq!(access["viewers"], 1);

    // Joining the running capture is a read, so the reader watches it too.
    let mut joining = srv.ws_at(&format!("/api/v1/devices/0/stream/live?session={b}")).await.unwrap();
    assert!(matches!(next_frame!(joining), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(joining), ws::Frame::Binary(_)));
    let (_, access) = send_as!(srv.get("/api/v1/devices/0/access"), b.as_str());
    assert_eq!(access["viewers"], 2);

    joining.send(ws::Message::Close(None)).await.unwrap();
    owner.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn forcing_exclusive_closes_another_clients_stream_with_4003() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, _) = open_session(&srv, "taker").await;
    let (b, b_client) = open_session(&srv, "viewer").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let mut viewer = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={b}")).await.unwrap();
    assert!(matches!(next_frame!(viewer), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(viewer), ws::Frame::Binary(_)));

    let (status, body) = send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive"}));
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["holder"], json!({"kind": "live", "client_id": b_client}));

    let (status, access) =
        send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive", "force": true}));
    assert_eq!(status, 200, "{access}");
    assert_eq!(access["mode"], "exclusive");

    let close = close_of!(viewer);
    assert_eq!(close.code, ws::CloseCode::Other(4003));
    assert_eq!(close.description.as_deref(), Some("access revoked"));
    let revoked = await_event!(events, |e| e["type"] == "access_revoked");
    assert_eq!(revoked["device"], 0);
    assert_eq!(revoked["client_id"], b_client.as_str());
    assert_eq!(revoked["by"]["name"], "taker");

    // The camera is the owner's now, without a busy refusal.
    let mut owner = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={a}")).await.unwrap();
    assert!(matches!(next_frame!(owner), ws::Frame::Text(_)), "the camera was released");
    owner.send(ws::Message::Close(None)).await.unwrap();
    // A revocation isn't a stream error.
    let error: Value = srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
    assert_eq!(error["last_error"], Value::Null, "{error}");
}

#[actix_web::test]
async fn forcing_exclusive_cancels_another_clients_burst() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, _) = open_session(&srv, "taker").await;
    let (b, b_client) = open_session(&srv, "burster").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={a}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    // Long enough to still be running when the lease is forced.
    let (status, job) =
        send_as!(srv.post("/api/v1/devices/0/grab/jobs"), b.as_str(), json!({"count": 500, "format": "raw"}));
    assert_eq!(status, 202);
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{}", job["job_id"].as_str().unwrap());
    await_event!(events, |e| e["type"] == "device_state" && e["burst"].is_object());

    let (status, body) = send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive"}));
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["holder"], json!({"kind": "burst", "client_id": b_client}));
    let (status, _) =
        send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive", "force": true}));
    assert_eq!(status, 200);
    let revoked = await_event!(events, |e| e["type"] == "access_revoked");
    assert_eq!(revoked["client_id"], b_client.as_str());

    // The job keeps its record, cancelled. It's the owner who may read it now.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let info = loop {
        let (status, info) = send_as!(srv.get(&job_uri), a.as_str());
        assert_eq!(status, 200);
        if info["status"] != "running" {
            break info;
        }
        assert!(std::time::Instant::now() < deadline, "the burst was never cancelled: {info}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(info["status"], "cancelled", "{info}");
    assert_eq!(info["error"], "access revoked");
    let (status, _) = send_as!(srv.get(&job_uri), b.as_str());
    assert_eq!(status, 423, "the burst's starter is locked out");

    // The owner can grab right away.
    let (status, _) = send_as!(srv.get("/api/v1/devices/0/stream/frame/raw"), a.as_str());
    assert_eq!(status, 200);
}

#[actix_web::test]
async fn the_owners_session_expiring_returns_the_device_to_shared() {
    let runtime = fast_runtime(Duration::from_millis(300), None);
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), runtime).await;
    let (a, a_client) = open_session(&srv, "owner").await;
    let (b, _) = open_session(&srv, "watcher").await;
    // b's events socket is its heartbeat; a sends none after this.
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let (status, _) = send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive"}));
    assert_eq!(status, 200);
    let taken = await_event!(events, |e| e["type"] == "device_state" && e["access"]["mode"] == "exclusive");
    assert_eq!(taken["cause"], "access");
    assert_eq!(taken["access"]["owner"]["client_id"], a_client.as_str());

    let released = await_event!(events, |e| e["type"] == "device_state" && e["access"]["mode"] == "shared");
    assert_eq!(released["cause"], "access");
    assert_eq!(released["access"]["owner"], Value::Null);
    let ended = await_event!(events, |e| e["type"] == "session_ended");
    assert_eq!(ended["client_id"], a_client.as_str());

    let (status, access) = send_as!(srv.get("/api/v1/devices/0/access"), b.as_str());
    assert_eq!((status, access["mode"].clone()), (200, json!("shared")));
}
