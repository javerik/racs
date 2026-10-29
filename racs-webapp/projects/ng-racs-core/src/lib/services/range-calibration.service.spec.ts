import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { rangeCameraG, rangeCameraMap, renderRangeLine, type SyntheticRangeCamera } from 'ng-racs-core/testing';
import { applyHomography } from '../imaging/homography';
import type { Envelope, MetricMapping, Pattern, RemoteStatus, ViewPoint } from '../laserline/protocol';
import type { FeatureState, GenICamNodeInfo } from '../models/racs.models';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceSelectionService } from './device-selection.service';
import { GenicamSession } from './genicam-session.service';
import { LaserlineLinkService } from './laserline-link.service';
import { reduceProfiles } from '../imaging/range-calibration';
import {
  patternHalvesAgree,
  RANGE_LINE_WIDTHS_PX,
  RangeCalibrationService,
  type RangeCalibration,
  type RangeFrame,
  type RangeFrameSource,
  type RangeGeometry,
} from './range-calibration.service';
import { ToolWindowService } from './tool-window.service';

const VIEW: ViewPoint = [1200, 800];
const MAC = '00:11:22:AA:BB:CC';
const KEY = 'racs.laserline.range.00:11:22:aa:bb:cc';
/** Profiles per frame. */
const PROFILES = 16;
/** The camera sees a 40 px band across the base line (view y 380..420), x 100..1100, on 400 columns. */
const FIELD = { x: 100, y: 380, width: 1000, height: 40 };
const CAM: SyntheticRangeCamera = {
  g: rangeCameraG(FIELD, { width: 400, rows: 120 }, { angleDeg: 0.5, perspective: 0.0002 }),
  width: 400,
  rows: 120,
  viewPx: VIEW,
  noise: 0.3,
};

function envelope(x0: number, y0: number, x1: number, y1: number): Envelope {
  return {
    corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    center_px: [(x0 + x1) / 2, (y0 + y1) / 2],
    dir: [1, 0],
    normal: [0, 1],
    along_px: [-(x1 - x0) / 2, (x1 - x0) / 2],
    across_px: [-(y1 - y0) / 2, (y1 - y0) / 2],
  };
}

function metric(center: ViewPoint = [600, 400]): MetricMapping {
  return {
    rev: 1,
    base: { center_px: center, dir: [1, 0], normal: [0, 1] },
    along_px_per_mm: 10,
    height_px_per_mm: -8,
    u0_mm: 0,
    dv_mm: 0.1,
    rows: 200,
    travel: { mode: 'per_second', rows_per_s: 100, mm_per_s: 10, approximate: false, playing: true, end: 'loop' },
    object_mm: null,
    model_mirrored: false,
    disturbances: [],
  };
}

function state(name: string, value: number | string, nodeType: FeatureState['node_type'] = 'Integer'): FeatureState {
  return {
    name,
    node_type: nodeType,
    value: String(value),
    available: true,
    locked: false,
    min: null,
    max: null,
    inc: null,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
  };
}

function node(name: string, node_type: GenICamNodeInfo['node_type'], extra: Partial<GenICamNodeInfo> = {}): [string, GenICamNodeInfo] {
  return [name, { name, display_name: name, node_type, visibility: 'Beginner', access_mode: 'ReadWrite', enums: null, ...extra }];
}

/** laserline: shows patterns, reports its view, the user's envelope and the metric mapping. */
class FakeLink {
  readonly supported = true;
  readonly host = signal<string | null>('ll');
  readonly status = signal<RemoteStatus | null>({ viewPx: VIEW, envelope: envelope(300, 390, 900, 410), session: null, field: null, metric: metric() });
  readonly metric = computed(() => this.status()?.metric);
  shown = 0;
  ended: string[] = [];
  onShow?: () => void;
  /** Profiles after its frame that the next pattern shows up late (it lands mid-frame). */
  delay = 0;
  connect = vi.fn(async () => 'll');
  hello = vi.fn(async () => 'll');
  drawnView = vi.fn(async () => this.status()!.viewPx);
  begin = vi.fn(async (_session: string) => undefined);
  touch = vi.fn();
  /** The real one, on this fake's `begin`/`touch`/`end`. */
  runSession = LaserlineLinkService.prototype.runSession;
  /** Each pattern with the captured index when it went on screen. */
  history: { pattern: Pattern; frame: number; delay: number }[] = [{ pattern: { kind: 'blank' }, frame: 0, delay: 0 }];
  frameCount = 0;
  async show(_session: string, _id: number, pattern: Pattern) {
    this.shown++;
    this.onShow?.();
    this.history.push({ pattern, frame: this.frameCount, delay: this.delay });
    this.delay = 0;
    return { at: performance.now(), viewPx: this.status()!.viewPx };
  }
  end(session: string) {
    this.ended.push(session);
  }
}

class FakeRegistry {
  readonly connected = signal<{ id: number; mac: string }[]>([{ id: 3, mac: MAC }]);
  find(id: number) {
    return this.connected().find((d) => d.id === id);
  }
}

/** The camera's features, as the 3D tab's session reads them. */
class FakeSession {
  readonly states = signal<Partial<Record<string, FeatureState>>>({
    DeviceScanType: state('DeviceScanType', 1, 'Enum'),
    PixelFormat: state('PixelFormat', 0x011000b8, 'Enum'),
    Width: state('Width', 400),
    OffsetX: state('OffsetX', 0),
    RegionSelector: state('RegionSelector', 1, 'Enum'),
    OffsetY: state('OffsetY', 300),
    Height: state('Height', 120),
    Scan3dCoordinateSelector: state('Scan3dCoordinateSelector', 2, 'Enum'),
    Scan3dCoordinateScale: state('Scan3dCoordinateScale', '0.0625', 'Float'),
  });
  readonly nodes = signal(
    new Map([
      node('DeviceScanType', 'Enum', {
        enums: [
          { display_name: 'Areascan', string_value: 'Areascan', value: 0 },
          { display_name: 'Linescan3D', string_value: 'Linescan3D', value: 1 },
        ],
      }),
      node('PixelFormat', 'Enum'),
      node('Width', 'Integer'),
      node('OffsetX', 'Integer'),
      node('RegionSelector', 'Enum', { selected: ['Width', 'Height', 'OffsetX', 'OffsetY'] }),
      node('OffsetY', 'Integer'),
      node('Height', 'Integer'),
      node('Scan3dCoordinateSelector', 'Enum', { selected: ['Scan3dCoordinateScale'] }),
      node('Scan3dCoordinateScale', 'Float'),
      node('Scan3dCoordinateReset', 'Command'),
      node('ExposureTime', 'Float'),
    ]),
  );
  watch = vi.fn();
  unwatch = vi.fn();
  value(name: string): string | undefined {
    return this.states()[name]?.value ?? undefined;
  }
  set(name: string, value: number | string) {
    this.states.update((s) => ({ ...s, [name]: { ...s[name]!, value: String(value) } }));
  }
}

/**
 * `cam` films laserline with a stream `lag` frames behind: profile i of frame k shows the pattern
 * that went on screen at frame k − lag (later by its `delay` in profiles).
 */
function setup(cam: SyntheticRangeCamera = CAM, lag = 3, options: { registry?: FakeRegistry; flicker?: boolean; bestWidthPx?: number } = {}) {
  const link = new FakeLink();
  const session = new FakeSession();
  TestBed.configureTestingModule({
    providers: [
      RangeCalibrationService,
      { provide: LaserlineLinkService, useValue: link },
      { provide: GenicamSession, useValue: session },
      { provide: ToolWindowService, useValue: { open: vi.fn(() => true) } },
      { provide: DeviceRegistryService, useValue: options.registry ?? new FakeRegistry() },
    ],
  });
  TestBed.inject(DeviceSelectionService).setSelectedDeviceId(3);
  const calib = TestBed.inject(RangeCalibrationService);
  TestBed.tick();

  const live = signal(true);
  const geometry = signal<RangeGeometry | null>({ width: cam.width, height: PROFILES, bitDepth: 16, pixelFormat: 'Coord3D_C16' });
  let seed = 0;
  const source: RangeFrameSource = {
    live,
    geometry,
    frames: async (count, _after, opts) => {
      const out: RangeFrame[] = [];
      while (out.length < count) {
        const k = ++link.frameCount;
        const pixels = new Uint16Array(PROFILES * cam.width);
        for (let i = 0; i < PROFILES; i++) {
          const p = k * PROFILES + i;
          const shown = [...link.history].reverse().find((h) => (h.frame + lag) * PROFILES + h.delay <= p);
          // `flicker`: the second half of every frame misses the line (a display's PWM, say).
          const pattern = options.flicker && i >= PROFILES / 2 ? { kind: 'blank' as const } : (shown?.pattern ?? { kind: 'blank' as const });
          const profile = renderRangeLine(cam, pattern, ++seed);
          // `bestWidthPx`: a line drawn in any other width is lost in 4 of 5 columns (a peak finder
          // that goes by slopes, on a flat top).
          if (options.bestWidthPx !== undefined && pattern.kind === 'line' && Math.abs(widthPx(pattern) - options.bestWidthPx) > 0.01) {
            profile.forEach((_, c) => c % 5 && (profile[c] = 0));
          }
          pixels.set(profile, i * cam.width);
        }
        const frame: RangeFrame = { pixels, width: cam.width, height: PROFILES, at: performance.now() + k, number: k };
        if (opts?.accept && !opts.accept(frame)) {
          throw new Error('no frames from the camera in time');
        }
        out.push(frame);
      }
      return out;
    },
    latestNumber: () => link.frameCount,
  };
  calib.attach(source);
  return { calib, link, session, live, geometry };
}

/** The width (view px) laserline draws a line pattern in; 4, its calibration width, without `width_pct`. */
function widthPx(pattern: Extract<Pattern, { kind: 'line' }>): number {
  return pattern.width_pct === undefined ? 4 : (pattern.width_pct / 100) * VIEW[pattern.orientation === 'Horizontal' ? 1 : 0];
}

/** The largest distance between `g` and the camera's true map over the calibrated domain, view px. */
function mapError(cal: RangeCalibration, cam: SyntheticRangeCamera = CAM): number {
  const truth = rangeCameraMap(cam);
  let max = 0;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const p = { x: cal.columns[0] + (i / 10) * (cal.columns[1] - cal.columns[0]), y: cal.values[0] + (j / 10) * (cal.values[1] - cal.values[0]) };
      const a = applyHomography(cal.g, p);
      const b = applyHomography(truth, p);
      max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return max;
}

/** A calibration as `calibrate` keeps it, measured with the fake session's states. */
function kept(camera: Record<string, string> = { RegionSelector: '1', OffsetY: '300', Height: '120', Width: '400', Scan3dCoordinateSelector: '2', Scan3dCoordinateScale: '0.0625' }): RangeCalibration {
  return {
    v: 1,
    g: rangeCameraMap(CAM),
    model: 'projective',
    viewPx: VIEW,
    camera,
    rms: 0.02,
    max: 0.1,
    lines: [],
    columns: [0, 399],
    values: [100, 2000],
    band: [-20, 15],
    base: metric().base,
    at: 1,
  };
}

/** The test environment has no localStorage of its own. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('patternHalvesAgree', () => {
  /** 100 columns, 8 profiles; `seen(c, p)` sees the line there at value 500 + `jitter(c, p)`. */
  const half = (seen: (c: number, p: number) => boolean, jitter: (c: number, p: number) => number = () => 0) => {
    const px = new Uint16Array(8 * 100);
    for (let p = 0; p < 8; p++) for (let c = 0; c < 100; c++) px[p * 100 + c] = seen(c, p) ? 500 + jitter(c, p) : 0;
    return reduceProfiles([px], 100);
  };

  it('takes a parallel line both halves barely see for lost, whatever its few columns do', () => {
    // 10 noisy columns at the band's edge, different in each half.
    const a = half((c) => c < 10, (c) => c * 3);
    const b = half((c) => c >= 5 && c < 15, (c) => -c * 3);
    expect(patternHalvesAgree('parallel', a, b, 100)).toBe(true);
    // A crossing line lights few columns by design: the same halves disagree.
    expect(patternHalvesAgree('crossing', a, b, 100)).toBe(false);
  });

  it('takes its tolerance from the columns that see the line, not from stray values', () => {
    // 20 columns see a crossing line, with noise of ±3 values (MAD 2) and halves 5 values apart;
    // the other 80 columns have one stray value each (MAD 0).
    const noisy = (shift: number) => {
      const px = new Uint16Array(8 * 100);
      for (let p = 0; p < 8; p++) {
        for (let c = 0; c < 100; c++) {
          if (c < 20) px[p * 100 + c] = 500 + shift + [-3, -2, -1, 0, 0, 1, 2, 3][p];
          else if (p === 0) px[p * 100 + c] = 1000 + c;
        }
      }
      return reduceProfiles([px], 100);
    };
    expect(patternHalvesAgree('crossing', noisy(0), noisy(5), 100)).toBe(true);
    // 20 values apart: another line.
    expect(patternHalvesAgree('crossing', noisy(0), noisy(20), 100)).toBe(false);
  });

  it('still tells a seen parallel line from a lost one', () => {
    expect(patternHalvesAgree('parallel', half(() => true), half((c) => c < 10), 100)).toBe(false);
  });
});

describe('RangeCalibrationService', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('measures the camera’s map within 0.1 px and keeps it by MAC', async () => {
    const { calib, link, session } = setup();
    expect(calib.blocked()).toBeNull();
    await calib.calibrate();
    expect(calib.error()).toBeNull();
    expect(calib.phase()).toBe('done');
    const cal = calib.result()!;
    expect(mapError(cal)).toBeLessThan(0.1);
    expect(cal.model).toBe('projective');
    expect(cal.rms).toBeLessThan(0.2);
    // The band is 40 px across the base line (±20 px; the camera is turned a little): 0, ±2, ±4,
    // ±8, ±16, lost at ±32, then bisected.
    expect(cal.band[0]).toBeGreaterThanOrEqual(-22);
    expect(cal.band[0]).toBeLessThanOrEqual(-18);
    expect(cal.band[1]).toBeGreaterThanOrEqual(18);
    expect(cal.band[1]).toBeLessThanOrEqual(22);
    expect(cal.lines.filter((l) => l.kind === 'parallel' && l.columns > 200).length).toBeGreaterThanOrEqual(9);
    expect(cal.lines.filter((l) => l.kind === 'crossing').length).toBe(14);
    expect(cal.columns[1] - cal.columns[0]).toBeGreaterThan(300);
    expect(calib.warnings()).toEqual([]);
    // The snapshot of the features, selectors included, without commands or unrelated ones.
    expect(cal.camera).toEqual({
      DeviceScanType: '1',
      PixelFormat: String(0x011000b8),
      Width: '400',
      OffsetX: '0',
      RegionSelector: '1',
      OffsetY: '300',
      Height: '120',
      Scan3dCoordinateSelector: '2',
      Scan3dCoordinateScale: '0.0625',
    });
    expect(session.watch).toHaveBeenCalledWith('range-calibration', expect.arrayContaining(['OffsetY', 'Scan3dCoordinateScale']));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(JSON.parse(JSON.stringify(cal)));
    // One laserline session, ended.
    expect(link.begin).toHaveBeenCalledTimes(1);
    expect(link.ended).toEqual([link.begin.mock.calls[0][0]]);
    expect(calib.report()!.residuals.length).toBe(CAM.width);
    expect(calib.stale()).toBe(false);
  }, 30_000);

  it('measures the lag in captured frames', async () => {
    const { calib } = setup(CAM, 3);
    await calib.calibrate();
    expect(calib.report()!.lag).toBe(3);
    expect(calib.report()!.straddled).toBe(0);
  }, 30_000);

  it('drops a frame straddling a pattern switch', async () => {
    const { calib, link } = setup(CAM, 2);
    // The first band line (after the blank, the base line and its widths) lands half a frame late:
    // the first frame counted for it shows two lines.
    link.onShow = () => {
      if (link.shown === 3 + RANGE_LINE_WIDTHS_PX.length) link.delay = PROFILES + PROFILES / 2;
    };
    await calib.calibrate();
    expect(calib.error()).toBeNull();
    expect(calib.report()!.straddled).toBe(1);
    expect(mapError(calib.result()!)).toBeLessThan(0.1);
  }, 30_000);

  it('draws every line in the width the camera sees best', async () => {
    const { calib, link } = setup(CAM, 3, { bestWidthPx: 3 });
    await calib.calibrate();
    expect(calib.error()).toBeNull();
    const cal = calib.result()!;
    expect(cal.lineWidthPx).toBe(3);
    expect(mapError(cal)).toBeLessThan(0.1);
    // The lag with laserline's width, then the base line in each width, then the rest in 3 px.
    const lines = link.history.flatMap((h) => (h.pattern.kind === 'line' ? [h.pattern] : []));
    expect(lines.slice(1, 1 + RANGE_LINE_WIDTHS_PX.length).map((p) => widthPx(p))).toEqual(RANGE_LINE_WIDTHS_PX.map((w) => expect.closeTo(w, 9)));
    lines.slice(1 + RANGE_LINE_WIDTHS_PX.length).forEach((p) => expect(widthPx(p)).toBeCloseTo(3, 9));
  }, 30_000);

  it('warns when the camera’s band is narrower than the envelope', async () => {
    const { calib, link } = setup();
    link.status.update((s) => ({ ...s!, envelope: envelope(300, 360, 900, 440) }));
    await calib.calibrate();
    expect(calib.phase()).toBe('done');
    expect(calib.warnings()).toEqual([expect.stringMatching(/less than its envelope \(−40…\+40 px\)/)]);
  }, 30_000);

  it('refuses a camera that does not see the line, and says why', async () => {
    const blind = { ...CAM, g: rangeCameraG({ ...FIELD, y: 600 }, { width: 400, rows: 120 }) };
    const { calib, link } = setup(blind);
    await calib.calibrate();
    expect(calib.phase()).toBe('failed');
    expect(calib.error()).toMatch(/does not see the line/);
    expect(calib.result()).toBeNull();
    expect(link.ended.length).toBe(1);
  });

  it('says why a pattern does not settle', async () => {
    const { calib } = setup(CAM, 3, { flicker: true });
    await calib.calibrate();
    expect(calib.phase()).toBe('failed');
    expect(calib.error()).toMatch(/does not settle \(base line · 8 px wide: \d+ frames, \d+ with halves that disagree; last: of \d+ columns seeing a line, \d+ seen in one half only/);
  });

  it('can be cancelled, which ends the laserline session', async () => {
    const { calib, link } = setup();
    link.onShow = () => link.shown === 4 && calib.cancel();
    await calib.calibrate();
    expect(calib.phase()).toBe('failed');
    expect(calib.error()).toBe('cancelled');
    expect(link.ended).toEqual([link.begin.mock.calls[0][0]]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('stops when laserline’s line moves', async () => {
    const { calib, link } = setup();
    link.onShow = () => link.shown === 5 && link.status.update((s) => ({ ...s!, metric: metric([600, 420]) }));
    await calib.calibrate();
    expect(calib.error()).toMatch(/line moved/);
    expect(link.ended.length).toBe(1);
  });

  it('refuses an 8-bit stream and an area scan, and takes any 16-bit range format', () => {
    const { calib, geometry, session } = setup();
    geometry.set({ width: 400, height: PROFILES, bitDepth: 8, pixelFormat: 'Mono8' });
    expect(calib.blocked()).toMatch(/runs at 8 bit/);
    // The AT C6 in Linescan3D streams its range as Mono16 too.
    geometry.set({ width: 400, height: PROFILES, bitDepth: 16, pixelFormat: 'Mono16' });
    expect(calib.blocked()).toBeNull();
    geometry.set({ width: 400, height: PROFILES, bitDepth: 16, pixelFormat: 'Coord3D_C16' });
    session.set('DeviceScanType', 0);
    expect(calib.blocked()).toMatch(/Linescan3D/);
    void calib.calibrate();
    expect(calib.phase()).toBe('idle');
  });

  it('needs a running stream, a known device and a laserline with a scan', () => {
    const registry = new FakeRegistry();
    const { calib, live, link } = setup(CAM, 3, { registry });
    live.set(false);
    expect(calib.blocked()).toMatch(/live stream/);
    live.set(true);
    registry.connected.set([]);
    expect(calib.blocked()).toBe('reading device…');
    registry.connected.set([{ id: 3, mac: MAC }]);
    link.status.update((s) => ({ ...s!, metric: null }));
    expect(calib.blocked()).toMatch(/load a scan/);
    link.status.update((s) => ({ ...s!, metric: undefined }));
    expect(calib.blocked()).toMatch(/update it/);
    // Without a laserline window, the click opens one.
    link.status.set(null);
    expect(calib.blocked()).toBeNull();
  });

  describe('stale', () => {
    beforeEach(() => localStorage.setItem(KEY, JSON.stringify(kept())));

    it('loads the kept calibration, valid as measured', () => {
      const { calib } = setup();
      expect(calib.result()).toEqual(kept());
      expect(calib.stale()).toBe(false);
    });

    it('after a laserline view resize', () => {
      const { calib, link } = setup();
      link.status.update((s) => ({ ...s!, viewPx: [1201, 800] }));
      expect(calib.staleReason()).toMatch(/view changed size/);
      // Laserline closed: unknown, not stale.
      link.status.set(null);
      expect(calib.stale()).toBe(false);
    });

    it('after an OffsetY change, but not under another region', () => {
      const { calib, session } = setup();
      session.set('OffsetY', 310);
      expect(calib.staleReason()).toBe('OffsetY changed (300 → 310)');
      // Another region selected: its offset reads differently, which says nothing about ours.
      session.set('RegionSelector', 0);
      expect(calib.stale()).toBe(false);
      session.set('RegionSelector', 1);
      session.set('OffsetY', 300);
      session.set('Scan3dCoordinateSelector', 0);
      session.set('Scan3dCoordinateScale', '0.001');
      expect(calib.stale()).toBe(false);
    });

    it('verifies against the same camera, and keeps the result', async () => {
      const { calib, link } = setup();
      await calib.verify();
      expect(calib.error()).toBeNull();
      expect(calib.phase()).toBe('done');
      expect(calib.task()).toBe('verify');
      const v = calib.result()!.verify!;
      expect(v.ok).toBe(true);
      expect(v.seen).toBe(5);
      expect(v.shown).toBe(5);
      expect(v.limit).toBe(0.1);
      expect(v.rms).toBeLessThan(0.1);
      expect(calib.stale()).toBe(false);
      expect(JSON.parse(localStorage.getItem(KEY)!).verify).toEqual(v);
      expect(link.ended).toHaveLength(1);
    });

    it('marks it stale when the camera has moved', async () => {
      // The camera now looks 3 px further down the view.
      const moved: SyntheticRangeCamera = { ...CAM, g: rangeCameraG({ ...FIELD, y: FIELD.y + 3 }, { width: 400, rows: 120 }, { angleDeg: 0.5, perspective: 0.0002 }) };
      const { calib } = setup(moved);
      await calib.verify();
      const v = calib.result()!.verify!;
      expect(v.ok).toBe(false);
      expect(v.rms).toBeGreaterThan(2);
      expect(calib.staleReason()).toMatch(/check lines are .* px off/);
      // Kept: a reload still knows.
      expect(JSON.parse(localStorage.getItem(KEY)!).verify.ok).toBe(false);
    });

    it('needs a calibration to verify', async () => {
      localStorage.removeItem(KEY);
      const { calib, link } = setup();
      await calib.verify();
      expect(calib.phase()).toBe('idle');
      expect(link.shown).toBe(0);
    });

    it('is forgotten on request', () => {
      const { calib } = setup();
      calib.forget();
      expect(calib.result()).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });

  it('stores nothing before the device is known', async () => {
    const registry = new FakeRegistry();
    registry.connected.set([]);
    localStorage.setItem(KEY, JSON.stringify(kept()));
    const { calib } = setup(CAM, 3, { registry });
    expect(calib.result()).toBeNull();
    await calib.calibrate();
    expect(calib.phase()).toBe('idle');
    registry.connected.set([{ id: 3, mac: MAC }]);
    TestBed.tick();
    expect(calib.result()).toEqual(kept());
  });
});
