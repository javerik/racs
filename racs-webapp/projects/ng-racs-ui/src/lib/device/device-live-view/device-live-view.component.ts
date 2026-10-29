import { Component, computed, effect, inject, OnDestroy, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, EMPTY, Subscription } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import {
  analyze,
  canRead,
  canWrite,
  centerRegion,
  decodeJpeg,
  decodeRaw,
  decodeZstd,
  DeviceRegistryService,
  DeviceSelectionService,
  formatDataRate,
  type FrameStats,
  fullRegion,
  GenicamSession,
  type GrayFrame,
  hasRegion,
  isLossless,
  LaserCalibrationService,
  LatestFrame,
  type LiveFormat,
  loadRangeSettings,
  type PixelDepth,
  RacsService,
  type RangeSettings,
  RateMeter,
  type Rates,
  type Region,
  REGION_FEATURES,
  regionFromStates,
  regionLimits,
  regionWrites,
  rememberGeometry,
  resolveRange,
  RoiSession,
  sameRegion,
  saveRangeSettings,
  snapRegion,
  type StreamInfo,
  type TimedFrame,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';

/** A received live frame, with the stream info it was sent under. */
interface ReceivedFrame {
  frameNumber: number;
  payload: Uint8Array;
  info: StreamInfo;
  /** `performance.now()` when it arrived. */
  receivedAt: number;
}

/** Someone waiting for frames that arrive after a point in time (the laserline calibration). */
interface FrameWaiter {
  count: number;
  after: number;
  accept?: (f: GrayFrame) => boolean;
  frames: TimedFrame[];
  resolve: (frames: TimedFrame[]) => void;
}
import { FrameCanvasComponent, type FrameSpace } from '../shared/frame-canvas.component';
import { RangeControlComponent } from '../shared/range-control.component';
import { RoiAnalysisComponent } from '../shared/roi-analysis.component';
import { RoiOverlayComponent } from '../shared/roi-overlay.component';
import { ViewToolsComponent } from '../shared/view-tools.component';
import { IconComponent } from '../../shared/icon.component';
import { RegionOverlayComponent } from './region-overlay.component';
import { LaserCalibrationComponent } from './laser-calibration.component';
import { LaserWizardComponent } from './laser-wizard.component';
import { EnvelopeOverlayComponent } from './envelope-overlay.component';

export interface LiveSettings {
  /** `raw` is exact and is what the display range is meant for; `jpeg` is far lighter on the wire. */
  format: LiveFormat;
  /** Only meaningful for raw: JPEG always carries 8 bits. */
  depth: PixelDepth;
  fps: number;
}

const SETTINGS_KEY = 'racs.live';
const FOLDED_KEY = 'racs.live.imageFolded';
/** How far (px) the handle must be swiped to fold or open the image rather than count as a tap. */
const SWIPE_PX = 24;
/** How often the received frame and data rates are recomputed while live. */
const RATE_REFRESH_MS = 500;
/** The frame number and dropped counter in front of every live frame message. */
const FRAME_HEADER_BYTES = 8;

const DEFAULT_SETTINGS: LiveSettings = { format: 'zstd', depth: 'mono8', fps: 15 };
const REGION_OWNER = 'region-editor';

@Component({
  selector: 'racs-device-live-view',
  standalone: true,
  imports: [
    CommonModule,
    FrameCanvasComponent,
    RangeControlComponent,
    IconComponent,
    ViewToolsComponent,
    RoiOverlayComponent,
    RoiAnalysisComponent,
    RegionOverlayComponent,
    LaserCalibrationComponent,
    LaserWizardComponent,
    EnvelopeOverlayComponent,
  ],
  // Per live view: it calibrates against this view's frames.
  providers: [LaserCalibrationService],
  templateUrl: './device-live-view.component.html',
  styleUrl: './device-live-view.component.scss',
})
export class DeviceLiveViewComponent implements OnDestroy {
  readonly selection = inject(DeviceSelectionService);
  private readonly racs = inject(RacsService);
  private readonly registry = inject(DeviceRegistryService);
  readonly layout = inject(LayoutService);
  /** Told while a stream holds the camera, so the settings panels know their writes apply live. */
  private readonly session = inject(GenicamSession, { optional: true });
  readonly roi = inject(RoiSession);
  readonly calibration = inject(LaserCalibrationService);
  private liveSubscription: Subscription | null = null;
  private readonly frameWaiters = new Set<FrameWaiter>();
  /** Number of the newest live frame received, shown or not. */
  private lastReceived = -1;
  /** Frames decode asynchronously (JPEG); never let an older one overwrite a newer one. */
  private latestShown = -1;

  readonly fpsChoices = [5, 10, 15, 30, 60];
  readonly regionFields: { key: keyof Region; label: string; title: string; offset: boolean }[] = [
    { key: 'width', label: 'W', title: 'Width', offset: false },
    { key: 'height', label: 'H', title: 'Height', offset: false },
    { key: 'x', label: 'X', title: 'OffsetX', offset: true },
    { key: 'y', label: 'Y', title: 'OffsetY', offset: true },
  ];

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly live = signal(false);
  readonly frameCount = signal(0);
  readonly droppedCount = signal(0);
  /** What this browser actually receives: frames and bytes per second. `null` until measured. */
  readonly rates = signal<Rates | null>(null);
  readonly formatDataRate = formatDataRate;
  private readonly meter = new RateMeter();
  /** Frames are counted as they arrive but decoded and drawn only as fast as the page can. */
  private readonly latest = new LatestFrame<ReceivedFrame>((f) => this.decode(f));

  readonly settings = signal<LiveSettings>(loadSettings());
  readonly info = signal<StreamInfo | null>(null);
  readonly frame = signal<GrayFrame | null>(null);
  readonly stats = signal<FrameStats | null>(null);

  /** The depth of what is on screen, or of what the next stream will deliver. */
  readonly bitDepth = computed(
    () =>
      this.frame()?.bitDepth ??
      (isLossless(this.settings().format) && this.settings().depth === 'mono16' ? 16 : 8),
  );
  readonly rangeSettings = signal<RangeSettings>(loadRangeSettings(-1, 8));

  /** Mobile: the pinned image folded into a slim bar, leaving the screen to the settings. */
  private readonly imageFolded = signal(loadFolded());
  readonly folded = computed(() => this.layout.isMobile() && this.imageFolded());
  private handleSwipe: { id: number; y: number } | null = null;
  /** A swipe ends in a click as well; that click must not toggle back. */
  private swiped = false;
  readonly range = computed(() => resolveRange(this.rangeSettings(), this.bitDepth(), this.stats()));

  // --- camera region editor ------------------------------------------------------------------
  readonly regionOpen = computed(() => this.roi.tool() === 'region');
  /** The tool is offered from the node list: its states are only read once it is open. */
  readonly regionAvailable = computed(() => !!this.session && hasRegion(this.session.nodes()));
  readonly regionLimits = computed(() => (this.session ? regionLimits(this.session.states()) : null));
  /** What the device holds. */
  readonly regionCurrent = computed(() => (this.session ? regionFromStates(this.session.states()) : null), {
    equal: (a, b) => sameRegion(a, b) || (a === null && b === null),
  });
  /** What is being edited; null while the tool is off. */
  readonly regionDraft = signal<Region | null>(null);
  readonly regionChanged = computed(() => !!this.regionDraft() && !sameRegion(this.regionDraft(), this.regionCurrent()));
  readonly regionApplying = computed(
    () => !!this.session && REGION_FEATURES.some((n) => this.session!.savingNodes().has(n)),
  );
  readonly regionError = computed(() => {
    const errors = this.session?.nodeErrors() ?? {};
    const name = REGION_FEATURES.find((n) => errors[n]);
    return name ? `${name}: ${errors[name]}` : null;
  });
  /** Why the region can't be written right now, if it can't. */
  readonly regionBlocked = computed(() => {
    const session = this.session;
    if (!session) {
      return 'no feature access';
    }
    if (session.holder() === 'burst') {
      return 'locked while a burst captures';
    }
    const readOnly = session.readOnlyReason();
    if (readOnly) {
      return readOnly;
    }
    const states = session.states();
    for (const name of ['Width', 'Height', 'OffsetX', 'OffsetY']) {
      const node = session.nodes().get(name);
      const st = states[name];
      if (!node || !st) {
        continue;
      }
      if (node.access_mode !== 'ReadWrite' && node.access_mode !== 'WriteOnly') {
        return `${name} is read only`;
      }
      // A live stream pauses acquisition for locked features itself; otherwise the lock holds.
      if (st.locked && session.holder() !== 'live') {
        return `${name} is locked`;
      }
    }
    return null;
  });
  /** Another client's live capture runs on this device: Start joins it (needs read only). */
  readonly streamRunning = computed(() => {
    const id = this.selection.selectedDeviceId();
    return id !== null && !!this.registry.streamState(id);
  });
  /** Open sockets of the device's capture, this one included. */
  readonly viewers = computed(() => {
    const id = this.selection.selectedDeviceId();
    return id === null ? 0 : (this.registry.access(id)?.viewers ?? 0);
  });
  /** Why Start can't start (or join) a stream, if it can't. */
  readonly startBlocked = computed(() => {
    const session = this.session;
    if (!session || this.live()) {
      return null;
    }
    const role = session.role();
    if (this.streamRunning() ? canRead(role) : canWrite(role)) {
      return null;
    }
    const why = session.readOnlyReason();
    return canRead(role) ? `${why} · no stream to join` : why;
  });
  /** Why a single-frame capture can't run, if it can't: it needs write access. */
  readonly captureBlocked = computed(() => (this.session && !this.session.canWrite() ? this.session.readOnlyReason() : null));

  /** The laserline calibration owns the region while it runs. */
  readonly calibrating = computed(() => this.calibration.phase() === 'running');
  /** The calibration wizard is open (it is opened from the region tool, which stays open with it). */
  readonly wizardOpen = computed(() => this.calibration.wizard() !== null);
  /** The sensor as the canvas's space while editing, with the frame at the device's offset. */
  readonly regionSpace = computed<FrameSpace | null>(() => {
    const limits = this.regionLimits();
    if (!this.regionOpen() || !limits) {
      return null;
    }
    const current = this.regionCurrent();
    return { width: limits.x.extent, height: limits.y.extent, offsetX: current?.x ?? 0, offsetY: current?.y ?? 0 };
  });

  constructor() {
    this.calibration.attach({
      live: this.live,
      regionBlocked: this.regionBlocked,
      frames: (count, after, options) => this.nextFrames(count, after, options),
      latestNumber: () => this.lastReceived,
      propose: (region) => {
        if (this.regionOpen()) {
          this.regionDraft.set(region);
        }
      },
    });

    // The rates are refreshed on a timer rather than per frame: steadier to read, and a stall
    // shows as a falling rate instead of the last one standing still.
    effect((onCleanup) => {
      if (!this.live()) {
        return;
      }
      const timer = setInterval(() => this.rates.set(this.meter.rate(performance.now())), RATE_REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    toObservable(this.selection.selectedDeviceId)
      .pipe(distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => {
        this.stopLive();
        this.frame.set(null);
        this.stats.set(null);
        this.info.set(null);
        this.error.set(null);
      });

    // The region tool reads the region features while it is open, and edits a copy of them.
    effect(() => {
      const open = this.regionOpen();
      untracked(() => {
        if (!this.session) {
          return;
        }
        if (open) {
          this.session.watch(REGION_OWNER, REGION_FEATURES);
          this.session.read(REGION_FEATURES, true);
        } else {
          this.session.unwatch(REGION_OWNER);
          this.regionDraft.set(null);
        }
      });
    });
    effect(() => {
      const current = this.regionCurrent();
      if (this.regionOpen() && current && !untracked(this.regionDraft)) {
        untracked(() => this.regionDraft.set(current));
      }
    });

    // The wizard works on the region tool's overlays: leaving the tool closes it.
    effect(() => {
      if (this.wizardOpen() && !this.regionOpen()) {
        untracked(() => this.calibration.closeWizard());
      }
    });

    // Each device and depth keeps its own window: 20↔50 on 8 bit means nothing on 12 bit.
    effect(() => {
      const id = this.selection.selectedDeviceId() ?? -1;
      const depth = this.bitDepth();
      untracked(() => this.rangeSettings.set(loadRangeSettings(id, depth)));
    });
  }

  ngOnDestroy(): void {
    this.stopLive();
    this.session?.unwatch(REGION_OWNER);
    if (this.roi.tool() === 'region') {
      this.roi.tool.set(null);
    }
  }

  // Region editor ------------------------------------------------------------------------------

  /** A typed value in the region bar: snapped onto the device's grid. */
  setRegionField(field: keyof Region, value: number): void {
    const draft = this.regionDraft();
    const limits = this.regionLimits();
    if (!draft || !limits || !Number.isFinite(value)) {
      return;
    }
    this.regionDraft.set(snapRegion({ ...draft, [field]: Math.round(value) }, limits));
  }

  fullRegion(): void {
    const limits = this.regionLimits();
    if (limits) {
      this.regionDraft.set(fullRegion(limits));
    }
  }

  centerRegion(): void {
    const draft = this.regionDraft();
    const limits = this.regionLimits();
    if (draft && limits) {
      this.regionDraft.set(centerRegion(draft, limits));
    }
  }

  /** Write the draft. The session queue is serial, so the writes keep their order. */
  applyRegion(): void {
    const current = this.regionCurrent();
    const draft = this.regionDraft();
    if (!this.session || !current || !draft || this.regionBlocked() || this.regionApplying() || this.calibrating()) {
      return;
    }
    for (const [name, value] of regionWrites(current, draft)) {
      this.session.write(name, value);
    }
  }

  startLiveFromWizard(): void {
    if (!this.live()) {
      this.toggleLive();
    }
  }

  /** Back to the region bar: with the wizard's proposal as the draft, or with what the device holds. */
  onWizardClosed(toEditor: boolean): void {
    if (!toEditor) {
      this.regionDraft.set(this.regionCurrent());
    }
  }

  cancelRegion(): void {
    this.regionDraft.set(null);
    this.roi.tool.set(null);
  }

  setFolded(folded: boolean): void {
    this.imageFolded.set(folded);
    try {
      localStorage.setItem(FOLDED_KEY, String(folded));
    } catch {
      // Remembering is a convenience only.
    }
  }

  onHandleDown(event: PointerEvent): void {
    this.handleSwipe = { id: event.pointerId, y: event.clientY };
    this.swiped = false;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  onHandleUp(event: PointerEvent): void {
    const start = this.handleSwipe;
    this.handleSwipe = null;
    if (!start || start.id !== event.pointerId) {
      return;
    }
    const dy = event.clientY - start.y;
    if (Math.abs(dy) >= SWIPE_PX) {
      this.swiped = true;
      this.setFolded(dy < 0);
    }
  }

  onHandleCancel(): void {
    this.handleSwipe = null;
  }

  onHandleClick(): void {
    if (this.swiped) {
      this.swiped = false;
      return;
    }
    this.setFolded(!this.imageFolded());
  }

  onRangeChange(settings: RangeSettings): void {
    this.rangeSettings.set(settings);
    saveRangeSettings(this.selection.selectedDeviceId() ?? -1, this.bitDepth(), settings);
  }

  updateSettings(patch: Partial<LiveSettings>): void {
    const next = { ...this.settings(), ...patch };
    if (next.format === 'jpeg') {
      next.depth = 'mono8';
    }
    this.settings.set(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Remembering is a convenience only.
    }
    // The stream's parameters are fixed when the socket opens, so apply by reopening it.
    if (this.live()) {
      this.stopLive();
      this.toggleLive();
    }
  }

  captureSnapshot(): void {
    const deviceId = this.selection.selectedDeviceId();
    if (deviceId === null || this.loading() || this.live()) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.racs
      .grabJpegFrame(deviceId)
      .pipe(
        catchError((e) => {
          this.error.set(this.errMsg(e));
          return EMPTY;
        }),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((blob) => {
        decodeJpeg(blob)
          .then((frame) => this.show(frame))
          .catch(() => this.error.set('Could not decode JPEG'));
      });
  }

  toggleLive(): void {
    if (this.live()) {
      this.stopLive();
      return;
    }

    const deviceId = this.selection.selectedDeviceId();
    if (deviceId === null) {
      return;
    }
    const { format, depth, fps } = this.settings();
    this.error.set(null);
    this.info.set(null);
    this.frameCount.set(0);
    this.droppedCount.set(0);
    this.meter.reset();
    this.rates.set(null);
    this.latestShown = -1;
    this.lastReceived = -1;
    this.live.set(true);
    this.session?.holder.set('live');
    this.liveSubscription = this.racs
      .liveStream(deviceId, { format, pixelDepth: isLossless(format) ? depth : undefined, fps })
      .subscribe({
        next: (event) => {
          if (event.kind === 'info') {
            this.info.set(event.info);
            rememberGeometry(deviceId, event.info.width, event.info.height);
            return;
          }
          const { frameNumber, dropped, payload } = event.frame;
          this.meter.add(performance.now(), payload.length + FRAME_HEADER_BYTES);
          this.frameCount.set(frameNumber + 1);
          this.lastReceived = frameNumber;
          this.droppedCount.set(dropped);
          const info = this.info();
          if (info) {
            this.latest.push({ frameNumber, payload, info, receivedAt: performance.now() });
          }
        },
        error: (e: Error) => {
          this.error.set(/Busy/.test(e.message) ? 'Camera is busy: a burst holds it' : e.message);
          this.live.set(false);
          this.liveSubscription = null;
          this.releaseHolder();
        },
        complete: () => {
          this.live.set(false);
          this.liveSubscription = null;
          this.releaseHolder();
        },
      });
  }

  /** Decode and show one frame. JPEG and zstd decode asynchronously; the promise settles when shown. */
  private decode({ frameNumber, payload, info, receivedAt }: ReceivedFrame): Promise<void> | void {
    if (info.format === 'jpeg') {
      return decodeJpeg(payload)
        .then((frame) => this.show(frame, frameNumber, receivedAt))
        .catch(() => this.error.set('Could not decode JPEG frame'));
    }
    if (info.format === 'zstd') {
      return decodeZstd(payload, info.width, info.height, info.bit_depth ?? 8)
        .then((frame) => this.show(frame, frameNumber, receivedAt))
        .catch((e: Error) => {
          this.error.set(e.message);
          this.stopLive();
        });
    }
    try {
      this.show(decodeRaw(payload, info.width, info.height, info.bit_depth ?? 8), frameNumber, receivedAt);
    } catch (e) {
      this.error.set((e as Error).message);
      this.stopLive();
    }
  }

  private show(frame: GrayFrame, frameNumber = Infinity, receivedAt = performance.now()): void {
    if (frameNumber !== Infinity) {
      if (frameNumber < this.latestShown) {
        return;
      }
      this.latestShown = frameNumber;
    }
    // While calibrating, the page's time goes to the calibration: drawing large frames would make
    // it fall behind the stream.
    if (!this.calibrating()) {
      this.stats.set(analyze(frame));
      this.frame.set(frame);
    }
    for (const w of this.frameWaiters) {
      if (receivedAt > w.after && (w.accept?.(frame) ?? true)) {
        w.frames.push({ frame, at: receivedAt, number: frameNumber === Infinity ? this.lastReceived : frameNumber });
        if (w.frames.length >= w.count) {
          w.resolve(w.frames);
        }
      }
    }
  }

  /**
   * The next `count` shown frames (with their arrival time) that arrived after `after` (`performance.now()`) and pass
   * `accept`. Frames the page skips while busy don't count. Rejects after `timeoutMs`, or with
   * `partial` resolves with what came by then.
   */
  nextFrames(
    count: number,
    after: number,
    options: { accept?: (f: GrayFrame) => boolean; timeoutMs?: number; partial?: boolean } = {},
  ): Promise<TimedFrame[]> {
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        count,
        after,
        accept: options.accept,
        frames: [],
        resolve: (frames) => {
          clearTimeout(timer);
          this.frameWaiters.delete(waiter);
          resolve(frames);
        },
      };
      const timer = setTimeout(() => {
        this.frameWaiters.delete(waiter);
        if (options.partial) {
          resolve(waiter.frames);
        } else {
          reject(new Error(this.live() ? 'no frames from the camera in time' : 'the live stream stopped'));
        }
      }, options.timeoutMs ?? 5000);
      this.frameWaiters.add(waiter);
    });
  }

  /**
   * Unsubscribing closes the socket, which is what makes the server stop acquiring and hand the
   * camera back — until then every other request for the device is rejected as busy.
   */
  private stopLive(): void {
    this.latest.clear();
    this.liveSubscription?.unsubscribe();
    this.liveSubscription = null;
    this.live.set(false);
    this.releaseHolder();
  }

  private releaseHolder(): void {
    if (this.session?.holder() === 'live') {
      this.session.holder.set(null);
    }
  }

  private errMsg(e: unknown): string {
    if (e && typeof e === 'object' && 'error' in e) {
      const err = (e as { error?: unknown }).error;
      if (err instanceof Blob) {
        return 'Could not read JPEG response';
      }
      if (typeof err === 'string') {
        return err;
      }
    }
    return 'Could not load image';
  }
}

function loadSettings(): LiveSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<LiveSettings>;
      return {
        format: s.format === 'jpeg' || s.format === 'raw' || s.format === 'zstd' ? s.format : DEFAULT_SETTINGS.format,
        depth: s.depth === 'mono16' && s.format !== 'jpeg' ? 'mono16' : 'mono8',
        fps: typeof s.fps === 'number' && s.fps > 0 ? s.fps : DEFAULT_SETTINGS.fps,
      };
    }
  } catch {
    // Fall through to the defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

function loadFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === 'true';
  } catch {
    return false;
  }
}
