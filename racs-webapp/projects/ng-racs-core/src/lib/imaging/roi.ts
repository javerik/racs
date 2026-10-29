/**
 * Soft regions of interest: rectangles and lines drawn over a frame in the browser, and what is
 * measured inside them (statistics, a line profile, a row/column projection, a histogram).
 * Coordinates are frame pixels with (0, 0) at the top-left corner of the first pixel, so pixel
 * (i, j) covers `[i, i+1) × [j, j+1)` and its centre is (i + 0.5, j + 0.5).
 */

import { HISTOGRAM_BINS, type GrayFrame } from './frame';
import type { Size } from './view';

export type RoiShape = 'rect' | 'line';

export interface Roi {
  id: string;
  /** `R1`, `R2`, … */
  name: string;
  shape: RoiShape;
  /** Rect: two opposite corners on pixel edges. Line: the end points, on pixel centres. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Index into the series colours. */
  series: number;
  /** Line only: pixels averaged across the line for its profile. */
  thickness: number;
}

export interface RoiStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  std: number;
}

/** A plain x/y data series. */
export interface Series {
  xs: Float64Array;
  ys: Float64Array;
}

/** The pixel columns `x0..x1` and rows `y0..y1` (end exclusive) a rect covers inside the frame. */
export function rectBounds(roi: Roi, frame: Size): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(0, Math.floor(Math.min(roi.x0, roi.x1)));
  const y0 = Math.max(0, Math.floor(Math.min(roi.y0, roi.y1)));
  const x1 = Math.min(frame.width, Math.ceil(Math.max(roi.x0, roi.x1)));
  const y1 = Math.min(frame.height, Math.ceil(Math.max(roi.y0, roi.y1)));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

export function lineLength(roi: Roi): number {
  return Math.hypot(roi.x1 - roi.x0, roi.y1 - roi.y0);
}

/** `120×80` for a rect, `143 px` for a line. */
export function roiSizeLabel(roi: Roi): string {
  if (roi.shape === 'line') {
    return `${Math.round(lineLength(roi))} px`;
  }
  return `${Math.round(Math.abs(roi.x1 - roi.x0))}×${Math.round(Math.abs(roi.y1 - roi.y0))}`;
}

/** Keep a ROI inside a frame of `size`, e.g. after the camera's region shrank. */
export function clampRoi(roi: Roi, size: Size): Roi {
  const cx = (v: number) => Math.min(size.width, Math.max(0, v));
  const cy = (v: number) => Math.min(size.height, Math.max(0, v));
  return { ...roi, x0: cx(roi.x0), y0: cy(roi.y0), x1: cx(roi.x1), y1: cy(roi.y1) };
}

/** Bilinear sample at a frame position, or NaN outside the frame. */
function sample(frame: GrayFrame, x: number, y: number): number {
  const { width, height, pixels } = frame;
  // Pixel centres sit on half-integers.
  const u = x - 0.5;
  const v = y - 0.5;
  if (u < -0.5 || v < -0.5 || u > width - 0.5 || v > height - 0.5) {
    return NaN;
  }
  const i0 = Math.min(width - 1, Math.max(0, Math.floor(u)));
  const j0 = Math.min(height - 1, Math.max(0, Math.floor(v)));
  const i1 = Math.min(width - 1, i0 + 1);
  const j1 = Math.min(height - 1, j0 + 1);
  const fx = Math.min(1, Math.max(0, u - i0));
  const fy = Math.min(1, Math.max(0, v - j0));
  const a = pixels[j0 * width + i0];
  const b = pixels[j0 * width + i1];
  const c = pixels[j1 * width + i0];
  const d = pixels[j1 * width + i1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Values along a line, one sample per pixel of length (bilinear), each the mean across
 * `thickness` parallel lines. `xs` is the distance from the start in pixels; samples off the
 * frame are NaN.
 */
export function lineProfile(frame: GrayFrame, roi: Roi): Series {
  const dx = roi.x1 - roi.x0;
  const dy = roi.y1 - roi.y0;
  const length = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(length)) + 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  // Unit normal, for the parallel lines of a thick profile.
  const nx = length > 0 ? -dy / length : 0;
  const ny = length > 0 ? dx / length : 0;
  const t = Math.max(1, Math.round(roi.thickness || 1));
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;
    const px = roi.x0 + f * dx;
    const py = roi.y0 + f * dy;
    let sum = 0;
    let count = 0;
    for (let k = 0; k < t; k++) {
      const o = k - (t - 1) / 2;
      const v = sample(frame, px + o * nx, py + o * ny);
      if (!Number.isNaN(v)) {
        sum += v;
        count++;
      }
    }
    xs[i] = f * length;
    ys[i] = count ? sum / count : NaN;
  }
  return { xs, ys };
}

/** Mean of each column (`'x'`) or row (`'y'`) of a rect; `xs` are the frame column/row indices. */
export function rectProjection(frame: GrayFrame, roi: Roi, axis: 'x' | 'y'): Series {
  const b = rectBounds(roi, frame);
  if (!b) {
    return { xs: new Float64Array(0), ys: new Float64Array(0) };
  }
  const { width, pixels } = frame;
  const cols = b.x1 - b.x0;
  const rows = b.y1 - b.y0;
  const n = axis === 'x' ? cols : rows;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * width;
    if (axis === 'x') {
      for (let x = b.x0; x < b.x1; x++) {
        ys[x - b.x0] += pixels[row + x];
      }
    } else {
      let s = 0;
      for (let x = b.x0; x < b.x1; x++) {
        s += pixels[row + x];
      }
      ys[y - b.y0] = s;
    }
  }
  const per = axis === 'x' ? rows : cols;
  for (let i = 0; i < n; i++) {
    xs[i] = (axis === 'x' ? b.x0 : b.y0) + i;
    ys[i] /= per;
  }
  return { xs, ys };
}

/** Count, extremes, mean and (population) standard deviation of a ROI's pixels or samples. */
export function roiStats(frame: GrayFrame, roi: Roi): RoiStats | null {
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  if (roi.shape === 'line') {
    for (const v of lineProfile(frame, roi).ys) {
      if (Number.isNaN(v)) {
        continue;
      }
      n++;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
    }
  } else {
    const b = rectBounds(roi, frame);
    if (!b) {
      return null;
    }
    const { width, pixels } = frame;
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * width;
      // Per-row sums stay exact; only the total is rounded.
      let rs = 0;
      let rq = 0;
      for (let x = b.x0; x < b.x1; x++) {
        const v = pixels[row + x];
        if (v < min) min = v;
        if (v > max) max = v;
        rs += v;
        rq += v * v;
      }
      sum += rs;
      sumSq += rq;
    }
    n = (b.x1 - b.x0) * (b.y1 - b.y0);
  }
  if (n === 0) {
    return null;
  }
  const mean = sum / n;
  return { n, min, max, mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/**
 * Histogram of a ROI's values in {@link HISTOGRAM_BINS} bins spanning `0..2^bitDepth`; `xs` are
 * the bins' centre values.
 */
export function roiHistogram(frame: GrayFrame, roi: Roi): Series {
  const shift = Math.max(0, frame.bitDepth - Math.log2(HISTOGRAM_BINS));
  const last = HISTOGRAM_BINS - 1;
  const ys = new Float64Array(HISTOGRAM_BINS);
  const add = (v: number) => {
    const bin = Math.round(v) >> shift;
    ys[bin > last ? last : bin]++;
  };
  if (roi.shape === 'line') {
    for (const v of lineProfile(frame, roi).ys) {
      if (!Number.isNaN(v)) {
        add(v);
      }
    }
  } else {
    const b = rectBounds(roi, frame);
    if (b) {
      const { width, pixels } = frame;
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
          add(pixels[y * width + x]);
        }
      }
    }
  }
  const xs = new Float64Array(HISTOGRAM_BINS);
  const binWidth = 2 ** shift;
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    xs[i] = (i + 0.5) * binWidth - 0.5;
  }
  return { xs, ys };
}

/** A geometry fingerprint: what a cached measurement of a ROI depends on. */
export function roiKey(roi: Roi): string {
  return `${roi.shape}:${roi.x0}:${roi.y0}:${roi.x1}:${roi.y1}:${roi.thickness}`;
}

/** The last `capacity` values of a time series, oldest first. */
export class TimeSeries<T> {
  private readonly ts: number[] = [];
  private readonly values: T[] = [];

  constructor(readonly capacity = 600) {}

  get length(): number {
    return this.ts.length;
  }

  push(t: number, value: T): void {
    this.ts.push(t);
    this.values.push(value);
    if (this.ts.length > this.capacity) {
      this.ts.shift();
      this.values.shift();
    }
  }

  clear(): void {
    this.ts.length = 0;
    this.values.length = 0;
  }

  /** The series as arrays, with `pick` choosing the value plotted. */
  toSeries(pick: (v: T) => number): Series {
    return { xs: Float64Array.from(this.ts), ys: Float64Array.from(this.values, pick) };
  }
}
