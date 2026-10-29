import { Component, ElementRef, computed, input, model, signal, viewChild } from '@angular/core';
import {
  type DisplayRange,
  edgeValue,
  type FrameStats,
  HISTOGRAM_BINS,
  maxValue,
  moveEdge,
  nearestEdge,
  type RangeEdge,
  type RangeMode,
  type RangeSettings,
  shiftWindow,
} from 'ng-racs-core';

type DragKind = RangeEdge | 'window';

/**
 * Display-range controls: full / manual / auto, and a histogram with the window marked on it
 * that doubles as the manual control: drag an edge or the whole window over it. Exact values go
 * in the two small fields shown in manual mode, or with the arrow keys on a focused edge.
 */
@Component({
  selector: 'racs-range-control',
  standalone: true,
  template: `
    <div class="flex flex-col gap-2 border-t border-line px-4 py-3">
      <div class="flex flex-wrap items-center gap-3">
        <span class="label">Range</span>
        <div class="inline-flex" role="radiogroup" aria-label="Display range mode">
          @for (m of modes; track m.id; let first = $first) {
          <button type="button" role="radio" [attr.aria-checked]="settings().mode === m.id"
            class="btn rounded-none" [class.-ml-px]="!first"
            [class.!border-accent]="settings().mode === m.id" [class.!text-fg]="settings().mode === m.id"
            [class.text-muted]="settings().mode !== m.id" [attr.title]="m.hint"
            (click)="setMode(m.id)">
            {{ m.label }}
          </button>
          }
        </div>
        @if (settings().mode === 'auto') {
        <button type="button" class="btn" title="Keep the current auto range as a manual window"
          (click)="lock()">
          Lock
        </button>
        }
        @if (settings().mode === 'manual') {
        <div class="inline-flex items-center gap-1.5 font-mono text-2xs text-faint">
          <input type="number" class="field h-6 w-[4.5rem] px-1.5" min="0" [max]="top()" [value]="settings().lo"
            aria-label="Range from" (change)="setLo($any($event.target).valueAsNumber)" />
          ↔
          <input type="number" class="field h-6 w-[4.5rem] px-1.5" min="0" [max]="top()" [value]="settings().hi"
            aria-label="Range to" (change)="setHi($any($event.target).valueAsNumber)" />
        </div>
        }
        <span class="ml-auto font-mono text-2xs text-muted">
          @if (settings().mode !== 'manual') {
          <span class="text-fg">{{ resolved().lo }}</span> ↔ <span class="text-fg">{{ resolved().hi }}</span>
          }
          <span class="text-faint"> / {{ top() }} · {{ bitDepth() }} bit</span>
          @if (stats(); as s) {
          <span class="text-faint"> · image {{ s.min }}–{{ s.max }}</span>
          }
        </span>
      </div>

      <!-- The histogram is the control: drag an edge or the window, or press anywhere to bring
           the nearer edge there. Dragging in Full or Auto switches to Manual. -->
      <div #hist class="hist relative h-10 touch-none select-none mobile:h-14" [style.cursor]="cursor()"
        title="Drag the edges or the window · double-click for the full range"
        (pointerdown)="onDown($event)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
        (pointercancel)="onUp($event)" (pointerleave)="zone.set(null)" (dblclick)="setMode('full')">
        <svg class="absolute inset-0 block h-full w-full" [attr.viewBox]="'0 0 ' + bins + ' 1'"
          preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" [attr.width]="bins" height="1" class="fill-bg" />
          <path [attr.d]="histPath()" class="fill-muted/40" />
          <!-- Shade what renders as clipped black or white. -->
          <rect x="0" y="0" [attr.width]="loX()" height="1" class="fill-bg/70" />
          <rect [attr.x]="hiX()" y="0" [attr.width]="bins - hiX()" height="1" class="fill-bg/70" />
          <line [attr.x1]="loX()" [attr.x2]="loX()" y1="0" y2="1" class="stroke-accent"
            vector-effect="non-scaling-stroke" stroke-width="1.5" />
          <line [attr.x1]="hiX()" [attr.x2]="hiX()" y1="0" y2="1" class="stroke-accent"
            vector-effect="non-scaling-stroke" stroke-width="1.5" />
        </svg>
        @for (e of edges; track e.id) {
        <div class="handle" role="slider" tabindex="0" [attr.data-edge]="e.id"
          [class.active]="drag()?.kind === e.id" [class.manual]="settings().mode === 'manual'"
          [style.left.%]="(e.id === 'lo' ? loX() : hiX()) / bins * 100" [attr.aria-label]="e.label"
          [attr.aria-valuemin]="0" [attr.aria-valuemax]="top()"
          [attr.aria-valuenow]="e.id === 'lo' ? resolved().lo : resolved().hi" (keydown)="onKey($event, e.id)">
        </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    /* A wide grab area around each edge line, with a small tab at the top marking it. */
    .handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 0.75rem;
      margin-left: -0.375rem;
      cursor: ew-resize;
      outline: none;

      &::before {
        content: '';
        position: absolute;
        top: -3px;
        left: 50%;
        width: 7px;
        height: 7px;
        transform: translateX(-50%);
        border-radius: 1px;
        background: rgb(var(--accent));
        opacity: 0;
        transition: opacity 150ms;
      }

      &.manual::before,
      &.active::before,
      &:focus-visible::before {
        opacity: 1;
      }

      &:focus-visible::after {
        content: '';
        position: absolute;
        inset: 0 3px;
        outline: 1px solid rgb(var(--accent));
        outline-offset: 0;
      }
    }

    .hist:hover .handle::before {
      opacity: 1;
    }

    /* A finger needs a wider grab area than a pointer. */
    :host-context([data-layout='mobile']) .handle {
      width: 1.5rem;
      margin-left: -0.75rem;
    }
  `,
})
export class RangeControlComponent {
  readonly settings = model.required<RangeSettings>();
  readonly bitDepth = input.required<number>();
  /** The window currently in effect (in auto mode, derived from `stats`). */
  readonly resolved = input.required<DisplayRange>();
  readonly stats = input<FrameStats | null>(null);

  readonly bins = HISTOGRAM_BINS;
  readonly modes: { id: RangeMode; label: string; hint: string }[] = [
    { id: 'full', label: 'Full', hint: 'The whole range of the bit depth' },
    { id: 'manual', label: 'Manual', hint: 'A fixed window, e.g. 20 to 50 LSB' },
    { id: 'auto', label: 'Auto', hint: "The image's own min to max" },
  ];

  readonly edges: { id: RangeEdge; label: string }[] = [
    { id: 'lo', label: 'Range from' },
    { id: 'hi', label: 'Range to' },
  ];

  private readonly histRef = viewChild.required<ElementRef<HTMLDivElement>>('hist');
  /** The drag in progress: what it holds, and the window and value it started from. */
  readonly drag = signal<{ kind: DragKind; pointer: number; start: DisplayRange; from: number } | null>(null);
  /** What a press at the pointer would grab, for the cursor. */
  readonly zone = signal<DragKind | null>(null);
  readonly cursor = computed(() => {
    const kind = this.drag()?.kind ?? this.zone();
    if (kind === 'window') {
      return this.drag() ? 'grabbing' : 'grab';
    }
    return 'ew-resize';
  });

  readonly top = computed(() => maxValue(this.bitDepth()));
  readonly loX = computed(() => this.toX(this.resolved().lo));
  readonly hiX = computed(() => this.toX(this.resolved().hi + 1));

  /** Log-scaled bars, so a few bright pixels stay visible next to a dominant background. */
  readonly histPath = computed(() => {
    const hist = this.stats()?.hist;
    if (!hist) {
      return '';
    }
    let peak = 0;
    for (const n of hist) {
      peak = Math.max(peak, n);
    }
    if (peak === 0) {
      return '';
    }
    const scale = Math.log1p(peak);
    let d = 'M0 1';
    for (let i = 0; i < hist.length; i++) {
      const h = Math.log1p(hist[i]) / scale;
      const y = (1 - h).toFixed(3);
      d += `V${y}H${i + 1}`;
    }
    return d + 'V1Z';
  });

  setMode(mode: RangeMode): void {
    const current = this.settings();
    if (mode === 'manual' && current.mode !== 'manual') {
      // Start the manual window from what is on screen, not from stale numbers.
      const { lo, hi } = this.resolved();
      this.settings.set({ mode, lo, hi });
      return;
    }
    this.settings.set({ ...current, mode });
  }

  lock(): void {
    const { lo, hi } = this.resolved();
    this.settings.set({ mode: 'manual', lo, hi });
  }

  setLo(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const lo = this.clamp(value);
    const hi = Math.max(this.settings().hi, Math.min(lo + 1, this.top()));
    this.settings.set({ mode: 'manual', lo, hi });
  }

  setHi(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const hi = this.clamp(value);
    const lo = Math.min(this.settings().lo, Math.max(hi - 1, 0));
    this.settings.set({ mode: 'manual', lo, hi });
  }

  // Dragging over the histogram ----------------------------------------------------------------

  onDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const win = this.resolved();
    const top = this.top();
    const frac = this.fracAt(event);
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]');
    let kind: DragKind;
    let start = win;
    if (handle) {
      kind = handle.dataset['edge'] as RangeEdge;
    } else if (frac > this.loX() / this.bins && frac < this.hiX() / this.bins) {
      kind = 'window';
    } else {
      // Outside the window: the nearer edge jumps here and follows the pointer.
      kind = nearestEdge(win, frac * (top + 1));
      start = moveEdge(win, kind, edgeValue(frac, top, kind), top);
      this.apply(start);
    }
    this.histRef().nativeElement.setPointerCapture(event.pointerId);
    this.drag.set({ kind, pointer: event.pointerId, start, from: frac });
    event.preventDefault();
  }

  onMove(event: PointerEvent): void {
    const drag = this.drag();
    const frac = this.fracAt(event);
    if (!drag || drag.pointer !== event.pointerId) {
      this.zone.set(this.zoneAt(event, frac));
      return;
    }
    const top = this.top();
    this.apply(
      drag.kind === 'window'
        ? shiftWindow(drag.start, (frac - drag.from) * (top + 1), top)
        : moveEdge(drag.start, drag.kind, edgeValue(frac, top, drag.kind), top),
    );
  }

  onUp(event: PointerEvent): void {
    if (this.drag()?.pointer === event.pointerId) {
      this.drag.set(null);
    }
  }

  /** Arrows step 1 LSB (Shift: 1/32 of the range), Home/End go to the ends. */
  onKey(event: KeyboardEvent, edge: RangeEdge): void {
    const top = this.top();
    const big = Math.max(1, Math.round((top + 1) / 32));
    const step = event.shiftKey ? big : 1;
    const win = this.resolved();
    const current = edge === 'lo' ? win.lo : win.hi;
    let value: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        value = current - step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        value = current + step;
        break;
      case 'PageDown':
        value = current - big;
        break;
      case 'PageUp':
        value = current + big;
        break;
      case 'Home':
        value = 0;
        break;
      case 'End':
        value = top;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.apply(moveEdge(win, edge, value, top));
  }

  private apply(win: DisplayRange): void {
    const current = this.settings();
    if (current.mode !== 'manual' || current.lo !== win.lo || current.hi !== win.hi) {
      this.settings.set({ mode: 'manual', lo: win.lo, hi: win.hi });
    }
  }

  private fracAt(event: PointerEvent): number {
    const rect = this.histRef().nativeElement.getBoundingClientRect();
    return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  }

  private zoneAt(event: PointerEvent, frac: number): DragKind {
    if ((event.target as HTMLElement).closest('[data-edge]')) {
      return 'lo';
    }
    return frac > this.loX() / this.bins && frac < this.hiX() / this.bins ? 'window' : 'lo';
  }

  private clamp(value: number): number {
    return Math.min(this.top(), Math.max(0, Math.round(value)));
  }

  private toX(value: number): number {
    return Math.min(this.bins, (value / (this.top() + 1)) * this.bins);
  }
}
