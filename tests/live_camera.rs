//! Tests that need real hardware. Replaces the old in-module tests that hardcoded 1280x1024 and
//! panicked when no camera was attached.
//!
//! ```text
//! RACS_LIVE_CAMERA_IP=169.254.133.91 cargo test --test live_camera -- --ignored --test-threads=1
//! ```
//!
//! `--test-threads=1` is required: aravis-port takes the camera's control channel exclusively, so
//! two tests connecting at once will fight over it. These are `#[ignore]` so a normal `cargo test`
//! stays hardware-free.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rust_cam_serve::controller::device_ctrl::DeviceCtrl;
use rust_cam_serve::controller::stream_ctrl::{LiveEnd, StreamCtrl};
use rust_cam_serve::models::live_stream::{LiveFormat, LiveMsg, LiveOptions, StreamInfo};
use rust_cam_serve::rcs_erros::RcsError;
use rust_cam_serve::stores::camera_store::CameraStore;
use rust_cam_serve::stores::job_store::JobStore;
use rust_cam_serve::events::EventBus;
use rust_cam_serve::server_config::RuntimeConfig;
use rust_cam_serve::models::stream_errors::StreamErrorStore;
use rust_cam_serve::stores::client_store::{Admission, ClientStore};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The controllers' calls as the server makes them for no client.
fn adm(id: u32) -> Admission {
    Admission::server(id)
}

const GVCP_PORT: u16 = 3956;

/// The camera under test, or `None` when `RACS_LIVE_CAMERA_IP` isn't set.
fn camera_addr() -> Option<SocketAddrV4> {
    let ip: Ipv4Addr = std::env::var("RACS_LIVE_CAMERA_IP").ok()?.parse().ok()?;
    Some(SocketAddrV4::new(ip, GVCP_PORT))
}

struct Live {
    dev: Arc<DeviceCtrl>,
    stream: Arc<StreamCtrl>,
}

/// Connect to the live camera as device 0, or return `None` to skip.
async fn connect() -> Option<Live> {
    let addr = camera_addr()?;
    let store = Arc::new(Box::new(CameraStore::new()));
    let runtime = RuntimeConfig::default();
    let events = Arc::new(EventBus::new(runtime.event_capacity));
    let clients = Arc::new(ClientStore::new(events.clone(), &runtime));
    let dev = DeviceCtrl::new(store.clone(), Arc::new(JobStore::new()), clients.clone(), events).await.unwrap();
    let stream = StreamCtrl::new(store.clone(), clients, Arc::new(StreamErrorStore::new()));
    dev.connect_by_addr(0, addr, None)
        .await
        .unwrap_or_else(|e| panic!("failed to connect to {addr}: {e:?}"));
    Some(Live {
        dev: Arc::new(dev),
        stream: Arc::new(stream),
    })
}

macro_rules! live {
    () => {
        match connect().await {
            Some(live) => live,
            None => {
                eprintln!("skipping: set RACS_LIVE_CAMERA_IP to run live-camera tests");
                return;
            }
        }
    };
}

async fn dimensions(live: &Live) -> (usize, usize) {
    let width: usize = live.dev.genicam_get_feature_value(&adm(0), "Width").await.unwrap().parse().unwrap();
    let height: usize = live.dev.genicam_get_feature_value(&adm(0), "Height").await.unwrap().parse().unwrap();
    (width, height)
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn reads_identity_and_geometry() {
    let live = live!();
    let (width, height) = dimensions(&live).await;
    // Read rather than asserted against constants: the ROI is whatever the last run left behind.
    assert!(width > 0 && height > 0, "implausible geometry {width}x{height}");

    let model = live.dev.genicam_get_feature_value(&adm(0), "DeviceModelName").await.unwrap();
    assert!(!model.is_empty(), "DeviceModelName should not be empty");
    println!("camera {model} at {width}x{height}");
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn round_trips_exposure_time() {
    let live = live!();
    let original: f64 = live
        .dev
        .genicam_get_feature_value(&adm(0), "ExposureTime")
        .await
        .unwrap()
        .parse()
        .unwrap();

    let bumped = original + 500.0;
    live.dev
        .genicam_set_feature_value(&adm(0), "ExposureTime", &bumped.to_string())
        .await
        .unwrap();
    let read_back: f64 = live
        .dev
        .genicam_get_feature_value(&adm(0), "ExposureTime")
        .await
        .unwrap()
        .parse()
        .unwrap();
    assert!((read_back - bumped).abs() < 1.0, "wrote {bumped}, read {read_back}");

    // Leave the camera as we found it — an over-exposed sensor washes out later frames.
    live.dev
        .genicam_set_feature_value(&adm(0), "ExposureTime", &original.to_string())
        .await
        .unwrap();
    let restored: f64 = live
        .dev
        .genicam_get_feature_value(&adm(0), "ExposureTime")
        .await
        .unwrap()
        .parse()
        .unwrap();
    assert!((restored - original).abs() < 1.0, "failed to restore exposure");
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn reads_pixel_format_as_an_integer() {
    let live = live!();
    // The endpoint's contract is the integer value, not the symbolic name.
    let value = live.dev.genicam_get_feature_value(&adm(0), "PixelFormat").await.unwrap();
    let parsed: i64 = value.parse().unwrap_or_else(|_| panic!("PixelFormat should be an integer, got {value:?}"));

    // It must also be one of the entries `/gc/categories` advertises for that node.
    let categories = live.dev.genicam_categories_json(&adm(0)).await.unwrap();
    let node = categories
        .iter()
        .flat_map(|c| c.nodes.iter())
        .find(|n| n.name == "PixelFormat")
        .expect("PixelFormat should be listed");
    let enums = node.enums.as_ref().expect("PixelFormat should carry enum entries");
    assert!(
        enums.iter().any(|e| e.value == parsed),
        "current value {parsed} is not among {:?}",
        enums.iter().map(|e| (e.string_value.clone(), e.value)).collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn grabs_a_raw_frame_matching_the_reported_geometry() {
    let live = live!();
    let (width, height) = dimensions(&live).await;

    let frame = live.stream.grab_raw_frame(&adm(0)).await.unwrap();
    // The exact byte count is the assertion that matters: a payload stride that drifts per packet
    // inflates the length and interleaves zero gaps through the image while still reporting a
    // successful frame.
    assert_eq!(frame.len(), width * height, "Mono8 frame should be exactly width*height");
    assert!(frame.iter().any(|&b| b != 0), "frame is entirely zero");
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn grabs_a_jpeg_frame_matching_the_reported_geometry() {
    let live = live!();
    let (width, height) = dimensions(&live).await;

    let jpeg = live.stream.grab_jpeg_frame(&adm(0), 90).await.unwrap();
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");

    // Confirm the encoder was handed the geometry it claimed, by reading the SOF0 dimensions
    // back out of the JPEG itself.
    let (jw, jh) = jpeg_dimensions(&jpeg).expect("no SOF marker in JPEG");
    assert_eq!((jw as usize, jh as usize), (width, height));
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn serves_the_genicam_xml() {
    let live = live!();
    let xml = live.dev.genicam_xml(&adm(0)).await.unwrap();
    assert!(xml.contains("RegisterDescription"), "not a GenICam document");
    assert!(xml.len() > 1000, "suspiciously small document: {} bytes", xml.len());
}

#[tokio::test]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn reconnects_after_disconnect() {
    let live = live!();
    let addr = camera_addr().unwrap();

    live.dev.disconnect(&adm(0), false).await.unwrap();
    // The camera holds its control channel until the heartbeat lapses, so give it a moment.
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;

    live.dev.connect_by_addr(0, addr, None).await.expect("reconnect failed");
    let (width, _) = dimensions(&live).await;
    assert!(width > 0);
}

/// A raw Mono8 live stream on device 0, as the WebSocket endpoint runs one.
struct LiveRun {
    rx: mpsc::Receiver<LiveMsg>,
    task: JoinHandle<Result<LiveEnd, RcsError>>,
}

impl LiveRun {
    fn start(live: &Live) -> Self {
        let (tx, rx) = mpsc::channel(4);
        let stream = live.stream.clone();
        let opts = LiveOptions {
            format: LiveFormat::Raw,
            ..LiveOptions::default()
        };
        let task = tokio::spawn(async move { stream.stream_live(&adm(0), opts, tx).await });
        Self { rx, task }
    }

    async fn next(&mut self) -> LiveMsg {
        tokio::time::timeout(Duration::from_secs(15), self.rx.recv())
            .await
            .expect("timed out waiting for the live stream")
            .expect("the live stream ended")
    }

    /// The next stream info, skipping frames still on their way from before it.
    async fn next_info(&mut self) -> StreamInfo {
        loop {
            if let LiveMsg::Info(info) = self.next().await {
                return info;
            }
        }
    }

    /// `n` frames, each checked to be a whole `width * height` image. Returns the dropped counter
    /// after the last one and how long they took.
    async fn frames(&mut self, n: usize, width: usize, height: usize) -> (u32, Duration) {
        let started = Instant::now();
        let mut last_dropped = 0;
        for i in 0..n {
            match self.next().await {
                LiveMsg::Frame { payload, dropped, .. } => {
                    assert_eq!(payload.len(), width * height, "frame {i} is not a whole Mono8 image");
                    last_dropped = dropped;
                }
                LiveMsg::Info(info) => panic!("unexpected stream info {info:?} at frame {i}"),
            }
        }
        (last_dropped, started.elapsed())
    }

    /// Stop as the WebSocket endpoint does when its client leaves.
    async fn stop(self) {
        drop(self.rx);
        let result = self.task.await.expect("live stream task panicked");
        result.expect("the live stream ended with an error");
    }
}

/// The sizes the packet-size sweep covers, from a standard 1500 MTU up to the jumbo frames the
/// AT C6 tops out at.
const PACKET_SIZE_SWEEP: [u16; 8] = [1500, 2000, 3000, 4000, 5000, 6000, 7000, 7960];

async fn set_packet_size(live: &Live, size: u16) {
    live.dev
        .genicam_set_feature_value(&adm(0), "GevSCPSPacketSize", &size.to_string())
        .await
        .unwrap_or_else(|e| panic!("writing GevSCPSPacketSize {size} failed: {e}"));
}

/// Every packet size from 1500 to 7960 that the link carries: written through the GenICam
/// endpoint, kept by a raw grab, and used by a live stream that delivers whole frames. Then the
/// size is changed and searched for while a stream runs. Needs a jumbo-frame link (MTU 9000) to
/// cover the whole range; sizes above the link MTU are skipped. Restores the packet size.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a live camera; set RACS_LIVE_CAMERA_IP"]
async fn streams_at_packet_sizes_1500_to_7960() {
    const FRAMES: usize = 20;
    let live = live!();
    let (width, height) = dimensions(&live).await;
    let info = live.dev.packet_size(&adm(0)).await.unwrap();
    println!(
        "camera {width}x{height}, packet size {} (bounds {}..={} step {}), link {:?} MTU {:?}",
        info.packet_size, info.min, info.max, info.inc, info.interface, info.link_mtu
    );
    let sizes: Vec<u16> = PACKET_SIZE_SWEEP
        .iter()
        .map(|&s| (s / info.inc * info.inc).clamp(info.min, info.max))
        .filter(|&s| info.link_mtu.is_none_or(|mtu| s as u32 <= mtu))
        .collect();
    if sizes.len() < PACKET_SIZE_SWEEP.len() {
        println!("link MTU {:?}: only sweeping {sizes:?}", info.link_mtu);
    }

    for &size in &sizes {
        set_packet_size(&live, size).await;
        let read: u16 = live.dev.genicam_get_feature_value(&adm(0), "GevSCPSPacketSize").await.unwrap().parse().unwrap();
        assert_eq!(read, size, "GevSCPSPacketSize read back");

        let frame = live.stream.grab_raw_frame(&adm(0)).await.unwrap_or_else(|e| panic!("grab at {size} failed: {e}"));
        assert_eq!(frame.len(), width * height, "grab at {size}");
        assert_eq!(live.dev.packet_size(&adm(0)).await.unwrap().packet_size, size, "a grab changed the packet size");

        let mut run = LiveRun::start(&live);
        let announced = run.next_info().await;
        assert_eq!(announced.packet_size, size, "the stream must run with the camera's packet size");
        let (dropped, took) = run.frames(FRAMES, width, height).await;
        run.stop().await;
        println!("{size:>5} B: {FRAMES} whole frames in {took:.2?} ({dropped} dropped)");
        assert_eq!(live.dev.packet_size(&adm(0)).await.unwrap().packet_size, size, "the stream changed the packet size");
    }

    // Changed while streaming: the stream reopens its channel and carries on.
    let (Some(&smallest), Some(&largest)) = (sizes.first(), sizes.last()) else {
        panic!("no packet size to test fits the link MTU {:?}", info.link_mtu);
    };
    set_packet_size(&live, largest).await;
    let mut run = LiveRun::start(&live);
    assert_eq!(run.next_info().await.packet_size, largest);
    run.frames(3, width, height).await;

    set_packet_size(&live, smallest).await;
    assert_eq!(run.next_info().await.packet_size, smallest, "a change mid-stream is announced");
    run.frames(FRAMES, width, height).await;

    let auto = live.dev.auto_packet_size(&adm(0)).await.unwrap();
    println!("auto packet size during the stream: {auto:?}");
    assert!(auto.test_packets, "the camera answered no test packet");
    assert_eq!(auto.previous, smallest);
    assert!(auto.packet_size >= largest, "auto settled on {} below the working {largest}", auto.packet_size);
    assert_eq!(run.next_info().await.packet_size, auto.packet_size);
    run.frames(FRAMES, width, height).await;
    run.stop().await;

    if let Err(e) = live
        .dev
        .genicam_set_feature_value(&adm(0), "GevSCPSPacketSize", &info.packet_size.to_string())
        .await
    {
        eprintln!("couldn't restore packet size {}: {e}", info.packet_size);
    }
}

/// Width and height from a JPEG's SOF0/SOF2 marker.
fn jpeg_dimensions(data: &[u8]) -> Option<(u16, u16)> {
    let mut i = 2; // skip SOI
    while i + 9 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        // SOF0 (baseline) or SOF2 (progressive).
        if marker == 0xC0 || marker == 0xC2 {
            let height = u16::from_be_bytes([data[i + 5], data[i + 6]]);
            let width = u16::from_be_bytes([data[i + 7], data[i + 8]]);
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}
