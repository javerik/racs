/**
 * The check against the STL (#33 §5): a snapshot of one full pass of the scanned object, measured
 * in the cloud's scaling, against the extent laserline reports for the object (`object_mm`).
 *
 * - The object is the largest 4-connected component, in (column, held row), of the points above
 *   half its lowest top face (at least a tenth of its height): every top face of a walled object,
 *   a stepped one too, and clear of the base.
 * - Δu and Δv are its column and row spans, centre to centre like `object_mm`.
 * - z is its 99th percentile with the noise taken out, against the highest top face: the median
 *   of the *Step* tool's neighbourhood medians at the points from the 99th percentile up. The
 *   plain percentile of a flat top reads about 2.3 σ of the noise too high.
 *
 * Pure.
 */

import type { MetricMapping } from '../laserline/protocol';
import { neighbourhoodMedian } from './measure';
import type { RowRing } from './ring';
import { type CloudScaling, isPixelScaling } from './scaling';
import { MAX_FRAMES } from './settings';

/** The error per axis the check passes at, as a share of the STL's size. */
export const STL_CHECK_TOLERANCE = 0.02;
/** What the proposed snapshot adds to one pass and the object, as a share. */
export const STL_CHECK_MARGIN = 0.2;
/** The threshold is half the lowest top face, but at least half this share of the object's height. */
export const STL_CHECK_FLOOR_SHARE = 0.1;
/** The measured height: this percentile of the object's heights, denoised. */
export const STL_CHECK_PERCENTILE = 0.99;

/** The snapshot that holds one whole passage of the object. */
export interface SnapshotProposal {
  /** Frames to capture: `needed`, at most `MAX_FRAMES`. */
  frames: number;
  /** Frames one pass plus the object take, with the margin. */
  needed: number;
  /** How long that is. */
  seconds: number;
  /** The camera's frames per second. */
  frameRate: number;
  fits: boolean;
  /** What to change when it doesn't fit. */
  hint: string | null;
}

/**
 * The burst for one check (#33 §5): one pass of laserline's scan (`rows × dv_mm`) plus the
 * object's own length, so a whole passage of it fits whatever the phase the snapshot starts at,
 * at the travel speed, plus `STL_CHECK_MARGIN`. `profileRate` is the camera's profiles per
 * second, `height` its profiles per frame. Null without an object, a travel speed or a rate.
 */
export function proposeSnapshot(
  metric: MetricMapping | null | undefined,
  profileRate: number | null | undefined,
  height: number,
): SnapshotProposal | null {
  const object = metric?.object_mm;
  const speed = metric?.travel.mm_per_s ?? NaN;
  if (!metric || !object || !(speed > 0) || !(profileRate! > 0) || !(height >= 1)) {
    return null;
  }
  const length = metric.rows * metric.dv_mm + Math.max(0, object.max[1] - object.min[1]);
  const seconds = (length / speed) * (1 + STL_CHECK_MARGIN);
  const frameRate = profileRate! / height;
  const needed = Math.max(1, Math.ceil(seconds * frameRate));
  const fits = needed <= MAX_FRAMES;
  return {
    frames: Math.min(needed, MAX_FRAMES),
    needed,
    seconds,
    frameRate,
    fits,
    hint: fits
      ? null
      : `one pass needs ${needed} frames, more than ${MAX_FRAMES}: take more profiles per frame (Height) or speed up laserline’s travel`,
  };
}

/** One axis: the STL's size, the cloud's, and the error as a share of the STL's. */
export interface AxisCheck {
  stl: number;
  measured: number;
  error: number;
  ok: boolean;
}

/** The object found in the cloud, in (column, held row). */
export interface CheckedComponent {
  columns: [number, number];
  rows: [number, number];
  points: number;
  /** The mean column and held row of its points. */
  centroid: [number, number];
}

export interface StlCheck {
  refused: null;
  /** Every axis within `STL_CHECK_TOLERANCE`. */
  pass: boolean;
  /** Along the line, along the travel, and the height above the base; mm. */
  u: AxisCheck;
  v: AxisCheck;
  z: AxisCheck;
  /** The height the object's points lie above, mm. */
  threshold: number;
  component: CheckedComponent;
}

export interface StlRefusal {
  /** Why nothing was compared. */
  refused: string;
}

export type StlCheckResult = StlCheck | StlRefusal;

/**
 * The scanned object in `ring`, in `scaling` (mm, z above the base), against laserline's
 * `object_mm`. Refused when there is nothing to compare (no object, a scaling not in mm, nothing
 * above the threshold), with `bounce` playback (the return pass runs backwards), and when the
 * object touches the first or last held row (an incomplete pass) or column (it leaves the view).
 */
export function checkAgainstObject(
  ring: RowRing,
  scaling: CloudScaling,
  metric: MetricMapping,
  storeStride: number,
): StlCheckResult {
  const object = metric.object_mm;
  if (!object) {
    return { refused: 'laserline reports no object: nothing in its scan rises above the base' };
  }
  if (metric.travel.end === 'bounce' || metric.disturbances.includes('bounce')) {
    return { refused: 'bounce playback runs the return pass backwards: set laserline to loop or once' };
  }
  if (scaling.unit !== 'mm' || isPixelScaling(scaling)) {
    return { refused: 'the scaling is not in mm' };
  }
  const threshold = Math.max(object.min[2], STL_CHECK_FLOOR_SHARE * object.max[2]) / 2;
  const width = ring.width;
  const rows = ring.filled;
  const found = largestComponent(ring, (v) => v * scaling.zScale + scaling.zOffset > threshold);
  if (!found) {
    return { refused: `nothing in the cloud rises above ${threshold.toFixed(1)} mm: was the scan playing past the camera?` };
  }
  const { columns, rows: span } = found.component;
  if (span[0] === 0 || span[1] === rows - 1) {
    return { refused: 'the snapshot cut the object (it reaches the first or last profile): take it again' };
  }
  if (columns[0] === 0 || columns[1] === width - 1) {
    return { refused: 'the object leaves the camera’s columns: its width can’t be measured' };
  }
  const rising = scaling.zScale > 0;
  const top = percentileValue(found.histogram, found.component.points, STL_CHECK_PERCENTILE, rising);
  const u = axis(object.max[0] - object.min[0], (columns[1] - columns[0]) * scaling.xPitch);
  const v = axis(object.max[1] - object.min[1], (span[1] - span[0]) * scaling.ySpacing * storeStride);
  const h = axis(object.max[2], topHeight(ring, found.cells, top, rising) * scaling.zScale + scaling.zOffset);
  return { refused: null, pass: u.ok && v.ok && h.ok, u, v, z: h, threshold, component: found.component };
}

function axis(stl: number, measured: number): AxisCheck {
  const error = stl > 0 ? (measured - stl) / stl : NaN;
  return { stl, measured, error, ok: Math.abs(error) <= STL_CHECK_TOLERANCE };
}

/**
 * The largest 4-connected component of the held cells whose value is valid and passes `above`,
 * with a histogram of its values. Two fills over one mask: the first sizes every component, the
 * second takes the largest's values.
 */
function largestComponent(
  ring: RowRing,
  above: (value: number) => boolean,
): { component: CheckedComponent; histogram: Uint32Array; cells: Uint8Array } | null {
  const width = ring.width;
  const rows = ring.filled;
  const oldest = ring.oldestSlot();
  // 1: above the threshold; 2: sized; 3: the largest, read.
  const mask = new Uint8Array(width * rows);
  const valueAt = (i: number) => {
    const c = i % width;
    return ring.mirror[((oldest + (i - c) / width) % ring.capacity) * width + c];
  };
  for (let k = 0; k < rows; k++) {
    const from = ((oldest + k) % ring.capacity) * width;
    for (let c = 0; c < width; c++) {
      const v = ring.mirror[from + c];
      if (v !== 0 && above(v)) {
        mask[k * width + c] = 1;
      }
    }
  }
  const stack = new Stack();
  let best: CheckedComponent | null = null;
  let bestSeed = -1;
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 1) {
      continue;
    }
    let points = 0;
    let c0 = width;
    let c1 = -1;
    let k0 = rows;
    let k1 = -1;
    let sc = 0;
    let sk = 0;
    fill(mask, width, rows, seed, 1, 2, stack, (i) => {
      const c = i % width;
      const k = (i - c) / width;
      points++;
      sc += c;
      sk += k;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      k0 = Math.min(k0, k);
      k1 = Math.max(k1, k);
    });
    if (!best || points > best.points) {
      best = { columns: [c0, c1], rows: [k0, k1], points, centroid: [sc / points, sk / points] };
      bestSeed = seed;
    }
  }
  if (!best) {
    return null;
  }
  const histogram = new Uint32Array(65536);
  fill(mask, width, rows, bestSeed, 2, 3, stack, (i) => histogram[valueAt(i)]++);
  // The largest component's cells, marked 1.
  for (let i = 0; i < mask.length; i++) {
    mask[i] = mask[i] === 3 ? 1 : 0;
  }
  return { component: best, histogram, cells: mask };
}

/**
 * The median, in counts, of the neighbourhood medians (`neighbourhoodMedian`, the *Step* tool's)
 * at the component's cells whose value reaches `top` (at or above it when heights rise with the
 * value, at or below when they fall).
 */
function topHeight(ring: RowRing, cells: Uint8Array, top: number, rising: boolean): number {
  const width = ring.width;
  const oldest = ring.oldestSlot();
  const oldestSeq = ring.oldestSeq();
  const medians: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) {
      continue;
    }
    const c = i % width;
    const k = (i - c) / width;
    const v = ring.mirror[((oldest + k) % ring.capacity) * width + c];
    if (rising ? v >= top : v <= top) {
      const m = neighbourhoodMedian(ring, { column: c, seq: oldestSeq + k });
      if (m) {
        medians.push(m.value);
      }
    }
  }
  if (!medians.length) {
    return top;
  }
  medians.sort((a, b) => a - b);
  const m = medians.length >> 1;
  return medians.length % 2 ? medians[m] : (medians[m - 1] + medians[m]) / 2;
}

/** Marks the 4-connected cells marked `from` around `seed` as `to`, visiting each once. */
function fill(
  mask: Uint8Array,
  width: number,
  rows: number,
  seed: number,
  from: number,
  to: number,
  stack: Stack,
  visit: (i: number) => void,
): void {
  const last = (rows - 1) * width;
  mask[seed] = to;
  stack.push(seed);
  while (stack.size) {
    const i = stack.pop();
    visit(i);
    const c = i % width;
    if (c > 0 && mask[i - 1] === from) {
      mask[i - 1] = to;
      stack.push(i - 1);
    }
    if (c < width - 1 && mask[i + 1] === from) {
      mask[i + 1] = to;
      stack.push(i + 1);
    }
    if (i >= width && mask[i - width] === from) {
      mask[i - width] = to;
      stack.push(i - width);
    }
    if (i < last && mask[i + width] === from) {
      mask[i + width] = to;
      stack.push(i + width);
    }
  }
}

/**
 * The value at percentile `p` of the heights of `n` values counted in `histogram`: from the low
 * values up when heights grow with the value, from the high ones down when they fall.
 */
function percentileValue(histogram: Uint32Array, n: number, p: number, rising: boolean): number {
  const rank = Math.max(1, Math.ceil(p * n));
  let seen = 0;
  for (let j = 1; j < 65536; j++) {
    const v = rising ? j : 65536 - j;
    seen += histogram[v];
    if (seen >= rank) {
      return v;
    }
  }
  return rising ? 65535 : 1;
}

/** A stack of cell indices that grows as a fill needs it. */
class Stack {
  private buf = new Int32Array(4096);
  size = 0;

  push(i: number): void {
    if (this.size === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.size++] = i;
  }

  pop(): number {
    return this.buf[--this.size];
  }
}
