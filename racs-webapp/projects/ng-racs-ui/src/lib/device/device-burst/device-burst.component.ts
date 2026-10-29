import {
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription, timer } from 'rxjs';
import { exhaustMap } from 'rxjs/operators';
import {
  analyze,
  type BurstFormat,
  type BurstJobInfo,
  bytesPerPixel,
  decodeJpeg,
  decodeRaw,
  decodeZstd,
  type DisplayRange,
  type FrameStats,
  GenicamSession,
  type GrayFrame,
  isLossless,
  loadRangeSettings,
  mergeStats,
  type OnFailure,
  type PixelDepth,
  RacsService,
  type RangeSettings,
  recallGeometry,
  rememberGeometry,
  renderToCanvas,
  resolveRange,
  RoiSession,
  saveBlob,
  saveRangeSettings,
  type ZipEntry,
  zipStore,
} from 'ng-racs-core';
import { FrameCanvasComponent } from '../shared/frame-canvas.component';
import { SliderDirective } from '../../shared/slider.directive';
import { RangeControlComponent } from '../shared/range-control.component';
import { RoiAnalysisComponent } from '../shared/roi-analysis.component';
import { RoiOverlayComponent } from '../shared/roi-overlay.component';
import { ViewToolsComponent } from '../shared/view-tools.component';

interface BurstForm {
  count: number;
  format: BurstFormat;
  depth: PixelDepth;
  onFailure: OnFailure;
}

/** One captured frame held in the browser. */
interface BurstFrame {
  frame: GrayFrame;
  stats: FrameStats;
  /**
   * The frame's file for the "original" download: the bytes as served for raw and JPEG, the
   * decoded pixels (a view, not a copy) for zstd, so that download is raw either way.
   */
  original: Uint8Array;
}

type AutoScope = 'frame' | 'burst';

const FORM_KEY = 'racs.burst.form';
const JOB_KEY = 'racs.burst.job';
const MAX_COUNT = 500;
const POLL_MS = 300;
/** Parallel image downloads; enough to keep up with a capture without flooding the server. */
const MAX_IN_FLIGHT = 4;
const MEMORY_WARNING_BYTES = 500 * 1024 * 1024;

const DEFAULT_FORM: BurstForm = { count: 50, format: 'raw', depth: 'mono8', onFailure: 'abort' };

@Component({
  selector: 'racs-device-burst',
  standalone: true,
  imports: [
    CommonModule,
    FrameCanvasComponent,
    RangeControlComponent,
    SliderDirective,
    ViewToolsComponent,
    RoiOverlayComponent,
    RoiAnalysisComponent,
  ],
  templateUrl: './device-burst.component.html',
  styleUrl: './device-burst.component.scss',
})
export class DeviceBurstComponent implements OnInit, OnDestroy {
  readonly deviceId = input.required<number>();

  private readonly racs = inject(RacsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly canvas = viewChild(FrameCanvasComponent);

  readonly maxCount = MAX_COUNT;
  readonly playbackFpsChoices = [5, 10, 15, 25, 30, 60];

  // --- setup -----------------------------------------------------------------------------
  readonly form = signal<BurstForm>(loadForm());
  readonly starting = signal(false);
  readonly error = signal<string | null>(null);

  // --- job -------------------------------------------------------------------------------
  readonly job = signal<BurstJobInfo | null>(null);
  /** One slot per burst index; `null` until downloaded (or for a failed index). */
  readonly slots = signal<(BurstFrame | null)[]>([]);
  readonly failed = signal<ReadonlyMap<number, string>>(new Map());
  /** Frames the server captured that could not be downloaded or decoded here. */
  private readonly downloadFailures = signal(0);
  private pollSub: Subscription | null = null;
  private listing = false;
  private readonly requested = new Set<number>();
  private queue: number[] = [];
  private inFlight = 0;

  // --- player ----------------------------------------------------------------------------
  readonly index = signal(0);
  readonly playing = signal(false);
  readonly playbackFps = signal(25);
  readonly loop = signal(true);
  readonly autoScope = signal<AutoScope>('burst');
  readonly rangeSettings = signal<RangeSettings>(loadRangeSettings(-1, 8));
  private rafId: number | null = null;

  // --- export ----------------------------------------------------------------------------
  /** Progress 0..1 of a running export, with what it is producing. */
  readonly exporting = signal<{ kind: string; progress: number } | null>(null);
  private exportAborted = false;
  readonly canRecord =
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype;

  readonly fetchedCount = computed(() => this.slots().filter((s) => s !== null).length);
  readonly validIndices = computed(() => {
    const out: number[] = [];
    this.slots().forEach((s, i) => s && out.push(i));
    return out;
  });
  readonly current = computed(() => this.slots()[this.index()] ?? null);
  /** Every frame by burst index, for the ROI time series. */
  readonly frames = computed(() => this.slots().map((s) => s?.frame ?? null));
  readonly roi = inject(RoiSession);

  readonly terminal = computed(() => {
    const status = this.job()?.status;
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  });
  /** Everything the server captured is also in the browser. */
  readonly complete = computed(() => {
    const job = this.job();
    return !!job && this.terminal() && this.fetchedCount() + this.downloadFailures() >= job.captured_count;
  });

  readonly bitDepth = computed(
    () =>
      this.current()?.frame.bitDepth ??
      this.job()?.bit_depth ??
      (isLossless(this.form().format) && this.form().depth === 'mono16' ? 16 : 8),
  );
  /**
   * Burst-wide stats, so auto range can hold still across the video instead of pumping with
   * every frame.
   */
  readonly burstStats = computed(() =>
    mergeStats(this.slots().flatMap((s) => (s ? [s.stats] : []))),
  );
  readonly rangeStats = computed(() =>
    this.autoScope() === 'burst' ? this.burstStats() : (this.current()?.stats ?? null),
  );
  readonly range = computed(() => resolveRange(this.rangeSettings(), this.bitDepth(), this.rangeStats()));

  /** Rough browser-side memory for the planned burst, when the frame size is known. */
  readonly estimate = computed(() => {
    const f = this.form();
    const geometry = recallGeometry(this.deviceId());
    if (!geometry) {
      return null;
    }
    const pixels = geometry.width * geometry.height;
    const perFrame =
      isLossless(f.format)
        ? pixels * bytesPerPixel(f.depth === 'mono16' ? 16 : 8)
        : // Decoded 8-bit pixels plus a JPEG of roughly a tenth of that.
          pixels * 1.1;
    const bytes = perFrame * f.count;
    return { bytes, label: formatBytes(bytes), warn: bytes > MEMORY_WARNING_BYTES, geometry };
  });

  readonly timeLabel = computed(() => {
    const fps = this.playbackFps();
    const position = this.validIndices().indexOf(this.index());
    const total = this.validIndices().length;
    return `${((Math.max(position, 0)) / fps).toFixed(2)} / ${(total / fps).toFixed(2)} s`;
  });

  /** Told while the burst holds the camera, so the settings panels lock meanwhile. */
  private readonly session = inject(GenicamSession, { optional: true });
  /** Why a burst can't be started, if it can't: it needs write access to the device. */
  readonly startBlocked = computed(() => (this.session && !this.session.canWrite() ? this.session.readOnlyReason() : null));

  constructor() {
    effect(() => {
      const status = this.job()?.status;
      const holding = this.starting() || status === 'pending' || status === 'running';
      untracked(() => {
        if (holding) {
          this.session?.holder.set('burst');
        } else if (this.session?.holder() === 'burst') {
          this.session.holder.set(null);
        }
      });
    });

    // The display window is remembered per device and depth, shared with the live view.
    effect(() => {
      const id = this.deviceId();
      const depth = this.bitDepth();
      untracked(() => this.rangeSettings.set(loadRangeSettings(id, depth)));
    });
  }

  ngOnInit(): void {
    // A job outlives the page for 10 minutes on the server; pick it back up after a reload.
    const jobId = loadJobId(this.deviceId());
    if (jobId) {
      this.attach(jobId, true);
    }
  }

  ngOnDestroy(): void {
    if (this.session?.holder() === 'burst') {
      this.session.holder.set(null);
    }
    this.stopPolling();
    this.pause();
    this.exportAborted = true;
  }

  // =========================================================================================
  // Setup
  // =========================================================================================

  updateForm(patch: Partial<BurstForm>): void {
    const next = { ...this.form(), ...patch };
    next.count = Math.min(MAX_COUNT, Math.max(1, Math.round(next.count) || 1));
    if (next.format === 'jpeg') {
      next.depth = 'mono8';
    }
    this.form.set(next);
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(next));
    } catch {
      // Remembering is a convenience only.
    }
  }

  start(): void {
    const f = this.form();
    this.reset();
    this.starting.set(true);
    this.racs
      .startBurst(this.deviceId(), {
        count: f.count,
        format: f.format,
        pixel_depth: isLossless(f.format) ? f.depth : 'mono8',
        on_failure: f.onFailure,
      })
      .subscribe({
        next: (created) => {
          this.starting.set(false);
          saveJobId(this.deviceId(), created.job_id);
          this.attach(created.job_id, false);
        },
        error: (e) => {
          this.starting.set(false);
          this.error.set(errMsg(e));
        },
      });
  }

  /** Stop a running capture. Frames already downloaded stay playable. */
  cancel(): void {
    const job = this.job();
    if (!job) {
      return;
    }
    this.stopPolling();
    this.queue = [];
    this.racs.deleteBurst(this.deviceId(), job.job_id).subscribe({ error: () => undefined });
    clearJobId(this.deviceId());
    this.job.set({ ...job, status: 'cancelled' });
  }

  /** Forget the burst here and on the server, and go back to the form. */
  discard(): void {
    const job = this.job();
    if (job) {
      this.racs.deleteBurst(this.deviceId(), job.job_id).subscribe({ error: () => undefined });
    }
    clearJobId(this.deviceId());
    this.reset();
  }

  private reset(): void {
    this.stopPolling();
    this.pause();
    this.job.set(null);
    this.slots.set([]);
    this.failed.set(new Map());
    this.downloadFailures.set(0);
    this.requested.clear();
    this.queue = [];
    this.index.set(0);
    this.error.set(null);
  }

  // =========================================================================================
  // Job tracking and download
  // =========================================================================================

  private attach(jobId: string, resumed: boolean): void {
    this.stopPolling();
    this.pollSub = timer(0, POLL_MS)
      .pipe(exhaustMap(() => this.racs.getBurst(this.deviceId(), jobId)))
      .subscribe({
        next: (info) => this.onInfo(info),
        error: (e) => {
          this.pollSub = null;
          clearJobId(this.deviceId());
          if (e instanceof HttpErrorResponse && e.status === 404) {
            // Expired or deleted. After a reload that is expected and not worth an error.
            if (!resumed || this.job()) {
              this.error.set('The burst is gone from the server (expired or deleted).');
            }
            if (!this.validIndices().length) {
              this.job.set(null);
            }
            return;
          }
          this.error.set(errMsg(e));
        },
      });
  }

  private onInfo(info: BurstJobInfo): void {
    this.job.set(info);
    if (this.slots().length !== info.requested_count) {
      this.slots.update((s) => Array.from({ length: info.requested_count }, (_, i) => s[i] ?? null));
    }
    if (info.width && info.height) {
      rememberGeometry(this.deviceId(), info.width, info.height);
    }

    // The server records the geometry before it stores the first image, so any status that
    // counts a captured frame also carries what is needed to decode it.
    const attempted = info.captured_count + info.failed_count;
    const known = this.requested.size + this.failed().size;
    if (attempted > known) {
      this.listImages(info.job_id);
    } else if (this.terminal()) {
      this.stopPolling();
    }
  }

  private listImages(jobId: string): void {
    if (this.listing) {
      return;
    }
    this.listing = true;
    this.racs.listBurstImages(this.deviceId(), jobId).subscribe({
      next: (entries) => {
        this.listing = false;
        const failed = new Map(this.failed());
        for (const entry of entries) {
          if (entry.status === 'failed') {
            failed.set(entry.index, entry.error);
          } else if (!this.requested.has(entry.index)) {
            this.requested.add(entry.index);
            this.queue.push(entry.index);
          }
        }
        if (failed.size !== this.failed().size) {
          this.failed.set(failed);
        }
        this.pump(jobId);
      },
      error: (e) => {
        this.listing = false;
        this.error.set(errMsg(e));
      },
    });
  }

  private pump(jobId: string): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const index = this.queue.shift()!;
      this.inFlight++;
      this.racs.getBurstImage(this.deviceId(), jobId, index).subscribe({
        next: (buffer) => {
          this.inFlight--;
          this.store(jobId, index, new Uint8Array(buffer)).finally(() => this.pump(jobId));
        },
        error: () => {
          this.inFlight--;
          if (this.job()?.job_id !== jobId) {
            return;
          }
          this.downloadFailures.update((n) => n + 1);
          this.failed.update((m) => new Map(m).set(index, 'download failed'));
          this.pump(jobId);
        },
      });
    }
  }

  private async store(jobId: string, index: number, bytes: Uint8Array): Promise<void> {
    const job = this.job();
    // A late answer for a burst that has since been discarded or replaced.
    if (!job || job.job_id !== jobId || job.width === null || job.height === null) {
      return;
    }
    try {
      const frame =
        job.format === 'jpeg'
          ? await decodeJpeg(bytes)
          : job.format === 'zstd'
            ? await decodeZstd(bytes, job.width, job.height, job.bit_depth ?? 8)
            : decodeRaw(bytes, job.width, job.height, job.bit_depth ?? 8);
      const original =
        job.format === 'zstd'
          ? new Uint8Array(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength)
          : bytes;
      const entry: BurstFrame = { frame, stats: analyze(frame), original };
      if (this.job()?.job_id !== jobId) {
        return;
      }
      this.slots.update((s) => {
        const next = s.slice();
        next[index] = entry;
        return next;
      });
      // Show something as soon as the first frame lands.
      if (!this.current()) {
        this.index.set(index);
      }
    } catch (e) {
      this.downloadFailures.update((n) => n + 1);
      this.failed.update((m) => new Map(m).set(index, (e as Error).message));
    }
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  // =========================================================================================
  // Player
  // =========================================================================================

  onRangeChange(settings: RangeSettings): void {
    this.rangeSettings.set(settings);
    saveRangeSettings(this.deviceId(), this.bitDepth(), settings);
  }

  togglePlay(): void {
    if (this.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }

  play(): void {
    if (this.validIndices().length < 2 || this.exporting()) {
      return;
    }
    // Starting at the end of a non-looping run restarts it.
    if (!this.loop() && this.nextIndex(this.index(), 1, false) === null) {
      this.index.set(this.validIndices()[0]);
    }
    this.playing.set(true);
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      if (!this.playing()) {
        return;
      }
      carry += now - last;
      last = now;
      const step = 1000 / this.playbackFps();
      while (carry >= step) {
        carry -= step;
        const next = this.nextIndex(this.index(), 1, this.loop());
        if (next === null) {
          this.pause();
          return;
        }
        this.index.set(next);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  step(direction: 1 | -1): void {
    this.pause();
    const next = this.nextIndex(this.index(), direction, true);
    if (next !== null) {
      this.index.set(next);
    }
  }

  seek(value: number): void {
    this.pause();
    // Snap to the nearest frame that exists, so failed indices are skipped over.
    const valid = this.validIndices();
    if (!valid.length) {
      return;
    }
    let best = valid[0];
    for (const i of valid) {
      if (Math.abs(i - value) < Math.abs(best - value)) {
        best = i;
      }
    }
    this.index.set(best);
  }

  onKey(event: KeyboardEvent): void {
    // The image view used the key already (a ROI nudged with the arrows, say).
    if (event.defaultPrevented || (event.target as HTMLElement).closest('input, select, textarea')) {
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      this.togglePlay();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.step(-1);
    }
  }

  private nextIndex(from: number, direction: 1 | -1, wrap: boolean): number | null {
    const valid = this.validIndices();
    if (!valid.length) {
      return null;
    }
    const pos = valid.indexOf(from);
    const next = (pos === -1 ? 0 : pos) + direction;
    if (next >= 0 && next < valid.length) {
      return valid[next];
    }
    return wrap ? valid[(next + valid.length) % valid.length] : null;
  }

  /** The window a given frame renders with, under the current range settings. */
  private rangeFor(slot: BurstFrame): DisplayRange {
    const stats = this.autoScope() === 'burst' ? this.burstStats() : slot.stats;
    return resolveRange(this.rangeSettings(), slot.frame.bitDepth, stats);
  }

  // =========================================================================================
  // Export
  // =========================================================================================

  /**
   * Record the burst as WebM by drawing each frame onto the player canvas and capturing it.
   * MediaRecorder timestamps by wall clock, so frames are paced at the playback rate and the
   * export takes as long as the video.
   */
  async exportWebm(): Promise<void> {
    const player = this.canvas();
    const job = this.job();
    if (!player || !job || !this.canRecord || this.exporting()) {
      return;
    }
    this.pause();
    this.exportAborted = false;
    const valid = this.validIndices();
    const fps = this.playbackFps();
    const canvas = player.canvas;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    if (!mimeType) {
      this.error.set('This browser cannot record WebM.');
      return;
    }

    this.exporting.set({ kind: 'WebM', progress: 0 });
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();

    try {
      for (let n = 0; n < valid.length && !this.exportAborted; n++) {
        const slot = this.slots()[valid[n]]!;
        this.index.set(valid[n]);
        player.draw(slot.frame, this.rangeFor(slot));
        track.requestFrame?.();
        this.exporting.set({ kind: 'WebM', progress: (n + 1) / valid.length });
        await sleep(1000 / fps);
      }
    } finally {
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      this.exporting.set(null);
    }
    if (!this.exportAborted) {
      saveBlob(new Blob(chunks, { type: 'video/webm' }), `${this.baseName(job)}.webm`);
    }
  }

  /**
   * Every frame as the server sent it (zstd ones decoded to raw, so the files read like any raw
   * export), plus a `meta.json` describing how to decode them.
   */
  downloadOriginal(): void {
    const job = this.job();
    if (!job) {
      return;
    }
    const raw = isLossless(job.format);
    const ext = raw ? 'raw' : 'jpg';
    const entries: ZipEntry[] = this.validIndices().map((i) => ({
      name: `frame_${pad(i)}.${ext}`,
      data: this.slots()[i]!.original,
    }));
    const meta = {
      job_id: job.job_id,
      device_id: job.device_id,
      format: raw ? 'raw' : job.format,
      width: job.width,
      height: job.height,
      pixel_format: job.pixel_format,
      bit_depth: job.bit_depth,
      // Raw only: 1 byte per pixel at 8 bit, else little-endian u16.
      bytes_per_pixel: raw ? bytesPerPixel(job.bit_depth ?? 8) : undefined,
      endianness: raw ? 'little' : undefined,
      captured_at: job.started_at,
      frames: this.validIndices(),
      failed: Object.fromEntries(this.failed()),
    };
    entries.push({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
    saveBlob(zipStore(entries), `${this.baseName(job)}-${ext}.zip`);
  }

  /** Every frame as an 8-bit PNG, rendered with the display range currently set. */
  async downloadRendered(): Promise<void> {
    const job = this.job();
    if (!job || this.exporting()) {
      return;
    }
    this.pause();
    this.exportAborted = false;
    const valid = this.validIndices();
    const entries: ZipEntry[] = [];
    this.exporting.set({ kind: 'PNG', progress: 0 });
    try {
      for (let n = 0; n < valid.length && !this.exportAborted; n++) {
        const slot = this.slots()[valid[n]]!;
        const { lo, hi } = this.rangeFor(slot);
        const blob = await toPng(renderToCanvas(slot.frame, lo, hi));
        entries.push({ name: `frame_${pad(valid[n])}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        this.exporting.set({ kind: 'PNG', progress: (n + 1) / valid.length });
      }
    } finally {
      this.exporting.set(null);
    }
    if (!this.exportAborted) {
      saveBlob(zipStore(entries), `${this.baseName(job)}-png.zip`);
    }
  }

  abortExport(): void {
    this.exportAborted = true;
  }

  private baseName(job: BurstJobInfo): string {
    const when = (job.started_at ?? job.created_at).replace(/[:.]/g, '-').slice(0, 19);
    return `burst-dev${job.device_id}-${when}`;
  }
}

function toPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(i: number): string {
  return i.toString().padStart(4, '0');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.ceil(bytes / 1024)} kB`;
}

function errMsg(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (typeof e.error === 'string' && e.error) {
      return e.error;
    }
    return e.status ? `Request failed (${e.status})` : 'Server unreachable';
  }
  return e instanceof Error ? e.message : 'Request failed';
}

function loadForm(): BurstForm {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (raw) {
      const f = JSON.parse(raw) as Partial<BurstForm>;
      const format: BurstFormat = f.format === 'jpeg' || f.format === 'zstd' ? f.format : 'raw';
      return {
        count:
          typeof f.count === 'number' ? Math.min(MAX_COUNT, Math.max(1, f.count)) : DEFAULT_FORM.count,
        format,
        depth: f.depth === 'mono16' && isLossless(format) ? 'mono16' : 'mono8',
        onFailure: f.onFailure === 'skip' ? 'skip' : 'abort',
      };
    }
  } catch {
    // Fall through to the defaults.
  }
  return { ...DEFAULT_FORM };
}

function loadJobId(deviceId: number): string | null {
  try {
    return localStorage.getItem(`${JOB_KEY}.${deviceId}`);
  } catch {
    return null;
  }
}

function saveJobId(deviceId: number, jobId: string): void {
  try {
    localStorage.setItem(`${JOB_KEY}.${deviceId}`, jobId);
  } catch {
    // Reattaching after a reload is a convenience only.
  }
}

function clearJobId(deviceId: number): void {
  try {
    localStorage.removeItem(`${JOB_KEY}.${deviceId}`);
  } catch {
    // Nothing to clear.
  }
}
