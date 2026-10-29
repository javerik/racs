import { rangeCameraG, rangeCameraMap, renderRangeScan, type SyntheticRangeCamera } from 'ng-racs-core/testing';
import type { BaseLine, MetricMapping, ViewPoint } from '../laserline/protocol';
import { composeMetric, fitLinearScaling, metricScaling } from './metric-scaling';
import { RowRing, ringLayout } from './ring';
import { type CloudScaling, PIXEL_SCALING, toUnits } from './scaling';
import { MAX_FRAMES } from './settings';
import { checkAgainstObject, proposeSnapshot, STL_CHECK_TOLERANCE, type StlCheck, type StlCheckResult } from './stl-check';

const VIEW: ViewPoint = [1920, 1080];
const BASE: BaseLine = { center_px: [960, 540], dir: [1, 0], normal: [0, 1] };
/** The camera sees 1600 px along the base line (200 mm) and 80 px across it, mostly above it. */
const FIELD = { x: 160, y: 470, width: 1600, height: 80 };
const COLUMNS = 400;
const ROWS = 80;
const DV = 0.5;
const PROFILES = 200;

/** 8 view px per mm along the line, 3 per mm of height (lifting the line toward −y). */
function metric(over: Partial<MetricMapping> = {}): MetricMapping {
  return {
    rev: 1,
    base: BASE,
    along_px_per_mm: 8,
    height_px_per_mm: -3,
    u0_mm: 0,
    dv_mm: DV,
    rows: PROFILES,
    travel: { mode: 'per_second', rows_per_s: 20, mm_per_s: 10, approximate: false, playing: true, end: 'loop' },
    object_mm: null,
    model_mirrored: false,
    disturbances: [],
    ...over,
  };
}

/** Column 0 sees the view's left end, so u grows with the column and the fit mirrors x. */
const CAM: SyntheticRangeCamera = {
  g: rangeCameraG(FIELD, { width: COLUMNS, rows: ROWS }, { perspective: 2e-5 }),
  width: COLUMNS,
  rows: ROWS,
  viewPx: VIEW,
  noise: 0.3,
};

/** The *Laserline* scaling for `CAM` and `m`, as the 3D tab derives it, y from the true travel. */
function scalingFor(m: MetricMapping): CloudScaling {
  const fit = fitLinearScaling({ columns: [0, COLUMNS - 1], values: [100, 100 + (ROWS - 1) * 16] }, composeMetric(rangeCameraMap(CAM), m));
  return metricScaling(fit!, DV);
}

/** A snapshot of `profiles` profiles of `height`, the first at travel `firstK` × `DV`. */
function scan(m: MetricMapping, height: (u: number, v: number) => number, firstK = 0, profiles = PROFILES, cam = CAM): RowRing {
  const ring = new RowRing(ringLayout(COLUMNS, profiles, 4096, 256), 'stacked', profiles);
  for (let k = 0; k < profiles; k++) {
    ring.writeStacked(k, 1, 1, renderRangeScan(cam, m, height, firstK + k, DV));
  }
  return ring;
}

const inside = (x: number, [lo, hi]: [number, number]) => x >= lo && x <= hi;

/** A 15 mm box, 80 mm along the line and 60 mm along the travel. */
const BOX = { u: [-40, 40] as [number, number], v: [20, 80] as [number, number], h: 15 };
const box = (u: number, v: number) => (inside(u, BOX.u) && inside(v, BOX.v) ? BOX.h : 0);
const BOX_MM: MetricMapping['object_mm'] = { min: [BOX.u[0], BOX.v[0], BOX.h], max: [BOX.u[1], BOX.v[1], BOX.h] };

/**
 * An asymmetric, stepped L in plan: a 6 mm arm along the line at the low v end, and a 20 mm
 * upright along the travel at the low u end. Its corner is at (−40, 20).
 */
const lBlock = (u: number, v: number) =>
  inside(u, [-40, -20]) && inside(v, [20, 80]) ? 20 : inside(u, [-40, 40]) && inside(v, [20, 35]) ? 6 : 0;
const L_MM: MetricMapping['object_mm'] = { min: [-40, 20, 6], max: [40, 80, 20] };

function checked(r: StlCheckResult): StlCheck {
  if (r.refused !== null) {
    throw new Error(`refused: ${r.refused}`);
  }
  return r;
}

describe('checkAgainstObject', () => {
  const boxMetric = metric({ object_mm: BOX_MM });
  const lMetric = metric({ object_mm: L_MM });
  const boxScan = scan(boxMetric, box);
  const lScan = scan(lMetric, lBlock);

  it('measures a box within 1 %', () => {
    const r = checked(checkAgainstObject(boxScan, scalingFor(boxMetric), boxMetric, 1));
    for (const a of [r.u, r.v, r.z]) {
      expect(Math.abs(a.error)).toBeLessThan(0.01);
      expect(a.ok).toBe(true);
    }
    expect(r.pass).toBe(true);
    expect(r.u.stl).toBe(80);
    expect(r.v.stl).toBe(60);
    expect(r.z.stl).toBe(15);
  });

  it('measures a stepped L within 1 %, its low arm too', () => {
    const r = checked(checkAgainstObject(lScan, scalingFor(lMetric), lMetric, 1));
    // Half of the 6 mm arm, not half of the 20 mm upright: the whole L is the object.
    expect(r.threshold).toBe(3);
    for (const a of [r.u, r.v, r.z]) {
      expect(Math.abs(a.error)).toBeLessThan(0.01);
    }
    expect(r.pass).toBe(true);
  });

  it('reads the top through noise as large as the C6’s', () => {
    // 1 sensor row is 1/3 mm here, about the base noise measured on the AT C6 (0.32 mm sd).
    const noisy = scan(boxMetric, box, 0, PROFILES, { ...CAM, noise: 1 });
    const r = checked(checkAgainstObject(noisy, scalingFor(boxMetric), boxMetric, 1));
    // The plain 99th percentile would read 2.3 σ high: about +0.77 mm, 5 %.
    expect(Math.abs(r.z.error)).toBeLessThan(0.01);
    expect(r.pass).toBe(true);
  });

  it('shows the L unmirrored through mirrorX', () => {
    const s = scalingFor(lMetric);
    // u grows with the column here, so the fit runs x the other way.
    expect(s.mirrorX).toBe(true);
    const r = checked(checkAgainstObject(lScan, s, lMetric, 1));
    const { centroid, columns, rows } = r.component;
    /** The centroid's offset from the box centre in the cloud's x and y. */
    const offset = (sc: CloudScaling) => {
      const p = toUnits(centroid[0], centroid[1], 0, sc, 1, COLUMNS);
      const mid = toUnits((columns[0] + columns[1]) / 2, (rows[0] + rows[1]) / 2, 0, sc, 1, COLUMNS);
      return [p[0] - mid[0], p[1] - mid[1]];
    };
    // In the model the L's mass lies toward its corner, at −u and −v: the product is positive.
    // A rotation keeps that sign, a mirror flips it.
    const [dx, dy] = offset(s);
    expect(dx * dy).toBeGreaterThan(0);
    const [mx, my] = offset({ ...s, mirrorX: false });
    expect(mx * my).toBeLessThan(0);
  });

  it('fails an axis that is off by more than the tolerance', () => {
    const s = scalingFor(boxMetric);
    const r = checked(checkAgainstObject(boxScan, { ...s, ySpacing: s.ySpacing * 1.05 }, boxMetric, 1));
    expect(r.v.ok).toBe(false);
    expect(r.v.error).toBeGreaterThan(STL_CHECK_TOLERANCE);
    expect(r.u.ok).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('counts the store stride along the travel', () => {
    const s = scalingFor(boxMetric);
    const thinned = new RowRing(ringLayout(COLUMNS, PROFILES / 2, 4096, 256), 'stacked', PROFILES / 2);
    for (let k = 0; k < PROFILES; k++) {
      thinned.writeStacked(k, 1, 2, renderRangeScan(CAM, boxMetric, box, k, DV));
    }
    const r = checked(checkAgainstObject(thinned, s, boxMetric, 2));
    expect(Math.abs(r.v.error)).toBeLessThan(0.02);
  });

  it('refuses an incomplete pass', () => {
    // The snapshot starts with the box already under the line.
    const cut = scan(boxMetric, box, 60, 100);
    expect(checkAgainstObject(cut, scalingFor(boxMetric), boxMetric, 1).refused).toMatch(/first or last profile/);
  });

  it('refuses an object that leaves the camera’s columns', () => {
    const wide = (u: number, v: number) => (inside(u, [40, 120]) && inside(v, BOX.v) ? BOX.h : 0);
    const m = metric({ object_mm: { min: [40, BOX.v[0], BOX.h], max: [120, BOX.v[1], BOX.h] } });
    expect(checkAgainstObject(scan(m, wide), scalingFor(m), m, 1).refused).toMatch(/columns/);
  });

  it('refuses bounce playback', () => {
    const m = metric({
      object_mm: BOX_MM,
      travel: { ...boxMetric.travel, end: 'bounce' },
      disturbances: ['bounce'],
    });
    expect(checkAgainstObject(boxScan, scalingFor(m), m, 1).refused).toMatch(/bounce/);
  });

  it('refuses without an object, without mm, and with nothing above the threshold', () => {
    const s = scalingFor(boxMetric);
    expect(checkAgainstObject(boxScan, s, metric(), 1).refused).toMatch(/no object/);
    expect(checkAgainstObject(boxScan, PIXEL_SCALING, boxMetric, 1).refused).toMatch(/not in mm/);
    expect(checkAgainstObject(scan(boxMetric, () => 0, 0, 20), s, boxMetric, 1).refused).toMatch(/nothing/);
  });
});

describe('proposeSnapshot', () => {
  // One pass is 200 rows × 0.5 mm = 100 mm, the box 60 mm: 160 mm at 10 mm/s, 16 s, + 20 %.
  const m = metric({ object_mm: BOX_MM });

  it('covers one pass and the object, with the margin', () => {
    const p = proposeSnapshot(m, 100, 10)!;
    expect(p.seconds).toBeCloseTo(19.2, 6);
    expect(p.frameRate).toBe(10);
    expect(p.needed).toBe(192);
    expect(p.frames).toBe(192);
    expect(p.fits).toBe(true);
    expect(p.hint).toBeNull();
  });

  it('caps the frames, with a hint', () => {
    const p = proposeSnapshot(m, 1000, 10)!;
    expect(p.needed).toBe(1920);
    expect(p.frames).toBe(MAX_FRAMES);
    expect(p.fits).toBe(false);
    expect(p.hint).toMatch(/1920 frames/);
  });

  it('needs an object, a travel speed and a rate', () => {
    expect(proposeSnapshot(metric(), 100, 10)).toBeNull();
    expect(proposeSnapshot(metric({ object_mm: BOX_MM, travel: { ...m.travel, mm_per_s: 0 } }), 100, 10)).toBeNull();
    expect(proposeSnapshot(m, null, 10)).toBeNull();
    expect(proposeSnapshot(undefined, 100, 10)).toBeNull();
  });
});
