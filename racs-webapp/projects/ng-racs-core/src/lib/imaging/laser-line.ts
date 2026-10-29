/**
 * Finding a bright line (a laser line, or the laserline tool's emulation of one) in a frame: a
 * sub-pixel peak per column or row. Plain functions over typed arrays, unit-tested without a DOM.
 */

import { maxValue, type GrayFrame } from './frame';

/** A frame as floats, so frames can be averaged and subtracted without clipping. */
export interface Plane {
  width: number;
  height: number;
  data: Float32Array;
  /** Value range of the source (`2^bitDepth - 1`). */
  max: number;
}

/**
 * Which way the line is scanned: `'x'` takes one peak per column (a line running roughly along
 * x), `'y'` one per row.
 */
export type ScanAxis = 'x' | 'y';

/**
 * One column's (or row's) peak: `u` is the column's (row's) centre, `v` the sub-pixel row (column),
 * both in continuous coordinates (pixel `i` spans `i..i+1`).
 */
export interface LinePoint {
  u: number;
  v: number;
  /** Peak height above the background. */
  peak: number;
}

/** A second peak this high (share of the first) makes a column ambiguous. */
const AMBIGUOUS_PEAK = 0.8;

export interface PeakOptions {
  /** Peaks must stand this many noise sigmas above the background. Default 6. */
  sigmas?: number;
  /** ... and reach this fraction of the frame's highest peak. Default 0.25. */
  relative?: number;
  /** ... and this fraction of the value range. Default 0.03. */
  absolute?: number;
}

export function toPlane(frame: GrayFrame): Plane {
  return { width: frame.width, height: frame.height, data: Float32Array.from(frame.pixels), max: maxValue(frame.bitDepth) };
}

/**
 * Robust noise sigma of a plane: the median absolute deviation around the median of a sample of
 * pixels, so a thin bright line hardly moves it.
 */
export function noiseSigma(plane: Plane): number {
  const step = Math.max(1, Math.floor(plane.data.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < plane.data.length; i += step) {
    sample.push(plane.data[i]);
  }
  const median = (xs: number[]) => {
    const s = Float64Array.from(xs).sort();
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const m = median(sample);
  return 1.4826 * median(sample.map((x) => Math.abs(x - m)));
}

/**
 * The line's sub-pixel position in every column (`axis` `'x'`) or row (`'y'`) where a single clear
 * peak stands out: the centroid of the samples above half the peak, around the maximum. Columns
 * with a second peak nearly as high elsewhere are left out as ambiguous; a clearly weaker one
 * (a ghost) is ignored.
 */
export function linePeaks(plane: Plane, axis: ScanAxis, options: PeakOptions = {}): LinePoint[] {
  const { width, height, data } = plane;
  const [count, length] = axis === 'x' ? [width, height] : [height, width];
  // The plane as `length` rows of `count` (v-major, so the passes below read it in order: walking
  // down a column of the frame is ten times slower), each sample the median of its column and the
  // two neighbouring ones. A filmed line spans neighbouring columns, a hot pixel doesn't (the AT C6
  // has a column with one in every 6th row, a straight line to anything that looks at single
  // pixels). Where the line's profile is monotonic, the median is the column's own value, so the
  // centroid stays. The first and last column stay as they are: one hot pixel there is a single
  // point.
  const m = new Float32Array(count * length);
  const median3 = (a: number, b: number, c: number) => (a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b);
  if (axis === 'x') {
    for (let v = 0; v < length; v++) {
      const row = v * width;
      m[row] = data[row];
      m[row + width - 1] = data[row + width - 1];
      for (let u = 1; u < width - 1; u++) {
        m[row + u] = median3(data[row + u - 1], data[row + u], data[row + u + 1]);
      }
    }
  } else {
    for (let u = 0; u < height; u++) {
      const row = u * width;
      const edge = u === 0 || u === height - 1;
      for (let v = 0; v < width; v++) {
        m[v * count + u] = edge ? data[row + v] : median3(data[row - width + v], data[row + v], data[row + width + v]);
      }
    }
  }
  const at = (u: number, v: number) => m[v * count + u];

  // The background of a column is the median of a sample of it (a line covers a few pixels of
  // it at most); the noise is shared by all columns.
  const best = new Float32Array(count).fill(-Infinity);
  const where = new Int32Array(count);
  for (let v = 0; v < length; v++) {
    const row = v * count;
    for (let u = 0; u < count; u++) {
      if (m[row + u] > best[u]) {
        best[u] = m[row + u];
        where[u] = v;
      }
    }
  }
  let globalPeak = 0;
  const peaks = new Float32Array(count);
  const base = new Float32Array(count);
  const sampleStep = Math.max(1, Math.floor(length / 63));
  const sample = new Float32Array(Math.ceil(length / sampleStep));
  for (let u = 0; u < count; u++) {
    for (let k = 0, v = 0; v < length; k++, v += sampleStep) {
      sample[k] = at(u, v);
    }
    sample.sort();
    base[u] = sample[Math.floor(sample.length / 2)];
    peaks[u] = best[u] - base[u];
    globalPeak = Math.max(globalPeak, peaks[u]);
  }
  const threshold = Math.max(
    (options.sigmas ?? 6) * noiseSigma(plane),
    (options.relative ?? 0.25) * globalPeak,
    (options.absolute ?? 0.03) * plane.max,
  );

  // Each column's run above half its peak; columns without a clear peak, or cut by the frame's
  // edge (the centroid would lean inwards), get none.
  const lo = new Int32Array(count).fill(-1);
  const hi = new Int32Array(count).fill(-1);
  // A second peak beyond a gap nearly as high: two lines, or the line folding back. A weaker
  // one is a ghost (a display seen through glass doubles lines at about half the height) and
  // is left alone.
  const rival = new Float32Array(count).fill(Infinity);
  for (let u = 0; u < count; u++) {
    const peak = peaks[u];
    if (peak < threshold || peak <= 0) {
      continue;
    }
    const half = base[u] + peak / 2;
    let a = where[u];
    let b = where[u];
    while (a > 0 && at(u, a - 1) >= half) a--;
    while (b < length - 1 && at(u, b + 1) >= half) b++;
    if (a === 0 || b === length - 1) {
      continue;
    }
    lo[u] = a;
    hi[u] = b;
    rival[u] = base[u] + AMBIGUOUS_PEAK * peak;
  }
  const ambiguous = new Uint8Array(count);
  for (let v = 0; v < length; v++) {
    const row = v * count;
    for (let u = 0; u < count; u++) {
      if (m[row + u] >= rival[u] && (v < lo[u] - 2 || v > hi[u] + 2)) {
        ambiguous[u] = 1;
      }
    }
  }

  const out: LinePoint[] = [];
  for (let u = 0; u < count; u++) {
    if (lo[u] < 0 || ambiguous[u]) {
      continue;
    }
    let sum = 0;
    let weight = 0;
    for (let v = Math.max(0, lo[u] - 1); v <= Math.min(length - 1, hi[u] + 1); v++) {
      const w = Math.max(0, at(u, v) - base[u]);
      sum += w * v;
      weight += w;
    }
    if (weight > 0) {
      // Continuous coordinates: pixel i covers i..i+1, its centre is at i + 0.5.
      out.push({ u: u + 0.5, v: sum / weight + 0.5, peak: peaks[u] });
    }
  }
  return out;
}
