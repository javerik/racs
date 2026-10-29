import { Injectable, OnDestroy, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import type { Mat3 } from '../imaging/homography';
import {
  checkCoverage,
  envelopeExtent,
  planCrossings,
  planParallel,
  profilesAgree,
  profilesDisagreement,
  type ProfilesDisagreement,
  RANGE_MAX_RMS_PX,
  RANGE_WARN_RMS_PX,
  reduceProfiles,
  seenColumns,
  solveRangeMap,
  type PlannedLine,
  type RangeMap,
  type RangeObservation,
  type ReducedProfiles,
} from '../imaging/range-calibration';
import type { BaseLine, Envelope, Pattern, ViewPoint } from '../laserline/protocol';
import type { GenICamNodeInfo } from '../models/racs.models';
import { deviceStorageKey } from './device-key';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceSelectionService } from './device-selection.service';
import { errorMessage, GenicamSession } from './genicam-session.service';
import type { CalibrationPhase } from './laser-calibration.service';
import { LaserlineLinkService } from './laserline-link.service';
import { LASERLINE_TOOL, ToolWindowService } from './tool-window.service';
import { RACS_CONFIG } from '../config';

/** Kept per camera by `deviceStorageKey` (#33 §2). */
const STORAGE_PREFIX = 'racs.laserline.range';
/** The `GenicamSession` watcher that reads the snapshot's features. */
const WATCH_OWNER = 'range-calibration';

/** The line must show within this many frames (captured indices), or the camera does not see it. */
export const RANGE_MAX_LAG_FRAMES = 40;
/** Frames after the lag in which a pattern must settle, on top of those its profiles take. */
export const RANGE_SETTLE_FRAMES = 10;
/** How long to wait for one frame. */
export const RANGE_FRAMES_MS = 6_000;
/** Profiles reduced per pattern at least. */
export const RANGE_MIN_PROFILES = 16;
/** Laserline counts as blank to the camera when under this share of its columns see anything. */
export const RANGE_BLANK_SHARE = 0.02;
/** The line has appeared (the lag) when at least this share of the columns sees it. */
export const RANGE_APPEAR_SHARE = 0.05;
/** The base line must be seen by at least this share of the columns. */
export const RANGE_BASE_SHARE = 0.3;
/** The band search goes on while a parallel line is seen by at least this share of the columns. */
export const RANGE_BAND_SHARE = 0.2;
/** The band search's first offset (view px); offsets double from it until a line is lost. */
export const RANGE_BAND_START_PX = 2;
/** Then this many bisections between the last line seen and the first lost find the band's edge. */
export const RANGE_BAND_REFINE_STEPS = 3;
/** Crossing pairs, spread over the envelope's along range widened by this share on each side. */
export const RANGE_CROSSING_POINTS = 7;
export const RANGE_CROSSING_MARGIN = 0.2;
export const RANGE_CROSSING_ANGLE_DEG = 45;
/** Two reductions agree within this × their median MAD (at least one value). */
export const RANGE_AGREE_MADS = 4;
/**
 * Calibration line widths (view px) tried on the base line; every line is drawn in the one the
 * camera sees in the most columns. How wide a line is in the image depends on the magnification,
 * and a peak finder that goes by slopes (the AT C6's FIR peak) loses a flat top much wider than its
 * filter: seen on the C6 at ~11 sensor rows per view px, 627 of 3072 columns at 6 px, 2991 at 3 px.
 */
export const RANGE_LINE_WIDTHS_PX = [2, 3, 4, 6, 8];
/** *Verify* fails above this × the calibration's rms… */
export const RANGE_VERIFY_FACTOR = 2;
/** …but never below this (view px): a fit's rms can be a few hundredths of a px, under the noise. */
export const RANGE_VERIFY_FLOOR_PX = 0.1;
/** A check line counts when at least this many columns see it. */
export const RANGE_VERIFY_MIN_COLUMNS = 3;

/** Read for the stale check (#33 §2), with `Scan3d*` and the selectors of any of them. */
const SNAPSHOT_FEATURES = [
  'DeviceScanType',
  'PixelFormat',
  'Width',
  'OffsetX',
  'RegionSelector',
  'OffsetY',
  'Height',
  'ReverseX',
  'ReverseY',
  'BinningHorizontal',
  'BinningVertical',
  'DecimationHorizontal',
  'DecimationVertical',
];
/** What `RegionSelector` selects on a server that doesn't report `selected`. */
const REGION_SELECTED = ['Width', 'Height', 'OffsetX', 'OffsetY'];

/** A range frame: `height` profiles of `width` values (0 invalid), when it arrived and its captured index. */
export interface RangeFrame {
  pixels: Uint16Array;
  width: number;
  height: number;
  /** `performance.now()` at arrival. */
  at: number;
  /** The captured index, `frame_number + dropped`: counts every frame the camera took. */
  number: number;
}

export interface RangeGeometry {
  width: number;
  height: number;
  bitDepth: number;
  pixelFormat: string;
}

/** Live range frames for the calibration; implemented by the 3D tab. */
export interface RangeFrameSource {
  /** The live stream runs. */
  live: Signal<boolean>;
  /** The running stream's frames; null before its `StreamInfo`. */
  geometry: Signal<RangeGeometry | null>;
  /**
   * The next `count` frames that arrive after `after` (a `performance.now()` time) and pass
   * `accept`. Rejects after `timeoutMs`, or resolves with what came by then with `partial`.
   */
  frames(count: number, after: number, options?: { accept?: (f: RangeFrame) => boolean; timeoutMs?: number; partial?: boolean }): Promise<RangeFrame[]>;
  /** The captured index of the newest frame received so far; -1 before any. */
  latestNumber(): number;
}

/** One calibration line as the fit saw it. */
export interface RangeLineRecord {
  kind: PlannedLine['kind'];
  /** Across offset (parallel) or along position (crossing) from the base centre, view px. */
  at: number;
  sign: PlannedLine['sign'];
  /** Columns that saw it. */
  columns: number;
  /** Its observations, how many the trimmed fit dropped, and their distance from the line (view px). */
  n: number;
  dropped: number;
  rms: number;
  max: number;
}

/** A measured range calibration, as kept in `racs.laserline.range.<mac>` (#33 §2). */
export interface RangeCalibration {
  v: 1;
  /** (column, value, 1) → laserline view px. */
  g: Mat3;
  model: RangeMap['model'];
  /** The laserline view size it was measured in. */
  viewPx: ViewPoint;
  /** The camera's feature states then (GenICam values as read). */
  camera: Record<string, string>;
  /** View px; every line weighs the same. */
  rms: number;
  max: number;
  lines: RangeLineRecord[];
  /** The columns and values the observations span: the calibrated domain. */
  columns: [number, number];
  values: [number, number];
  /** The parallel lines' across offsets the camera saw, view px from the base line along its normal. */
  band: [number, number];
  /** Laserline's base line then. */
  base: BaseLine;
  /** The line width (view px) it was measured with; laserline's calibration width when absent. */
  lineWidthPx?: number;
  at: number;
  /** The last *Verify* against it, if any; a failed one makes it stale. */
  verify?: RangeVerification;
}

/** *Verify* (#33 §3): check lines filmed against the stored G. */
export interface RangeVerification {
  at: number;
  /** Distance of the observations from their lines under G, view px; every line weighs the same. */
  rms: number;
  max: number;
  /** `max(RANGE_VERIFY_FACTOR × rms of G, RANGE_VERIFY_FLOOR_PX)`. */
  limit: number;
  ok: boolean;
  /** Check lines the camera saw, of those shown. */
  seen: number;
  shown: number;
}

/** What the last run measured besides the calibration (not kept). */
export interface RangeRunReport {
  /** Frames (captured indices) between a pattern going on screen and the camera showing it. */
  lag: number;
  /** Frames dropped because their two halves disagreed (they straddled a pattern switch). */
  straddled: number;
  patterns: number;
  durationMs: number;
  /** Per column, the largest distance of its observations from their lines (view px); NaN where none. */
  residuals: Float64Array;
}

/**
 * The range calibration (#33 §2): with the camera in `Linescan3D`, has laserline show lines around
 * its base line and fits the projective map G: (column, value) → laserline view px from the range
 * profiles.
 *
 * 1. Blank, then the base line: the frames until it shows are the lag (captured indices).
 * 2. Parallel lines at growing offsets on both sides until the camera loses them: the band.
 * 3. ±45° crossing pairs along the line, which fix the along direction.
 * 4. `checkCoverage`, then `solveRangeMap`; kept per camera (by MAC) with a snapshot of the camera's
 *    features, against which `stale` checks.
 *
 * It writes nothing to the camera. Provided by the 3D tab, which attaches its frames.
 */
@Injectable()
export class RangeCalibrationService implements OnDestroy {
  private readonly link = inject(LaserlineLinkService);
  private readonly tools = inject(ToolWindowService);
  /** The configured laserline window. */
  private readonly laserline = inject(RACS_CONFIG).tools.find((t) => t.id === LASERLINE_TOOL.id) ?? LASERLINE_TOOL;
  private readonly session = inject(GenicamSession, { optional: true });
  private readonly selection = inject(DeviceSelectionService);
  private readonly registry = inject(DeviceRegistryService);

  readonly phase = signal<CalibrationPhase>('idle');
  /** What the running (or last) run does: a calibration or a check of the kept one. */
  readonly task = signal<'calibrate' | 'verify'>('calibrate');
  /** What a running calibration does now, for the status line. */
  readonly stepText = signal('');
  /** 0..1 while running. */
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);
  /** What is worth knowing about the last run that didn't stop it. */
  readonly warnings = signal<string[]>([]);
  /** The device's calibration, from this run or kept from an earlier one. */
  readonly result = signal<RangeCalibration | null>(null);
  readonly report = signal<RangeRunReport | null>(null);

  private readonly source = signal<RangeFrameSource | null>(null);
  private cancelled = false;
  private patternId = 0;

  /** Where the device's calibration is kept; null until the registry lists it. */
  private readonly key = computed(() => {
    const id = this.selection.selectedDeviceId();
    return deviceStorageKey(STORAGE_PREFIX, id === null ? null : this.registry.find(id));
  });

  /** `DeviceScanType`'s entry name, if the camera has one: enums read as their integer value. */
  readonly scanType = computed(() => {
    const value = this.session?.value('DeviceScanType');
    if (value === undefined) {
      return null;
    }
    const entry = this.session!.nodes().get('DeviceScanType')?.enums?.find((e) => String(e.value) === value);
    return entry ? (entry.string_value ?? entry.display_name) : value;
  });

  /** Why a calibration can't start now, if it can't. */
  readonly blocked = computed<string | null>(() => {
    const source = this.source();
    if (!this.session) {
      return 'no feature access';
    }
    if (!source?.live()) {
      return 'start the live stream first';
    }
    if (!/^linescan3d$/i.test(this.scanType() ?? '')) {
      return 'switch the scan type to Linescan3D';
    }
    const g = source.geometry();
    if (!g) {
      return 'waiting for the stream…';
    }
    // Any 16-bit format carries the range in Linescan3D: the AT C6 accepts Mono16 there as well as
    // Coord3D_C16, and the server tries Mono16 first. The calibration measures the values as they come.
    if (g.bitDepth !== 16) {
      return `the stream runs at ${g.bitDepth} bit: restart it at 16 bit`;
    }
    if (!this.key()) {
      return 'reading device…';
    }
    // Without a status the click opens laserline, and `calibrate` checks it then.
    return this.link.status() ? metricProblem(this.link.metric()) : null;
  });

  /** The features the calibration records, of those the camera has. */
  private readonly snapshotNames = computed(() => {
    const nodes = this.session?.nodes() ?? new Map<string, GenICamNodeInfo>();
    const names = new Set(SNAPSHOT_FEATURES.filter((n) => nodes.has(n)));
    for (const name of nodes.keys()) {
      if (name.startsWith('Scan3d')) names.add(name);
    }
    for (const [name, node] of nodes) {
      if (node.selected?.some((t) => names.has(t))) names.add(name);
    }
    return [...names].filter((n) => nodes.get(n)!.node_type !== 'Command');
  });

  /** Per feature, the selectors it is read under. */
  private readonly selectors = computed(() => {
    const out = new Map<string, string[]>();
    for (const [name, node] of this.session?.nodes() ?? new Map<string, GenICamNodeInfo>()) {
      const selected = node.selected ?? (name === 'RegionSelector' ? REGION_SELECTED : []);
      for (const target of selected) out.set(target, [...(out.get(target) ?? []), name]);
    }
    return out;
  });

  /**
   * Why the calibration no longer holds, if it doesn't: the laserline view has another size, or a
   * recorded feature reads differently. A feature read under a selector that is set otherwise now
   * (another region) is unknown, not changed; so is one not read yet.
   */
  readonly staleReason = computed<string | null>(() => {
    const cal = this.result();
    if (!cal) {
      return null;
    }
    const view = this.link.status()?.viewPx;
    if (view && view[0] > 0 && view[1] > 0 && !sameView(view, cal.viewPx)) {
      return 'the laserline view changed size';
    }
    if (cal.verify && !cal.verify.ok) {
      return `the check lines are ${cal.verify.rms.toFixed(2)} px off (limit ${cal.verify.limit.toFixed(2)} px): has the camera or the window moved?`;
    }
    const states = this.session?.states() ?? {};
    const selectors = this.selectors();
    for (const [name, recorded] of Object.entries(cal.camera)) {
      const now = states[name]?.value;
      if (now === null || now === undefined || isSelector(name, this.session?.nodes().get(name)?.selected)) continue;
      if ((selectors.get(name) ?? []).some((s) => s in cal.camera && states[s]?.value !== cal.camera[s])) continue;
      if (now !== recorded) {
        return `${name} changed (${recorded} → ${now})`;
      }
    }
    return null;
  });
  readonly stale = computed(() => this.staleReason() !== null);

  constructor() {
    // Each camera keeps its own calibration. Keyed by the string only: a registry update that keeps
    // the MAC must not cancel a running calibration.
    effect(() => {
      const key = this.key();
      untracked(() => {
        this.cancel();
        this.result.set(key === null ? null : load(key));
        this.report.set(null);
        this.error.set(null);
        this.warnings.set([]);
        this.phase.set('idle');
      });
    });

    // The snapshot is taken from the session's states, so they have to be read.
    effect(() => {
      const names = this.snapshotNames();
      if (names.length) {
        untracked(() => this.session?.watch(WATCH_OWNER, names));
      }
    });
  }

  ngOnDestroy(): void {
    this.cancel();
    this.session?.unwatch(WATCH_OWNER);
    this.source.set(null);
  }

  attach(source: RangeFrameSource): void {
    this.source.set(source);
  }

  /** Stops a running calibration at its next frame; the laserline session ends. */
  cancel(): void {
    if (this.phase() === 'running') {
      this.cancelled = true;
    }
  }

  /** Forgets the device's calibration. */
  forget(): void {
    const key = this.key();
    this.result.set(null);
    this.report.set(null);
    if (key !== null) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing kept.
      }
    }
  }

  /** Call from a click: may open the laserline window. */
  async calibrate(): Promise<void> {
    const source = this.source();
    const deviceId = this.selection.selectedDeviceId();
    const geometry = source?.geometry();
    if (this.phase() === 'running' || this.blocked() || !source || deviceId === null || !geometry) {
      return;
    }
    const started = performance.now();
    this.cancelled = false;
    this.task.set('calibrate');
    this.phase.set('running');
    this.error.set(null);
    this.warnings.set([]);
    this.report.set(null);
    this.progress.set(0);
    try {
      this.setStep('opening laserline');
      const viewPx = await this.openView();
      const metric = this.link.metric();
      const problem = metricProblem(metric);
      if (problem || !metric) {
        throw new Error(problem ?? 'laserline publishes no metric mapping');
      }
      const { width, height } = geometry;
      const run: Run = {
        source,
        session: '',
        viewPx,
        base: metric.base,
        envelope: this.link.status()?.envelope ?? null,
        width,
        accept: (f) => f.width === width && f.height === height,
        settleFrames: RANGE_SETTLE_FRAMES + 2 * Math.ceil(RANGE_MIN_PROFILES / Math.max(1, height)),
        lag: 1,
        lineWidthPx: null,
        previous: null,
        straddled: 0,
        patterns: 0,
      };
      const captured = await this.link.runSession(`racs-${deviceId}`, (session) => {
        run.session = session;
        return this.film(run);
      });
      this.throwIfMoved(run);

      this.setStep('solving');
      this.progress.set(0.96);
      const coverage = checkCoverage(captured.map((c) => ({ kind: c.planned.kind, sign: c.planned.sign, columns: c.columns })), width);
      const observations: RangeObservation[] = captured.flatMap((c) => c.columns.map((col) => ({ c: col, r: c.reduced.median[col], line: c.planned.line })));
      const fit = coverage.ok ? solveRangeMap(observations) : null;
      logLines(captured, fit);
      console.debug('[range calibration] fit', { lag: run.lag, straddled: run.straddled, coverage, rms: fit?.rms, max: fit?.max, model: fit?.model, used: fit?.used });
      if (!coverage.ok) {
        throw new Error(coverage.reason!);
      }
      if (!fit) {
        throw new Error('the lines the camera saw do not determine the mapping: does it see the line along its whole width?');
      }
      if (fit.rms > RANGE_MAX_RMS_PX) {
        throw new Error(`the lines do not fit one mapping (rms ${fit.rms.toFixed(2)} px): is the display sharp in the image, and still?`);
      }
      const warnings: string[] = [];
      if (fit.rms > RANGE_WARN_RMS_PX) {
        warnings.push(`the mapping is rough (rms ${fit.rms.toFixed(2)} px): check the focus and the exposure`);
      }
      const cal = calibrationOf(run, captured, observations, fit, this.snapshot());
      const env = envelopeExtent(run.envelope, run.base);
      if (env && (env.across[0] < cal.band[0] || env.across[1] > cal.band[1])) {
        warnings.push(
          `the camera sees ${span(cal.band)} px across the line, less than its envelope (${span(env.across)} px): heights outside it are lost`,
        );
      }
      this.result.set(cal);
      this.report.set({ lag: run.lag, straddled: run.straddled, patterns: run.patterns, durationMs: performance.now() - started, residuals: columnResiduals(observations, fit.g, width) });
      this.warnings.set(warnings);
      const key = this.key();
      if (key) {
        store(key, cal);
      }
      this.progress.set(1);
      this.phase.set('done');
    } catch (e) {
      this.phase.set('failed');
      this.error.set(this.cancelled ? 'cancelled' : errorMessage(e));
    } finally {
      this.cancelled = false;
      this.setStep('');
    }
  }

  /**
   * *Verify* (#33 §3): films 3 parallel lines (the base line and the band's middle on each side) and
   * 2 crossing lines at the base centre, about the calibration's base line, and measures how far G
   * puts them from where laserline drew them. Above `max(2 × G's rms, 0.1 px)` the calibration is
   * stale (kept with it, so a reload still says so). Call from a click: may open laserline.
   */
  async verify(): Promise<void> {
    const source = this.source();
    const cal = this.result();
    const deviceId = this.selection.selectedDeviceId();
    const geometry = source?.geometry();
    if (this.phase() === 'running' || this.blocked() || !cal || !source || deviceId === null || !geometry) {
      return;
    }
    this.cancelled = false;
    this.task.set('verify');
    this.phase.set('running');
    this.error.set(null);
    this.progress.set(0);
    try {
      this.setStep('opening laserline');
      const viewPx = await this.openView();
      if (!sameView(viewPx, cal.viewPx)) {
        throw new Error('the laserline view changed size since the calibration: calibrate again');
      }
      const metric = this.link.metric();
      const problem = metricProblem(metric);
      if (problem || !metric) {
        throw new Error(problem ?? 'laserline publishes no metric mapping');
      }
      const { width, height } = geometry;
      const run: Run = {
        source,
        session: '',
        viewPx,
        base: metric.base,
        envelope: null,
        width,
        accept: (f) => f.width === width && f.height === height,
        settleFrames: RANGE_SETTLE_FRAMES + 2 * Math.ceil(RANGE_MIN_PROFILES / Math.max(1, height)),
        lag: 1,
        lineWidthPx: cal.lineWidthPx ?? null,
        previous: null,
        straddled: 0,
        patterns: 0,
      };
      // About the base line the band was measured around: that is where the camera looks.
      const lines = [
        ...planParallel(cal.base, [0, cal.band[0] / 2, cal.band[1] / 2], viewPx),
        ...planCrossings(cal.base, [0], viewPx, RANGE_CROSSING_ANGLE_DEG),
      ];
      if (!lines.length || lines[0].at !== 0) {
        throw new Error('laserline’s line lies outside its view');
      }
      const captured = await this.link.runSession(`racs-${deviceId}`, async (session) => {
        run.session = session;
        this.setStep('finding the line');
        await this.findLag(run, lines[0]);
        const out: Captured[] = [];
        for (const [i, line] of lines.entries()) {
          this.setStep(`check line ${i + 1}/${lines.length}`);
          this.progress.set(0.1 + (0.85 * i) / lines.length);
          out.push(await this.capture(run, line));
        }
        return out;
      });
      this.throwIfMoved(run);

      const seen = captured.filter((c) => c.columns.length >= RANGE_VERIFY_MIN_COLUMNS);
      if (!seen.length) {
        throw new Error('the camera sees none of the check lines: is it still aimed at the laserline view?');
      }
      let sq = 0;
      let max = 0;
      for (const c of seen) {
        let lineSq = 0;
        for (const col of c.columns) {
          const d = distanceTo(cal.g, col, c.reduced.median[col], c.planned.line);
          lineSq += d * d;
          max = Math.max(max, d);
        }
        sq += lineSq / c.columns.length;
      }
      const rms = Math.sqrt(sq / seen.length);
      const limit = Math.max(RANGE_VERIFY_FACTOR * cal.rms, RANGE_VERIFY_FLOOR_PX);
      const verify: RangeVerification = { at: Date.now(), rms, max, limit, ok: rms <= limit, seen: seen.length, shown: lines.length };
      console.debug('[range calibration] verify', verify);
      const next: RangeCalibration = { ...cal, verify };
      this.result.set(next);
      const key = this.key();
      if (key) {
        store(key, next);
      }
      this.progress.set(1);
      this.phase.set('done');
    } catch (e) {
      this.phase.set('failed');
      this.error.set(this.cancelled ? 'cancelled' : errorMessage(e));
    } finally {
      this.cancelled = false;
      this.setStep('');
    }
  }

  /** The lag, the base line, the band and the crossing lines, in a laserline session. */
  private async film(run: Run): Promise<Captured[]> {
    const out: Captured[] = [];
    const [base] = planParallel(run.base, [0], run.viewPx);
    if (!base) {
      throw new Error('laserline’s line lies outside its view');
    }
    this.setStep('finding the line');
    this.progress.set(0.02);
    await this.findLag(run, base);

    const first = await this.pickLineWidth(run, base);
    if (first.columns.length < RANGE_BASE_SHARE * run.width) {
      throw new Error(
        `the camera sees the line in ${percent(first.columns.length / run.width)} % of its columns (${RANGE_BASE_SHARE * 100} % needed): does its region hold the line?`,
      );
    }
    out.push(first);

    // Doubling offsets on each side until a line is lost, then bisected towards the band's edge.
    const farthest = Math.hypot(run.viewPx[0], run.viewPx[1]);
    for (const side of [-1, 1]) {
      let seen = 0;
      let lost: number | null = null;
      let refine = 0;
      while (lost === null ? seen < farthest : refine++ < RANGE_BAND_REFINE_STEPS) {
        const at: number = lost === null ? Math.max(RANGE_BAND_START_PX, 2 * seen) : (seen + lost) / 2;
        const [line] = planParallel(run.base, [side * at], run.viewPx);
        if (!line) {
          lost = at;
          continue;
        }
        this.setStep(`band ${signed(side * at)} px`);
        this.progress.set(Math.min(0.45, 0.05 + 0.03 * out.length));
        const c = await this.capture(run, line);
        out.push(c);
        if (c.columns.length >= RANGE_BAND_SHARE * run.width) seen = at;
        else lost = at;
      }
    }

    const env = envelopeExtent(run.envelope, run.base);
    // Along the envelope, widened on both sides; without one, the base line's run through the view.
    const [lo, hi] = env?.along ?? viewRun(run.base, run.viewPx);
    const margin = RANGE_CROSSING_MARGIN * (hi - lo);
    const points = Array.from({ length: RANGE_CROSSING_POINTS }, (_, i) => lo - margin + (i * (hi - lo + 2 * margin)) / (RANGE_CROSSING_POINTS - 1));
    const crossings = planCrossings(run.base, points, run.viewPx, RANGE_CROSSING_ANGLE_DEG);
    for (const [i, line] of crossings.entries()) {
      this.setStep(`crossing ${i + 1}/${crossings.length}`);
      this.progress.set(0.5 + (0.45 * i) / crossings.length);
      out.push(await this.capture(run, line));
    }
    return out;
  }

  /** Blank until the camera sees nothing, then the base line: the frames until it shows are the lag. */
  private async findLag(run: Run, base: PlannedLine): Promise<void> {
    const blank = await this.show(run, { kind: 'blank' });
    let after = blank.at;
    for (;;) {
      const f = await this.next(run, after);
      after = f.at;
      if (seenShare(f) < RANGE_BLANK_SHARE) break;
      if (f.number - blank.from > RANGE_MAX_LAG_FRAMES) {
        throw new Error('the camera sees a line while laserline is blank: is there another light in the image?');
      }
    }
    const shown = await this.show(run, base.pattern);
    after = shown.at;
    for (;;) {
      const f = await this.next(run, after);
      after = f.at;
      const behind = f.number - shown.from;
      if (behind > 0 && seenShare(f) >= RANGE_APPEAR_SHARE) {
        // That frame may be exposed while the line appeared: patterns count from the next one.
        run.lag = Math.max(1, behind);
        console.debug('[range calibration] lag', run.lag);
        return;
      }
      if (behind > RANGE_MAX_LAG_FRAMES) {
        throw new Error('the camera does not see the line: aim it at the laserline view, check the exposure and that its region holds the line');
      }
    }
  }

  /**
   * Shows `planned` and reduces at least `RANGE_MIN_PROFILES` profiles of it. Frames count from the
   * one after the lag; one whose halves disagree straddles a switch and starts over. A result that
   * looks like the previous pattern's counts only once another lag has passed (two lines outside
   * the band look alike).
   */
  private async capture(run: Run, planned: PlannedLine): Promise<Captured> {
    const shown = await this.show(run, planned.pattern);
    const first = shown.from + run.lag + 1;
    const limit = first + 2 * run.lag + run.settleFrames;
    let after = shown.at;
    let held: RangeFrame[] = [];
    // Why frames were refused, for the error when the pattern never settles.
    const why = { frames: 0, split: 0, last: null as (ProfilesDisagreement & { tolerance: number }) | null };
    for (;;) {
      const f = await this.next(run, after);
      after = f.at;
      if (f.number < first) {
        continue;
      }
      if (f.number > limit) {
        console.debug('[range calibration] does not settle', this.stepText(), why);
        throw new UnsettledError(`the range image does not settle (${this.stepText()}: ${unsettled(why)}): is the display, the light or the exposure changing?`);
      }
      why.frames++;
      if (f.height >= 2) {
        const [a, b] = halves([f], run.width);
        if (!patternHalvesAgree(planned.kind, a, b, run.width)) {
          why.split++;
          why.last = { ...profilesDisagreement(a, b), tolerance: tolerance(a, b) };
          run.straddled++;
          held = [];
          continue;
        }
      }
      held.push(f);
      if (held.reduce((s, h) => s + h.height, 0) < RANGE_MIN_PROFILES) {
        continue;
      }
      const reduced = reduceProfiles(held.map((h) => h.pixels), run.width);
      if (held.length >= 2 && !patternHalvesAgree(planned.kind, ...halves(held, run.width), run.width)) {
        held = [];
        continue;
      }
      if (run.previous && agree(reduced, run.previous) && f.number <= first + run.lag) {
        // Still the last pattern, or one that looks like it: only frames after another lag count.
        held = held.filter((h) => h.number > first + run.lag);
        continue;
      }
      run.previous = reduced;
      run.patterns++;
      return { planned, reduced, columns: seenColumns(reduced) };
    }
  }

  /**
   * The base line in each of `RANGE_LINE_WIDTHS_PX`; keeps the width the camera sees in the most
   * columns for the rest of the run, and resolves with that capture. A width whose halves never
   * agree counts as unseen.
   */
  private async pickLineWidth(run: Run, base: PlannedLine): Promise<Captured> {
    let best: { width: number; captured: Captured } | null = null;
    let lastUnsettled: unknown = null;
    for (const width of RANGE_LINE_WIDTHS_PX) {
      this.setStep(`base line · ${width} px wide`);
      run.lineWidthPx = width;
      try {
        const captured = await this.capture(run, base);
        if (!best || captured.columns.length > best.captured.columns.length) best = { width, captured };
      } catch (e) {
        if (!(e instanceof UnsettledError)) throw e;
        lastUnsettled = e;
      }
    }
    if (!best) {
      throw lastUnsettled;
    }
    console.debug('[range calibration] line width', best.width, 'px', best.captured.columns.length, 'columns');
    run.lineWidthPx = best.width;
    return best.captured;
  }

  /** Shows `pattern` (a line in the run's width); resolves when it is on screen, with the newest captured index by then. */
  private async show(run: Run, pattern: Pattern): Promise<{ at: number; from: number }> {
    this.throwIfCancelled();
    this.throwIfMoved(run);
    const shown = await this.link.show(run.session, ++this.patternId, withLineWidth(pattern, run.lineWidthPx, run.viewPx));
    if (!sameView(shown.viewPx, run.viewPx)) {
      throw new Error('the laserline view changed size during the calibration');
    }
    return { at: shown.at, from: run.source.latestNumber() };
  }

  private async next(run: Run, after: number): Promise<RangeFrame> {
    const [f] = await run.source.frames(1, after, { accept: run.accept, timeoutMs: RANGE_FRAMES_MS });
    this.throwIfCancelled();
    return f;
  }

  /** Connects to laserline and resolves with its view size once it draws. */
  private async openView(): Promise<ViewPoint> {
    await this.link.connect(() => this.tools.open(this.laserline));
    const viewPx = await this.link.drawnView();
    if (!viewPx) {
      throw new Error('the laserline view does not draw: keep its window visible (not minimised or covered)');
    }
    return viewPx;
  }

  /** The user's line must stay where it was: the calibration is measured around it. */
  private throwIfMoved(run: Run): void {
    const metric = this.link.metric();
    if (!metric) {
      throw new Error('laserline’s scan was unloaded during the calibration');
    }
    if (!sameBase(metric.base, run.base)) {
      throw new Error('laserline’s line moved during the calibration');
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error('cancelled');
    }
  }

  /** The recorded features' current values. */
  private snapshot(): Record<string, string> {
    const states = this.session?.states() ?? {};
    const out: Record<string, string> = {};
    for (const name of this.snapshotNames()) {
      const value = states[name]?.value;
      if (value !== null && value !== undefined) out[name] = value;
    }
    return out;
  }

  private setStep(step: string): void {
    this.stepText.set(step);
  }
}

/** What every step of one run shares. */
interface Run {
  source: RangeFrameSource;
  session: string;
  viewPx: ViewPoint;
  base: BaseLine;
  envelope: Envelope | null;
  width: number;
  accept: (f: RangeFrame) => boolean;
  /** Frames after the lag a pattern may take to settle. */
  settleFrames: number;
  lag: number;
  /** The width (view px) lines are drawn in; laserline's calibration width while null. */
  lineWidthPx: number | null;
  /** The last pattern's reduction. */
  previous: ReducedProfiles | null;
  straddled: number;
  patterns: number;
}

/** A filmed calibration line. */
interface Captured {
  planned: PlannedLine;
  reduced: ReducedProfiles;
  columns: number[];
}

/** Why the metric mapping can't be calibrated against, if it can't. */
function metricProblem(metric: unknown): string | null {
  if (metric === undefined) {
    return 'this laserline does not publish its metric mapping: update it (reload its window)';
  }
  return metric === null ? 'load a scan in laserline and enable it' : null;
}

/** The share of the frame's columns that see a line. */
function seenShare(f: RangeFrame): number {
  return seenColumns(reduceProfiles([f.pixels], f.width)).length / f.width;
}

/** The first and the second half of the profiles in `frames` (by frame when there are several). */
function halves(frames: readonly RangeFrame[], width: number): [ReducedProfiles, ReducedProfiles] {
  if (frames.length === 1) {
    const f = frames[0];
    const split = (f.height >> 1) * width;
    return [reduceProfiles([f.pixels.subarray(0, split)], width), reduceProfiles([f.pixels.subarray(split)], width)];
  }
  const split = frames.length >> 1;
  return [reduceProfiles(frames.slice(0, split).map((f) => f.pixels), width), reduceProfiles(frames.slice(split).map((f) => f.pixels), width)];
}

/**
 * Whether two halves of a pattern's frames show the same thing. A parallel line both halves see in
 * under `RANGE_BAND_SHARE` of the columns is lost to the band search either way: the few columns
 * left at the band's edge are noise, and would never agree (seen on the AT C6: 68 of 3072 columns,
 * 18 of them differing). Crossing lines light few columns by design and keep the full check.
 */
export function patternHalvesAgree(kind: PlannedLine['kind'], a: ReducedProfiles, b: ReducedProfiles, width: number): boolean {
  if (kind === 'parallel') {
    const lost = RANGE_BAND_SHARE * width;
    if (seenColumns(a).length < lost && seenColumns(b).length < lost) {
      return true;
    }
  }
  return agree(a, b);
}

/** `profilesAgree` within `tolerance(a, b)`. */
function agree(a: ReducedProfiles, b: ReducedProfiles): boolean {
  return profilesAgree(a, b, tolerance(a, b));
}

/**
 * `RANGE_AGREE_MADS` × the median MAD of the columns either sees, at least one value. Only seen
 * columns count: a real camera's stray values leave thousands of columns with a single value and a
 * MAD of 0, which would pull a short crossing line's tolerance down to the floor.
 */
function tolerance(a: ReducedProfiles, b: ReducedProfiles): number {
  const mads: number[] = [];
  for (const r of [a, b]) {
    for (const c of seenColumns(r)) {
      if (Number.isFinite(r.mad[c])) mads.push(r.mad[c]);
    }
  }
  mads.sort((x, y) => x - y);
  const mad = mads.length ? mads[mads.length >> 1] : 0;
  return Math.max(1, RANGE_AGREE_MADS * mad);
}

/** What kept a pattern from settling, for its error. */
function unsettled(why: { frames: number; split: number; last: (ProfilesDisagreement & { tolerance: number }) | null }): string {
  const parts = [`${why.frames} frames, ${why.split} with halves that disagree`];
  const d = why.last;
  if (d && d.counted > 0) {
    parts.push(
      `last: of ${d.counted} columns seeing a line, ${d.seenByOne} seen in one half only; the halves ${Math.abs(d.shift).toFixed(1)} values apart (${d.tolerance.toFixed(1)} allowed)`,
    );
  }
  return parts.join('; ');
}

/** Where the base line runs inside the view, along `dir` from its centre. */
function viewRun(base: BaseLine, [w, h]: ViewPoint): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [p, d, size] of [[base.center_px[0], base.dir[0], w], [base.center_px[1], base.dir[1], h]]) {
    if (Math.abs(d) < 1e-9) continue;
    const [t0, t1] = [-p / d, (size - p) / d].sort((x, y) => x - y);
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
  }
  return hi > lo ? [lo, hi] : [0, 0];
}

function calibrationOf(run: Run, captured: Captured[], obs: RangeObservation[], fit: RangeMap, camera: Record<string, string>): RangeCalibration {
  const byLine = new Map(fit.perLine.map((l) => [l.line.join(','), l]));
  const band = captured.filter((c) => c.planned.kind === 'parallel' && c.columns.length >= RANGE_BAND_SHARE * run.width).map((c) => c.planned.at);
  return {
    v: 1,
    g: fit.g,
    model: fit.model,
    viewPx: [run.viewPx[0], run.viewPx[1]],
    camera,
    rms: fit.rms,
    max: fit.max,
    lines: captured.map((c) => {
      const r = byLine.get(c.planned.line.join(','));
      return { kind: c.planned.kind, at: c.planned.at, sign: c.planned.sign, columns: c.columns.length, n: r?.n ?? 0, dropped: r?.dropped ?? 0, rms: r?.rms ?? 0, max: r?.max ?? 0 };
    }),
    columns: extent(obs.map((o) => o.c)),
    values: extent(obs.map((o) => o.r)),
    band: [Math.min(...band), Math.max(...band)],
    base: run.base,
    ...(run.lineWidthPx === null ? {} : { lineWidthPx: run.lineWidthPx }),
    at: Date.now(),
  };
}

/** A pattern never settled: the halves of its frames kept disagreeing. */
class UnsettledError extends Error {}

/** `pattern` drawn `widthPx` wide (view px) when it is a line and a width is set. */
function withLineWidth(pattern: Pattern, widthPx: number | null, [w, h]: ViewPoint): Pattern {
  if (pattern.kind !== 'line' || widthPx === null) {
    return pattern;
  }
  return { ...pattern, width_pct: (100 * widthPx) / (pattern.orientation === 'Horizontal' ? h : w) };
}

/** Per column, the largest distance of its observations from their lines under `g`. */
function columnResiduals(obs: readonly RangeObservation[], g: Mat3, width: number): Float64Array {
  const out = new Float64Array(width).fill(NaN);
  for (const { c, r, line } of obs) {
    const d = distanceTo(g, c, r, line);
    out[c] = Number.isNaN(out[c]) ? d : Math.max(out[c], d);
  }
  return out;
}

/** How far `g` puts (c, r) from `line`, view px. */
function distanceTo(g: Mat3, c: number, r: number, line: readonly [number, number, number]): number {
  const w = g[6] * c + g[7] * r + g[8];
  const x = (g[0] * c + g[1] * r + g[2]) / w;
  const y = (g[3] * c + g[4] * r + g[5]) / w;
  return Math.abs(line[0] * x + line[1] * y + line[2]);
}

/** One line per pattern: where it was, how many columns saw it, their median MAD and its residual. */
function logLines(captured: readonly Captured[], fit: RangeMap | null): void {
  const byLine = new Map(fit?.perLine.map((l) => [l.line.join(','), l]) ?? []);
  for (const c of captured) {
    const mads = c.columns.map((col) => c.reduced.mad[col]).sort((a, b) => a - b);
    const r = byLine.get(c.planned.line.join(','));
    console.debug(
      `[range calibration] ${c.planned.kind} ${c.planned.kind === 'parallel' ? `${signed(c.planned.at)} px` : `at ${signed(c.planned.at)} px ${c.planned.sign > 0 ? '+' : '−'}${RANGE_CROSSING_ANGLE_DEG}°`}`,
      { columns: c.columns.length, mad: mads.length ? mads[mads.length >> 1] : null, rms: r?.rms, max: r?.max, dropped: r?.dropped },
    );
  }
}

/** A recorded selector is not compared: another value of it selects other features, it doesn't change them. */
function isSelector(name: string, selected: string[] | undefined): boolean {
  return /Selector$/.test(name) || !!selected?.length;
}

function sameView(a: ViewPoint, b: ViewPoint): boolean {
  return Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
}

function sameBase(a: BaseLine, b: BaseLine): boolean {
  return sameView(a.center_px, b.center_px) && Math.abs(a.dir[0] - b.dir[0]) < 1e-4 && Math.abs(a.dir[1] - b.dir[1]) < 1e-4;
}

/** [min, max]; reduced, since thousands of values are too many arguments for `Math.min`. */
function extent(values: readonly number[]): [number, number] {
  return values.reduce<[number, number]>(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity]);
}

function signed(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}`;
}

function span([lo, hi]: [number, number]): string {
  return `${signed(lo)}…${signed(hi)}`;
}

function percent(share: number): number {
  return Math.round(share * 100);
}

/** A stored calibration, if it is one. */
function parseCalibration(raw: string | null): RangeCalibration | null {
  try {
    const c = raw ? (JSON.parse(raw) as RangeCalibration) : null;
    return c && c.v === 1 && Array.isArray(c.g) && c.g.length === 9 && Array.isArray(c.viewPx) && c.camera && c.base ? c : null;
  } catch {
    return null;
  }
}

function load(key: string): RangeCalibration | null {
  try {
    return parseCalibration(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key: string, cal: RangeCalibration): void {
  try {
    localStorage.setItem(key, JSON.stringify(cal));
  } catch {
    // Kept for this session only.
  }
}
