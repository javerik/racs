import {
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  analyzeProfiles,
  BurstFetch,
  type BurstJobInfo,
  canRead,
  canWrite,
  CAPACITY_CHOICES,
  clampFrames,
  cloudBudget,
  type CloudMode,
  type CloudScaling,
  type CloudSettings,
  countValid,
  decodeRaw,
  DeviceRegistryService,
  encodePly,
  errMsg,
  formatDataRate,
  formatUnits,
  type FrameStats,
  GenicamSession,
  isPixelScaling,
  loadCloudSettings,
  loadRangeSettings,
  loadScaling,
  MAX_FRAMES,
  maxValue,
  mergeStats,
  PIXEL_SCALING,
  ProfileRateEstimator,
  RacsService,
  RangeCalibrationService,
  type RangeFrame,
  type RangeFrameSource,
  type RangeSettings,
  RateMeter,
  type Rates,
  resolveRange,
  ringLayout,
  RollingStats,
  RowRing,
  saveBlob,
  saveCloudSettings,
  saveRangeSettings,
  saveScaling,
  scalingKey,
  storeStride,
  type StreamInfo,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { IconComponent } from '../../shared/icon.component';
import { InspectorComponent, InspectorSectionComponent } from '../../shared/inspector.component';
import { RangeControlComponent } from '../shared/range-control.component';
import { CameraFeaturesComponent } from './camera-features.component';
import { CloudViewSettingsComponent } from './cloud-view-settings.component';
import { CloudViewComponent, type DrawInfo } from './cloud-view.component';
import { MetricScalingComponent } from './metric-scaling.component';
import type { StlCloud } from './stl-check.component';

/** What the frames being turned into a cloud look like. */
interface Geometry {
  width: number;
  height: number;
  pixelFormat: string;
  bitDepth: number;
}

/** The range calibration waiting for frames that arrive after a point in time. */
interface RangeWaiter {
  count: number;
  after: number;
  accept?: (f: RangeFrame) => boolean;
  frames: RangeFrame[];
  resolve: (frames: RangeFrame[]) => void;
}

interface SnapshotProgress {
  requested: number;
  captured: number;
  loaded: number;
  failed: number;
}

const SCAN_TYPE = 'DeviceScanType';
const SCAN3D_CATEGORY = 'Scan3dControl';
const REGION_SELECTOR = 'RegionSelector';
const WATCH_OWNER = 'cloud';
const RANGE_SCOPE = 'racs.cloud.range';
const JOB_KEY = 'racs.cloud.job';
/** How often the counters, rates and the value window follow a running stream. */
const REFRESH_MS = 500;
/** The frame number and dropped counter in front of every live frame message. */
const FRAME_HEADER_BYTES = 8;
/** The GPU limits WebGL2 guarantees, until the view knows the real ones. */
const MIN_LIMITS = { maxTextureSize: 2048, maxLayers: 256, maxBytes: Infinity };

/**
 * The 3D tab: frames as point clouds. Each image row is a profile (y), each column a position
 * along it (x), each value a height (z), which is what a laser profiler in `Linescan3D` streams.
 *
 * - Continuous: the live stream, unthrottled, every frame appended to a rolling buffer of
 *   profiles. Frames the stream dropped leave a gap, so distances along y stay true.
 * - Snapshot: a raw burst of N frames, stacked in capture order as they download.
 */
@Component({
  selector: 'racs-device-cloud',
  standalone: true,
  imports: [
    CameraFeaturesComponent,
    CloudViewComponent,
    CloudViewSettingsComponent,
    IconComponent,
    InspectorComponent,
    InspectorSectionComponent,
    MetricScalingComponent,
    RangeControlComponent,
  ],
  // The range calibration (#33 §2) films this tab's live frames.
  providers: [RangeCalibrationService],
  templateUrl: './device-cloud.component.html',
  styleUrl: './device-cloud.component.scss',
})
export class DeviceCloudComponent implements OnInit, OnDestroy {
  readonly deviceId = input.required<number>();

  private readonly racs = inject(RacsService);
  private readonly registry = inject(DeviceRegistryService);
  readonly layout = inject(LayoutService);
  /** Told while the cloud holds the camera, so the settings panels know their writes apply live. */
  readonly session = inject(GenicamSession, { optional: true });
  private readonly view = viewChild(CloudViewComponent);
  private readonly metricScaling = viewChild(MetricScalingComponent);
  /** The range calibration (#33 §2) films this tab's live frames and pauses the cloud meanwhile. */
  readonly calib = inject(RangeCalibrationService);
  private readonly captureMenu = viewChild<ElementRef<HTMLElement>>('captureMenu');

  readonly capacityChoices = CAPACITY_CHOICES;
  readonly maxFrames = MAX_FRAMES;
  readonly modes: { id: CloudMode; label: string; hint: string }[] = [
    { id: 'continuous', label: 'Continuous', hint: 'Stream every frame into a rolling buffer of profiles' },
    { id: 'snapshot', label: 'Snapshot', hint: 'Capture N frames as one cloud' },
  ];
  readonly depths: { id: CloudSettings['depth']; label: string }[] = [
    { id: 'mono16', label: '16 bit' },
    { id: 'mono8', label: '8 bit' },
  ];
  readonly formatDataRate = formatDataRate;

  readonly budget = computed(() => cloudBudget(this.layout.isMobile()));
  readonly settings = signal<CloudSettings>(loadCloudSettings(this.layout.isMobile()));

  readonly running = signal<CloudMode | null>(null);
  readonly error = signal<string | null>(null);
  readonly ring = signal<RowRing | null>(null);
  /** The ring keeps every n-th profile (a snapshot larger than the memory budget). */
  readonly storeStride = signal(1);
  readonly geometry = signal<Geometry | null>(null);
  readonly zStats = signal<FrameStats | null>(null);
  readonly drawInfo = signal<DrawInfo | null>(null);
  readonly rates = signal<Rates | null>(null);
  readonly frames = signal(0);
  readonly dropped = signal(0);
  readonly held = signal(0);
  readonly snapshot = signal<SnapshotProgress | null>(null);

  readonly bitDepth = computed(() => this.geometry()?.bitDepth ?? (this.settings().depth === 'mono16' ? 16 : 8));
  readonly rangeSettings = signal<RangeSettings>({ mode: 'auto', lo: 0, hi: 65535 });
  readonly range = computed(() => resolveRange(this.rangeSettings(), this.bitDepth(), this.zStats()));
  readonly zExtent = computed(() => {
    const s = this.zStats();
    return s ? { min: s.min, max: s.max } : null;
  });

  // --- scaling ---------------------------------------------------------------------------------
  private readonly device = computed(() => this.registry.connected().find((d) => d.id === this.deviceId()));
  /** Null until the registry lists the device: nothing is loaded or saved under a stand-in key. */
  private readonly scalingStore = computed(() => scalingKey(this.device()));
  readonly scaling = signal<CloudScaling>(PIXEL_SCALING);
  readonly calibrated = computed(() => !isPixelScaling(this.scaling()));
  readonly scalingSummary = computed(() => {
    const s = this.scaling();
    const source = s.source === 'laserline' ? ' · laserline' : '';
    return this.calibrated()
      ? `${s.unit} · ${formatUnits(s.xPitch)} / ${formatUnits(s.ySpacing)} / ${formatUnits(s.zScale)}${source}`
      : `px · profiles · counts${source}`;
  });
  /** The camera's profiles per second while streaming (#33 §3), copied on the refresh timer. */
  readonly liveRate = signal<number | null>(null);
  /** The last snapshot that completed, for a rough profile rate without a stream. */
  readonly lastBurst = signal<BurstJobInfo | null>(null);
  readonly calibrating = computed(() => this.calib.phase() === 'running');

  // --- check against the STL (#33 §5) ------------------------------------------------------------
  /** A snapshot taken for the check is being captured. */
  readonly stlChecking = signal(false);
  /** That snapshot, once complete; cleared by the next capture. */
  readonly stlCloud = signal<StlCloud | null>(null);
  /** Profiles per frame: the stream's frame height, else the camera's `Height`. */
  readonly profilesPerFrame = computed(() => {
    const h = this.geometry()?.height ?? Number(this.session?.states()['Height']?.value);
    return Number.isFinite(h) && h >= 1 ? h : null;
  });
  /** Why the check's snapshot can't be taken now (a running stream is stopped for it). */
  readonly stlBlocked = computed(() => {
    if (this.running() === 'snapshot') {
      return 'a snapshot is being captured';
    }
    if (!this.is3d()) {
      return 'the camera is not in Linescan3D';
    }
    const session = this.session;
    return session && !canWrite(session.role()) ? session.readOnlyReason() : null;
  });

  // --- capture settings ------------------------------------------------------------------------
  /** The capture settings' popover under the command bar. */
  readonly captureOpen = signal(false);
  /** A rolling buffer smaller than asked for, because of the budget or the card: its length. */
  readonly bufferShort = computed(() => {
    const ring = this.ring();
    return ring?.mode === 'rolling' && ring.layout.capacity < this.settings().capacity ? ring.layout.capacity : null;
  });

  readonly captureSummary = computed(() => {
    const s = this.settings();
    const depth = s.depth === 'mono16' ? '16 bit' : '8 bit';
    return s.mode === 'continuous'
      ? `${depth} · ${s.capacity.toLocaleString()} profiles`
      : `${depth} · ${s.frames} ${s.frames === 1 ? 'frame' : 'frames'}`;
  });

  toggleCapture(): void {
    this.captureOpen.update((open) => !open);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointer(e: PointerEvent): void {
    const menu = this.captureMenu()?.nativeElement;
    if (this.captureOpen() && menu && !menu.contains(e.target as Node)) {
      this.captureOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.captureOpen.set(false);
  }

  // --- camera sections ---------------------------------------------------------------------------
  /** The camera's Scan3dControl category, which a 3D camera has. */
  readonly hasScan3d = computed(() => !!this.session?.categories().some((c) => c.name === SCAN3D_CATEGORY));
  readonly hasRegion = computed(() => !!this.session?.nodes().has(REGION_SELECTOR));
  readonly scan3dSummary = computed(() => this.featureText('Scan3dExtractionMethod'));
  readonly regionSummary = computed(() => {
    const region = this.featureText(REGION_SELECTOR);
    const height = this.featureText('Height');
    return [region, height && `h ${height}`].filter(Boolean).join(' · ') || null;
  });

  /** A feature's value as shown: an enum's entry name, else the value; `null` while unknown. */
  private featureText(name: string): string | null {
    const value = this.session?.states()[name]?.value;
    if (value === null || value === undefined) {
      return null;
    }
    const entry = this.session?.nodes().get(name)?.enums?.find((e) => String(e.value) === value);
    return entry ? entry.display_name || entry.string_value || value : value;
  }

  /** What the cloud's corner adds to its extents: the points drawn. */
  readonly drawDetail = computed(() => {
    const d = this.drawInfo();
    if (!d) {
      return null;
    }
    const thinned = d.colStride > 1 || d.rowStride > 1 ? ` · 1/${d.colStride}×1/${d.rowStride}` : '';
    return `${(d.drawn / 1e6).toFixed(2)} M pts${thinned}`;
  });

  // --- scan type -------------------------------------------------------------------------------
  readonly scanNode = computed(() => this.session?.nodes().get(SCAN_TYPE) ?? null);
  private readonly scanState = computed(() => this.session?.states()[SCAN_TYPE] ?? null);
  readonly scanEntry = computed(() => {
    const value = this.scanState()?.value;
    return this.scanNode()?.enums?.find((e) => String(e.value) === value) ?? null;
  });
  private readonly linescan3d = computed(
    () => this.scanNode()?.enums?.find((e) => /^linescan3d$/i.test(e.string_value ?? e.display_name)) ?? null,
  );
  readonly is3d = computed(() => {
    const entry = this.scanEntry();
    return !!entry && entry.value === this.linescan3d()?.value;
  });
  readonly scanSaving = computed(() => !!this.session?.savingNodes().has(SCAN_TYPE));
  readonly scanError = computed(() => this.session?.nodeErrors()[SCAN_TYPE] ?? null);
  /** Why the switch to Linescan3D can't be made, if it can't. */
  readonly scanBlocked = computed(() => {
    const node = this.scanNode();
    const target = this.linescan3d();
    const state = this.scanState();
    if (!node || !target) {
      return 'this camera has no Linescan3D';
    }
    if (this.session?.holder() === 'burst') {
      return 'locked while a burst captures';
    }
    if (this.session?.readOnlyReason()) {
      return this.session.readOnlyReason();
    }
    if (node.access_mode !== 'ReadWrite' && node.access_mode !== 'WriteOnly') {
      return 'DeviceScanType is read only';
    }
    // A live stream pauses acquisition for a locked feature itself.
    if (state?.locked && this.session?.holder() !== 'live') {
      return 'DeviceScanType is locked';
    }
    if (state?.available_entries && !state.available_entries.includes(target.value)) {
      return 'Linescan3D is not available now';
    }
    return null;
  });

  /**
   * Why the capture can't start, if it can't: a snapshot is a burst (write access), continuous
   * mode starts a live stream (write) or joins another client's (read).
   */
  readonly startBlocked = computed(() => {
    const session = this.session;
    if (!session || this.running()) {
      return null;
    }
    const role = session.role();
    const joinable = this.settings().mode === 'continuous' && !!this.registry.streamState(this.deviceId());
    return (joinable ? canRead(role) : canWrite(role)) ? null : session.readOnlyReason();
  });

  // --- running state ---------------------------------------------------------------------------
  private liveSub: Subscription | null = null;
  private fetch: BurstFetch | null = null;
  private jobId: string | null = null;
  private readonly meter = new RateMeter();
  private readonly profileRate = new ProfileRateEstimator();
  /** The captured index (`frame_number + dropped`) of the newest live frame; -1 before any. */
  private lastCaptured = -1;
  private readonly rangeWaiters = new Set<RangeWaiter>();
  private readonly rolling = new RollingStats();
  /** Snapshot frames' stats, by index. */
  private snapshotStats: (FrameStats | null)[] = [];
  /** Counters updated per frame, copied to the signals on a timer. */
  private counts = { frames: 0, dropped: 0 };
  private lastDropped = 0;
  private statsDue = 0;

  readonly placeholder = computed(() => {
    if (this.running() === 'continuous') {
      return 'waiting for profiles';
    }
    if (this.running() === 'snapshot') {
      return 'capturing';
    }
    return this.settings().mode === 'snapshot' ? 'capture a snapshot' : 'start the stream';
  });

  constructor() {
    // Each device and depth keeps its own window of heights, apart from the live view's.
    effect(() => {
      const id = this.deviceId();
      const depth = this.bitDepth();
      untracked(() =>
        this.rangeSettings.set(loadRangeSettings(id, depth, RANGE_SCOPE, { mode: 'auto', lo: 0, hi: maxValue(depth) })),
      );
    });

    effect(() => {
      const key = this.scalingStore();
      untracked(() => this.scaling.set(key ? loadScaling(key) : { ...PIXEL_SCALING }));
    });

    // Counters, rates and the value window follow a running capture on a timer, not per frame:
    // steadier to read, and cheap at several hundred frames a second.
    effect((onCleanup) => {
      if (!this.running()) {
        return;
      }
      const timer = setInterval(() => this.refresh(), REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });

    effect(() => {
      const session = this.session;
      if (session && session.nodes().has(SCAN_TYPE)) {
        untracked(() => session.watch(WATCH_OWNER, [SCAN_TYPE]));
      }
    });

    const source: RangeFrameSource = {
      live: computed(() => this.running() === 'continuous'),
      geometry: this.geometry,
      frames: (count, after, options) => this.rangeFrames(count, after, options),
      latestNumber: () => this.lastCaptured,
    };
    this.calib.attach(source);
  }

  ngOnInit(): void {
    // A snapshot left running by a reload: nothing will collect it any more.
    const leftover = loadJob(this.deviceId());
    if (leftover) {
      clearJob(this.deviceId());
      this.racs.deleteBurst(this.deviceId(), leftover).subscribe({ error: () => undefined });
    }
  }

  ngOnDestroy(): void {
    this.stopLive();
    this.cancelSnapshot();
    this.session?.unwatch(WATCH_OWNER);
  }

  // Settings -----------------------------------------------------------------------------------

  updateSettings(patch: Partial<CloudSettings>): void {
    const next = { ...this.settings(), ...patch };
    next.frames = clampFrames(next.frames, this.settings().frames);
    this.settings.set(next);
    saveCloudSettings(next);
    // The stream's depth and buffer are fixed when it starts: apply by starting again.
    if (this.running() === 'continuous' && (patch.depth !== undefined || patch.capacity !== undefined)) {
      this.stopLive();
      this.startLive();
    }
  }

  onRangeChange(settings: RangeSettings): void {
    this.rangeSettings.set(settings);
    saveRangeSettings(this.deviceId(), this.bitDepth(), settings, RANGE_SCOPE);
  }

  onDrawInfo(info: DrawInfo): void {
    this.drawInfo.set(info);
  }

  switchToLinescan3d(): void {
    const target = this.linescan3d();
    if (this.session && target && !this.scanBlocked()) {
      this.session.write(SCAN_TYPE, String(target.value));
    }
  }

  // Scaling ------------------------------------------------------------------------------------

  /** Applies a scaling from the Scaling section (`racs-metric-scaling`) and keeps it per camera. */
  applyScaling(s: CloudScaling): void {
    this.scaling.set(s);
    const key = this.scalingStore();
    if (key) {
      saveScaling(key, s);
    }
  }

  // Start / stop -------------------------------------------------------------------------------

  setMode(mode: CloudMode): void {
    if (!this.running()) {
      this.updateSettings({ mode });
    }
  }

  toggle(): void {
    if (this.running() === 'continuous') {
      this.stopLive();
    } else if (this.running() === 'snapshot') {
      this.cancelSnapshot();
    } else if (this.settings().mode === 'continuous') {
      this.startLive();
    } else {
      this.startSnapshot();
    }
  }

  private resetCapture(): void {
    this.error.set(null);
    this.ring.set(null);
    this.geometry.set(null);
    this.zStats.set(null);
    this.drawInfo.set(null);
    this.storeStride.set(1);
    this.rates.set(null);
    this.meter.reset();
    this.rolling.clear();
    this.snapshotStats = [];
    this.counts = { frames: 0, dropped: 0 };
    this.lastDropped = 0;
    this.statsDue = 0;
    this.frames.set(0);
    this.dropped.set(0);
    this.held.set(0);
    this.snapshot.set(null);
    this.stlCloud.set(null);
  }

  // Continuous ---------------------------------------------------------------------------------

  private startLive(): void {
    this.resetCapture();
    this.profileRate.reset();
    this.lastCaptured = -1;
    this.running.set('continuous');
    this.session?.holder.set('live');
    // No fps limit: every frame the camera delivers is a slice of the scan.
    this.liveSub = this.racs
      .liveStream(this.deviceId(), { format: 'raw', pixelDepth: this.settings().depth })
      .subscribe({
        next: (event) =>
          event.kind === 'info'
            ? this.onStreamInfo(event.info)
            : this.onFrame(event.frame.payload, event.frame.frameNumber, event.frame.dropped),
        error: (e: Error) => {
          this.error.set(busyMessage(e.message));
          this.finishLive();
        },
        complete: () => this.finishLive(),
      });
  }

  /** Closing the socket is what makes the server stop acquiring and hand the camera back. */
  private stopLive(): void {
    this.liveSub?.unsubscribe();
    this.finishLive();
  }

  private finishLive(): void {
    if (this.running() !== 'continuous') {
      return;
    }
    this.liveSub = null;
    this.running.set(null);
    this.refresh();
    this.releaseHolder('live');
    this.liveRate.set(null);
    this.profileRate.reset();
  }

  /** Bytes the stored profiles may take: the budget, or less when the card holds less. */
  private storeBytes(): number {
    return Math.min(this.budget().maxBytes, this.view()?.limits()?.maxBytes ?? Infinity);
  }

  /**
   * The card refused the ring (it holds less than its probe found, other tabs share it): a
   * running stream goes on with a shorter buffer; a snapshot is dropped, and the next one keeps
   * every n-th profile to fit (`storeBytes` is lower now).
   */
  onMemoryShort(maxBytes: number): void {
    const g = this.geometry();
    const ring = this.ring();
    if (!g || !ring) {
      return;
    }
    if (ring.layout.capacity * ring.layout.width * 2 <= maxBytes) {
      // Already no larger than the card's floor: smaller won't help.
      this.stopLive();
      this.cancelSnapshot();
      this.ring.set(null);
      this.error.set('the graphics card has no memory left for profiles: close other 3D tabs or windows and try again');
      return;
    }
    if (ring.mode === 'rolling') {
      this.planRolling(g);
      return;
    }
    this.cancelSnapshot();
    this.ring.set(null);
    this.error.set('the graphics card had no room for this snapshot: take it again, it keeps fewer profiles to fit');
  }

  private onStreamInfo(info: StreamInfo): void {
    const geometry: Geometry = {
      width: info.width,
      height: info.height,
      pixelFormat: info.pixel_format,
      bitDepth: info.bit_depth ?? 8,
    };
    const previous = this.geometry();
    this.geometry.set(geometry);
    // A new frame height still appends profiles of the same width; anything else starts over.
    if (previous && this.ring() && previous.width === geometry.width && previous.bitDepth === geometry.bitDepth) {
      return;
    }
    this.planRolling(geometry);
  }

  /** A rolling ring for `geometry`: the buffer asked for, as far as the budget and the card allow. */
  private planRolling(geometry: Geometry): void {
    const limits = this.view()?.limits() ?? MIN_LIMITS;
    const rows = Math.max(1, Math.min(this.settings().capacity, Math.floor(this.storeBytes() / (geometry.width * 2))));
    try {
      const layout = ringLayout(geometry.width, rows, limits.maxTextureSize, limits.maxLayers);
      this.ring.set(new RowRing(layout, 'rolling'));
    } catch (e) {
      this.error.set((e as Error).message);
      this.stopLive();
      return;
    }
    this.rolling.clear();
    this.zStats.set(null);
    this.statsDue = 0;
  }

  private onFrame(payload: Uint8Array, frameNumber: number, dropped: number): void {
    const ring = this.ring();
    const g = this.geometry();
    if (!ring || !g) {
      return;
    }
    const now = performance.now();
    this.meter.add(now, payload.length + FRAME_HEADER_BYTES);
    this.counts.frames++;
    this.counts.dropped = dropped;
    // The captured index counts the frames dropped on the way too: the camera's own count.
    const captured = frameNumber + dropped;
    this.lastCaptured = captured;
    this.profileRate.push(captured, now, g.height);
    let pixels: Uint8Array | Uint16Array;
    try {
      pixels = decodeRaw(payload, g.width, g.height, g.bitDepth).pixels;
    } catch (e) {
      this.error.set((e as Error).message);
      this.stopLive();
      return;
    }
    if (pixels instanceof Uint16Array) {
      this.offerRange({ pixels, width: g.width, height: g.height, at: now, number: captured });
    }
    // While calibrating the page's time goes to the calibration, and laserline shows patterns, not
    // the scan: the cloud pauses.
    if (this.calibrating()) {
      this.lastDropped = dropped;
      return;
    }
    // Frames lost on the way leave a gap of their profiles, so the scan keeps its length.
    if (dropped > this.lastDropped) {
      ring.gap((dropped - this.lastDropped) * g.height);
    }
    this.lastDropped = dropped;
    const seq = ring.seq;
    ring.push(pixels, g.height);
    this.rolling.push(analyzeProfiles(pixels, g.bitDepth), seq, g.height);
    this.rolling.evictBefore(ring.oldestSeq());
    // The first frame sets the view's box; after that the window follows on the timer.
    if (now >= this.statsDue) {
      this.statsDue = now + REFRESH_MS;
      this.zStats.set(this.rolling.current());
    }
    this.view()?.requestRender();
  }

  /** Hands a live frame to the range calibration's waiters. */
  private offerRange(frame: RangeFrame): void {
    for (const w of this.rangeWaiters) {
      if (frame.at > w.after && (w.accept?.(frame) ?? true)) {
        w.frames.push(frame);
        if (w.frames.length >= w.count) {
          w.resolve(w.frames);
        }
      }
    }
  }

  /**
   * The next `count` live frames that arrive after `after` (`performance.now()`) and pass `accept`.
   * Rejects after `timeoutMs`, or with `partial` resolves with what came by then.
   */
  private rangeFrames(
    count: number,
    after: number,
    options: { accept?: (f: RangeFrame) => boolean; timeoutMs?: number; partial?: boolean } = {},
  ): Promise<RangeFrame[]> {
    return new Promise((resolve, reject) => {
      const waiter: RangeWaiter = {
        count,
        after,
        accept: options.accept,
        frames: [],
        resolve: (frames) => {
          clearTimeout(timer);
          this.rangeWaiters.delete(waiter);
          resolve(frames);
        },
      };
      const timer = setTimeout(() => {
        this.rangeWaiters.delete(waiter);
        if (options.partial) {
          resolve(waiter.frames);
        } else {
          reject(new Error(this.running() === 'continuous' ? 'no frames from the camera in time' : 'the live stream stopped'));
        }
      }, options.timeoutMs ?? 5000);
      this.rangeWaiters.add(waiter);
    });
  }

  // Snapshot -----------------------------------------------------------------------------------

  /** The STL check's snapshot: stops a running stream, then captures `frames` and hands them back. */
  checkAgainstStl(frames: number): void {
    if (this.stlBlocked() || this.calibrating()) {
      return;
    }
    if (this.running() === 'continuous') {
      this.stopLive();
    }
    this.updateSettings({ mode: 'snapshot', frames });
    this.startSnapshot();
    this.stlChecking.set(this.running() === 'snapshot');
  }

  private startSnapshot(): void {
    const id = this.deviceId();
    const { frames, depth } = this.settings();
    this.resetCapture();
    this.running.set('snapshot');
    this.session?.holder.set('burst');
    this.snapshot.set({ requested: frames, captured: 0, loaded: 0, failed: 0 });
    this.racs.startBurst(id, { count: frames, format: 'raw', pixel_depth: depth, on_failure: 'skip' }).subscribe({
      next: (created) => {
        if (this.running() !== 'snapshot') {
          // Cancelled before the job existed.
          this.racs.deleteBurst(id, created.job_id).subscribe({ error: () => undefined });
          return;
        }
        this.jobId = created.job_id;
        saveJob(id, created.job_id);
        this.fetch = new BurstFetch(this.racs, id, created.job_id, {
          info: (info) => this.onSnapshotInfo(info),
          image: (index, bytes, info) => this.onSnapshotImage(index, bytes, info),
          failed: () => this.snapshot.update((p) => p && { ...p, failed: p.failed + 1 }),
          finished: (info) => {
            if (info.status === 'failed') {
              this.error.set(busyMessage(info.error ?? 'The snapshot failed'));
            } else if (info.status === 'completed') {
              this.lastBurst.set(info);
              const ring = this.ring();
              if (this.stlChecking() && ring) {
                this.stlCloud.set({ ring, storeStride: this.storeStride() });
              }
            }
            this.finishSnapshot(true);
          },
          error: (message, gone) => {
            this.error.set(message);
            this.finishSnapshot(!gone);
          },
        });
        this.fetch.start();
      },
      error: (e) => {
        this.error.set(errMsg(e));
        this.finishSnapshot(false);
      },
    });
  }

  private onSnapshotInfo(info: BurstJobInfo): void {
    this.snapshot.update((p) => p && { ...p, captured: info.captured_count });
    if (this.ring() || !info.width || !info.height) {
      return;
    }
    // The server records the geometry before it stores the first image.
    const width = info.width;
    const height = info.height;
    const total = info.requested_count * height;
    const k = storeStride(total, width, this.storeBytes());
    const rows = Math.ceil(total / k);
    const limits = this.view()?.limits() ?? MIN_LIMITS;
    try {
      const layout = ringLayout(width, rows, limits.maxTextureSize, limits.maxLayers);
      this.storeStride.set(k);
      this.geometry.set({ width, height, pixelFormat: info.pixel_format ?? '', bitDepth: info.bit_depth ?? 8 });
      this.ring.set(new RowRing(layout, 'stacked', rows));
      this.snapshotStats = new Array(info.requested_count).fill(null);
    } catch (e) {
      this.error.set((e as Error).message);
      this.cancelSnapshot();
    }
  }

  private onSnapshotImage(index: number, bytes: Uint8Array, info: BurstJobInfo): void {
    const ring = this.ring();
    const g = this.geometry();
    if (!ring || !g) {
      return;
    }
    let pixels: Uint8Array | Uint16Array;
    try {
      pixels = decodeRaw(bytes, g.width, g.height, info.bit_depth ?? g.bitDepth).pixels;
    } catch (e) {
      this.snapshot.update((p) => p && { ...p, failed: p.failed + 1 });
      this.error.set((e as Error).message);
      return;
    }
    ring.writeStacked(index, g.height, this.storeStride(), pixels);
    this.snapshotStats[index] = analyzeProfiles(pixels, g.bitDepth);
    this.zStats.set(mergeStats(this.snapshotStats.filter((s): s is FrameStats => !!s)));
    this.snapshot.update((p) => p && { ...p, loaded: p.loaded + 1 });
    this.held.set(ring.filled);
    this.view()?.requestRender();
  }

  /** Stop following the snapshot, keeping what arrived; the job is discarded on the server. */
  private cancelSnapshot(): void {
    if (this.running() !== 'snapshot') {
      return;
    }
    this.finishSnapshot(true);
  }

  private finishSnapshot(deleteJob: boolean): void {
    this.fetch?.stop();
    this.fetch = null;
    const id = this.deviceId();
    if (this.jobId) {
      if (deleteJob) {
        // Cancels a running job too, which is what lets go of the camera.
        this.racs.deleteBurst(id, this.jobId).subscribe({ error: () => undefined });
      }
      clearJob(id);
      this.jobId = null;
    }
    this.running.set(null);
    this.stlChecking.set(false);
    this.releaseHolder('burst');
  }

  // Export -------------------------------------------------------------------------------------

  readonly exportSize = computed(() => {
    this.drawInfo();
    this.held();
    const ring = this.ring();
    if (!ring || this.running()) {
      return null;
    }
    const points = countValid(ring);
    return { points, bytes: points * 12 };
  });

  exportPly(): void {
    const ring = this.ring();
    const g = this.geometry();
    if (!ring || !g) {
      return;
    }
    const s = this.scaling();
    const device = this.device();
    const blob = encodePly(ring, s, {
      storeStride: this.storeStride(),
      comments: [
        [`RACS device #${this.deviceId()}`, device?.model, device?.ip].filter(Boolean).join(' · '),
        `${g.width}x${g.height} ${g.pixelFormat} ${g.bitDepth} bit · ${ring.mode === 'rolling' ? 'continuous' : 'snapshot'}`,
        `units ${s.unit}: x = ${s.mirrorX ? `(${ring.width - 1} - column)` : 'column'} * ${s.xPitch}, ` +
          `y = -profile * ${s.ySpacing * this.storeStride()}, z = value * ${s.zScale} + ${s.zOffset}`,
        ...(this.metricScaling()?.plyComments() ?? [`scaling source ${s.source ?? 'manual'}`]),
      ],
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    saveBlob(blob, `cloud-dev${this.deviceId()}-${stamp}.ply`);
  }

  // Helpers ------------------------------------------------------------------------------------

  private refresh(): void {
    this.frames.set(this.counts.frames);
    this.dropped.set(this.counts.dropped);
    this.held.set(this.ring()?.filled ?? 0);
    if (this.running() === 'continuous') {
      this.rates.set(this.meter.rate(performance.now()));
      this.zStats.set(this.rolling.current());
      this.liveRate.set(this.profileRate.rate());
    }
  }

  private releaseHolder(holder: 'live' | 'burst'): void {
    if (this.session?.holder() === holder) {
      this.session.holder.set(null);
    }
  }
}

function busyMessage(message: string): string {
  return /Busy/.test(message) ? 'Camera is busy: a burst or a live stream holds it' : message;
}

function loadJob(deviceId: number): string | null {
  try {
    return localStorage.getItem(`${JOB_KEY}.${deviceId}`);
  } catch {
    return null;
  }
}

function saveJob(deviceId: number, jobId: string): void {
  try {
    localStorage.setItem(`${JOB_KEY}.${deviceId}`, jobId);
  } catch {
    // Only used to clean up after a reload.
  }
}

function clearJob(deviceId: number): void {
  try {
    localStorage.removeItem(`${JOB_KEY}.${deviceId}`);
  } catch {
    // Nothing to clean up.
  }
}
