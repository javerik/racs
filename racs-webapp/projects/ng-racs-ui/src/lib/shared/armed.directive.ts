import { Directive, DestroyRef, inject, input, output, signal } from '@angular/core';

/** How long an armed button waits for the confirming click. */
export const ARMED_MS = 4000;

/**
 * A two-step button for forceful actions (force release, force exclusive): the first click arms
 * it (`data-armed`, styled in `styles.scss`), and a second click within {@link ARMED_MS} emits
 * `confirmed`. Leaving the button disarms it. Bind `(confirmed)` instead of `(click)`; the label
 * follows `armed()` through the exported reference:
 *
 * ```html
 * <button class="btn" racsArmed #force="armed" (confirmed)="breakLease()">
 *   {{ force.armed() ? 'Confirm force' : 'Force release' }}
 * </button>
 * ```
 */
@Directive({
  selector: 'button[racsArmed]',
  standalone: true,
  exportAs: 'armed',
  host: {
    '[attr.data-armed]': 'armed() ? "true" : null',
    '(click)': 'click()',
    '(blur)': 'disarm()',
  },
})
export class ArmedDirective {
  /** Arm for this long (ms). */
  readonly armedFor = input(ARMED_MS);
  readonly confirmed = output<void>();
  readonly armed = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  click(): void {
    if (this.armed()) {
      this.disarm();
      this.confirmed.emit();
      return;
    }
    this.armed.set(true);
    this.clear();
    this.timer = setTimeout(() => this.disarm(), this.armedFor());
  }

  disarm(): void {
    this.clear();
    this.armed.set(false);
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
