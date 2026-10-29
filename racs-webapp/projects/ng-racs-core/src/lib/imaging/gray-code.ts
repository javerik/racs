/**
 * Decoding Gray-code stripes a camera filmed off the laserline view: every camera pixel learns the
 * view position it sees, and the pixels seeing the same stretch of the view (a cell) give one
 * screen ↔ sensor point pair. Works however small a part of the view the camera sees.
 *
 * Frames are first shrunk by block averaging (`downsample`), so a large sensor costs one pass over
 * its bytes and the rest works on a small plane.
 */

import type { GrayFrame } from './frame';
import { applyHomography, reprojectionRms, solveHomography, type Mat3, type PointPair } from './homography';

/** A frame shrunk by `factor`: pixel `i` averages a `factor`×`factor` block of the sensor. */
export interface SmallPlane {
  width: number;
  height: number;
  factor: number;
  data: Float32Array;
}

/** A Gray-code stripe a pixel must be at least this sure of (share of half the white–black contrast). */
const MIN_CONFIDENCE = 0.25;
/** Bits are decoded down to the lowest one at least this share of the lit pixels reads surely. */
const MIN_SURE_SHARE = 0.6;
/** A cell needs this many pixels to count. */
const MIN_CELL_PIXELS = 2;

/** `frame` shrunk by block averaging (edge blocks are cut off). */
export function downsample(frame: GrayFrame, factor: number): SmallPlane {
  const f = Math.max(1, Math.floor(factor));
  const width = Math.floor(frame.width / f);
  const height = Math.floor(frame.height / f);
  const data = new Float32Array(width * height);
  const src = frame.pixels;
  for (let y = 0; y < height * f; y++) {
    const row = y * frame.width;
    const out = Math.floor(y / f) * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = row + x * f, end = i + f; i < end; i++) sum += src[i];
      data[out + x] += sum;
    }
  }
  const n = f * f;
  for (let i = 0; i < data.length; i++) data[i] /= n;
  return { width, height, factor: f, data };
}

/** Mean absolute difference of two planes of one size. */
export function meanDifference(a: SmallPlane, b: SmallPlane): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return a.data.length ? sum / a.data.length : 0;
}

export function meanLevel(a: SmallPlane): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += a.data[i];
  return a.data.length ? sum / a.data.length : 0;
}

/** Bits of the Gray code that number every pixel of an `extent` px view axis. */
export function grayBits(extent: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, extent))));
}

/** What the camera saw: the blank and white views, and each stripe bit per axis (index = bit). */
export interface CodeFrames {
  black: SmallPlane;
  white: SmallPlane;
  x: SmallPlane[];
  y: SmallPlane[];
}

export interface Decoded {
  /** Cell centres in view px ↔ the mean sensor position of the pixels that saw them. */
  pairs: PointPair[];
  /** Pixels lit enough by the white view to decode. */
  litPixels: number;
  /** The lowest bit decoded per axis (one above the finest the camera reads): cells are `2^bit` view px wide. */
  bitX: number;
  bitY: number;
}

/**
 * Decodes the stripes: a pixel's bit is set where the stripe frame is brighter than halfway
 * between its blank and white value. Pixels not lit by the white view by `minContrast` are left
 * out. Each axis is decoded down to the lowest bit most pixels read surely; finer stripes the
 * camera blurs are ignored.
 */
export function decodeGray(frames: CodeFrames, minContrast: number): Decoded {
  const { black, white } = frames;
  const factor = black.factor;
  const n = black.data.length;
  const lit = new Uint8Array(n);
  let litPixels = 0;
  for (let i = 0; i < n; i++) {
    if (white.data[i] - black.data[i] >= minContrast) {
      lit[i] = 1;
      litPixels++;
    }
  }
  // Per axis: each pixel's code from the top bit down, and how many bits it read surely.
  const axis = (planes: SmallPlane[]) => {
    const bits = planes.length;
    const code = new Uint32Array(n);
    const sure = new Uint8Array(n);
    const sureAt = new Uint32Array(bits);
    for (let i = 0; i < n; i++) {
      if (!lit[i]) continue;
      const mid = (white.data[i] + black.data[i]) / 2;
      const half = (white.data[i] - black.data[i]) / 2;
      let c = 0;
      let k = 0;
      for (let b = bits - 1; b >= 0; b--) {
        const v = planes[b].data[i];
        if (Math.abs(v - mid) < MIN_CONFIDENCE * half) break;
        if (v > mid) c |= 1 << b;
        sureAt[b]++;
        k++;
      }
      code[i] = c;
      sure[i] = k;
    }
    // The lowest bit enough pixels read surely (from the top down, without gaps), and one above
    // it: at the finest readable stripes most pixels straddle an edge, and cells need pixels
    // inside them.
    let lowest = bits;
    for (let b = bits - 1; b >= 0 && sureAt[b] >= MIN_SURE_SHARE * litPixels; b--) lowest = b;
    return { code, sure, bits, lowest: Math.min(bits, lowest + 1) };
  };
  const ax = axis(frames.x);
  const ay = axis(frames.y);
  // Pixels sure down to the axis' lowest bit, grouped by the view cell they saw.
  const cells = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i < n; i++) {
    if (!lit[i] || ax.sure[i] < ax.bits - ax.lowest || ay.sure[i] < ay.bits - ay.lowest) continue;
    const cx = grayToBinary(ax.code[i] >>> ax.lowest);
    const cy = grayToBinary(ay.code[i] >>> ay.lowest);
    const key = cx * 65536 + cy;
    const cell = cells.get(key) ?? { x: 0, y: 0, n: 0 };
    cell.x += ((i % black.width) + 0.5) * factor;
    cell.y += (Math.floor(i / black.width) + 0.5) * factor;
    cell.n++;
    cells.set(key, cell);
  }
  const pairs: PointPair[] = [];
  const sizeX = 2 ** ax.lowest;
  const sizeY = 2 ** ay.lowest;
  for (const [key, cell] of cells) {
    if (cell.n < MIN_CELL_PIXELS) continue;
    const cx = Math.floor(key / 65536);
    const cy = key % 65536;
    pairs.push({ from: { x: (cx + 0.5) * sizeX, y: (cy + 0.5) * sizeY }, to: { x: cell.x / cell.n, y: cell.y / cell.n } });
  }
  return { pairs, litPixels, bitX: ax.lowest, bitY: ay.lowest };
}

/** The binary value of a Gray code. */
export function grayToBinary(g: number): number {
  let v = 0;
  for (; g; g >>>= 1) v ^= g;
  return v;
}

/**
 * The homography mapping the pairs, refitted twice without the pairs further than three times the
 * median error (at least 1 px) from it: cells at the edge of what the camera sees, or misread,
 * don't pull it. Null with fewer than four pairs left.
 */
export function solveTrimmed(pairs: PointPair[]): { h: Mat3; rms: number; used: PointPair[] } | null {
  let use = pairs;
  let h = solveHomography(use);
  for (let round = 0; h && round < 2; round++) {
    const errors = use.map(({ from, to }) => {
      const p = applyHomography(h!, from);
      return Math.hypot(p.x - to.x, p.y - to.y);
    });
    const sorted = [...errors].sort((a, b) => a - b);
    const limit = Math.max(1, 3 * sorted[Math.floor(sorted.length / 2)]);
    const next = use.filter((_, i) => errors[i] <= limit);
    if (next.length === use.length || next.length < 4) break;
    use = next;
    h = solveHomography(use);
  }
  return h ? { h, rms: reprojectionRms(h, use), used: use } : null;
}
