/**
 * Test helper: a camera in `Linescan3D` filming the laserline view, so the range calibration and
 * the metric scaling can be checked without hardware. Each profile holds, per column, the value at
 * which that column finds the line (0 where it finds none). Only imported by specs.
 */

import {
  applyHomography,
  invertHomography,
  lineThrough,
  type Mat3,
  type MetricMapping,
  multiplyMat3,
  type Pattern,
  patternSegment,
  type Point,
  type ViewPoint,
} from 'ng-racs-core';
import { cameraHomography, seededRandom } from './synthetic-camera.testing';

export interface SyntheticRangeCamera {
  /** (column, sensor row) → laserline view px. */
  g: Mat3;
  width: number;
  /** The region's height: the band. A line found outside rows [0, rows − 1] reads 0. */
  rows: number;
  viewPx: ViewPoint;
  /**
   * Values per sensor row, default 16, and the value of row 0, default 100. Values are integers, so
   * the scale sets the quantisation: 16 reads 1/16 row, 1 whole rows.
   */
  scale?: number;
  offset?: number;
  /** Noise sigma of the peak, in sensor rows; default 0. */
  noise?: number;
  /** Profiles per frame, default 1. */
  profiles?: number;
}

/**
 * A camera `g` that sees the `field` of the view (view px, axis-aligned) on `width` columns and
 * `rows` rows, turned by `angleDeg`, optionally mirrored, with a little perspective.
 */
export function rangeCameraG(
  field: { x: number; y: number; width: number; height: number },
  size: { width: number; rows: number },
  { angleDeg = 0, mirror = false, perspective = 0 } = {},
): Mat3 {
  return invertHomography(cameraHomography(field, { width: size.width, height: size.rows }, angleDeg, mirror, perspective))!;
}

/** The map (column, value) → view px the range calibration should find for `cam`. */
export function rangeCameraMap(cam: SyntheticRangeCamera): Mat3 {
  const { scale = 16, offset = 100 } = cam;
  const g = multiplyMat3(cam.g, [1, 0, 0, 0, 1 / scale, -offset / scale, 0, 0, 1]);
  return g.map((v) => v / g[8]) as unknown as Mat3;
}

/** One profile while laserline shows `pattern` (a line, or blank). */
export function renderRangeLine(cam: SyntheticRangeCamera, pattern: Pattern, seed = 1): Uint16Array {
  return profileOf(cam, pattern, seededRandom(seed));
}

/**
 * A frame of `cam.profiles` profiles showing `pattern`; with `next`, the profiles from index
 * `next.after` on show `next.pattern` (a frame straddling a pattern switch).
 */
export function renderRangeFrame(
  cam: SyntheticRangeCamera,
  pattern: Pattern,
  seed = 1,
  next?: { pattern: Pattern; after: number },
): Uint16Array {
  const profiles = cam.profiles ?? 1;
  const random = seededRandom(seed);
  const out = new Uint16Array(profiles * cam.width);
  for (let k = 0; k < profiles; k++) {
    out.set(profileOf(cam, next && k >= next.after ? next.pattern : pattern, random), k * cam.width);
  }
  return out;
}

/**
 * Profile `k` of a scan of an object `height(u, v)` (mm above the base) through laserline's metric
 * `metric`, the camera advancing `mmPerProfile` of travel per profile (v = k × it). The line runs
 * across the whole view (its drawn length is ignored).
 */
export function renderRangeScan(
  cam: SyntheticRangeCamera,
  metric: MetricMapping,
  height: (u: number, v: number) => number,
  k: number,
  mmPerProfile = metric.dv_mm,
  seed = k + 1,
): Uint16Array {
  const random = seededRandom(seed);
  const v = k * mmPerProfile;
  const [cx, cy] = metric.base.center_px;
  const [dx, dy] = metric.base.dir;
  const [nx, ny] = metric.base.normal;
  const out = new Uint16Array(cam.width);
  for (let c = 0; c < cam.width; c++) {
    // Across distance of the column's view point from the deformed line, as the row runs.
    const f = (row: number) => {
      const p = applyHomography(cam.g, { x: c, y: row });
      const s = (p.x - cx) * dx + (p.y - cy) * dy;
      const t = (p.x - cx) * nx + (p.y - cy) * ny;
      return t - height(metric.u0_mm + s / metric.along_px_per_mm, v) * metric.height_px_per_mm;
    };
    let lo = 0;
    let flo = f(lo);
    let found: number | null = flo === 0 ? 0 : null;
    for (let hi = 0.5; found === null && hi <= cam.rows - 1; hi += 0.5) {
      const fhi = f(hi);
      if (Math.sign(fhi) !== Math.sign(flo)) {
        let a = lo;
        let b = hi;
        for (let i = 0; i < 40; i++) {
          const m = (a + b) / 2;
          if (Math.sign(f(m)) === Math.sign(flo)) a = m;
          else b = m;
        }
        found = (a + b) / 2;
      }
      lo = hi;
      flo = fhi;
    }
    const p = found === null ? null : applyHomography(cam.g, { x: c, y: found });
    out[c] = found !== null && p && inView(cam, p) ? valueOf(cam, found, random) : 0;
  }
  return out;
}

function profileOf(cam: SyntheticRangeCamera, pattern: Pattern, random: () => number): Uint16Array {
  const out = new Uint16Array(cam.width);
  if (pattern.kind === 'blank') {
    return out;
  }
  const segment = patternSegment(pattern, cam.viewPx);
  if (!segment) {
    throw new Error(`a range camera can't film a ${pattern.kind} pattern`);
  }
  const l = lineThrough(segment.a, segment.b);
  // lᵀ·g: the column c sees the line at the row where m · (c, row, 1) = 0.
  const m = [0, 1, 2].map((j) => l[0] * cam.g[j] + l[1] * cam.g[3 + j] + l[2] * cam.g[6 + j]);
  const ab = { x: segment.b.x - segment.a.x, y: segment.b.y - segment.a.y };
  const len2 = ab.x * ab.x + ab.y * ab.y;
  for (let c = 0; c < cam.width; c++) {
    if (Math.abs(m[1]) < 1e-12) continue;
    const row = -(m[0] * c + m[2]) / m[1];
    if (!(row >= 0 && row <= cam.rows - 1)) continue;
    const p = applyHomography(cam.g, { x: c, y: row });
    const t = ((p.x - segment.a.x) * ab.x + (p.y - segment.a.y) * ab.y) / len2;
    if (t < 0 || t > 1 || !inView(cam, p)) continue;
    out[c] = valueOf(cam, row, random);
  }
  return out;
}

function inView(cam: SyntheticRangeCamera, p: Point): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= cam.viewPx[0] && p.y <= cam.viewPx[1];
}

function valueOf(cam: SyntheticRangeCamera, row: number, random: () => number): number {
  const { scale = 16, offset = 100, noise = 0 } = cam;
  // Box–Muller.
  const n = noise ? Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random()) * noise : 0;
  const v = offset + (row + n) * scale;
  return Math.max(1, Math.min(65535, Math.round(v)));
}
