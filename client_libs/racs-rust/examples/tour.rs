//! A tour of the client against a running server:
//!
//! ```sh
//! cargo run --example tour -- http://localhost:8742 0
//! ```

use racs_client::{BurstRequest, LiveOptions, PixelDepth, RacsClient};

#[tokio::main]
async fn main() -> racs_client::Result<()> {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "http://localhost:8742".into());
    let device_id: u32 = args.next().and_then(|id| id.parse().ok()).unwrap_or(0);

    let client = RacsClient::new(&url)?;
    let cam = client.connect(device_id, None).await?;
    let info = cam.info().await?;
    println!("Device {device_id}: {} {} at {}", info.vendor, info.model, info.ip);

    let width: u32 = cam.get("Width").await?;
    let height: u32 = cam.get("Height").await?;
    let exposure: f64 = cam.get("ExposureTime").await?;
    println!("{width}x{height}, exposure {exposure} us");

    let jpeg = cam.grab_jpeg(Some(90)).await?;
    std::fs::write("frame.jpg", jpeg).expect("cannot write frame.jpg");
    println!("Saved frame.jpg");

    let mut live = cam.live(&LiveOptions::raw().pixel_depth(PixelDepth::Mono16)).await?;
    for _ in 0..10 {
        let Some(frame) = live.next_frame().await? else { break };
        let pixels = frame.to_u16()?;
        let mean = pixels.iter().map(|&p| f64::from(p)).sum::<f64>() / pixels.len() as f64;
        println!(
            "live #{}: {}x{} at {} bit, mean {mean:.1}, dropped {}",
            frame.frame_number.unwrap_or_default(),
            frame.width,
            frame.height,
            frame.bit_depth,
            frame.dropped.unwrap_or_default()
        );
    }
    live.close().await?;

    let job = cam.burst(&BurstRequest::new(5)).await?;
    let done = job.wait().await?;
    println!("Burst {}: {} frames captured", job.id(), done.captured_count);
    job.delete().await?;
    Ok(())
}
