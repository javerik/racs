import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import {
  type Fit,
  fitSummary,
  gaussianFit,
  type GrayFrame,
  linearFit,
  lineProfile,
  movingAverage,
  type PlotKind,
  type PlotMode,
  type PlotSettings,
  polyFit,
  rectProjection,
  type Roi,
  roiHistogram,
  roiKey,
  RoiSession,
  roiSizeLabel,
  roiStats,
  type RoiStats,
  type Series,
  seriesColor,
  TimeSeries,
  type TimeStat,
} from 'ng-racs-core';
import { IconComponent } from '../../shared/icon.component';
import { PlotComponent, type PlotLine } from './plot.component';

/** Live measurements are refreshed at most this often (ms). */
const LIVE_INTERVAL_MS = 100;
/** Burst time series: work this long (ms) before yielding to the page. */
const CHUNK_MS = 24;

const KINDS: { id: PlotKind; label: string; hint: string }[] = [
  { id: 'profile', label: 'Profile', hint: 'Values along a line ROI' },
  { id: 'projection', label: 'Projection', hint: 'Column or row means of a rect ROI' },
  { id: 'time', label: 'Time', hint: 'A ROI statistic over time (live) or over the burst' },
  { id: 'histogram', label: 'Histogram', hint: 'Distribution of the values in a ROI' },
];

const MODES: { id: PlotMode; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'smooth', label: 'Moving average' },
  { id: 'linear', label: 'Linear fit' },
  { id: 'poly', label: 'Polynomial fit' },
  { id: 'gaussian', label: 'Gaussian fit' },
];

const STATS: TimeStat[] = ['mean', 'min', 'max', 'std'];

/**
 * Measurements of the soft ROIs: a statistics table and a plot (line profile, rect projection,
 * a statistic over time, or a histogram) with smoothing and fits. Each has its own auto-update
 * switch: off, it holds the frame it last measured (ROIs can still be moved over it) until
 * Update. Live: pass `frame` (and frames keep arriving). Burst: also pass `frames` and the
 * player's `index`, so the time series covers the whole burst with the playhead on it.
 */
@Component({
  selector: 'racs-roi-analysis',
  standalone: true,
  imports: [IconComponent, PlotComponent],
  template: `
    <section class="flex flex-col border-t border-line">
      <button type="button" [attr.aria-expanded]="session.open()"
        class="flex h-9 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 text-left hover:bg-raised mobile:h-11"
        (click)="session.setOpen(!session.open())">
        <span class="w-3 font-mono text-xs text-muted">{{ session.open() ? '−' : '+' }}</span>
        <span class="label flex-1 text-fg">ROI analysis</span>
        <span class="font-mono text-2xs text-faint">{{ rois().length }}</span>
      </button>

      @if (session.open()) {
      @if (rois().length === 0) {
      <p class="m-0 border-t border-line px-4 py-3 font-mono text-2xs text-faint">
        no roi · draw one with the rect or line tool in the view toolbar
      </p>
      } @else {
      <!-- Statistics -->
      <div class="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1">
        <span class="label flex-1">Statistics</span>
        @if (!session.auto().stats) {
        <button type="button" class="btn" title="Measure the current frame" (click)="refreshStats()">Update</button>
        }
        <button type="button" class="btn" [attr.aria-pressed]="session.auto().stats"
          [class.!border-accent]="session.auto().stats" [class.!text-fg]="session.auto().stats"
          [class.text-muted]="!session.auto().stats"
          title="Follow every frame; off holds the last one" (click)="toggleAuto('stats')">Auto</button>
      </div>
      <div class="overflow-x-auto border-t border-line">
        <table class="tbl text-xs">
          <thead>
            <tr>
              <th>ROI</th>
              <th class="mobile:hidden">Size</th>
              <th class="text-right">n</th>
              <th class="text-right">Min</th>
              <th class="text-right">Max</th>
              <th class="text-right">Mean</th>
              <th class="text-right">Std</th>
              <th class="w-10"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (row of statRows(); track row.roi.id) {
            @let sel = row.roi.id === session.selectedId();
            <tr class="group cursor-pointer font-mono hover:bg-raised" [class.bg-raised]="sel"
              (click)="session.select(sel ? null : row.roi.id)">
              <td class="relative !h-9" [class.sel]="sel">
                <span class="inline-flex items-center gap-2">
                  <span class="swatch" [class.line]="row.roi.shape === 'line'" [style.background]="color(row.roi)"></span>
                  <span class="text-fg">{{ row.roi.name }}</span>
                  <span class="text-faint">{{ row.roi.shape }}</span>
                </span>
              </td>
              <td class="!h-9 text-muted mobile:hidden">{{ row.size }}</td>
              @if (row.stats; as s) {
              <td class="!h-9 text-right text-muted">{{ s.n }}</td>
              <td class="!h-9 text-right">{{ num(s.min) }}</td>
              <td class="!h-9 text-right">{{ num(s.max) }}</td>
              <td class="!h-9 text-right text-fg">{{ s.mean.toFixed(2) }}</td>
              <td class="!h-9 text-right">{{ s.std.toFixed(2) }}</td>
              } @else {
              <td class="!h-9 text-right text-faint" colspan="5">{{ statsFrame() ? 'outside the frame' : 'no frame' }}</td>
              }
              <td class="relative !h-9 !px-2">
                <button type="button" class="icon-btn row-action !right-2" title="Delete this ROI" aria-label="Delete ROI"
                  (click)="$event.stopPropagation(); session.remove(row.roi.id)"><racs-icon name="trash" /></button>
              </td>
            </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Plot -->
      <div class="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-4 py-1.5">
        <span class="label">Plot</span>
        <div class="inline-flex flex-wrap" role="radiogroup" aria-label="Plot">
          @for (k of kinds; track k.id; let first = $first) {
          <button type="button" role="radio" class="btn rounded-none" [class.-ml-px]="!first"
            [attr.aria-checked]="plot().kind === k.id" [class.!border-accent]="plot().kind === k.id"
            [class.!text-fg]="plot().kind === k.id" [class.text-muted]="plot().kind !== k.id" [title]="k.hint"
            (click)="session.updatePlot({ kind: k.id })">{{ k.label }}</button>
          }
        </div>
        <span class="flex-1"></span>
        @if (!session.auto().plot) {
        <button type="button" class="btn" title="Plot the current frame" (click)="refreshPlot()">Update</button>
        }
        <button type="button" class="btn" [attr.aria-pressed]="session.auto().plot"
          [class.!border-accent]="session.auto().plot" [class.!text-fg]="session.auto().plot"
          [class.text-muted]="!session.auto().plot"
          title="Follow every frame; off holds the plot" (click)="toggleAuto('plot')">Auto</button>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2">
        <label class="flex items-center gap-2">
          <span class="label">Show</span>
          <select class="field w-auto" (change)="session.updatePlot({ mode: $any($event.target).value })">
            @for (m of modes; track m.id) {
            <option [value]="m.id" [selected]="m.id === plot().mode">{{ m.label }}</option>
            }
          </select>
        </label>
        @if (plot().mode === 'smooth') {
        <label class="flex items-center gap-2">
          <span class="label">Window</span>
          <input type="number" class="field w-16" min="2" max="101" [value]="plot().window"
            (change)="session.updatePlot({ window: $any($event.target).valueAsNumber })" />
        </label>
        }
        @if (plot().mode === 'poly') {
        <label class="flex items-center gap-2">
          <span class="label">Degree</span>
          <select class="field w-auto" (change)="session.updatePlot({ degree: +$any($event.target).value })">
            @for (d of [2, 3, 4, 5]; track d) {
            <option [value]="d" [selected]="d === plot().degree">{{ d }}</option>
            }
          </select>
        </label>
        }
        @if (plot().kind === 'projection') {
        <div class="inline-flex" role="radiogroup" aria-label="Project onto">
          @for (a of ['x', 'y']; track a; let first = $first) {
          <button type="button" role="radio" class="btn rounded-none" [class.-ml-px]="!first"
            [attr.aria-checked]="plot().axis === a" [class.!border-accent]="plot().axis === a"
            [class.!text-fg]="plot().axis === a" [class.text-muted]="plot().axis !== a"
            [title]="a === 'x' ? 'Mean of each column' : 'Mean of each row'"
            (click)="session.updatePlot({ axis: $any(a) })">{{ a === 'x' ? 'Columns' : 'Rows' }}</button>
          }
        </div>
        }
        @if (plot().kind === 'time') {
        <label class="flex items-center gap-2">
          <span class="label">Stat</span>
          <select class="field w-auto" (change)="session.updatePlot({ stat: $any($event.target).value })">
            @for (s of stats; track s) {
            <option [value]="s" [selected]="s === plot().stat">{{ s }}</option>
            }
          </select>
        </label>
        }
        @if (plot().kind === 'profile' && primary()?.shape === 'line') {
        <label class="flex items-center gap-2" title="Pixels averaged across the line">
          <span class="label">Width</span>
          <input type="number" class="field w-16" min="1" max="51" [value]="primary()!.thickness"
            (change)="setThickness($any($event.target).valueAsNumber)" />
        </label>
        }
        <button type="button" class="btn" [attr.aria-pressed]="plot().all" [class.!border-accent]="plot().all"
          [class.!text-fg]="plot().all" [class.text-muted]="!plot().all"
          title="Overlay every ROI this plot applies to; fits use the selected one"
          (click)="session.updatePlot({ all: !plot().all })">All ROIs</button>
        @if (plot().kind === 'time' && !burst()) {
        <button type="button" class="btn" title="Start the time series over" (click)="clearSeries()">Clear</button>
        }
        @if (progress(); as p) {
        <span class="inline-flex items-center gap-2 font-mono text-2xs text-muted">
          <span class="dot animate-pulse bg-warn"></span>measuring {{ (p * 100).toFixed(0) }}%
        </span>
        }
      </div>

      <racs-plot class="h-52 border-t border-line px-1 pt-1 mobile:h-48" [lines]="plotData().lines"
        [xLabel]="plotData().xLabel" [cursorX]="plotData().cursor" [placeholder]="plotData().hint"
        [yFromZero]="plot().kind === 'histogram'" />

      @if (plotData().lines.length > 0) {
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 font-mono text-2xs text-muted">
        @if (plotData().legend.length > 1) {
        @for (l of plotData().legend; track l.id) {
        <span class="inline-flex items-center gap-1.5"><span class="swatch" [style.background]="l.color"></span>{{ l.label }}</span>
        }
        }
        @if (plotData().fit; as f) {
        <span class="text-faint">{{ plotData().fitOf }}</span>
        @for (part of f; track part[0]) {
        <span>{{ part[0] }} <span class="text-fg">{{ part[1] }}</span></span>
        }
        } @else if (plot().mode !== 'raw' && plot().mode !== 'smooth') {
        <span class="text-faint">fit did not converge</span>
        }
        @if (!session.auto().plot) {
        <span class="ml-auto text-faint">held</span>
        }
      </div>
      }
      }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    /* A ROI's colour: a small square for a rect, a short bar for a line. */
    .swatch {
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      flex-shrink: 0;
    }

    .swatch.line {
      height: 2px;
      width: 0.75rem;
    }

    /* The selected row carries the accent marker on its left edge. */
    td.sel::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 2px;
      background: rgb(var(--accent));
    }
  `,
})
export class RoiAnalysisComponent {
  /** The frame on screen. */
  readonly frame = input<GrayFrame | null>(null);
  /** Burst only: every frame (null where not loaded or failed), and the player's position. */
  readonly frames = input<readonly (GrayFrame | null)[] | null>(null);
  readonly index = input(0);

  readonly session = inject(RoiSession);
  readonly kinds = KINDS;
  readonly modes = MODES;
  readonly stats = STATS;
  readonly rois = this.session.rois;
  readonly plot = this.session.plot;
  readonly burst = computed(() => this.frames() !== null);

  /** The frames the table and the plot measure: the current one, or the one held. */
  readonly statsFrame = signal<GrayFrame | null>(null);
  readonly plotFrame = signal<GrayFrame | null>(null);
  private readonly plotIndex = signal(0);

  /** Live time series per ROI, and a tick that redraws the plot when they grow. */
  private readonly live = new Map<string, { key: string; series: TimeSeries<RoiStats> }>();
  private liveStart = performance.now();
  private readonly liveTick = signal(0);

  /** Burst time series: per ROI geometry, the stats of each frame object measured so far. */
  private readonly burstCache = new Map<string, WeakMap<GrayFrame, RoiStats | null>>();
  private readonly burstTick = signal(0);
  readonly progress = signal<number | null>(null);
  private burstJob = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    let lastLive = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    destroyRef.onDestroy(() => {
      if (pending) clearTimeout(pending);
      this.burstJob++;
    });

    // Follow the frame on screen, at most every LIVE_INTERVAL_MS while live.
    effect(() => {
      const frame = this.frame();
      const index = this.index();
      const burst = this.burst();
      untracked(() => {
        const apply = () => {
          pending = null;
          lastLive = performance.now();
          const f = this.frame();
          if (this.session.auto().stats) this.statsFrame.set(f);
          if (this.session.auto().plot) {
            this.plotFrame.set(f);
            this.plotIndex.set(this.index());
          }
          if (!burst && f) this.sampleLive(f);
        };
        if (burst || !frame) {
          if (pending) clearTimeout(pending);
          apply();
          return;
        }
        const wait = LIVE_INTERVAL_MS - (performance.now() - lastLive);
        if (wait <= 0) {
          apply();
        } else if (!pending) {
          pending = setTimeout(apply, wait);
        }
        void index;
      });
    });

    // Burst: measure every loaded frame for the time series, in chunks.
    effect(() => {
      const frames = this.frames();
      const rois = this.rois();
      const wanted = this.session.open() && this.plot().kind === 'time';
      if (frames && wanted) {
        untracked(() => this.measureBurst(frames, rois));
      }
    });
  }

  color(roi: Roi): string {
    return seriesColor(roi.series);
  }

  num(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  toggleAuto(which: 'stats' | 'plot'): void {
    const on = !this.session.auto()[which];
    this.session.setAuto({ [which]: on });
    if (on) {
      which === 'stats' ? this.refreshStats() : this.refreshPlot();
    }
  }

  refreshStats(): void {
    this.statsFrame.set(this.frame());
  }

  refreshPlot(): void {
    this.plotFrame.set(this.frame());
    this.plotIndex.set(this.index());
    this.liveTick.update((n) => n + 1);
  }

  clearSeries(): void {
    this.live.clear();
    this.liveStart = performance.now();
    this.liveTick.update((n) => n + 1);
  }

  setThickness(v: number): void {
    const roi = this.primary();
    if (roi && Number.isFinite(v)) {
      this.session.update(roi.id, { thickness: Math.min(51, Math.max(1, Math.round(v))) });
    }
  }

  readonly statRows = computed(() => {
    const frame = this.statsFrame();
    return this.rois().map((roi) => ({
      roi,
      size: roiSizeLabel(roi),
      stats: frame ? roiStats(frame, roi) : null,
    }));
  });

  /** The ROI the plot is about: the selected one if the plot applies to it, else the first that fits. */
  readonly primary = computed(() => {
    const kind = this.plot().kind;
    const fits = (r: Roi) => applies(kind, r);
    const sel = this.session.selected();
    return sel && fits(sel) ? sel : (this.rois().find(fits) ?? null);
  });

  readonly plotData = computed(() => {
    const s = this.plot();
    const frame = this.plotFrame();
    const primary = this.primary();
    const empty = (hint: string) => ({
      lines: [] as PlotLine[],
      legend: [] as { id: string; label: string; color: string }[],
      xLabel: '',
      cursor: null as number | null,
      hint,
      fit: null as [string, string][] | null,
      fitOf: '',
    });
    if (!primary) {
      return empty(s.kind === 'profile' ? 'profile needs a line roi' : s.kind === 'projection' ? 'projection needs a rect roi' : 'no roi');
    }
    const targets = s.all ? this.rois().filter((r) => applies(s.kind, r)) : [primary];
    const xLabel = { profile: 'px', projection: s.axis === 'x' ? 'x' : 'y', time: this.burst() ? 'frame' : 's', histogram: 'value · % of roi' }[s.kind];
    const out = { ...empty(''), xLabel };

    if (s.kind === 'time') {
      this.liveTick();
      this.burstTick();
    } else if (!frame) {
      return { ...out, hint: 'no frame' };
    }

    for (const roi of targets) {
      const data = this.seriesFor(s, roi, frame);
      if (!data || data.ys.length === 0) {
        continue;
      }
      const color = seriesColor(roi.series);
      const isPrimary = roi.id === primary.id;
      const style = s.kind === 'histogram' ? 'step' : 'data';
      const shown = isPrimary && s.mode !== 'raw';
      out.lines.push({ id: roi.id, label: roi.name, color, xs: data.xs, ys: data.ys, style, faint: shown });
      out.legend.push({ id: roi.id, label: roi.name, color });
      if (!isPrimary || s.mode === 'raw') {
        continue;
      }
      if (s.mode === 'smooth') {
        out.lines.push({ id: `${roi.id}:avg`, label: `${roi.name} avg`, color, xs: data.xs, ys: movingAverage(data.ys, s.window), style: 'data' });
        continue;
      }
      const fit = fitFor(s, data);
      if (fit) {
        const xs = sampleXs(data.xs);
        out.lines.push({ id: `${roi.id}:fit`, label: `${roi.name} fit`, color, xs, ys: xs.map(fit.evaluate), style: 'fit' });
        out.fit = fitSummary(fit);
        out.fitOf = `${roi.name} ·`;
      }
    }
    if (s.kind === 'time' && this.burst()) {
      out.cursor = this.plotIndex();
    }
    if (out.lines.length === 0) {
      out.hint = s.kind === 'time' ? (this.burst() ? 'measuring…' : 'collecting · start live') : 'outside the frame';
    }
    return out;
  });

  private seriesFor(s: PlotSettings, roi: Roi, frame: GrayFrame | null): Series | null {
    switch (s.kind) {
      case 'profile':
        return frame ? lineProfile(frame, roi) : null;
      case 'projection':
        return frame ? rectProjection(frame, roi, s.axis) : null;
      case 'histogram':
        return frame ? cropHistogram(toShare(roiHistogram(frame, roi))) : null;
      case 'time':
        return this.burst() ? this.burstSeries(roi, s.stat) : this.liveSeries(roi, s.stat);
    }
  }

  // Time series -----------------------------------------------------------------------------

  /** Live: add a sample per ROI while the time plot is wanted. */
  private sampleLive(frame: GrayFrame): void {
    if (!this.session.open() || this.plot().kind !== 'time') {
      return;
    }
    if (this.live.size === 0) {
      this.liveStart = performance.now();
    }
    const t = (performance.now() - this.liveStart) / 1000;
    const ids = new Set<string>();
    for (const roi of this.rois()) {
      ids.add(roi.id);
      const key = roiKey(roi);
      let entry = this.live.get(roi.id);
      // A moved ROI measures something else: start its series over.
      if (!entry || entry.key !== key) {
        entry = { key, series: new TimeSeries<RoiStats>() };
        this.live.set(roi.id, entry);
      }
      const stats = roiStats(frame, roi);
      if (stats) {
        entry.series.push(t, stats);
      }
    }
    for (const id of [...this.live.keys()]) {
      if (!ids.has(id)) this.live.delete(id);
    }
    if (this.session.auto().plot) {
      this.liveTick.update((n) => n + 1);
    }
  }

  private liveSeries(roi: Roi, stat: TimeStat): Series | null {
    const entry = this.live.get(roi.id);
    return entry && entry.key === roiKey(roi) ? entry.series.toSeries((v) => v[stat]) : null;
  }

  private burstSeries(roi: Roi, stat: TimeStat): Series | null {
    const frames = this.frames();
    const cache = this.burstCache.get(roiKey(roi));
    if (!frames || !cache) {
      return null;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    frames.forEach((f, i) => {
      const v = f ? cache.get(f) : undefined;
      if (v) {
        xs.push(i);
        ys.push(v[stat]);
      }
    });
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
  }

  /** Fill the burst cache for every ROI and loaded frame, yielding to the page between chunks. */
  private measureBurst(frames: readonly (GrayFrame | null)[], rois: readonly Roi[]): void {
    const job = ++this.burstJob;
    const todo: [WeakMap<GrayFrame, RoiStats | null>, Roi, GrayFrame][] = [];
    for (const roi of rois) {
      const key = roiKey(roi);
      let cache = this.burstCache.get(key);
      if (!cache) {
        cache = new WeakMap();
        this.burstCache.set(key, cache);
      }
      for (const f of frames) {
        if (f && !cache.has(f)) todo.push([cache, roi, f]);
      }
    }
    if (todo.length === 0) {
      this.progress.set(null);
      this.burstTick.update((n) => n + 1);
      return;
    }
    let i = 0;
    const step = () => {
      if (job !== this.burstJob) {
        return;
      }
      const until = performance.now() + CHUNK_MS;
      while (i < todo.length && performance.now() < until) {
        const [cache, roi, f] = todo[i++];
        cache.set(f, roiStats(f, roi));
      }
      this.burstTick.update((n) => n + 1);
      if (i < todo.length) {
        this.progress.set(i / todo.length);
        setTimeout(step);
      } else {
        this.progress.set(null);
      }
    };
    step();
  }
}

function applies(kind: PlotKind, roi: Roi): boolean {
  return kind === 'profile' ? roi.shape === 'line' : kind === 'projection' ? roi.shape === 'rect' : true;
}

function fitFor(s: PlotSettings, data: Series): Fit | null {
  switch (s.mode) {
    case 'linear':
      return linearFit(data.xs, data.ys);
    case 'poly':
      return polyFit(data.xs, data.ys, s.degree);
    case 'gaussian':
      return gaussianFit(data.xs, data.ys);
    default:
      return null;
  }
}

/** Evenly spaced x positions to draw a fit curve with. */
function sampleXs(xs: ArrayLike<number>): number[] {
  if (xs.length === 0) {
    return [];
  }
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  const n = Math.min(400, Math.max(2, xs.length * 2));
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/** Counts as a percentage of the ROI, so ROIs of any size compare on one axis. */
function toShare(h: Series): Series {
  let total = 0;
  for (const v of h.ys) total += v;
  return { xs: h.xs, ys: total > 0 ? h.ys.map((v) => (100 * v) / total) : h.ys };
}

/** Only the occupied part of a histogram (plus a bin either side), so a narrow ROI isn't a spike. */
function cropHistogram(h: Series): Series {
  let first = -1;
  let last = -1;
  for (let i = 0; i < h.ys.length; i++) {
    if (h.ys[i] > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    return { xs: new Float64Array(0), ys: new Float64Array(0) };
  }
  const a = Math.max(0, first - 1);
  const b = Math.min(h.ys.length, last + 2);
  return { xs: h.xs.slice(a, b), ys: h.ys.slice(a, b) };
}
