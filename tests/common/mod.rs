//! Helpers shared by the integration targets that drive the HTTP API against the in-process fake
//! camera (`http_contract`, `burst_grab`, `webapp`). Each target pulls them in with
//! `#[macro_use] mod common;` and uses only some, hence the `allow`.
#![allow(dead_code, unused_macros)]

use std::sync::OnceLock;
use std::time::Duration;

use actix_web::{web, App};
use aravis_port_fakecamera::{feature, FakeCamera, FakeCameraConfig};
use rust_cam_serve::app_context::AppContext;
use rust_cam_serve::endpoints::config_endpoints;
use rust_cam_serve::maintenance;
use rust_cam_serve::server_config::RuntimeConfig;

/// The fake camera's frame size in every target.
pub const W: u32 = 64;
pub const H: u32 = 32;

/// Keep `GET /devices` off the real network: without this it broadcasts on every local interface
/// and costs a discovery timeout each. Set once per process, before any test builds an app.
pub fn confine_discovery_to_loopback() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        std::env::set_var("RACS_DISCOVERY_BIND", "127.0.0.1");
        std::env::set_var("RACS_DISCOVERY_TIMEOUT_MS", "50");
    });
}

/// A camera that delivers frames briskly.
pub fn streaming_camera() -> FakeCameraConfig {
    FakeCameraConfig { frame_period: Duration::from_millis(10), ..Default::default() }
}

/// A running fake camera plus an `AppContext` with that camera connected as device 0.
pub async fn app_context() -> (FakeCamera, AppContext) {
    app_context_with(FakeCameraConfig::default()).await
}

/// [`app_context`] with a camera configured from `cfg` (its frame period is always 10 ms).
pub async fn app_context_with(cfg: FakeCameraConfig) -> (FakeCamera, AppContext) {
    start_with_runtime(cfg, RuntimeConfig::default()).await
}

/// Sessions and the idle timeout in milliseconds: a session lives `session` without a heartbeat
/// (pinged every third of that), an unused device closes after `idle`, and the sweep runs every
/// 20 ms.
pub fn fast_runtime(session: Duration, idle: Option<Duration>) -> RuntimeConfig {
    RuntimeConfig {
        session_timeout: session,
        session_timeout_min: Duration::from_millis(10),
        device_idle_timeout: idle,
        sweep_interval: Duration::from_millis(20),
        ..RuntimeConfig::default()
    }
}

/// [`app_context_with`] on `runtime`, with the maintenance sweep running (the other helpers leave
/// it off, as the 0.3 server had none).
pub async fn app_context_with_runtime(cfg: FakeCameraConfig, runtime: RuntimeConfig) -> (FakeCamera, AppContext) {
    let (camera, ctx) = start_with_runtime(cfg, runtime).await;
    maintenance::spawn(ctx.clone());
    (camera, ctx)
}

async fn start_with_runtime(cfg: FakeCameraConfig, runtime: RuntimeConfig) -> (FakeCamera, AppContext) {
    confine_discovery_to_loopback();

    let camera = FakeCamera::start(FakeCameraConfig {
        frame_period: Duration::from_millis(10),
        ..cfg
    })
    .expect("failed to start fake camera");
    camera.poke_register(feature::WIDTH, W);
    camera.poke_register(feature::HEIGHT, H);
    camera.poke_register(feature::ACQUISITION_ACTIVE, 1);

    let ctx = AppContext::new(runtime).await;
    ctx.dev_ctrl.connect_by_addr(0, camera.local_addr(), None).await.unwrap();
    (camera, ctx)
}

/// The routes exactly as `main` mounts them, so paths and scope come from the real wiring.
pub fn api(ctx: AppContext) -> impl FnOnce(&mut web::ServiceConfig) {
    move |cfg| {
        cfg.app_data(web::Data::new(ctx))
            .service(web::scope("/api/v1").configure(config_endpoints));
    }
}

/// Build the service exactly as `main` does, in-process (no socket, so no WebSocket upgrade).
macro_rules! service {
    ($ctx:expr) => {
        ::actix_web::test::init_service(::actix_web::App::new().configure($crate::common::api($ctx))).await
    };
}

// ---------------------------------------------------------------------------------------------
// Live streams. These need a real bound server: `test::init_service` drives the router in-process
// and cannot perform an HTTP upgrade, so the socket tests run against `actix_test::start` instead.
// ---------------------------------------------------------------------------------------------

/// A running fake camera plus a live server exposing the same routes as `main`.
pub async fn live_server() -> (FakeCamera, actix_test::TestServer) {
    live_server_with(FakeCameraConfig::default()).await
}

/// [`live_server`] with a camera configured from `cfg`.
pub async fn live_server_with(cfg: FakeCameraConfig) -> (FakeCamera, actix_test::TestServer) {
    let (camera, ctx) = app_context_with(cfg).await;
    let server = actix_test::start(move || App::new().configure(api(ctx.clone())));
    (camera, server)
}

/// [`live_server_with`] on `runtime`, also handing back the context so a test can look inside.
pub async fn live_server_with_runtime(
    cfg: FakeCameraConfig,
    runtime: RuntimeConfig,
) -> (FakeCamera, AppContext, actix_test::TestServer) {
    let (camera, ctx) = app_context_with_runtime(cfg, runtime).await;
    let served = ctx.clone();
    let server = actix_test::start(move || App::new().configure(api(served.clone())));
    (camera, ctx, server)
}

/// Next frame off the socket, or a failed test — never a hang.
macro_rules! next_frame {
    ($framed:expr) => {
        ::tokio::time::timeout(::std::time::Duration::from_secs(10), ::futures::StreamExt::next(&mut $framed))
            .await
            .expect("timed out waiting for a websocket frame")
            .expect("the socket closed before sending a frame")
            .expect("websocket protocol error")
    };
}

/// `[u32 frame_number][u32 frames_dropped][image]`, both counters little-endian.
pub fn parse_frame(bytes: &[u8]) -> (u32, u32, &[u8]) {
    assert!(bytes.len() > 8, "frame message is shorter than its header");
    (
        u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
        u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        &bytes[8..],
    )
}

/// The fake's Mono8 gradient: each pixel one more (mod 255) than its left neighbour.
pub fn assert_mono8_gradient(pixels: &[u8]) {
    for row in pixels.chunks(W as usize) {
        for pair in row.windows(2) {
            assert_eq!(pair[1], ((pair[0] as u32 + 1) % 255) as u8, "not the fake's gradient");
        }
    }
}

/// The fake's Mono16 gradient: each pixel 8 more (wrapping) than its left neighbour.
pub fn assert_mono16_gradient(pixels: &[u8]) {
    let values: Vec<u16> = pixels.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    for row in values.chunks(W as usize) {
        for pair in row.windows(2) {
            assert_eq!(pair[1], pair[0].wrapping_add(8), "not the fake's gradient");
        }
    }
    assert!(values.iter().any(|&v| v > 255), "16-bit pixels should use more than 8 bits");
}

// ---------------------------------------------------------------------------------------------
// Burst grab jobs
// ---------------------------------------------------------------------------------------------

/// Start a burst job on device 0, asserting the accepted-response contract, and return its id.
macro_rules! start_job {
    ($app:expr, $body:expr) => {{
        let resp = ::actix_web::test::call_service(
            &$app,
            ::actix_web::test::TestRequest::post()
                .uri("/api/v1/devices/0/grab/jobs")
                .set_json($body)
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 202, "a started job is accepted, not completed");
        assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");

        let body: ::serde_json::Value = ::actix_web::test::read_body_json(resp).await;
        assert_eq!(body["device_id"], 0);
        assert_eq!(body["status"], "pending", "the capture has not taken the camera yet");
        body["job_id"].as_str().expect("missing `job_id`").to_string()
    }};
}

/// `GET $uri` as `(status, JSON body)`.
macro_rules! get_json {
    ($app:expr, $uri:expr) => {{
        let resp = ::actix_web::test::call_service(
            &$app,
            ::actix_web::test::TestRequest::get().uri($uri).to_request(),
        )
        .await;
        let status = resp.status().as_u16();
        let body: ::serde_json::Value = ::actix_web::test::read_body_json(resp).await;
        (status, body)
    }};
}

/// Poll a job until it leaves `pending`/`running`, then return its status document. Bounded, so a
/// job that never finishes fails the test instead of hanging it.
macro_rules! await_job {
    ($app:expr, $uri:expr) => {{
        let deadline = ::std::time::Instant::now() + ::std::time::Duration::from_secs(20);
        loop {
            let resp = ::actix_web::test::call_service(
                &$app,
                ::actix_web::test::TestRequest::get().uri($uri).to_request(),
            )
            .await;
            assert_eq!(resp.status(), 200);
            let info: ::serde_json::Value = ::actix_web::test::read_body_json(resp).await;
            if info["status"] != "pending" && info["status"] != "running" {
                break info;
            }
            assert!(::std::time::Instant::now() < deadline, "the job never reached a terminal state: {info}");
            ::tokio::time::sleep(::std::time::Duration::from_millis(50)).await;
        }
    }};
}

/// Poll a job's status until `pred` holds, or fail the test. Never sleeps blind.
macro_rules! await_status {
    ($app:expr, $uri:expr, $timeout:expr, $pred:expr) => {{
        let deadline = ::std::time::Instant::now() + $timeout;
        loop {
            let (status, info) = get_json!($app, $uri);
            assert_eq!(status, 200, "the job disappeared: {info}");
            let pred: fn(&::serde_json::Value) -> bool = $pred;
            if pred(&info) {
                break info;
            }
            assert!(::std::time::Instant::now() < deadline, "condition never held; last status was {info}");
            ::tokio::time::sleep(::std::time::Duration::from_millis(25)).await;
        }
    }};
}

// ---------------------------------------------------------------------------------------------
// Sessions and events
// ---------------------------------------------------------------------------------------------

/// Start a session named `name` on a live server and return its `(session_id, client_id)`.
pub async fn open_session(srv: &actix_test::TestServer, name: &str) -> (String, String) {
    let mut resp = srv
        .post("/api/v1/sessions")
        .send_json(&serde_json::json!({ "name": name }))
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    (body["session_id"].as_str().unwrap().to_string(), body["client_id"].as_str().unwrap().to_string())
}

/// Start a session on an in-process service and return its `session_id`.
macro_rules! session {
    ($app:expr) => {{
        let resp = ::actix_web::test::call_service(
            &$app,
            ::actix_web::test::TestRequest::post().uri("/api/v1/sessions").to_request(),
        )
        .await;
        assert_eq!(resp.status(), 201);
        let body: ::serde_json::Value = ::actix_web::test::read_body_json(resp).await;
        body["session_id"].as_str().unwrap().to_string()
    }};
}

/// The next JSON message on an events (or live) socket, answering the server's pings on the way
/// as a WebSocket client does.
macro_rules! next_event {
    ($framed:expr) => {{
        loop {
            match next_frame!($framed) {
                ::awc::ws::Frame::Text(bytes) => break ::serde_json::from_slice::<::serde_json::Value>(&bytes).unwrap(),
                ::awc::ws::Frame::Ping(bytes) => {
                    ::futures::SinkExt::send(&mut $framed, ::awc::ws::Message::Pong(bytes)).await.unwrap();
                }
                other => panic!("expected an event, got {other:?}"),
            }
        }
    }};
}

/// Skip events until one satisfies `pred`, and return it. Fails the test after 10 s.
macro_rules! await_event {
    ($framed:expr, $pred:expr) => {{
        let deadline = ::std::time::Instant::now() + ::std::time::Duration::from_secs(10);
        let pred: fn(&::serde_json::Value) -> bool = $pred;
        loop {
            let event = next_event!($framed);
            if pred(&event) {
                break event;
            }
            assert!(::std::time::Instant::now() < deadline, "the event never came; last was {event}");
        }
    }};
}

/// `(status, JSON body)` of a request on a live server, sent with session `$session`.
macro_rules! send_as {
    ($req:expr, $session:expr) => {{
        let mut resp = $req.insert_header(("X-Racs-Session", $session)).send().await.unwrap();
        let status = resp.status().as_u16();
        let body: ::serde_json::Value = resp.json().await.unwrap_or(::serde_json::Value::Null);
        (status, body)
    }};
    ($req:expr, $session:expr, $json:expr) => {{
        let mut resp = $req.insert_header(("X-Racs-Session", $session)).send_json(&$json).await.unwrap();
        let status = resp.status().as_u16();
        let body: ::serde_json::Value = resp.json().await.unwrap_or(::serde_json::Value::Null);
        (status, body)
    }};
}

/// The close frame a socket ends with, skipping frames still in flight.
macro_rules! close_of {
    ($framed:expr) => {
        loop {
            match next_frame!($framed) {
                ::awc::ws::Frame::Close(reason) => break reason.expect("the close carries a reason"),
                ::awc::ws::Frame::Text(_)
                | ::awc::ws::Frame::Binary(_)
                | ::awc::ws::Frame::Ping(_)
                | ::awc::ws::Frame::Pong(_) => {}
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    };
}
