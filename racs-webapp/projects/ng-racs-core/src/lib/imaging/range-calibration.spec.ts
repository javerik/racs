import type { BaseLine, MetricMapping, ViewPoint } from '../laserline/protocol';
import { applyHomography, type Mat3 } from './homography';
import {
  checkCoverage,
  linePattern,
  lineThrough,
  type LineCoverage,
  patternSegment,
  planCrossings,
  planParallel,
  type PlannedLine,
  profilesAgree,
  profilesDisagreement,
  type RangeObservation,
  reduceProfiles,
  seenColumns,
  solveRangeMap,
  type ViewLine,
} from './range-calibration';
import {
  rangeCameraG,
  rangeCameraMap,
  renderRangeFrame,
  renderRangeLine,
  renderRangeScan,
  type SyntheticRangeCamera,
} from 'ng-racs-core/testing';

const VIEW: ViewPoint = [1920, 1080];
const BASE: BaseLine = { center_px: [960, 540], dir: [1, 0], normal: [0, 1] };
/** A 40 px band across the base line, 1600 px along it. */
const BAND = { x: 160, y: 520, width: 1600, height: 40 };
const COLUMNS = 800;
const ROWS = 160;
const PARALLEL = [-16, -12, -8, -4, 0, 4, 8, 12, 16];
const ALONG = [-700, -350, 0, 350, 700];

function camera(opts: { angleDeg?: number; mirror?: boolean; perspective?: number } = {}, noise = 0): SyntheticRangeCamera {
  return { g: rangeCameraG(BAND, { width: COLUMNS, rows: ROWS }, opts), width: COLUMNS, rows: ROWS, viewPx: VIEW, noise, profiles: 16 };
}

function plan(angleDeg = 45): PlannedLine[] {
  return [...planParallel(BASE, PARALLEL, VIEW), ...planCrossings(BASE, ALONG, VIEW, angleDeg)];
}

/** What the camera reads for each planned line: per seen column, the median value. */
function observe(cam: SyntheticRangeCamera, lines: PlannedLine[], seed = 1): { obs: RangeObservation[]; coverage: LineCoverage[] } {
  const obs: RangeObservation[] = [];
  const coverage: LineCoverage[] = [];
  lines.forEach((planned, i) => {
    const reduced = reduceProfiles([renderRangeFrame(cam, planned.pattern, seed + i)], cam.width);
    const columns = seenColumns(reduced);
    columns.forEach((c) => obs.push({ c, r: reduced.median[c], line: planned.line }));
    coverage.push({ kind: planned.kind, sign: planned.sign, columns });
  });
  return { obs, coverage };
}

/** Largest distance (or its component along the base line) between two maps over the camera's domain. */
function mapError(cam: SyntheticRangeCamera, g: Mat3, along = false): number {
  const truth = rangeCameraMap(cam);
  const { scale = 16, offset = 100 } = cam;
  let max = 0;
  for (let c = 0; c < cam.width; c += 10) {
    for (let row = 0; row <= cam.rows - 1; row += 8) {
      const v = offset + row * scale;
      const a = applyHomography(g, { x: c, y: v });
      const b = applyHomography(truth, { x: c, y: v });
      const d = along ? Math.abs((a.x - b.x) * BASE.dir[0] + (a.y - b.y) * BASE.dir[1]) : Math.hypot(a.x - b.x, a.y - b.y);
      max = Math.max(max, d);
    }
  }
  return max;
}

function distance(l: ViewLine, p: { x: number; y: number }): number {
  return Math.abs(l[0] * p.x + l[1] * p.y + l[2]);
}

describe('patternSegment', () => {
  it('draws a line as long as the view along it, centred on the middle axis', () => {
    const flat = patternSegment({ kind: 'line', orientation: 'Horizontal', position_pct: 25 }, VIEW)!;
    expect(flat.a).toEqual({ x: 0, y: 270 });
    expect(flat.b).toEqual({ x: 1920, y: 270 });
    const tilted = patternSegment({ kind: 'line', orientation: 'Vertical', position_pct: 40, tilt_deg: 30 }, VIEW)!;
    const angle = (120 * Math.PI) / 180;
    const length = 1920 * Math.abs(Math.cos(angle)) + 1080 * Math.abs(Math.sin(angle));
    expect(Math.hypot(tilted.b.x - tilted.a.x, tilted.b.y - tilted.a.y)).toBeCloseTo(length, 6);
    expect((tilted.a.x + tilted.b.x) / 2).toBeCloseTo(768, 6);
    expect((tilted.a.y + tilted.b.y) / 2).toBeCloseTo(540, 6);
    expect(patternSegment({ kind: 'blank' }, VIEW)).toBeNull();
  });
});

describe('linePattern', () => {
  const cases: [string, ViewPoint, ViewPoint][] = [
    ['centred', [960, 540], [1, 0]],
    ['off-centre', [300, 200], [1, 0.2]],
    ['tilted', [1500, 900], [Math.cos(0.5), Math.sin(0.5)]],
    ['steep', [1600, 250], [0.1, 1]],
    ['vertical', [100, 1000], [0, -1]],
    ['45° at an end of the band', [1660, 560], [1, -1]],
    ['outside the view', [-200, 540], [1, 0.05]],
  ];
  for (const [name, point, dir] of cases) {
    it(`round trips a ${name} line through the drawn segment`, () => {
      const pattern = linePattern({ point, dir }, VIEW)!;
      expect(pattern).not.toBeNull();
      expect(pattern.tilt_deg!).toBeGreaterThanOrEqual(-90);
      expect(pattern.tilt_deg!).toBeLessThan(90);
      const seg = patternSegment(pattern, VIEW)!;
      const line = lineThrough(seg.a, seg.b);
      const p = { x: point[0], y: point[1] };
      expect(distance(line, p)).toBeLessThan(1e-6);
      // Parallel to `dir`, and covering the point.
      const len = Math.hypot(dir[0], dir[1]);
      expect(Math.abs(line[0] * dir[0] + line[1] * dir[1]) / len).toBeLessThan(1e-9);
      const ab = { x: seg.b.x - seg.a.x, y: seg.b.y - seg.a.y };
      const t = ((p.x - seg.a.x) * ab.x + (p.y - seg.a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    });
  }

  it('is null when the drawn segment does not reach the point', () => {
    expect(linePattern({ point: [5000, 540], dir: [1, 0] }, VIEW)).toBeNull();
    expect(linePattern({ point: [-3000, 300], dir: [1, 0.01] }, VIEW)).toBeNull();
    expect(linePattern({ point: [960, 540], dir: [0, 0] }, VIEW)).toBeNull();
  });

  it('plans parallel lines and ±45° crossing pairs on their lines', () => {
    const parallel = planParallel(BASE, [-10, 10], VIEW);
    expect(parallel.map((p) => p.line[2])).toEqual([-530, -550].map((c) => expect.closeTo(c, 9)));
    const crossing = planCrossings(BASE, [100], VIEW);
    expect(crossing.map((p) => p.sign)).toEqual([-1, 1]);
    for (const p of crossing) {
      expect(distance(p.line, { x: 1060, y: 540 })).toBeLessThan(1e-9);
      expect(Math.abs(p.pattern.tilt_deg!)).toBeCloseTo(45, 9);
    }
  });
});

describe('the synthetic range camera', () => {
  it('reads each line where the map puts it on that line', () => {
    const cam = camera({ perspective: 5e-5 });
    const g = rangeCameraMap(cam);
    for (const planned of plan()) {
      const profile = renderRangeLine(cam, planned.pattern);
      let seen = 0;
      profile.forEach((v, c) => {
        if (!v) return;
        seen++;
        expect(distance(planned.line, applyHomography(g, { x: c, y: v }))).toBeLessThan(0.02);
      });
      expect(seen).toBeGreaterThan(planned.kind === 'parallel' ? COLUMNS / 2 : 10);
    }
  });

  it('films a scanned object through the metric mapping', () => {
    const cam = camera();
    const metric: MetricMapping = {
      rev: 1,
      base: BASE,
      along_px_per_mm: 4,
      height_px_per_mm: -4,
      u0_mm: 0,
      dv_mm: 0.1,
      rows: 100,
      travel: { mode: 'per_second', rows_per_s: 10, mm_per_s: 1, approximate: false, playing: true, end: 'loop' },
      object_mm: { min: [-10, 0, 0], max: [10, 10, 2] },
      model_mirrored: false,
      disturbances: [],
    };
    const flat = renderRangeScan(cam, metric, () => 0, 3);
    const base = renderRangeLine(cam, linePattern({ point: BASE.center_px, dir: BASE.dir }, VIEW)!);
    flat.forEach((v, c) => expect(Math.abs(v - base[c])).toBeLessThanOrEqual(1));
    // A 2 mm box over |u| < 10 mm lifts the line by 8 view px: 32 rows of 16 values.
    const box = renderRangeScan(cam, metric, (u) => (Math.abs(u) < 10 ? 2 : 0), 3);
    const c = COLUMNS / 2;
    expect(box[c] - base[c]).toBeCloseTo(-512, -1);
    expect(box[50]).toBe(base[50]);
  });
});

describe('solveRangeMap', () => {
  const geometries: [string, { angleDeg?: number; mirror?: boolean; perspective?: number }][] = [
    ['projective', { perspective: 5e-5 }],
    ['mirrored', { mirror: true, perspective: 5e-5 }],
    ['rotated', { angleDeg: 180, perspective: -4e-5 }],
    ['slightly rolled', { angleDeg: 0.5, perspective: 3e-5 }],
  ];
  for (const [name, opts] of geometries) {
    it(`recovers a ${name} map within 0.05 px without noise`, () => {
      const cam = camera(opts);
      const { obs } = observe(cam, plan());
      const fit = solveRangeMap(obs)!;
      expect(fit).not.toBeNull();
      expect(fit.model).toBe('projective');
      expect(mapError(cam, fit.g)).toBeLessThan(0.05);
      expect(fit.rms).toBeLessThan(0.02);
    });

    it(`recovers a ${name} map within 0.3 px with noise`, () => {
      const cam = camera(opts, 0.5);
      const { obs } = observe(cam, plan());
      const fit = solveRangeMap(obs)!;
      expect(mapError(cam, fit.g)).toBeLessThan(0.3);
    });
  }

  it('trims a misread line', () => {
    const cam = camera({ perspective: 5e-5 });
    const lines = plan();
    const { obs } = observe(cam, lines);
    // Laserline drew one crossing line 3 px from where the calibration thinks.
    const wrong = lines.find((l) => l.kind === 'crossing')!.line;
    const misread: ViewLine = [wrong[0], wrong[1], wrong[2] + 3];
    const shifted = obs.map((o) => (o.line === wrong ? { ...o, line: misread } : o));
    const fit = solveRangeMap(shifted)!;
    const entry = fit.perLine.find((l) => l.line === misread)!;
    expect(entry.dropped).toBe(entry.n);
    expect(entry.rms).toBeGreaterThan(2.5);
    expect(mapError(cam, fit.g)).toBeLessThan(0.05);
  });

  it('trims a misread parallel line', () => {
    const cam = camera({ perspective: 5e-5 });
    const lines = plan();
    const { obs } = observe(cam, lines);
    const wrong = lines.find((l) => l.kind === 'parallel' && l.at === 8)!.line;
    const misread: ViewLine = [wrong[0], wrong[1], wrong[2] - 2];
    const fit = solveRangeMap(obs.map((o) => (o.line === wrong ? { ...o, line: misread } : o)))!;
    const entry = fit.perLine.find((l) => l.line === misread)!;
    expect(entry.dropped).toBeGreaterThan(0.9 * entry.n);
    expect(mapError(cam, fit.g)).toBeLessThan(0.1);
  });

  it('cannot solve a parallel-only set, which checkCoverage refuses', () => {
    const cam = camera({ perspective: 5e-5 });
    const parallel = observe(cam, planParallel(BASE, PARALLEL, VIEW));
    expect(solveRangeMap(parallel.obs)).toBeNull();
    const check = checkCoverage(parallel.coverage, COLUMNS);
    expect(check.ok).toBe(false);
    expect(check.parallel).toBe(PARALLEL.length);
    expect(check.reason).toContain('crossing');
  });

  it('hides a missing along direction from the residuals, so checkCoverage must refuse a single crossing line', () => {
    const lines = [...planParallel(BASE, PARALLEL, VIEW), planCrossings(BASE, [0], VIEW)[0]];
    for (const noise of [0, 0.5]) {
      // Quantisation and noise make the degenerate system look conditioned: a small rms, a wrong along direction.
      const cam = camera({ perspective: 5e-5 }, noise);
      const { obs, coverage } = observe(cam, lines);
      const fit = solveRangeMap(obs);
      if (fit) {
        expect(fit.rms).toBeLessThan(0.1);
        expect(mapError(cam, fit.g)).toBeGreaterThan(10);
      }
      expect(checkCoverage(coverage, COLUMNS).reason).toContain('crossing');
    }
  });

  it('leaves crossings bunched along the line to the span minimum', () => {
    const cam = camera({ perspective: 5e-5 }, 0.5);
    const { obs, coverage } = observe(cam, [...planParallel(BASE, PARALLEL, VIEW), ...planCrossings(BASE, [-100, -50, 0, 50, 100], VIEW)]);
    // Conditioned, so the solver answers, but the error grows away from the crossings.
    expect(mapError(cam, solveRangeMap(obs)!.g)).toBeGreaterThan(0.1);
    const check = checkCoverage(coverage, COLUMNS);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('span');
  });

  it('keeps the along error of a 40 px band under 0.1 px with 45° crossings, far worse with ±1° tilts', () => {
    const cam = camera({ perspective: 5e-5 }, 0.5);
    const crossing = solveRangeMap(observe(cam, plan(45)).obs)!;
    const tilted = solveRangeMap(observe(cam, plan(1)).obs);
    const crossingError = mapError(cam, crossing.g, true);
    const tiltedError = tilted ? mapError(cam, tilted.g, true) : Infinity;
    expect(crossingError).toBeLessThan(0.1);
    expect(tiltedError).toBeGreaterThan(5 * crossingError);
  });
});

describe('checkCoverage', () => {
  const full = (n: number) => Array.from({ length: n }, (_, i) => i);
  const parallel: LineCoverage[] = [0, 1, 2].map(() => ({ kind: 'parallel', sign: 0, columns: full(600) }));
  const crossing = (sign: number, from: number): LineCoverage => ({ kind: 'crossing', sign, columns: [from, from + 1, from + 2, from + 3] });

  it('accepts the minimums', () => {
    const check = checkCoverage([...parallel, crossing(-1, 0), crossing(1, 10), crossing(-1, 390), crossing(1, 396)], COLUMNS);
    expect(check).toEqual({ ok: true, reason: null, parallel: 3, crossing: { neg: 2, pos: 2 }, span: 0.5 });
  });

  it('counts only parallel lines seen in half the columns', () => {
    const check = checkCoverage([...parallel.slice(0, 2), { kind: 'parallel', sign: 0, columns: full(399) }], COLUMNS);
    expect(check.parallel).toBe(2);
    expect(check.reason).toContain('parallel');
  });

  it('needs crossing lines of both signs, spanning half the columns', () => {
    expect(checkCoverage([...parallel, crossing(1, 0), crossing(1, 10), crossing(1, 400), crossing(-1, 500)], COLUMNS).reason).toContain(
      '1 turned −, 3 turned +',
    );
    expect(checkCoverage([...parallel, crossing(-1, 0), crossing(1, 10), crossing(-1, 300), crossing(1, 310)], COLUMNS).reason).toContain(
      'span only 39 %',
    );
    // A line seen in fewer than 3 columns doesn't count.
    const short: LineCoverage = { kind: 'crossing', sign: 1, columns: [700, 701] };
    expect(checkCoverage([...parallel, crossing(-1, 0), crossing(1, 10), crossing(-1, 390), short], COLUMNS).crossing).toEqual({ neg: 2, pos: 1 });
  });
});

describe('reduceProfiles', () => {
  it('takes the median, MAD and valid share of the non-zero values per column', () => {
    const r = reduceProfiles([new Uint16Array([0, 10, 5, 0, 12, 0]), new Uint16Array([0, 11, 7]), new Uint16Array([0, 0, 6])], 3);
    expect(r.profiles).toBe(4);
    expect(r.median[0]).toBeNaN();
    expect(r.valid[0]).toBe(0);
    expect([r.median[1], r.mad[1], r.valid[1]]).toEqual([11, 1, 0.75]);
    expect([r.median[2], r.mad[2], r.valid[2]]).toEqual([6, 1, 0.75]);
    expect(seenColumns(r)).toEqual([1, 2]);
  });

  it('tells a frame that straddles a pattern switch by its halves', () => {
    const cam = camera({}, 0.5);
    const [a, b] = planParallel(BASE, [-8, 8], VIEW);
    const halves = (frame: Uint16Array) => {
      const half = (cam.profiles! / 2) * cam.width;
      return [reduceProfiles([frame.subarray(0, half)], cam.width), reduceProfiles([frame.subarray(half)], cam.width)] as const;
    };
    const tolerance = 3 * 0.5 * 16;
    expect(profilesAgree(...halves(renderRangeFrame(cam, a.pattern, 1)), tolerance)).toBe(true);
    expect(profilesAgree(...halves(renderRangeFrame(cam, a.pattern, 2, { pattern: b.pattern, after: 8 })), tolerance)).toBe(false);
    expect(profilesAgree(...halves(renderRangeFrame(cam, a.pattern, 3, { pattern: { kind: 'blank' }, after: 8 })), tolerance)).toBe(false);
    // Switching late in the frame leaves the first half alone, and the median of the second still
    // shows the old line.
    const late = halves(renderRangeFrame(cam, a.pattern, 4, { pattern: b.pattern, after: 13 }));
    expect(profilesAgree(...late, tolerance)).toBe(true);
    expect(profilesAgree(reduceProfiles([], cam.width), reduceProfiles([], cam.width), tolerance)).toBe(true);
  });

  it('takes a column flickering in one half for the same line, not a missing one', () => {
    // 10 columns, 8 profiles a half, every column reads 500 where it sees the line.
    const half = (seen: (column: number, profile: number) => boolean) => {
      const px = new Uint16Array(8 * 10);
      for (let p = 0; p < 8; p++) for (let c = 0; c < 10; c++) px[p * 10 + c] = seen(c, p) ? 500 : 0;
      return reduceProfiles([px], 10);
    };
    const steady = half(() => true);
    // Columns 0..4 see it in 3 of 8 profiles: a thin line near the peak threshold.
    expect(profilesAgree(steady, half((c, p) => c >= 5 || p % 3 === 0), 1)).toBe(true);
    // Columns 0..4 don't see it at all: another line.
    expect(profilesAgree(steady, half((c) => c >= 5), 1)).toBe(false);
  });

  it('goes by the shift of the whole line, not by noisy columns', () => {
    // As on the AT C6: 5 profiles a half, values in steps of 8, every fifth column's median a step
    // or two off in either half while the line stands still.
    const half = (shift: number, seed: number) => {
      const px = new Uint16Array(5 * 100);
      for (let p = 0; p < 5; p++) for (let c = 0; c < 100; c++) px[p * 100 + c] = 13248 + shift + ((c + seed) % 5 === 0 ? 8 * (1 + ((c >> 2) % 2)) : 0);
      return reduceProfiles([px], 100);
    };
    const tolerance = 12;
    expect(profilesDisagreement(half(0, 0), half(0, 2))).toEqual({ counted: 100, seenByOne: 0, shift: 0 });
    expect(profilesAgree(half(0, 0), half(0, 2), tolerance)).toBe(true);
    // The line moved by 20 values, everywhere: another line.
    expect(profilesAgree(half(0, 0), half(20, 2), tolerance)).toBe(false);
  });
});
