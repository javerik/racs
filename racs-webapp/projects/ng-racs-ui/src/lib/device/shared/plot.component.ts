import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { decimate, niceTicks, paddedExtent, tickLabel } from 'ng-racs-core';

/** One line on the plot. `xs` must ascend; NaN values break the line. */
export interface PlotLine {
  id: string;
  /** Shown in the hover readout. */
  label: string;
  /** A CSS colour (a series token). */
  color: string;
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  /** `data` is a solid line, `step` a histogram outline, `fit` a dashed line over faint data. */
  style: 'data' | 'step' | 'fit';
  /** Drawn faint (raw data under a fit or smoothing). */
  faint?: boolean;
}

const M = { top: 8, right: 10, bottom: 22, left: 48 };

/**
 * A small SVG line plot in the instrument style: hairline axes, mono tick labels, series-coloured
 * lines, dashed fits, an optional cursor (the burst playhead) and a hover crosshair with a readout.
 * Sized to its box in real pixels, so text and strokes are never stretched.
 */
@Component({
  selector: 'racs-plot',
  standalone: true,
  template: `
    <div #box class="relative h-full w-full select-none" (pointermove)="onHover($event)" (pointerdown)="onHover($event)" (pointerleave)="hoverX.set(null)">
      <svg class="absolute inset-0 block h-full w-full" aria-hidden="true">
        @if (frame(); as f) {
        <!-- Grid and ticks. -->
        @for (t of f.yTicks; track t.v) {
        <line [attr.x1]="M.left" [attr.x2]="f.w - M.right" [attr.y1]="t.p" [attr.y2]="t.p" class="grid" />
        <text [attr.x]="M.left - 6" [attr.y]="t.p" text-anchor="end" dominant-baseline="middle" class="tick">{{ t.label }}</text>
        }
        @for (t of f.xTicks; track t.v) {
        <line [attr.x1]="t.p" [attr.x2]="t.p" [attr.y1]="M.top" [attr.y2]="f.h - M.bottom" class="grid" />
        <text [attr.x]="t.p" [attr.y]="f.h - M.bottom + 13" text-anchor="middle" class="tick">{{ t.label }}</text>
        }
        <line [attr.x1]="M.left" [attr.x2]="f.w - M.right" [attr.y1]="f.h - M.bottom" [attr.y2]="f.h - M.bottom" class="axis" />
        <line [attr.x1]="M.left" [attr.x2]="M.left" [attr.y1]="M.top" [attr.y2]="f.h - M.bottom" class="axis" />
        <clipPath [attr.id]="clipId">
          <rect [attr.x]="M.left" [attr.y]="M.top" [attr.width]="f.w - M.left - M.right" [attr.height]="f.h - M.top - M.bottom" />
        </clipPath>
        <g [attr.clip-path]="'url(#' + clipId + ')'">
          @for (p of f.paths; track p.id) {
          <path [attr.d]="p.d" [attr.stroke]="p.color" class="series" [class.fit]="p.style === 'fit'" [class.faint]="p.faint" />
          }
          @if (cursorPx(); as cx) {
          <line [attr.x1]="cx" [attr.x2]="cx" [attr.y1]="M.top" [attr.y2]="f.h - M.bottom" class="cursor" />
          }
          @if (hover(); as h) {
          <line [attr.x1]="h.px" [attr.x2]="h.px" [attr.y1]="M.top" [attr.y2]="f.h - M.bottom" class="crosshair" />
          @for (v of h.values; track v.id) {
          <circle [attr.cx]="h.px" [attr.cy]="v.py" r="3" [attr.fill]="v.color" class="marker" />
          }
          }
        </g>
        @if (xLabel()) {
        <text [attr.x]="f.w - M.right" [attr.y]="f.h - 2" text-anchor="end" class="tick unit">{{ xLabel() }}</text>
        }
        @if (yLabel()) {
        <text [attr.x]="M.left + 4" [attr.y]="M.top + 9" class="tick unit">{{ yLabel() }}</text>
        }
        }
      </svg>
      @if (hover(); as h) {
      <span class="pointer-events-none absolute left-14 top-1 inline-flex flex-wrap items-center gap-x-2 border border-line bg-bg/80 px-1.5 py-0.5 font-mono text-2xs text-fg">
        <span class="text-muted">{{ xLabel() || 'x' }} {{ h.x }}</span>
        @for (v of h.values; track v.id) {
        <span class="inline-flex items-center gap-1"><span class="dot" [style.background]="v.color"></span>{{ v.label }} {{ v.y }}</span>
        }
      </span>
      }
      @if (empty()) {
      <p class="pointer-events-none absolute inset-0 m-0 flex items-center justify-center font-mono text-2xs text-faint">{{ placeholder() }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .grid {
      stroke: rgb(var(--line));
      stroke-width: 1px;
      shape-rendering: crispEdges;
    }

    .axis {
      stroke: rgb(var(--line-strong));
      stroke-width: 1px;
      shape-rendering: crispEdges;
    }

    .tick {
      fill: rgb(var(--faint));
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
    }

    .unit {
      fill: rgb(var(--muted));
    }

    .series {
      fill: none;
      stroke-width: 1.5px;
      stroke-linejoin: round;
      stroke-linecap: round;
    }

    .series.faint {
      opacity: 0.35;
    }

    .series.fit {
      stroke-width: 1.5px;
      stroke-dasharray: 5 3;
    }

    .cursor {
      stroke: rgb(var(--muted));
      stroke-width: 1px;
    }

    .crosshair {
      stroke: rgb(var(--faint));
      stroke-width: 1px;
      stroke-dasharray: 2 2;
    }

    .marker {
      stroke: rgb(var(--surface));
      stroke-width: 2px;
    }
  `,
})
export class PlotComponent {
  readonly lines = input<PlotLine[]>([]);
  readonly xLabel = input('');
  /** What the y axis shows, in the plot's top-left corner. */
  readonly yLabel = input('');
  /** A vertical marker at this x, e.g. the burst playhead. */
  readonly cursorX = input<number | null>(null);
  readonly placeholder = input('no data');
  /** Start the y axis at 0 when the data allows (histogram counts). */
  readonly yFromZero = input(false);

  readonly M = M;
  readonly clipId = `plot-clip-${Math.random().toString(36).slice(2, 9)}`;
  private readonly boxRef = viewChild.required<ElementRef<HTMLDivElement>>('box');
  private readonly size = signal({ w: 0, h: 0 });
  readonly hoverX = signal<number | null>(null);

  readonly empty = computed(() => !this.lines().some((l) => l.ys.length > 0));

  private readonly domain = computed(() => {
    const lines = this.lines();
    const x = paddedExtent(lines.flatMap((l) => (l.xs.length ? [l.xs[0], l.xs[l.xs.length - 1]] : [])), 0);
    const yValues: number[] = [];
    for (const l of lines) {
      for (let i = 0; i < l.ys.length; i++) yValues.push(l.ys[i]);
    }
    if (this.yFromZero()) {
      yValues.push(0);
    }
    const y = paddedExtent(yValues);
    return x && y ? { x, y } : null;
  });

  readonly frame = computed(() => {
    const { w, h } = this.size();
    const d = this.domain();
    if (w <= M.left + M.right || h <= M.top + M.bottom || !d) {
      return null;
    }
    const [x0, x1] = d.x;
    const [y0, y1] = d.y;
    const px = (v: number) => M.left + ((v - x0) / (x1 - x0 || 1)) * (w - M.left - M.right);
    const py = (v: number) => h - M.bottom - ((v - y0) / (y1 - y0 || 1)) * (h - M.top - M.bottom);
    const columns = w - M.left - M.right;
    const paths = this.lines().map((l) => {
      const pts = decimate(l.xs, l.ys, x0, x1, columns);
      let d = '';
      let pen = false;
      for (let i = 0; i < pts.xs.length; i++) {
        const y = pts.ys[i];
        if (!Number.isFinite(y)) {
          pen = false;
          continue;
        }
        const X = px(pts.xs[i]).toFixed(1);
        const Y = py(y).toFixed(1);
        if (l.style === 'step' && pen) {
          d += `H${X}V${Y}`;
        } else {
          d += `${pen ? 'L' : 'M'}${X} ${Y}`;
        }
        pen = true;
      }
      return { id: l.id, color: l.color, style: l.style, faint: !!l.faint, d };
    });
    return {
      w,
      h,
      px,
      py,
      x0,
      x1,
      paths,
      xTicks: niceTicks(x0, x1, Math.max(2, Math.floor(columns / 70))).map((v) => ({ v, p: px(v), label: tickLabel(v) })),
      yTicks: niceTicks(y0, y1, Math.max(2, Math.floor((h - M.top - M.bottom) / 28))).map((v) => ({
        v,
        p: py(v),
        label: tickLabel(v),
      })),
    };
  });

  readonly cursorPx = computed(() => {
    const f = this.frame();
    const c = this.cursorX();
    return f && c !== null && c >= f.x0 && c <= f.x1 ? f.px(c) : null;
  });

  /** The values at the hovered x: the nearest sample of each line that isn't faint. */
  readonly hover = computed(() => {
    const f = this.frame();
    const x = this.hoverX();
    if (!f || x === null) {
      return null;
    }
    const values: { id: string; label: string; color: string; y: string; py: number }[] = [];
    let at: number | null = null;
    for (const l of this.lines()) {
      if (l.faint || l.xs.length === 0) {
        continue;
      }
      const i = nearest(l.xs, x);
      const y = l.ys[i];
      if (!Number.isFinite(y)) {
        continue;
      }
      at ??= l.xs[i];
      values.push({ id: l.id, label: l.label, color: l.color, y: tickLabel(Number(y.toPrecision(5))), py: f.py(y) });
    }
    return at === null ? null : { x: tickLabel(Number(at.toPrecision(6))), px: f.px(at), values };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const box = this.boxRef().nativeElement;
      const measure = () => this.size.set({ w: box.clientWidth, h: box.clientHeight });
      const observer = new ResizeObserver(measure);
      observer.observe(box);
      measure();
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  onHover(event: PointerEvent): void {
    const f = this.frame();
    if (!f) {
      return;
    }
    const rect = this.boxRef().nativeElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (px < M.left || px > f.w - M.right) {
      this.hoverX.set(null);
      return;
    }
    this.hoverX.set(f.x0 + ((px - M.left) / (f.w - M.left - M.right)) * (f.x1 - f.x0));
  }
}

/** Index of the value in ascending `xs` closest to `x`. */
function nearest(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? hi : lo;
}
