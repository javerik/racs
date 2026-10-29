//! Burst grab job lifecycles, against the in-process fake camera.
//!
//! [`http_contract`](../http_contract.rs) pins the per-route shapes; this target covers the things
//! that only show up over time — cancelling a job while it is capturing, the camera being held for
//! the whole run, images being collectable before the job ends, and a burst that fails because the
//! camera stops delivering frames.

use std::time::{Duration, Instant};

#[macro_use]
mod common;
use common::*;

use actix_web::test;
use aravis_port_fakecamera::FakeCameraConfig;

/// Long enough that a job is reliably still capturing when the test acts on it, and short enough
/// that "wait for it to finish" is never the fallback.
const LONG_BURST: u32 = 400;

#[actix_web::test]
async fn images_are_collectable_while_the_job_is_still_running() {
    let (_cam, ctx) = app_context_with(streaming_camera()).await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": LONG_BURST, "format": "raw"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");

    // The whole point of the split between status and images: a client does not have to wait for
    // the burst to end before it starts pulling frames.
    let info = await_status!(&app, &job_uri, Duration::from_secs(20), |info| {
        info["captured_count"].as_u64().unwrap_or(0) >= 2
    });
    assert_eq!(info["status"], "running", "a 400-frame burst cannot be done already: {info}");

    let (status, images) = get_json!(&app, &format!("{job_uri}/images"));
    assert_eq!(status, 200);
    let images = images.as_array().unwrap();
    assert!(images.len() >= 2, "the list must reflect progress, not only the final result");

    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(test::read_body(resp).await.len(), (W * H) as usize);

    // An index the burst has not reached yet is a 404, not an error and not a wait.
    let resp = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!("{job_uri}/images/{}", LONG_BURST - 1))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 404);

    test::call_service(&app, test::TestRequest::delete().uri(&job_uri).to_request()).await;
}

#[actix_web::test]
async fn cancelling_a_running_job_stops_it_and_gives_the_camera_back() {
    let (_cam, ctx) = app_context_with(streaming_camera()).await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": LONG_BURST, "format": "raw"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    await_status!(&app, &job_uri, Duration::from_secs(20), |info| {
        info["captured_count"].as_u64().unwrap_or(0) >= 1
    });

    let resp =
        test::call_service(&app, test::TestRequest::delete().uri(&job_uri).to_request()).await;
    assert_eq!(resp.status(), 204);
    // The record goes at once — there is no cancelled job left to inspect, by design.
    let resp = test::call_service(&app, test::TestRequest::get().uri(&job_uri).to_request()).await;
    assert_eq!(resp.status(), 404);

    // The real proof that the capture loop stopped: it let go of the camera. The loop notices the
    // cancel flag between buffer pops, so bound the wait rather than assuming it is instant.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut status = 0;
    while Instant::now() < deadline {
        let resp = test::call_service(
            &app,
            test::TestRequest::get().uri("/api/v1/devices/0/stream/frame/jpeg").to_request(),
        )
        .await;
        status = resp.status().as_u16();
        if status == 200 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(status, 200, "the cancelled job never released the camera");
}

#[actix_web::test]
async fn disconnect_cancels_running_burst() {
    let (_cam, ctx) = app_context_with(streaming_camera()).await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": LONG_BURST, "format": "raw"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    await_status!(&app, &job_uri, Duration::from_secs(20), |info| {
        info["captured_count"].as_u64().unwrap_or(0) >= 1
    });

    let resp = test::call_service(
        &app,
        test::TestRequest::put().uri("/api/v1/devices/0/disconnect").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);

    // Unlike a DELETE, the record stays, says why it ended, and keeps what it captured.
    let info = await_job!(app, &job_uri);
    assert_eq!(info["status"], "cancelled", "{info}");
    assert_eq!(info["error"], "device disconnected", "{info}");
    let captured = info["captured_count"].as_u64().unwrap();
    assert!(captured >= 1 && captured < LONG_BURST as u64, "{info}");
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200, "the images taken so far stay readable");
}

#[actix_web::test]
async fn a_second_job_on_a_busy_camera_fails_instead_of_being_rejected() {
    let (_cam, ctx) = app_context_with(streaming_camera()).await;
    let app = service!(ctx);

    let first = start_job!(app, serde_json::json!({"count": LONG_BURST, "format": "raw"}));
    let first_uri = format!("/api/v1/devices/0/grab/jobs/{first}");
    await_status!(&app, &first_uri, Duration::from_secs(20), |info| {
        info["captured_count"].as_u64().unwrap_or(0) >= 1
    });

    // The documented asymmetry: the camera is taken by the background task, not by the handler,
    // so a busy device still accepts the job and reports the problem through its status.
    let second = start_job!(app, serde_json::json!({"count": 1, "format": "raw"}));
    let second_uri = format!("/api/v1/devices/0/grab/jobs/{second}");
    let info = await_status!(&app, &second_uri, Duration::from_secs(20), |info| {
        info["status"] == "failed"
    });
    let error = info["error"].as_str().unwrap_or_default();
    assert!(error.contains("Busy"), "the failure must say the camera was in use, got {error:?}");
    assert_eq!(info["captured_count"], 0);

    // The first job was never disturbed by the second one's attempt.
    let (status, info) = get_json!(&app, &first_uri);
    assert_eq!(status, 200);
    assert_eq!(info["status"], "running", "{info}");

    test::call_service(&app, test::TestRequest::delete().uri(&first_uri).to_request()).await;
}

#[actix_web::test]
async fn a_camera_that_delivers_nothing_fails_the_job_and_its_index_is_gone() {
    // Every GVSP packet is dropped, so no frame ever reassembles and the per-frame grab timeout
    // is what ends the burst. This is the only failure mode the fake camera can be made to
    // produce, so the `on_failure`/`max_failures` policy itself is covered by unit tests in
    // `grab_ctrl.rs` rather than here.
    let (_cam, ctx) = app_context_with(FakeCameraConfig {
        frame_period: Duration::from_millis(10),
        gvsp_loss_probability: 1.0,
        ..Default::default()
    })
    .await;
    let app = service!(ctx);

    let job_id = start_job!(app, serde_json::json!({"count": 3, "format": "raw"}));
    let job_uri = format!("/api/v1/devices/0/grab/jobs/{job_id}");
    // One grab timeout (5s) plus slack; `abort` is the default, so the first failure ends it.
    let info = await_status!(&app, &job_uri, Duration::from_secs(30), |info| {
        info["status"] == "failed"
    });
    assert_eq!(info["captured_count"], 0);
    assert_eq!(info["failed_count"], 1, "abort stops at the first failure: {info}");
    assert!(
        info["error"].as_str().unwrap_or_default().contains("timeout"),
        "the job must say why it failed, got {info}"
    );

    // The failed index is still listed, so a client can see where the burst died.
    let (status, images) = get_json!(&app, &format!("{job_uri}/images"));
    assert_eq!(status, 200);
    let images = images.as_array().unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(images[0]["status"], "failed");
    assert_eq!(images[0]["index"], 0);

    // 410, not 404: that index exists and will never have bytes.
    let resp = test::call_service(
        &app,
        test::TestRequest::get().uri(&format!("{job_uri}/images/0")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 410);
    assert!(!test::read_body(resp).await.is_empty(), "the 410 carries the failure reason");
}

#[actix_web::test]
async fn a_burst_waits_for_a_short_operation() {
    // Slow frames, so a single-frame grab holds the camera far longer than the busy grace. The
    // grab stands in for any short operation (a feature read, a write): the fake can't make
    // those slow.
    confine_discovery_to_loopback();
    let cam = aravis_port_fakecamera::FakeCamera::start(FakeCameraConfig {
        frame_period: Duration::from_millis(300),
        ..Default::default()
    })
    .unwrap();
    cam.poke_register(aravis_port_fakecamera::feature::WIDTH, W);
    cam.poke_register(aravis_port_fakecamera::feature::HEIGHT, H);
    cam.poke_register(aravis_port_fakecamera::feature::ACQUISITION_ACTIVE, 1);
    let ctx = rust_cam_serve::app_context::AppContext::new(Default::default()).await;
    ctx.dev_ctrl.connect_by_addr(0, cam.local_addr(), None).await.unwrap();
    let app = service!(ctx);

    let grab = test::TestRequest::get().uri("/api/v1/devices/0/stream/frame/raw").to_request();
    let (grabbed, job_id) = tokio::join!(test::call_service(&app, grab), async {
        // The burst asks for the camera while the grab holds it.
        tokio::time::sleep(Duration::from_millis(50)).await;
        start_job!(app, serde_json::json!({"count": 2, "format": "raw"}))
    });
    assert_eq!(grabbed.status(), 200);

    let info = await_job!(app, &format!("/api/v1/devices/0/grab/jobs/{job_id}"));
    assert_eq!(info["status"], "completed", "the burst waits its turn instead of failing as busy: {info}");
    assert_eq!(info["captured_count"], 2);
}
