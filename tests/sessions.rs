//! Client sessions, device membership and the idle auto-disconnect, through the real router
//! against the in-process fake camera. Timeouts run in milliseconds (`fast_runtime`).

use std::time::{Duration, Instant};

#[macro_use]
mod common;
use common::*;

use actix_web::test;
use aravis_port_fakecamera::FakeCameraConfig;
use awc::ws;
use futures::SinkExt;
use rust_cam_serve::server_config::RuntimeConfig;
use serde_json::{json, Value};

/// `(status, JSON body)` of a request on an in-process service.
macro_rules! call_json {
    ($app:expr, $req:expr) => {{
        let resp = test::call_service(&$app, $req.to_request()).await;
        let status = resp.status().as_u16();
        let body = test::read_body(resp).await;
        let json: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap() };
        (status, json)
    }};
}

/// Number of connected devices.
macro_rules! connected {
    ($app:expr) => {{
        let (status, body) = call_json!($app, test::TestRequest::get().uri("/api/v1/devices/connected"));
        assert_eq!(status, 200);
        body.as_array().unwrap().len()
    }};
}

#[actix_web::test]
async fn the_session_lifecycle() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let (status, created) = call_json!(
        app,
        test::TestRequest::post().uri("/api/v1/sessions").set_json(json!({"name": "line-script", "timeout_s": 60}))
    );
    assert_eq!(status, 201);
    assert_eq!(created["name"], "line-script");
    assert_eq!(created["timeout_s"], 60);
    assert_eq!(created["heartbeat_interval_s"], 20);
    let id = created["session_id"].as_str().unwrap();
    let heartbeat = format!("/api/v1/sessions/{id}/heartbeat");

    let resp = test::call_service(&app, test::TestRequest::post().uri(&heartbeat).to_request()).await;
    assert_eq!(resp.status(), 204);

    let (_, list) = call_json!(app, test::TestRequest::get().uri("/api/v1/sessions"));
    assert_eq!(list[0]["client_id"], created["client_id"]);
    assert!(!list.to_string().contains(id), "the secret id is never listed");

    let resp = test::call_service(&app, test::TestRequest::delete().uri(&format!("/api/v1/sessions/{id}")).to_request()).await;
    assert_eq!(resp.status(), 204);

    // Gone: its heartbeat and every request carrying it are refused, with the documented body.
    let resp = test::call_service(&app, test::TestRequest::post().uri(&heartbeat).to_request()).await;
    assert_eq!(resp.status(), 401);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    assert_eq!(test::read_body_json::<Value, _>(resp).await, json!({"error": "session_expired"}));
    let (status, body) = call_json!(
        app,
        test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/Width").insert_header(("X-Racs-Session", id))
    );
    assert_eq!((status, body), (401, json!({"error": "session_expired"})));

    // Ending an unknown session is not an error.
    let resp = test::call_service(&app, test::TestRequest::delete().uri(&format!("/api/v1/sessions/{id}")).to_request()).await;
    assert_eq!(resp.status(), 204);
    let resp =
        test::call_service(&app, test::TestRequest::post().uri("/api/v1/sessions/not-a-uuid/heartbeat").to_request()).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
async fn the_session_travels_as_header_or_query() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let id = session!(app);
    let other = session!(app);
    let uri = "/api/v1/devices/0/gc/feature/Width";

    let (status, _) = call_json!(app, test::TestRequest::get().uri(uri).insert_header(("X-Racs-Session", id.as_str())));
    assert_eq!(status, 200);
    let (status, _) = call_json!(app, test::TestRequest::get().uri(&format!("{uri}?session={id}")));
    assert_eq!(status, 200);
    let (status, _) = call_json!(
        app,
        test::TestRequest::get().uri(&format!("{uri}?session={id}")).insert_header(("X-Racs-Session", id.as_str()))
    );
    assert_eq!(status, 200, "both, naming the same session");

    let (status, body) = call_json!(
        app,
        test::TestRequest::get().uri(&format!("{uri}?session={other}")).insert_header(("X-Racs-Session", id.as_str()))
    );
    assert_eq!((status, body), (400, json!({"error": "session_conflict"})));

    let (status, body) = call_json!(app, test::TestRequest::get().uri(&format!("{uri}?session=garbage")));
    assert_eq!((status, body), (401, json!({"error": "session_expired"})));

    // Other query parameters still reach the handler.
    let (status, _) = call_json!(
        app,
        test::TestRequest::put().uri(&format!("/api/v1/devices/0/gc/feature/Width?value=32&session={id}"))
    );
    assert_eq!(status, 200);
    let (_, list) = call_json!(app, test::TestRequest::get().uri("/api/v1/sessions"));
    let devices: Vec<&Value> = list.as_array().unwrap().iter().map(|s| &s["devices"]).collect();
    assert!(devices.contains(&&json!([0])), "using the device made the session a member: {list}");
}

#[actix_web::test]
async fn the_events_socket_keeps_its_session_alive() {
    let (_cam, _ctx, mut srv) =
        live_server_with_runtime(FakeCameraConfig::default(), fast_runtime(Duration::from_millis(300), None)).await;
    let (kept, _) = open_session(&srv, "kept").await;
    let (lapsed, _) = open_session(&srv, "lapsed").await;

    let mut framed = srv.ws_at(&format!("/api/v1/events?session={kept}")).await.unwrap();
    assert_eq!(next_event!(framed)["type"], "hello");
    // Answer the pings for well past the timeout; `lapsed` sends nothing meanwhile.
    let until = Instant::now() + Duration::from_millis(1000);
    let mut ended = Vec::new();
    while Instant::now() < until {
        let event = tokio::time::timeout(until - Instant::now(), async { next_event!(framed) }).await;
        if let Ok(event) = event {
            if event["type"] == "session_ended" {
                ended.push(event["reason"].clone());
            }
        }
    }
    assert_eq!(ended, vec![json!("expired")], "only the silent session expired");

    let heartbeat = |id: &str| srv.post(format!("/api/v1/sessions/{id}/heartbeat")).send();
    assert_eq!(heartbeat(&kept).await.unwrap().status(), 204);
    assert_eq!(heartbeat(&lapsed).await.unwrap().status(), 401);
    framed.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn an_unused_device_is_closed_after_the_idle_timeout() {
    let idle = Duration::from_millis(200);
    let start = Instant::now();
    let (_cam, ctx) =
        app_context_with_runtime(FakeCameraConfig::default(), fast_runtime(Duration::from_secs(30), Some(idle))).await;
    let app = service!(ctx);
    assert_eq!(connected!(app), 1);
    let deadline = Instant::now() + Duration::from_secs(5);
    while connected!(app) == 1 {
        assert!(Instant::now() < deadline, "the idle device was never closed");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(start.elapsed() >= idle, "closed before the timeout");

    // It comes back on demand, by its remembered address.
    let (status, _) = call_json!(app, test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/Width"));
    assert_eq!(status, 200);
    assert_eq!(connected!(app), 1);
}

#[actix_web::test]
async fn anonymous_requests_keep_a_device_open() {
    let idle = Duration::from_millis(300);
    let (_cam, ctx) =
        app_context_with_runtime(FakeCameraConfig::default(), fast_runtime(Duration::from_secs(30), Some(idle))).await;
    let app = service!(ctx);
    let until = Instant::now() + Duration::from_millis(900);
    while Instant::now() < until {
        let (status, _) = call_json!(app, test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/Width"));
        assert_eq!(status, 200);
        assert_eq!(connected!(app), 1, "closed while in use");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[actix_web::test]
async fn a_member_session_holds_a_device_open_until_it_ends() {
    let (_cam, ctx) = app_context_with_runtime(
        FakeCameraConfig::default(),
        fast_runtime(Duration::from_millis(300), Some(Duration::from_millis(100))),
    )
    .await;
    let app = service!(ctx);
    let id = session!(app);
    let (status, _) = call_json!(app, test::TestRequest::put().uri(&format!("/api/v1/devices/0/connect?session={id}")));
    assert_eq!(status, 200);
    // Heartbeats keep the session, and so the device.
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(60)).await;
        let resp = test::call_service(
            &app,
            test::TestRequest::post().uri(&format!("/api/v1/sessions/{id}/heartbeat")).to_request(),
        )
        .await;
        assert_eq!(resp.status(), 204);
        assert_eq!(connected!(app), 1);
    }
    // Silence: the session expires, then the device idles out.
    let deadline = Instant::now() + Duration::from_secs(5);
    while connected!(app) == 1 {
        assert!(Instant::now() < deadline, "the device outlived its last session");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[actix_web::test]
async fn disconnecting_leaves_and_closes_only_when_nobody_is_left() {
    let (_cam, ctx) = app_context_with(FakeCameraConfig::default()).await;
    let app = service!(ctx);
    let a = session!(app);
    let b = session!(app);
    for id in [&a, &b] {
        let (status, _) = call_json!(app, test::TestRequest::put().uri(&format!("/api/v1/devices/0/connect?session={id}")));
        assert_eq!(status, 200);
    }

    // An anonymous disconnect leaves a device sessions use alone.
    let (status, body) = call_json!(app, test::TestRequest::put().uri("/api/v1/devices/0/disconnect"));
    assert_eq!((status, body), (200, json!({"closed": false, "members": 2})));
    assert_eq!(connected!(app), 1);

    // A leaves; B still uses it.
    let (_, body) = call_json!(app, test::TestRequest::put().uri(&format!("/api/v1/devices/0/disconnect?session={a}")));
    assert_eq!(body, json!({"closed": false, "members": 1}));
    assert_eq!(connected!(app), 1);
    // The last one out closes it.
    let (_, body) = call_json!(app, test::TestRequest::put().uri(&format!("/api/v1/devices/0/disconnect?session={b}")));
    assert_eq!(body, json!({"closed": true, "members": 0}));
    assert_eq!(connected!(app), 0);

    // `force` closes it whoever uses it.
    let (status, _) = call_json!(app, test::TestRequest::put().uri(&format!("/api/v1/devices/0/connect?session={a}")));
    assert_eq!(status, 200);
    let (_, body) = call_json!(app, test::TestRequest::put().uri("/api/v1/devices/0/disconnect?force=true"));
    assert_eq!(body, json!({"closed": true, "members": 0}));
    assert_eq!(connected!(app), 0);
    let (_, list) = call_json!(app, test::TestRequest::get().uri("/api/v1/sessions"));
    assert!(list.as_array().unwrap().iter().all(|s| s["devices"] == json!([])), "nobody is a member any more: {list}");
}

#[actix_web::test]
async fn a_session_end_closes_its_live_viewer_with_4001() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (id, _) = open_session(&srv, "viewer").await;
    let mut framed = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={id}")).await.unwrap();
    assert!(matches!(next_frame!(framed), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(framed), ws::Frame::Binary(_)));

    assert_eq!(srv.delete(format!("/api/v1/sessions/{id}")).send().await.unwrap().status(), 204);
    let close = loop {
        match next_frame!(framed) {
            ws::Frame::Close(reason) => break reason.expect("the close carries a reason"),
            ws::Frame::Binary(_) | ws::Frame::Ping(_) | ws::Frame::Pong(_) => {}
            other => panic!("unexpected frame after the session ended: {other:?}"),
        }
    };
    assert_eq!(close.code, ws::CloseCode::Other(4001));
    assert_eq!(close.description.as_deref(), Some("session expired"));

    // The camera is free again, for anyone.
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    assert!(matches!(next_frame!(framed), ws::Frame::Text(_)), "the camera was released");
    framed.send(ws::Message::Close(None)).await.unwrap();
}
