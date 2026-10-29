//! Turning a raw acquisition buffer into what an endpoint hands back.
//!
//! Shared by [`StreamCtrl`](crate::controller::stream_ctrl::StreamCtrl) (one-shot grabs and the
//! live stream) and [`GrabCtrl`](crate::controller::grab_ctrl::GrabCtrl) (burst jobs). It lives in
//! its own module rather than on one of them because both need the identical trim/encode
//! behaviour — the raw `width * height * bytes_per_pixel` contract is enforced in exactly one place,
//! and so is the `zstd` wire format ([`encode_zstd`]).

use std::cell::RefCell;
use std::io;

use jpeg_encoder::{ColorType, Encoder as JpegEncoder};
use tracing::debug;
use zstd::zstd_safe::CParameter;

use crate::controller::stream_ctrl::StreamCtrlError;
use crate::models::pixel::{PixelDepth, PixelLayout};
use crate::stores::conn_camera::CamHandle;

/// Put the camera into an unpacked mono (or, on a 3D camera in Linescan3D, single-coordinate
/// range) no-chunk mode of the requested depth, and report the layout it actually ended up in.
///
/// Best-effort by design: a camera that lacks a format or either feature simply streams in
/// whatever mode it is already in, which is better than failing the request outright. The
/// read-back is what makes that safe — frames are trimmed and encoded against the format the
/// camera reports, not the one that was asked for. aravis-port reports a missing feature or enum
/// entry as a stringified `GenIcam` error rather than a distinct variant, so there is nothing
/// more specific to match on.
pub fn prepare_pixel_format(handle: &CamHandle, depth: PixelDepth) -> PixelLayout {
    for candidate in depth.candidates() {
        match handle.camera.write::<String>("PixelFormat", candidate.to_string()) {
            Ok(()) => break,
            Err(e) => debug!("could not set PixelFormat={candidate} => {e}"),
        }
    }
    if let Err(e) = handle.camera.write::<bool>("ChunkModeActive", false) {
        debug!("could not disable ChunkModeActive => {e}");
    }
    match handle.camera.read::<String>("PixelFormat") {
        Ok(name) => PixelLayout::from_pixel_format(&name),
        Err(_) => PixelLayout::mono8(),
    }
}

/// Fall back to the `Width`/`Height` features for cameras that omit dimensions from the GVSP
/// leader, exactly as the one-shot grab does.
pub fn feature_dimensions(handle: &CamHandle) -> (u32, u32) {
    let width = handle.camera.read::<i64>("Width").unwrap_or(0).max(0) as u32;
    let height = handle.camera.read::<i64>("Height").unwrap_or(0).max(0) as u32;
    (width, height)
}

/// Whether `len` bytes fall short of a whole `width x height` frame in `layout`.
///
/// The long-running loops (live stream, burst) check this before they keep a frame, and treat a
/// short one like an incomplete one: skipped and counted, rather than ending the run on the
/// error [`copy_image`] would return. Unknown dimensions (0) are not short: those stay the
/// encoder's error to report.
pub fn is_short(len: usize, width: u32, height: u32, layout: &PixelLayout) -> bool {
    len < width as usize * height as usize * layout.bytes_per_pixel()
}

/// How a frame goes out: the `format` of a live stream or burst job, with its settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameEncoding {
    /// The pixels as they are.
    Raw,
    /// An 8-bit greyscale JPEG.
    Jpeg { quality: u8 },
    /// Lossless: the residuals of [`predict`] in one zstd frame. See [`encode_zstd`].
    Zstd,
}

/// Copy exactly the `width * height * bytes_per_pixel` image bytes out of a frame buffer.
///
/// The buffer can legitimately be longer than the image — trailing chunk data, or padding — and
/// only the image is copied, so it is never carried further. Clients (and the raw endpoint's
/// contract) expect exactly `width * height` bytes for Mono8, twice that for 16-bit.
pub fn copy_image(
    data: &[u8],
    width: u32,
    height: u32,
    layout: &PixelLayout,
) -> Result<Vec<u8>, StreamCtrlError> {
    let expected = width as usize * height as usize * layout.bytes_per_pixel();
    if expected == 0 {
        return Err(StreamCtrlError::InvalidFrame);
    }
    if data.len() < expected {
        return Err(StreamCtrlError::Error(format!(
            "frame is {} bytes but {width}x{height} needs {expected}",
            data.len()
        )));
    }
    Ok(data[..expected].to_vec())
}

/// Encode an image [`copy_image`] produced. Raw hands the pixels back as they are.
pub fn encode(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    layout: &PixelLayout,
    encoding: FrameEncoding,
) -> Result<Vec<u8>, StreamCtrlError> {
    match encoding {
        FrameEncoding::Raw => check_size(&pixels, width, height, layout).map(|()| pixels),
        _ => encode_slice(&pixels, width, height, layout, encoding),
    }
}

/// [`encode`] for an image shared with others (a live capture's frame, fanned out to several
/// viewers). Raw copies the pixels.
pub fn encode_slice(
    pixels: &[u8],
    width: u32,
    height: u32,
    layout: &PixelLayout,
    encoding: FrameEncoding,
) -> Result<Vec<u8>, StreamCtrlError> {
    match encoding {
        FrameEncoding::Raw => check_size(pixels, width, height, layout).map(|()| pixels.to_vec()),
        FrameEncoding::Jpeg { quality } => encode_jpeg(pixels, width, height, layout, quality),
        FrameEncoding::Zstd => encode_zstd(pixels, width, height, layout),
    }
}

/// `Ok` when `pixels` is exactly one `width x height` image in `layout`.
fn check_size(pixels: &[u8], width: u32, height: u32, layout: &PixelLayout) -> Result<(), StreamCtrlError> {
    let expected = width as usize * height as usize * layout.bytes_per_pixel();
    if expected == 0 {
        return Err(StreamCtrlError::InvalidFrame);
    }
    if pixels.len() != expected {
        return Err(StreamCtrlError::Error(format!(
            "image is {} bytes but {width}x{height} needs {expected}",
            pixels.len()
        )));
    }
    Ok(())
}

/// Encode an image as an 8-bit greyscale JPEG.
///
/// JPEG has no 16-bit greyscale, so deeper frames keep their top 8 significant bits — a
/// fixed, predictable mapping, unlike any auto-scaling that would make brightness jump between
/// frames. Clients that need the full range ask for raw or zstd instead.
pub fn encode_jpeg(
    pixels: &[u8],
    width: u32,
    height: u32,
    layout: &PixelLayout,
    quality: u8,
) -> Result<Vec<u8>, StreamCtrlError> {
    check_size(pixels, width, height, layout)?;
    let (Ok(w), Ok(h)) = (u16::try_from(width), u16::try_from(height)) else {
        return Err(StreamCtrlError::EncodingError(format!(
            "{width}x{height} is too large for JPEG (65535 at most)"
        )));
    };
    let mono8;
    let pixels = if layout.bytes_per_pixel() == 1 {
        pixels
    } else {
        mono8 = to_mono8(pixels, layout);
        &mono8
    };
    // Compressed greyscale is rarely more than half the pixels; start there rather than growing
    // the buffer from nothing.
    let mut jpg_bytes: Vec<u8> = Vec::with_capacity(pixels.len() / 2);
    JpegEncoder::new(&mut jpg_bytes, quality)
        .encode(pixels, w, h, ColorType::Luma)
        .map_err(StreamCtrlError::from)?;
    Ok(jpg_bytes)
}

/// Reduce little-endian 16-bit pixels to their top 8 significant bits.
fn to_mono8(pixels: &[u8], layout: &PixelLayout) -> Vec<u8> {
    let shift = layout.bit_depth.saturating_sub(8);
    pixels
        .chunks_exact(2)
        .map(|px| (u16::from_le_bytes([px[0], px[1]]) >> shift).min(255) as u8)
        .collect()
}

/// zstd's fastest level that still entropy-codes literals. Negative levels leave them as they
/// are, and prediction residuals are almost all literals: they barely compress there.
const ZSTD_LEVEL: i32 = 1;

/// A small match-finder table and long minimum matches: residuals of a noisy image rarely repeat,
/// so time spent looking for matches is mostly wasted. Measured on real frames, this is about a
/// third faster than level 1's defaults at the same ratio (`specs/live-compression.md`).
const ZSTD_HASH_LOG: u32 = 12;
const ZSTD_MIN_MATCH: u32 = 7;

thread_local! {
    /// One compression context per encoding thread, reused for every frame it encodes.
    static ZSTD: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
    /// The residuals of the frame being encoded, reused likewise.
    static RESIDUALS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn new_compressor() -> io::Result<zstd::bulk::Compressor<'static>> {
    let mut compressor = zstd::bulk::Compressor::new(ZSTD_LEVEL)?;
    compressor.set_parameter(CParameter::HashLog(ZSTD_HASH_LOG))?;
    compressor.set_parameter(CParameter::MinMatch(ZSTD_MIN_MATCH))?;
    // Decoders size their output from it; it is the default, but the format depends on it.
    compressor.set_parameter(CParameter::ContentSizeFlag(true))?;
    Ok(compressor)
}

/// Encode an image losslessly: [`predict`]'s residuals, compressed as a single zstd frame with
/// its content size in the header.
///
/// This is the `zstd` wire format, and [`decode_zstd`] its reference decoder. Prediction from
/// the row above turns a camera image into small residuals around zero, which zstd's entropy
/// coder packs close to their entropy (about 2.3x on real 8-bit frames) at a few hundred MB/s.
pub fn encode_zstd(
    pixels: &[u8],
    width: u32,
    height: u32,
    layout: &PixelLayout,
) -> Result<Vec<u8>, StreamCtrlError> {
    check_size(pixels, width, height, layout)?;
    RESIDUALS.with_borrow_mut(|residuals| {
        predict(pixels, width as usize, layout.bytes_per_pixel(), residuals);
        ZSTD.with_borrow_mut(|slot| {
            let compressor = match slot {
                Some(compressor) => compressor,
                None => slot.insert(new_compressor().map_err(zstd_error)?),
            };
            compressor.compress(residuals).map_err(zstd_error)
        })
    })
}

/// Decode a payload of [`encode_zstd`] back into the image's raw bytes.
pub fn decode_zstd(
    payload: &[u8],
    width: u32,
    height: u32,
    layout: &PixelLayout,
) -> Result<Vec<u8>, StreamCtrlError> {
    let expected = width as usize * height as usize * layout.bytes_per_pixel();
    if expected == 0 {
        return Err(StreamCtrlError::InvalidFrame);
    }
    let residuals = zstd::bulk::decompress(payload, expected).map_err(zstd_error)?;
    if residuals.len() != expected {
        return Err(StreamCtrlError::EncodingError(format!(
            "zstd payload holds {} bytes, {width}x{height} needs {expected}",
            residuals.len()
        )));
    }
    Ok(unpredict(&residuals, width as usize, layout.bytes_per_pixel()))
}

fn zstd_error(e: io::Error) -> StreamCtrlError {
    StreamCtrlError::EncodingError(format!("zstd: {e}"))
}

/// The prediction step of the `zstd` format, writing `pixels`' residuals to `out` (resized to
/// fit, no other allocation once it has grown).
///
/// Every pixel is predicted by the one above it, and by 0 in the first row; the residual is the
/// difference, wrapping at the pixel width. 8-bit residuals are bytes in pixel order. 16-bit
/// (little-endian) ones are zigzagged (`(d << 1) ^ (d >> 15)` of the residual `d` as `i16`, so
/// small differences of either sign become small numbers) and split into two planes, every low
/// byte first, then every high byte: the high plane is then mostly zeros, which is what lets a
/// 12-bit image compress as well as an 8-bit one.
pub fn predict(pixels: &[u8], width: usize, bytes_per_pixel: usize, out: &mut Vec<u8>) {
    let n = pixels.len() / bytes_per_pixel;
    // Every byte is overwritten below, so the buffer is only resized, never cleared.
    out.resize(n * bytes_per_pixel, 0);
    if n == 0 || width == 0 {
        return;
    }
    if bytes_per_pixel == 1 {
        out[..width].copy_from_slice(&pixels[..width]);
        for ((res, row), above) in out[width..]
            .chunks_exact_mut(width)
            .zip(pixels[width..].chunks_exact(width))
            .zip(pixels.chunks_exact(width))
        {
            for ((r, p), a) in res.iter_mut().zip(row).zip(above) {
                *r = p.wrapping_sub(*a);
            }
        }
        return;
    }

    let (low, high) = out.split_at_mut(n);
    let row_bytes = width * 2;
    for (y, row) in pixels.chunks_exact(row_bytes).enumerate() {
        let lo = &mut low[y * width..(y + 1) * width];
        let hi = &mut high[y * width..(y + 1) * width];
        if y == 0 {
            for ((l, h), p) in lo.iter_mut().zip(hi.iter_mut()).zip(row.chunks_exact(2)) {
                let z = zigzag(u16::from_le_bytes([p[0], p[1]]));
                *l = z as u8;
                *h = (z >> 8) as u8;
            }
            continue;
        }
        let above = &pixels[(y - 1) * row_bytes..y * row_bytes];
        for (((l, h), p), a) in lo.iter_mut().zip(hi.iter_mut()).zip(row.chunks_exact(2)).zip(above.chunks_exact(2)) {
            let d = u16::from_le_bytes([p[0], p[1]]).wrapping_sub(u16::from_le_bytes([a[0], a[1]]));
            let z = zigzag(d);
            *l = z as u8;
            *h = (z >> 8) as u8;
        }
    }
}

/// The inverse of [`predict`]: the image's raw bytes from its residuals.
pub fn unpredict(residuals: &[u8], width: usize, bytes_per_pixel: usize) -> Vec<u8> {
    let n = residuals.len() / bytes_per_pixel;
    if n == 0 || width == 0 {
        return Vec::new();
    }
    if bytes_per_pixel == 1 {
        let mut pixels = residuals.to_vec();
        for y in 1..n / width {
            let (done, rest) = pixels.split_at_mut(y * width);
            let above = &done[(y - 1) * width..];
            for (p, a) in rest[..width].iter_mut().zip(above) {
                *p = p.wrapping_add(*a);
            }
        }
        return pixels;
    }

    let (low, high) = residuals.split_at(n);
    let mut pixels = vec![0u8; n * 2];
    // The row above, decoded; zeros for the first row, which is what it was predicted from.
    let mut above = vec![0u16; width];
    for ((out, lo), hi) in pixels.chunks_exact_mut(width * 2).zip(low.chunks_exact(width)).zip(high.chunks_exact(width)) {
        for (((o, a), l), h) in out.chunks_exact_mut(2).zip(above.iter_mut()).zip(lo).zip(hi) {
            *a = a.wrapping_add(unzigzag(u16::from(*l) | u16::from(*h) << 8));
            o.copy_from_slice(&a.to_le_bytes());
        }
    }
    pixels
}

/// Map a wrapped 16-bit difference to an unsigned value that is small when the difference is.
fn zigzag(d: u16) -> u16 {
    let d = d as i16;
    ((d << 1) ^ (d >> 15)) as u16
}

fn unzigzag(z: u16) -> u16 {
    (z >> 1) ^ (z & 1).wrapping_neg()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mono8() -> PixelLayout {
        PixelLayout::mono8()
    }

    /// A deterministic noisy image: a gradient plus pseudo-random noise, in `layout`'s width.
    fn noisy(width: u32, height: u32, layout: &PixelLayout) -> Vec<u8> {
        let max = (1u32 << layout.bit_depth) - 1;
        let mut seed = 0x2545_f491u32;
        let mut out = Vec::new();
        for y in 0..height {
            for x in 0..width {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let v = ((x + y) * max / (width + height)).saturating_add(seed % 7).min(max);
                if layout.bytes_per_pixel() == 1 {
                    out.push(v as u8);
                } else {
                    out.extend_from_slice(&(v as u16).to_le_bytes());
                }
            }
        }
        out
    }

    #[test]
    fn copy_image_drops_trailing_chunk_data() {
        let data = vec![7u8; 16 * 8 + 40];
        let image = copy_image(&data, 16, 8, &mono8()).unwrap();
        assert_eq!(image.len(), 16 * 8);
    }

    #[test]
    fn copy_image_rejects_a_short_frame() {
        // Better a clear error than handing a truncated buffer to an encoder, which would fail
        // with something far less obvious.
        let err = copy_image(&[0u8; 10], 16, 8, &mono8()).unwrap_err();
        assert!(matches!(err, StreamCtrlError::Error(_)), "got {err:?}");
    }

    #[test]
    fn a_frame_is_short_only_below_its_geometry() {
        let mono16 = PixelLayout::from_pixel_format("Mono16");
        assert!(is_short(16 * 8 - 1, 16, 8, &mono8()));
        assert!(!is_short(16 * 8, 16, 8, &mono8()));
        assert!(!is_short(16 * 8 + 40, 16, 8, &mono8()));
        assert!(is_short(16 * 8, 16, 8, &mono16));
        assert!(!is_short(0, 0, 8, &mono8()));
    }

    #[test]
    fn copy_image_rejects_zero_dimensions() {
        assert!(matches!(copy_image(&[0u8; 10], 0, 8, &mono8()).unwrap_err(), StreamCtrlError::InvalidFrame));
    }

    #[test]
    fn copy_image_keeps_two_bytes_per_pixel_for_16_bit() {
        let layout = PixelLayout::from_pixel_format("Mono16");
        let image = copy_image(&[1u8; 16 * 8 * 2 + 20], 16, 8, &layout).unwrap();
        assert_eq!(image.len(), 16 * 8 * 2);
        // Half the bytes is a short frame in 16-bit, not a complete Mono8 one.
        assert!(copy_image(&[1u8; 16 * 8], 16, 8, &layout).is_err());
    }

    #[test]
    fn encoding_needs_exactly_one_image() {
        for encoding in [FrameEncoding::Raw, FrameEncoding::Jpeg { quality: 80 }, FrameEncoding::Zstd] {
            assert!(encode(vec![0u8; 16 * 8 + 1], 16, 8, &mono8(), encoding).is_err(), "{encoding:?}");
            assert!(encode(vec![0u8; 16 * 8], 16, 8, &mono8(), encoding).is_ok(), "{encoding:?}");
        }
        let raw = encode(vec![3u8; 16 * 8], 16, 8, &mono8(), FrameEncoding::Raw).unwrap();
        assert_eq!(raw, vec![3u8; 16 * 8], "raw is the pixels as they are");
    }

    #[test]
    fn to_mono8_keeps_the_top_significant_bits() {
        let mono12 = PixelLayout::from_pixel_format("Mono12");
        let pixels: Vec<u8> = [0u16, 16, 4095].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(to_mono8(&pixels, &mono12), vec![0, 1, 255]);

        let mono16 = PixelLayout::from_pixel_format("Mono16");
        let pixels: Vec<u8> = [0x1234u16, 0xffff].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(to_mono8(&pixels, &mono16), vec![0x12, 0xff]);
    }

    #[test]
    fn jpeg_takes_8_and_16_bit_frames() {
        let jpeg = encode_jpeg(&[0u8; 16 * 8], 16, 8, &mono8(), 80).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");
        let jpeg = encode_jpeg(&[0x80u8; 16 * 8 * 2], 16, 8, &PixelLayout::from_pixel_format("Mono16"), 80).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");
    }

    #[test]
    fn jpeg_refuses_dimensions_beyond_its_limit() {
        let err = encode_jpeg(&[0u8; 70_000], 70_000, 1, &mono8(), 80).unwrap_err();
        assert!(matches!(err, StreamCtrlError::EncodingError(_)), "got {err:?}");
    }

    #[test]
    fn zstd_round_trips_every_depth_and_shape() {
        for format in ["Mono8", "Mono10", "Mono12", "Mono16", "Coord3D_C16"] {
            let layout = PixelLayout::from_pixel_format(format);
            for (w, h) in [(1, 1), (1, 9), (9, 1), (7, 5), (64, 48), (333, 17)] {
                let image = noisy(w, h, &layout);
                let payload = encode_zstd(&image, w, h, &layout).unwrap();
                assert_eq!(decode_zstd(&payload, w, h, &layout).unwrap(), image, "{format} {w}x{h}");
            }
        }
    }

    #[test]
    fn zstd_round_trips_differences_that_wrap() {
        // 0 next to 65535 (and 0 under 255) is the largest residual there is, in both directions.
        let layout = PixelLayout::from_pixel_format("Mono16");
        let image: Vec<u8> = [0u16, 65535, 65535, 0, 1, 32768, 32767, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let payload = encode_zstd(&image, 2, 4, &layout).unwrap();
        assert_eq!(decode_zstd(&payload, 2, 4, &layout).unwrap(), image);

        let image = vec![0u8, 255, 255, 0, 128, 127];
        let payload = encode_zstd(&image, 2, 3, &mono8()).unwrap();
        assert_eq!(decode_zstd(&payload, 2, 3, &mono8()).unwrap(), image);
    }

    #[test]
    fn residuals_follow_the_documented_layout() {
        // Clients implement the decoder by hand from the documentation, so pin it: the row above
        // predicts (0 for the first row), and 16-bit residuals are zigzagged and split into a
        // plane of low bytes followed by a plane of high bytes.
        let mut out = Vec::new();
        predict(&[10, 20, 13, 18], 2, 1, &mut out);
        assert_eq!(out, vec![10, 20, 3, 254]);

        let pixels: Vec<u8> = [300u16, 5, 299, 6].iter().flat_map(|v| v.to_le_bytes()).collect();
        predict(&pixels, 2, 2, &mut out);
        // Row 0: zigzag(300) = 600, zigzag(5) = 10. Row 1: -1 -> 1, +1 -> 2.
        assert_eq!(out, vec![600u16 as u8, 10, 1, 2, (600u16 >> 8) as u8, 0, 0, 0]);
    }

    #[test]
    fn a_zstd_payload_is_one_frame_with_its_content_size() {
        let image = noisy(32, 8, &mono8());
        let payload = encode_zstd(&image, 32, 8, &mono8()).unwrap();
        assert_eq!(&payload[..4], &[0x28, 0xB5, 0x2F, 0xFD], "zstd magic");
        assert_eq!(
            zstd::zstd_safe::get_frame_content_size(&payload).unwrap(),
            Some(32 * 8),
            "decoders size their output from the header"
        );
        assert_eq!(zstd::zstd_safe::find_frame_compressed_size(&payload).unwrap(), payload.len());
    }

    #[test]
    fn a_noisy_image_compresses() {
        let layout = PixelLayout::from_pixel_format("Mono12");
        let image = noisy(256, 64, &layout);
        let payload = encode_zstd(&image, 256, 64, &layout).unwrap();
        assert!(payload.len() * 2 < image.len(), "{} of {} bytes", payload.len(), image.len());
    }

    #[test]
    fn decode_zstd_rejects_a_payload_of_the_wrong_size() {
        let payload = encode_zstd(&noisy(16, 8, &mono8()), 16, 8, &mono8()).unwrap();
        assert!(decode_zstd(&payload, 16, 9, &mono8()).is_err());
        assert!(decode_zstd(&payload, 16, 4, &mono8()).is_err());
        assert!(decode_zstd(&payload[..payload.len() - 3], 16, 8, &mono8()).is_err());
    }
}
