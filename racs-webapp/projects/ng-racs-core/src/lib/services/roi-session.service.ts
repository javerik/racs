import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { distinctUntilChanged } from 'rxjs';
import type { Roi, RoiShape } from '../imaging/roi';
import { DeviceSelectionService } from './device-selection.service';

/** The number of series colours (`--series-1..6` in styles.scss). */
export const SERIES_COUNT = 6;

/** The CSS colour of series `i`, for SVG strokes and swatches. */
export function seriesColor(i: number): string {
  return `rgb(var(--series-${(((i % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT) + 1}))`;
}

/** What a drag on the image does: draw a ROI, edit the camera region, or nothing (pan, probe). */
export type ViewTool = 'rect' | 'line' | 'region' | null;

export type PlotKind = 'profile' | 'projection' | 'time' | 'histogram';
export type PlotMode = 'raw' | 'smooth' | 'linear' | 'poly' | 'gaussian';
export type TimeStat = 'mean' | 'min' | 'max' | 'std';

export interface PlotSettings {
  kind: PlotKind;
  /** Projection: onto columns (`x`) or rows (`y`). */
  axis: 'x' | 'y';
  mode: PlotMode;
  /** Moving-average window, samples. */
  window: number;
  /** Polynomial degree, 2–5. */
  degree: number;
  stat: TimeStat;
  /** Overlay every ROI the kind applies to, not only the selected one. */
  all: boolean;
}

export interface AutoUpdate {
  stats: boolean;
  plot: boolean;
}

export const DEFAULT_PLOT: PlotSettings = {
  kind: 'profile',
  axis: 'x',
  mode: 'raw',
  window: 5,
  degree: 2,
  stat: 'mean',
  all: false,
};

const ROIS_KEY = 'racs.rois';
const PLOT_KEY = 'racs.roi.plot';
const AUTO_KEY = 'racs.roi.auto';
const OPEN_KEY = 'racs.roi.open';

/**
 * The soft ROIs of the selected device, shared by the live view and the burst player (one scene,
 * one set), with the plot settings and the auto-update switches. Provided on the device workspace
 * next to `GenicamSession`. ROIs are kept per device in localStorage.
 */
@Injectable()
export class RoiSession {
  private readonly selection = inject(DeviceSelectionService);

  readonly rois = signal<readonly Roi[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly tool = signal<ViewTool>(null);
  readonly plot = signal<PlotSettings>(loadJson(PLOT_KEY, DEFAULT_PLOT, sanitizePlot));
  readonly auto = signal<AutoUpdate>(loadJson(AUTO_KEY, { stats: true, plot: true }, sanitizeAuto));
  /** The analysis section is expanded. */
  readonly open = signal<boolean>(loadJson(OPEN_KEY, true, (v) => v !== false));

  readonly selected = computed(() => this.rois().find((r) => r.id === this.selectedId()) ?? null);

  private deviceId: number | null = null;
  private counter = 0;

  constructor() {
    toObservable(this.selection.selectedDeviceId)
      .pipe(distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((id) => {
        this.deviceId = id;
        this.rois.set(id === null ? [] : loadRois(id));
        this.selectedId.set(null);
        this.tool.set(null);
      });
  }

  /** Add a ROI with the lowest free name and colour; it becomes the selected one. */
  add(shape: RoiShape, x0: number, y0: number, x1: number, y1: number): Roi {
    const rois = this.rois();
    const names = new Set(rois.map((r) => r.name));
    let n = 1;
    while (names.has(`R${n}`)) n++;
    const used = new Set(rois.map((r) => r.series));
    let series = 0;
    while (used.has(series) && series < SERIES_COUNT) series++;
    if (series === SERIES_COUNT) {
      series = rois.length % SERIES_COUNT;
    }
    const roi: Roi = {
      id: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`,
      name: `R${n}`,
      shape,
      x0,
      y0,
      x1,
      y1,
      series,
      thickness: 1,
    };
    this.save([...rois, roi]);
    this.selectedId.set(roi.id);
    const kind = this.plot().kind;
    const fits = (r: Roi) => (kind === 'profile' ? r.shape === 'line' : kind === 'projection' ? r.shape === 'rect' : true);
    if (!rois.some(fits) && !fits(roi)) {
      this.updatePlot({ kind: shape === 'line' ? 'profile' : 'projection' });
    }
    return roi;
  }

  update(id: string, patch: Partial<Omit<Roi, 'id'>>): void {
    this.save(this.rois().map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  remove(id: string): void {
    this.save(this.rois().filter((r) => r.id !== id));
    if (this.selectedId() === id) {
      this.selectedId.set(null);
    }
  }

  clear(): void {
    this.save([]);
    this.selectedId.set(null);
  }

  select(id: string | null): void {
    this.selectedId.set(id);
  }

  /** Pick a tool, or switch it off when it is already on. */
  toggleTool(tool: Exclude<ViewTool, null>): void {
    this.tool.set(this.tool() === tool ? null : tool);
  }

  updatePlot(patch: Partial<PlotSettings>): void {
    this.plot.set(sanitizePlot({ ...this.plot(), ...patch }));
    saveJson(PLOT_KEY, this.plot());
  }

  setAuto(patch: Partial<AutoUpdate>): void {
    this.auto.set({ ...this.auto(), ...patch });
    saveJson(AUTO_KEY, this.auto());
  }

  setOpen(open: boolean): void {
    this.open.set(open);
    saveJson(OPEN_KEY, open);
  }

  private save(rois: Roi[]): void {
    this.rois.set(rois);
    if (this.deviceId !== null) {
      saveJson(`${ROIS_KEY}.${this.deviceId}`, rois);
    }
  }
}

function loadJson<T>(key: string, fallback: T, sanitize: (v: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : sanitize(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering is a convenience only.
  }
}

function loadRois(deviceId: number): Roi[] {
  return loadJson(`${ROIS_KEY}.${deviceId}`, [], (v) => (Array.isArray(v) ? v.filter(isRoi) : []));
}

function isRoi(v: unknown): v is Roi {
  const r = v as Partial<Roi> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    (r.shape === 'rect' || r.shape === 'line') &&
    [r.x0, r.y0, r.x1, r.y1, r.series, r.thickness].every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

const KINDS: readonly PlotKind[] = ['profile', 'projection', 'time', 'histogram'];
const MODES: readonly PlotMode[] = ['raw', 'smooth', 'linear', 'poly', 'gaussian'];
const STATS: readonly TimeStat[] = ['mean', 'min', 'max', 'std'];

export function sanitizePlot(v: unknown): PlotSettings {
  const p = (v ?? {}) as Partial<PlotSettings>;
  const int = (x: unknown, lo: number, hi: number, d: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  return {
    kind: KINDS.includes(p.kind as PlotKind) ? (p.kind as PlotKind) : DEFAULT_PLOT.kind,
    axis: p.axis === 'y' ? 'y' : 'x',
    mode: MODES.includes(p.mode as PlotMode) ? (p.mode as PlotMode) : DEFAULT_PLOT.mode,
    window: int(p.window, 2, 101, DEFAULT_PLOT.window),
    degree: int(p.degree, 2, 5, DEFAULT_PLOT.degree),
    stat: STATS.includes(p.stat as TimeStat) ? (p.stat as TimeStat) : DEFAULT_PLOT.stat,
    all: p.all === true,
  };
}

function sanitizeAuto(v: unknown): AutoUpdate {
  const a = (v ?? {}) as Partial<AutoUpdate>;
  return { stats: a.stats !== false, plot: a.plot !== false };
}
