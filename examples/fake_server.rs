//! The RACS API backed by in-process fake cameras, for clients that need a server but no hardware.
//!
//! ```sh
//! cargo run --release --example fake_server -- --port 8743
//! ```
//!
//! Serves the same `/api/v1` routes as `main` (no Swagger, no webapp) with `--cameras` fake
//! cameras already connected as devices `0..N`. Once bound it prints
//! `Listening at http://<addr>/api/v1`; with `--port 0` that line is the only way to learn the
//! port, which is what `client_libs/run-tests.sh` relies on.
//!
//! The fake cameras listen on loopback ports that discovery never probes. A device disconnected
//! here can still be connected again by id: the server remembers the address it was connected at,
//! which is also how a device closed by `--device-idle-timeout` comes back.

use std::io::Write;
use std::time::Duration;

use actix_web::{web, App, HttpServer};
use aravis_port::core::MacAddress;
use aravis_port_fakecamera::{feature, FakeCamera, FakeCameraConfig};
use clap::Parser;
use rust_cam_serve::app_context::AppContext;
use rust_cam_serve::endpoints::config_endpoints;
use rust_cam_serve::maintenance;
use rust_cam_serve::server_config::RuntimeConfig;

#[derive(Debug, Parser)]
#[command(about = "RACS API server backed by fake cameras")]
struct Args {
    /// Listener IP address
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Listener TCP port; 0 picks a free one
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Number of fake cameras, connected as devices 0..N
    #[arg(long, default_value_t = 2)]
    cameras: u8,
    /// Initial frame width of every camera
    #[arg(long, default_value_t = 64)]
    width: u32,
    /// Initial frame height of every camera
    #[arg(long, default_value_t = 32)]
    height: u32,
    /// Seconds a client session lives without a heartbeat (clamped to 5..=600)
    #[arg(long, default_value_t = 30)]
    session_timeout: u64,
    /// Seconds an unused device stays connected; 0 (the default here) never disconnects one
    #[arg(long, default_value_t = 0)]
    device_idle_timeout: u64,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();

    // Keep `GET /devices` off the real network, as the integration tests do.
    if std::env::var_os("RACS_DISCOVERY_BIND").is_none() {
        std::env::set_var("RACS_DISCOVERY_BIND", "127.0.0.1");
    }
    if std::env::var_os("RACS_DISCOVERY_TIMEOUT_MS").is_none() {
        std::env::set_var("RACS_DISCOVERY_TIMEOUT_MS", "50");
    }
    env_logger::init();

    let context = AppContext::new(RuntimeConfig::from_secs(args.session_timeout, args.device_idle_timeout)).await;
    maintenance::spawn(context.clone());

    // Held until the server stops: dropping a FakeCamera stops it.
    let mut cameras = Vec::new();
    for i in 0..args.cameras {
        let camera = FakeCamera::start(FakeCameraConfig {
            // Device ids are kept per MAC, so every camera needs its own.
            mac: MacAddress::new([0x00, 0x11, 0x22, 0x33, 0x44, 0x55 + i]),
            serial: format!("{:04}", i + 1),
            frame_period: Duration::from_millis(10),
            ..Default::default()
        })?;
        camera.poke_register(feature::WIDTH, args.width);
        camera.poke_register(feature::HEIGHT, args.height);
        camera.poke_register(feature::ACQUISITION_ACTIVE, 1);
        context
            .dev_ctrl
            .connect_by_addr(u32::from(i), camera.local_addr(), None)
            .await
            .unwrap_or_else(|e| panic!("Failed to connect fake camera {i} => {e}"));
        cameras.push(camera);
    }

    let server = HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(context.clone()))
            .service(web::scope("/api/v1").configure(config_endpoints))
    })
    .bind((args.host.as_str(), args.port))?;

    let addr = server.addrs()[0];
    println!("Listening at http://{addr}/api/v1");
    std::io::stdout().flush()?;

    let result = server.run().await;
    drop(cameras);
    result
}
