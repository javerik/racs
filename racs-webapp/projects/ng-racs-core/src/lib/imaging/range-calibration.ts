/**
 * Range calibration (#33 §2): how a camera in `Linescan3D` maps its (column, value) pairs onto
 * laserline's view. Laserline shows lines; every column that sees one gives a point (c, r) that lies
 * on it, and a point-on-line DLT fits the projective map G: (c, r) → view px. The camera stays a
 * black box: its value encoding doesn't matter. Pure; no dependencies.
 */

import type { BaseLine, Envelope, Pattern, ViewPoint } from '../laserline/protocol';
import { solve } from './fit';
import { applyHomography, multiplyMat3, type Mat3, type Point } from './homography';

/** A line `a·x + b·y + c = 0` in view px with `(a, b)` a unit normal, so `l·(x, y, 1)` is the signed distance. */
export type ViewLine = [number, number, number];

export type LinePattern = Extract<Pattern, { kind: 'line' }>;

/** A calibration line: the pattern laserline shows, and the line it draws. */
export interface PlannedLine {
  kind: 'parallel' | 'crossing';
  /** The across offset from the base line (parallel) or the along position on it (crossing), view px. */
  at: number;
  /** The sign of a crossing line's angle against the base line (y down); 0 for a parallel one. */
  sign: -1 | 0 | 1;
  pattern: LinePattern;
  line: ViewLine;
}

/** A column that saw a line: the value it read there. */
export interface RangeObservation {
  c: number;
  r: number;
  line: ViewLine;
}

export interface LineResidual {
  line: ViewLine;
  /** Observations of the line, and how many of them the trimmed refit dropped. */
  n: number;
  dropped: number;
  /** Over all its observations, view px. */
  rms: number;
  max: number;
}

export interface RangeMap {
  /** (c, r, 1) → view px, row-major. */
  g: Mat3;
  model: 'projective' | 'affine';
  /** Distance of G(c, r) from its line over the observations kept, view px; in `rms` every line weighs the same. */
  rms: number;
  max: number;
  used: number;
  /** In the order the lines first appear. */
  perLine: LineResidual[];
}

/** Per column of a set of profiles: the median of the non-zero values (NaN without any), their MAD and the valid share. */
export interface ReducedProfiles {
  width: number;
  profiles: number;
  median: Float64Array;
  /** Median absolute deviation from the median (not scaled to a sigma). */
  mad: Float64Array;
  valid: Float64Array;
}

/** What one calibration line covered: the columns that saw it. */
export interface LineCoverage {
  kind: 'parallel' | 'crossing';
  sign: number;
  columns: ArrayLike<number>;
}

export interface CoverageCheck {
  ok: boolean;
  /** Why it isn't enough; null when it is. */
  reason: string | null;
  /** Parallel lines seen in enough columns. */
  parallel: number;
  /** Crossing lines seen in enough columns, by the sign of their angle. */
  crossing: { neg: number; pos: number };
  /** The share of the columns the crossing lines span together. */
  span: number;
}

/** A column sees a line when at least this share of its profiles hold a value. */
export const RANGE_SEEN_SHARE = 0.5;
/** Two reductions agree when at most this share of the columns either sees is seen by one only. */
export const RANGE_DISAGREE_SHARE = 0.1;
/**
 * A column one reduction sees is missing from the other only when the other's valid share is
 * below this. A switch between patterns leaves ≈1 against ≈0; a flickering column (a thin line
 * near the camera's peak threshold) sees it in part of both, which isn't a different line.
 */
export const RANGE_UNSEEN_SHARE = 0.1;
/** Minimums of a calibration set (#33 §2). */
export const RANGE_MIN_PARALLEL = 3;
export const RANGE_PARALLEL_SHARE = 0.5;
export const RANGE_MIN_CROSSING_PER_SIGN = 2;
export const RANGE_CROSSING_MIN_COLUMNS = 3;
export const RANGE_CROSSING_SPAN = 0.5;
/** Limits on the fit's rms, view px: warn above, refuse above (tuned on hardware, #38). */
export const RANGE_WARN_RMS_PX = 1;
export const RANGE_MAX_RMS_PX = 4;
/** The trimmed refit drops observations over this × the median residual (at least the floor), at most this share. */
export const RANGE_TRIM_FACTOR = 3;
export const RANGE_TRIM_FLOOR_PX = 0.05;
export const RANGE_TRIM_SHARE = 0.2;
/**
 * The smallest ratio of the normal matrix's eigenvalues (scaled to a unit diagonal) that counts as
 * conditioned. A projective system below it falls back to an affine G; an affine one is refused.
 * It only catches degenerate sets: usable ones measure 6e-5 and more (a full set about 0.1), a
 * parallel-only set 0, a single crossing line 1e-11 without noise. Noise lifts a degenerate set to
 * 1e-9 … 1e-6, and the fit then has a small rms but no along direction, so `checkCoverage` has to
 * pass before a fit is trusted.
 */
export const RANGE_MIN_CONDITION = 1e-8;

/**
 * The segment laserline draws for a `line` pattern in a view of `viewPx` (`pattern_params`): the
 * centre at 50 % of the middle axis, turned by the tilt (y down), `W·|cos α| + H·|sin α|` long.
 * Null for any other pattern.
 */
export function patternSegment(pattern: Pattern, viewPx: ViewPoint): { a: Point; b: Point } | null {
  if (pattern.kind !== 'line') {
    return null;
  }
  const [w, h] = viewPx;
  const horizontal = pattern.orientation === 'Horizontal';
  const c = horizontal ? { x: w / 2, y: (pattern.position_pct / 100) * h } : { x: (pattern.position_pct / 100) * w, y: h / 2 };
  const angle = ((horizontal ? 0 : 90) + (pattern.tilt_deg ?? 0)) * (Math.PI / 180);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const half = (w * Math.abs(dx) + h * Math.abs(dy)) / 2;
  return { a: { x: c.x - dx * half, y: c.y - dy * half }, b: { x: c.x + dx * half, y: c.y + dy * half } };
}

/** The line through `a` and `b`. */
export function lineThrough(a: Point, b: Point): ViewLine {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  return [nx, ny, -(nx * a.x + ny * a.y)];
}

/**
 * The pattern that draws the line through `point` along `dir` exactly. Both orientations give the
 * same angle and so the same length; the one whose middle axis the line crosses nearer to `point`
 * is used, `position_pct` is where it crosses that axis (not clamped) and `tilt_deg` the rest of the
 * angle, in [−90°, 90°). Null when the drawn segment doesn't reach `point`.
 */
export function linePattern(line: { point: ViewPoint; dir: ViewPoint }, viewPx: ViewPoint): LinePattern | null {
  const [w, h] = viewPx;
  const [px, py] = line.point;
  const len = Math.hypot(line.dir[0], line.dir[1]);
  if (!(len > 0) || !(w > 0) || !(h > 0)) {
    return null;
  }
  const dx = line.dir[0] / len;
  const dy = line.dir[1] / len;
  const theta = (Math.atan2(dy, dx) * 180) / Math.PI;
  let best: { t: number; pattern: LinePattern } | null = null;
  // Along the line from `point` to the middle axis: x = W/2 for horizontal lines, y = H/2 for vertical ones.
  if (Math.abs(dx) > 1e-9) {
    const t = (w / 2 - px) / dx;
    best = { t, pattern: { kind: 'line', orientation: 'Horizontal', position_pct: (100 * (py + t * dy)) / h, tilt_deg: wrapTilt(theta) } };
  }
  if (Math.abs(dy) > 1e-9) {
    const t = (h / 2 - py) / dy;
    if (!best || Math.abs(t) < Math.abs(best.t)) {
      best = { t, pattern: { kind: 'line', orientation: 'Vertical', position_pct: (100 * (px + t * dx)) / w, tilt_deg: wrapTilt(theta - 90) } };
    }
  }
  const half = (w * Math.abs(dx) + h * Math.abs(dy)) / 2;
  return best && Math.abs(best.t) <= half * (1 + 1e-9) ? best.pattern : null;
}

/** An angle in degrees as a line's tilt in [−90, 90). */
function wrapTilt(deg: number): number {
  return ((((deg + 90) % 180) + 180) % 180) - 90;
}

/** Lines parallel to the base line at `offsetsPx` across it (along `base.normal`). Lines laserline can't draw are left out. */
export function planParallel(base: BaseLine, offsetsPx: readonly number[], viewPx: ViewPoint): PlannedLine[] {
  const [cx, cy] = base.center_px;
  const [nx, ny] = base.normal;
  return offsetsPx.flatMap((at) => planned('parallel', at, 0, [cx + at * nx, cy + at * ny], base.dir, viewPx));
}

/**
 * Pairs of lines crossing the base line at ±`angleDeg` through the points `alongPx` along it (from
 * `base.center_px`, along `base.dir`). Lines laserline can't draw are left out.
 */
export function planCrossings(base: BaseLine, alongPx: readonly number[], viewPx: ViewPoint, angleDeg = 45): PlannedLine[] {
  const [cx, cy] = base.center_px;
  const [dx, dy] = base.dir;
  return alongPx.flatMap((at) =>
    ([-1, 1] as const).flatMap((sign) => {
      const a = (sign * angleDeg * Math.PI) / 180;
      const dir: ViewPoint = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
      return planned('crossing', at, sign, [cx + at * dx, cy + at * dy], dir, viewPx);
    }),
  );
}

function planned(kind: PlannedLine['kind'], at: number, sign: PlannedLine['sign'], point: ViewPoint, dir: ViewPoint, viewPx: ViewPoint): PlannedLine[] {
  const pattern = linePattern({ point, dir }, viewPx);
  const segment = pattern && patternSegment(pattern, viewPx);
  return pattern && segment ? [{ kind, at, sign, pattern, line: lineThrough(segment.a, segment.b) }] : [];
}

/**
 * Per column: the median of the non-zero values, their MAD and the valid share. Each array holds
 * one or more profiles of `width` values (a whole frame, say); 0 is invalid.
 */
export function reduceProfiles(profiles: readonly Uint16Array[], width: number): ReducedProfiles {
  const columns: number[][] = Array.from({ length: width }, () => []);
  let count = 0;
  for (const p of profiles) {
    const rows = Math.floor(p.length / width);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < width; c++) {
        const v = p[row * width + c];
        if (v) columns[c].push(v);
      }
    }
    count += rows;
  }
  const median = new Float64Array(width).fill(NaN);
  const mad = new Float64Array(width).fill(NaN);
  const valid = new Float64Array(width);
  columns.forEach((values, c) => {
    if (!values.length) return;
    const m = medianOf(values);
    median[c] = m;
    mad[c] = medianOf(values.map((v) => Math.abs(v - m)));
    valid[c] = values.length / count;
  });
  return { width, profiles: count, median, mad, valid };
}

/** The columns that see a line: a valid share of at least `minShare`. */
export function seenColumns(reduced: ReducedProfiles, minShare = RANGE_SEEN_SHARE): number[] {
  const out: number[] = [];
  reduced.valid.forEach((share, c) => {
    if (share >= minShare) out.push(c);
  });
  return out;
}

/**
 * Whether two reductions show the same thing (a frame's two halves, say, which differ when it
 * straddles a pattern switch): at most `RANGE_DISAGREE_SHARE` of the columns either sees are seen
 * by one while the other clearly doesn't (under `RANGE_UNSEEN_SHARE`), and the columns both see are
 * shifted by at most `tolerance` (values), the median of their differences. A column one sees and
 * the other only flickers in (a share in between) isn't counted against them.
 *
 * The shift, not a count of columns that differ: a switch moves the whole line, while a real
 * camera's columns are noisy one by one. On the AT C6 the medians of a frame's two halves (5
 * profiles each, values in steps of 8) differed by over 4 MADs in ~17 % of the columns of a line
 * that stood still, and by a median of 0; a switch shifted them by 88, then 20 and 7 while the
 * display settled.
 */
export function profilesAgree(a: ReducedProfiles, b: ReducedProfiles, tolerance: number): boolean {
  const d = profilesDisagreement(a, b);
  return d.seenByOne <= RANGE_DISAGREE_SHARE * d.counted && Math.abs(d.shift) <= tolerance;
}

/** How two reductions differ: the columns either sees, those only one sees (the other under `RANGE_UNSEEN_SHARE`), and the median of `a − b` over the columns both see (0 without any). */
export interface ProfilesDisagreement {
  counted: number;
  seenByOne: number;
  shift: number;
}

/** What `profilesAgree` measures, for reporting why two reductions don't agree. */
export function profilesDisagreement(a: ReducedProfiles, b: ReducedProfiles): ProfilesDisagreement {
  let counted = 0;
  let seenByOne = 0;
  const differences: number[] = [];
  const width = Math.min(a.width, b.width);
  for (let c = 0; c < width; c++) {
    const sa = a.valid[c] >= RANGE_SEEN_SHARE;
    const sb = b.valid[c] >= RANGE_SEEN_SHARE;
    if (!sa && !sb) continue;
    counted++;
    if (sa && sb) {
      differences.push(a.median[c] - b.median[c]);
    } else if (Math.min(a.valid[c], b.valid[c]) < RANGE_UNSEEN_SHARE) {
      seenByOne++;
    }
  }
  return { counted, seenByOne, shift: differences.length ? medianOf(differences) : 0 };
}

/**
 * The map G: (c, r) → view px that puts every observation on its line, or null when the
 * observations don't determine it (a parallel-only set, say: all its lines meet at infinity). Only
 * the crossing lines fix the along direction, and a wrong one leaves no residual, so the set has to
 * pass `checkCoverage` first.
 *
 * A point-on-line DLT, `lᵀ · G · (c, r, 1)ᵀ = 0`, solved in normalised space (c and r each to mean 0
 * and RMS 1, the view about the lines' common point, the lines with the inverse transpose) with
 * h8 = 1, then once more weighted by 1/w so the error is the distance in view px. When the
 * projective system is ill-conditioned (`RANGE_MIN_CONDITION`), G is affine. A trimmed refit drops
 * the observations over `RANGE_TRIM_FACTOR` × the median residual, at most `RANGE_TRIM_SHARE`.
 *
 * Every line weighs the same, however many columns saw it: a parallel line lights hundreds of
 * columns and a crossing line a few dozen, but only the crossing lines fix the along direction. So
 * the fit, the median, the trimmed share and `rms` all count each observation with 1 ÷ its line's.
 */
export function solveRangeMap(obs: readonly RangeObservation[]): RangeMap | null {
  if (obs.length < 8) {
    return null;
  }
  const lines = obs.map((o) => unitLine(o.line));
  const keys = obs.map((o) => o.line.join(','));
  const counts = new Map<string, number>();
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  const weight = keys.map((key) => 1 / counts.get(key)!);
  const tIn = axisNormalizer(obs);
  const tView = viewNormalizer(lines);
  const rows: NormalRow[] = obs.map((o, i) => {
    const [a, b, c] = lines[i];
    return {
      x: tIn[0] * o.c + tIn[2],
      y: tIn[4] * o.r + tIn[5],
      l: [a, b, tView.k * (a * tView.x + b * tView.y + c)],
      weight: weight[i],
    };
  });
  // G = Tv⁻¹ · G' · T.
  const back: Mat3 = [1 / tView.k, 0, tView.x, 0, 1 / tView.k, tView.y, 0, 0, 1];
  const denormalise = (g: Mat3): Mat3 => {
    const out = multiplyMat3(multiplyMat3(back, g), tIn);
    const s = Math.abs(out[8]) > 1e-12 ? out[8] : 1;
    return out.map((v) => v / s) as unknown as Mat3;
  };
  const residual = (g: Mat3, i: number) => {
    const [a, b, c] = lines[i];
    const w = g[6] * obs[i].c + g[7] * obs[i].r + g[8];
    if (!(Math.abs(w) > 1e-12)) return Infinity;
    const p = applyHomography(g, { x: obs[i].c, y: obs[i].r });
    return Math.abs(a * p.x + b * p.y + c);
  };

  const all = obs.map((_, i) => i);
  const first = fitNormalised(rows, all);
  if (!first) {
    return null;
  }
  const g1 = denormalise(first.g);
  const res1 = all.map((i) => residual(g1, i));
  const threshold = Math.max(RANGE_TRIM_FACTOR * weightedMedian(res1, weight), RANGE_TRIM_FLOOR_PX);
  const drop = new Set<number>();
  let budget = RANGE_TRIM_SHARE * counts.size;
  for (const i of [...all].sort((p, q) => res1[q] - res1[p])) {
    if (res1[i] <= threshold || weight[i] > budget) break;
    drop.add(i);
    budget -= weight[i];
  }
  const kept = all.filter((i) => !drop.has(i));
  const second = drop.size ? fitNormalised(rows, kept) : first;
  const fit = second ?? first;
  const used = second ? kept : all;
  const g = second ? denormalise(second.g) : g1;

  const res = all.map((i) => residual(g, i));
  const usedWeight = used.reduce((s, i) => s + weight[i], 0);
  const perLine = new Map<string, { line: ViewLine; sq: number; n: number; dropped: number; max: number }>();
  const usedSet = new Set(used);
  obs.forEach((o, i) => {
    const key = keys[i];
    const entry = perLine.get(key) ?? { line: o.line, sq: 0, n: 0, dropped: 0, max: 0 };
    entry.sq += res[i] ** 2;
    entry.n++;
    entry.max = Math.max(entry.max, res[i]);
    if (!usedSet.has(i)) entry.dropped++;
    perLine.set(key, entry);
  });
  return {
    g,
    model: fit.model,
    rms: Math.sqrt(used.reduce((s, i) => s + weight[i] * res[i] ** 2, 0) / usedWeight),
    max: used.reduce((m, i) => Math.max(m, res[i]), 0),
    used: used.length,
    perLine: [...perLine.values()].map(({ line, sq, n, dropped, max }) => ({ line, n, dropped, rms: Math.sqrt(sq / n), max })),
  };
}

interface NormalRow {
  x: number;
  y: number;
  l: ViewLine;
  weight: number;
}

/** G' for the rows `use`: projective, or affine when that is ill-conditioned; null when neither is conditioned. */
function fitNormalised(rows: readonly NormalRow[], use: readonly number[]): { g: Mat3; model: RangeMap['model'] } | null {
  for (const model of ['projective', 'affine'] as const) {
    const n = model === 'projective' ? 8 : 6;
    let g: number[] | null = null;
    // Unweighted first, then weighted by 1/w so the algebraic error approaches the distance.
    for (let pass = 0; pass < 2; pass++) {
      const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      const atb = new Array<number>(n).fill(0);
      for (const i of use) {
        const { x, y, l, weight } = rows[i];
        const row = [l[0] * x, l[0] * y, l[0], l[1] * x, l[1] * y, l[1], l[2] * x, l[2] * y].slice(0, n);
        const w = g && n === 8 ? g[6] * x + g[7] * y + 1 : 1;
        const k = weight / Math.max(Math.abs(w), 1e-6) ** 2;
        for (let r = 0; r < n; r++) {
          atb[r] -= k * row[r] * l[2];
          for (let c = 0; c < n; c++) ata[r][c] += k * row[r] * row[c];
        }
      }
      if (pass === 0 && eigenRatio(ata) < RANGE_MIN_CONDITION) {
        g = null;
        break;
      }
      g = solve(ata, atb);
      if (!g || n === 6) break;
    }
    if (g) {
      const [a, b, c, d, e, f, p = 0, q = 0] = g;
      return { g: [a, b, c, d, e, f, p, q, 1], model };
    }
  }
  return null;
}

/** c and r each to mean 0 and RMS 1 (the domain is a narrow band, so not isotropically). */
function axisNormalizer(obs: readonly RangeObservation[]): Mat3 {
  const n = obs.length;
  const mc = obs.reduce((s, o) => s + o.c, 0) / n;
  const mr = obs.reduce((s, o) => s + o.r, 0) / n;
  const sc = Math.sqrt(obs.reduce((s, o) => s + (o.c - mc) ** 2, 0) / n) || 1;
  const sr = Math.sqrt(obs.reduce((s, o) => s + (o.r - mr) ** 2, 0) / n) || 1;
  return [1 / sc, 0, -mc / sc, 0, 1 / sr, -mr / sr, 0, 0, 1];
}

/** The view about the lines' least-squares common point, scaled so the lines lie at a mean distance of 1 from it. */
function viewNormalizer(lines: readonly ViewLine[]): { x: number; y: number; k: number } {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let bx = 0;
  let by = 0;
  for (const [a, b, c] of lines) {
    sxx += a * a;
    sxy += a * b;
    syy += b * b;
    bx -= a * c;
    by -= b * c;
  }
  const det = sxx * syy - sxy * sxy;
  let x: number;
  let y: number;
  if (det > 1e-9 * lines.length * lines.length) {
    x = (syy * bx - sxy * by) / det;
    y = (sxx * by - sxy * bx) / det;
  } else {
    // All (nearly) parallel: the mean of their feet from the origin.
    x = lines.reduce((s, [a, , c]) => s - a * c, 0) / lines.length;
    y = lines.reduce((s, [, b, c]) => s - b * c, 0) / lines.length;
  }
  const mean = lines.reduce((s, [a, b, c]) => s + Math.abs(a * x + b * y + c), 0) / lines.length;
  return { x, y, k: mean > 1e-9 ? 1 / mean : 1 };
}

function unitLine([a, b, c]: ViewLine): ViewLine {
  const n = Math.hypot(a, b) || 1;
  return [a / n, b / n, c / n];
}

/** λmin / λmax of a symmetric positive semi-definite matrix scaled to a unit diagonal (cyclic Jacobi). */
function eigenRatio(a: readonly number[][]): number {
  const n = a.length;
  if (a.some((row, i) => !(row[i] > 0))) {
    return 0;
  }
  const d = a.map((row, i) => 1 / Math.sqrt(row[i]));
  const m = a.map((row, i) => row.map((v, j) => v * d[i] * d[j]));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (m[p][q] === 0) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const kp = m[k][p];
          const kq = m[k][q];
          m[k][p] = c * kp - s * kq;
          m[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < n; k++) {
          const pk = m[p][k];
          const qk = m[q][k];
          m[p][k] = c * pk - s * qk;
          m[q][k] = s * pk + c * qk;
        }
      }
    }
  }
  const eig = m.map((row, i) => row[i]);
  const max = Math.max(...eig);
  return max > 0 ? Math.max(0, Math.min(...eig)) / max : 0;
}

/**
 * The envelope's corners from the base centre: along `base.dir` and across along `base.normal`,
 * `[min, max]` in view px each. The band (#33 §2) is measured the same way.
 */
export function envelopeExtent(env: Envelope | null | undefined, base: BaseLine): { along: [number, number]; across: [number, number] } | null {
  if (!env) {
    return null;
  }
  const along = env.corners.map(([x, y]) => (x - base.center_px[0]) * base.dir[0] + (y - base.center_px[1]) * base.dir[1]);
  const across = env.corners.map(([x, y]) => (x - base.center_px[0]) * base.normal[0] + (y - base.center_px[1]) * base.normal[1]);
  return { along: [Math.min(...along), Math.max(...along)], across: [Math.min(...across), Math.max(...across)] };
}

/**
 * Whether a calibration set meets the minimums of #33 §2: at least 3 parallel lines, each seen in
 * half the columns; at least 2 crossing lines of each sign, each seen in a few columns, spanning
 * half the columns together.
 */
export function checkCoverage(lines: readonly LineCoverage[], width: number): CoverageCheck {
  const parallel = lines.filter((l) => l.kind === 'parallel' && l.columns.length >= RANGE_PARALLEL_SHARE * width).length;
  const crossing = lines.filter((l) => l.kind === 'crossing' && l.columns.length >= RANGE_CROSSING_MIN_COLUMNS);
  const neg = crossing.filter((l) => l.sign < 0).length;
  const pos = crossing.filter((l) => l.sign > 0).length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of crossing) {
    for (let i = 0; i < l.columns.length; i++) {
      lo = Math.min(lo, l.columns[i]);
      hi = Math.max(hi, l.columns[i]);
    }
  }
  const span = hi >= lo && width > 0 ? (hi - lo + 1) / width : 0;
  let reason: string | null = null;
  if (parallel < RANGE_MIN_PARALLEL) {
    reason = `only ${parallel} parallel lines are seen in half the columns (${RANGE_MIN_PARALLEL} needed): does the camera's region hold the band around the line?`;
  } else if (neg < RANGE_MIN_CROSSING_PER_SIGN || pos < RANGE_MIN_CROSSING_PER_SIGN) {
    reason = `too few crossing lines are seen (${neg} turned −, ${pos} turned +; ${RANGE_MIN_CROSSING_PER_SIGN} of each needed)`;
  } else if (span < RANGE_CROSSING_SPAN) {
    reason = `the crossing lines span only ${Math.round(span * 100)} % of the columns (${RANGE_CROSSING_SPAN * 100} % needed)`;
  }
  return { ok: reason === null, reason, parallel, crossing: { neg, pos }, span };
}

/** The value at half the total weight; NaN residuals count as the largest. */
function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const key = (i: number) => (Number.isNaN(values[i]) ? Infinity : values[i]);
  const order = values.map((_, i) => i).sort((a, b) => key(a) - key(b));
  const half = weights.reduce((s, w) => s + w, 0) / 2;
  let sum = 0;
  for (const i of order) {
    sum += weights[i];
    if (sum >= half) return values[i];
  }
  return NaN;
}

function medianOf(values: readonly number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
