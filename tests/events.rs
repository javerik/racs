//! The events WebSocket: what a client learns about changes made by others.

use std::time::Duration;

#[macro_use]
mod common;
use common::*;

use aravis_port_fakecamera::FakeCameraConfig;
use awc::ws;
use futures::SinkExt;
use rust_cam_serve::events::EventKind;
use rust_cam_serve::server_config::RuntimeConfig;
use serde_json::{json, Value};

#[actix_web::test]
async fn hello_comes_first_with_every_connected_device() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (id, client_id) = open_session(&srv, "watcher").await;

    let mut events = srv.ws_at(&format!("/api/v1/events?session={id}")).await.unwrap();
    let hello = next_event!(events);
    assert_eq!(hello["type"], "hello");
    assert!(hello["seq"].is_u64());
    assert!(hello["time"].as_str().unwrap().ends_with('Z'));
    assert_eq!(hello["session"], json!({"client_id": client_id, "timeout_s": 30}));
    assert_eq!(
        hello["devices"],
        json!([{
            "device": 0,
            "connected": true,
            "access": {"mode": "shared", "owner": null, "members": []},
            "stream": null,
            "burst": null,
        }])
    );
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn the_events_socket_requires_a_session() {
    let (_cam, _ctx, srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let mut resp = srv.get("/api/v1/events").send().await.unwrap();
    assert_eq!(resp.status(), 400);
    assert_eq!(resp.json::<Value>().await.unwrap(), json!({"error": "session_required"}));
}

#[actix_web::test]
async fn device_state_follows_connect_and_disconnect() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, a_client) = open_session(&srv, "a").await;
    let (b, _) = open_session(&srv, "b").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let resp = srv.put(format!("/api/v1/devices/0/disconnect?session={a}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let closed = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(closed["cause"], "disconnected");
    assert_eq!(closed["reason"], "request");
    assert_eq!(closed["connected"], false);
    assert_eq!(closed["by"], json!({"client_id": a_client, "name": "a"}));

    let resp = srv.put(format!("/api/v1/devices/0/connect?session={a}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let opened = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(opened["cause"], "connected");
    assert_eq!(opened["reason"], Value::Null);
    assert_eq!(opened["connected"], true);
    assert_eq!(opened["by"]["client_id"], a_client);
    assert_eq!(opened["access"]["members"], json!([{"client_id": a_client, "name": "a"}]));
    assert!(opened["seq"].as_u64() > closed["seq"].as_u64());
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_rename_is_announced_on_the_devices_the_session_uses() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, a_client) = open_session(&srv, "a").await;
    let (b, _) = open_session(&srv, "b").await;
    let resp = srv.put(format!("/api/v1/devices/0/connect?session={a}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let (status, _) = send_as!(srv.patch(format!("/api/v1/sessions/{a}")), a.as_str(), json!({"name": "line-script"}));
    assert_eq!(status, 204);
    let renamed = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(renamed["cause"], "access");
    assert_eq!(renamed["by"], json!({"client_id": a_client, "name": "line-script"}));
    assert_eq!(renamed["access"]["members"], json!([{"client_id": a_client, "name": "line-script"}]));

    let mut resp = srv.get("/api/v1/sessions").send().await.unwrap();
    let list: Value = resp.json().await.unwrap();
    assert!(list.as_array().unwrap().iter().any(|s| s["client_id"] == a_client && s["name"] == "line-script"));

    // Removing the name, and an ended session.
    let (status, _) = send_as!(srv.patch(format!("/api/v1/sessions/{a}")), a.as_str(), json!({}));
    assert_eq!(status, 204);
    let resp = srv.delete(format!("/api/v1/sessions/{a}")).send().await.unwrap();
    assert_eq!(resp.status(), 204);
    let mut resp = srv.patch(format!("/api/v1/sessions/{a}")).send_json(&json!({"name": "x"})).await.unwrap();
    assert_eq!(resp.status(), 401);
    assert_eq!(resp.json::<Value>().await.unwrap(), json!({"error": "session_expired"}));
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn another_clients_write_is_announced_also_during_a_live_stream() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, a_client) = open_session(&srv, "a").await;
    let (b, _) = open_session(&srv, "b").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let write = |value: &str| format!("/api/v1/devices/0/gc/feature/ExposureTime?value={value}&session={a}");
    assert_eq!(srv.put(write("2000")).send().await.unwrap().status(), 200);
    let changed = await_event!(events, |e| e["type"] == "feature_changed");
    assert_eq!(changed["device"], 0);
    assert_eq!(changed["feature"], "ExposureTime");
    assert_eq!(changed["by"]["client_id"], a_client);

    // An anonymous live stream: its start is a state change too.
    let mut live = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    assert!(matches!(next_frame!(live), ws::Frame::Text(_)));
    let started = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(started["stream"], json!({"viewers": 1, "pixel_format": "Mono8", "bit_depth": 8}));
    assert_eq!(started["by"], Value::Null);

    // The write is forwarded into the stream and still announced.
    assert_eq!(srv.put(write("3000")).send().await.unwrap().status(), 200);
    let changed = await_event!(events, |e| e["type"] == "feature_changed");
    assert_eq!(changed["feature"], "ExposureTime");
    assert_eq!(changed["by"]["client_id"], a_client);

    let resp = srv.post(format!("/api/v1/devices/0/gc/command/TriggerSoftware?session={a}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let executed = await_event!(events, |e| e["type"] == "command_executed");
    assert_eq!(executed["command"], "TriggerSoftware");

    let resp = srv.post("/api/v1/devices/0/stream/packet-size/auto").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let changed = await_event!(events, |e| e["type"] == "feature_changed");
    assert_eq!(changed["feature"], "GevSCPSPacketSize");
    assert_eq!(changed["by"], Value::Null, "anonymous");

    live.send(ws::Message::Close(None)).await.unwrap();
    let stopped = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(stopped["stream"], Value::Null);
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_session_end_is_announced() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, a_client) = open_session(&srv, "a").await;
    let (b, _) = open_session(&srv, "b").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={b}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    // A member: its end changes the device's members too.
    assert_eq!(srv.put(format!("/api/v1/devices/0/connect?session={a}")).send().await.unwrap().status(), 200);
    let joined = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(joined["cause"], "access");
    assert_eq!(joined["access"]["members"][0]["client_id"], a_client);

    assert_eq!(srv.delete(format!("/api/v1/sessions/{a}")).send().await.unwrap().status(), 204);
    let left = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(left["cause"], "access");
    assert_eq!(left["access"]["members"], json!([]));
    let ended = await_event!(events, |e| e["type"] == "session_ended");
    assert_eq!(ended, json!({"seq": ended["seq"], "time": ended["time"], "type": "session_ended", "client_id": a_client, "reason": "closed"}));

    // B's own end closes its events socket, after telling it.
    assert_eq!(srv.delete(format!("/api/v1/sessions/{b}")).send().await.unwrap().status(), 204);
    assert_eq!(await_event!(events, |e| e["type"] == "session_ended")["reason"], "closed");
    let close = loop {
        match next_frame!(events) {
            ws::Frame::Close(reason) => break reason.expect("the close carries a reason"),
            ws::Frame::Ping(_) | ws::Frame::Text(_) => {}
            other => panic!("unexpected frame: {other:?}"),
        }
    };
    assert_eq!(close.code, ws::CloseCode::Other(4001));
}

#[actix_web::test]
async fn a_subscriber_that_falls_behind_gets_resync() {
    let runtime = RuntimeConfig { event_capacity: 2, ..RuntimeConfig::default() };
    let (_cam, ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), runtime).await;
    let (id, _) = open_session(&srv, "slow").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={id}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    // Far more than the bus holds, faster than the socket's task can pass them on.
    for _ in 0..10_000 {
        ctx.events.emit(EventKind::CommandExecuted { device: 0, command: "TriggerSoftware".into(), by: None });
    }
    let resync = await_event!(events, |e| e["type"] == "resync");
    assert!(resync["seq"].as_u64().unwrap() > 0);

    // And it carries on afterwards.
    tokio::time::sleep(Duration::from_millis(50)).await;
    ctx.events.emit(EventKind::SessionEnded { client_id: "marker00".into(), reason: rust_cam_serve::models::session::EndReason::Closed });
    await_event!(events, |e| e["type"] == "session_ended" && e["client_id"] == "marker00");
    events.send(ws::Message::Close(None)).await.unwrap();
}
