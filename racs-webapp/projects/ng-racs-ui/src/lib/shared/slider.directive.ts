import { Directive, ElementRef, afterEveryRender, inject } from '@angular/core';

/**
 * Keeps `--fill` (the share of the track left of the thumb) current on an `<input type="range"
 * class="slider">`, for engines without a native progress part. Styling is `.slider` in
 * `styles.scss`.
 */
@Directive({
  selector: 'input[type=range].slider',
  standalone: true,
  host: { '(input)': 'sync()' },
})
export class SliderDirective {
  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef);

  constructor() {
    // The value also changes through bindings, which no input event reports.
    afterEveryRender(() => this.sync());
  }

  sync(): void {
    const input = this.el.nativeElement;
    const min = input.min === '' ? 0 : Number(input.min);
    const max = input.max === '' ? 100 : Number(input.max);
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
  }
}
