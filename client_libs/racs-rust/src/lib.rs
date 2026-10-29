//! Async client for a [RACS](https://codeberg.org/javerik/RACS-RustAravisCamServe) camera server:
//! device discovery and connection, typed GenICam feature access, single frames, the live stream
//! (WebSocket) and burst jobs.
//!
//! A [`Camera`] holds the device id, so nothing else needs to pass it around:
//!
//! ```no_run
//! use racs_client::{BurstRequest, LiveOptions, RacsClient};
//!
//! # async fn demo() -> racs_client::Result<()> {
//! let client = RacsClient::new("http://localhost:8742")?;
//! let cam = client.connect(0, None).await?;
//!
//! cam.set("ExposureTime", 5000.0).await?;
//! let width: u32 = cam.get("Width").await?;
//!
//! let mut live = cam.live(&LiveOptions::raw().fps(10.0)).await?;
//! if let Some(frame) = live.next_frame().await? {
//!     println!("{}x{} at {} bit", frame.width, frame.height, frame.bit_depth);
//! }
//! live.close().await?;
//!
//! let job = cam.burst(&BurstRequest::new(20)).await?;
//! job.wait().await?;
//! let first = job.frame(0).await?;
//! job.delete().await?;
//! # Ok(()) }
//! ```
//!
//! The client identifies itself with a session, created with its first request. Other clients see
//! it, and a session can hold a device's lease (`ro-shared`: only it writes, `exclusive`: only it
//! uses the device):
//!
//! ```no_run
//! use racs_client::{Mode, RacsClient};
//!
//! # async fn demo() -> racs_client::Result<()> {
//! let client = RacsClient::builder("http://localhost:8742").name("line-script").build()?;
//! tokio::spawn(client.clone().keep_alive());
//! let cam = client.connect_as(0, Mode::Exclusive, None).await?;
//! cam.set("ExposureTime", 5000.0).await?;
//! cam.release(false).await?;
//! client.close().await?;
//! # Ok(()) }
//! ```
//!
//! [`RacsClient`] also has one method per REST route, taking the device id each time.

mod burst;
mod camera;
mod client;
mod error;
mod events;
mod frame;
mod live;
pub mod models;
mod value;

pub use burst::BurstJob;
pub use camera::Camera;
pub use client::{RacsClient, RacsClientBuilder};
pub use error::{ApiError, Error, Result};
pub use events::EventStream;
pub use frame::Frame;
pub use live::LiveStream;
pub use models::{
    AccessRefusal, AutoPacketSize, BurstJobInfo, BurstRequest, DeviceAccess, DisconnectResult, Event, EventKind,
    FeatureState, ImageFormat, ImageEntry, JobStatus, LiveOptions, Mode, OnFailure, PacketSizeInfo, PixelDepth, Role,
    SessionCreated, StreamInfo,
};
pub use value::{FeatureValue, FromFeatureValue, IntoFeatureValue};
