import type { Mat3 } from '../imaging/homography';
import type { Envelope, MetricMapping, ViewPoint } from '../laserline/protocol';
import {
  composeMetric,
  fitLinearScaling,
  metricDomain,
  metricScaling,
  metricStates,
  scalingMoved,
  type MetricDomain,
  type MetricStateInputs,
} from './metric-scaling';
import type { CloudScaling } from './scaling';

const deg = Math.PI / 180;

/** A line at 30° through (400, 300), 4 px per mm along it and 3 px per mm of height (not inverted). */
function metric(over: Partial<MetricMapping> = {}): MetricMapping {
  const a = 30 * deg;
  return {
    rev: 1,
    base: { center_px: [400, 300], dir: [Math.cos(a), Math.sin(a)], normal: [-Math.sin(a), Math.cos(a)] },
    along_px_per_mm: 4,
    height_px_per_mm: -3,
    u0_mm: 2,
    dv_mm: 0.1,
    rows: 200,
    travel: { mode: 'per_second', rows_per_s: 50, mm_per_s: 5, approximate: false, playing: true, end: 'loop' },
    object_mm: null,
    model_mirrored: false,
    disturbances: [],
    ...over,
  };
}

/**
 * The affine G under which `m` reads u = u0 + a·c (mm) and z = b·r + e (mm above the base), with
 * `w` added to its last row for perspective.
 */
function affineG(m: MetricMapping, a: number, b: number, e: number, w: [number, number] = [0, 0]): Mat3 {
  const { center_px: c0, dir: d, normal: n } = m.base;
  const al = m.along_px_per_mm;
  const h = m.height_px_per_mm;
  const u0 = 7; // u at column 0, mm
  return [
    a * al * d[0],
    b * h * n[0],
    c0[0] + (u0 - m.u0_mm) * al * d[0] + e * h * n[0],
    a * al * d[1],
    b * h * n[1],
    c0[1] + (u0 - m.u0_mm) * al * d[1] + e * h * n[1],
    w[0],
    w[1],
    1,
  ];
}

const domain: MetricDomain = { columns: [0, 799], values: [1000, 5000] };

describe('composeMetric', () => {
  it('reads u along the line and z above the base', () => {
    const m = metric();
    const compose = composeMetric(affineG(m, 0.05, 0.002, -4), m);
    const p = compose(100, 3000);
    expect(p.u).toBeCloseTo(7 + 0.05 * 100);
    expect(p.z).toBeCloseTo(0.002 * 3000 - 4);
    // The base: value 2000 lies at height 0 in every column.
    expect(compose(0, 2000).z).toBeCloseTo(0);
    expect(compose(799, 2000).z).toBeCloseTo(0);
  });

  it('has no height for a flat mapping', () => {
    const g = affineG(metric(), 0.05, 0.002, -4);
    expect(composeMetric(g, metric({ disturbances: ['flat'] }))(10, 10).z).toBeNaN();
    expect(composeMetric(g, metric({ height_px_per_mm: 0 }))(10, 10).z).toBeNaN();
  });
});

describe('fitLinearScaling', () => {
  it('fits an affine G exactly', () => {
    const m = metric();
    const fit = fitLinearScaling(domain, composeMetric(affineG(m, -0.05, 0.002, -4), m))!;
    expect(fit.xPitch).toBeCloseTo(0.05, 12);
    expect(fit.zScale).toBeCloseTo(0.002, 12);
    expect(fit.zOffset).toBeCloseTo(-4, 9);
    expect(fit.residual.x.max).toBeLessThan(1e-9);
    expect(fit.residual.z.max).toBeLessThan(1e-9);
  });

  it('mirrors x exactly when u grows with the column', () => {
    const m = metric();
    const falling = fitLinearScaling(domain, composeMetric(affineG(m, -0.05, 0.002, -4), m))!;
    const rising = fitLinearScaling(domain, composeMetric(affineG(m, 0.05, 0.002, -4), m))!;
    expect(falling.mirrorX).toBe(false);
    expect(rising.mirrorX).toBe(true);
    expect(rising.xPitch).toBeCloseTo(falling.xPitch, 12);
  });

  it('puts the base at z = 0, and flips z with an inverted height', () => {
    const m = metric();
    const g = affineG(m, 0.05, 0.002, -4);
    const fit = fitLinearScaling(domain, composeMetric(g, m))!;
    expect(2000 * fit.zScale + fit.zOffset).toBeCloseTo(0, 9);

    // Laserline inverted: the same camera values read the other way up.
    const inverted = fitLinearScaling(domain, composeMetric(g, metric({ height_px_per_mm: 3 })))!;
    expect(inverted.zScale).toBeCloseTo(-fit.zScale, 12);
    expect(2000 * inverted.zScale + inverted.zOffset).toBeCloseTo(0, 9);
  });

  it('leaves a residual that grows with perspective', () => {
    const m = metric();
    const residual = (w: number) => {
      const fit = fitLinearScaling(domain, composeMetric(affineG(m, 0.05, 0.002, -4, [w, w / 10]), m))!;
      return fit.residual;
    };
    const small = residual(2e-5);
    const large = residual(1e-4);
    expect(small.x.rms).toBeGreaterThan(1e-4);
    expect(small.z.rms).toBeGreaterThan(1e-4);
    expect(large.x.rms).toBeGreaterThan(small.x.rms * 3);
    expect(large.z.rms).toBeGreaterThan(small.z.rms * 3);
    expect(large.x.max).toBeGreaterThanOrEqual(large.x.rms);
  });

  it('refuses a flat mapping, an empty domain and a G through infinity', () => {
    const m = metric();
    const g = affineG(m, 0.05, 0.002, -4);
    expect(fitLinearScaling(domain, composeMetric(g, metric({ disturbances: ['flat'] })))).toBeNull();
    expect(fitLinearScaling({ columns: [5, 5], values: [0, 10] }, composeMetric(g, m))).toBeNull();
    // w = 1 − c/401 crosses 0 between two grid columns.
    expect(fitLinearScaling(domain, composeMetric(affineG(m, 0.05, 0.002, -4, [-1 / 401, 0]), m))).toBeNull();
    // An overall sign doesn't matter: −G is the same map.
    const negated = affineG(m, 0.05, 0.002, -4).map((v) => -v) as unknown as typeof g;
    expect(fitLinearScaling(domain, composeMetric(negated, m))?.xPitch).toBeCloseTo(0.05, 12);
  });
});

describe('metricScaling', () => {
  it('is in mm from laserline, with the travel per profile', () => {
    const m = metric();
    const fit = fitLinearScaling(domain, composeMetric(affineG(m, 0.05, 0.002, -4), m))!;
    expect(metricScaling(fit, 0.02)).toEqual({
      unit: 'mm',
      xPitch: fit.xPitch,
      ySpacing: 0.02,
      zScale: fit.zScale,
      zOffset: fit.zOffset,
      mirrorX: true,
      source: 'laserline',
    });
  });
});

/** The envelope `along` × `across` view px about `m`'s base centre (along `dir`, across `normal`). */
function envelopeOf(m: MetricMapping, along: [number, number], across: [number, number]): Envelope {
  const { center_px: c, dir: d, normal: n } = m.base;
  const at = (a: number, t: number): ViewPoint => [c[0] + a * d[0] + t * n[0], c[1] + a * d[1] + t * n[1]];
  return {
    corners: [at(along[0], across[0]), at(along[1], across[0]), at(along[1], across[1]), at(along[0], across[1])],
    center_px: c,
    dir: d,
    normal: n,
    along_px: along,
    across_px: across,
  };
}

describe('metricDomain', () => {
  // z = 0.002·r − 4 mm, 3 px per mm of height against the normal: t = −3·z.
  const m = metric();
  const g = affineG(m, 0.05, 0.002, -4);
  const cal = { g, columns: domain.columns, values: domain.values };

  it('cuts the values to the heights the envelope reaches', () => {
    // t from −12 to 0 px: z from 0 to 4 mm, so r from 2000 to 4000.
    const d = metricDomain(cal, m.base, envelopeOf(m, [-100, 100], [-12, 0]));
    expect(d.columns).toEqual([0, 799]);
    expect(d.values[0]).toBeCloseTo(2000, 3);
    expect(d.values[1]).toBeCloseTo(4000, 3);
  });

  it('keeps the calibrated values without an envelope, or when the envelope lies outside them', () => {
    expect(metricDomain(cal, m.base, null)).toEqual(domain);
    expect(metricDomain(cal, m.base, envelopeOf(m, [-100, 100], [-500, -400]))).toEqual(domain);
  });

  it('clamps an envelope wider than the calibration to it', () => {
    const d = metricDomain(cal, m.base, envelopeOf(m, [-100, 100], [-100, 100]));
    expect(d.values).toEqual([1000, 5000]);
  });
});

describe('scalingMoved', () => {
  const base: CloudScaling = { unit: 'mm', xPitch: 0.1, ySpacing: 0.05, zScale: 0.002, zOffset: -4, mirrorX: true, source: 'laserline' };
  const values: [number, number] = [1000, 5000];

  it('ignores changes up to 0.2 %', () => {
    expect(scalingMoved(base, { ...base, xPitch: 0.1 * 1.0019 }, values)).toBe(false);
    expect(scalingMoved(base, { ...base, ySpacing: 0.05 * 0.9981 }, values)).toBe(false);
    // 0.0015 mm of an 8 mm height range.
    expect(scalingMoved(base, { ...base, zOffset: -4.0015 }, values)).toBe(false);
  });

  it('applies changes above 0.2 %', () => {
    expect(scalingMoved(base, { ...base, xPitch: 0.1 * 1.0021 }, values)).toBe(true);
    expect(scalingMoved(base, { ...base, ySpacing: 0.05 * 1.0021 }, values)).toBe(true);
    expect(scalingMoved(base, { ...base, zOffset: -4.02 }, values)).toBe(true);
    expect(scalingMoved(base, { ...base, zScale: 0.002 * 1.003 }, values)).toBe(true);
  });

  it('always applies another mirror, unit or source', () => {
    expect(scalingMoved(base, { ...base, mirrorX: false }, values)).toBe(true);
    expect(scalingMoved({ ...base, source: 'manual' }, base, values)).toBe(true);
    expect(scalingMoved({ ...base, unit: 'px' }, base, values)).toBe(true);
  });

  it('takes its own share for y', () => {
    const next = { ...base, ySpacing: 0.05 * 1.008 };
    expect(scalingMoved(base, next, values)).toBe(true);
    expect(scalingMoved(base, next, values, { yShare: 0.05 })).toBe(false);
    expect(scalingMoved(base, { ...base, ySpacing: 0.05 * 1.06 }, values, { yShare: 0.05 })).toBe(true);
  });
});

describe('metricStates', () => {
  const ok: MetricStateInputs = {
    online: true,
    metric: metric(),
    calibrated: true,
    staleReason: null,
    fitProblem: null,
    rate: { rate: 1000, source: 'live', rough: false },
    outOfBand: false,
  };
  const ids = (i: Partial<MetricStateInputs>) => metricStates({ ...ok, ...i }).map((s) => s.id);

  it('is live when everything holds', () => {
    expect(metricStates(ok)).toEqual([{ id: 'live', word: 'live', tone: 'ok' }]);
  });

  it('names why it is not live', () => {
    expect(ids({ online: false })).toEqual(['offline']);
    expect(ids({ metric: undefined })).toEqual(['metric']);
    expect(ids({ metric: null })).toEqual(['metric']);
    expect(ids({ calibrated: false })).toEqual(['uncalibrated']);
    expect(ids({ fitProblem: 'flat' })).toEqual(['fit']);
  });

  it('adds what to mistrust while live', () => {
    expect(ids({ staleReason: 'OffsetY changed (300 → 310)' })).toEqual(['live', 'stale']);
    expect(ids({ outOfBand: true })).toEqual(['live', 'band']);
    expect(ids({ rate: null })).toEqual(['live', 'y']);
    expect(ids({ rate: { rate: 900, source: 'burst', rough: true } })).toEqual(['live', 'y']);
    expect(ids({ metric: metric({ travel: { ...metric().travel, mode: 'per_frame', approximate: true } }) })).toEqual(['live', 'y']);
  });

  it('names each disturbance', () => {
    const [, d] = metricStates({ ...ok, metric: metric({ disturbances: ['motion', 'noise'] }) });
    expect(d.id).toBe('disturbances');
    expect(d.detail).toBe('the line moves on its own · noise');
  });
});
