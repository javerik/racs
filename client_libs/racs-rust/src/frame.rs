use crate::error::{Error, Result};
use crate::models::ImageFormat;

/// One image, with what it takes to decode it.
///
/// For [`ImageFormat::Raw`], `data` is `width * height` pixels row by row: one byte each at a
/// `bit_depth` of 8, otherwise a little-endian u16 each in the range `0..2^bit_depth`. For
/// [`ImageFormat::Zstd`] it is those pixels losslessly compressed, which [`Frame::to_u16`] and
/// [`Frame::to_raw`] decode. For [`ImageFormat::Jpeg`] it is a JPEG file holding the top 8
/// significant bits.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
    pub pixel_format: String,
    pub bit_depth: u8,
    /// Live stream only: the message number in the session.
    pub frame_number: Option<u32>,
    /// Live stream only: frames dropped so far in the session.
    pub dropped: Option<u32>,
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("bytes", &self.data.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .field("format", &self.format)
            .field("pixel_format", &self.pixel_format)
            .field("bit_depth", &self.bit_depth)
            .field("frame_number", &self.frame_number)
            .field("dropped", &self.dropped)
            .finish()
    }
}

impl Frame {
    /// A raw Mono8 frame.
    pub fn mono8(data: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            data,
            width,
            height,
            format: ImageFormat::Raw,
            pixel_format: "Mono8".into(),
            bit_depth: 8,
            frame_number: None,
            dropped: None,
        }
    }

    pub fn bytes_per_pixel(&self) -> usize {
        if self.bit_depth > 8 { 2 } else { 1 }
    }

    /// The pixels as one u16 each, row by row. 8-bit pixels are widened. A zstd frame is decoded
    /// first.
    pub fn to_u16(&self) -> Result<Vec<u16>> {
        let decoded;
        let data = match self.format {
            ImageFormat::Raw => &self.data,
            ImageFormat::Zstd => {
                decoded = self.decode_zstd()?;
                &decoded
            }
            ImageFormat::Jpeg => {
                return Err(Error::Protocol(
                    "to_u16 needs a raw or zstd frame, this one is jpeg; decode `data` instead".into(),
                ))
            }
        };
        let pixels = self.width as usize * self.height as usize;
        let expected = pixels * self.bytes_per_pixel();
        if data.len() != expected {
            return Err(Error::Protocol(format!(
                "frame holds {} bytes, {}x{} at {} bit needs {expected}",
                data.len(),
                self.width,
                self.height,
                self.bit_depth
            )));
        }
        Ok(if self.bytes_per_pixel() == 1 {
            data.iter().map(|&p| u16::from(p)).collect()
        } else {
            data.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect()
        })
    }

    /// This frame with raw pixels: a zstd frame decoded, a raw one as it is.
    pub fn to_raw(&self) -> Result<Frame> {
        match self.format {
            ImageFormat::Raw => Ok(self.clone()),
            ImageFormat::Zstd => Ok(Frame { data: self.decode_zstd()?, format: ImageFormat::Raw, ..self.clone() }),
            ImageFormat::Jpeg => Err(Error::Protocol("to_raw needs a raw or zstd frame, this one is jpeg".into())),
        }
    }

    /// The raw bytes of a zstd frame. It decompresses to a residual per pixel: the pixel minus the
    /// one above it (minus 0 in the first row), wrapping at the pixel width. Above 8 bit the
    /// residuals are zigzagged and stored as every low byte followed by every high byte.
    fn decode_zstd(&self) -> Result<Vec<u8>> {
        let width = self.width as usize;
        let count = width * self.height as usize;
        let size = count * self.bytes_per_pixel();
        if count == 0 {
            return Err(Error::Protocol(format!("invalid frame size {}x{}", self.width, self.height)));
        }
        let mut residuals = zstd::bulk::decompress(&self.data, size)
            .map_err(|e| Error::Protocol(format!("not a valid zstd frame: {e}")))?;
        if residuals.len() != size {
            return Err(Error::Protocol(format!(
                "zstd frame holds {} bytes, {}x{} at {} bit needs {size}",
                residuals.len(),
                self.width,
                self.height,
                self.bit_depth
            )));
        }
        if self.bytes_per_pixel() == 1 {
            for i in width..count {
                residuals[i] = residuals[i].wrapping_add(residuals[i - width]);
            }
            return Ok(residuals);
        }
        let (low, high) = residuals.split_at(count);
        let mut values = vec![0u16; count];
        for i in 0..count {
            let z = u16::from(low[i]) | u16::from(high[i]) << 8;
            let d = (z >> 1) ^ (z & 1).wrapping_neg();
            values[i] = if i < width { d } else { values[i - width].wrapping_add(d) };
        }
        Ok(values.iter().flat_map(|v| v.to_le_bytes()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_u16_follows_the_bit_depth() {
        assert_eq!(Frame::mono8(vec![1, 2, 3, 4, 5, 6], 3, 2).to_u16().unwrap(), [1, 2, 3, 4, 5, 6]);

        let twelve = Frame { bit_depth: 12, ..Frame::mono8(vec![1, 0, 0xFF, 0x0F, 0, 1], 3, 1) };
        assert_eq!(twelve.to_u16().unwrap(), [1, 4095, 256]);

        assert!(Frame::mono8(vec![0], 2, 2).to_u16().is_err());
        let jpeg = Frame { format: ImageFormat::Jpeg, ..Frame::mono8(vec![0xFF, 0xD8], 1, 1) };
        assert!(jpeg.to_u16().is_err());
    }

    fn zstd_frame(bit_depth: u8, residuals: &[u8]) -> Frame {
        Frame {
            format: ImageFormat::Zstd,
            bit_depth,
            ..Frame::mono8(zstd::bulk::compress(residuals, 1).unwrap(), 2, 2)
        }
    }

    #[test]
    fn zstd_frames_decode_to_the_pixels() {
        // Each residual is the pixel minus the one above, wrapping; 16-bit ones are zigzagged and
        // stored as low bytes, then high bytes. Row 0: zigzag(300) = 600, zigzag(5) = 10;
        // row 1: -1 -> 1, +1 -> 2.
        assert_eq!(zstd_frame(8, &[10, 20, 3, 254]).to_u16().unwrap(), [10, 20, 13, 18]);
        assert_eq!(zstd_frame(12, &[88, 10, 1, 2, 2, 0, 0, 0]).to_u16().unwrap(), [300, 5, 299, 6]);
        // 65535 is -1 from 0, and 0 is +1 from 65535.
        assert_eq!(zstd_frame(16, &[0, 1, 1, 2, 0, 0, 0, 0]).to_u16().unwrap(), [0, 65535, 65535, 0]);
    }

    #[test]
    fn to_raw_decodes_a_zstd_frame() {
        let frame = Frame { frame_number: Some(7), ..zstd_frame(12, &[88, 10, 1, 2, 2, 0, 0, 0]) };
        let raw = frame.to_raw().unwrap();
        assert_eq!((raw.format, raw.frame_number), (ImageFormat::Raw, Some(7)));
        assert_eq!(raw.data, [0x2C, 0x01, 5, 0, 0x2B, 0x01, 6, 0]);
        assert_eq!(raw.to_raw().unwrap(), raw);
        assert!(Frame { format: ImageFormat::Jpeg, ..raw }.to_raw().is_err());
    }

    #[test]
    fn a_bad_zstd_frame_is_an_error() {
        assert!(zstd_frame(8, &[1, 2, 3, 4, 5, 6]).to_u16().is_err());
        assert!(zstd_frame(8, &[1, 2, 3]).to_u16().is_err());
        let garbage = Frame { format: ImageFormat::Zstd, ..Frame::mono8(vec![1, 2, 3, 4], 2, 2) };
        assert!(garbage.to_u16().is_err());
    }
}
