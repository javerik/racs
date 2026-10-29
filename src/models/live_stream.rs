//! Types for the live-stream WebSocket at `/devices/{id}/stream/live`.
//!
//! Wire protocol, in order:
//!
//! ```text
//! text:   {"width":1280,"height":1024,"format":"jpeg","pixel_format":"Mono8","bit_depth":8,"packet_size":1500}
//! binary: [u32 LE frame_number][u32 LE frames_dropped][N bytes image]
//! ```
//!
//! The opening text message exists because the binary header carries no dimensions, and a `raw`
//! or `zstd` consumer cannot decode the frame without them: `width * height` bytes for 8-bit, or
//! `width * height` little-endian `u16`s when `bit_depth` is above 8.
//!
//! The text message is sent again whenever the geometry or the packet size changes mid-stream (a
//! forwarded `Width` or `GevSCPSPacketSize` write, or acquisition restarted after a change): each
//! one applies to every binary message after it until the next. Frame numbers and the dropped
//! counter are cumulative across it.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::controller::frame_codec::FrameEncoding;
use crate::models::pixel::PixelDepth;

/// Bytes of metadata in front of every binary frame message.
pub const FRAME_HEADER_LEN: usize = 8;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum LiveFormat {
    #[default]
    Jpeg,
    Raw,
    /// Lossless: prediction residuals in one zstd frame. See
    /// [`frame_codec::encode_zstd`](crate::controller::frame_codec::encode_zstd).
    Zstd,
}

impl LiveFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            LiveFormat::Jpeg => "jpeg",
            LiveFormat::Raw => "raw",
            LiveFormat::Zstd => "zstd",
        }
    }
}

/// The resolved settings a live stream runs with, after query defaults have been applied.
#[derive(Debug, Clone, Copy)]
pub struct LiveOptions {
    pub format: LiveFormat,
    /// JPEG quality 1–100; ignored for the other formats.
    pub quality: u8,
    /// Target frame rate. `None` means "send every frame the camera delivers".
    pub fps: Option<f32>,
    pub pixel_depth: PixelDepth,
}

impl LiveOptions {
    pub fn encoding(&self) -> FrameEncoding {
        match self.format {
            LiveFormat::Raw => FrameEncoding::Raw,
            LiveFormat::Jpeg => FrameEncoding::Jpeg { quality: self.quality },
            LiveFormat::Zstd => FrameEncoding::Zstd,
        }
    }
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self {
            format: LiveFormat::default(),
            quality: 80,
            fps: None,
            pixel_depth: PixelDepth::default(),
        }
    }
}

/// The opening text message of a live stream, repeated when the geometry changes.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StreamInfo {
    pub width: u32,
    pub height: u32,
    /// `"jpeg"`, `"raw"` or `"zstd"` — the encoding of every binary message that follows.
    pub format: String,
    /// The pixel format the frames were acquired in, read back from the camera.
    pub pixel_format: String,
    /// Significant bits per pixel. Above 8, raw frames carry two little-endian bytes per pixel
    /// in the range `0..2^bit_depth`; JPEG frames always carry the top 8 of them.
    pub bit_depth: u8,
    /// `GevSCPSPacketSize` the stream runs with: bytes per GVSP packet, IP and UDP headers
    /// included.
    pub packet_size: u16,
}

/// What a live capture hands to each viewer's WebSocket handler.
#[derive(Debug)]
pub enum LiveMsg {
    Info(StreamInfo),
    Frame {
        frame_number: u32,
        dropped: u32,
        /// Shared with the capture's other raw viewers.
        payload: Bytes,
    },
}

impl LiveMsg {
    /// Serialise a frame message: `[frame_number][dropped][image]`, both counters little-endian.
    pub fn frame_bytes(frame_number: u32, dropped: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
        out.extend_from_slice(&frame_number.to_le_bytes());
        out.extend_from_slice(&dropped.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_message_is_two_le_counters_then_the_image() {
        let msg = LiveMsg::frame_bytes(1, 258, &[0xAA, 0xBB]);
        assert_eq!(msg.len(), FRAME_HEADER_LEN + 2);
        assert_eq!(u32::from_le_bytes(msg[0..4].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(msg[4..8].try_into().unwrap()), 258);
        assert_eq!(&msg[8..], &[0xAA, 0xBB]);
    }

    #[test]
    fn the_format_query_value_is_lowercase() {
        assert_eq!(
            serde_json::from_str::<LiveFormat>("\"raw\"").unwrap(),
            LiveFormat::Raw
        );
        assert_eq!(
            serde_json::from_str::<LiveFormat>("\"zstd\"").unwrap(),
            LiveFormat::Zstd
        );
        assert_eq!(LiveFormat::default(), LiveFormat::Jpeg);
    }
}
