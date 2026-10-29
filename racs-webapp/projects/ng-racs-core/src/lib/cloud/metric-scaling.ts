/**
 * Metric scaling (#33 §3): the range calibration G and laserline's metric mapping composed into
 * millimetres, then fitted per axis into a `CloudScaling`.
 *
 *   p = G(c, r)                            camera (column, value) → laserline view px
 *   s = (p − c0)·d,  t = (p − c0)·n        along and across the base line, view px
 *   u = u0_mm + s ÷ along_px_per_mm        mm along the line
 *   z = t ÷ height_px_per_mm               mm above the base
 *
 * The cloud is per axis, so u is fitted on the column alone and z on the value alone; what that
 * leaves out is the residual. The live follow (`metricDomain`, `scalingMoved`, `metricStates`)
 * is here too. Pure; no dependencies.
 */

import { applyHomography, type Mat3 } from '../imaging/homography';
import type { BaseLine, Envelope, MetricDisturbance, MetricMapping } from '../laserline/protocol';
import type { PickedRate } from './profile-rate';
import type { CloudScaling } from './scaling';

/** Height gains below this (view px per mm) count as flat, as in laserline (`FLAT_GAIN_PX_PER_MM`). */
export const METRIC_FLAT_GAIN = 1e-6;

/** Grid points per axis the linear fit samples the domain at. */
export const METRIC_FIT_GRID = 21;

/** (c, r) → (u, z) in mm; `w` is G's homogeneous weight there, when the mapping has one. */
export type MetricCompose = (c: number, r: number) => { u: number; z: number; w?: number };

/** Where the calibration holds: columns and values, `[lo, hi]` each. */
export interface MetricDomain {
  columns: [number, number];
  values: [number, number];
}

export interface FitResidual {
  rms: number;
  max: number;
}

export interface LinearScalingFit {
  /** mm per column, positive. */
  xPitch: number;
  /** u grows with the column, so x has to run the other way (see `CloudScaling.mirrorX`). */
  mirrorX: boolean;
  /** z = value × zScale + zOffset, mm above the base. */
  zScale: number;
  zOffset: number;
  /** What the per-axis fit leaves, mm over the domain. */
  residual: { x: FitResidual; z: FitResidual };
}

/** (c, r) → (u, z) in mm. A flat mapping (heights don't move the line) gives z = NaN. */
export function composeMetric(g: Mat3, metric: MetricMapping): MetricCompose {
  const { center_px: c0, dir: d, normal: n } = metric.base;
  const flat = metric.disturbances.includes('flat') || !(Math.abs(metric.height_px_per_mm) >= METRIC_FLAT_GAIN);
  return (c, r) => {
    const p = applyHomography(g, { x: c, y: r });
    const dx = p.x - c0[0];
    const dy = p.y - c0[1];
    return {
      u: metric.u0_mm + (dx * d[0] + dy * d[1]) / metric.along_px_per_mm,
      z: flat ? NaN : (dx * n[0] + dy * n[1]) / metric.height_px_per_mm,
      w: g[6] * c + g[7] * r + g[8],
    };
  };
}

/**
 * The per-axis linear scaling that best matches `compose` over the domain (a grid of
 * `METRIC_FIT_GRID`² points): u ≈ a + b·c, z ≈ zScale·r + zOffset. Null when anything on the grid
 * isn't finite (a flat mapping), G goes through infinity inside the domain (`w` changes sign; it
 * is affine, so the corners, which the grid includes, decide), or an axis doesn't move.
 */
export function fitLinearScaling(domain: MetricDomain, compose: MetricCompose): LinearScalingFit | null {
  const [c0, c1] = domain.columns;
  const [r0, r1] = domain.values;
  if (![c0, c1, r0, r1].every(Number.isFinite) || !(c1 > c0) || !(r1 > r0)) {
    return null;
  }
  const n = METRIC_FIT_GRID;
  const cs: number[] = [];
  const rs: number[] = [];
  const us: number[] = [];
  const zs: number[] = [];
  let side = 0;
  for (let i = 0; i < n; i++) {
    const c = c0 + ((c1 - c0) * i) / (n - 1);
    for (let j = 0; j < n; j++) {
      const r = r0 + ((r1 - r0) * j) / (n - 1);
      const { u, z, w } = compose(c, r);
      if (!Number.isFinite(u) || !Number.isFinite(z)) {
        return null;
      }
      if (w !== undefined) {
        const sign = Math.sign(w);
        if (sign === 0 || (side !== 0 && sign !== side)) {
          return null;
        }
        side = sign;
      }
      cs.push(c);
      rs.push(r);
      us.push(u);
      zs.push(z);
    }
  }
  const x = line(cs, us);
  const z = line(rs, zs);
  if (!x || !z || x.slope === 0 || z.slope === 0) {
    return null;
  }
  return {
    xPitch: Math.abs(x.slope),
    mirrorX: x.slope > 0,
    zScale: z.slope,
    zOffset: z.intercept,
    residual: { x: x.residual, z: z.residual },
  };
}

/** The fit as the 3D view's scaling, with `ySpacing` mm per profile. */
export function metricScaling(fit: LinearScalingFit, ySpacing: number): CloudScaling {
  return {
    unit: 'mm',
    xPitch: fit.xPitch,
    ySpacing,
    zScale: fit.zScale,
    zOffset: fit.zOffset,
    mirrorX: fit.mirrorX,
    source: 'laserline',
  };
}

/** Changes the live follow applies at least, as a share (#33 §3): smaller ones are rate jitter. */
export const METRIC_FOLLOW_SHARE = 0.002;
/**
 * The same for `ySpacing` while laserline's travel is approximate (per-frame playback): its speed
 * follows laserline's own frame rate, which wanders by a few percent, so smaller changes are noise.
 */
export const METRIC_FOLLOW_APPROX_Y_SHARE = 0.05;

/**
 * The domain the linear fit samples: the calibration's columns, and its values cut to those whose
 * point under G lies across the base line within the envelope's across range (the heights the
 * scan can reach). The full values without an envelope, or when the cut leaves nothing.
 */
export function metricDomain(
  cal: { g: Mat3; columns: [number, number]; values: [number, number] },
  base: BaseLine,
  envelope: Envelope | null | undefined,
): MetricDomain {
  const full: MetricDomain = { columns: [cal.columns[0], cal.columns[1]], values: [cal.values[0], cal.values[1]] };
  if (!envelope) {
    return full;
  }
  const across = envelope.corners.map(([x, y]) => (x - base.center_px[0]) * base.normal[0] + (y - base.center_px[1]) * base.normal[1]);
  const lo = Math.min(...across);
  const hi = Math.max(...across);
  const [c0, c1] = cal.columns;
  const [r0, r1] = cal.values;
  const t = (c: number, r: number) => {
    const p = applyHomography(cal.g, { x: c, y: r });
    return (p.x - base.center_px[0]) * base.normal[0] + (p.y - base.center_px[1]) * base.normal[1];
  };
  let min = Infinity;
  let max = -Infinity;
  for (const c of [c0, (c0 + c1) / 2, c1]) {
    // Along a column G draws a straight line, so t is monotonic in r: the values at the range's
    // two ends bound the rest.
    for (const target of [lo, hi]) {
      const r = solveMonotonic((r) => t(c, r) - target, r0, r1);
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
  }
  return max > min ? { columns: full.columns, values: [min, max] } : full;
}

/** The root of a monotonic `f` in [a, b]; the nearer end when it has none there. */
function solveMonotonic(f: (x: number) => number, a: number, b: number): number {
  let fa = f(a);
  const fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return NaN;
  }
  if (Math.sign(fa) === Math.sign(fb)) {
    return Math.abs(fa) < Math.abs(fb) ? a : b;
  }
  for (let i = 0; i < 60 && b - a > 1e-9 * (Math.abs(a) + Math.abs(b) + 1); i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.sign(fm) === Math.sign(fa)) {
      a = m;
      fa = fm;
    } else {
      b = m;
    }
  }
  return (a + b) / 2;
}

/**
 * Whether the live follow applies `next` over `current` (#33 §3): the unit, source or mirror
 * differ, `xPitch` or `ySpacing` move by more than their share, or z moves by more than
 * `share` of the height range anywhere over `values` (so a `zOffset` near 0 doesn't count double).
 */
export function scalingMoved(
  current: CloudScaling,
  next: CloudScaling,
  values: [number, number],
  { share = METRIC_FOLLOW_SHARE, yShare = share }: { share?: number; yShare?: number } = {},
): boolean {
  if (current.unit !== next.unit || current.source !== next.source || !!current.mirrorX !== !!next.mirrorX) {
    return true;
  }
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
  if (!(rel(current.xPitch, next.xPitch) <= share) || !(rel(current.ySpacing, next.ySpacing) <= yShare)) {
    return true;
  }
  const range = Math.abs(next.zScale) * Math.abs(values[1] - values[0]);
  const dz = Math.max(...values.map((r) => Math.abs(current.zScale * r + current.zOffset - (next.zScale * r + next.zOffset))));
  return !(dz <= share * range);
}

/** One state of the *Laserline* scaling, shown as a dot and a word. */
export interface MetricState {
  id: 'live' | 'offline' | 'metric' | 'uncalibrated' | 'stale' | 'fit' | 'y' | 'band' | 'disturbances';
  word: string;
  tone: 'ok' | 'warn' | 'err' | 'faint';
  /** Why, shown beside the word. */
  detail?: string;
}

export interface MetricStateInputs {
  /** A laserline window answers. */
  online: boolean;
  /** Its metric mapping (`undefined`: it publishes none; `null`: no scan). */
  metric: MetricMapping | null | undefined;
  calibrated: boolean;
  staleReason: string | null;
  /** Why the calibration gives no linear scaling, when it doesn't. */
  fitProblem: string | null;
  rate: PickedRate | null;
  /** The envelope's across range leaves the calibrated band. */
  outOfBand: boolean;
}

/** What laserline's disturbances do to the mapping, by name. */
export const DISTURBANCE_TEXT: Record<MetricDisturbance, string> = {
  motion: 'the line moves on its own',
  bounce: 'bounce: the return pass runs backwards',
  once: 'the scan stops at its end',
  paused: 'playback paused',
  noise: 'noise',
  flat: 'height gain 0',
};

/**
 * The states of the *Laserline* scaling (#33 §3), most important first: live, or why not
 * (laserline offline, no mapping, not calibrated, no fit), then what to mistrust (a stale
 * calibration, an approximate y, out of band, laserline's disturbances).
 */
export function metricStates(i: MetricStateInputs): MetricState[] {
  const out: MetricState[] = [];
  if (!i.online) {
    out.push({ id: 'offline', word: 'laserline offline', tone: 'warn', detail: 'the last mapping is kept' });
  } else if (i.metric === undefined) {
    out.push({ id: 'metric', word: 'no mapping', tone: 'warn', detail: 'this laserline does not publish one: update it (reload its window)' });
  } else if (i.metric === null) {
    out.push({ id: 'metric', word: 'no mapping', tone: 'warn', detail: 'load a scan in laserline and enable it' });
  }
  if (!i.calibrated) {
    out.push({ id: 'uncalibrated', word: 'not calibrated', tone: 'faint', detail: 'calibrate with the camera on the laserline view' });
  } else if (i.fitProblem) {
    out.push({ id: 'fit', word: 'no fit', tone: 'err', detail: i.fitProblem });
  }
  if (i.online && i.metric && i.calibrated && !i.fitProblem) {
    out.unshift({ id: 'live', word: 'live', tone: 'ok' });
  }
  if (i.calibrated && i.staleReason) {
    out.push({ id: 'stale', word: 'calibration stale', tone: 'warn', detail: i.staleReason });
  }
  if (i.metric) {
    if (i.metric.travel.approximate) {
      out.push({ id: 'y', word: 'y approximate', tone: 'warn', detail: 'per-frame playback: the travel follows laserline’s frame rate' });
    } else if (!i.rate) {
      out.push({ id: 'y', word: 'y approximate', tone: 'warn', detail: 'no profile rate yet: stream for 10 s' });
    } else if (i.rate.rough) {
      out.push({ id: 'y', word: 'y approximate', tone: 'warn', detail: 'the rate comes from a burst’s timing' });
    }
    if (i.metric.disturbances.length) {
      out.push({ id: 'disturbances', word: 'disturbances', tone: 'warn', detail: i.metric.disturbances.map((d) => DISTURBANCE_TEXT[d] ?? d).join(' · ') });
    }
  }
  if (i.calibrated && i.outOfBand) {
    out.push({ id: 'band', word: 'out of band', tone: 'warn', detail: 'the scan reaches heights the camera’s region does not see' });
  }
  return out;
}

/** Least-squares line through (xs, ys), with its residuals. */
function line(xs: number[], ys: number[]): { slope: number; intercept: number; residual: FitResidual } | null {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (!(sxx > 0)) {
    return null;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sq = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.abs(ys[i] - (intercept + slope * xs[i]));
    sq += e * e;
    max = Math.max(max, e);
  }
  return { slope, intercept, residual: { rms: Math.sqrt(sq / n), max } };
}
