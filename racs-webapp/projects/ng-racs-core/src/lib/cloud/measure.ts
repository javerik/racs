/**
 * The measuring tool's numbers (#33 §4): a picked point in the scaling's units, the distance
 * between two, the step height between two faces and the cross-section along a segment. Any unit
 * works, pixels too; a metric scaling only changes the numbers.
 */

import type { Vec3 } from './mat4';
import type { CloudPick } from './pick';
import type { RowRing } from './ring';
import { type CloudScaling, toUnits } from './scaling';

/** The neighbourhood a step height takes its medians over: (2r + 1)² cells around the pick. */
export const STEP_RADIUS = 2;

/**
 * A pick in units (no view stretch), as `toUnits` places it: x along the columns (from the last one
 * when mirrored), y = −k × spacing (profiles toward −y), z = value × scale + offset. With the
 * *Laserline* source z is the height above the base.
 */
export function pointUnits(
  pick: Pick<CloudPick, 'column' | 'k' | 'value'>,
  scaling: CloudScaling,
  storeStride: number,
  width: number,
): Vec3 {
  return toUnits(pick.column, pick.k, pick.value, scaling, storeStride, width);
}

export interface Distance {
  /** The straight-line distance. */
  d: number;
  /** `b − a` per axis. */
  dx: number;
  dy: number;
  dz: number;
}

/** From `a` to `b`. */
export function distance(a: Vec3, b: Vec3): Distance {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return { d: Math.hypot(dx, dy, dz), dx, dy, dz };
}

/** The median of the valid values around a pick, in counts, and how many there were. */
export interface Neighbourhood {
  value: number;
  n: number;
}

/**
 * The median of the valid (non-zero) held values in the (2·radius + 1)² cells around `pick`'s
 * cell, or `null` when none is valid. The cell is the pick's column and its profile `seq` as the
 * ring holds it now, so a pick on a rolling ring reads its own profile however far it has moved.
 * Up to half the cells may lie on another face: the median stays on the pick's.
 */
export function neighbourhoodMedian(
  ring: RowRing,
  pick: Pick<CloudPick, 'column' | 'seq'>,
  radius = STEP_RADIUS,
): Neighbourhood | null {
  const c0 = Math.round(pick.column);
  const k0 = Math.round(pick.seq - ring.oldestSeq());
  const r = Math.max(0, Math.floor(radius));
  const values: number[] = [];
  for (let k = k0 - r; k <= k0 + r; k++) {
    if (k < 0 || k >= ring.filled) {
      continue;
    }
    for (let c = c0 - r; c <= c0 + r; c++) {
      if (c < 0 || c >= ring.width) {
        continue;
      }
      const v = heldValue(ring, c, k);
      if (v !== 0) {
        values.push(v);
      }
    }
  }
  if (!values.length) {
    return null;
  }
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return { value: values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2, n: values.length };
}

export interface StepHeight {
  /** A's and B's median in units (z above the base with the *Laserline* source). */
  za: number;
  zb: number;
  /** `zb − za`. */
  dz: number;
}

/** The height from face `a` to face `b`: the difference of their neighbourhoods' medians, in units. */
export function stepHeight(a: Neighbourhood, b: Neighbourhood, scaling: CloudScaling): StepHeight {
  const za = a.value * scaling.zScale + scaling.zOffset;
  const zb = b.value * scaling.zScale + scaling.zOffset;
  return { za, zb, dz: (b.value - a.value) * scaling.zScale };
}

/** The values along a segment: `z` at distance `s` from its start, NaN where there is none. */
export interface CrossSection {
  s: Float64Array;
  z: Float64Array;
}

/**
 * The values from `a` to `b` in one-cell steps over (column, held row): each sample is its nearest
 * cell's value in units, NaN where that cell is invalid or not held (a gap). `s` is the distance
 * from `a` across the cloud's footprint (x and y) in the scaling's unit, so it runs from 0 to the
 * segment's length whatever the mirror and the store stride.
 */
export function crossSection(
  ring: RowRing,
  a: Pick<CloudPick, 'column' | 'seq'>,
  b: Pick<CloudPick, 'column' | 'seq'>,
  scaling: CloudScaling,
  storeStride: number,
): CrossSection {
  const oldest = ring.oldestSeq();
  const ka = a.seq - oldest;
  const kb = b.seq - oldest;
  const dc = b.column - a.column;
  const dk = kb - ka;
  const steps = Math.max(0, Math.ceil(Math.max(Math.abs(dc), Math.abs(dk)) - 1e-9));
  // A mirror turns Δx around, which leaves the length as it is.
  const length = Math.hypot(dc * scaling.xPitch, dk * scaling.ySpacing * storeStride);
  const s = new Float64Array(steps + 1);
  const z = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    const c = Math.round(a.column + dc * t);
    const k = Math.round(ka + dk * t);
    const v = c >= 0 && c < ring.width && k >= 0 && k < ring.filled ? heldValue(ring, c, k) : 0;
    s[i] = t * length;
    z[i] = v === 0 ? NaN : v * scaling.zScale + scaling.zOffset;
  }
  return { s, z };
}

/** Column `c` of held row `k` (0 = oldest). */
function heldValue(ring: RowRing, c: number, k: number): number {
  return ring.mirror[((ring.oldestSlot() + k) % ring.capacity) * ring.width + c];
}
