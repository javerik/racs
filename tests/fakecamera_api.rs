//! Controller-level tests against aravis-port's in-process fake camera — no hardware needed.
//!
//! The fake binds an ephemeral loopback port rather than GVCP's 3956, which is why
//! `DeviceCtrl::connect_by_addr` is public.

use std::net::SocketAddrV4;
use std::sync::Arc;
use std::time::Duration;

use aravis_port_fakecamera::{feature, FakeCamera, FakeCameraConfig};
use rust_cam_serve::controller::device_ctrl::DeviceCtrl;
use rust_cam_serve::controller::stream_ctrl::{LiveEnd, StreamCtrl};
use rust_cam_serve::models::genicam_models::GenICamNodeType;
use rust_cam_serve::models::device_models::CloseReason;
use rust_cam_serve::models::live_stream::{LiveFormat, LiveMsg, LiveOptions, StreamInfo};
use rust_cam_serve::stores::camera_store::CameraStore;
use rust_cam_serve::stores::job_store::JobStore;
use rust_cam_serve::events::EventBus;
use rust_cam_serve::server_config::RuntimeConfig;
use rust_cam_serve::models::stream_errors::StreamErrorStore;
use rust_cam_serve::stores::client_store::{Admission, Client, ClientStore};
use serde_json::json;
use tokio::sync::mpsc;

/// The controllers' calls as the server makes them for no client.
fn adm(id: u32) -> Admission {
    Admission::server(id)
}

/// A `DeviceCtrl` and `StreamCtrl` over `store`, wired as `AppContext::new` wires them.
async fn controllers(store: &Arc<Box<CameraStore>>) -> (DeviceCtrl, StreamCtrl) {
    let runtime = RuntimeConfig::default();
    let events = Arc::new(EventBus::new(runtime.event_capacity));
    let clients = Arc::new(ClientStore::new(events.clone(), &runtime));
    let dev = DeviceCtrl::new(store.clone(), Arc::new(JobStore::new()), clients.clone(), events).await.unwrap();
    (dev, StreamCtrl::new(store.clone(), clients, Arc::new(StreamErrorStore::new())))
}

const W: u32 = 64;
const H: u32 = 32;

struct Harness {
    _cameras: Vec<FakeCamera>,
    dev: DeviceCtrl,
    stream: StreamCtrl,
}

/// Start `n` fake cameras and connect each as device id 0..n.
async fn harness(n: usize) -> Harness {
    let store = Arc::new(Box::new(CameraStore::new()));
    let (dev, stream) = controllers(&store).await;

    let mut cameras = Vec::new();
    for id in 0..n {
        let camera = FakeCamera::start(FakeCameraConfig {
            frame_period: Duration::from_millis(10),
            ..Default::default()
        })
        .expect("failed to start fake camera");
        camera.poke_register(feature::WIDTH, W);
        camera.poke_register(feature::HEIGHT, H);
        camera.poke_register(feature::ACQUISITION_ACTIVE, 1);
        connect(&dev, id as u32, camera.local_addr()).await;
        cameras.push(camera);
    }

    Harness { _cameras: cameras, dev, stream }
}

async fn connect(dev: &DeviceCtrl, id: u32, addr: SocketAddrV4) {
    dev.connect_by_addr(id, addr, None)
        .await
        .unwrap_or_else(|e| panic!("connect of id {id} failed: {e:?}"));
}

#[tokio::test]
async fn reads_an_integer_feature_from_the_device() {
    let h = harness(1).await;
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap(), W.to_string());
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Height").await.unwrap(), H.to_string());
}

#[tokio::test]
async fn writes_then_reads_a_float_feature() {
    let h = harness(1).await;
    h.dev.genicam_set_feature_value(&adm(0), "ExposureTime", "42000").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ExposureTime").await.unwrap(), "42000");
}

#[tokio::test]
async fn reads_an_enum_as_its_integer_value() {
    let h = harness(1).await;
    // The endpoint's long-standing contract is the integer, not the symbolic name.
    let value = h.dev.genicam_get_feature_value(&adm(0), "PixelFormat").await.unwrap();
    assert_eq!(value.parse::<i64>().unwrap(), 1, "expected the Mono8 register value");
}

#[tokio::test]
async fn writing_an_enum_accepts_an_integer_or_a_symbolic_name() {
    let h = harness(1).await;
    h.dev.genicam_set_feature_value(&adm(0), "PixelFormat", "3").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "PixelFormat").await.unwrap(), "3");
    // A symbolic name is also honoured rather than rejected as unparseable.
    h.dev.genicam_set_feature_value(&adm(0), "PixelFormat", "Mono8").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "PixelFormat").await.unwrap(), "1");
}

#[tokio::test]
async fn an_unknown_feature_is_reported_not_found() {
    let h = harness(1).await;
    let err = h.dev.genicam_get_feature_value(&adm(0), "NoSuchFeature").await.unwrap_err();
    assert!(format!("{err:?}").contains("Feature not found"), "got {err:?}");
}

#[tokio::test]
async fn categories_expose_feature_metadata_and_omit_registers() {
    let h = harness(1).await;
    let categories = h.dev.genicam_categories_json(&adm(0)).await.unwrap();

    let root = categories.iter().find(|c| c.name == "Root").expect("no Root category");
    let names: Vec<&str> = root.nodes.iter().map(|n| n.name.as_str()).collect();

    for expected in ["Width", "Height", "PixelFormat", "ExposureTime", "Gain", "PayloadSize"] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }
    let kind = |name: &str| root.nodes.iter().find(|n| n.name == name).map(|n| n.node_type.clone());
    assert_eq!(kind("ChunkModeActive"), Some(GenICamNodeType::Boolean));
    assert_eq!(kind("AcquisitionFrameRateEnable"), Some(GenICamNodeType::Boolean));
    assert_eq!(kind("TriggerSoftware"), Some(GenICamNodeType::Command));
    assert_eq!(kind("AcquisitionStart"), Some(GenICamNodeType::Command));
    // Backing registers are not features in their own right.
    assert!(!names.contains(&"WidthReg"), "register leaked into {names:?}");

    let pixel_format = root.nodes.iter().find(|n| n.name == "PixelFormat").unwrap();
    let enums = pixel_format.enums.as_ref().expect("PixelFormat should carry enum entries");
    assert!(enums.iter().any(|e| e.string_value.as_deref() == Some("Mono8") && e.value == 1));
}

#[tokio::test]
async fn genicam_xml_is_served_from_the_connected_device() {
    let h = harness(1).await;
    let xml = h.dev.genicam_xml(&adm(0)).await.unwrap();
    assert!(xml.contains("RegisterDescription"), "not a GenICam document");
    assert!(xml.contains(r#"Name="Width""#));
}

#[tokio::test]
async fn grabs_a_raw_frame_of_exactly_width_times_height() {
    let h = harness(1).await;
    let frame = h.stream.grab_raw_frame(&adm(0)).await.unwrap();
    // Anything other than an exact match means the payload stride is off.
    assert_eq!(frame.len(), (W * H) as usize);
}

#[tokio::test]
async fn grabs_a_jpeg_frame() {
    let h = harness(1).await;
    let jpeg = h.stream.grab_jpeg_frame(&adm(0), 80).await.unwrap();
    // JPEG SOI marker.
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");
    assert!(jpeg.len() > 100, "suspiciously small JPEG: {} bytes", jpeg.len());
}

#[tokio::test]
async fn a_disconnected_id_can_be_reconnected() {
    let h = harness(2).await;
    // Disconnect id 0 — deliberately *not* the last entry in the store. A `pop_if`-style
    // removal only tests the last element, which used to leave the slot behind and brick the id
    // for the rest of the process's life.
    h.dev.disconnect(&adm(0), false).await.unwrap();
    connect(&h.dev, 0, h._cameras[0].local_addr()).await;
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap(), W.to_string());
    // The other camera is untouched.
    assert_eq!(h.dev.genicam_get_feature_value(&adm(1), "Width").await.unwrap(), W.to_string());
}

#[tokio::test]
async fn concurrent_grabs_do_not_deadlock() {
    let h = Arc::new(harness(1).await);
    let a = {
        let h = h.clone();
        tokio::spawn(async move { h.stream.grab_raw_frame(&adm(0)).await })
    };
    let b = {
        let h = h.clone();
        tokio::spawn(async move { h.stream.grab_raw_frame(&adm(0)).await })
    };

    // The store serializes access per camera: the second grab waits for the first. Both must
    // *return*. The previous design blocked on a tokio mutex from inside a Drop impl, which
    // could wedge a worker thread permanently.
    let (a, b) = tokio::time::timeout(Duration::from_secs(20), async { (a.await.unwrap(), b.await.unwrap()) })
        .await
        .expect("concurrent grabs deadlocked");

    for frame in [a, b] {
        assert_eq!(frame.expect("a grab waits its turn instead of failing as busy").len(), (W * H) as usize);
    }
}

#[tokio::test]
async fn ten_concurrent_writes_all_succeed_and_the_last_wins() {
    let h = Arc::new(harness(1).await);
    // Spawned on this test's single thread, each runs until it queues for the camera before the
    // next one starts: they arrive in order.
    let writes: Vec<_> = (0..10)
        .map(|i| {
            let h = h.clone();
            tokio::spawn(async move {
                h.dev.genicam_set_feature_value(&adm(0), "ExposureTime", &(1000 + i * 100).to_string()).await
            })
        })
        .collect();
    for (i, write) in writes.into_iter().enumerate() {
        write.await.unwrap().unwrap_or_else(|e| panic!("write {i} failed: {e:?}"));
    }
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ExposureTime").await.unwrap(), "1900");
}

#[tokio::test]
async fn a_feature_read_on_an_unconnected_id_fails_cleanly() {
    let store = Arc::new(Box::new(CameraStore::new()));
    let (dev, _) = controllers(&store).await;
    // Never discovered and never connected: an error, not a panic or a hang.
    let err = dev.genicam_get_feature_value(&adm(7), "Width").await.unwrap_err();
    assert!(format!("{err:?}").contains("NotDiscovered"), "got {err:?}");
}

#[tokio::test]
async fn an_addr_connected_device_reconnects_by_id() {
    let h = harness(1).await;
    h.dev.disconnect(&adm(0), false).await.unwrap();
    assert!(h.dev.connected(&Client::Anonymous).await.is_empty());

    // Never seen by discovery, but the server remembers where it was connected.
    h.dev.connect(&adm(0)).await.unwrap();
    assert_eq!(h.dev.connected(&Client::Anonymous).await.len(), 1);
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap(), W.to_string());

    // Implicit connects (every device route) take the same way back.
    h.dev.disconnect(&adm(0), false).await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Height").await.unwrap(), H.to_string());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_connects_open_once() {
    let h = harness(1).await;
    h.dev.disconnect(&adm(0), false).await.unwrap();

    // Like the web UI's parallel first requests: all find the device closed at once. Without the
    // lifecycle lock each opens the camera, and all but one fail (the id is taken, or the camera's
    // control privilege is).
    let results = futures::future::join_all((0..4).map(|_| async { h.dev.connect(&adm(0)).await })).await;
    for result in &results {
        assert!(result.is_ok(), "every concurrent connect succeeds: {results:?}");
    }
    assert_eq!(h.dev.connected(&Client::Anonymous).await.len(), 1);
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap(), W.to_string());

    // The same through the implicit connect of a device route.
    h.dev.disconnect(&adm(0), false).await.unwrap();
    let reads = futures::future::join_all((0..4).map(|_| async { h.dev.genicam_get_feature_value(&adm(0), "Width").await })).await;
    for read in &reads {
        assert_eq!(read.as_deref().ok(), Some(W.to_string().as_str()), "{reads:?}");
    }
    assert_eq!(h.dev.connected(&Client::Anonymous).await.len(), 1);
}

#[tokio::test]
async fn booleans_read_and_write_as_true_false() {
    let h = harness(1).await;
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ReverseX").await.unwrap(), "false");
    h.dev.genicam_set_feature_value(&adm(0), "ReverseX", "true").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ReverseX").await.unwrap(), "true");
    assert_eq!(h._cameras[0].peek_register(feature::REVERSE_X), 1);
    h.dev.genicam_set_feature_value(&adm(0), "ReverseX", "0").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ReverseX").await.unwrap(), "false");
    let err = h.dev.genicam_set_feature_value(&adm(0), "ReverseX", "maybe").await.unwrap_err();
    assert!(format!("{err:?}").contains("ValueError"), "got {err:?}");
}

#[tokio::test]
async fn executing_a_command_writes_its_register() {
    let h = harness(1).await;
    h.dev.genicam_execute_command(&adm(0), "TriggerSoftware").await.unwrap();
    assert_eq!(h._cameras[0].peek_register(feature::TRIGGER_SOFTWARE), 1);

    // A command has no value, and a value is no command.
    let err = h.dev.genicam_get_feature_value(&adm(0), "TriggerSoftware").await.unwrap_err();
    assert!(format!("{err:?}").contains("gc/command"), "got {err:?}");
    let err = h.dev.genicam_execute_command(&adm(0), "Width").await.unwrap_err();
    assert!(format!("{err:?}").contains("not a Command"), "got {err:?}");
}

#[tokio::test]
async fn feature_states_report_bounds_lock_and_errors() {
    let h = harness(1).await;
    let names = ["ExposureTime", "AcquisitionFrameRate", "PixelFormat", "TriggerSoftware", "NoSuchFeature"];
    let states = h
        .dev
        .genicam_feature_states(&adm(0), names.iter().map(|n| n.to_string()).collect())
        .await
        .unwrap();
    let states = serde_json::to_value(states).unwrap();
    let got: Vec<&str> = states.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(got, names, "request order is kept");

    let exposure = &states[0];
    assert_eq!(exposure["node_type"], "Float");
    assert_eq!(exposure["value"], "10000");
    assert_eq!(exposure["min"], json!(1.0));
    assert_eq!(exposure["max"], json!(1_000_000.0));
    assert_eq!(exposure["inc"], json!(1.0));
    assert_eq!(exposure["unit"], "us");
    assert_eq!(exposure["available"], true);
    assert_eq!(exposure["locked"], false);
    assert!(exposure["error"].is_null());

    assert_eq!(states[1]["max"], json!(500.0), "pMax evaluated");
    assert_eq!(states[1]["locked"], false);
    assert_eq!(states[2]["available_entries"], json!([1, 2, 3]));
    assert!(states[3]["value"].is_null(), "commands have no value");
    assert_eq!(states[3]["node_type"], "Command");
    assert_eq!(states[4]["error"], "Feature not found");
    assert!(states[4]["node_type"].is_null());

    h.dev.genicam_set_feature_value(&adm(0), "AcquisitionFrameRateEnable", "false").await.unwrap();
    let states = h.dev.genicam_feature_states(&adm(0), vec!["AcquisitionFrameRate".into()]).await.unwrap();
    assert!(states[0].locked, "locked while its enable is off");
}

#[tokio::test]
async fn pixel_format_entries_follow_the_scan_type() {
    let h = harness(1).await;
    h.dev.genicam_set_feature_value(&adm(0), "DeviceScanType", "Linescan3D").await.unwrap();
    let states = h.dev.genicam_feature_states(&adm(0), vec!["PixelFormat".into()]).await.unwrap();
    let state = serde_json::to_value(&states[0]).unwrap();
    assert_eq!(state["available_entries"], json!([4]), "only Coord3D_C16 in Linescan3D");
    assert_eq!(state["value"], "4", "the device moved onto it by itself");
    // The GenICam client writes any entry; the device refuses it.
    h.dev.genicam_set_feature_value(&adm(0), "PixelFormat", "Mono16").await.unwrap_err();

    h.dev.genicam_set_feature_value(&adm(0), "DeviceScanType", "Areascan").await.unwrap();
    let states = h.dev.genicam_feature_states(&adm(0), vec!["PixelFormat".into()]).await.unwrap();
    assert_eq!(serde_json::to_value(&states[0]).unwrap()["available_entries"], json!([1, 2, 3]));
}

/// A live stream on device 0 of `h`, plus its message channel.
fn start_live(h: &Arc<Harness>, format: LiveFormat) -> (mpsc::Receiver<LiveMsg>, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(2);
    let h = h.clone();
    let pump = tokio::spawn(async move {
        let opts = LiveOptions { format, ..Default::default() };
        h.stream.stream_live(&adm(0), opts, tx).await.expect("live stream failed");
    });
    (rx, pump)
}

async fn next_msg(rx: &mut mpsc::Receiver<LiveMsg>) -> LiveMsg {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("no live message within 5s")
        .expect("live stream ended")
}

async fn next_info(rx: &mut mpsc::Receiver<LiveMsg>) -> StreamInfo {
    loop {
        if let LiveMsg::Info(info) = next_msg(rx).await {
            return info;
        }
    }
}

#[tokio::test]
async fn feature_requests_during_a_live_stream_are_carried_out_inside_it() {
    let h = Arc::new(harness(1).await);
    let (mut rx, pump) = start_live(&h, LiveFormat::Raw);
    let info = next_info(&mut rx).await;
    assert_eq!((info.width, info.height), (W, H));

    let started = std::time::Instant::now();
    h.dev.genicam_set_feature_value(&adm(0), "ExposureTime", "2222").await.unwrap();
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ExposureTime").await.unwrap(), "2222");
    let states = h.dev.genicam_feature_states(&adm(0), vec!["ExposureTime".into(), "Width".into()]).await.unwrap();
    assert_eq!(states[0].value.as_deref(), Some("2222"));
    h.dev.genicam_execute_command(&adm(0), "TriggerSoftware").await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());

    // A stream-owned feature is refused, and the stream survives it.
    let err = h.dev.genicam_set_feature_value(&adm(0), "PixelFormat", "3").await.unwrap_err();
    assert!(format!("{err:?}").contains("live stream"), "got {err:?}");
    match next_msg(&mut rx).await {
        LiveMsg::Frame { payload, .. } => assert_eq!(payload.len(), (W * H) as usize),
        LiveMsg::Info(info) => panic!("unexpected re-announce {info:?}"),
    }

    drop(rx);
    tokio::time::timeout(Duration::from_secs(5), pump).await.unwrap().unwrap();
    // Back to plain checkouts once the stream has handed the camera back.
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ExposureTime").await.unwrap(), "2222");
}

#[tokio::test]
async fn a_geometry_change_during_a_live_stream_is_announced_again() {
    let h = Arc::new(harness(1).await);
    let (mut rx, pump) = start_live(&h, LiveFormat::Raw);
    next_info(&mut rx).await;

    h.dev.genicam_set_feature_value(&adm(0), "Width", "32").await.unwrap();
    let info = next_info(&mut rx).await;
    assert_eq!((info.width, info.height), (32, H));
    // Every frame after the new announcement has the new geometry.
    for _ in 0..3 {
        match next_msg(&mut rx).await {
            LiveMsg::Frame { payload, .. } => assert_eq!(payload.len(), (32 * H) as usize),
            LiveMsg::Info(info) => panic!("unexpected second re-announce {info:?}"),
        }
    }

    drop(rx);
    tokio::time::timeout(Duration::from_secs(5), pump).await.unwrap().unwrap();
}

#[tokio::test]
async fn a_feature_locked_during_acquisition_is_written_with_the_stream_paused() {
    use aravis_port::core::bootstrap::offset::STREAM_CHANNEL_0_PORT;

    let h = Arc::new(harness(1).await);
    let (mut rx, pump) = start_live(&h, LiveFormat::Raw);
    next_info(&mut rx).await;
    // Each acquisition start binds a fresh GVSP socket, so the programmed host port tells
    // whether the stream was restarted.
    let port = || h._cameras[0].peek_register(STREAM_CHANNEL_0_PORT);
    let before = port();

    // Gain has no pIsLocked: written straight into the running acquisition.
    h.dev.genicam_set_feature_value(&adm(0), "Gain", "7").await.unwrap();
    assert_eq!(port(), before, "an unlocked feature must not restart acquisition");

    // ExposureTime is locked on TLParamsLocked, which a device may only apply at the next start.
    h.dev.genicam_set_feature_value(&adm(0), "ExposureTime", "3333").await.unwrap();
    assert_ne!(port(), before, "a TLParamsLocked feature must be written with acquisition paused");
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "ExposureTime").await.unwrap(), "3333");

    // Same geometry, so no new stream info: frames simply continue.
    match next_msg(&mut rx).await {
        LiveMsg::Frame { payload, .. } => assert_eq!(payload.len(), (W * H) as usize),
        LiveMsg::Info(info) => panic!("unexpected re-announce {info:?}"),
    }

    drop(rx);
    tokio::time::timeout(Duration::from_secs(5), pump).await.unwrap().unwrap();
}

#[tokio::test]
async fn a_restart_that_delivers_nothing_is_started_again() {
    let store = Arc::new(Box::new(CameraStore::new()));
    let (dev, stream) = controllers(&store).await;
    // Slow frames, so the camera can be silenced after a restart before its first frame.
    let camera = FakeCamera::start(FakeCameraConfig {
        frame_period: Duration::from_millis(500),
        ..Default::default()
    })
    .unwrap();
    camera.poke_register(feature::WIDTH, W);
    camera.poke_register(feature::HEIGHT, H);
    camera.poke_register(feature::ACQUISITION_ACTIVE, 1);
    connect(&dev, 0, camera.local_addr()).await;
    let h = Arc::new(Harness { _cameras: vec![camera], dev, stream });

    let (mut rx, pump) = start_live(&h, LiveFormat::Jpeg);
    next_info(&mut rx).await;
    next_msg(&mut rx).await;

    // A paused write restarts acquisition; then the device "ignores" that start.
    h.dev.genicam_set_feature_value(&adm(0), "ExposureTime", "4444").await.unwrap();
    h._cameras[0].poke_register(feature::ACQUISITION_ACTIVE, 0);
    while rx.try_recv().is_ok() {}

    // Started again after FIRST_FRAME_TIMEOUT, well before the 10 s stall closes the stream.
    let started = std::time::Instant::now();
    let msg = tokio::time::timeout(Duration::from_secs(8), rx.recv()).await.expect("no frame within 8s");
    assert!(matches!(msg, Some(LiveMsg::Frame { .. })), "{msg:?}");
    assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());

    drop(rx);
    tokio::time::timeout(Duration::from_secs(5), pump).await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_racing_a_close_reconnects() {
    let h = Arc::new(harness(1).await);
    // A live stream holds the camera, so the close has to wait for it to stop.
    let (tx, mut rx) = mpsc::channel(2);
    let pump = {
        let h = h.clone();
        tokio::spawn(async move {
            let opts = LiveOptions { format: LiveFormat::Raw, ..Default::default() };
            h.stream.stream_live(&adm(0), opts, tx).await
        })
    };
    assert!(matches!(next_msg(&mut rx).await, LiveMsg::Info(_)));
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let close = {
        let h = h.clone();
        tokio::spawn(async move { h.dev.close(0, CloseReason::Request, None).await })
    };
    // The slot is closing as soon as it no longer counts as connected.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !h.dev.connected(&Client::Anonymous).await.is_empty() {
        assert!(std::time::Instant::now() < deadline, "the close never marked the device");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    // Waits for the close, connects the device again and reads.
    assert_eq!(h.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap(), W.to_string());
    close.await.unwrap().unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), pump).await.unwrap().unwrap();
    assert_eq!(ended.unwrap(), LiveEnd::DeviceClosed(CloseReason::Request), "the stream says why it ended");
    drain.await.unwrap();
    assert_eq!(h.dev.connected(&Client::Anonymous).await.len(), 1, "the read reopened the device");
}
