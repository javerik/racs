/**
 * Levelling the laserline: how slanted a filmed line runs across the sensor, and which tilt of the
 * line in laserline makes it run along the sensor rows (or columns). Plain functions, unit-tested
 * without a DOM.
 */

import { linearFit } from './fit';
import { linePeaks, type Plane, type ScanAxis } from './laser-line';

/** A measurement needs this many peaks ... */
export const MIN_LINE_POINTS = 50;
/** ... spread over this share of the frame along the line. */
export const MIN_LINE_SPAN = 0.3;
/** Peaks further than this many rms from the first fit are dropped before the second. */
const OUTLIER_RMS = 3;
/** ... but never closer than this (px), so a very clean line keeps its points. */
const OUTLIER_FLOOR_PX = 0.3;
/** Below this many sensor degrees per laserline degree, the tilt does not turn the filmed line. */
export const MIN_TILT_GAIN = 0.2;

/** A filmed line's slant: `angleDeg` from the scan axis (y down, so positive turns towards +v). */
export interface LineAngle {
  angleDeg: number;
  /** Distance of the peaks from the fitted straight line, px rms. */
  rms: number;
  /** Peaks used. */
  points: number;
  /** Share of the frame along the line the peaks cover. */
  span: number;
}

/**
 * The slant of the line in `plane` from its per-column (`axis` `'x'`) or per-row peaks: a straight
 * line fitted twice, the second time without the peaks far off the first. Null when too few peaks
 * are found or they cover too little of the frame.
 */
export function lineAngle(plane: Plane, axis: ScanAxis): LineAngle | null {
  const peaks = linePeaks(plane, axis);
  const extent = axis === 'x' ? plane.width : plane.height;
  const fit = (us: number[], vs: number[]) => {
    const f = linearFit(us, vs);
    if (!f) return null;
    let sum = 0;
    for (let i = 0; i < us.length; i++) sum += (vs[i] - f.evaluate(us[i])) ** 2;
    return { f, rms: Math.sqrt(sum / us.length) };
  };
  const first = fit(peaks.map((p) => p.u), peaks.map((p) => p.v));
  if (!first || peaks.length < MIN_LINE_POINTS) return null;
  const limit = OUTLIER_RMS * Math.max(first.rms, OUTLIER_FLOOR_PX);
  const kept = peaks.filter((p) => Math.abs(p.v - first.f.evaluate(p.u)) <= limit);
  const second = fit(kept.map((p) => p.u), kept.map((p) => p.v));
  if (!second || kept.length < MIN_LINE_POINTS) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of kept) {
    lo = Math.min(lo, p.u);
    hi = Math.max(hi, p.u);
  }
  const span = (hi - lo) / extent;
  if (span < MIN_LINE_SPAN) return null;
  return { angleDeg: (Math.atan(second.f.slope) * 180) / Math.PI, rms: second.rms, points: kept.length, span };
}

/** The sensor axis a filmed line runs along (within 45°), or null when the frame shows no line. */
export function lineAxis(plane: Plane): ScanAxis | null {
  let best: { axis: ScanAxis; score: number } | null = null;
  for (const axis of ['x', 'y'] as const) {
    const a = lineAngle(plane, axis);
    if (a && Math.abs(a.angleDeg) <= 45 && (!best || a.points * a.span > best.score)) {
      best = { axis, score: a.points * a.span };
    }
  }
  return best?.axis ?? null;
}

/** The filmed line's angle at one tilt of the line in laserline. */
export interface TiltSample {
  tilt: number;
  angle: number;
  /** Straightness of the filmed line, px rms. */
  rms: number;
}

/** The straight line `angle = gain·tilt + offset` through `samples`, and the tilt where it crosses 0. */
export interface TiltModel {
  gain: number;
  offset: number;
  tilt: number;
}

/**
 * Fits the filmed angle against the tilt. The gain is about ±1 (negative when the camera mirrors
 * the view); null with fewer than two distinct tilts, or when the tilt hardly turns the line
 * (`|gain|` under {@link MIN_TILT_GAIN}: laserline ignores the tilt, or the camera sees no line).
 */
export function fitTilt(samples: TiltSample[]): TiltModel | null {
  const f = linearFit(samples.map((s) => s.tilt), samples.map((s) => s.angle));
  if (!f || Math.abs(f.slope) < MIN_TILT_GAIN) return null;
  return { gain: f.slope, offset: f.intercept, tilt: -f.intercept / f.slope };
}

/**
 * The next tilt to try: the secant through the two samples closest to level (the model's root
 * while those two can't make one). Null when there is no model.
 */
export function nextTilt(samples: TiltSample[]): number | null {
  const model = fitTilt(samples);
  if (!model) return null;
  const [a, b] = [...samples].sort((p, q) => Math.abs(p.angle) - Math.abs(q.angle));
  if (b && Math.abs(a.tilt - b.tilt) > 1e-6) {
    const gain = (a.angle - b.angle) / (a.tilt - b.tilt);
    // A local slope far from the overall one comes from noise: trust the model then.
    if (Math.sign(gain) === Math.sign(model.gain) && Math.abs(gain) >= MIN_TILT_GAIN) {
      return a.tilt - a.angle / gain;
    }
  }
  return model.tilt;
}
