import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import {
  decadeWindows,
  type FeatureState,
  formatQuantity,
  formatSpan,
  formatValue,
  fromSlider,
  type GenICamEnumInfo,
  type GenICamNodeInfo,
  isDurationUnit,
  type NumericRange,
  type RangeWindow,
  SLIDER_STEPS,
  sliderRange,
  snap,
  toSlider,
  windowIndex,
} from 'ng-racs-core';
import { SliderDirective } from '../../shared/slider.directive';

/**
 * The editor for one GenICam feature, picked by its type and live state: a slider for a bounded
 * number, a select for an enum, a switch for a boolean, a button for a command, a text field
 * otherwise. Read-only, locked and unavailable features show their value only.
 *
 * Holds the user's edit locally until the device's value comes back; emits values to write as
 * strings in the REST API's format.
 */
@Component({
  selector: 'racs-feature-control',
  standalone: true,
  imports: [SliderDirective],
  template: `
    @let n = node();
    @let st = state();
    <div class="flex min-w-0 flex-col gap-1">
      <div class="flex min-w-0 items-center gap-2">
        @if (!st) {
        <span class="font-mono text-xs text-faint">…</span>
        } @else if (!st.available) {
        <span class="font-mono text-xs text-faint" title="Not available in the camera's current mode">n/a</span>
        } @else if (n.node_type === 'Command') {
        <button type="button" class="btn" [disabled]="!writable() || saving()" (click)="execute.emit()">
          {{ saving() ? 'Running…' : 'Execute' }}
        </button>
        } @else if (!writable()) {
        <span class="min-w-0 truncate font-mono text-xs text-muted" [title]="display()">{{ display() }}</span>
        } @else if (n.node_type === 'Boolean') {
        <button type="button" role="switch" [attr.aria-checked]="shown() === 'true'" [attr.aria-label]="n.display_name"
          class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40"
          [class.border-accent]="shown() === 'true'" [class.bg-accent]="shown() === 'true'"
          [class.border-line-strong]="shown() !== 'true'" [class.bg-bg]="shown() !== 'true'" [disabled]="saving()"
          (click)="commitValue(shown() === 'true' ? 'false' : 'true')">
          <span class="absolute left-0 h-3.5 w-3.5 rounded-full bg-fg transition-transform"
            [style.transform]="shown() === 'true' ? 'translateX(1.1rem)' : 'translateX(0.15rem)'"></span>
        </button>
        } @else if (n.node_type === 'Enum' && n.enums?.length) {
        <select class="field" [class.border-accent]="dirty()" [disabled]="saving()" [value]="shown()"
          [attr.aria-label]="n.display_name" (change)="commitValue($any($event.target).value)">
          @if (unlisted()) {
          <option [value]="shown()" disabled>{{ shown() }} (unlisted)</option>
          }
          @for (en of entries(); track en.value) {
          <option [value]="en.value + ''" [selected]="en.value + '' === shown()">{{ en.display_name }}</option>
          }
        </select>
        } @else if (range(); as r) {
        @if (r.log) {
        <!-- A range over several decades: pick the decade, then slide within it. -->
        <!-- Strip: the value, the decades and the slider in one row (the two rows become contents). -->
        <div class="flex min-w-0 flex-1 gap-1.5" [class.flex-col]="layout() !== 'strip'"
          [class.items-center]="layout() === 'strip'" [class.flex-wrap]="layout() === 'strip'"
          [class.gap-x-3]="layout() === 'strip'">
          <div class="flex min-w-0 flex-wrap items-center gap-2" [class.contents]="layout() === 'strip'">
            <span class="min-w-[5rem] font-mono text-sm text-fg" [title]="shown() + ' ' + (st.unit ?? '')">
              {{ quantity() }}
            </span>
            @if (layout() !== 'inline') {
            <div class="inline-flex flex-wrap" [class.ml-auto]="layout() === 'wide'" role="radiogroup" [attr.aria-label]="n.display_name + ' range'">
              @for (w of windows(); track $index; let i = $index; let first = $first) {
              <button type="button" role="radio" [attr.aria-checked]="activeWindow() === i"
                class="btn h-6 rounded-none px-2 normal-case tracking-normal" [class.-ml-px]="!first"
                [class.!border-accent]="activeWindow() === i" [class.!text-fg]="activeWindow() === i"
                [class.text-muted]="activeWindow() !== i" [disabled]="saving()" (click)="pickWindow(i)">
                {{ windowLabel(w, i) }}
              </button>
              }
            </div>
            }
          </div>
          <div class="flex min-w-0 items-center gap-2" [class.flex-1]="layout() === 'strip'"
            [style.min-width.rem]="layout() === 'strip' ? 16 : null">
            <button type="button" class="btn h-6 shrink-0 px-2" title="Half (−1 stop)" [disabled]="saving()"
              (click)="scale(0.5)">½×</button>
            @if (layout() !== 'inline') {
            <input type="range" min="0" [max]="steps" [value]="windowPos()" [attr.aria-label]="n.display_name"
              class="min-w-0 flex-1 slider" (pointerdown)="dragging = true"
              (input)="onSlide($any($event.target).valueAsNumber, true)"
              (change)="onSlideEnd($any($event.target).valueAsNumber, true)" />
            }
            <button type="button" class="btn h-6 shrink-0 px-2" title="Double (+1 stop)" [disabled]="saving()"
              (click)="scale(2)">2×</button>
            <input type="number" class="field w-28 shrink-0" [class.border-accent]="dirty()" [min]="r.min"
              [max]="r.max" [step]="r.inc ?? 'any'" [value]="shown()" [attr.aria-label]="n.display_name + ' value'"
              (change)="commitNumber($any($event.target).value)" />
            @if (st.unit) {
            <span class="w-6 shrink-0 font-mono text-2xs text-faint">{{ st.unit }}</span>
            }
          </div>
        </div>
        } @else {
        <input type="range" min="0" [max]="steps" [value]="sliderPos()" [attr.aria-label]="n.display_name"
          class="min-w-0 flex-1 slider"
          (pointerdown)="dragging = true" (input)="onSlide($any($event.target).valueAsNumber)"
          (change)="onSlideEnd($any($event.target).valueAsNumber)" />
        <input type="number" class="field w-24 shrink-0" [class.border-accent]="dirty()" [min]="r.min" [max]="r.max"
          [step]="r.inc ?? 'any'" [value]="shown()" [attr.aria-label]="n.display_name + ' value'"
          (change)="commitNumber($any($event.target).value)" />
        @if (st.unit) {
        <span class="w-6 shrink-0 font-mono text-2xs text-faint">{{ st.unit }}</span>
        }
        }
        } @else {
        <input type="text" class="field" [class.border-accent]="dirty()" [value]="shown()"
          [attr.aria-label]="n.display_name" (input)="draft.set($any($event.target).value)"
          (keydown.enter)="commitValue(shown())" (keydown.escape)="draft.set(null)" />
        @if (st.unit) {
        <span class="shrink-0 font-mono text-2xs text-faint">{{ st.unit }}</span>
        }
        <button type="button" class="btn shrink-0" [class.btn-primary]="dirty()" [disabled]="!dirty() || saving()"
          (click)="commitValue(shown())">Set</button>
        }

        @if (st?.locked && st?.available) {
        <span class="tag h-4 shrink-0 px-1" title="Locked by the camera's current settings">Locked</span>
        }
        @if (saving() && n.node_type !== 'Command') {
        <span class="dot shrink-0 animate-pulse bg-warn" title="Applying"></span>
        }
      </div>
      @if (error(); as err) {
      <p class="m-0 font-mono text-2xs text-err">{{ err }}</p>
      } @else if (st?.error; as err) {
      <p class="m-0 truncate font-mono text-2xs text-faint" [title]="err">{{ err }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
  `,
})
export class FeatureControlComponent {
  readonly node = input.required<GenICamNodeInfo>();
  readonly state = input<FeatureState | undefined>();
  readonly saving = input(false);
  /** The last write error for this feature. */
  readonly error = input<string | undefined>();
  /** Nothing may be written right now (e.g. a burst holds the camera). */
  readonly disabled = input(false);
  /**
   * `wide` has the room for range chips and a slider on wide-range numbers, on two rows; `strip`
   * puts them in one row; `inline` has neither.
   */
  readonly layout = input<'inline' | 'wide' | 'strip'>('inline');

  readonly commit = output<string>();
  readonly execute = output<void>();

  readonly steps = SLIDER_STEPS;
  /** The user's unapplied edit; `null` follows the device. */
  readonly draft = signal<string | null>(null);
  /** A slider drag is in progress: device values arriving meanwhile must not move the thumb. */
  dragging = false;

  readonly value = computed(() => this.state()?.value ?? null);
  readonly shown = computed(() => this.draft() ?? this.value() ?? '');
  readonly dirty = computed(() => this.draft() !== null && this.draft() !== this.value());

  readonly writable = computed(() => {
    const mode = this.node().access_mode;
    return (mode === 'ReadWrite' || mode === 'WriteOnly') && !this.state()?.locked && !this.disabled();
  });

  readonly range = computed(() => {
    const n = this.node();
    const st = this.state();
    if (!st || (n.node_type !== 'Integer' && n.node_type !== 'Float')) {
      return null;
    }
    return sliderRange(st.min, st.max, st.inc, st.representation, n.node_type === 'Integer');
  });

  readonly sliderPos = computed(() => {
    const r = this.range();
    const v = Number(this.shown());
    return r && Number.isFinite(v) ? toSlider(v, r) : 0;
  });

  readonly windows = computed(() => {
    const r = this.range();
    return r?.log ? decadeWindows(r.min, r.max) : [];
  });
  /** A decade chosen with the chips; otherwise the one holding the value. */
  private readonly pickedWindow = signal<number | null>(null);
  readonly activeWindow = computed(() => {
    const picked = this.pickedWindow();
    const windows = this.windows();
    if (picked !== null && picked < windows.length) {
      return picked;
    }
    const v = Number(this.shown());
    return Number.isFinite(v) ? windowIndex(v, windows) : 0;
  });
  /** The linear slider range within the active decade. */
  private readonly windowRange = computed<NumericRange | null>(() => {
    const r = this.range();
    const w = this.windows()[this.activeWindow()];
    return r && w ? { ...r, min: w.lo, max: w.hi, log: false } : null;
  });
  readonly windowPos = computed(() => {
    const r = this.windowRange();
    const v = Number(this.shown());
    return r && Number.isFinite(v) ? toSlider(v, r) : 0;
  });
  readonly quantity = computed(() => {
    const v = Number(this.shown());
    return Number.isFinite(v) && this.shown() !== '' ? formatQuantity(v, this.state()?.unit ?? null) : '—';
  });

  /** Enum entries the device currently offers, plus the current one whatever it is. */
  readonly entries = computed<GenICamEnumInfo[]>(() => {
    const all = this.node().enums ?? [];
    const offered = this.state()?.available_entries;
    if (!offered) {
      return all;
    }
    const current = this.shown();
    return all.filter((e) => offered.includes(e.value) || String(e.value) === current);
  });

  readonly unlisted = computed(() => {
    const v = this.shown();
    return v !== '' && !this.entries().some((e) => String(e.value) === v);
  });

  readonly display = computed(() => {
    const st = this.state();
    const raw = this.value();
    if (raw === null) {
      return '—';
    }
    const n = this.node();
    if (n.node_type === 'Enum') {
      const entry = n.enums?.find((e) => String(e.value) === raw);
      return entry?.display_name ?? raw;
    }
    if (n.node_type === 'Integer' || n.node_type === 'Float') {
      const unit = st?.unit ?? null;
      if (isDurationUnit(unit) && Number.isFinite(Number(raw))) {
        return formatQuantity(Number(raw), unit);
      }
      return formatValue(raw, st?.representation ?? null, unit);
    }
    return raw;
  });

  constructor() {
    // A new value from the device (or a rejected write) replaces the edit, unless the user is
    // still dragging.
    effect(() => {
      this.value();
      this.error();
      untracked(() => {
        if (!this.dragging) {
          this.draft.set(null);
          this.pickedWindow.set(null);
        }
      });
    });
  }

  commitValue(value: string): void {
    this.draft.set(value);
    if (value !== this.value()) {
      this.commit.emit(value);
    }
  }

  commitNumber(text: string): void {
    const r = this.range();
    const v = Number(text);
    if (!r || text.trim() === '' || !Number.isFinite(v)) {
      this.draft.set(null);
      return;
    }
    this.commitValue(String(snap(v, r)));
  }

  /**
   * Dragging only previews the value; it is written on release. Many features can only change
   * with acquisition paused, so writing every step would restart a live stream over and over.
   */
  onSlide(pos: number, inWindow = false): void {
    const r = inWindow ? this.windowRange() : this.range();
    if (!r) {
      return;
    }
    this.dragging = true;
    this.draft.set(String(fromSlider(pos, r)));
  }

  onSlideEnd(pos: number, inWindow = false): void {
    this.onSlide(pos, inWindow);
    this.dragging = false;
    this.commitValue(this.shown());
  }

  /** Show decade `i` on the slider; a value outside it moves to its nearest edge. */
  pickWindow(i: number): void {
    const r = this.range();
    const w = this.windows()[i];
    if (!r || !w) {
      return;
    }
    this.pickedWindow.set(i);
    const v = Number(this.shown());
    if (Number.isFinite(v) && (v < w.lo || v > w.hi)) {
      this.commitValue(String(snap(v < w.lo ? w.lo : w.hi, r)));
    }
  }

  /** Halve or double: one photographic stop. */
  scale(factor: number): void {
    const r = this.range();
    const v = Number(this.shown());
    if (!r || !Number.isFinite(v)) {
      return;
    }
    this.pickedWindow.set(null);
    this.commitValue(String(snap(v * factor, r)));
  }

  windowLabel(w: RangeWindow, i: number): string {
    const unit = this.state()?.unit ?? null;
    return i === 0 && this.windows().length > 1 ? `≤ ${formatQuantity(w.hi, unit)}` : formatSpan(w.lo, w.hi, unit);
  }
}
