/**
 * Greyscale frames as the server delivers them, and the window/level rendering that turns them
 * into something visible.
 *
 * Everything here is a plain function over typed arrays so it can be unit-tested without a DOM
 * and shared by the live view and the burst player.
 */

import type { ZSTDDecoder } from 'zstddec';

/** A decoded mono frame. `pixels` holds one element per pixel, in the sensor's native range. */
export interface GrayFrame {
  width: number;
  height: number;
  /** Significant bits per pixel: 8, or 10–16 for the unpacked deep formats. */
  bitDepth: number;
  pixels: Uint8Array | Uint16Array;
}

/** What one pass over a frame learns: its value range and a histogram for the range control. */
export interface FrameStats {
  min: number;
  max: number;
  /** {@link HISTOGRAM_BINS} bins spanning `0..2^bitDepth`. */
  hist: Uint32Array;
}

export const HISTOGRAM_BINS = 256;

/** Typed arrays use host byte order; the wire is little-endian. Every current browser is LE. */
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Largest value a pixel of this depth can hold. */
export function maxValue(bitDepth: number): number {
  return 2 ** bitDepth - 1;
}

export function bytesPerPixel(bitDepth: number): number {
  return bitDepth > 8 ? 2 : 1;
}

/**
 * Wrap raw frame bytes: `width*height` bytes for 8-bit, or as many little-endian `u16`s above
 * that. No copy is made when the platform allows a direct view.
 */
export function decodeRaw(
  bytes: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
): GrayFrame {
  const count = width * height;
  const bpp = bytesPerPixel(bitDepth);
  if (count <= 0) {
    throw new Error(`invalid frame size ${width}x${height}`);
  }
  if (bytes.byteLength < count * bpp) {
    throw new Error(
      `frame is ${bytes.byteLength} bytes but ${width}x${height} at ${bitDepth} bit needs ${count * bpp}`,
    );
  }

  if (bpp === 1) {
    return { width, height, bitDepth, pixels: bytes.subarray(0, count) };
  }

  let pixels: Uint16Array;
  if (HOST_LITTLE_ENDIAN && bytes.byteOffset % 2 === 0) {
    pixels = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
  } else {
    pixels = new Uint16Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    for (let i = 0; i < count; i++) {
      pixels[i] = view.getUint16(i * 2, true);
    }
  }
  return { width, height, bitDepth, pixels };
}

/**
 * Decode a `zstd` frame: one zstd frame holding a residual per pixel, the pixel minus the one
 * above it (0 above the first row), wrapping at the pixel width. 16-bit residuals are zigzagged and
 * stored as a plane of low bytes followed by a plane of high bytes. The result is exactly the raw
 * frame. Rejects a payload that is not such a frame of this size.
 */
export async function decodeZstd(
  bytes: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
): Promise<GrayFrame> {
  const count = width * height;
  const bpp = bytesPerPixel(bitDepth);
  if (count <= 0) {
    throw new Error(`invalid frame size ${width}x${height}`);
  }
  // A corrupt frame comes back at another length (the decoder doesn't throw), so this check is
  // what catches it.
  const residuals = (await zstdDecoder()).decode(bytes, count * bpp);
  if (residuals.byteLength !== count * bpp) {
    throw new Error(`not a zstd frame of ${width}x${height} at ${bitDepth} bit`);
  }

  if (bpp === 1) {
    // In place: a Uint8Array stores the sum modulo 256, which is the wrap the encoder used.
    for (let i = width; i < count; i++) {
      residuals[i] += residuals[i - width];
    }
    return { width, height, bitDepth, pixels: residuals };
  }

  const pixels = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const z = residuals[i] | (residuals[count + i] << 8);
    // Un-zigzag; a negative difference wraps when stored, as it did when it was taken.
    const d = (z >>> 1) ^ -(z & 1);
    pixels[i] = i < width ? d : pixels[i - width] + d;
  }
  return { width, height, bitDepth, pixels };
}

let decoder: Promise<ZSTDDecoder> | null = null;

/**
 * zstd's own decoder built for WebAssembly, several times faster than one in JavaScript. Loaded on
 * first use, so pages that never see a zstd frame don't carry it.
 */
function zstdDecoder(): Promise<ZSTDDecoder> {
  if (!decoder) {
    decoder = import('zstddec').then(async ({ ZSTDDecoder }) => {
      const d = new ZSTDDecoder();
      await d.init();
      return d;
    });
    // A failed load is tried again next time rather than remembered.
    decoder.catch(() => (decoder = null));
  }
  return decoder;
}

/** Decode a greyscale JPEG to an 8-bit frame (the red channel; all three are equal). */
export async function decodeJpeg(data: Blob | Uint8Array): Promise<GrayFrame> {
  // WebCodecs hands over the decoded pixels without a canvas round trip, about four times
  // faster for a full-size frame; the canvas path is for browsers without it.
  if (typeof ImageDecoder !== 'undefined') {
    try {
      return await decodeWithImageDecoder(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
    } catch {
      // A format this can't take apart: decode it the slow way.
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const ctx = scratchContext(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const pixels = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      pixels[i] = rgba[j];
    }
    return { width, height, bitDepth: 8, pixels };
  } finally {
    bitmap.close();
  }
}

async function decodeWithImageDecoder(bytes: Uint8Array): Promise<GrayFrame> {
  const decoder = new ImageDecoder({ data: bytes, type: 'image/jpeg' });
  try {
    const { image } = await decoder.decode();
    try {
      const rect = image.visibleRect!;
      const buffer = new Uint8Array(image.allocationSize({ rect }));
      const planes = await image.copyTo(buffer, { rect });
      return grayFromPlanes(buffer, image.format, planes, rect.width, rect.height);
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

/**
 * The grey values of a decoded image as WebCodecs lays it out: the luma plane of a YUV format,
 * or one channel of a 4-byte RGB format (all three are equal in a greyscale image). Throws for a
 * format it doesn't know.
 */
export function grayFromPlanes(
  data: Uint8Array,
  format: string | null,
  planes: readonly { offset: number; stride: number }[],
  width: number,
  height: number,
): GrayFrame {
  let step: number;
  let channel: number;
  switch (format) {
    case 'I420':
    case 'I420A':
    case 'I422':
    case 'I444':
    case 'NV12':
      step = 1;
      channel = 0;
      break;
    case 'RGBA':
    case 'RGBX':
    case 'BGRA':
    case 'BGRX':
      step = 4;
      channel = 1;
      break;
    default:
      throw new Error(`unsupported decoded format ${format}`);
  }
  const { offset, stride } = planes[0];
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = offset + y * stride + channel;
    const out = y * width;
    if (step === 1) {
      pixels.set(data.subarray(row, row + width), out);
    } else {
      for (let x = 0, i = row; x < width; x++, i += 4) {
        pixels[out + x] = data[i];
      }
    }
  }
  return { width, height, bitDepth: 8, pixels };
}

/** Min, max and histogram in a single pass. */
export function analyze(frame: GrayFrame): FrameStats {
  const { pixels } = frame;
  const hist = new Uint32Array(HISTOGRAM_BINS);
  const shift = Math.max(0, frame.bitDepth - Math.log2(HISTOGRAM_BINS));
  const lastBin = HISTOGRAM_BINS - 1;
  if (pixels instanceof Uint8Array && HISTOGRAM_BINS === 256) {
    // One bin per value: the histogram alone gives min and max, so the loop only counts. About
    // twice as fast on a full-size 8-bit frame, which the live view analyses every frame it draws.
    for (let i = 0; i < pixels.length; i++) {
      hist[pixels[i]]++;
    }
    let min = 0;
    let max = 0;
    if (pixels.length > 0) {
      while (hist[min] === 0) min++;
      max = lastBin;
      while (hist[max] === 0) max--;
    }
    return { min, max, hist };
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < min) min = v;
    if (v > max) max = v;
    // A camera that sets bits above its declared depth must not index past the last bin.
    const bin = v >> shift;
    hist[bin > lastBin ? lastBin : bin]++;
  }
  if (pixels.length === 0) {
    min = 0;
    max = 0;
  }
  return { min, max, hist };
}

/** Combine per-frame stats, e.g. for a range that holds still across a whole burst. */
export function mergeStats(all: FrameStats[]): FrameStats | null {
  if (all.length === 0) {
    return null;
  }
  const hist = new Uint32Array(HISTOGRAM_BINS);
  let min = Infinity;
  let max = -Infinity;
  for (const s of all) {
    min = Math.min(min, s.min);
    max = Math.max(max, s.max);
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      hist[i] += s.hist[i];
    }
  }
  return { min, max, hist };
}

/**
 * A lookup table from pixel value to a packed opaque grey RGBA pixel, mapping `lo` to black and
 * `hi` to white, linearly in between and clamped outside.
 *
 * Sized for the storage type rather than `bitDepth`, so out-of-range values from a misbehaving
 * camera still land in the table (and clamp to white).
 */
export function buildLut(lo: number, hi: number, bitDepth: number): Uint32Array {
  const size = bytesPerPixel(bitDepth) === 1 ? 256 : 65536;
  const lut = new Uint32Array(size);
  const span = Math.max(hi - lo, 1e-9);
  for (let v = 0; v < size; v++) {
    const g = v <= lo ? 0 : v >= hi ? 255 : Math.round(((v - lo) / span) * 255);
    lut[v] = packGrey(g);
  }
  return lut;
}

/** Write `frame` through `lut` into an `ImageData` of the same size. */
export function renderInto(frame: GrayFrame, lut: Uint32Array, out: ImageData): void {
  const target = new Uint32Array(out.data.buffer, out.data.byteOffset, out.width * out.height);
  const { pixels } = frame;
  const n = Math.min(target.length, pixels.length);
  for (let i = 0; i < n; i++) {
    target[i] = lut[pixels[i]];
  }
}

/** Render a frame onto a fresh canvas, for exporting it as an image. */
export function renderToCanvas(
  frame: GrayFrame,
  lo: number,
  hi: number,
): OffscreenCanvas | HTMLCanvasElement {
  const canvas = makeCanvas(frame.width, frame.height);
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  const image = ctx.createImageData(frame.width, frame.height);
  renderInto(frame, buildLut(lo, hi, frame.bitDepth), image);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function packGrey(g: number): number {
  // RGBA bytes in memory order; as a host-order u32 that is ABGR on little-endian.
  return HOST_LITTLE_ENDIAN
    ? (0xff000000 | (g << 16) | (g << 8) | g) >>> 0
    : ((g << 24) | (g << 16) | (g << 8) | 0xff) >>> 0;
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;

function scratchContext(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (!scratch || scratch.width !== width || scratch.height !== height) {
    scratch = makeCanvas(width, height);
  }
  return scratch.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
}
