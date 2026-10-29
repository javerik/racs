//! Exercises every REST route and the live-stream WebSocket through the real router, against the
//! in-process fake camera.
//!
//! `openapi.json` is committed and three client libraries are generated from it, so the HTTP
//! surface is a contract. These tests pin status codes, content types and body shapes so a change
//! to the camera backend can't quietly move them.

use std::time::{Duration, Instant};

#[macro_use]
mod common;
use common::*;

use actix_web::body::{BodySize, MessageBody};
use actix_web::test;
use aravis_port_fakecamera::{feature, pixel_format, scan_type, FakeCamera, FakeCameraConfig};
use awc::ws;
use futures::SinkExt;
use rust_cam_serve::controller::frame_codec;
use rust_cam_serve::models::pixel::PixelLayout;

/// Put the fake camera into Linescan3D, as switching `DeviceScanType` over GVCP would: a poke
/// skips the device's own side effects, so it sets the one format that mode streams too.
fn poke_linescan3d(camera: &FakeCamera) {
    camera.poke_register(feature::DEVICE_SCAN_TYPE, scan_type::LINESCAN3D);
    camera.poke_register(feature::PIXEL_FORMAT, pixel_format::COORD3D_C16);
}

/// Every value of a fake Linescan3D frame is a height in its scene's range, or 0 (no laser line).
fn assert_profile_values(payload: &[u8]) {
    let values: Vec<u16> = payload.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    assert!(values.iter().all(|&z| z == 0 || (9_000..=33_000).contains(&z)), "not profile heights");
    assert!(values.iter().any(|&z| z > 255), "a 16-bit range image should use more than 8 bits");
}

#[actix_web::test]
async fn get_devices_returns_the_connections_document() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/devices").to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json",
        "clients parse this as JSON"
    );

    let body: serde_json::Value = test::read_body_json(resp).await;
    // The fake camera doesn't answer broadcast discovery, but the connected camera must appear.
    assert!(body.get("available").is_some(), "missing `available`: {body}");
    assert!(body.get("connected").is_some(), "missing `connected`: {body}");
    let connected = body["connected"].as_array().unwrap();
    assert_eq!(connected.len(), 1, "expected the connected camera: {body}");
    for key in ["id", "dev_id", "serial_number", "vendor", "model", "manufacturer_info", "ip", "mac"] {
        assert!(connected[0].get(key).is_some(), "missing `{key}` in {}", connected[0]);
    }
}

#[actix_web::test]
async fn get_connected_devices_lists_only_the_store_without_discovery() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let uri = "/api/v1/devices/connected";
    let resp = test::call_service(&app, test::TestRequest::get().uri(uri).to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    let connected = body.as_array().expect("a plain array, not the discovery document");
    assert_eq!(connected.len(), 1, "{body}");
    for key in ["id", "dev_id", "serial_number", "vendor", "model", "manufacturer_info", "ip", "mac"] {
        assert!(connected[0].get(key).is_some(), "missing `{key}` in {}", connected[0]);
    }
    // Additive: the device's access state, as this (anonymous) client sees it.
    assert_eq!(
        connected[0]["access"],
        serde_json::json!({"device": 0, "mode": "shared", "owner": null, "members": [], "holder": null,
                           "viewers": 0, "you": "writer"})
    );

    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri("/api/v1/devices/0/disconnect").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let resp = test::call_service(&app, test::TestRequest::get().uri(uri).to_request()).await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body, serde_json::json!([]), "a disconnected device is no longer listed");
}

#[actix_web::test]
async fn connect_and_disconnect_answer_200() {
    let (cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri("/api/v1/devices/0/disconnect").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body, serde_json::json!({"closed": true, "members": 0}));

    // Reconnect by id (the remembered address): the answer is the device's access state.
    let resp = test::call_service(&app, test::TestRequest::put().uri("/api/v1/devices/0/connect").to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!((body["device"].clone(), body["mode"].clone(), body["you"].clone()),
               (serde_json::json!(0), serde_json::json!("shared"), serde_json::json!("writer")));
    let resp = test::call_service(&app, test::TestRequest::put().uri("/api/v1/devices/0/disconnect").to_request()).await;
    assert_eq!(resp.status(), 200);

    // Reconnect by ip. The fake isn't on GVCP's port 3956, so this exercises the query-param
    // path and is expected to fail to reach a camera — what matters is the shape of the reply.
    let uri = format!("/api/v1/devices/0/connect?ip={}", cam.local_addr().ip());
    let resp = test::call_service(&app, test::TestRequest::put().uri(&uri).to_request()).await;
    assert!(
        resp.status() == 200 || resp.status() == 500,
        "connect must answer 200 or 500, got {}",
        resp.status()
    );
}

#[actix_web::test]
async fn session_routes_answer_with_the_documented_shapes() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    // The body is optional.
    let resp = test::call_service(&app, test::TestRequest::post().uri("/api/v1/sessions").to_request()).await;
    assert_eq!(resp.status(), 201);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let created: serde_json::Value = test::read_body_json(resp).await;
    let keys: Vec<&String> = created.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["client_id", "heartbeat_interval_s", "name", "session_id", "timeout_s"]);
    assert_eq!(created["name"], serde_json::Value::Null);
    assert_eq!(created["timeout_s"], 30);
    assert_eq!(created["heartbeat_interval_s"], 10);
    let client_id = created["client_id"].as_str().unwrap();
    assert!(client_id.len() == 8 && client_id.chars().all(|c| c.is_ascii_hexdigit()));
    let id = created["session_id"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(id).is_ok());

    // The timeout is clamped.
    let resp = test::call_service(
        &app,
        test::TestRequest::post().uri("/api/v1/sessions").set_json(serde_json::json!({"timeout_s": 1})).to_request(),
    )
    .await;
    let short: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!((short["timeout_s"].as_u64(), short["heartbeat_interval_s"].as_u64()), (Some(5), Some(1)));

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/sessions").to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let list: serde_json::Value = test::read_body_json(resp).await;
    let first = &list.as_array().unwrap()[0];
    let keys: Vec<&String> = first.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["client_id", "devices", "last_seen", "name", "owns", "since"]);
    assert_eq!(first["client_id"], client_id);
    assert!(chrono::DateTime::parse_from_rfc3339(first["since"].as_str().unwrap()).is_ok());

    let uri = format!("/api/v1/sessions/{id}/heartbeat");
    let resp = test::call_service(&app, test::TestRequest::post().uri(&uri).to_request()).await;
    assert_eq!(resp.status(), 204);
    assert!(test::read_body(resp).await.is_empty());

    let rename = format!("/api/v1/sessions/{id}");
    let resp = test::call_service(
        &app,
        test::TestRequest::patch().uri(&rename).set_json(serde_json::json!({"name": "webapp · Firefox"})).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 204);
    assert!(test::read_body(resp).await.is_empty());

    let resp = test::call_service(&app, test::TestRequest::delete().uri(&format!("/api/v1/sessions/{id}")).to_request()).await;
    assert_eq!(resp.status(), 204);
    let resp = test::call_service(
        &app,
        test::TestRequest::patch().uri(&rename).set_json(serde_json::json!({"name": "x"})).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
    let resp = test::call_service(&app, test::TestRequest::post().uri(&uri).to_request()).await;
    assert_eq!(resp.status(), 401);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body, serde_json::json!({"error": "session_expired"}));
}

#[actix_web::test]
async fn the_events_route_needs_a_session() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/events").to_request()).await;
    assert_eq!(resp.status(), 400);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body, serde_json::json!({"error": "session_required"}));
}

/// The sorted keys of a JSON object.
fn keys(value: &serde_json::Value) -> Vec<&str> {
    value.as_object().unwrap().keys().map(String::as_str).collect()
}

#[actix_web::test]
async fn the_access_routes_answer_the_device_access() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let a = session!(app);
    let access = "/api/v1/devices/0/access";

    let resp = test::call_service(&app, test::TestRequest::get().uri(access).insert_header(("X-Racs-Session", a.as_str())).to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(keys(&body), ["device", "holder", "members", "mode", "owner", "viewers", "you"]);
    assert_eq!((body["mode"].as_str(), body["owner"].is_null(), body["you"].as_str()), (Some("shared"), true, Some("writer")));

    let resp = test::call_service(
        &app,
        test::TestRequest::put()
            .uri(access)
            .insert_header(("X-Racs-Session", a.as_str()))
            .set_json(serde_json::json!({"mode": "ro-shared"}))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(keys(&body), ["device", "holder", "members", "mode", "owner", "viewers", "you"]);
    assert_eq!((body["mode"].as_str(), body["you"].as_str()), (Some("ro-shared"), Some("owner")));
    assert_eq!(keys(&body["owner"]), ["client_id", "name"]);
    assert_eq!(keys(&body["members"][0]), ["client_id", "name"]);

    let resp = test::call_service(
        &app,
        test::TestRequest::delete().uri(access).insert_header(("X-Racs-Session", a.as_str())).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(keys(&body), ["device", "holder", "members", "mode", "owner", "viewers", "you"]);
    assert_eq!((body["mode"].as_str(), body["owner"].is_null()), (Some("shared"), true));
}

#[actix_web::test]
async fn access_refusals_are_json_with_their_context() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let (a, b) = (session!(app), session!(app));
    let access = "/api/v1/devices/0/access";
    let refusal = |status: u16, body: &serde_json::Value| (status, body["error"].as_str().map(str::to_owned), keys(body).join(","));

    // 400: a lease route without a session.
    let resp = test::call_service(&app, test::TestRequest::put().uri(access).set_json(serde_json::json!({"mode": "exclusive"})).to_request()).await;
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let status = resp.status().as_u16();
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!((status, body), (400, serde_json::json!({"error": "session_required"})));

    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri(access).insert_header(("X-Racs-Session", a.as_str())).set_json(serde_json::json!({"mode": "ro-shared"})).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);

    // 403: a reader writes.
    let resp = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/v1/devices/0/gc/feature/Width?value=64")
            .insert_header(("X-Racs-Session", b.as_str()))
            .to_request(),
    )
    .await;
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let status = resp.status().as_u16();
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(refusal(status, &body), (403, Some("read_only".into()), "error,mode,owner".into()));

    // 409: the owner goes exclusive while the reader (a member since its read) is there.
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/Width").insert_header(("X-Racs-Session", b.as_str())).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri(access).insert_header(("X-Racs-Session", a.as_str())).set_json(serde_json::json!({"mode": "exclusive"})).to_request(),
    )
    .await;
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let status = resp.status().as_u16();
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(refusal(status, &body), (409, Some("device_in_use".into()), "error,holder,members,mode,owner".into()));
    assert_eq!(keys(&body["members"][0]), ["client_id", "name"]);

    // 423: taking a lease another session owns.
    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri(access).insert_header(("X-Racs-Session", b.as_str())).set_json(serde_json::json!({"mode": "exclusive"})).to_request(),
    )
    .await;
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let status = resp.status().as_u16();
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(refusal(status, &body), (423, Some("device_locked".into()), "error,mode,owner".into()));
}

#[actix_web::test]
async fn the_events_socket_sends_hello_then_complete_states() {
    let (_cam, mut srv) = live_server().await;
    let (id, _) = open_session(&srv, "watcher").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={id}")).await.unwrap();

    let hello = next_event!(events);
    assert_eq!(keys(&hello), ["devices", "seq", "session", "time", "type"]);
    assert_eq!(keys(&hello["session"]), ["client_id", "timeout_s"]);
    assert_eq!(keys(&hello["devices"][0]), ["access", "burst", "connected", "device", "stream"]);
    assert_eq!(keys(&hello["devices"][0]["access"]), ["members", "mode", "owner"]);

    let resp = srv.put("/api/v1/devices/0/gc/feature/Width?value=64").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let changed = await_event!(events, |e| e["type"] == "feature_changed");
    assert_eq!(keys(&changed), ["by", "device", "feature", "seq", "time", "type"]);

    let resp = srv.put(format!("/api/v1/devices/0/connect?mode=ro-shared&session={id}")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let state = await_event!(events, |e| e["type"] == "device_state");
    assert_eq!(keys(&state), ["access", "burst", "by", "cause", "connected", "device", "reason", "seq", "stream", "time", "type"]);
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn the_api_document_declares_the_optional_session() {
    use utoipa::OpenApi;
    let doc = serde_json::to_value(rust_cam_serve::restapi_doc::ApiDoc::openapi()).unwrap();
    assert_eq!(
        doc["components"]["securitySchemes"]["session"],
        serde_json::json!({"type": "apiKey", "in": "header", "name": "X-Racs-Session", "description": doc["components"]["securitySchemes"]["session"]["description"]})
    );
    assert_eq!(doc["security"], serde_json::json!([{}, {"session": []}]));
    for (path, item) in doc["paths"].as_object().unwrap() {
        for (method, op) in item.as_object().unwrap() {
            assert!(op["responses"]["401"].is_object(), "{method} {path} documents no 401");
        }
    }
    for path in ["/sessions", "/sessions/{session_id}", "/sessions/{session_id}/heartbeat", "/events"] {
        assert!(doc["paths"][path].is_object(), "{path} is not documented");
    }
    assert!(doc["paths"]["/sessions/{session_id}"]["patch"].is_object(), "the rename is not documented");
}

#[actix_web::test]
async fn the_api_document_lists_the_access_refusals_per_route() {
    use utoipa::OpenApi;
    let doc = serde_json::to_value(rust_cam_serve::restapi_doc::ApiDoc::openapi()).unwrap();
    let documents = |method: &str, path: &str, status: &str| doc["paths"][path][method]["responses"][status].is_object();
    // (method, path, the refusals it can return)
    let routes: &[(&str, &str, &[&str])] = &[
        ("get", "/devices/{id}/xml", &[]),
        ("get", "/devices/{id}/gc/categories", &[]),
        ("get", "/devices/{id}/stream/error", &[]),
        ("get", "/devices/{id}/access", &[]),
        ("get", "/devices/{id}/gc/feature/{feature_name}", &["423"]),
        ("post", "/devices/{id}/gc/features/state", &["423"]),
        ("get", "/devices/{id}/stream/packet-size", &["423"]),
        ("get", "/devices/{id}/grab/jobs/{job_id}", &["423"]),
        ("get", "/devices/{id}/grab/jobs/{job_id}/images", &["423"]),
        ("get", "/devices/{id}/grab/jobs/{job_id}/images/{index}", &["423"]),
        ("put", "/devices/{id}/gc/feature/{feature_name}", &["403", "423"]),
        ("post", "/devices/{id}/gc/command/{command_name}", &["403", "423"]),
        ("post", "/devices/{id}/stream/packet-size/auto", &["403", "423"]),
        ("get", "/devices/{id}/stream/frame/raw", &["403", "423"]),
        ("get", "/devices/{id}/stream/frame/jpeg", &["403", "423"]),
        ("get", "/devices/{id}/stream/live", &["403", "423"]),
        ("post", "/devices/{id}/grab/jobs", &["403", "423"]),
        ("delete", "/devices/{id}/grab/jobs/{job_id}", &["403", "423"]),
        ("put", "/devices/{id}/disconnect", &["403", "423"]),
        ("put", "/devices/{id}/connect", &["400", "409", "423"]),
        ("put", "/devices/{id}/access", &["400", "409", "423"]),
        ("delete", "/devices/{id}/access", &["400", "423"]),
    ];
    for (method, path, refusals) in routes {
        assert!(doc["paths"][path][method].is_object(), "{method} {path} is not documented");
        for status in ["403", "409", "423"] {
            assert_eq!(documents(method, path, status), refusals.contains(&status), "{method} {path} and {status}");
        }
        if refusals.contains(&"400") {
            assert!(documents(method, path, "400"), "{method} {path} documents no 400");
        }
    }
    for schema in ["DeviceAccess", "AccessError", "ConnectedDevice", "SetAccessRequest", "Mode", "Role"] {
        assert!(doc["components"]["schemas"][schema].is_object(), "schema {schema} missing");
    }
}

#[actix_web::test]
async fn get_device_xml_returns_xml() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/devices/0/xml").to_request()).await;
    assert_eq!(resp.status(), 200);
    let ct = resp.headers().get("content-type").unwrap().to_str().unwrap().to_string();
    assert!(ct.contains("xml"), "expected an XML content type, got {ct}");

    let body = test::read_body(resp).await;
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("RegisterDescription"), "not a GenICam document");
}

#[actix_web::test]
async fn get_gc_categories_returns_the_documented_node_shape() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/gc/categories").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);

    let body: serde_json::Value = test::read_body_json(resp).await;
    let categories = body.as_array().expect("categories must be a JSON array");
    assert!(!categories.is_empty());
    for key in ["name", "display_name", "nodes"] {
        assert!(categories[0].get(key).is_some(), "category missing `{key}`");
    }

    let node = categories
        .iter()
        .flat_map(|c| c["nodes"].as_array().unwrap())
        .find(|n| n["name"] == "PixelFormat")
        .expect("PixelFormat should be listed");
    // Every field in the committed schema must be present.
    for key in ["name", "display_name", "node_type", "visibility", "access_mode", "enums", "selected"] {
        assert!(node.get(key).is_some(), "node missing `{key}`: {node}");
    }
    assert_eq!(node["node_type"], "Enum");
    let entry = &node["enums"].as_array().unwrap()[0];
    for key in ["display_name", "value", "string_value"] {
        assert!(entry.get(key).is_some(), "enum entry missing `{key}`: {entry}");
    }
}

#[actix_web::test]
async fn get_and_put_gc_feature_use_plain_text_values() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/Width").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    // The body is the bare value, not JSON — clients parse it directly.
    assert_eq!(String::from_utf8_lossy(&test::read_body(resp).await), W.to_string());

    let resp = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/v1/devices/0/gc/feature/ExposureTime?value=1234")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);

    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/devices/0/gc/feature/ExposureTime")
            .to_request(),
    )
    .await;
    assert_eq!(String::from_utf8_lossy(&test::read_body(resp).await), "1234");
}

#[actix_web::test]
async fn an_unknown_feature_returns_500_with_a_message() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/devices/0/gc/feature/NoSuchFeature")
            .to_request(),
    )
    .await;
    // Every error maps to 500 with a debug-formatted body; that's the existing behaviour and
    // clients depend on the status, not the text.
    assert_eq!(resp.status(), 500);
    assert!(!test::read_body(resp).await.is_empty(), "errors carry a message");
}

#[actix_web::test]
async fn raw_frame_streams_width_times_height_octets() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/devices/0/stream/frame/raw")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/octet-stream"
    );

    let body = test::read_body(resp).await;
    assert_eq!(body.len(), (W * H) as usize, "raw frame must be exactly width*height for Mono8");
}

#[actix_web::test]
async fn jpeg_frame_returns_a_jpeg() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/devices/0/stream/frame/jpeg?quality=80")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);

    let body = test::read_body(resp).await;
    assert_eq!(&body[..2], &[0xFF, 0xD8], "not a JPEG");
}

#[actix_web::test]
async fn jpeg_quality_is_optional() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/devices/0/stream/frame/jpeg")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200, "quality must default rather than 400");
}

// ---------------------------------------------------------------------------------------------
// Burst grab jobs
// ---------------------------------------------------------------------------------------------

#[actix_web::test]
async fn a_burst_job_runs_to_completion_and_serves_its_frames() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": 3, "format": "raw"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");

    let info = await_job!(app, &job_uri);
    // Every field in the committed schema must be present, even the null ones.
    for key in [
        "job_id", "device_id", "status", "format", "requested_count", "captured_count",
        "failed_count", "created_at", "started_at", "completed_at", "expires_at", "error",
        "width", "height", "pixel_format", "bit_depth",
    ] {
        assert!(info.get(key).is_some(), "status missing `{key}`: {info}");
    }
    assert_eq!(info["status"], "completed", "{info}");
    assert_eq!(info["requested_count"], 3);
    assert_eq!(info["captured_count"], 3);
    assert_eq!(info["failed_count"], 0);
    assert!(info["error"].is_null(), "a completed job carries no error");
    // A finished job is reclaimable; a running one is not, which is what `expires_at` says.
    assert!(!info["expires_at"].is_null(), "{info}");
    // Recorded from the first frame, so a raw consumer can decode without asking the camera.
    assert_eq!(info["width"], W);
    assert_eq!(info["height"], H);
    assert_eq!(info["pixel_format"], "Mono8", "8-bit unless asked otherwise");
    assert_eq!(info["bit_depth"], 8);

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let images: serde_json::Value = test::read_body_json(resp).await;
    let images = images.as_array().expect("the image list is a JSON array");
    assert_eq!(images.len(), 3);
    for (index, entry) in images.iter().enumerate() {
        assert_eq!(entry["status"], "ok");
        assert_eq!(entry["index"], index as u64, "entries are ordered by index");
        assert_eq!(entry["size_bytes"], (W * H) as u64);
    }

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/1")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/octet-stream",
        "frames are bytes, the same as the single-frame endpoints"
    );
    // A sized body is what actix sends with a Content-Length (the in-process service adds no
    // headers of its own, so the size is checked here instead).
    assert_eq!(
        resp.response().body().size(),
        BodySize::Sized((W * H) as u64),
        "a frame is sent whole, with its length"
    );
    let body = test::read_body(resp).await;
    assert_eq!(body.len(), (W * H) as usize, "a raw frame is exactly width*height for Mono8");

    // Past the end of a finished burst: nothing more is coming, but it is still just "not there".
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/3")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 404);

    let resp =
        test::call_service(&app, test::TestRequest::delete().uri(&job_uri).to_request()).await;
    assert_eq!(resp.status(), 204);
    assert!(test::read_body(resp).await.is_empty(), "a deleted job returns no body");

    // Deleting frees the record immediately rather than waiting for the TTL.
    let resp = test::call_service(&app, test::TestRequest::get().uri(&job_uri).to_request()).await;
    assert_eq!(resp.status(), 404);
    let resp =
        test::call_service(&app, test::TestRequest::delete().uri(&job_uri).to_request()).await;
    assert_eq!(resp.status(), 404, "deleting twice is a 404 the second time");
}

#[actix_web::test]
async fn a_jpeg_burst_job_serves_jpegs() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": 2, "format": "jpeg", "quality": 60}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    let info = await_job!(app, &job_uri);
    assert_eq!(info["status"], "completed", "{info}");
    assert_eq!(info["format"], "jpeg");

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    // JPEG bytes go out as octet-stream too, matching `GET /stream/frame/jpeg`.
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/octet-stream");
    let body = test::read_body(resp).await;
    assert_eq!(&body[..2], &[0xFF, 0xD8], "not a JPEG");
}

#[actix_web::test]
async fn a_zstd_burst_serves_frames_that_decode_to_the_pixels() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    for (depth, layout) in [("mono8", PixelLayout::mono8()), ("mono16", PixelLayout::from_pixel_format("Mono16"))] {
        let job_id =
            start_job!(app, serde_json::json!({"count": 3, "format": "zstd", "pixel_depth": depth}));
        let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
        let info = await_job!(app, &job_uri);
        assert_eq!(info["status"], "completed", "{info}");
        assert_eq!(info["format"], "zstd");
        assert_eq!(info["captured_count"], 3, "every frame is stored before the job completes");
        assert_eq!(info["pixel_format"], layout.pixel_format.as_str());

        for index in 0..3 {
            let resp = test::call_service(
                &app,
                test::TestRequest::get().uri(&format!("{job_uri}/images/{index}")).to_request(),
            )
            .await;
            assert_eq!(resp.status(), 200);
            assert_eq!(resp.headers().get("content-type").unwrap(), "application/octet-stream");
            let body = test::read_body(resp).await;
            let pixels = frame_codec::decode_zstd(&body, W, H, &layout).expect("not a zstd frame");
            assert!(body.len() < pixels.len(), "{} bytes for {} pixels", body.len(), pixels.len());
            match depth {
                "mono8" => assert_mono8_gradient(&pixels),
                _ => assert_mono16_gradient(&pixels),
            }
        }
    }
}

#[actix_web::test]
async fn a_mono16_raw_burst_reports_its_depth_and_serves_two_bytes_per_pixel() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let job_id =
        start_job!(app, serde_json::json!({"count": 2, "format": "raw", "pixel_depth": "mono16"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    let info = await_job!(app, &job_uri);
    assert_eq!(info["status"], "completed", "{info}");
    assert_eq!(info["pixel_format"], "Mono16");
    assert_eq!(info["bit_depth"], 16);
    assert_eq!((info["width"].as_u64(), info["height"].as_u64()), (Some(W as u64), Some(H as u64)));

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let body = test::read_body(resp).await;
    assert_eq!(body.len(), (W * H * 2) as usize, "16-bit raw is two bytes per pixel");
    let max = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).max().unwrap();
    assert!(max > 255, "little-endian u16 pixels should use more than 8 bits, max {max}");

    // JPEG cannot carry 16 bits, but a 16-bit burst must still encode rather than fail.
    let job_id =
        start_job!(app, serde_json::json!({"count": 1, "format": "jpeg", "pixel_depth": "mono16"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    let info = await_job!(app, &job_uri);
    assert_eq!(info["status"], "completed", "{info}");
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(&test::read_body(resp).await[..2], &[0xFF, 0xD8], "not a JPEG");

    // The camera keeps whatever format the last acquisition left it in, so the single-frame
    // endpoints must put it back to Mono8 rather than inherit 16-bit.
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/stream/frame/raw").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(test::read_body(resp).await.len(), (W * H) as usize);
}

#[actix_web::test]
async fn a_linescan3d_raw_burst_reports_coord3d_c16() {
    let (cam, ctx) = app_context().await;
    poke_linescan3d(&cam);
    let app = service!(ctx);

    // A 3D profiler in Linescan3D offers no mono format: either depth lands on its range format,
    // and the status says what was granted.
    for depth in ["mono16", "mono8"] {
        let job_id =
            start_job!(app, serde_json::json!({"count": 2, "format": "raw", "pixel_depth": depth}));
        let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
        let info = await_job!(app, &job_uri);
        assert_eq!(info["status"], "completed", "{depth}: {info}");
        assert_eq!(info["pixel_format"], "Coord3D_C16", "{depth}");
        assert_eq!(info["bit_depth"], 16, "{depth}");

        let resp = test::call_service(
            &app,
            test::TestRequest::get().uri(&format!("{job_uri}/images/1")).to_request(),
        )
        .await;
        assert_eq!(resp.status(), 200);
        let body = test::read_body(resp).await;
        assert_eq!(body.len(), (W * H * 2) as usize, "{depth}: the whole range image");
        assert_profile_values(&body);
    }
}

#[actix_web::test]
async fn an_out_of_range_count_is_rejected_before_a_job_exists() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    for count in [0u32, 501] {
        let resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/v1/devices/0/grab/jobs")
                .set_json(serde_json::json!({"count": count, "format": "raw"}))
                .to_request(),
        )
        .await;
        // A bad request is the one thing here that is *not* reported through the job record.
        assert_eq!(resp.status(), 400, "count {count} must be rejected");
        assert!(!test::read_body(resp).await.is_empty(), "the 400 explains itself");
    }
}

#[actix_web::test]
async fn an_unknown_job_is_a_404_on_every_route() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    // Never issued, so indistinguishable from one that has already expired or been deleted.
    let job_uri = "/api/v1/devices/0/grab/jobs/1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    for uri in [job_uri, &format!("{job_uri}/images"), &format!("{job_uri}/images/0")] {
        let resp = test::call_service(&app, test::TestRequest::get().uri(uri).to_request()).await;
        assert_eq!(resp.status(), 404, "{uri}");
    }
    let resp =
        test::call_service(&app, test::TestRequest::delete().uri(job_uri).to_request()).await;
    assert_eq!(resp.status(), 404);

    // A real job under the wrong device id must not be reachable either.
    let job_id = start_job!(app, serde_json::json!({"count": 1, "format": "raw"}));
    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!("/api/v1/devices/9/grab/jobs/{job_id}"))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 404);
}

// ---------------------------------------------------------------------------------------------
// Live stream (WebSocket)
//
#[actix_web::test]
async fn gc_categories_list_booleans_and_commands() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/gc/categories").to_request(),
    )
    .await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    let node_type = |name: &str| {
        body.as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["nodes"].as_array().unwrap())
            .find(|n| n["name"] == name)
            .map(|n| n["node_type"].clone())
    };
    assert_eq!(node_type("ReverseX"), Some(serde_json::json!("Boolean")));
    assert_eq!(node_type("TriggerSoftware"), Some(serde_json::json!("Command")));
}

#[actix_web::test]
async fn post_gc_features_state_returns_the_documented_shape() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/v1/devices/0/gc/features/state")
            .set_json(serde_json::json!({"names": ["Width", "ExposureTime", "NoSuchFeature"]}))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = test::read_body_json(resp).await;
    let states = body.as_array().expect("an array of states");
    assert_eq!(states.len(), 3);
    for state in states {
        for key in [
            "name", "node_type", "value", "available", "locked", "min", "max", "inc", "unit", "representation",
            "available_entries", "error",
        ] {
            assert!(state.get(key).is_some(), "state missing `{key}`: {state}");
        }
    }
    let names: Vec<&str> = states.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Width", "ExposureTime", "NoSuchFeature"], "request order is kept");
    // Values are strings, exactly as GET /gc/feature/{name} returns them.
    assert_eq!(states[0]["value"], W.to_string());
    assert_eq!(states[1]["unit"], "us");
    assert!(states[1]["max"].is_number());
    assert!(states[2]["error"].is_string(), "a per-feature problem is reported in its entry");
}

#[actix_web::test]
async fn an_empty_or_oversized_state_request_is_400() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);
    let too_many: Vec<String> = (0..257).map(|i| format!("F{i}")).collect();
    for names in [vec![], too_many] {
        let resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/v1/devices/0/gc/features/state")
                .set_json(serde_json::json!({ "names": names }))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 400, "for {} names", names.len());
    }
}

#[actix_web::test]
async fn post_gc_command_executes_once_and_rejects_non_commands() {
    let (cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::post().uri("/api/v1/devices/0/gc/command/TriggerSoftware").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert!(test::read_body(resp).await.is_empty());
    assert_eq!(cam.peek_register(feature::TRIGGER_SOFTWARE), 1);

    let resp = test::call_service(
        &app,
        test::TestRequest::post().uri("/api/v1/devices/0/gc/command/Width").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 500);
}

// ---------------------------------------------------------------------------------------------
// Live stream WebSocket: against a real bound server (`common::live_server`), since
// `test::init_service` cannot perform an HTTP upgrade.
// ---------------------------------------------------------------------------------------------

#[actix_web::test]
async fn live_stream_announces_itself_then_sends_numbered_jpeg_frames() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv
        .ws_at("/api/v1/devices/0/stream/live")
        .await
        .expect("the upgrade must be accepted");

    // The opening text message is what makes a raw stream decodable, so it must come first.
    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["width"], W);
    assert_eq!(info["height"], H);
    assert_eq!(info["format"], "jpeg", "jpeg is the default format");
    assert!(info.get("pixel_format").is_some(), "missing `pixel_format`: {info}");
    assert_eq!(info["bit_depth"], 8, "8-bit is the default depth");
    assert_eq!(info["packet_size"], 1500, "the camera's own packet size, not a forced one");

    for expected in 0..3u32 {
        let ws::Frame::Binary(bytes) = next_frame!(framed) else {
            panic!("frames are binary messages");
        };
        let (frame_number, _dropped, payload) = parse_frame(&bytes);
        assert_eq!(frame_number, expected, "frame numbers start at 0 and count up");
        assert_eq!(&payload[..2], &[0xFF, 0xD8], "not a JPEG");
    }
}

#[actix_web::test]
async fn a_raw_live_frame_is_exactly_width_times_height() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();

    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["format"], "raw");

    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    let (_, _, payload) = parse_frame(&bytes);
    assert_eq!(payload.len(), (W * H) as usize, "raw frames are width*height Mono8 bytes");
}

#[actix_web::test]
async fn a_live_stream_skips_frames_with_lost_packets_and_keeps_going() {
    // Lost packets the camera can no longer resend: those frames never arrive whole. The stream
    // must drop them and carry on, and every frame it does send must be whole.
    let (_cam, mut srv) = live_server_with(FakeCameraConfig {
        gvsp_loss_probability: 0.2,
        resend_unavailable: true,
        ..Default::default()
    })
    .await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(_) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };

    let mut last_dropped = 0;
    for _ in 0..20 {
        let ws::Frame::Binary(bytes) = next_frame!(framed) else {
            panic!("frames are binary messages");
        };
        let (_, dropped, payload) = parse_frame(&bytes);
        assert_eq!(payload.len(), (W * H) as usize);
        // The fake's gradient steps by one (mod 255) along a row; a zero-filled gap breaks it.
        assert_mono8_gradient(payload);
        last_dropped = dropped;
    }
    assert!(last_dropped > 0, "no frame lost a packet");
}

#[actix_web::test]
async fn a_mono16_raw_live_frame_is_two_bytes_per_pixel() {
    let (_cam, mut srv) = live_server().await;
    let mut framed =
        srv.ws_at("/api/v1/devices/0/stream/live?format=raw&pixel_depth=mono16").await.unwrap();

    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["pixel_format"], "Mono16");
    assert_eq!(info["bit_depth"], 16, "{info}");

    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    let (_, _, payload) = parse_frame(&bytes);
    assert_eq!(payload.len(), (W * H * 2) as usize, "16-bit raw is two bytes per pixel");
    let max = payload.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).max().unwrap();
    assert!(max > 255, "little-endian u16 pixels should use more than 8 bits, max {max}");
}

#[actix_web::test]
async fn a_zstd_live_stream_sends_numbered_frames_that_decode_to_the_pixels() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=zstd").await.unwrap();

    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["format"], "zstd");
    assert_eq!(info["bit_depth"], 8);

    // Frames are encoded several at a time, so this is also where their order is checked.
    for expected in 0..10u32 {
        let ws::Frame::Binary(bytes) = next_frame!(framed) else {
            panic!("frames are binary messages");
        };
        let (frame_number, _, payload) = parse_frame(&bytes);
        assert_eq!(frame_number, expected, "frame numbers start at 0 and count up");
        let pixels = frame_codec::decode_zstd(payload, W, H, &PixelLayout::mono8()).expect("not a zstd frame");
        assert_mono8_gradient(&pixels);
    }
}

#[actix_web::test]
async fn a_mono16_zstd_live_frame_decodes_to_two_bytes_per_pixel() {
    let (_cam, mut srv) = live_server().await;
    let mut framed =
        srv.ws_at("/api/v1/devices/0/stream/live?format=zstd&pixel_depth=mono16").await.unwrap();

    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!((info["format"].as_str(), info["bit_depth"].as_u64()), (Some("zstd"), Some(16)), "{info}");

    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    let layout = PixelLayout::from_pixel_format("Mono16");
    let pixels = frame_codec::decode_zstd(parse_frame(&bytes).2, W, H, &layout).expect("not a zstd frame");
    assert_mono16_gradient(&pixels);
}

#[actix_web::test]
async fn a_linescan3d_zstd_live_stream_decodes_to_range_values() {
    let (cam, mut srv) = live_server().await;
    poke_linescan3d(&cam);
    let mut framed =
        srv.ws_at("/api/v1/devices/0/stream/live?format=zstd&pixel_depth=mono16").await.unwrap();
    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["pixel_format"], "Coord3D_C16", "{info}");

    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    let layout = PixelLayout::from_pixel_format("Coord3D_C16");
    let pixels = frame_codec::decode_zstd(parse_frame(&bytes).2, W, H, &layout).expect("not a zstd frame");
    assert_profile_values(&pixels);
}

#[actix_web::test]
async fn a_linescan3d_raw_live_stream_announces_coord3d_c16() {
    let (cam, mut srv) = live_server().await;
    poke_linescan3d(&cam);
    let mut framed =
        srv.ws_at("/api/v1/devices/0/stream/live?format=raw&pixel_depth=mono16").await.unwrap();

    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["pixel_format"], "Coord3D_C16", "{info}");
    assert_eq!(info["bit_depth"], 16, "{info}");

    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    let (_, _, payload) = parse_frame(&bytes);
    assert_eq!(payload.len(), (W * H * 2) as usize, "the whole range image, not half of it");
    assert_profile_values(payload);
}

#[actix_web::test]
async fn a_scan_type_switch_during_a_live_stream_reannounces_coord3d_c16() {
    let (_cam, mut srv) = live_server().await;
    let mut framed =
        srv.ws_at("/api/v1/devices/0/stream/live?format=raw&pixel_depth=mono16").await.unwrap();
    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["pixel_format"], "Mono16");

    let resp =
        srv.put("/api/v1/devices/0/gc/feature/DeviceScanType?value=Linescan3D").send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // The device moved PixelFormat, so the stream restarts and says what it now delivers.
    let info = loop {
        match next_frame!(framed) {
            ws::Frame::Text(bytes) => break serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            ws::Frame::Binary(bytes) => assert_eq!(parse_frame(&bytes).2.len(), (W * H * 2) as usize),
            other => panic!("unexpected {other:?}"),
        }
    };
    assert_eq!(info["pixel_format"], "Coord3D_C16", "{info}");
    assert_eq!(info["bit_depth"], 16, "{info}");
    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    assert_profile_values(parse_frame(&bytes).2);
}

#[actix_web::test]
async fn the_fps_limit_spaces_frames_out_and_counts_the_ones_it_drops() {
    let (_cam, mut srv) = live_server().await;
    // The fake camera produces a frame every 10ms; at 5 fps the limiter must discard most of them.
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw&fps=5").await.unwrap();

    let ws::Frame::Text(_) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };

    let started = Instant::now();
    let mut last_dropped = 0;
    for expected in 0..3u32 {
        let ws::Frame::Binary(bytes) = next_frame!(framed) else {
            panic!("frames are binary messages");
        };
        let (frame_number, dropped, _) = parse_frame(&bytes);
        assert_eq!(frame_number, expected);
        last_dropped = dropped;
    }
    let elapsed = started.elapsed();

    // Two 200ms gaps between three frames. Generous lower bound — this only has to prove the
    // limiter is throttling at all, not that it is precise.
    assert!(
        elapsed >= Duration::from_millis(300),
        "3 frames at 5 fps arrived in {elapsed:?}; the limit is not being applied"
    );
    assert!(
        last_dropped > 0,
        "frames skipped by the fps limit must show up in the dropped counter"
    );
}

#[actix_web::test]
async fn closing_the_socket_returns_the_camera_to_the_store() {
    let (_cam, mut srv) = live_server().await;
    {
        let mut framed = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
        let _ = next_frame!(framed);
        let _ = next_frame!(framed);
        framed.send(ws::Message::Close(None)).await.unwrap();
    }

    // The acquisition loop only notices the closed socket between buffer pops, so the camera comes
    // back a moment later. The close announces that release, so the very next request waits for it
    // instead of being refused as busy — no retry loop needed on the client.
    let resp = srv.get("/api/v1/devices/0/stream/frame/jpeg").send().await.unwrap();
    assert_eq!(resp.status(), 200, "the camera was not handed over after the stream closed");
}

#[actix_web::test]
async fn a_stream_reopened_right_after_closing_gets_the_camera() {
    let (_cam, mut srv) = live_server().await;
    // Several rounds, since a lost race only shows up some of the time.
    for round in 0..5 {
        let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
        let ws::Frame::Text(_) = next_frame!(framed) else {
            panic!("round {round}: expected the stream info, the camera was refused");
        };
        let ws::Frame::Binary(_) = next_frame!(framed) else {
            panic!("round {round}: frames are binary messages");
        };
        // Close and reopen with no pause, exactly as a client changing a stream setting does.
        framed.send(ws::Message::Close(None)).await.unwrap();
    }
}

#[actix_web::test]
async fn a_cancelled_burst_hands_the_camera_straight_to_the_next_request() {
    let (_cam, mut srv) = live_server().await;

    let resp = srv
        .post("/api/v1/devices/0/grab/jobs")
        .send_json(&serde_json::json!({"count": 500, "format": "raw"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 202);
    let body: serde_json::Value = { let mut resp = resp; resp.json().await.unwrap() };
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{}", body["job_id"].as_str().unwrap());

    // Wait until it is really capturing, i.e. holds the camera.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let info: serde_json::Value = srv.get(&job_uri).send().await.unwrap().json().await.unwrap();
        if info["captured_count"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the burst never started capturing: {info}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert_eq!(srv.delete(&job_uri).send().await.unwrap().status(), 204);
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    let ws::Frame::Text(_) = next_frame!(framed) else {
        panic!("expected the stream info: the camera was not handed over after the cancel");
    };
}

#[actix_web::test]
async fn the_stream_error_endpoint_reports_state_after_the_socket_is_gone() {
    let (_cam, mut srv) = live_server().await;

    let mut resp = srv.get("/api/v1/devices/0/stream/error").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json",
        "clients parse this as JSON"
    );

    let body: serde_json::Value = resp.json::<serde_json::Value>().await.unwrap();
    for key in ["last_error", "timestamp", "active_stream", "viewers"] {
        assert!(body.get(key).is_some(), "missing `{key}`: {body}");
    }
    // Nothing has streamed on this device yet.
    assert_eq!(body["active_stream"], false);
    assert_eq!(body["viewers"], 0);
    assert!(body["last_error"].is_null());
    assert!(body["timestamp"].is_null());

    {
        let mut framed = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
        let _ = next_frame!(framed);
        let body: serde_json::Value = srv
            .get("/api/v1/devices/0/stream/error")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["active_stream"], true, "a live socket is an active stream");
        assert_eq!(body["viewers"], 1);
        framed.send(ws::Message::Close(None)).await.unwrap();
    }

    // The flag clears once the acquisition loop has wound down, which happens a beat after the
    // socket closes.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut body = serde_json::Value::Null;
    while Instant::now() < deadline {
        body = srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
        if body["active_stream"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(body["active_stream"], false, "the stream was never marked inactive");
    // A client hanging up is not an error, so nothing should have been recorded.
    assert!(body["last_error"].is_null(), "a normal close must not record an error: {body}");
}

#[actix_web::test]
async fn disconnect_during_live_closes_1001_and_frees_camera() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    assert!(matches!(next_frame!(framed), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(framed), ws::Frame::Binary(_)));

    // Same answer as without a stream: the disconnect waits for the stream to stop.
    let mut resp = srv.put("/api/v1/devices/0/disconnect").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body, serde_json::json!({"closed": true, "members": 0}), "an anonymous stream doesn't hold it");
    let connected: serde_json::Value =
        srv.get("/api/v1/devices/connected").send().await.unwrap().json().await.unwrap();
    assert_eq!(connected, serde_json::json!([]), "the device is closed");

    // The socket is told why, as a going-away close rather than an error.
    let close = loop {
        match next_frame!(framed) {
            ws::Frame::Close(reason) => break reason.expect("the close carries a reason"),
            ws::Frame::Binary(_) | ws::Frame::Ping(_) | ws::Frame::Pong(_) => {}
            other => panic!("unexpected frame after the disconnect: {other:?}"),
        }
    };
    assert_eq!(close.code, ws::CloseCode::Away);
    assert_eq!(close.description.as_deref(), Some("device disconnected"));
    let body: serde_json::Value =
        srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
    assert!(body["last_error"].is_null(), "a disconnect is not a stream error: {body}");

    // The camera was let go: the id connects again and streams.
    assert_eq!(srv.put("/api/v1/devices/0/connect").send().await.unwrap().status(), 200);
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    assert!(matches!(next_frame!(framed), ws::Frame::Text(_)), "the reconnected device streams");
    assert!(matches!(next_frame!(framed), ws::Frame::Binary(_)));
    framed.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_second_stream_joins_the_first() {
    let (_cam, mut srv) = live_server().await;
    let mut first = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    assert!(matches!(next_frame!(first), ws::Frame::Text(_)));
    assert!(matches!(next_frame!(first), ws::Frame::Binary(_)));

    // Several viewers per device: the second socket joins the running capture.
    let mut second = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(info) = next_frame!(second) else { panic!("a joiner is told the geometry first") };
    let info: serde_json::Value = serde_json::from_slice(&info).unwrap();
    assert_eq!(info["format"], "raw", "its own format: {info}");
    let ws::Frame::Binary(bytes) = next_frame!(second) else { panic!("then frames") };
    assert_eq!(parse_frame(&bytes).0, 0, "its own frame numbers");
    let body: serde_json::Value =
        srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
    assert_eq!((body["active_stream"].clone(), body["viewers"].clone()), (serde_json::json!(true), serde_json::json!(2)), "{body}");

    // One leaving leaves the other alone: it keeps delivering, and is still reported.
    second.send(ws::Message::Close(None)).await.unwrap();
    let before = loop {
        if let ws::Frame::Binary(bytes) = next_frame!(first) {
            break parse_frame(&bytes).0;
        }
    };
    let after = loop {
        if let ws::Frame::Binary(bytes) = next_frame!(first) {
            break parse_frame(&bytes).0;
        }
    };
    assert!(after > before, "frame numbers keep counting: {before} then {after}");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let body = loop {
        let body: serde_json::Value =
            srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
        if body["viewers"] == 1 || std::time::Instant::now() > deadline {
            break body;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!((body["active_stream"].clone(), body["viewers"].clone()), (serde_json::json!(true), serde_json::json!(1)), "{body}");
    assert_eq!(body["last_error"], serde_json::Value::Null, "joining is no error: {body}");

    first.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_feature_write_during_a_live_stream_is_applied_and_the_stream_continues() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(_) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let ws::Frame::Binary(_) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };

    let started = Instant::now();
    let resp = srv.put("/api/v1/devices/0/gc/feature/ExposureTime?value=2222").send().await.unwrap();
    assert_eq!(resp.status(), 200, "writes are carried out inside the stream, not refused as busy");
    let mut resp = srv.get("/api/v1/devices/0/gc/feature/ExposureTime").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(String::from_utf8_lossy(&resp.body().await.unwrap()), "2222");
    let resp = srv
        .post("/api/v1/devices/0/gc/features/state")
        .send_json(&serde_json::json!({"names": ["ExposureTime"]}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(srv.post("/api/v1/devices/0/gc/command/TriggerSoftware").send().await.unwrap().status(), 200);
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());

    // PixelFormat belongs to the stream while it runs.
    let resp = srv.put("/api/v1/devices/0/gc/feature/PixelFormat?value=3").send().await.unwrap();
    assert_eq!(resp.status(), 500);

    // Frames keep coming, with the announced geometry.
    for _ in 0..3 {
        let ws::Frame::Binary(bytes) = next_frame!(framed) else {
            panic!("no geometry change, so no new stream info");
        };
        assert_eq!(parse_frame(&bytes).2.len(), (W * H) as usize);
    }
}

#[actix_web::test]
async fn a_geometry_change_during_a_raw_live_stream_reannounces() {
    let (_cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(_) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };

    let resp = srv.put("/api/v1/devices/0/gc/feature/Width?value=32").send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // Frames of the old geometry may still be in flight; then a new text message, then only new
    // frames.
    let info = loop {
        match next_frame!(framed) {
            ws::Frame::Text(bytes) => break serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            ws::Frame::Binary(bytes) => assert_eq!(parse_frame(&bytes).2.len(), (W * H) as usize),
            other => panic!("unexpected {other:?}"),
        }
    };
    assert_eq!(info["width"], 32);
    assert_eq!(info["height"], H);
    let ws::Frame::Binary(bytes) = next_frame!(framed) else {
        panic!("frames are binary messages");
    };
    assert_eq!(parse_frame(&bytes).2.len(), (32 * H) as usize);
}

#[actix_web::test]
async fn feature_requests_during_a_burst_are_still_busy() {
    let (_cam, srv) = live_server().await;
    let resp = srv
        .post("/api/v1/devices/0/grab/jobs")
        .send_json(&serde_json::json!({"count": 500, "format": "raw"}))
        .await
        .unwrap();
    assert_eq!(resp.status(), 202);
    let body: serde_json::Value = { let mut resp = resp; resp.json().await.unwrap() };
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{}", body["job_id"].as_str().unwrap());

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let info: serde_json::Value = srv.get(&job_uri).send().await.unwrap().json().await.unwrap();
        if info["captured_count"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the burst never started capturing: {info}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // A burst is a measurement: nothing may change the camera under it.
    let mut resp = srv.put("/api/v1/devices/0/gc/feature/ExposureTime?value=2222").send().await.unwrap();
    assert_eq!(resp.status(), 500);
    let body = String::from_utf8_lossy(&resp.body().await.unwrap()).to_string();
    assert!(body.contains("Busy"), "got {body}");
    let mut resp = srv.post("/api/v1/devices/0/stream/packet-size/auto").send().await.unwrap();
    assert_eq!(resp.status(), 500);
    let body = String::from_utf8_lossy(&resp.body().await.unwrap()).to_string();
    assert!(body.contains("Busy"), "got {body}");

    assert_eq!(srv.delete(&job_uri).send().await.unwrap().status(), 204);
}

// ---------------------------------------------------------------------------------------------
// Stream packet size (GevSCPSPacketSize)
// ---------------------------------------------------------------------------------------------

const PACKET_SIZE_REG: u32 = aravis_port::core::bootstrap::offset::STREAM_CHANNEL_0_PACKET_SIZE;

#[actix_web::test]
async fn get_packet_size_returns_the_size_its_bounds_and_the_link() {
    let (_cam, ctx) = app_context().await;
    let app = service!(ctx);

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/devices/0/stream/packet-size").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["packet_size"], 1500, "{body}");
    assert_eq!((body["min"].clone(), body["max"].clone(), body["inc"].clone()), (576.into(), 9000.into(), 4.into()));
    assert_eq!(body["local_ip"], "127.0.0.1");
    assert!(body["interface"].is_string(), "{body}");
    // Reported where the OS tells it (Linux), null elsewhere; never missing.
    assert!(body["link_mtu"].is_u64() || body["link_mtu"].is_null(), "{body}");
}

#[actix_web::test]
async fn a_written_packet_size_is_used_by_grabs_and_kept() {
    let (cam, ctx) = app_context().await;
    let app = service!(ctx);

    let put = |value: &str| test::TestRequest::put().uri(&format!("/api/v1/devices/0/gc/feature/GevSCPSPacketSize?value={value}")).to_request();
    let resp = test::call_service(&app, put("900")).await;
    assert_eq!(resp.status(), 200);

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/devices/0/stream/frame/raw").to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(test::read_body(resp).await.len(), (W * H) as usize);
    assert_eq!(cam.peek_register(PACKET_SIZE_REG) & 0xffff, 900, "a grab must not overwrite the packet size");

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/devices/0/gc/feature/GevSCPSPacketSize").to_request()).await;
    assert_eq!(test::read_body(resp).await, "900");

    // Off the grid or out of bounds: refused with a reason, and nothing written.
    for (value, reason) in [("902", "multiple of 4"), ("100", "between 576 and 9000"), ("big", "GevSCPSPacketSize")] {
        let resp = test::call_service(&app, put(value)).await;
        assert_eq!(resp.status(), 500, "{value}");
        let body = String::from_utf8_lossy(&test::read_body(resp).await).to_string();
        assert!(body.contains(reason), "{value}: {body}");
    }
    assert_eq!(cam.peek_register(PACKET_SIZE_REG) & 0xffff, 900);
}

#[actix_web::test]
async fn auto_packet_size_finds_the_largest_size_that_arrives() {
    let (cam, ctx) = app_context_with(FakeCameraConfig {
        path_mtu: 4003,
        ..Default::default()
    })
    .await;
    let app = service!(ctx);
    // Connecting kept the camera's 1500: it gets through.
    assert_eq!(cam.peek_register(PACKET_SIZE_REG) & 0xffff, 1500);

    let resp = test::call_service(
        &app,
        test::TestRequest::post().uri("/api/v1/devices/0/stream/packet-size/auto").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["packet_size"], 4000, "{body}");
    assert_eq!(body["previous"], 1500, "{body}");
    assert_eq!(body["test_packets"], true, "{body}");
    assert!(body.get("link_mtu").is_some() && body.get("interface").is_some(), "{body}");
    assert_eq!(cam.peek_register(PACKET_SIZE_REG), 4000, "set, with don't-fragment restored");

    let resp = test::call_service(&app, test::TestRequest::get().uri("/api/v1/devices/0/stream/frame/raw").to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(test::read_body(resp).await.len(), (W * H) as usize);
}

#[actix_web::test]
async fn connecting_replaces_a_packet_size_that_does_not_arrive() {
    let (cam, _ctx) = app_context_with(FakeCameraConfig {
        packet_size: 8000,
        path_mtu: 1500,
        ..Default::default()
    })
    .await;
    assert_eq!(cam.peek_register(PACKET_SIZE_REG), 1500);
}

#[actix_web::test]
async fn a_packet_size_change_during_a_live_stream_reopens_the_channel() {
    let (cam, mut srv) = live_server().await;
    let mut framed = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(bytes) = next_frame!(framed) else {
        panic!("the first message must be the text stream info");
    };
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["packet_size"], 1500);

    // Each change is announced, and the frames after it are whole.
    for (request, expected) in [("put", 2000), ("auto", 9000)] {
        let resp = match request {
            "put" => srv.put(format!("/api/v1/devices/0/gc/feature/GevSCPSPacketSize?value={expected}")).send().await,
            _ => srv.post("/api/v1/devices/0/stream/packet-size/auto").send().await,
        };
        assert_eq!(resp.unwrap().status(), 200, "{request} is carried out inside the stream");

        let info = loop {
            match next_frame!(framed) {
                ws::Frame::Text(bytes) => break serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
                ws::Frame::Binary(bytes) => assert_eq!(parse_frame(&bytes).2.len(), (W * H) as usize),
                other => panic!("unexpected {other:?}"),
            }
        };
        assert_eq!(info["packet_size"], expected, "{info}");
        assert_eq!(info["width"], W);
        for _ in 0..3 {
            let ws::Frame::Binary(bytes) = next_frame!(framed) else {
                panic!("frames are binary messages");
            };
            assert_eq!(parse_frame(&bytes).2.len(), (W * H) as usize);
        }
        assert_eq!(cam.peek_register(PACKET_SIZE_REG) & 0xffff, expected as u32);
    }

    let mut resp = srv.get("/api/v1/devices/0/stream/packet-size").send().await.unwrap();
    assert_eq!(resp.status(), 200, "readable while live");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["packet_size"], 9000);
}
