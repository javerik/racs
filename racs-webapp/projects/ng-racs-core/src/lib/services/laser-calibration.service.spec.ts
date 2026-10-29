import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { GrayFrame } from '../imaging/frame';
import type { Region } from '../imaging/region';
import { cameraHomography, renderPattern, renderSegment, type SyntheticCamera } from 'ng-racs-core/testing';
import type { Envelope, Pattern, RemoteStatus, ViewPoint } from '../laserline/protocol';
import type { FeatureState } from '../models/racs.models';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceSelectionService } from './device-selection.service';
import { GenicamSession } from './genicam-session.service';
import { LaserCalibrationService, type FrameSource, type TimedFrame } from './laser-calibration.service';
import { LaserlineLinkService } from './laserline-link.service';
import { RacsService } from './racs.service';
import { ToolWindowService } from './tool-window.service';

const VIEW: ViewPoint = [1200, 800];
const SENSOR = { width: 320, height: 240 };
/** The camera sees view 200..1000 × 100..700: 2.5 view px per sensor px. */
const CAM: SyntheticCamera = { h: cameraHomography({ x: 200, y: 100, width: 800, height: 600 }, SENSOR, 0, false, 0.00001), sensor: SENSOR, viewPx: VIEW };
/** The usual case: a camera seeing a small part of the display (view 560..680 × 380..470, 1/80 of it), turned a little. */
const SMALL: SyntheticCamera = { h: cameraHomography({ x: 560, y: 380, width: 120, height: 90 }, SENSOR, 4, false, 0.00002), sensor: SENSOR, viewPx: VIEW, lineWidth: 4 };
const SAVED: Region = { x: 40, y: 60, width: 128, height: 64 };
const MAC = '00:11:22:AA:BB:CC';
const KEY = 'racs.laserline.calib.00:11:22:aa:bb:cc';
const TILT_KEY = 'racs.laserline.tilt.00:11:22:aa:bb:cc';

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

function state(name: string, value: number, extra: Partial<FeatureState> = {}): FeatureState {
  return {
    name,
    node_type: 'Integer',
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
    ...extra,
  };
}

/** `frame` plus sensor-like noise (sigma about 2) of its own. */
function withNoise(frame: GrayFrame, seed: number): GrayFrame {
  let s = (seed * 2654435761) >>> 0 || 1;
  const pixels = new Uint8Array(frame.pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Sum of two uniforms in ±3.5: roughly normal, sigma 2.
    const n = (((s >>> 0) & 0xffff) / 0xffff + ((s >>> 16) & 0xffff) / 0xffff - 1) * 3.5;
    pixels[i] = Math.max(0, Math.min(255, Math.round(frame.pixels[i] + n)));
  }
  return { ...frame, pixels };
}

/** laserline: shows patterns, reports its view and the user's envelope. */
class FakeLink {
  readonly supported = true;
  readonly host = signal<string | null>('ll');
  readonly status = signal<RemoteStatus | null>({ viewPx: VIEW, envelope: envelope(400, 380, 800, 420), session: null, field: null });
  pattern: Pattern = { kind: 'blank' };
  shown = 0;
  ended: string[] = [];
  fields: (ViewPoint[] | null)[] = [];
  failShowAt = -1;
  userLine: { a: { x: number; y: number }; b: { x: number; y: number } } | null = { a: { x: 400, y: 400 }, b: { x: 800, y: 400 } };
  onShow?: () => void;
  connect = vi.fn(async () => 'll');
  hello = vi.fn(async () => 'll');
  drawnView = vi.fn(async () => this.status()!.viewPx);
  begin = vi.fn(async () => undefined);
  touch = vi.fn();
  /** The real one, on this fake's `begin`/`touch`/`end`. */
  runSession = LaserlineLinkService.prototype.runSession;
  /** Each pattern with the camera frame count when it went on screen. */
  history: { pattern: Pattern; frame: number }[] = [{ pattern: { kind: 'blank' }, frame: 0 }];
  frameCount = 0;
  async show(_session: string, _id: number, pattern: Pattern) {
    if (++this.shown === this.failShowAt) {
      throw new Error('the laserline view does not draw: keep its window visible (not minimised or covered)');
    }
    this.pattern = pattern;
    this.history.push({ pattern, frame: this.frameCount });
    this.onShow?.();
    return { at: performance.now(), viewPx: VIEW };
  }
  end(session: string) {
    this.ended.push(session);
  }
  setField(polygon: ViewPoint[] | null) {
    this.fields.push(polygon);
  }
  fitToField = vi.fn(async () => true);
  /** Laserline sets the user's tilt and reports it in its status. */
  setTilt = vi.fn(async (deg: number) => {
    this.status.update((s) => ({ ...s!, tilt_deg: deg }));
    return deg;
  });
  /** Laserline keeps the line in the polygon it was sent and reports it in its status. */
  constrain = vi.fn(async (polygon: ViewPoint[] | null) => {
    this.status.update((s) => ({ ...s!, constraint: polygon }));
    return polygon ? ['amplitude'] : [];
  });
}

/** The server's connected list: device 3 is the camera with `MAC`. */
class FakeRegistry {
  readonly connected = signal<{ id: number; mac: string }[]>([{ id: 3, mac: MAC }]);
  find(id: number) {
    return this.connected().find((d) => d.id === id);
  }
}

/** The camera's region features, written through `change` like the real session. */
class FakeSession {
  readonly states = signal<Partial<Record<string, FeatureState>>>({
    Width: state('Width', SAVED.width, { min: 16, inc: 4 }),
    Height: state('Height', SAVED.height, { min: 8, inc: 2 }),
    OffsetX: state('OffsetX', SAVED.x, { inc: 4 }),
    OffsetY: state('OffsetY', SAVED.y, { inc: 2 }),
    WidthMax: state('WidthMax', SENSOR.width),
    HeightMax: state('HeightMax', SENSOR.height),
  });
  readonly writes: string[] = [];
  readonly scanType = signal('0');
  value(name: string): string | undefined {
    return name === 'DeviceScanType' ? this.scanType() : (this.states()[name]?.value ?? undefined);
  }
  readonly nodes = signal(
    new Map([
      [
        'DeviceScanType',
        {
          enums: [
            { display_name: 'Areascan', string_value: 'Areascan', value: 0 },
            { display_name: 'Linescan3D', string_value: 'Linescan3D', value: 1 },
          ],
        },
      ],
    ]),
  );
  /** Set by `setup`: runs the request (which names the value) and stores it. */
  change!: (name: string, request: (id: number) => unknown) => Promise<void>;
}

/**
 * `cam` films laserline with a stream `lag` frames behind: frame k shows the pattern that was on
 * screen at frame k - lag (and, outside a session, the user's line), cropped to the region.
 */
function setup(cam: SyntheticCamera = CAM, lag = 3, options: { registry?: FakeRegistry; scanType?: string } = {}) {
  const link = new FakeLink();
  const session = new FakeSession();
  const registry = options.registry ?? new FakeRegistry();
  if (options.scanType !== undefined) {
    session.scanType.set(options.scanType);
  }
  let written = '';
  const racs = {
    setFeatureValue: vi.fn((_id: number, _name: string, value: string) => {
      written = value;
      return of(undefined);
    }),
  };
  session.change = async (name, request) => {
    request(0);
    session.writes.push(name);
    session.states.update((s) => ({ ...s, [name]: { ...s[name]!, value: written } }));
  };
  TestBed.configureTestingModule({
    providers: [
      LaserCalibrationService,
      { provide: LaserlineLinkService, useValue: link },
      { provide: GenicamSession, useValue: session },
      { provide: RacsService, useValue: racs },
      { provide: ToolWindowService, useValue: { open: vi.fn(() => true) } },
      { provide: DeviceRegistryService, useValue: registry },
    ],
  });
  TestBed.inject(DeviceSelectionService).setSelectedDeviceId(3);
  const calib = TestBed.inject(LaserCalibrationService);
  TestBed.tick();

  const live = signal(true);
  const proposed: Region[] = [];
  let seed = 0;
  const region = () => {
    const s = session.states();
    return { x: +s['OffsetX']!.value!, y: +s['OffsetY']!.value!, width: +s['Width']!.value!, height: +s['Height']!.value! };
  };
  const cache = new Map<string, GrayFrame>();
  const source: FrameSource = {
    live,
    regionBlocked: signal(null),
    frames: async (count, _after, options) => {
      const out: TimedFrame[] = [];
      while (out.length < count) {
        const k = ++link.frameCount;
        const r = region();
        const full = r.width === SENSOR.width && r.height === SENSOR.height;
        const pattern = [...link.history].reverse().find((h) => h.frame <= k - lag)?.pattern ?? { kind: 'blank' };
        const key = full ? JSON.stringify(pattern) : `user ${JSON.stringify(link.userLine)} ${JSON.stringify(r)}`;
        // Rendered once without noise; every frame gets noise of its own, as from a camera.
        let clean = cache.get(key);
        if (!clean) {
          const quiet = { ...cam, noise: 0 };
          clean = full ? renderPattern(quiet, pattern) : renderSegment(quiet, link.userLine, r);
          cache.set(key, clean);
        }
        const frame = withNoise(clean, ++seed);
        if (options?.accept && !options.accept(frame)) {
          throw new Error('no frames from the camera in time');
        }
        out.push({ frame, at: performance.now() + k, number: k });
      }
      return out;
    },
    propose: (r) => proposed.push(r),
    latestNumber: () => link.frameCount,
  };
  calib.attach(source);
  return { calib, link, session, racs, proposed, region, live, registry };
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

describe('LaserCalibrationService', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('calibrates, puts the region back and proposes the region holding the line', async () => {
    const { calib, link, session, proposed, region } = setup();
    expect(calib.blocked()).toBeNull();
    await calib.calibrate();
    expect(calib.error()).toBeNull();
    expect(calib.phase()).toBe('done');
    const cal = calib.calibration()!;
    expect(cal.rms).toBeLessThan(0.5);
    expect(cal.pairs).toBeGreaterThanOrEqual(25);
    expect(calib.points().length).toBeGreaterThan(0);
    expect(calib.points().length).toBeLessThanOrEqual(400);
    // Full sensor for the grid, then back to what it was.
    expect(session.writes.length).toBeGreaterThanOrEqual(8);
    expect(region()).toEqual(SAVED);
    expect(link.ended.length).toBe(1);
    // The camera field went to laserline: about the 800×600 the camera sees.
    const field = link.fields.at(-1)!;
    expect(Math.min(...field.map((p) => p[0]))).toBeCloseTo(200, -1);
    expect(Math.max(...field.map((p) => p[1]))).toBeCloseTo(700, -1);
    expect(calib.fieldShare()!).toBeCloseTo(0.5, 1);
    // Envelope 400..800 × 380..420 → sensor 80..240 × 112..128, plus the margin.
    const p = calib.proposal()!;
    expect(p.complete).toBe(true);
    // Nothing is proposed before the wizard gets to the region.
    expect(proposed).toEqual([]);
    calib.regionMode.set('line');
    expect(calib.target()).toEqual(p.region);
    expect(p.region.x).toBeLessThanOrEqual(72);
    expect(p.region.x + p.region.width).toBeGreaterThanOrEqual(248);
    expect(p.region.y).toBeLessThanOrEqual(104);
    expect(p.region.y + p.region.height).toBeGreaterThanOrEqual(136);
    // Kept for the device.
    expect(JSON.parse(localStorage.getItem(KEY)!).pairs).toBe(cal.pairs);
  });

  it('follows the envelope and reports one leaving the sensor', async () => {
    const { calib, link } = setup();
    await calib.calibrate();
    link.status.update((s) => ({ ...s!, envelope: envelope(100, 380, 900, 420) }));
    const p = calib.proposal()!;
    expect(p.complete).toBe(false);
    expect(p.overflow.left).toBeGreaterThan(30);
    await calib.fitLine();
    expect(link.fitToField).toHaveBeenCalled();
    // A resized laserline view invalidates the mapping.
    link.status.update((s) => ({ ...s!, viewPx: [1000, 800] }));
    expect(calib.stale()).toBe(true);
    expect(calib.proposal()).toBeNull();
  });

  it('restores the region when laserline stops drawing', async () => {
    const { calib, link, region } = setup();
    link.failShowAt = 4;
    await calib.calibrate();
    expect(calib.phase()).toBe('failed');
    expect(calib.error()).toMatch(/keep its window visible/);
    expect(region()).toEqual(SAVED);
    expect(link.ended.length).toBe(1);
    expect(calib.calibration()).toBeNull();
  });

  describe('levelling', () => {
    /** A camera seeing the view 200..1000 × 100..700, rolled 3° against it. */
    const ROLLED: SyntheticCamera = { ...CAM, h: cameraHomography({ x: 200, y: 100, width: 800, height: 600 }, SENSOR, 3, false, 0.00001) };

    it('finds the tilt that levels the line, then sets it in laserline', async () => {
      const { calib, link, region } = setup(ROLLED);
      link.status.update((s) => ({ ...s!, tilt_deg: 0 }));
      await calib.levelLine();
      expect(calib.tiltError()).toBeNull();
      const r = calib.tiltResult()!;
      // About the roll (the camera's slight perspective moves it a little); level in the image.
      expect(r.tilt).toBeCloseTo(-3, 0);
      expect(Math.abs(r.angle)).toBeLessThan(0.03);
      expect(r.gain).toBeGreaterThan(0.5);
      expect(r.axis).toBe('x');
      expect(r.orientation).toBe('Horizontal');
      expect(calib.tiltSamples().length).toBeGreaterThanOrEqual(5);
      // The line was shown where the user's runs, tilted.
      const lines = link.history.map((h) => h.pattern).filter((p) => p.kind === 'line');
      expect(lines.every((p) => p.kind === 'line' && p.position_pct === 50)).toBe(true);
      expect(new Set(lines.map((p) => p.kind === 'line' && p.tilt_deg)).size).toBeGreaterThan(4);
      // Region back, session over, result kept.
      expect(region()).toEqual(SAVED);
      expect(link.ended.length).toBe(1);
      expect(JSON.parse(localStorage.getItem(TILT_KEY)!).tilt).toBeCloseTo(r.tilt, 6);
      expect(calib.tiltApplied()).toBe(false);
      expect(await calib.applyTilt()).toBe(true);
      expect(link.setTilt).toHaveBeenCalledWith(r.tilt);
      expect(calib.tiltApplied()).toBe(true);
    });

    it('levels a line running along the sensor columns', async () => {
      const { calib, link } = setup(ROLLED);
      link.status.update((s) => ({ ...s!, envelope: { ...envelope(580, 200, 620, 600), dir: [0, 1], normal: [-1, 0] } }));
      await calib.levelLine();
      expect(calib.tiltError()).toBeNull();
      const r = calib.tiltResult()!;
      expect(r.orientation).toBe('Vertical');
      expect(r.axis).toBe('y');
      expect(r.tilt).toBeCloseTo(-3, 0);
      expect(Math.abs(r.angle)).toBeLessThan(0.03);
    });

    it('reports a laserline that ignores the tilt', async () => {
      const { calib, link, region } = setup(ROLLED);
      const show = link.show.bind(link);
      link.show = (session, id, pattern) => show(session, id, pattern.kind === 'line' ? { ...pattern, tilt_deg: undefined } : pattern);
      await calib.levelLine();
      expect(calib.tiltError()).toMatch(/does not turn it/);
      expect(calib.tiltResult()).toBeNull();
      expect(region()).toEqual(SAVED);
    });

    it('can be stopped', async () => {
      const { calib, link, region } = setup(ROLLED);
      link.onShow = () => link.shown === 4 && calib.cancel();
      await calib.levelLine();
      expect(calib.tiltError()).toBe('cancelled');
      expect(calib.levelling()).toBe(false);
      expect(region()).toEqual(SAVED);
      expect(link.ended.length).toBe(1);
    });
  });

  it('can be cancelled', async () => {
    const { calib, link, region } = setup();
    link.onShow = () => link.shown === 3 && calib.cancel();
    await calib.calibrate();
    expect(calib.phase()).toBe('failed');
    expect(calib.error()).toBe('cancelled');
    expect(region()).toEqual(SAVED);
  });

  it('explains a camera that does not see the display', async () => {
    const { calib, link } = setup();
    // Laserline draws, but the camera looks elsewhere.
    link.show = async () => ({ at: performance.now(), viewPx: VIEW });
    await calib.calibrate();
    expect(calib.error()).toMatch(/does not see the laserline view/);
  });

  it('finds a small field through a lagging stream and fits the line into it', async () => {
    const { calib, link } = setup(SMALL, 5);
    // Laserline fits the line into the field it was told about.
    link.fitToField = vi.fn(async () => {
      link.status.update((s) => ({ ...s!, envelope: envelope(580, 420, 660, 430) }));
      return true;
    });
    await calib.calibrate();
    expect(calib.error()).toBeNull();
    const cal = calib.calibration()!;
    expect(cal.rms).toBeLessThan(0.5);
    expect(cal.pairs).toBeGreaterThanOrEqual(16);
    // The field went to laserline: about view 560..680 × 380..470.
    const field = link.fields.at(-1)!;
    expect(Math.min(...field.map((p) => p[0]))).toBeGreaterThan(540);
    expect(Math.max(...field.map((p) => p[0]))).toBeLessThan(700);
    expect(calib.fieldShare()!).toBeLessThan(0.02);
    // The user's line (400..800) was far wider than the field: laserline fitted it.
    expect(link.fitToField).toHaveBeenCalled();
    expect(calib.note()).toMatch(/moved and shrank/);
    expect(calib.proposal()!.complete).toBe(true);
  }, 30_000);

  it('proposes the travel area, writes it and keeps laserline inside it', async () => {
    const { calib, link, region, proposed } = setup(SMALL, 5);
    link.fitToField = vi.fn(async () => true);
    calib.openWizard();
    await calib.wizardCalibrate();
    expect(calib.wizard()).toBe('review');
    // The camera sees only a part of the display: all of its sensor sees the view.
    expect(calib.regionMode()).toBe('travel');
    expect(calib.target()).toEqual({ x: 0, y: 0, width: SENSOR.width, height: SENSOR.height });
    calib.wizard.set('region');
    TestBed.tick();
    expect(proposed.at(-1)).toEqual(calib.target());
    expect(await calib.applyTarget()).toBe(true);
    expect(region()).toEqual(calib.target());
    expect(calib.targetApplied()).toBe(true);
    // The limits: the region less the margin, in view px, inside the field the camera sees.
    const poly = calib.limitPolygon()!;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    expect(Math.min(...xs)).toBeGreaterThan(555);
    expect(Math.max(...xs)).toBeLessThan(685);
    expect(Math.min(...ys)).toBeGreaterThan(375);
    expect(Math.max(...ys)).toBeLessThan(475);
    expect(await calib.applyLimits()).toBe(true);
    expect(link.constrain).toHaveBeenLastCalledWith(poly, 'RACS · camera #3');
    expect(calib.limited()).toBe(true);
    expect(calib.limitResult()).toEqual({ clamped: ['amplitude'], released: false });
    // Leaving the line free releases the limits.
    calib.limitsOn.set(false);
    expect(await calib.applyLimits()).toBe(true);
    expect(link.constrain).toHaveBeenLastCalledWith(null, 'RACS · camera #3');
    expect(calib.limited()).toBe(false);
  }, 30_000);

  it('crops only rows of the line region on request', async () => {
    const { calib } = setup();
    await calib.calibrate();
    calib.regionMode.set('line');
    const fit = calib.target()!;
    calib.rowsOnly.set(true);
    expect(calib.target()).toEqual({ ...fit, x: 0, width: SENSOR.width });
  });

  it('explains a laserline that cannot keep limits', async () => {
    const { calib, link } = setup();
    await calib.calibrate();
    link.constrain = vi.fn(async () => {
      throw new Error('this laserline version cannot keep the line in an area: update it');
    });
    expect(await calib.applyLimits()).toBe(false);
    expect(calib.limitError()).toMatch(/cannot keep the line/);
  });

  it('switches the camera to area scan', () => {
    const { calib, session } = setup();
    const write = vi.fn();
    (session as unknown as { write: typeof write }).write = write;
    session.scanType.set('1');
    expect(calib.areascan()).toBe(false);
    calib.useAreascan();
    expect(write).toHaveBeenCalledWith('DeviceScanType', '0');
  });

  it('needs a running stream in areascan', () => {
    const { calib, live, session } = setup();
    expect(calib.blocked()).toBeNull();
    session.scanType.set('1');
    expect(calib.blocked()).toBe('switch the scan type to areascan');
    live.set(false);
    expect(calib.blocked()).toBe('start the live stream first');
  });

  it('checks the applied region against the live line', async () => {
    const { calib, session, link } = setup();
    await calib.calibrate();
    const p = calib.proposal()!;
    // Apply the proposal, then show the user's line inside it.
    session.states.update((s) => ({
      ...s,
      OffsetX: { ...s['OffsetX']!, value: String(p.region.x) },
      OffsetY: { ...s['OffsetY']!, value: String(p.region.y) },
      Width: { ...s['Width']!, value: String(p.region.width) },
      Height: { ...s['Height']!, value: String(p.region.height) },
    }));
    await calib.checkLine();
    expect(calib.check()).toMatchObject({ frames: 60, complete: 60, cut: 0, none: 0 });
    // A longer line runs into the region's right edge.
    link.userLine = { a: { x: 400, y: 400 }, b: { x: 950, y: 400 } };
    await calib.checkLine();
    expect(calib.check()).toMatchObject({ cut: 60, edges: ['right'] });
    link.userLine = null;
    await calib.checkLine();
    expect(calib.check()).toMatchObject({ none: 60 });
  });
  describe('storage by MAC', () => {
    const stored = (sensor = SENSOR) => ({ h: [1, 0, 0, 0, 1, 0, 0, 0, 1], viewPx: VIEW, sensor, rms: 0.3, pairs: 40, at: 1 });
    const tilt = { tilt: -3, angle: 0.01, rms: 0.2, gain: 1, axis: 'x', orientation: 'Horizontal', viewPx: VIEW, at: 1 };

    it('takes over a calibration kept by device id, with its levelling', () => {
      localStorage.setItem('racs.laserline.calib.3', JSON.stringify(stored()));
      localStorage.setItem('racs.laserline.tilt.3', JSON.stringify(tilt));
      const { calib } = setup();
      expect(calib.calibration()).toEqual(stored());
      expect(calib.tiltResult()).toEqual(tilt);
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(stored());
      expect(JSON.parse(localStorage.getItem(TILT_KEY)!)).toEqual(tilt);
      expect(localStorage.getItem('racs.laserline.calib.3')).toBeNull();
      expect(localStorage.getItem('racs.laserline.tilt.3')).toBeNull();
    });

    it("drops one of another camera's sensor size, and its levelling", () => {
      localStorage.setItem('racs.laserline.calib.3', JSON.stringify(stored({ width: 640, height: 480 })));
      localStorage.setItem('racs.laserline.tilt.3', JSON.stringify(tilt));
      const { calib } = setup();
      expect(calib.calibration()).toBeNull();
      expect(calib.tiltResult()).toBeNull();
      expect(localStorage.length).toBe(0);
    });

    it('waits with the migration while the camera is in Linescan3D', () => {
      localStorage.setItem('racs.laserline.calib.3', JSON.stringify(stored({ width: 640, height: 480 })));
      const { calib, session } = setup(CAM, 3, { scanType: '1' });
      expect(localStorage.getItem('racs.laserline.calib.3')).not.toBeNull();
      session.scanType.set('0');
      TestBed.tick();
      expect(localStorage.getItem('racs.laserline.calib.3')).toBeNull();
      expect(calib.calibration()).toBeNull();
    });

    it('never overwrites what the camera keeps under its MAC', () => {
      const mine = { ...stored(), rms: 0.1 };
      localStorage.setItem(KEY, JSON.stringify(mine));
      localStorage.setItem('racs.laserline.calib.3', JSON.stringify(stored()));
      const { calib } = setup();
      expect(calib.calibration()).toEqual(mine);
      expect(localStorage.getItem('racs.laserline.calib.3')).not.toBeNull();
    });

    it('stores nothing before the device is known', async () => {
      localStorage.setItem('racs.laserline.calib.3', JSON.stringify(stored()));
      const registry = new FakeRegistry();
      registry.connected.set([]);
      const { calib } = setup(CAM, 3, { registry });
      expect(calib.blocked()).toBe('reading device…');
      await calib.calibrate();
      expect(calib.phase()).toBe('idle');
      expect(calib.calibration()).toBeNull();
      expect(localStorage.length).toBe(1);
      // Listed: the old calibration is taken over.
      registry.connected.set([{ id: 3, mac: MAC }]);
      TestBed.tick();
      expect(calib.calibration()).toEqual(stored());
      expect(localStorage.getItem(KEY)).not.toBeNull();
    });

    it('keeps running through a registry update with the same MAC', async () => {
      const { calib, link, registry } = setup();
      link.onShow = () => {
        if (link.shown === 3) {
          registry.connected.set([{ id: 3, mac: MAC }, { id: 4, mac: '00:11:22:00:00:04' }]);
          TestBed.tick();
        }
      };
      await calib.calibrate();
      expect(calib.error()).toBeNull();
      expect(calib.phase()).toBe('done');
      expect(localStorage.getItem(KEY)).not.toBeNull();
    });

    it('stops when another camera takes the id', async () => {
      const { calib, link, registry } = setup();
      link.onShow = () => {
        if (link.shown === 3) {
          registry.connected.set([{ id: 3, mac: '00:11:22:00:00:09' }]);
          TestBed.tick();
        }
      };
      await calib.calibrate();
      expect(calib.error()).toBe('cancelled');
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });
});
