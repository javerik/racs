//! Tests against `examples/fake_server.rs` in the repository root; each returns early unless
//! RACS_TEST_URL points at one (`client_libs/run-tests.sh rust` sets it).
//!
//! They share the server's device 0, so each test holds a lock and resets the camera first.
//! `run-tests.sh` starts the server with 5 s sessions, so every test runs on the heartbeat.

use std::pin::pin;
use std::time::Duration;

use futures_util::{StreamExt, TryStreamExt};
use racs_client::models::{EventKind, GenICamNodeType};
use racs_client::{
    BurstRequest, Error, Event, FeatureValue, ImageEntry, ImageFormat, JobStatus, LiveOptions, LiveStream, Mode,
    PixelDepth, RacsClient, Role,
};
use tokio::sync::{Mutex, MutexGuard};

// The fake server starts every camera at this size.
const WIDTH: u32 = 64;
const HEIGHT: u32 = 32;

static LOCK: Mutex<()> = Mutex::const_new(());

struct Server {
    url: String,
    client: RacsClient,
    _guard: MutexGuard<'static, ()>,
}

async fn server() -> Option<Server> {
    let Ok(url) = std::env::var("RACS_TEST_URL") else {
        eprintln!("skipped: RACS_TEST_URL is not set; run client_libs/run-tests.sh");
        return None;
    };
    let guard = LOCK.lock().await;
    let client = RacsClient::builder(&url).name("racs-rust tests").build().unwrap();
    tokio::spawn(client.clone().keep_alive());
    let cam = client.camera(0);
    // A failed test may have left a lease behind.
    cam.release(true).await.unwrap();
    cam.set("Width", WIDTH).await.unwrap();
    cam.set("Height", HEIGHT).await.unwrap();
    cam.set("ReverseX", false).await.unwrap();
    cam.set("GevSCPSPacketSize", 1500).await.unwrap();
    Some(Server { url, client, _guard: guard })
}

macro_rules! server {
    () => {
        match server().await {
            Some(server) => server,
            None => return,
        }
    };
}

/// Another client of the server, with a session kept alive.
fn client(s: &Server, name: &str) -> RacsClient {
    let client = RacsClient::builder(&s.url).name(name).build().unwrap();
    tokio::spawn(client.clone().keep_alive());
    client
}

fn client_id(client: &RacsClient) -> String {
    client.session().expect("a session").client_id
}

/// Reads frames until the stream fails, and returns how.
async fn stream_end(live: &mut LiveStream) -> Error {
    let end = async {
        loop {
            match live.next_frame().await {
                Ok(Some(_)) => {}
                Ok(None) => panic!("the stream ended normally"),
                Err(e) => return e,
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), end).await.expect("the stream did not end")
}

/// The next event matching `want`, skipping others.
async fn next_event_where(events: &mut racs_client::EventStream, want: impl Fn(&Event) -> bool) -> Event {
    let next = async {
        loop {
            let event = events.next_event().await.unwrap().expect("the events socket closed");
            if want(&event) {
                return event;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), next).await.expect("no such event")
}

#[tokio::test]
async fn connected_devices_are_listed() {
    let s = server!();
    let ids: Vec<u32> = s.client.cameras().await.unwrap().iter().map(|c| c.id()).collect();
    assert!(ids.contains(&0), "{ids:?}");

    let info = s.client.camera(0).info().await.unwrap();
    assert_eq!(info.id, 0);
    assert_eq!(info.ip, "127.0.0.1");
    assert!(s.client.get_devices().await.unwrap().connected.iter().any(|d| d.id == 0));
}

#[tokio::test]
async fn a_bare_server_url_reaches_the_api() {
    let s = server!();
    let bare = RacsClient::new(s.url.trim_end_matches("/api/v1")).unwrap();
    assert!(bare.camera(0).is_connected().await.unwrap());
}

#[tokio::test]
async fn features_read_and_write_as_typed_values() {
    let s = server!();
    let cam = s.client.camera(0);
    assert_eq!(cam.get::<u32>("Width").await.unwrap(), WIDTH);

    cam.set("ExposureTime", 2500.0).await.unwrap();
    assert_eq!(cam.get::<f64>("ExposureTime").await.unwrap(), 2500.0);

    cam.set("ReverseX", true).await.unwrap();
    assert!(cam.get::<bool>("ReverseX").await.unwrap());
    cam.set("ReverseX", false).await.unwrap();
    assert!(!cam.get::<bool>("ReverseX").await.unwrap());

    assert!(matches!(cam.get::<FeatureValue>("PixelFormat").await.unwrap(), FeatureValue::Int(_)));
    assert_eq!(cam.get::<Option<i64>>("TriggerSoftware").await.unwrap(), None);
    assert!(matches!(cam.get::<bool>("Width").await, Err(Error::Feature { .. })));
}

#[tokio::test]
async fn feature_states_report_problems_per_entry() {
    let s = server!();
    let cam = s.client.camera(0);
    let states = cam.states(["Width", "NoSuchFeature"]).await.unwrap();
    assert_eq!(states.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Width", "NoSuchFeature"]);
    assert!(states[0].error.is_none());
    assert!(states[1].error.is_some());

    let exposure = cam.state("ExposureTime").await.unwrap();
    assert_eq!(exposure.unit.as_deref(), Some("us"));
    assert_eq!(exposure.min.as_ref().and_then(|m| m.as_f64()), Some(1.0));

    assert!(matches!(cam.get::<i64>("NoSuchFeature").await, Err(Error::Feature { .. })));
}

#[tokio::test]
async fn feature_info_comes_from_the_categories() {
    let s = server!();
    let cam = s.client.camera(0);
    assert_eq!(cam.feature_info("TriggerSoftware").await.unwrap().node_type, GenICamNodeType::Command);
    assert!(!cam.feature_info("PixelFormat").await.unwrap().enums.unwrap().is_empty());
    assert!(matches!(cam.feature_info("NoSuchFeature").await, Err(Error::Feature { .. })));
}

#[tokio::test]
async fn commands_execute() {
    let s = server!();
    let cam = s.client.camera(0);
    cam.execute("TriggerSoftware").await.unwrap();
    assert_eq!(cam.execute("Width").await.unwrap_err().status(), Some(500));
}

#[tokio::test]
async fn the_low_level_methods_still_take_the_device_id() {
    let s = server!();
    assert_eq!(s.client.get_device_gc_node_value(0, "Width").await.unwrap(), WIDTH.to_string());
    assert!(s.client.get_device_xml(0).await.unwrap().contains("RegisterDescription"));
    assert!(!s.client.get_device_gc_categories(0).await.unwrap().is_empty());
}

#[tokio::test]
async fn single_frames() {
    let s = server!();
    let cam = s.client.camera(0);
    assert_eq!(&cam.grab_jpeg(Some(50)).await.unwrap()[..2], [0xFF, 0xD8]);

    let frame = cam.grab_raw().await.unwrap();
    assert_eq!((frame.width, frame.height, frame.bit_depth), (WIDTH, HEIGHT, 8));
    assert_eq!(frame.to_u16().unwrap().len(), (WIDTH * HEIGHT) as usize);
}

#[tokio::test]
async fn stream_error_without_a_stream() {
    let s = server!();
    assert!(!s.client.camera(0).stream_error().await.unwrap().active_stream);
}

#[tokio::test]
async fn live_raw_frames() {
    let s = server!();
    let cam = s.client.camera(0);
    let mut live = cam.live(&LiveOptions::raw()).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..3 {
        frames.push(live.next_frame().await.unwrap().unwrap());
    }
    assert!(cam.stream_error().await.unwrap().active_stream);
    assert_eq!(live.info().unwrap().width, WIDTH);
    assert_eq!(live.info().unwrap().packet_size, Some(1500));
    live.close().await.unwrap();

    assert_eq!(frames.iter().map(|f| f.frame_number.unwrap()).collect::<Vec<_>>(), [0, 1, 2]);
    assert!(frames.iter().all(|f| f.data.len() == (WIDTH * HEIGHT) as usize));
}

#[tokio::test]
async fn live_mono16_frames() {
    let s = server!();
    let mut live = s.client.camera(0).live(&LiveOptions::raw().pixel_depth(PixelDepth::Mono16)).await.unwrap();
    let frame = live.next_frame().await.unwrap().unwrap();
    live.close().await.unwrap();

    assert!(frame.bit_depth > 8);
    assert_eq!(frame.data.len(), (WIDTH * HEIGHT * 2) as usize);
    assert!(frame.to_u16().unwrap().into_iter().max().unwrap() > 255);
}

/// The fake's Mono8 pattern: each pixel one more (mod 255) than its left neighbour.
fn assert_mono8_gradient(pixels: &[u16]) {
    for row in pixels.chunks(WIDTH as usize) {
        for pair in row.windows(2) {
            assert_eq!(pair[1], (pair[0] + 1) % 255, "not the fake's gradient");
        }
    }
}

#[tokio::test]
async fn live_zstd_frames_decode_to_the_pixels() {
    let s = server!();
    let mut live = s.client.camera(0).live(&LiveOptions::zstd()).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..5 {
        frames.push(live.next_frame().await.unwrap().unwrap());
    }
    assert_eq!(live.info().unwrap().format, ImageFormat::Zstd);
    live.close().await.unwrap();

    assert_eq!(frames.iter().map(|f| f.frame_number.unwrap()).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
    for frame in &frames {
        assert_eq!(frame.format, ImageFormat::Zstd);
        assert!(frame.data.len() < (WIDTH * HEIGHT) as usize);
        assert_mono8_gradient(&frame.to_u16().unwrap());
    }
    assert_eq!(frames[0].to_raw().unwrap().data.len(), (WIDTH * HEIGHT) as usize);
}

#[tokio::test]
async fn live_mono16_zstd_frames() {
    let s = server!();
    let mut live = s.client.camera(0).live(&LiveOptions::zstd().pixel_depth(PixelDepth::Mono16)).await.unwrap();
    let frame = live.next_frame().await.unwrap().unwrap();
    live.close().await.unwrap();

    assert!(frame.bit_depth > 8);
    let pixels = frame.to_u16().unwrap();
    assert!(pixels.iter().max().unwrap() > &255);
    // The fake's 16-bit ramp steps by 8 along a row.
    for pair in pixels[..WIDTH as usize].windows(2) {
        assert_eq!(pair[1], pair[0].wrapping_add(8));
    }
}

#[tokio::test]
async fn live_jpeg_frames_as_a_stream() {
    let s = server!();
    let live = s.client.camera(0).live(&LiveOptions::jpeg().fps(20.0)).await.unwrap();
    let frames: Vec<_> = live.into_frames().take(2).try_collect().await.unwrap();
    assert_eq!(frames.len(), 2);
    assert!(frames.iter().all(|f| f.format == ImageFormat::Jpeg && f.data[..2] == [0xFF, 0xD8]));
}

#[tokio::test]
async fn a_write_during_a_live_stream_resizes_the_frames() {
    let s = server!();
    let cam = s.client.camera(0);
    let mut live = cam.live(&LiveOptions::raw()).await.unwrap();
    live.next_frame().await.unwrap();
    cam.set("Width", 32).await.unwrap();

    let mut resized = None;
    for _ in 0..50 {
        let frame = live.next_frame().await.unwrap().unwrap();
        if frame.width == 32 {
            resized = Some(frame);
            break;
        }
    }
    live.close().await.unwrap();
    assert_eq!(resized.expect("no resized frame").data.len(), (32 * HEIGHT) as usize);
}

#[tokio::test]
async fn the_packet_size_is_reported_and_kept() {
    let s = server!();
    let cam = s.client.camera(0);
    let info = cam.packet_size().await.unwrap();
    assert_eq!((info.packet_size, info.min, info.max, info.inc), (1500, 576, 9000, 4));
    assert_eq!(info.local_ip.as_deref(), Some("127.0.0.1"));

    cam.set("GevSCPSPacketSize", 4000).await.unwrap();
    cam.grab_raw().await.unwrap();
    assert_eq!(cam.packet_size().await.unwrap().packet_size, 4000);
    assert!(matches!(cam.set("GevSCPSPacketSize", 4002).await, Err(Error::Api(_))));
}

#[tokio::test]
async fn auto_packet_size_during_a_live_stream() {
    let s = server!();
    let cam = s.client.camera(0);
    let mut live = cam.live(&LiveOptions::raw()).await.unwrap();
    live.next_frame().await.unwrap();
    let auto = cam.auto_packet_size().await.unwrap();
    assert!(auto.test_packets);
    assert_eq!((auto.previous, auto.packet_size), (1500, 9000));

    // Frames of the old size may still be on their way; the stream announces the new one.
    let mut after = None;
    for _ in 0..50 {
        let frame = live.next_frame().await.unwrap().unwrap();
        if live.info().unwrap().packet_size == Some(9000) {
            after = Some(frame);
            break;
        }
    }
    live.close().await.unwrap();
    assert_eq!(after.expect("no frame after the change").data.len(), (WIDTH * HEIGHT) as usize);
}

#[tokio::test]
async fn a_grab_during_a_live_stream_is_busy() {
    let s = server!();
    let cam = s.client.camera(0);
    let mut live = cam.live(&LiveOptions::jpeg()).await.unwrap();
    live.next_frame().await.unwrap();
    let grab = cam.grab_jpeg(None).await;
    live.close().await.unwrap();
    assert!(matches!(grab, Err(Error::CameraBusy(_))), "{grab:?}");
}

#[tokio::test]
async fn a_raw_burst() {
    let s = server!();
    let job = s.client.camera(0).burst(&BurstRequest::new(5)).await.unwrap();
    let frames: Vec<_> = job.frames().try_collect().await.unwrap();
    let info = job.wait().await.unwrap();
    job.delete().await.unwrap();

    assert_eq!(info.status, JobStatus::Completed);
    assert_eq!(info.captured_count, 5);
    assert_eq!(frames.len(), 5);
    assert!(frames.iter().all(|f| (f.width, f.height, f.format) == (WIDTH, HEIGHT, ImageFormat::Raw)));
}

#[tokio::test]
async fn burst_frames_arrive_one_by_one() {
    let s = server!();
    let job = s.client.camera(0).burst(&BurstRequest::new(3)).await.unwrap();
    {
        let mut frames = pin!(job.frames());
        let first = frames.next().await.unwrap().unwrap();
        assert_eq!(first.data.len(), (WIDTH * HEIGHT) as usize);
        assert_eq!(frames.count().await, 2);
    }
    job.delete().await.unwrap();
}

#[tokio::test]
async fn a_zstd_burst() {
    let s = server!();
    let job = s.client.camera(0).burst(&BurstRequest::new(3).format(ImageFormat::Zstd)).await.unwrap();
    let frames: Vec<_> = job.frames().try_collect().await.unwrap();
    let info = job.wait().await.unwrap();
    job.delete().await.unwrap();

    assert_eq!((info.status, info.format), (JobStatus::Completed, ImageFormat::Zstd));
    assert_eq!(frames.len(), 3);
    for frame in &frames {
        assert_eq!(frame.format, ImageFormat::Zstd);
        assert_mono8_gradient(&frame.to_u16().unwrap());
    }
}

#[tokio::test]
async fn a_jpeg_burst() {
    let s = server!();
    let request = BurstRequest::new(2).format(ImageFormat::Jpeg).quality(60);
    let job = s.client.camera(0).burst(&request).await.unwrap();
    job.wait().await.unwrap();
    assert_eq!(&job.image(0).await.unwrap()[..2], [0xFF, 0xD8]);
    assert!(job.images().await.unwrap().iter().all(|e| matches!(e, ImageEntry::Ok { .. })));
    assert!(matches!(job.image(5).await, Err(Error::NotFound(_))));
    job.delete().await.unwrap();
}

#[tokio::test]
async fn a_deleted_job_is_gone() {
    let s = server!();
    let cam = s.client.camera(0);
    let job = cam.burst(&BurstRequest::new(1)).await.unwrap();
    job.wait().await.unwrap();
    let id = job.id();
    job.delete().await.unwrap();
    assert!(matches!(cam.job(id).info().await, Err(Error::NotFound(_))));
}

#[tokio::test]
async fn a_burst_on_a_busy_camera_fails() {
    let s = server!();
    let cam = s.client.camera(0);
    let mut live = cam.live(&LiveOptions::jpeg()).await.unwrap();
    live.next_frame().await.unwrap();
    let job = cam.burst(&BurstRequest::new(1)).await.unwrap();
    let outcome = job.wait().await;
    live.close().await.unwrap();
    job.delete().await.unwrap();

    match outcome {
        Err(Error::BurstJobFailed(info)) => assert!(info.error.unwrap().contains("Busy")),
        other => panic!("expected a failed job, got {other:?}"),
    }
}

#[tokio::test]
async fn disconnect() {
    let s = server!();
    // Device 1 only: a fake camera cannot be connected again once it is gone.
    let cam = s.client.camera(1);
    assert!(cam.is_connected().await.unwrap());
    let result = cam.disconnect().await.unwrap();
    assert_eq!((result.closed, result.members), (true, 0));
    assert!(!cam.is_connected().await.unwrap());
    assert!(cam.info().await.is_err());
}

// --- SESSIONS AND ACCESS ---

#[tokio::test]
async fn two_clients_and_the_lock_semantics() {
    let s = server!();
    let a = client(&s, "a");
    let b = client(&s, "b");
    let anonymous = RacsClient::builder(&s.url).anonymous().build().unwrap();
    let (cam_a, cam_b, cam_anon) = (a.camera(0), b.camera(0), anonymous.camera(0));

    // Shared: everyone writes, the anonymous client too, and sends no session.
    cam_anon.set("Width", WIDTH).await.unwrap();
    assert!(anonymous.session().is_none());

    let access = cam_a.connect_as(Mode::RoShared, None).await.unwrap();
    assert_eq!((access.mode, access.you), (Mode::RoShared, Role::Owner));
    assert_eq!(access.owner.unwrap().name.as_deref(), Some("a"));
    cam_a.set("Width", WIDTH).await.unwrap();

    // ro-shared: b reads, but may not write; the anonymous client gets meta routes only.
    assert_eq!(cam_b.get::<u32>("Width").await.unwrap(), WIDTH);
    assert_eq!(cam_b.access().await.unwrap().you, Role::Reader);
    let refused = cam_b.set("Width", WIDTH).await.unwrap_err();
    assert!(matches!(refused, Error::ReadOnly(_)), "{refused:?}");
    assert_eq!(refused.refusal().unwrap().owner.unwrap().client_id, client_id(&a));
    let refused = cam_anon.get::<u32>("Width").await.unwrap_err();
    assert!(matches!(refused, Error::DeviceLocked(_)), "{refused:?}");
    cam_anon.xml().await.unwrap();

    // exclusive while b is a member: refused, unless forced.
    let refused = cam_a.take(Mode::Exclusive, false).await.unwrap_err();
    assert!(matches!(refused, Error::DeviceInUse(_)), "{refused:?}");
    assert!(refused.refusal().unwrap().members.iter().any(|m| m.client_id == client_id(&b)));
    let access = cam_a.take(Mode::Exclusive, true).await.unwrap();
    assert_eq!((access.mode, access.you), (Mode::Exclusive, Role::Owner));

    // exclusive: b is locked out, and can't take the lease without force.
    let refused = cam_b.get::<u32>("Width").await.unwrap_err();
    assert!(matches!(refused, Error::DeviceLocked(_)), "{refused:?}");
    assert_eq!(refused.refusal().unwrap().mode, Some(Mode::Exclusive));
    assert!(matches!(cam_b.take(Mode::RoShared, false).await, Err(Error::DeviceLocked(_))));
    assert_eq!(cam_b.access().await.unwrap().you, Role::Meta);

    // Released: shared again.
    let access = cam_a.release(false).await.unwrap();
    assert_eq!((access.mode, access.owner), (Mode::Shared, None));
    cam_b.set("Width", WIDTH).await.unwrap();

    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn a_forced_exclusive_lease_revokes_another_clients_stream() {
    let s = server!();
    let a = client(&s, "a");
    let b = client(&s, "b");
    let mut live = b.camera(0).live(&LiveOptions::jpeg()).await.unwrap();
    live.next_frame().await.unwrap();

    a.camera(0).take(Mode::Exclusive, true).await.unwrap();
    let end = stream_end(&mut live).await;
    assert!(matches!(end, Error::AccessRevoked { .. }), "{end:?}");

    a.camera(0).release(false).await.unwrap();
    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn an_event_arrives_after_another_client_writes() {
    let s = server!();
    let a = client(&s, "a");
    let b = client(&s, "b");
    let mut events = a.events().await.unwrap();
    let hello = events.next_event().await.unwrap().unwrap();
    match hello.kind {
        EventKind::Hello { session, devices } => {
            assert_eq!(session.client_id, client_id(&a));
            assert!(devices.iter().any(|d| d.device == 0 && d.connected));
        }
        other => panic!("expected hello, got {other:?}"),
    }

    b.camera(0).set("ReverseX", true).await.unwrap();
    let reverse_x = |e: &Event| matches!(&e.kind, EventKind::FeatureChanged { feature, .. } if feature == "ReverseX");
    let event = next_event_where(&mut events, reverse_x).await;
    let EventKind::FeatureChanged { device, by, .. } = event.kind else { unreachable!() };
    assert_eq!(device, 0);
    assert_eq!(by.unwrap().client_id, client_id(&b));

    events.close().await.unwrap();
    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn two_viewers_watch_one_camera() {
    let s = server!();
    let a = client(&s, "a");
    let b = client(&s, "b");
    let mut live_a = a.camera(0).live(&LiveOptions::raw()).await.unwrap();
    let mut live_b = b.camera(0).live(&LiveOptions::jpeg()).await.unwrap();
    let frame_a = live_a.next_frame().await.unwrap().unwrap();
    let frame_b = live_b.next_frame().await.unwrap().unwrap();
    assert_eq!(frame_a.data.len(), (WIDTH * HEIGHT) as usize);
    assert_eq!(&frame_b.data[..2], [0xFF, 0xD8]);

    let access = a.camera(0).access().await.unwrap();
    assert_eq!(access.viewers, 2);
    assert_eq!(a.camera(0).stream_error().await.unwrap().viewers, 2);

    live_a.close().await.unwrap();
    live_b.close().await.unwrap();
    a.close().await.unwrap();
    b.close().await.unwrap();
}

#[tokio::test]
async fn an_expired_session_is_renewed_on_the_next_request() {
    let s = server!();
    // No keep_alive: the session expires once the client goes quiet.
    let quiet = RacsClient::builder(&s.url).name("quiet").session_timeout_s(5).build().unwrap();
    assert!(quiet.session().is_none(), "the session is created with the first request");
    assert_eq!(quiet.camera(0).get::<u32>("Width").await.unwrap(), WIDTH);
    let first = quiet.session().unwrap();
    assert_eq!(first.name.as_deref(), Some("quiet"));

    tokio::time::sleep(Duration::from_secs(first.timeout_s + 2)).await;
    let sessions = s.client.list_sessions().await.unwrap();
    assert!(sessions.iter().all(|x| x.client_id != first.client_id), "the session did not expire");
    assert!(matches!(quiet.heartbeat(first.session_id).await, Err(Error::SessionExpired(_))));

    // The next request starts a new session and goes through.
    assert_eq!(quiet.camera(0).get::<u32>("Width").await.unwrap(), WIDTH);
    let second = quiet.session().unwrap();
    assert_ne!(second.client_id, first.client_id);
    assert_eq!(second.name.as_deref(), Some("quiet"));
    quiet.close().await.unwrap();
}

#[tokio::test]
async fn a_live_stream_ends_with_its_session() {
    let s = server!();
    let c = client(&s, "c");
    let mut live = c.camera(0).live(&LiveOptions::jpeg()).await.unwrap();
    live.next_frame().await.unwrap();
    c.close().await.unwrap();
    let end = stream_end(&mut live).await;
    assert!(matches!(end, Error::SessionEnded { .. }), "{end:?}");
}

#[tokio::test]
async fn sessions_are_listed_and_renamed() {
    let s = server!();
    let c = client(&s, "before");
    let session = c.start_session().await.unwrap().unwrap();
    c.rename(Some("after")).await.unwrap();
    let listed = s.client.list_sessions().await.unwrap();
    let entry = listed.iter().find(|x| x.client_id == session.client_id).expect("not listed");
    assert_eq!(entry.name.as_deref(), Some("after"));
    c.close().await.unwrap();
    let listed = s.client.list_sessions().await.unwrap();
    assert!(listed.iter().all(|x| x.client_id != session.client_id), "closed, but still listed");
}
