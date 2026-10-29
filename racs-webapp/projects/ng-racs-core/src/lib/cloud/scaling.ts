/**
 * From stored profiles to positions: a column, a profile and a value become x, y and z in the
 * user's units.
 *
 *   x =  column × xPitch      (mirrored: (width − 1 − column) × xPitch)
 *   y = −profile × ySpacing   (profiles run toward −Y, so the Top view reads like the image)
 *   z =  value × zScale + zOffset
 *
 * The view may stretch each axis further (`cloudDisplay`), z also automatically to make a flat
 * relief visible; exports never do.
 */

import { deviceStorageKey } from '../services/device-key';
import type { Vec3 } from './mat4';
import type { Bounds } from './orbit';

export interface CloudScaling {
  unit: string;
  /** Units per column. */
  xPitch: number;
  /** Units per profile. */
  ySpacing: number;
  /** Units per count of the value. */
  zScale: number;
  zOffset: number;
  /**
   * x runs from the last column to the first. Set where the cloud would otherwise be a mirror
   * image of the scanned object (#33 §3): the box stays where it is, the columns run the other way.
   */
  mirrorX?: boolean;
  /** Where the values came from: typed in, the camera's Scan3d features, or laserline's metric mapping. */
  source?: ScalingSource;
}

export type ScalingSource = 'manual' | 'camera' | 'laserline';

const SOURCES: readonly ScalingSource[] = ['manual', 'camera', 'laserline'];

/** Pixels, profiles and raw counts. */
export const PIXEL_SCALING: CloudScaling = { unit: 'px', xPitch: 1, ySpacing: 1, zScale: 1, zOffset: 0 };

const STORAGE_PREFIX = 'racs.cloud.scaling';

export function isPixelScaling(s: CloudScaling): boolean {
  return (
    s.unit === PIXEL_SCALING.unit &&
    s.xPitch === 1 &&
    s.ySpacing === 1 &&
    s.zScale === 1 &&
    s.zOffset === 0 &&
    !s.mirrorX
  );
}

/** A usable scaling from anything: pitches and spacing positive, scale non-zero, all finite. */
export function sanitizeScaling(raw: unknown, base: CloudScaling = PIXEL_SCALING): CloudScaling {
  const r = (raw ?? {}) as Partial<Record<keyof CloudScaling, unknown>>;
  const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  const nonZero = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : fallback);
  const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const unit = typeof r.unit === 'string' ? r.unit.trim().slice(0, 8) : '';
  const out: CloudScaling = {
    unit: unit || base.unit,
    xPitch: positive(r.xPitch, base.xPitch),
    ySpacing: positive(r.ySpacing, base.ySpacing),
    zScale: nonZero(r.zScale, base.zScale),
    zOffset: finite(r.zOffset, base.zOffset),
  };
  // Optional, and left out when unset, so stored scalings stay as they were.
  const mirrorX = typeof r.mirrorX === 'boolean' ? r.mirrorX : base.mirrorX;
  if (mirrorX !== undefined) {
    out.mirrorX = mirrorX;
  }
  const source = SOURCES.includes(r.source as ScalingSource) ? (r.source as ScalingSource) : base.source;
  if (source !== undefined) {
    out.source = source;
  }
  return out;
}

/**
 * Where a camera's scaling is kept: by MAC, since device ids only last as long as the server
 * process. A camera without a MAC falls back to its id; one not known yet has no key.
 */
export function scalingKey(device: { id: number; mac?: string | null } | null | undefined): string | null {
  return deviceStorageKey(STORAGE_PREFIX, device);
}

export function loadScaling(key: string): CloudScaling {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      return sanitizeScaling(JSON.parse(raw));
    }
  } catch {
    // Storage unavailable or corrupt: pixels.
  }
  return { ...PIXEL_SCALING };
}

export function saveScaling(key: string, s: CloudScaling): void {
  try {
    // A pixel scaling is the default, unless it names a source to keep (Laserline, before its calibration).
    if (isPixelScaling(s) && (s.source ?? 'manual') === 'manual') {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(s));
    }
  } catch {
    // Remembering is a convenience only.
  }
}

/** A camera's SFNC `Scan3dCoordinateScale`/`Offset` for one coordinate. */
export interface CameraCoordinate {
  scale: number | null;
  offset: number | null;
  unit: string | null;
}

/**
 * The scaling a camera reports: coordinate A along the profile (x), B across profiles (y),
 * C the value (z). What it doesn't report (or reports as 0) stays as in `base`.
 */
export function scalingFromCoordinates(
  c: Partial<Record<'A' | 'B' | 'C', CameraCoordinate>>,
  base: CloudScaling,
): CloudScaling {
  const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0;
  const next = { ...base };
  if (usable(c.A?.scale) && c.A.scale > 0) {
    next.xPitch = c.A.scale;
  }
  if (usable(c.B?.scale) && c.B.scale > 0) {
    next.ySpacing = c.B.scale;
  }
  if (usable(c.C?.scale)) {
    next.zScale = c.C.scale;
    next.zOffset = typeof c.C.offset === 'number' && Number.isFinite(c.C.offset) ? c.C.offset : 0;
  }
  const unit = c.C?.unit || c.A?.unit || c.B?.unit;
  if (unit && !isPixelScaling(next)) {
    next.unit = unit;
  }
  return sanitizeScaling(next, base);
}

/**
 * Held row `k` of a store keeping every `storeStride`-th profile, in units (no exaggeration).
 * `width` is the number of columns, which a mirrored x counts back from.
 */
export function toUnits(
  col: number,
  k: number,
  value: number,
  s: CloudScaling,
  storeStride: number,
  width: number,
): Vec3 {
  const c = s.mirrorX ? Math.max(0, width - 1) - col : col;
  // `0 - …`, not `-…`: the first profile is at y = 0, not −0.
  return [c * s.xPitch, 0 - k * s.ySpacing * storeStride, value * s.zScale + s.zOffset];
}

/**
 * The box the view shows: `width` columns, `rows` stored rows, values `zLo..zHi`, with z
 * stretched by `zExag`. A mirrored x spans the same box.
 */
export function cloudBounds(
  width: number,
  rows: number,
  storeStride: number,
  s: CloudScaling,
  zLo: number,
  zHi: number,
  zExag = 1,
): Bounds {
  const z1 = (zLo * s.zScale + s.zOffset) * zExag;
  const z2 = (zHi * s.zScale + s.zOffset) * zExag;
  const yEnd = -Math.max(0, rows - 1) * s.ySpacing * storeStride;
  return {
    min: [0, yEnd, Math.min(z1, z2)],
    max: [Math.max(0, width - 1) * s.xPitch, 0, Math.max(z1, z2)],
  };
}

/**
 * The z stretch that makes values `zLo..zHi` rise to `ratio` of the cloud's footprint: raw counts
 * against pixels would otherwise be a needle, or a calibrated relief invisibly flat.
 */
export function autoZExaggeration(
  width: number,
  rows: number,
  storeStride: number,
  s: CloudScaling,
  zLo: number,
  zHi: number,
  ratio = 0.35,
): number {
  const b = cloudBounds(width, rows, storeStride, s, zLo, zHi);
  const footprint = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  const height = b.max[2] - b.min[2];
  if (!(footprint > 0) || !(height > 0)) {
    return 1;
  }
  return (ratio * footprint) / height;
}

/**
 * What the vertex shader applies, `position = vec3(column, k, value) * scale + offset`: z
 * stretched by `zExag`, and rows shifted back by `rowShift` (a rolling buffer not yet full sits at
 * the far end of its box, where it will grow from). Mirrored, `scale[0]` is negative and the last
 * of `width` columns lands at x = 0.
 */
export function pointTransform(
  s: CloudScaling,
  storeStride: number,
  zExag: number,
  rowShift: number,
  width: number,
): { scale: Vec3; offset: Vec3 } {
  const yStep = s.ySpacing * storeStride;
  return {
    scale: [s.mirrorX ? -s.xPitch : s.xPitch, -yStep, s.zScale * zExag],
    offset: [s.mirrorX ? Math.max(0, width - 1) * s.xPitch : 0, -rowShift * yStep, s.zOffset * zExag],
  };
}

/** Where the view puts the cloud, and the transform the vertex shader applies to get it there. */
export interface CloudDisplay {
  /** The z stretch in use. */
  exag: number;
  box: Bounds;
  scale: Vec3;
  offset: Vec3;
}

/**
 * The cloud as the view shows it: x and y stretched by `stretch[0]`/`[1]`, z stretched (`'auto'`:
 * to a share of the stretched footprint, following the values) and then by `stretch[2]`, and
 * shifted so the lowest value sits at z = 0. With an automatic stretch the box so keeps its place
 * and shape however the values move, and a fitted view stays fitted.
 */
export function cloudDisplay(
  width: number,
  rows: number,
  storeStride: number,
  s: CloudScaling,
  zLo: number,
  zHi: number,
  zExag: number | 'auto',
  rowShift: number,
  stretch: Vec3 = [1, 1, 1],
): CloudDisplay {
  const shown: CloudScaling = { ...s, xPitch: s.xPitch * stretch[0], ySpacing: s.ySpacing * stretch[1] };
  const base = zExag === 'auto' ? autoZExaggeration(width, rows, storeStride, shown, zLo, zHi) : zExag;
  const exag = base * stretch[2];
  const units = cloudBounds(width, rows, storeStride, shown, zLo, zHi);
  const t = pointTransform(shown, storeStride, exag, rowShift, width);
  return {
    exag,
    box: {
      min: [units.min[0], units.min[1], 0],
      max: [units.max[0], units.max[1], (units.max[2] - units.min[2]) * exag],
    },
    scale: t.scale,
    offset: [t.offset[0], t.offset[1], t.offset[2] - units.min[2] * exag],
  };
}

/** A length in units, short: `51.2`, `0.05`, `2048`. */
export function formatUnits(v: number): string {
  if (!Number.isFinite(v)) {
    return '—';
  }
  const a = Math.abs(v);
  if (a === 0 || a >= 1000) {
    return v.toFixed(0);
  }
  return Number(v.toPrecision(a >= 1 ? 4 : 3)).toString();
}
