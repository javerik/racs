import { Component, computed, effect, inject, input, type OnDestroy, output, signal, untracked } from '@angular/core';
import {
  type BurstJobInfo,
  type CloudScaling,
  composeMetric,
  envelopeExtent,
  errMsg,
  fitLinearScaling,
  formatUnits,
  GenicamSession,
  hasCameraScaling,
  isPixelScaling,
  LaserlineLinkService,
  METRIC_FLAT_GAIN,
  METRIC_FOLLOW_APPROX_Y_SHARE,
  METRIC_FOLLOW_SHARE,
  metricDomain,
  metricScaling,
  metricStates,
  type MetricState,
  pickRate,
  PIXEL_SCALING,
  RacsService,
  RANGE_WARN_RMS_PX,
  RangeCalibrationService,
  RATE_FEATURES,
  type RateFeatureValues,
  type RateSource,
  readCameraCoordinates,
  sanitizeScaling,
  scalingFromCoordinates,
  scalingMoved,
  type ScalingSource,
  ySpacingFrom,
} from 'ng-racs-core';
import { ArmedDirective } from '../../shared/armed.directive';
import { PlotComponent, type PlotLine } from '../shared/plot.component';
import { type StlCloud, StlCheckComponent } from './stl-check.component';

/** How often laserline is asked to report while the source is *Laserline*: it only reports changes. */
export const METRIC_HELLO_MS = 3_000;
/** The `GenicamSession` watcher of the rate features. */
const WATCH_OWNER = 'metric-scaling';

type Field = 'unit' | 'xPitch' | 'ySpacing' | 'zScale' | 'zOffset';

const RATE_SOURCE_TEXT: Record<RateSource, string> = {
  live: 'live estimate',
  last: 'last estimate',
  feature: 'AcquisitionLineRate',
  burst: 'burst timing, rough',
};

const TONE_DOT: Record<MetricState['tone'], string> = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', faint: 'bg-faint' };

/**
 * The 3D tab's Scaling section (#33 §3): the source (Manual · From camera · Laserline), the five
 * values, and for *Laserline* the range calibration with its review, what laserline and the camera
 * contribute, and the live follow, which applies the derived scaling whenever it moves by more
 * than 0.2 %.
 *
 * It is projected into an inspector section, so it exists (and follows) while the section is
 * folded or another mobile tab is open. The parent stores what `scalingChange` emits.
 */
@Component({
  selector: 'racs-metric-scaling',
  standalone: true,
  imports: [ArmedDirective, PlotComponent, StlCheckComponent],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    <div class="flex w-full" role="radiogroup" aria-label="Scaling source">
      @for (s of sources(); track s.id; let first = $first) {
      @let on = source() === s.id;
      <button type="button" role="radio" class="btn flex-1 rounded-none px-1.5" [style.margin-left.px]="first ? 0 : -1"
        [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
        [attr.aria-busy]="s.id === 'camera' && readingCamera()" [disabled]="s.disabled" [title]="s.hint" (click)="setSource(s.id)">
        {{ s.id === 'camera' && readingCamera() ? 'Reading…' : s.label }}
      </button>
      }
    </div>

    @if (source() === 'laserline') {
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Laserline scaling state">
      @for (st of states(); track st.id) {
      <li class="grid grid-cols-[0.5rem_minmax(0,1fr)] items-center gap-x-2 font-mono text-2xs" [attr.data-state]="st.id">
        <span class="dot" [class]="dotClass(st.tone)"></span>
        <span class="uppercase tracking-[0.08em]" [class]="st.tone === 'faint' ? 'text-muted' : 'text-fg'">{{ st.word }}</span>
        @if (st.detail) {
        <span class="col-start-2 text-faint">{{ st.detail }}</span>
        }
      </li>
      }
    </ul>
    @if (metric()?.model_mirrored) {
    <p class="m-0 font-mono text-2xs text-faint">laserline's scan is itself a mirror image of the model (its slice settings)</p>
    }

    @if (running()) {
    <div class="flex flex-col gap-1.5" role="status">
      <div class="flex items-center gap-2 font-mono text-2xs">
        <span class="dot shrink-0 animate-pulse bg-accent"></span>
        <span class="flex-1 text-fg">{{ calib.task() === 'verify' ? 'verifying' : 'calibrating' }} · {{ calib.stepText() }}</span>
        <span class="text-muted">{{ percent() }} %</span>
      </div>
      <div class="h-0.5 bg-line"><div class="h-0.5 bg-accent" [style.width.%]="percent()"></div></div>
      <p class="m-0 font-mono text-2xs text-faint">keep the camera and the laserline window still · the cloud pauses meanwhile</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn mobile:flex-1" (click)="calib.cancel()">Cancel</button>
    </div>
    } @else {
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn btn-primary mobile:flex-1" [disabled]="!!calib.blocked()"
        [title]="calib.blocked() ?? 'Has laserline show lines and measures how the camera’s columns and values map onto its view (opens laserline if needed)'"
        (click)="calib.calibrate()">Calibrate</button>
      @if (cal()) {
      <button type="button" class="btn mobile:flex-1" [disabled]="!!calib.blocked()"
        [title]="calib.blocked() ?? '3 parallel and 2 crossing lines against the kept calibration; more than twice its rms marks it stale'"
        (click)="calib.verify()">Verify</button>
      <button type="button" class="btn mobile:flex-1" racsArmed #forget="armed" title="Forget this camera's range calibration" (confirmed)="calib.forget()">
        {{ forget.armed() ? 'Confirm' : 'Forget' }}
      </button>
      }
    </div>
    @if (calib.blocked(); as why) {
    <p class="m-0 font-mono text-2xs text-faint">{{ why }}</p>
    }
    }
    @if (calib.error(); as err) {
    @if (!running()) {
    <div class="notice-err">{{ calib.task() === 'verify' ? 'Verify' : 'Calibration' }}: {{ err }}</div>
    }
    }
    @for (w of calib.warnings(); track w) {
    <p class="m-0 font-mono text-2xs text-warn">{{ w }}</p>
    }

    @if (cal(); as c) {
    <div class="flex flex-col gap-1.5">
      <span class="label">Calibration</span>
      <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-2xs">
        <span class="text-muted">rms / max</span>
        <span class="text-fg" [class.!text-warn]="c.rms > warnRms">{{ c.rms.toFixed(2) }} / {{ c.max.toFixed(2) }} px</span>
        <span class="text-muted">lines</span>
        <span class="text-fg">{{ lineCounts().parallel }} parallel · {{ lineCounts().crossing }} crossing</span>
        <span class="text-muted">band</span>
        <span class="text-fg">{{ signed(c.band[0]) }} … {{ signed(c.band[1]) }} px</span>
        @if (c.verify; as v) {
        <span class="text-muted">verify</span>
        <span [class]="v.ok ? 'text-fg' : 'text-warn'">{{ v.ok ? 'ok' : 'failed' }} · {{ v.rms.toFixed(2) }} px of {{ v.limit.toFixed(2) }} · {{ v.seen }}/{{ v.shown }} lines</span>
        }
        <span class="text-muted">taken</span>
        <span class="text-faint">{{ takenAt() }}</span>
      </div>
      @if (residualLines(); as lines) {
      <div class="h-28">
        <racs-plot [lines]="lines" xLabel="column" [yFromZero]="true" placeholder="no residuals" />
      </div>
      <span class="font-mono text-2xs text-faint">largest residual per column, view px · this run</span>
      }
    </div>
    }

    <div class="flex flex-col gap-1.5">
      <span class="label">Inputs</span>
      <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-2xs">
        @if (metric(); as m) {
        <span class="text-muted">along</span>
        <span class="text-fg">{{ m.along_px_per_mm.toFixed(3) }} px/mm</span>
        <span class="text-muted">height</span>
        <span class="text-fg">{{ m.height_px_per_mm.toFixed(3) }} px/mm</span>
        <span class="text-muted">travel</span>
        <span class="text-fg">{{ m.travel.mm_per_s.toFixed(2) }} mm/s <span class="text-faint">· {{ m.travel.mode === 'per_frame' ? 'per frame' : 'per second' }}{{ m.travel.playing ? '' : ' · paused' }}</span></span>
        } @else {
        <span class="text-muted">laserline</span>
        <span class="text-faint">{{ online() ? 'no mapping' : 'offline' }}</span>
        }
        <span class="text-muted">camera</span>
        @if (rate(); as r) {
        <span class="text-fg">{{ r.rate.toFixed(r.rate < 100 ? 1 : 0) }} profiles/s <span class="text-faint">· {{ rateSourceText(r.source) }}</span></span>
        } @else {
        <span class="text-faint">profiles/s unknown · stream for 10 s</span>
        }
      </div>
    </div>

    @if (fit(); as f) {
    <div class="flex flex-col gap-1.5">
      <span class="label">Derived</span>
      <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-2xs">
        <span class="text-muted">x pitch</span>
        <span class="text-fg">{{ fmt(f.xPitch) }} mm{{ f.mirrorX ? ' · mirrored' : '' }}</span>
        <span class="text-muted">y spacing</span>
        <span class="text-fg">{{ ySpacing() === null ? '—' : fmt(ySpacing()!) + ' mm' }}</span>
        <span class="text-muted">z</span>
        <span class="text-fg">{{ fmt(f.zScale) }} × value {{ f.zOffset < 0 ? '−' : '+' }} {{ fmt(Math.abs(f.zOffset)) }} mm</span>
        <span class="text-muted">x residual</span>
        <span class="text-fg">{{ f.residual.x.rms.toFixed(3) }} / {{ f.residual.x.max.toFixed(3) }} mm <span class="text-faint">rms / max</span></span>
        <span class="text-muted">z residual</span>
        <span class="text-fg">{{ f.residual.z.rms.toFixed(3) }} / {{ f.residual.z.max.toFixed(3) }} mm <span class="text-faint">rms / max</span></span>
      </div>
    </div>
    }

    <racs-stl-check [scaling]="scaling()" [metric]="metric()" [rate]="rate()?.rate ?? null" [height]="profilesPerFrame()"
      [captureBlocked]="running() ? 'a calibration is running' : stlBlocked()" [checking]="stlChecking()" [cloud]="stlCloud()"
      (capture)="stlCapture.emit($event)" />
    }

    @let s = scaling();
    <div class="grid grid-cols-2 gap-x-2 gap-y-2.5">
      <label class="flex flex-col gap-1">
        <span class="label">Unit</span>
        <input type="text" class="field" maxlength="8" [value]="s.unit" (change)="setField('unit', $any($event.target).value)" />
      </label>
      <label class="flex flex-col gap-1" title="Units per column">
        <span class="label">X pitch</span>
        <input type="number" class="field" min="0" step="any" [value]="shown(s.xPitch)" (change)="setField('xPitch', $any($event.target).value)" />
      </label>
      <label class="flex flex-col gap-1" title="Units per profile">
        <span class="label">Y spacing</span>
        <input type="number" class="field" min="0" step="any" [value]="shown(s.ySpacing)" (change)="setField('ySpacing', $any($event.target).value)" />
      </label>
      <label class="flex flex-col gap-1" title="Units per count of the value">
        <span class="label">Z scale</span>
        <input type="number" class="field" step="any" [value]="shown(s.zScale)" (change)="setField('zScale', $any($event.target).value)" />
      </label>
      <label class="flex flex-col gap-1" title="Added to every scaled value">
        <span class="label">Z offset</span>
        <input type="number" class="field" step="any" [value]="shown(s.zOffset)" (change)="setField('zOffset', $any($event.target).value)" />
      </label>
      <div class="flex flex-col gap-1">
        <span class="label">X order</span>
        <button type="button" class="btn" [attr.aria-pressed]="!!s.mirrorX" [class.!border-accent]="!!s.mirrorX" [class.!text-fg]="!!s.mirrorX"
          title="Run x from the last column to the first (the box stays where it is)" (click)="toggleMirror()">
          {{ s.mirrorX ? 'Mirrored' : 'Plain' }}
        </button>
      </div>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn mobile:flex-1" [disabled]="pixels()" title="Back to pixels, profiles and raw counts" (click)="reset()">Reset to px</button>
    </div>
    @if (error(); as err) {
    <div class="notice-err">{{ err }}</div>
    }
    <p class="m-0 font-mono text-2xs text-faint">
      x = {{ s.mirrorX ? '(last − column)' : 'column' }} × pitch · y = profile × spacing · z = value × scale + offset
      @if (source() !== 'manual') {
      <span class="block">an edit switches the source to manual</span>
      }
    </p>
  `,
})
export class MetricScalingComponent implements OnDestroy {
  /** The scaling applied now. */
  readonly scaling = input.required<CloudScaling>();
  /** The running stream's profile rate (`ProfileRateEstimator.rate()`), null while unknown. */
  readonly liveRate = input<number | null>(null);
  /** The last finished snapshot, for a rough rate without a stream. */
  readonly burst = input<BurstJobInfo | null>(null);
  readonly scalingChange = output<CloudScaling>();
  // The check against the STL (#33 §5), passed through to `racs-stl-check`.
  /** Profiles per frame, null while unknown. */
  readonly profilesPerFrame = input<number | null>(null);
  /** Why the tab can't take the check's snapshot now. */
  readonly stlBlocked = input<string | null>(null);
  readonly stlChecking = input(false);
  /** The check's finished snapshot. */
  readonly stlCloud = input<StlCloud | null>(null);
  /** Take the check's snapshot of this many frames. */
  readonly stlCapture = output<number>();

  readonly calib = inject(RangeCalibrationService);
  private readonly link = inject(LaserlineLinkService);
  private readonly session = inject(GenicamSession, { optional: true });
  private readonly racs = inject(RacsService);

  readonly Math = Math;
  readonly warnRms = RANGE_WARN_RMS_PX;
  readonly error = signal<string | null>(null);
  readonly readingCamera = signal(false);

  readonly source = computed<ScalingSource>(() => this.scaling().source ?? 'manual');
  readonly pixels = computed(() => isPixelScaling(this.scaling()));
  private readonly cameraScaling = computed(() => !!this.session && hasCameraScaling(this.session.nodes()));
  readonly sources = computed(() => {
    const out: { id: ScalingSource; label: string; hint: string; disabled: boolean }[] = [
      // A running calibration keeps the source.
      { id: 'manual', label: 'Manual', hint: 'The values as typed', disabled: this.running() },
    ];
    if (this.cameraScaling()) {
      const blocked = this.running() || this.readingCamera() || this.session?.holder() === 'burst' || this.session?.role() === 'meta';
      out.push({
        id: 'camera',
        label: 'From camera',
        hint: 'Read Scan3dCoordinateScale and Offset of coordinates A, B and C from the camera',
        disabled: blocked,
      });
    }
    out.push({
      id: 'laserline',
      label: 'Laserline',
      hint: 'mm from laserline’s metric mapping and a range calibration, followed live',
      disabled: false,
    });
    return out;
  });

  readonly running = computed(() => this.calib.phase() === 'running');
  readonly percent = computed(() => Math.round(this.calib.progress() * 100));
  readonly cal = this.calib.result;
  readonly online = computed(() => !!this.link.host());
  readonly metric = computed(() => this.link.metric());

  readonly lineCounts = computed(() => {
    const lines = this.cal()?.lines ?? [];
    return { parallel: lines.filter((l) => l.kind === 'parallel').length, crossing: lines.filter((l) => l.kind === 'crossing').length };
  });
  readonly takenAt = computed(() => {
    const at = this.cal()?.at;
    return at ? new Date(at).toLocaleString() : '';
  });
  readonly residualLines = computed<PlotLine[] | null>(() => {
    const r = this.calib.report()?.residuals;
    if (!r) {
      return null;
    }
    return [{ id: 'residual', label: 'px', color: 'rgb(var(--fg))', xs: Array.from(r, (_, i) => i), ys: r, style: 'data' }];
  });

  // --- rate ------------------------------------------------------------------------------------
  /** The rate features now, as `pickRate` compares them. */
  private readonly features = computed<RateFeatureValues | null>(() => {
    if (!this.session) {
      return null;
    }
    const states = this.session.states();
    const out: RateFeatureValues = {};
    for (const name of RATE_FEATURES) {
      out[name] = states[name]?.value ?? null;
    }
    return out;
  });
  /** The last live estimate, with the rate features then. */
  private readonly last = signal<{ rate: number; features: RateFeatureValues | null } | null>(null);
  readonly rate = computed(() =>
    pickRate({
      live: this.liveRate(),
      last: this.last()?.rate,
      lastFeatures: this.last()?.features,
      features: this.features(),
      burst: this.burst(),
    }),
  );

  // --- the derived scaling ---------------------------------------------------------------------
  private readonly domain = computed(() => {
    const cal = this.cal();
    const metric = this.metric();
    return cal && metric ? metricDomain(cal, metric.base, this.link.status()?.envelope) : null;
  });
  readonly fit = computed(() => {
    const cal = this.cal();
    const metric = this.metric();
    const domain = this.domain();
    return cal && metric && domain ? fitLinearScaling(domain, composeMetric(cal.g, metric)) : null;
  });
  private readonly fitProblem = computed(() => {
    const metric = this.metric();
    if (!this.cal() || !metric || this.fit()) {
      return null;
    }
    return metric.disturbances.includes('flat') || !(Math.abs(metric.height_px_per_mm) >= METRIC_FLAT_GAIN)
      ? 'laserline’s height gain is 0: heights do not move its line'
      : 'the calibration gives no linear scaling here: calibrate again';
  });
  readonly ySpacing = computed(() => {
    const metric = this.metric();
    const rate = this.rate();
    return metric && rate ? ySpacingFrom(metric.travel, rate.rate) : null;
  });
  /** What the live follow applies; without a rate, y stays as it is. */
  readonly derived = computed(() => {
    const fit = this.fit();
    return fit ? metricScaling(fit, this.ySpacing() ?? this.scaling().ySpacing) : null;
  });
  private readonly outOfBand = computed(() => {
    const cal = this.cal();
    const env = cal ? envelopeExtent(this.link.status()?.envelope, cal.base) : null;
    return !!cal && !!env && (env.across[0] < cal.band[0] || env.across[1] > cal.band[1]);
  });
  readonly states = computed(() =>
    metricStates({
      online: this.online(),
      metric: this.metric(),
      calibrated: !!this.cal(),
      staleReason: this.calib.staleReason(),
      fitProblem: this.fitProblem(),
      rate: this.rate(),
      outOfBand: this.outOfBand(),
    }),
  );

  constructor() {
    effect(() => {
      const rate = this.liveRate();
      if (rate !== null && Number.isFinite(rate) && rate > 0) {
        untracked(() => this.last.set({ rate, features: this.features() }));
      }
    });

    effect(() => {
      const session = this.session;
      const names = session ? RATE_FEATURES.filter((n) => session.nodes().has(n)) : [];
      if (session && names.length) {
        untracked(() => session.watch(WATCH_OWNER, names));
      }
    });

    // Laserline only reports changes: asking now and then tells an open window from a closed one.
    effect((onCleanup) => {
      if (this.source() !== 'laserline' || !this.link.supported) {
        return;
      }
      const poll = () => {
        if (this.calib.phase() !== 'running') {
          void this.link.hello();
        }
      };
      untracked(poll);
      const timer = setInterval(poll, METRIC_HELLO_MS);
      onCleanup(() => clearInterval(timer));
    });

    // The live follow: a new rev, G or rate recomputes; only a change above the share applies.
    effect(() => {
      const next = this.derived();
      const domain = this.domain();
      if (this.source() !== 'laserline' || !next || !domain) {
        return;
      }
      const yShare = this.metric()?.travel.approximate ? METRIC_FOLLOW_APPROX_Y_SHARE : METRIC_FOLLOW_SHARE;
      if (scalingMoved(untracked(this.scaling), next, domain.values, { yShare })) {
        this.scalingChange.emit(next);
      }
    });
  }

  ngOnDestroy(): void {
    this.session?.unwatch(WATCH_OWNER);
  }

  setSource(source: ScalingSource): void {
    if (source === 'camera') {
      void this.fromCamera();
      return;
    }
    if (source !== this.source()) {
      this.scalingChange.emit({ ...this.scaling(), source });
    }
  }

  /** A typed value; any edit makes the scaling manual. */
  setField(field: Field, raw: string | number): void {
    const value = field === 'unit' ? String(raw) : Number(raw);
    const current = this.scaling();
    this.scalingChange.emit({ ...sanitizeScaling({ ...current, [field]: value }, current), source: 'manual' });
  }

  toggleMirror(): void {
    const current = this.scaling();
    this.scalingChange.emit({ ...current, mirrorX: !current.mirrorX, source: 'manual' });
  }

  reset(): void {
    this.scalingChange.emit({ ...PIXEL_SCALING });
  }

  /** The camera's own Scan3d scaling; it has no mirror of its own. */
  async fromCamera(): Promise<void> {
    if (!this.session || this.readingCamera()) {
      return;
    }
    this.readingCamera.set(true);
    this.error.set(null);
    try {
      const coordinates = await readCameraCoordinates(this.session, this.racs);
      const { mirrorX: _, ...next } = scalingFromCoordinates(coordinates, this.scaling());
      this.scalingChange.emit({ ...next, source: 'camera' });
    } catch (e) {
      this.error.set(`Could not read the camera's scaling: ${errMsg(e)}`);
    } finally {
      this.readingCamera.set(false);
    }
  }

  /** What the PLY export's header says about the scaling. */
  plyComments(): string[] {
    const s = this.scaling();
    const out = [`scaling source ${s.source ?? 'manual'}`];
    if (s.source !== 'laserline') {
      return out;
    }
    const cal = this.cal();
    if (cal) {
      out.push(`range calibration G rms ${cal.rms.toFixed(3)} px, max ${cal.max.toFixed(3)} px, ${cal.lines.length} lines${this.calib.stale() ? ', stale' : ''}`);
    }
    const m = this.metric();
    out.push(
      m
        ? `laserline metric rev ${m.rev}, travel ${m.travel.mm_per_s.toFixed(3)} mm/s (${m.travel.mode}${m.travel.approximate ? ', approximate' : ''})`
        : 'laserline offline: the last mapping applied',
    );
    const r = this.rate();
    out.push(r ? `profile rate ${r.rate.toFixed(2)} /s (${RATE_SOURCE_TEXT[r.source]})` : 'profile rate unknown');
    return out;
  }

  dotClass(tone: MetricState['tone']): string {
    return TONE_DOT[tone];
  }

  rateSourceText(source: RateSource): string {
    return RATE_SOURCE_TEXT[source];
  }

  /** A field's value: 6 significant digits, so a derived one fits the field. */
  shown(v: number): number {
    return Number(v.toPrecision(6));
  }

  fmt(v: number): string {
    return formatUnits(v);
  }

  signed(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}`;
  }
}
