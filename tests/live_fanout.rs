//! Several live viewers per device (phase 5 of `specs/multi-user.md`): one capture, fanned out to
//! every socket, each with its own format, frame rate and counters.

use std::time::{Duration, Instant};

#[macro_use]
mod common;
use common::*;

use aravis_port_fakecamera::{feature, FakeCameraConfig};
use awc::ws;
use futures::SinkExt;
use rust_cam_serve::controller::frame_codec;
use rust_cam_serve::models::pixel::PixelLayout;
use rust_cam_serve::server_config::RuntimeConfig;
use serde_json::{json, Value};

/// The next StreamInfo on a live socket, skipping frames still on their way from before it.
macro_rules! next_info {
    ($framed:expr) => {
        loop {
            if let ws::Frame::Text(bytes) = next_frame!($framed) {
                break serde_json::from_slice::<Value>(&bytes).unwrap();
            }
        }
    };
}

/// The next frame message on a live socket as `(frame_number, dropped, payload)`, skipping
/// StreamInfo.
macro_rules! next_image {
    ($framed:expr) => {
        loop {
            match next_frame!($framed) {
                ws::Frame::Binary(bytes) => {
                    let (n, dropped, payload) = parse_frame(&bytes);
                    break (n, dropped, payload.to_vec());
                }
                ws::Frame::Text(_) | ws::Frame::Ping(_) | ws::Frame::Pong(_) => {}
                other => panic!("expected a frame, got {other:?}"),
            }
        }
    };
}

/// `GET …/stream/error` until `pred` holds, or fail after 5 s.
async fn await_stream_state(srv: &actix_test::TestServer, pred: fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let body: Value = srv.get("/api/v1/devices/0/stream/error").send().await.unwrap().json().await.unwrap();
        if pred(&body) {
            return body;
        }
        assert!(Instant::now() < deadline, "the stream state never matched: {body}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A baseline JPEG's `(width, height)`, read from its SOF0 header.
fn jpeg_size(jpeg: &[u8]) -> (u32, u32) {
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");
    assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "a JPEG ends with EOI");
    let sof = jpeg.windows(2).position(|m| m == [0xFF, 0xC0]).expect("no SOF0 header");
    let be = |i: usize| u16::from_be_bytes([jpeg[sof + i], jpeg[sof + i + 1]]) as u32;
    (be(7), be(5))
}

#[actix_web::test]
async fn viewers_with_different_formats_each_get_correct_frames() {
    let (_cam, mut srv) = live_server().await;
    let mut jpeg = srv.ws_at("/api/v1/devices/0/stream/live?format=jpeg").await.unwrap();
    let mut raw = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let mut zstd = srv.ws_at("/api/v1/devices/0/stream/live?format=zstd").await.unwrap();

    for (framed, format) in [(&mut jpeg, "jpeg"), (&mut raw, "raw"), (&mut zstd, "zstd")] {
        let info = next_info!(*framed);
        assert_eq!(info["format"], format, "each viewer is told its own format: {info}");
        assert_eq!((info["width"].clone(), info["height"].clone()), (json!(W), json!(H)));
    }
    for _ in 0..3 {
        let (_, _, image) = next_image!(jpeg);
        assert_eq!(jpeg_size(&image), (W, H));
        let (_, _, image) = next_image!(raw);
        assert_eq!(image.len(), (W * H) as usize);
        assert_mono8_gradient(&image);
        let (_, _, image) = next_image!(zstd);
        assert_mono8_gradient(&frame_codec::decode_zstd(&image, W, H, &PixelLayout::mono8()).unwrap());
    }

    for framed in [&mut jpeg, &mut raw, &mut zstd] {
        framed.send(ws::Message::Close(None)).await.unwrap();
    }
}

#[actix_web::test]
async fn a_late_joiner_gets_stream_info_before_its_first_frame() {
    let (_cam, mut srv) = live_server().await;
    let mut first = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    next_info!(first);
    for _ in 0..5 {
        next_image!(first);
    }

    let mut late = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let ws::Frame::Text(info) = next_frame!(late) else { panic!("the first message is the stream info") };
    let info: Value = serde_json::from_slice(&info).unwrap();
    assert_eq!(info["width"], W);
    let (n, _, _) = next_image!(late);
    assert_eq!(n, 0, "a joiner's frame numbers start at 0");

    first.send(ws::Message::Close(None)).await.unwrap();
    late.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_slow_viewer_does_not_slow_the_other_down() {
    let (cam, mut srv) = live_server().await;
    // Frames big enough that a viewer not reading backs up soon (and within awc's 64 KiB limit).
    cam.poke_register(feature::WIDTH, 256);
    cam.poke_register(feature::HEIGHT, 240);
    let mut slow = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let mut fast = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    next_info!(fast);

    // The camera delivers every 10 ms. Reading 100 frames takes about a second, unless the slow
    // viewer, which reads nothing, holds the capture back.
    let started = Instant::now();
    let mut fast_dropped = 0;
    for _ in 0..100 {
        fast_dropped = next_image!(fast).1;
    }
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(4), "100 frames took {elapsed:?}");

    // The slow viewer lost frames meanwhile; the first ones it reads were queued before that.
    let mut slow_dropped = 0;
    for _ in 0..200 {
        if let ws::Frame::Binary(bytes) = next_frame!(slow) {
            slow_dropped = parse_frame(&bytes).1;
            if slow_dropped > fast_dropped {
                break;
            }
        }
    }
    assert!(slow_dropped > fast_dropped, "the slow viewer dropped {slow_dropped}, the fast one {fast_dropped}");

    fast.send(ws::Message::Close(None)).await.unwrap();
    slow.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn one_viewer_leaving_does_not_stop_the_other() {
    let (_cam, mut srv) = live_server().await;
    let mut stays = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let mut leaves = srv.ws_at("/api/v1/devices/0/stream/live?format=jpeg").await.unwrap();
    next_image!(leaves);
    await_stream_state(&srv, |s| s["viewers"] == 2).await;

    leaves.send(ws::Message::Close(None)).await.unwrap();
    await_stream_state(&srv, |s| s["viewers"] == 1 && s["active_stream"] == true).await;
    let (first, _, _) = next_image!(stays);
    let mut last = first;
    for _ in 0..20 {
        last = next_image!(stays).0;
    }
    assert!(last > first, "the capture keeps running: {first} then {last}");

    stays.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn the_last_viewer_leaving_frees_the_camera_for_a_burst() {
    let (_cam, mut srv) = live_server().await;
    let mut a = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    let mut b = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    next_image!(a);
    next_image!(b);

    a.send(ws::Message::Close(None)).await.unwrap();
    b.send(ws::Message::Close(None)).await.unwrap();
    // Right away: the burst waits for the camera rather than failing as busy.
    let mut resp =
        srv.post("/api/v1/devices/0/grab/jobs").send_json(&json!({"count": 3, "format": "raw"})).await.unwrap();
    assert_eq!(resp.status(), 202);
    let job: Value = resp.json().await.unwrap();
    let uri = format!("/api/v1/devices/0/grab/jobs/{}", job["job_id"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        let status: Value = srv.get(&uri).send().await.unwrap().json().await.unwrap();
        if status["status"] != "pending" && status["status"] != "running" {
            break status;
        }
        assert!(Instant::now() < deadline, "the burst never finished: {status}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(status["status"], "completed", "{status}");
}

#[actix_web::test]
async fn a_mono16_joiner_on_a_mono8_capture_gets_the_running_depth() {
    let (_cam, mut srv) = live_server().await;
    let mut starter = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    assert_eq!(next_info!(starter)["bit_depth"], 8);

    let mut joiner = srv.ws_at("/api/v1/devices/0/stream/live?format=raw&pixel_depth=mono16").await.unwrap();
    let info = next_info!(joiner);
    assert_eq!((info["bit_depth"].clone(), info["pixel_format"].clone()), (json!(8), json!("Mono8")), "{info}");
    let (_, _, image) = next_image!(joiner);
    assert_eq!(image.len(), (W * H) as usize, "one byte per pixel, as announced");

    starter.send(ws::Message::Close(None)).await.unwrap();
    joiner.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn a_write_during_the_stream_is_announced_to_every_viewer() {
    let (_cam, mut srv) = live_server().await;
    let mut raw = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    let mut jpeg = srv.ws_at("/api/v1/devices/0/stream/live?format=jpeg").await.unwrap();
    next_info!(raw);
    next_info!(jpeg);

    let resp = srv.put("/api/v1/devices/0/gc/feature/Width?value=32").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    for (framed, format) in [(&mut raw, "raw"), (&mut jpeg, "jpeg")] {
        let info = next_info!(*framed);
        assert_eq!((info["width"].clone(), info["format"].clone()), (json!(32), json!(format)), "{info}");
    }
    let (_, _, image) = next_image!(raw);
    assert_eq!(image.len(), (32 * H) as usize, "frames after it have the new geometry");
    let (_, _, image) = next_image!(jpeg);
    assert_eq!(jpeg_size(&image), (32, H));

    raw.send(ws::Message::Close(None)).await.unwrap();
    jpeg.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn the_device_state_counts_the_viewers() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (observer, _) = open_session(&srv, "observer").await;
    let mut events = srv.ws_at(&format!("/api/v1/events?session={observer}")).await.unwrap();
    assert_eq!(next_event!(events)["type"], "hello");

    let mut first = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    let state = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(state["stream"]["viewers"], 1);
    let mut second = srv.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    let state = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(state["stream"]["viewers"], 2);

    second.send(ws::Message::Close(None)).await.unwrap();
    let state = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(state["stream"]["viewers"], 1);
    first.send(ws::Message::Close(None)).await.unwrap();
    let state = await_event!(events, |e| e["type"] == "device_state" && e["cause"] == "stream");
    assert_eq!(state["stream"], Value::Null, "the last leave ends the stream");
    events.send(ws::Message::Close(None)).await.unwrap();
}

#[actix_web::test]
async fn forcing_exclusive_closes_the_other_viewers_and_keeps_the_forcers() {
    let (_cam, _ctx, mut srv) = live_server_with_runtime(FakeCameraConfig::default(), RuntimeConfig::default()).await;
    let (a, a_client) = open_session(&srv, "taker").await;
    let (b, _) = open_session(&srv, "starter").await;

    // b started the capture; a and an anonymous client joined it.
    let mut b_view = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={b}")).await.unwrap();
    next_image!(b_view);
    let mut a_view = srv.ws_at(&format!("/api/v1/devices/0/stream/live?format=raw&session={a}")).await.unwrap();
    next_image!(a_view);
    let mut anon_view = srv.ws_at("/api/v1/devices/0/stream/live?format=raw").await.unwrap();
    next_image!(anon_view);

    let (status, body) = send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive"}));
    assert_eq!(status, 409, "{body}");
    let (status, access) =
        send_as!(srv.put("/api/v1/devices/0/access"), a.as_str(), json!({"mode": "exclusive", "force": true}));
    assert_eq!(status, 200, "{access}");
    assert_eq!(access["holder"]["client_id"], a_client.as_str(), "the capture is a's now: {access}");

    for framed in [&mut b_view, &mut anon_view] {
        let close = close_of!(*framed);
        assert_eq!(close.code, ws::CloseCode::Other(4003));
        assert_eq!(close.description.as_deref(), Some("access revoked"));
    }
    // a's viewer keeps the same capture: its frame numbers carry on.
    let (before, _, _) = next_image!(a_view);
    let (after, _, _) = next_image!(a_view);
    assert!(after > before);
    await_stream_state(&srv, |s| s["viewers"] == 1).await;
    let (_, access) = send_as!(srv.get("/api/v1/devices/0/access"), a.as_str());
    assert_eq!(access["viewers"], 1, "{access}");

    a_view.send(ws::Message::Close(None)).await.unwrap();
}
