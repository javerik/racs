/**
 * Picking a point of the cloud on the CPU (#33 §4): a ray from the pointer, marched over the
 * ring's CPU mirror in the transform the view drew. Exact at full resolution, whatever density is
 * drawn, and the same for points and surface.
 *
 * The view places held value `v` of column `c`, held row `k` at `(c, k, v) · scale + offset` (see
 * `pointTransform`): per axis, so a straight ray stays straight in (column, row, value) space. The
 * march runs there, which takes the mirror (`scale.x < 0`), the store stride, the rolling offset
 * and the z stretch into account without a case for each.
 */

import { invertInto, type Mat4, type Vec3 } from './mat4';
import type { RowRing } from './ring';

/** A ray in the view's world: `origin + t · dir`, `dir` of unit length, t ≥ 0 in front. */
export interface PickRay {
  origin: Vec3;
  dir: Vec3;
}

/** The transform the view drew the cloud with (`CloudDisplay`'s). */
export interface PickTransform {
  scale: Vec3;
  offset: Vec3;
}

/** A picked point of the cloud. */
export interface CloudPick {
  /** Column, with the position inside the cell (fractional). */
  column: number;
  /** Held row counted from the oldest at the time of the pick (fractional). */
  k: number;
  /** The global row (`oldestSeq + k`): the pick's profile, which keeps it while the ring rolls. */
  seq: number;
  /** The value there, bilinear between the cell's corners. */
  value: number;
}

export interface PickOptions {
  /**
   * The largest spread of a cell's values (counts) that is still surface: the drawn surface breaks
   * at larger steps (`jump` × the window), so a pick doesn't land on a wall that isn't drawn.
   */
  maxStep?: number;
  /**
   * Points mode: a valid value whose drawn point covers the pointer counts too. `ndc` is the
   * pointer, `radius` the point's half size in NDC per axis, `mvp` the view's.
   */
  points?: { mvp: Mat4; ndc: [number, number]; radius: [number, number] };
}

/** The ray through `ndc` (−1..1, y up) of a view drawn with `mvp`, from its near plane. */
export function pickRay(mvp: Mat4, ndc: [number, number]): PickRay | null {
  const inv = invertInto(mvp, new Float64Array(16));
  if (!inv) {
    return null;
  }
  const near = unproject(inv, ndc[0], ndc[1], -1);
  const far = unproject(inv, ndc[0], ndc[1], 1);
  if (!near || !far) {
    return null;
  }
  const d: Vec3 = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (!(l > 0)) {
    return null;
  }
  return { origin: near, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** Where held value `v` of column `c`, held row `k` is drawn. */
export function gridToWorld(t: PickTransform, c: number, k: number, v: number): Vec3 {
  return [c * t.scale[0] + t.offset[0], k * t.scale[1] + t.offset[1], v * t.scale[2] + t.offset[2]];
}

/**
 * Where `p` lands in a view of `size` CSS px (`[width, height]`, y down) drawn with `mvp`, and its
 * depth in NDC; `null` behind the eye.
 */
export function screenPoint(mvp: Mat4, p: Vec3, size: [number, number]): { x: number; y: number; depth: number } | null {
  const x = mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12];
  const y = mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13];
  const z = mvp[2] * p[0] + mvp[6] * p[1] + mvp[10] * p[2] + mvp[14];
  const w = mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15];
  if (!(w > 0)) {
    return null;
  }
  return { x: ((x / w + 1) / 2) * size[0], y: ((1 - y / w) / 2) * size[1], depth: z / w };
}

/**
 * The first point of the cloud along `ray`, or `null` when it misses.
 *
 * It marches the cells between neighbouring columns and held rows in the order the ray crosses
 * them. A cell whose four values are valid (and spread no more than `maxStep`) is a bilinear patch,
 * and the ray's first crossing of it wins. In points mode the valid values around the cell whose
 * point covers the pointer count too, the nearest first.
 */
export function pickHeightfield(ray: PickRay, ring: RowRing, display: PickTransform, opts: PickOptions = {}): CloudPick | null {
  const w = ring.width;
  const rows = ring.filled;
  const [sx, sy, sz] = display.scale;
  if (rows < 1 || sx === 0 || sy === 0 || sz === 0) {
    return null;
  }
  // The ray in grid space: (column, held row, value).
  const o: Vec3 = [
    (ray.origin[0] - display.offset[0]) / sx,
    (ray.origin[1] - display.offset[1]) / sy,
    (ray.origin[2] - display.offset[2]) / sz,
  ];
  const d: Vec3 = [ray.dir[0] / sx, ray.dir[1] / sy, ray.dir[2] / sz];

  // Clip to the grid's footprint, [0, w − 1] × [0, rows − 1].
  let t0 = 0;
  let t1 = Infinity;
  for (const [i, hi] of [
    [0, w - 1],
    [1, rows - 1],
  ] as const) {
    if (d[i] === 0) {
      if (o[i] < 0 || o[i] > hi) {
        return null;
      }
      continue;
    }
    let a = (0 - o[i]) / d[i];
    let b = (hi - o[i]) / d[i];
    if (a > b) {
      [a, b] = [b, a];
    }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  if (!(t0 <= t1)) {
    return null;
  }

  const oldestSlot = ring.oldestSlot();
  const capacity = ring.capacity;
  const mirror = ring.mirror;
  const valueAt = (c: number, k: number) => mirror[((oldestSlot + k) % capacity) * w + c];
  const maxStep = opts.maxStep ?? Infinity;
  const cellsX = Math.max(1, w - 1);
  const cellsY = Math.max(1, rows - 1);
  const at = (t: number, i: 0 | 1) => o[i] + d[i] * t;
  // The cell the march starts in, nudged inside along the ray.
  const startT = t0 + Math.min(1e-9, (t1 - t0) / 2);
  let cx = clamp(Math.floor(at(startT, 0)), 0, cellsX - 1);
  let ck = clamp(Math.floor(at(startT, 1)), 0, cellsY - 1);
  const stepX = d[0] > 0 ? 1 : -1;
  const stepY = d[1] > 0 ? 1 : -1;
  const nextBorder = (cell: number, i: 0 | 1, step: number) => {
    if (d[i] === 0) {
      return Infinity;
    }
    const border = step > 0 ? cell + 1 : cell;
    return (border - o[i]) / d[i];
  };
  let tx = nextBorder(cx, 0, stepX);
  let ty = nextBorder(ck, 1, stepY);
  let tIn = t0;

  for (let guard = cellsX + cellsY + 4; guard > 0; guard--) {
    const tOut = Math.min(tx, ty, t1);
    const hit = cellHit(cx, ck, tIn, tOut);
    if (hit) {
      return hit;
    }
    if (tOut >= t1) {
      break;
    }
    if (tx <= ty) {
      cx += stepX;
      tx = nextBorder(cx, 0, stepX);
    } else {
      ck += stepY;
      ty = nextBorder(ck, 1, stepY);
    }
    if (cx < 0 || cx >= cellsX || ck < 0 || ck >= cellsY) {
      break;
    }
    tIn = tOut;
  }
  return null;

  function pickAt(c: number, k: number, value: number): CloudPick {
    return { column: c, k, seq: ring.oldestSeq() + k, value };
  }

  /** The nearer of the cell's surface crossing and (points mode) a covering point around it. */
  function cellHit(c: number, k: number, tA: number, tB: number): CloudPick | null {
    let best: { pick: CloudPick; depth: number } | null = null;
    const surface = surfaceHit(c, k, tA, tB);
    if (surface) {
      best = { pick: surface.pick, depth: surface.t };
    }
    const pts = opts.points;
    if (pts) {
      // Depths compare along the ray: a point's is where the ray passes closest to it.
      for (let kk = k - 1; kk <= k + 2; kk++) {
        for (let cc = c - 1; cc <= c + 2; cc++) {
          if (cc < 0 || cc >= w || kk < 0 || kk >= rows) {
            continue;
          }
          const v = valueAt(cc, kk);
          if (v === 0) {
            continue;
          }
          const p = gridToWorld(display, cc, kk, v);
          const s = screenPoint(pts.mvp, p, [2, 2]);
          if (!s) {
            continue;
          }
          const nx = s.x - 1;
          const ny = 1 - s.y;
          const ex = (nx - pts.ndc[0]) / pts.radius[0];
          const ey = (ny - pts.ndc[1]) / pts.radius[1];
          if (ex * ex + ey * ey > 1) {
            continue;
          }
          const along =
            (p[0] - ray.origin[0]) * ray.dir[0] + (p[1] - ray.origin[1]) * ray.dir[1] + (p[2] - ray.origin[2]) * ray.dir[2];
          if (along >= 0 && (!best || along < best.depth)) {
            best = { pick: pickAt(cc, kk, v), depth: along };
          }
        }
      }
    }
    return best?.pick ?? null;
  }

  /** The ray's first crossing of the cell's bilinear patch within `tA..tB`, with its t. */
  function surfaceHit(c: number, k: number, tA: number, tB: number): { pick: CloudPick; t: number } | null {
    if (c + 1 >= w || k + 1 >= rows) {
      return null;
    }
    const v00 = valueAt(c, k);
    const v10 = valueAt(c + 1, k);
    const v01 = valueAt(c, k + 1);
    const v11 = valueAt(c + 1, k + 1);
    if (v00 === 0 || v10 === 0 || v01 === 0 || v11 === 0) {
      return null;
    }
    if (Math.max(v00, v10, v01, v11) - Math.min(v00, v10, v01, v11) > maxStep) {
      return null;
    }
    // h(u, s) = a + b·u + e·s + f·u·s over the cell (u, s in 0..1); along the ray from tA,
    // u = u0 + du·τ, s = s0 + ds·τ, z = z0 + dz·τ. Solve z − h = Aτ² + Bτ + C = 0.
    const a = v00;
    const b = v10 - v00;
    const e = v01 - v00;
    const f = v11 - v10 - v01 + v00;
    const u0 = at(tA, 0) - c;
    const s0 = at(tA, 1) - k;
    const z0 = o[2] + d[2] * tA;
    const [du, ds, dz] = d;
    const A = -f * du * ds;
    const B = dz - b * du - e * ds - f * (u0 * ds + s0 * du);
    const C = z0 - (a + b * u0 + e * s0 + f * u0 * s0);
    const span = tB - tA;
    const tau = firstRoot(A, B, C, span);
    if (tau === null) {
      return null;
    }
    const u = clamp(u0 + du * tau, 0, 1);
    const s = clamp(s0 + ds * tau, 0, 1);
    const value = a + b * u + e * s + f * u * s;
    return { pick: pickAt(c + u, k + s, value), t: tA + tau };
  }
}

/** The smallest root of `Aτ² + Bτ + C` in `0..span`, or `null`. */
function firstRoot(A: number, B: number, C: number, span: number): number | null {
  const scale = Math.max(Math.abs(A) * span * span, Math.abs(B) * span, Math.abs(C), 1e-300);
  const inRange = (t: number) => t >= -1e-9 * Math.max(1, span) && t <= span * (1 + 1e-9) + 1e-12;
  if (Math.abs(A) * span * span <= 1e-12 * scale) {
    if (Math.abs(B) * span <= 1e-12 * scale) {
      return Math.abs(C) <= 1e-12 * scale ? 0 : null;
    }
    const t = -C / B;
    return inRange(t) ? Math.max(0, t) : null;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    return null;
  }
  // The numerically stable pair.
  const q = -0.5 * (B + Math.sign(B || 1) * Math.sqrt(disc));
  const roots = [q / A, q !== 0 ? C / q : -B / A].filter(inRange).sort((x, y) => x - y);
  return roots.length ? Math.max(0, roots[0]) : null;
}

function unproject(inv: Float64Array, x: number, y: number, z: number): Vec3 | null {
  const px = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
  const py = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
  const pz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  const pw = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  if (!(Math.abs(pw) > 0)) {
    return null;
  }
  return [px / pw, py / pw, pz / pw];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
