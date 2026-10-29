import { pickRate, ProfileRateEstimator, ySpacingFrom, type RateFeatureValues } from './profile-rate';

/** A deterministic jitter in [−1, 1). */
function jitter(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

/** Frames of `height` profiles taken every `periodMs`, arriving up to `jitterMs` late. */
function feed(
  e: ProfileRateEstimator,
  o: { frames: number; periodMs: number; height: number; jitterMs?: number; startIndex?: number; startMs?: number; skip?: (i: number) => boolean },
): void {
  const next = jitter(7);
  for (let i = 0; i < o.frames; i++) {
    const late = Math.abs(next()) * (o.jitterMs ?? 0);
    if (o.skip?.(i)) {
      continue;
    }
    e.push((o.startIndex ?? 0) + i, (o.startMs ?? 0) + i * o.periodMs + late, o.height);
  }
}

describe('ProfileRateEstimator', () => {
  it('measures a constant rate through arrival jitter', () => {
    const e = new ProfileRateEstimator();
    // 25 fps × 40 profiles = 1000 profiles/s; arrivals up to 30 ms late.
    feed(e, { frames: 25 * 15, periodMs: 40, height: 40, jitterMs: 30 });
    expect(e.rate()).toBeCloseTo(1000, -1);
    expect(Math.abs(e.rate()! - 1000) / 1000).toBeLessThan(0.002);
  });

  it('waits for 10 s of arrivals', () => {
    const e = new ProfileRateEstimator();
    feed(e, { frames: 240, periodMs: 40, height: 40 });
    expect(e.rate()).toBeNull();
    feed(e, { frames: 20, periodMs: 40, height: 40, startIndex: 240, startMs: 240 * 40 });
    expect(e.rate()).toBeCloseTo(1000, 6);
  });

  it('counts the camera, not the arrivals, when frames are dropped', () => {
    const e = new ProfileRateEstimator();
    // Two of every three frames never arrive; the captured index still counts them.
    feed(e, { frames: 25 * 15, periodMs: 40, height: 40, jitterMs: 10, skip: (i) => i % 3 !== 0 });
    expect(Math.abs(e.rate()! - 1000) / 1000).toBeLessThan(0.002);
  });

  it('follows a new rate within its window', () => {
    const e = new ProfileRateEstimator();
    feed(e, { frames: 25 * 15, periodMs: 40, height: 40 });
    // Now 50 fps, continuing the index and the clock.
    feed(e, { frames: 50 * 21, periodMs: 20, height: 40, startIndex: 375, startMs: 375 * 40 });
    expect(e.rate()).toBeCloseTo(2000, 6);
  });

  it('starts over on a height change, an index going back and a gap', () => {
    const height = new ProfileRateEstimator();
    feed(height, { frames: 25 * 15, periodMs: 40, height: 40 });
    height.push(375, 375 * 40, 20);
    expect(height.rate()).toBeNull();
    feed(height, { frames: 25 * 11, periodMs: 40, height: 20, startIndex: 376, startMs: 376 * 40 });
    expect(height.rate()).toBeCloseTo(500, 6);

    const back = new ProfileRateEstimator();
    feed(back, { frames: 25 * 15, periodMs: 40, height: 40 });
    back.push(3, 375 * 40, 40);
    expect(back.rate()).toBeNull();

    const gap = new ProfileRateEstimator();
    feed(gap, { frames: 25 * 15, periodMs: 40, height: 40 });
    gap.push(375, 374 * 40 + 2100, 40);
    expect(gap.rate()).toBeNull();
  });
});

describe('ySpacingFrom', () => {
  it('is the travel per profile', () => {
    expect(ySpacingFrom({ mm_per_s: 5 }, 1000)).toBeCloseTo(0.005);
    expect(ySpacingFrom({ mm_per_s: 5 }, null)).toBeNull();
    expect(ySpacingFrom({ mm_per_s: 5 }, 0)).toBeNull();
    expect(ySpacingFrom({ mm_per_s: 0 }, 1000)).toBeNull();
  });
});

describe('pickRate', () => {
  const features: RateFeatureValues = {
    AcquisitionLineRate: '800',
    AcquisitionLineRateEnable: 'true',
    ExposureTime: '100',
    TriggerMode: 'Off',
    Width: '1024',
    Height: '40',
  };
  const burst = {
    captured_count: 100,
    height: 40,
    started_at: '2026-10-27T10:00:00.000Z',
    completed_at: '2026-10-27T10:00:05.000Z',
  };
  const all = { live: 1000, last: 990, lastFeatures: features, features, burst };

  it('goes live, last, feature, burst', () => {
    expect(pickRate(all)).toEqual({ rate: 1000, source: 'live', rough: false });
    expect(pickRate({ ...all, live: null })).toEqual({ rate: 990, source: 'last', rough: false });
    expect(pickRate({ ...all, live: null, last: null })).toEqual({ rate: 800, source: 'feature', rough: false });
    const noRate = { ...features, AcquisitionLineRateEnable: 'false' };
    expect(pickRate({ ...all, live: null, last: null, features: noRate })).toEqual({ rate: 800, source: 'burst', rough: true });
    expect(pickRate({})).toBeNull();
  });

  it('drops the last estimate once a rate feature changed', () => {
    const exposure = { ...features, ExposureTime: '200' };
    expect(pickRate({ ...all, live: null, features: exposure })?.source).toBe('feature');
    // A feature the camera doesn't have is the same in both.
    const without = { ...features, TriggerMode: undefined };
    expect(pickRate({ ...all, live: null, lastFeatures: without, features: { ...without, TriggerMode: null } })?.source).toBe(
      'last',
    );
    // Without the current features nothing says the last estimate still holds.
    expect(pickRate({ ...all, live: null, features: null })?.source).toBe('burst');
  });

  it('skips what is unusable', () => {
    expect(pickRate({ live: 0, features: { ...features, AcquisitionLineRate: '0' }, burst })?.source).toBe('burst');
    expect(pickRate({ burst: { ...burst, completed_at: null } })).toBeNull();
    expect(pickRate({ burst: { ...burst, completed_at: burst.started_at } })).toBeNull();
  });
});
