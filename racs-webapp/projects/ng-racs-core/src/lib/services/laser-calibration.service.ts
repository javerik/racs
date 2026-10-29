import { Injectable, OnDestroy, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import { maxValue, type GrayFrame } from '../imaging/frame';
import { type Point } from '../imaging/homography';
import {
  cameraField,
  checkFrame,
  fieldFraction,
  fullWidth,
  MAX_RMS_PX,
  proposeRegion,
  REGION_MARGIN_PX,
  regionInView,
  residualTiles,
  travelArea,
  type Calibration,
  type Edge,
  type RegionProposal,
  type TravelArea,
} from '../imaging/laser-calibration';
import { decodeGray, downsample, grayBits, meanDifference, meanLevel, solveTrimmed, type CodeFrames, type SmallPlane } from '../imaging/gray-code';
import { toPlane, type ScanAxis } from '../imaging/laser-line';
import { fitTilt, lineAngle, lineAxis, nextTilt, type TiltSample } from '../imaging/line-tilt';
import { fullRegion, regionFromStates, regionLimits, regionWrites, sameRegion, sensorSize, type Region } from '../imaging/region';
import type { Size } from '../imaging/view';
import type { Orientation, Pattern, ViewPoint } from '../laserline/protocol';
import { deviceStorageKey, migrateStorage } from './device-key';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceSelectionService } from './device-selection.service';
import { errorMessage, GenicamSession } from './genicam-session.service';
import { LaserlineLinkService } from './laserline-link.service';
import { RacsService } from './racs.service';
import { LASERLINE_TOOL, ToolWindowService } from './tool-window.service';
import { RACS_CONFIG } from '../config';

/** Kept per camera by `deviceStorageKey`; formerly per server device id (`<prefix>.<id>`, migrated). */
const STORAGE_PREFIX = 'racs.laserline.calib';
const TILT_STORAGE_PREFIX = 'racs.laserline.tilt';
/**
 * Frames (by the server's frame numbers) that can still show the previous pattern after laserline
 * reports a new one on screen: the camera's buffers, the server's queue and the socket hold
 * several. Counted in frame numbers, not in frames the page shows: a busy page skips and delays
 * frames, the numbers don't change. Measured at the start of each run with a flash; this is the
 * guess the measurement waits with.
 */
const INITIAL_LAG_FRAMES = 8;
/** The flash must show within this many frames, or the camera does not see the display. */
const MAX_LAG_FRAMES = 40;
/** Frames after the lag in which two in a row must agree. */
const SETTLE_FRAMES = 10;
/** Fewer decoded cells than this map nothing. */
const MIN_PAIRS = 8;
/** Crossing points drawn on the sensor at most. */
const MAX_POINTS = 400;
/** How long to wait for one frame, or for the stream after a region change. */
const FRAMES_MS = 6_000;
/** How long the line check watches the stream. */
const CHECK_MS = 3_000;
const CHECK_FRAMES = 60;
/** Distance kept between the line and the camera field's edge when laserline fits it, view px. */
const FIT_MARGIN_PX = 12;
/** The levelling's first tilts, degrees from the user's. */
const TILT_SWEEP_DEG = [-4, -2, 0, 2, 4];
/** Secant steps after the sweep at most. */
const TILT_REFINE_STEPS = 4;
/** A line this close to the sensor axis counts as level, degrees. */
const LEVEL_DEG = 0.02;
/** Two frames of one tilt must agree on the line's angle within this, degrees. */
const TILT_AGREE_DEG = 0.05;
/** Laserline's tilt range, degrees either way. */
const MAX_TILT_DEG = 45;

/** A frame, when it arrived (`performance.now()`) and the server's number for it. */
export interface TimedFrame {
  frame: GrayFrame;
  at: number;
  /** Counts up with every frame the server sends, in capture order. */
  number: number;
}

/** Live frames for the calibration; implemented by the live view. */
export interface FrameSource {
  /** The live stream runs. */
  live: Signal<boolean>;
  /** Why the region can't be written now, if it can't. */
  regionBlocked: Signal<string | null>;
  /**
   * The next `count` frames that arrive after `after` (a `performance.now()` time) and pass
   * `accept`. Rejects after `timeoutMs`, or resolves with what came by then with `partial`.
   */
  frames(count: number, after: number, options?: { accept?: (f: GrayFrame) => boolean; timeoutMs?: number; partial?: boolean }): Promise<TimedFrame[]>;
  /** Puts a region into the region editor as its draft. */
  propose(region: Region): void;
  /** The number of the newest frame received so far (whether shown yet or not); -1 before any. */
  latestNumber(): number;
}

export type CalibrationPhase = 'idle' | 'running' | 'done' | 'failed';

/** The calibration wizard's steps, in order. */
export const WIZARD_STEPS = ['prepare', 'capture', 'review', 'tilt', 'region', 'limits', 'check'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * What the camera region is made from: the smallest one holding the user's line over its whole
 * movement, or every part of the sensor that sees the laserline view (where a line can travel).
 */
export type RegionMode = 'line' | 'travel';

/** What a running calibration films now: `bit` patterns of that axis are done. */
export interface CaptureStage {
  key: 'blank' | 'white' | 'x' | 'y' | 'solve';
  bit: number;
}

/** The levelling's outcome: the tilt at which the filmed line runs along the sensor axis. */
export interface TiltResult {
  /** Laserline tilt, degrees. */
  tilt: number;
  /** The filmed line's angle at that tilt, degrees from the sensor axis. */
  angle: number;
  /** Its straightness, px rms around a straight line. */
  rms: number;
  /** Sensor degrees per laserline degree (negative when the camera mirrors the view). */
  gain: number;
  /** The sensor axis the line runs along: `x` levels it to the rows, `y` to the columns. */
  axis: ScanAxis;
  orientation: Orientation;
  /** Laserline view size it was measured with. */
  viewPx: ViewPoint;
  at: number;
}

/** What the line check saw. */
export interface LineCheck {
  frames: number;
  complete: number;
  cut: number;
  none: number;
  edges: Edge[];
}

/**
 * Calibrates a camera against the laserline tool and proposes the camera region that holds the
 * line's whole envelope (design: the "Laserline calibration" section of CLAUDE.md).
 *
 * 1. Writes the full sensor (the region is put back afterwards) and has laserline go blank, then
 *    flash: the frames until the flash shows are the stream's lag, waited out after every pattern.
 * 2. Finds the part of the view the camera sees (usually a small one): bands across the view,
 *    then bands across the lit range, until the field spans several.
 * 3. Shows lines inside the field, finds each in the frames, crosses horizontal with vertical
 *    ones, and solves the screen → sensor homography from the crossings, dropping misread lines.
 * 4. Tells laserline the camera's field; if the user's line does not fit it, has laserline fit it
 *    in.
 *
 * The calibration is kept per camera (by MAC), and the proposal follows the envelope while the user
 * changes the line. The wizard (`wizard`) then sets the camera region (`target`: around the line,
 * or the travel area that sees the whole view) and can have laserline keep its line inside it
 * (`applyLimits`). Provided by the live view, which attaches its frames.
 */
@Injectable()
export class LaserCalibrationService implements OnDestroy {
  private readonly link = inject(LaserlineLinkService);
  private readonly tools = inject(ToolWindowService);
  /** The configured laserline window. */
  private readonly laserline = inject(RACS_CONFIG).tools.find((t) => t.id === LASERLINE_TOOL.id) ?? LASERLINE_TOOL;
  private readonly session = inject(GenicamSession, { optional: true });
  private readonly racs = inject(RacsService);
  private readonly selection = inject(DeviceSelectionService);
  private readonly registry = inject(DeviceRegistryService);

  readonly phase = signal<CalibrationPhase>('idle');
  /** What a running calibration does now, for the status line. */
  readonly step = signal('');
  /** 0..1 while running. */
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);
  /** The device's calibration, from this run or kept from an earlier one. */
  readonly calibration = signal<Calibration | null>(null);
  /** Where the grid crossings landed on the sensor in the last run. */
  readonly points = signal<Point[]>([]);
  readonly checking = signal(false);
  readonly check = signal<LineCheck | null>(null);
  readonly fitting = signal(false);
  /** Something worth knowing about the last run that is not an error. */
  readonly note = signal<string | null>(null);

  /** The wizard's step; null while it is closed. */
  readonly wizard = signal<WizardStep | null>(null);
  readonly regionMode = signal<RegionMode>('travel');
  /** In `line` mode, crop rows only and keep the sensor's whole width. */
  readonly rowsOnly = signal(false);
  /** The Gray-code bits of the running (or last) calibration, per axis. */
  readonly plan = signal<{ bitsX: number; bitsY: number } | null>(null);
  readonly stage = signal<CaptureStage | null>(null);
  /** The target region is being written. */
  readonly applying = signal(false);
  /** Keep laserline's line inside the target region. */
  readonly limitsOn = signal(true);
  /** Limits are being sent to laserline. */
  readonly limiting = signal(false);
  /** What laserline answered the last limits with. */
  readonly limitResult = signal<{ clamped: string[]; released: boolean } | null>(null);
  readonly limitError = signal<string | null>(null);

  /** The line is being levelled. */
  readonly levelling = signal(false);
  /** The levelling's measurements so far: the filmed angle at each tilt. */
  readonly tiltSamples = signal<TiltSample[]>([]);
  /** The device's levelling, from this run or kept from an earlier one. */
  readonly tiltResult = signal<TiltResult | null>(null);
  readonly tiltError = signal<string | null>(null);
  /** The tilt is being sent to laserline. */
  readonly tilting = signal(false);

  private source: FrameSource | null = null;
  private cancelled = false;
  private patternId = 0;
  /** Frames that may still show the previous pattern; see INITIAL_LAG_FRAMES. */
  private lag = INITIAL_LAG_FRAMES;
  /**
   * Two frames of one pattern differ by at most this (mean absolute difference, grey levels): 2 %
   * of the range until the blank view shows the camera's noise.
   */
  private tolerance: number | null = null;
  /** How much the two frames a capture agreed on differed. */
  private pairDifference = 0;

  /** Where the device's calibration and levelling are kept; null until the registry lists it. */
  private readonly device = computed(() => {
    const id = this.selection.selectedDeviceId();
    return id === null ? null : this.registry.find(id);
  });
  private readonly calibKey = computed(() => deviceStorageKey(STORAGE_PREFIX, this.device()));
  private readonly tiltKey = computed(() => deviceStorageKey(TILT_STORAGE_PREFIX, this.device()));

  readonly linkStatus = this.link.status;
  /** The user's line tilt in laserline; null from a laserline that can't set it. */
  readonly currentTilt = computed(() => this.link.status()?.tilt_deg ?? null);
  /** Laserline's line has the levelled tilt. */
  readonly tiltApplied = computed(() => {
    const r = this.tiltResult();
    const t = this.currentTilt();
    return !!r && t !== null && Math.abs(r.tilt - t) < 0.005;
  });
  readonly limits = computed(() => (this.session ? regionLimits(this.session.states()) : null));
  readonly current = computed(() => (this.session ? regionFromStates(this.session.states()) : null));

  /** The calibration was measured with another laserline view size: the mapping no longer holds. */
  readonly stale = computed(() => {
    const cal = this.calibration();
    const status = this.link.status();
    return !!cal && !!status && !sameView(cal.viewPx, status.viewPx);
  });

  /** The region holding laserline's line envelope, from the calibration. */
  readonly proposal = computed<RegionProposal | null>(() => {
    const cal = this.calibration();
    const status = this.link.status();
    const limits = this.limits();
    if (!cal || !status?.envelope || !limits || this.stale()) {
      return null;
    }
    if (limits.x.extent !== cal.sensor.width || limits.y.extent !== cal.sensor.height) {
      return null;
    }
    return proposeRegion(cal, status.envelope, limits, this.margin());
  });

  /** Free sensor px kept around the line: a rough mapping gets a wider margin. */
  readonly margin = computed(() => REGION_MARGIN_PX + Math.ceil(2 * (this.calibration()?.rms ?? 0)));

  /** The sensor part that sees the laserline view, and the region holding it. */
  readonly travel = computed<TravelArea | null>(() => {
    const cal = this.calibration();
    const limits = this.limits();
    if (!cal || !limits || this.stale() || limits.x.extent !== cal.sensor.width || limits.y.extent !== cal.sensor.height) {
      return null;
    }
    return travelArea(cal, limits);
  });

  /** The region the wizard proposes, by `regionMode`. */
  readonly target = computed<Region | null>(() => {
    if (this.regionMode() === 'travel') {
      return this.travel()?.region ?? null;
    }
    const p = this.proposal();
    const limits = this.limits();
    return p && limits ? (this.rowsOnly() ? fullWidth(p.region, limits) : p.region) : null;
  });

  /** The device holds the target region. */
  readonly targetApplied = computed(() => sameRegion(this.target(), this.current()));

  /** The target region, `margin` inside its edges, in laserline view px: where the line may go. */
  readonly limitPolygon = computed(() => {
    const cal = this.calibration();
    const target = this.target();
    if (!cal || !target || this.stale()) {
      return null;
    }
    const polygon = regionInView(cal, target, this.margin());
    return polygon.length >= 3 ? polygon : null;
  });

  /** Laserline keeps its line in an area now (one set by any controller). */
  readonly limited = computed(() => !!this.link.status()?.constraint?.length);

  /** The live stream runs. */
  readonly live = computed(() => this.source?.live() ?? false);
  /** Why the region can't be written now, if it can't. */
  readonly regionBlocked = computed(() => this.source?.regionBlocked() ?? null);

  /** Share of the laserline view the camera sees. */
  readonly fieldShare = computed(() => {
    const cal = this.calibration();
    return cal ? fieldFraction(cameraField(cal), cal.viewPx) : null;
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

  /** The camera scans areas; null if it has no scan type. */
  readonly areascan = computed(() => {
    const t = this.scanType();
    return t === null ? null : /^areascan$/i.test(t);
  });

  /** Why a calibration can't start now, if it can't. */
  readonly blocked = computed<string | null>(() => {
    if (!this.session) {
      return 'no feature access';
    }
    if (!this.source?.live()) {
      return 'start the live stream first';
    }
    if (this.areascan() === false) {
      return 'switch the scan type to areascan';
    }
    if (!this.limits() || !this.current()) {
      return 'reading region…';
    }
    if (!this.calibKey()) {
      return 'reading device…';
    }
    return this.source.regionBlocked();
  });

  constructor() {
    // Each camera keeps its own calibration. Keyed by the strings only: a registry update that
    // keeps the MAC must not cancel a running calibration.
    effect(() => {
      const key = this.calibKey();
      const tiltKey = this.tiltKey();
      untracked(() => {
        this.cancel();
        this.calibration.set(key === null ? null : load(key));
        this.points.set([]);
        this.check.set(null);
        this.error.set(null);
        this.phase.set('idle');
        this.wizard.set(null);
        this.limitResult.set(null);
        this.limitError.set(null);
        this.tiltResult.set(tiltKey === null ? null : loadTilt(tiltKey));
        this.tiltSamples.set([]);
        this.tiltError.set(null);
      });
    });

    // Calibrations kept by device id before they were kept by MAC. Ids are handed out again after
    // a server restart, so one is only taken over by a camera with its sensor size; it was
    // measured in areascan, where the extent is read the same way.
    effect(() => {
      const id = this.selection.selectedDeviceId();
      const key = this.calibKey();
      const tiltKey = this.tiltKey();
      const limits = this.limits();
      if (id === null || !key || !tiltKey || !limits || this.areascan() === false) {
        return;
      }
      untracked(() => this.migrate(id, key, tiltKey, sensorSize(limits)));
    });

    // While the wizard shows a region, it is the region editor's draft (so the overlay shows it).
    effect(() => {
      const step = this.wizard();
      const target = this.target();
      if (target && (step === 'region' || step === 'limits')) {
        untracked(() => this.source?.propose(target));
      }
    });
  }

  ngOnDestroy(): void {
    this.cancel();
    this.source = null;
  }

  private migrate(id: number, key: string, tiltKey: string, sensor: Size): void {
    let accepted: boolean | null = null;
    migrateStorage(`${STORAGE_PREFIX}.${id}`, key, (raw) => {
      const cal = parseCalibration(raw);
      accepted = !!cal && cal.sensor.width === sensor.width && cal.sensor.height === sensor.height;
      return accepted;
    });
    if (accepted === null) {
      return;
    }
    const legacyTilt = `${TILT_STORAGE_PREFIX}.${id}`;
    if (!accepted) {
      // Another camera's levelling, like its calibration.
      try {
        localStorage.removeItem(legacyTilt);
      } catch {
        // Nothing kept.
      }
      return;
    }
    migrateStorage(legacyTilt, tiltKey);
    if (!this.calibration() && this.phase() !== 'running') {
      this.calibration.set(load(key));
    }
    if (!this.tiltResult() && !this.levelling()) {
      this.tiltResult.set(loadTilt(tiltKey));
    }
  }

  attach(source: FrameSource): void {
    this.source = source;
  }

  /** Stops a running calibration at its next step; the region is put back. */
  cancel(): void {
    if (this.phase() === 'running' || this.levelling()) {
      this.cancelled = true;
    }
  }

  /** Puts the target region into the region editor. */
  useProposal(): void {
    const target = this.target();
    if (target && this.source) {
      this.source.propose(target);
    }
  }

  openWizard(): void {
    this.error.set(null);
    this.limitError.set(null);
    this.wizard.set('prepare');
    if (this.link.supported) {
      void this.link.hello();
    }
  }

  /** Closes the wizard; a running calibration stops and puts the region back. */
  closeWizard(): void {
    this.cancel();
    this.wizard.set(null);
  }

  /** The wizard's Calibrate: films the patterns, then moves on to the review if that worked. */
  async wizardCalibrate(): Promise<void> {
    this.wizard.set('capture');
    await this.calibrate();
    if (this.phase() === 'done' && this.wizard() === 'capture') {
      this.wizard.set('review');
    }
  }

  /** Switches the camera to area scan (the calibration films whole images). */
  useAreascan(): void {
    const entry = this.session?.nodes().get('DeviceScanType')?.enums?.find((e) => /^areascan$/i.test(e.string_value ?? e.display_name));
    if (entry) {
      this.session!.write('DeviceScanType', String(entry.value));
    }
  }

  /** Opens (or finds) the laserline window. Call from a click. */
  async openLaserline(): Promise<void> {
    this.error.set(null);
    try {
      await this.link.connect(() => this.tools.open(this.laserline));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** Writes the target region to the camera; resolves with whether it did. */
  async applyTarget(): Promise<boolean> {
    const target = this.target();
    const current = this.current();
    if (!this.session || !target || !current || this.applying() || this.phase() === 'running') {
      return false;
    }
    const blocked = this.regionBlocked();
    if (blocked) {
      this.error.set(blocked);
      return false;
    }
    this.applying.set(true);
    this.error.set(null);
    try {
      await this.writeRegion(current, target);
      return true;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    } finally {
      this.applying.set(false);
    }
  }

  /**
   * Sends the limits to laserline (with `limitsOn`), or releases ones it keeps; resolves with
   * whether laserline took them. Call from a click: may open the laserline window.
   */
  async applyLimits(): Promise<boolean> {
    const polygon = this.limitsOn() ? this.limitPolygon() : null;
    if (this.limitsOn() && !polygon) {
      return false;
    }
    if (!polygon && !this.limited()) {
      this.limitResult.set(null);
      return true;
    }
    this.limiting.set(true);
    this.limitError.set(null);
    try {
      await this.link.connect(() => this.tools.open(this.laserline));
      const id = this.selection.selectedDeviceId();
      const clamped = await this.link.constrain(polygon, id === null ? 'RACS' : `RACS · camera #${id}`);
      this.limitResult.set({ clamped, released: !polygon });
      await this.link.hello();
      return true;
    } catch (e) {
      this.limitError.set(errorMessage(e));
      return false;
    } finally {
      this.limiting.set(false);
    }
  }

  /** Has laserline move and shrink the line into the camera field. */
  async fitLine(): Promise<void> {
    this.fitting.set(true);
    this.error.set(null);
    try {
      await this.link.connect(() => this.tools.open(this.laserline));
      this.resendField();
      const fits = await this.link.fitToField(FIT_MARGIN_PX);
      if (!fits) {
        this.error.set('the line’s deformation or scan height is larger than the camera field');
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.fitting.set(false);
    }
  }

  /** Call from a click: may open the laserline window. */
  async calibrate(): Promise<void> {
    const deviceId = this.selection.selectedDeviceId();
    const limits = this.limits();
    const saved = this.current();
    const source = this.source;
    if (this.phase() === 'running' || this.levelling() || this.blocked() || deviceId === null || !limits || !saved || !source) {
      return;
    }
    this.cancelled = false;
    this.phase.set('running');
    this.error.set(null);
    this.check.set(null);
    this.points.set([]);
    this.progress.set(0);
    this.stage.set(null);
    try {
      this.setStep('opening laserline');
      const viewPx = await this.openView();
      const sensor = { width: limits.x.extent, height: limits.y.extent };
      const frames = await this.withFullSensor(saved, (m) => this.error.set(m), (accept) =>
        this.link.runSession(`racs-${deviceId}`, (session) => {
          // Analysed at about 1000 px across: a large sensor costs one pass over its bytes.
          const run: Run = { session, viewPx, accept, factor: Math.max(1, Math.round(sensor.width / 1000)), range: 255 };
          return this.filmCode(run);
        }),
      );

      this.setStep('solving');
      this.stage.set({ key: 'solve', bit: 0 });
      this.progress.set(0.96);
      const contrast = contrastOf(frames);
      const decoded = decodeGray(frames, Math.max(6, 0.3 * contrast));
      const solved = decoded.pairs.length >= MIN_PAIRS ? solveTrimmed(decoded.pairs) : null;
      console.debug('[laserline calibration] decoded', {
        contrast: +contrast.toFixed(1),
        litPixels: decoded.litPixels,
        cells: decoded.pairs.length,
        cellPx: [2 ** decoded.bitX, 2 ** decoded.bitY],
        rms: solved?.rms,
        used: solved?.used.length,
        lag: this.lag,
      });
      if (!solved) {
        throw new Error(
          decoded.litPixels === 0
            ? 'the camera does not see the laserline view: aim it at the display and check the exposure'
            : `the camera sees too little of the laserline view to map it (${decoded.pairs.length} cells): is the display sharp in the image?`,
        );
      }
      const tiles = residualTiles(solved.h, solved.used, sensor);
      console.debug('[laserline calibration] residuals by sensor tile (px)', tiles.map((t) => t?.toFixed(1) ?? '-'));
      if (solved.rms > MAX_RMS_PX) {
        throw new Error(
          `the stripes do not fit one mapping (rms ${solved.rms.toFixed(1)} px over ${solved.used.length} cells): is the display sharp in the image, and still?`,
        );
      }
      const cal: Calibration = { h: solved.h, viewPx: [viewPx[0], viewPx[1]], sensor, rms: solved.rms, pairs: solved.used.length, at: Date.now(), tiles };
      this.calibration.set(cal);
      // A sample of the cells for the overlay; there may be thousands.
      const step = Math.max(1, Math.ceil(solved.used.length / MAX_POINTS));
      this.points.set(solved.used.filter((_, i) => i % step === 0).map((p) => p.to));
      const key = this.calibKey();
      if (key) {
        store(key, cal);
      }
      this.resendField();
      await this.fitIfNeeded();
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
   * Finds the tilt of laserline's line at which the camera sees it run along the sensor rows (or
   * columns, for a line along them): films the line at a sweep of tilts around the user's, fits the
   * filmed angle against the tilt, then steps by the secant until the line is level. The line is
   * shown where the user's runs, in its orientation; the full sensor is written meanwhile and the
   * region put back. Call from a click: may open the laserline window.
   */
  async levelLine(): Promise<void> {
    const deviceId = this.selection.selectedDeviceId();
    const saved = this.current();
    if (this.levelling() || this.phase() === 'running' || this.blocked() || deviceId === null || !saved || !this.source) {
      return;
    }
    this.cancelled = false;
    this.levelling.set(true);
    this.tiltError.set(null);
    this.tiltSamples.set([]);
    this.progress.set(0);
    try {
      this.setStep('opening laserline');
      const viewPx = await this.openView();
      const status = this.link.status();
      const start = status?.tilt_deg ?? 0;
      const env = status?.envelope;
      // The user's line, its tilt taken out: the orientation it was drawn in and where it runs.
      const angle = env ? Math.atan2(env.dir[1], env.dir[0]) - (start * Math.PI) / 180 : 0;
      const orientation: Orientation = Math.abs(Math.cos(angle)) >= Math.abs(Math.sin(angle)) ? 'Horizontal' : 'Vertical';
      const across = orientation === 'Horizontal' ? 1 : 0;
      const position_pct = env ? Math.max(2, Math.min(98, (100 * env.center_px[across]) / viewPx[across])) : 50;
      const line = (tilt: number): Pattern => ({ kind: 'line', orientation, position_pct, tilt_deg: tilt });

      const result = await this.withFullSensor(saved, (m) => this.tiltError.set(m), (accept) =>
        this.link.runSession(`racs-${deviceId}`, async (session) => {
          const run: Run = { session, viewPx, accept, factor: 1, range: 255 };
          const axis = await this.findLine(run, line(start));
          const total = TILT_SWEEP_DEG.length + TILT_REFINE_STEPS;
          const samples: TiltSample[] = [];
          const measure = async (tilt: number) => {
            this.setStep(`tilt ${tilt.toFixed(2)}° · ${samples.length + 1}`);
            this.progress.set(0.05 + (0.9 * samples.length) / total);
            const sample = await this.measureTilt(run, line(tilt), tilt, axis);
            samples.push(sample);
            this.tiltSamples.set([...samples]);
            console.debug('[laserline levelling] sample', sample);
            return sample;
          };
          for (const d of TILT_SWEEP_DEG) {
            await measure(clampTilt(start + d));
          }
          const model = fitTilt(samples);
          if (!model) {
            throw new Error('tilting the line in laserline does not turn it in the camera image: update laserline (reload its window)');
          }
          for (let i = 0; i < TILT_REFINE_STEPS; i++) {
            const best = closestToLevel(samples);
            if (Math.abs(best.angle) < LEVEL_DEG) break;
            const next = nextTilt(samples) ?? model.tilt;
            if (Math.abs(next) > MAX_TILT_DEG) {
              throw new Error(`the line would need ${next.toFixed(1)}° of tilt (laserline allows ±${MAX_TILT_DEG}°): is the camera turned against the display?`);
            }
            await measure(next);
          }
          const best = closestToLevel(samples);
          const gain = fitTilt(samples)?.gain ?? model.gain;
          return { tilt: best.tilt, angle: best.angle, rms: best.rms, gain, axis, orientation, viewPx: [viewPx[0], viewPx[1]], at: Date.now() } satisfies TiltResult;
        }),
      );
      this.tiltResult.set(result);
      const tiltKey = this.tiltKey();
      if (tiltKey) {
        storeTilt(tiltKey, result);
      }
      this.progress.set(1);
    } catch (e) {
      this.tiltError.set(this.cancelled ? 'cancelled' : errorMessage(e));
    } finally {
      this.cancelled = false;
      this.levelling.set(false);
      this.setStep('');
    }
  }

  /** Sets the levelled tilt as laserline's line tilt. Call from a click: may open the laserline window. */
  async applyTilt(): Promise<boolean> {
    const result = this.tiltResult();
    if (!result || this.tilting() || this.levelling()) {
      return false;
    }
    this.tilting.set(true);
    this.tiltError.set(null);
    try {
      await this.link.connect(() => this.tools.open(this.laserline));
      await this.link.setTilt(result.tilt);
      // The tilted line's envelope comes with laserline's next status.
      await this.link.hello();
      return true;
    } catch (e) {
      this.tiltError.set(errorMessage(e));
      return false;
    } finally {
      this.tilting.set(false);
    }
  }

  /** Watches the stream for a few seconds and counts frames showing the whole line. */
  async checkLine(): Promise<void> {
    const source = this.source;
    // The line's direction comes from its envelope; without laserline, lines run across the image.
    const axis = this.proposal()?.axis ?? 'x';
    if (!source || this.checking() || !source.live()) {
      return;
    }
    this.checking.set(true);
    this.check.set(null);
    try {
      const frames = await source.frames(CHECK_FRAMES, performance.now(), { timeoutMs: CHECK_MS, partial: true });
      const result: LineCheck = { frames: frames.length, complete: 0, cut: 0, none: 0, edges: [] };
      const edges = new Set<Edge>();
      for (const { frame: f } of frames) {
        const c = checkFrame(toPlane(f), axis);
        result[c.state]++;
        c.edges.forEach((e) => edges.add(e));
      }
      result.edges = [...edges];
      this.check.set(result);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.checking.set(false);
    }
  }

  /** Forgets the device's calibration and the field shown in laserline. */
  forget(): void {
    const key = this.calibKey();
    this.calibration.set(null);
    this.points.set([]);
    this.check.set(null);
    if (key !== null) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing kept.
      }
    }
    if (this.link.host()) {
      this.link.setField(null);
    }
  }

  private resendField(): void {
    const cal = this.calibration();
    const id = this.selection.selectedDeviceId();
    if (cal && !this.stale()) {
      this.link.setField(cameraField(cal), id === null ? 'Camera' : `Camera #${id}`);
    }
  }

  /**
   * Films the Gray code: the blank view, the white one (whose arrival measures how many frames the
   * stream lags), then each stripe bit of x and of y, highest first.
   */
  private async filmCode(run: Run): Promise<CodeFrames> {
    const [vw, vh] = run.viewPx;
    const bitsX = grayBits(vw);
    const bitsY = grayBits(vh);
    const total = 2 + bitsX + bitsY;
    let done = 0;
    this.plan.set({ bitsX, bitsY });
    const step = (name: string, stage: CaptureStage) => {
      this.stage.set(stage);
      this.setStep(`${name} · ${done + 1}/${total}`);
      this.progress.set(0.05 + (0.9 * done++) / total);
    };
    this.lag = INITIAL_LAG_FRAMES;
    this.tolerance = null;
    step('blank', { key: 'blank', bit: 0 });
    const black = await this.capture(run, { kind: 'blank' }, null);
    this.tolerance = Math.max(0.5, 4 * this.pairDifference, 0.005 * run.range);
    step('white', { key: 'white', bit: 0 });
    const white = await this.captureWhite(run, black);
    const x: SmallPlane[] = [];
    const y: SmallPlane[] = [];
    let previous = white;
    for (const [orientation, out, bits] of [['Vertical', x, bitsX], ['Horizontal', y, bitsY]] as const) {
      for (let bit = bits - 1; bit >= 0; bit--) {
        const key = orientation === 'Vertical' ? 'x' : 'y';
        step(`stripes ${key}`, { key, bit: bits - 1 - bit });
        previous = out[bit] = await this.capture(run, { kind: 'stripes', orientation, bit }, previous);
      }
    }
    return { black, white, x, y };
  }

  /**
   * Shows `pattern` and resolves with two agreeing frames of it, averaged. Frames count from the
   * one the lag says shows it; one that still looks like `previous` (the last pattern) counts only
   * once another lag has passed, as a pattern can look the same as the last (coarse stripes the
   * whole field falls into).
   */
  private async capture(run: Run, pattern: Pattern, previous: SmallPlane | null): Promise<SmallPlane> {
    const shown = await this.show(run, pattern);
    const first = shown.from + this.lag + 1;
    const limit = first + 2 * this.lag + SETTLE_FRAMES;
    let after = shown.at;
    let last: SmallPlane | null = null;
    for (;;) {
      const [f] = await this.source!.frames(1, after, { accept: run.accept, timeoutMs: FRAMES_MS });
      after = f.at;
      this.throwIfCancelled();
      if (f.number < first) {
        continue;
      }
      run.range = maxValue(f.frame.bitDepth);
      const tolerance = this.tolerance ?? 0.02 * run.range;
      const plane = downsample(f.frame, run.factor);
      const changed = !previous || meanDifference(plane, previous) > tolerance || f.number > first + this.lag;
      if (last && changed && meanDifference(last, plane) <= tolerance) {
        this.pairDifference = meanDifference(last, plane);
        return average(last, plane);
      }
      if (f.number > limit) {
        throw new Error('the camera image does not settle: is the scene, the light or the exposure changing?');
      }
      last = changed ? plane : null;
    }
  }

  /** Shows the white view; the frames until it shows are the stream's lag from now on. */
  private async captureWhite(run: Run, black: SmallPlane): Promise<SmallPlane> {
    const shown = await this.show(run, { kind: 'white' });
    const dark = meanLevel(black);
    let after = shown.at;
    for (;;) {
      const [f] = await this.source!.frames(1, after, { accept: run.accept, timeoutMs: FRAMES_MS });
      after = f.at;
      this.throwIfCancelled();
      const behind = f.number - shown.from;
      if (behind > 0 && meanLevel(downsample(f.frame, run.factor)) - dark > Math.max(2, 4 * (this.tolerance ?? 0))) {
        // That frame may be exposed while the view turned white: frames count from the next one.
        this.lag = Math.max(1, behind);
        break;
      }
      if (behind > MAX_LAG_FRAMES) {
        throw new Error('the camera does not see the laserline view: aim it at the display and check the exposure');
      }
    }
    console.debug('[laserline calibration] lag', this.lag);
    return this.capture(run, { kind: 'white' }, black);
  }

  /** Shows `pattern`; resolves when it is on screen, with the newest frame number by then. */
  private async show(run: Run, pattern: Pattern): Promise<{ at: number; from: number }> {
    this.throwIfCancelled();
    const shown = await this.link.show(run.session, ++this.patternId, pattern);
    if (!sameView(shown.viewPx, run.viewPx)) {
      throw new Error('the laserline view changed size during the calibration');
    }
    return { at: shown.at, from: this.source!.latestNumber() };
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

  /**
   * Runs `fn` with the full sensor as the camera region (once its first frame came; `accept` passes
   * full frames only), then puts `saved` back. Failing to put it back goes to `report`.
   */
  private async withFullSensor<T>(saved: Region, report: (message: string) => void, fn: (accept: (f: GrayFrame) => boolean) => Promise<T>): Promise<T> {
    const limits = this.limits()!;
    const full = fullRegion(limits);
    const changed = !sameRegion(saved, full);
    try {
      if (changed) {
        this.setStep('full sensor');
        await this.writeRegion(saved, full);
      }
      const accept = (f: GrayFrame) => f.width === full.width && f.height === full.height;
      await this.source!.frames(1, performance.now(), { accept, timeoutMs: FRAMES_MS });
      this.note.set(null);
      return await fn(accept);
    } finally {
      if (changed) {
        this.setStep('restoring region');
        try {
          await this.writeRegion(full, saved);
        } catch (e) {
          report(`could not put the region back: ${errorMessage(e)}`);
        }
      }
    }
  }

  /**
   * Shows a blank view until the camera sees no line, then `pattern`: the frames until it shows are
   * the stream's lag. Resolves with the sensor axis the line runs along.
   */
  private async findLine(run: Run, pattern: Pattern): Promise<ScanAxis> {
    this.setStep('finding the line');
    const blank = await this.show(run, { kind: 'blank' });
    let after = blank.at;
    for (;;) {
      const [f] = await this.source!.frames(1, after, { accept: run.accept, timeoutMs: FRAMES_MS });
      after = f.at;
      this.throwIfCancelled();
      if (!lineAxis(toPlane(f.frame))) break;
      if (f.number - blank.from > MAX_LAG_FRAMES) {
        throw new Error('the camera sees a line while laserline is blank: is there another light in the image?');
      }
    }
    const shown = await this.show(run, pattern);
    after = shown.at;
    for (;;) {
      const [f] = await this.source!.frames(1, after, { accept: run.accept, timeoutMs: FRAMES_MS });
      after = f.at;
      this.throwIfCancelled();
      const behind = f.number - shown.from;
      const axis = behind > 0 ? lineAxis(toPlane(f.frame)) : null;
      if (axis) {
        this.lag = Math.max(1, behind);
        console.debug('[laserline levelling] lag', this.lag, 'axis', axis);
        return axis;
      }
      if (behind > MAX_LAG_FRAMES) {
        throw new Error('the camera does not see the line: aim it at the laserline view, check the exposure, or calibrate and fit the line first');
      }
    }
  }

  /** Shows `pattern` and resolves with the filmed line's angle at `tilt`: two agreeing frames, averaged. */
  private async measureTilt(run: Run, pattern: Pattern, tilt: number, axis: ScanAxis): Promise<TiltSample> {
    const shown = await this.show(run, pattern);
    const first = shown.from + this.lag + 1;
    const limit = first + 2 * this.lag + SETTLE_FRAMES;
    let after = shown.at;
    let last: { angle: number; rms: number } | null = null;
    for (;;) {
      const [f] = await this.source!.frames(1, after, { accept: run.accept, timeoutMs: FRAMES_MS });
      after = f.at;
      this.throwIfCancelled();
      if (f.number < first) {
        continue;
      }
      const a = lineAngle(toPlane(f.frame), axis);
      if (a && last && Math.abs(a.angleDeg - last.angle) <= TILT_AGREE_DEG) {
        return { tilt, angle: (a.angleDeg + last.angle) / 2, rms: (a.rms + last.rms) / 2 };
      }
      if (f.number > limit) {
        throw new Error(
          a
            ? 'the line’s angle does not settle in the image: is the camera or the display moving?'
            : 'the camera loses the tilted line: move the line into the camera’s view (Fit) or widen the view',
        );
      }
      last = a ? { angle: a.angleDeg, rms: a.rms } : null;
    }
  }

  /** If the user's line leaves the camera's view, has laserline fit it into the field. */
  private async fitIfNeeded(): Promise<void> {
    await this.link.hello();
    if (this.proposal()?.complete !== false) {
      return;
    }
    const fits = await this.link.fitToField(FIT_MARGIN_PX);
    // The fitted line's envelope comes with laserline's next status.
    await this.link.hello();
    this.note.set(
      fits
        ? 'the line did not fit the camera’s view: laserline moved and shrank it into the field'
        : 'the line does not fit the camera’s view, and its deformation or scan height is too large to fit',
    );
  }

  private async writeRegion(from: Region, to: Region): Promise<void> {
    const session = this.session!;
    for (const [name, value] of regionWrites(from, to)) {
      await session.change(name, (id) => this.racs.setFeatureValue(id, name, value));
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error('cancelled');
    }
  }

  private setStep(step: string): void {
    this.step.set(step);
  }
}

/** What every step of one run shares. */
interface Run {
  session: string;
  viewPx: ViewPoint;
  accept: (f: GrayFrame) => boolean;
  /** Frames are analysed shrunk by this. */
  factor: number;
  /** The frames' value range (`2^bitDepth - 1`), once one came. */
  range: number;
}

/** The white–blank contrast most lit pixels reach (the 95th percentile). */
function contrastOf(frames: CodeFrames): number {
  const d = frames.white.data.map((w, i) => w - frames.black.data[i]).sort();
  return d.length ? d[Math.floor(d.length * 0.95)] : 0;
}

function average(a: SmallPlane, b: SmallPlane): SmallPlane {
  return { ...a, data: a.data.map((v, i) => (v + b.data[i]) / 2) };
}

function clampTilt(t: number): number {
  return Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, t));
}

function closestToLevel(samples: TiltSample[]): TiltSample {
  return samples.reduce((a, b) => (Math.abs(b.angle) < Math.abs(a.angle) ? b : a));
}

function sameView(a: ViewPoint, b: ViewPoint): boolean {
  return Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
}

/** A stored calibration, if it is one. */
function parseCalibration(raw: string | null): Calibration | null {
  try {
    const c = raw ? (JSON.parse(raw) as Calibration) : null;
    return c && Array.isArray(c.h) && c.h.length === 9 && Array.isArray(c.viewPx) && c.sensor ? c : null;
  } catch {
    return null;
  }
}

function load(key: string): Calibration | null {
  try {
    return parseCalibration(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key: string, cal: Calibration): void {
  try {
    localStorage.setItem(key, JSON.stringify(cal));
  } catch {
    // Kept for this session only.
  }
}

function loadTilt(key: string): TiltResult | null {
  try {
    const raw = localStorage.getItem(key);
    const t = raw ? (JSON.parse(raw) as TiltResult) : null;
    return t && Number.isFinite(t.tilt) && Array.isArray(t.viewPx) ? t : null;
  } catch {
    return null;
  }
}

function storeTilt(key: string, result: TiltResult): void {
  try {
    localStorage.setItem(key, JSON.stringify(result));
  } catch {
    // Kept for this session only.
  }
}
