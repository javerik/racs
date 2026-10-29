//! Pixel depth selection shared by the live stream and burst jobs.
//!
//! The camera has the final say: a request for [`PixelDepth::Mono16`] is a request for the
//! deepest unpacked mono format the camera accepts, and what it actually ended up in is reported
//! back as a [`PixelLayout`] so clients never have to guess how to decode a raw frame. A 3D
//! profiler in Linescan3D offers no mono format at all, only a single-coordinate range format
//! (`Coord3D_C16`: one height per pixel), which is laid out the same way and tried last.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The pixel depth a client asks for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PixelDepth {
    /// One byte per pixel. The default, and what every endpoint delivered before this option.
    #[default]
    Mono8,
    /// Two little-endian bytes per pixel, in the sensor's native range (`0..2^bit_depth`).
    /// Negotiated as the first of `Mono16`, `Mono14`, `Mono12`, `Mono10`, `Coord3D_C16` the
    /// camera accepts.
    Mono16,
}

impl PixelDepth {
    /// The `PixelFormat` entries to try, best first.
    pub fn candidates(&self) -> &'static [&'static str] {
        match self {
            PixelDepth::Mono8 => &["Mono8", "Coord3D_C8"],
            PixelDepth::Mono16 => &["Mono16", "Mono14", "Mono12", "Mono10", "Coord3D_C16"],
        }
    }
}

/// The pixel layout frames were actually acquired in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelLayout {
    /// The camera's `PixelFormat`, read back after negotiation.
    pub pixel_format: String,
    /// Significant bits per pixel: 8, 10, 12, 14 or 16.
    pub bit_depth: u8,
}

impl PixelLayout {
    pub fn mono8() -> Self {
        Self::from_pixel_format("Mono8")
    }

    /// Derive the layout from a `PixelFormat` name.
    ///
    /// Only the unpacked mono formats and the single-coordinate 3D range formats (`Coord3D_C8`,
    /// `Coord3D_C16`: one value per pixel, laid out like Mono8/Mono16) are understood. Anything
    /// else (packed or colour formats) is treated as 8-bit, which is what every frame path
    /// assumed before 16-bit support existed.
    pub fn from_pixel_format(name: &str) -> Self {
        let bit_depth = match name {
            "Mono10" => 10,
            "Mono12" => 12,
            "Mono14" => 14,
            "Mono16" | "Coord3D_C16" => 16,
            _ => 8,
        };
        Self { pixel_format: name.to_string(), bit_depth }
    }

    pub fn bytes_per_pixel(&self) -> usize {
        if self.bit_depth > 8 { 2 } else { 1 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacked_mono_formats_map_to_their_depth() {
        assert_eq!(PixelLayout::from_pixel_format("Mono8").bit_depth, 8);
        assert_eq!(PixelLayout::from_pixel_format("Mono12").bit_depth, 12);
        assert_eq!(PixelLayout::from_pixel_format("Mono16").bytes_per_pixel(), 2);
        assert_eq!(PixelLayout::from_pixel_format("Mono10").bytes_per_pixel(), 2);
    }

    #[test]
    fn single_coordinate_3d_formats_are_unpacked() {
        let range = PixelLayout::from_pixel_format("Coord3D_C16");
        assert_eq!((range.bit_depth, range.bytes_per_pixel()), (16, 2));
        let range = PixelLayout::from_pixel_format("Coord3D_C8");
        assert_eq!((range.bit_depth, range.bytes_per_pixel()), (8, 1));
    }

    #[test]
    fn a_3d_range_format_is_the_last_resort_of_each_depth() {
        assert_eq!(PixelDepth::Mono8.candidates().first(), Some(&"Mono8"));
        assert_eq!(PixelDepth::Mono8.candidates().last(), Some(&"Coord3D_C8"));
        assert_eq!(PixelDepth::Mono16.candidates().first(), Some(&"Mono16"));
        assert_eq!(PixelDepth::Mono16.candidates().last(), Some(&"Coord3D_C16"));
    }

    #[test]
    fn unknown_formats_fall_back_to_8_bit() {
        // Packed formats would need unpacking that no frame path does; treating them as 8-bit is
        // the pre-existing behaviour rather than a new failure mode.
        let layout = PixelLayout::from_pixel_format("Mono12Packed");
        assert_eq!(layout.bit_depth, 8);
        assert_eq!(layout.bytes_per_pixel(), 1);
    }

    #[test]
    fn the_wire_value_is_lowercase() {
        assert_eq!(serde_json::from_str::<PixelDepth>("\"mono16\"").unwrap(), PixelDepth::Mono16);
        assert_eq!(PixelDepth::default(), PixelDepth::Mono8);
    }
}
