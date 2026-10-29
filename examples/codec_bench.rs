//! Measures the frame encodings of the live stream and burst jobs: time per frame, throughput on
//! one and on several threads, and compression ratio.
//!
//! ```sh
//! cargo run --release --example codec_bench -- [<burst export dir>] [--bits 12] [--frames N]
//! ```
//!
//! The best input is a burst export from the web UI (the "original" zip, unpacked: `meta.json`
//! plus `frame_*.raw`), i.e. real camera frames. Without one, noisy synthetic frames are made up.
//! `--bits 12` turns 8-bit frames into 12-bit ones (value × 16 plus shot and read noise), which
//! measures the 16-bit path on a real scene. The results behind the choices in `frame_codec` are
//! in `specs/live-compression.md`.

use std::cell::RefCell;
use std::path::Path;
use std::time::{Duration, Instant};

use rust_cam_serve::controller::encode_stage::encode_parallelism;
use rust_cam_serve::controller::frame_codec;
use rust_cam_serve::models::pixel::PixelLayout;

struct Frames {
    width: u32,
    height: u32,
    layout: PixelLayout,
    frames: Vec<Vec<u8>>,
    source: String,
}

type Codec = Box<dyn Fn(&[u8], &Frames) -> Vec<u8> + Sync>;

fn main() {
    let mut dir = None;
    let mut bits = None;
    let mut max_frames = 40usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bits" => bits = args.next().and_then(|b| b.parse::<u8>().ok()),
            "--frames" => max_frames = args.next().and_then(|n| n.parse().ok()).unwrap_or(max_frames),
            _ => dir = Some(arg),
        }
    }

    let mut frames = match &dir {
        Some(dir) => load_export(Path::new(dir), max_frames),
        None => synthetic(2176, 570, max_frames),
    };
    if bits.is_some_and(|b| b > 8) && frames.layout.bit_depth == 8 {
        frames = deepen(frames, bits.unwrap());
    }
    let pixels = frames.width as usize * frames.height as usize;
    println!(
        "{} · {} frames of {}x{} {} ({} bit) · {} encoder threads\n",
        frames.source,
        frames.frames.len(),
        frames.width,
        frames.height,
        frames.layout.pixel_format,
        frames.layout.bit_depth,
        encode_parallelism()
    );

    let codecs: Vec<(&str, Codec)> = vec![
        ("raw (copy)", Box::new(|f, s| frame_codec::copy_image(f, s.width, s.height, &s.layout).unwrap())),
        (
            "jpeg q80",
            Box::new(|f, s| frame_codec::encode_jpeg(f, s.width, s.height, &s.layout, 80).unwrap()),
        ),
        ("zstd 1, no prediction", Box::new(|f, _| zstd::bulk::compress(f, 1).unwrap())),
        ("zstd 1 defaults, predicted", Box::new(zstd_default_params)),
        (
            "zstd (shipped: tuned, predicted)",
            Box::new(|f, s| frame_codec::encode_zstd(f, s.width, s.height, &s.layout).unwrap()),
        ),
    ];

    println!(
        "{:34} {:>7} {:>10} {:>9} {:>11} {:>12}",
        "codec", "ratio", "ms/frame", "MB/s", "fps 1 thr", "fps parallel"
    );
    for (name, codec) in &codecs {
        let (per_frame, ratio) = single_thread(codec, &frames);
        let parallel = parallel_fps(codec, &frames, encode_parallelism());
        let mbps = (pixels * frames.layout.bytes_per_pixel()) as f64 / per_frame.as_secs_f64() / 1e6;
        println!(
            "{name:34} {ratio:7.2} {:10.2} {mbps:9.0} {:11.0} {parallel:12.0}",
            per_frame.as_secs_f64() * 1e3,
            1.0 / per_frame.as_secs_f64(),
        );
    }

    // The decoder clients mirror, checked on every frame and timed.
    let payloads: Vec<Vec<u8>> = frames
        .frames
        .iter()
        .map(|f| frame_codec::encode_zstd(f, frames.width, frames.height, &frames.layout).unwrap())
        .collect();
    let start = Instant::now();
    for (payload, frame) in payloads.iter().zip(&frames.frames) {
        let decoded = frame_codec::decode_zstd(payload, frames.width, frames.height, &frames.layout).unwrap();
        assert_eq!(&decoded, frame, "zstd did not round-trip");
    }
    let per_frame = start.elapsed() / payloads.len() as u32;
    println!("\nzstd decode (reference decoder): {:.2} ms/frame, round trip exact", per_frame.as_secs_f64() * 1e3);
}

/// Mean time per frame over at least a second of encoding, and the ratio of raw to encoded bytes.
fn single_thread(codec: &Codec, frames: &Frames) -> (Duration, f64) {
    // One pass to warm up caches and per-thread encoder state.
    let encoded: usize = frames.frames.iter().map(|f| codec(f, frames).len()).sum();
    let raw: usize = frames.frames.iter().map(Vec::len).sum();
    let start = Instant::now();
    let mut n = 0u32;
    while start.elapsed() < Duration::from_secs(1) {
        for f in &frames.frames {
            std::hint::black_box(codec(f, frames));
            n += 1;
        }
    }
    (start.elapsed() / n, raw as f64 / encoded as f64)
}

/// Frames per second `threads` threads encode together, each going through the frames in turn.
fn parallel_fps(codec: &Codec, frames: &Frames, threads: usize) -> f64 {
    let run = Duration::from_secs(1);
    let start = Instant::now();
    let total: usize = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|t| {
                scope.spawn(move || {
                    let mut n = 0;
                    let mut i = t;
                    while start.elapsed() < run {
                        std::hint::black_box(codec(&frames.frames[i % frames.frames.len()], frames));
                        n += 1;
                        i += 1;
                    }
                    n
                })
            })
            .collect();
        workers.into_iter().map(|w| w.join().unwrap()).sum()
    });
    total as f64 / start.elapsed().as_secs_f64()
}

/// The shipped prediction with zstd level 1's own match-finder settings.
fn zstd_default_params(frame: &[u8], s: &Frames) -> Vec<u8> {
    thread_local! {
        static STATE: RefCell<(Vec<u8>, Option<zstd::bulk::Compressor<'static>>)> = const { RefCell::new((Vec::new(), None)) };
    }
    STATE.with_borrow_mut(|(residuals, compressor)| {
        frame_codec::predict(frame, s.width as usize, s.layout.bytes_per_pixel(), residuals);
        compressor
            .get_or_insert_with(|| zstd::bulk::Compressor::new(1).unwrap())
            .compress(residuals)
            .unwrap()
    })
}

fn load_export(dir: &Path, max_frames: usize) -> Frames {
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("meta.json")).expect("meta.json")).expect("meta.json is JSON");
    assert_eq!(meta["format"], "raw", "only raw exports carry the pixels as they are");
    let width = meta["width"].as_u64().expect("width") as u32;
    let height = meta["height"].as_u64().expect("height") as u32;
    let layout = PixelLayout::from_pixel_format(meta["pixel_format"].as_str().unwrap_or("Mono8"));
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .expect("export directory")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "raw"))
        .collect();
    names.sort();
    let frames: Vec<Vec<u8>> = names.iter().take(max_frames).map(|p| std::fs::read(p).expect("frame")).collect();
    assert!(!frames.is_empty(), "no frame_*.raw in {}", dir.display());
    Frames { width, height, layout, frames, source: dir.display().to_string() }
}

/// A smooth scene with a few edges, plus Gaussian noise of σ ≈ 2 grey values.
fn synthetic(width: u32, height: u32, count: usize) -> Frames {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let frames = (0..count)
        .map(|k| {
            let mut frame = Vec::with_capacity((width * height) as usize);
            for y in 0..height {
                for x in 0..width {
                    let (fx, fy) = (x as f64 / width as f64, y as f64 / height as f64);
                    let scene = 60.0
                        + 50.0 * (6.0 * fx + k as f64 * 0.05).sin() * (4.0 * fy).cos()
                        + if (x / 97 + y / 61) % 3 == 0 { 70.0 } else { 0.0 };
                    frame.push((scene + 2.0 * rng.gaussian()).clamp(0.0, 255.0) as u8);
                }
            }
            frame
        })
        .collect();
    Frames { width, height, layout: PixelLayout::mono8(), frames, source: "synthetic".into() }
}

/// 8-bit frames as `bits`-bit ones: each value scaled up, plus shot and read noise.
fn deepen(frames: Frames, bits: u8) -> Frames {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let scale = f64::from(1u32 << (bits - 8));
    let max = f64::from((1u32 << bits) - 1);
    let deep = frames
        .frames
        .iter()
        .map(|f| {
            f.iter()
                .flat_map(|&v| {
                    let signal = f64::from(v) * scale;
                    let noise = (4.0 + signal / 8.0).sqrt() * rng.gaussian();
                    ((signal + noise).clamp(0.0, max) as u16).to_le_bytes()
                })
                .collect()
        })
        .collect();
    let format = format!("Mono{bits}");
    Frames {
        layout: PixelLayout::from_pixel_format(&format),
        frames: deep,
        source: format!("{} deepened to {bits} bit", frames.source),
        ..frames
    }
}

/// xorshift64*, enough noise for a benchmark.
struct Rng(u64);

impl Rng {
    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Box–Muller.
    fn gaussian(&mut self) -> f64 {
        let (u, v) = (self.next_f64().max(1e-12), self.next_f64());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}
