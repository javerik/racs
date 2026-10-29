/**
 * The camera's profile rate (#33 §3), which turns laserline's travel speed into the travel per
 * profile: `ySpacing = travel.mm_per_s ÷ profiles per second`.
 *
 * Measured live from the captured index (`frame_number + dropped`) over arrival time, so frames
 * dropped on the way still count; otherwise taken from what is known, in the order `pickRate`
 * goes through. Pure; times in ms (`performance.now()`), rates in profiles per second.
 */

import type { BurstJobInfo } from '../models/racs.models';
import type { MetricMapping } from '../laserline/protocol';

/** The estimate needs arrivals spanning this long. */
export const RATE_MIN_SPAN_MS = 10_000;
/** Arrivals older than this are forgotten, so the estimate follows a changed rate. */
export const RATE_WINDOW_MS = 20_000;
/** A longer pause in arrivals starts over: the stream stalled or restarted. */
export const RATE_MAX_GAP_MS = 2_000;

/**
 * The least-squares slope of the captured index over arrival time, × the frame height. It starts
 * over on a height change, an index going backwards (a new stream) or a gap over `RATE_MAX_GAP_MS`.
 */
export class ProfileRateEstimator {
  private index: number[] = [];
  private at: number[] = [];
  private height = 0;

  constructor(
    private readonly minSpanMs = RATE_MIN_SPAN_MS,
    private readonly windowMs = RATE_WINDOW_MS,
    private readonly maxGapMs = RATE_MAX_GAP_MS,
  ) {}

  reset(): void {
    this.index = [];
    this.at = [];
    this.height = 0;
  }

  /** Frame `capturedIndex` (`frame_number + dropped`) of `height` profiles arrived at `at`. */
  push(capturedIndex: number, at: number, height: number): void {
    const n = this.index.length;
    if (
      n > 0 &&
      (height !== this.height || capturedIndex < this.index[n - 1] || at - this.at[n - 1] > this.maxGapMs)
    ) {
      this.reset();
    }
    this.height = height;
    this.index.push(capturedIndex);
    this.at.push(at);
    let drop = 0;
    while (drop < this.at.length - 1 && this.at[drop] < at - this.windowMs) {
      drop++;
    }
    if (drop > 0) {
      this.index.splice(0, drop);
      this.at.splice(0, drop);
    }
  }

  /** Profiles per second, or null until the arrivals span `minSpanMs`. */
  rate(): number | null {
    const n = this.at.length;
    if (n < 2 || this.at[n - 1] - this.at[0] < this.minSpanMs || !(this.height > 0)) {
      return null;
    }
    // Centred on the first sample, so large indices and times keep their precision.
    const t0 = this.at[0];
    const i0 = this.index[0];
    let mt = 0;
    let mi = 0;
    for (let k = 0; k < n; k++) {
      mt += this.at[k] - t0;
      mi += this.index[k] - i0;
    }
    mt /= n;
    mi /= n;
    let stt = 0;
    let sti = 0;
    for (let k = 0; k < n; k++) {
      const dt = this.at[k] - t0 - mt;
      stt += dt * dt;
      sti += dt * (this.index[k] - i0 - mi);
    }
    const framesPerMs = sti / stt;
    const rate = framesPerMs * 1000 * this.height;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
}

/** mm of travel per profile, or null without a usable speed and rate. */
export function ySpacingFrom(travel: Pick<MetricMapping['travel'], 'mm_per_s'>, rate: number | null): number | null {
  const v = travel.mm_per_s / (rate ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The features that decide the profile rate: while they stay, the last live estimate does too. */
export const RATE_FEATURES = [
  'AcquisitionLineRate',
  'AcquisitionLineRateEnable',
  'ExposureTime',
  'TriggerMode',
  'Width',
  'Height',
] as const;

export type RateFeature = (typeof RATE_FEATURES)[number];

/** `FeatureState.value` per rate feature; missing or `null` when the camera has none. */
export type RateFeatureValues = Partial<Record<RateFeature, string | null>>;

export type RateSource = 'live' | 'last' | 'feature' | 'burst';

export interface PickedRate {
  /** Profiles per second. */
  rate: number;
  source: RateSource;
  /** Only roughly right: a burst's times include the wait for the camera. */
  rough: boolean;
}

export interface RateInputs {
  /** `ProfileRateEstimator.rate()` of the running stream. */
  live?: number | null;
  /** The last live estimate, and the rate features when it was made. */
  last?: number | null;
  lastFeatures?: RateFeatureValues | null;
  /** The rate features now. */
  features?: RateFeatureValues | null;
  /** A finished snapshot. */
  burst?: Pick<BurstJobInfo, 'captured_count' | 'height' | 'started_at' | 'completed_at'> | null;
}

/**
 * The best profile rate known, in the order of #33 §3: the live estimate; the last one, while the
 * rate features are unchanged; `AcquisitionLineRate` when `AcquisitionLineRateEnable` is on; a
 * burst's captured profiles over its duration (rough: `started_at` is set before the camera is
 * checked out). Null when none is usable.
 */
export function pickRate(i: RateInputs): PickedRate | null {
  if (usable(i.live)) {
    return { rate: i.live, source: 'live', rough: false };
  }
  if (usable(i.last) && i.lastFeatures && i.features && sameRateFeatures(i.lastFeatures, i.features)) {
    return { rate: i.last, source: 'last', rough: false };
  }
  const f = i.features;
  if (f && (f.AcquisitionLineRateEnable ?? '').trim().toLowerCase() === 'true') {
    const rate = Number(f.AcquisitionLineRate ?? NaN);
    if (usable(rate)) {
      return { rate, source: 'feature', rough: false };
    }
  }
  const b = i.burst;
  if (b?.started_at && b.completed_at && b.height) {
    const seconds = (Date.parse(b.completed_at) - Date.parse(b.started_at)) / 1000;
    const rate = (b.captured_count * b.height) / seconds;
    if (seconds > 0 && usable(rate)) {
      return { rate, source: 'burst', rough: true };
    }
  }
  return null;
}

/** Every rate feature reads the same in both (missing in both counts as the same). */
export function sameRateFeatures(a: RateFeatureValues, b: RateFeatureValues): boolean {
  return RATE_FEATURES.every((name) => (a[name] ?? null) === (b[name] ?? null));
}

function usable(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
