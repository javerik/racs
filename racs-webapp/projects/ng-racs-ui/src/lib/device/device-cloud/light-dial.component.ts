import { Component, computed, input, output } from '@angular/core';
import { anglesToDial, dialToAngles } from 'ng-racs-core';

/** Arrow keys move the light by this many degrees (shift: five times as far). */
const KEY_STEP = 5;

/**
 * Where the light comes from, as a dot on a disk seen from above like the Top view: the centre is
 * straight overhead, the rim the horizon, and the rings 60° and 30° up. Drag (or touch) the disk
 * to move it; arrow keys turn it (left/right) and raise or lower it (up/down). A tick on the rim
 * marks where the view looks from.
 */
@Component({
  selector: 'racs-light-dial',
  standalone: true,
  template: `
    <svg viewBox="-1.2 -1.2 2.4 2.4" class="block h-16 w-16 mobile:h-20 mobile:w-20" role="slider" tabindex="0"
      aria-label="Light direction" [attr.aria-valuetext]="valueText()" [attr.aria-disabled]="disabled()"
      [attr.title]="disabled() ? 'The light follows the view' : 'Light from ' + valueText() + ' · drag to move, arrows turn and raise'"
      [class.opacity-40]="disabled()"
      (pointerdown)="onDown($event)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onUp($event)" (keydown)="onKey($event)">
      <circle class="rim" r="1" />
      <circle class="ring" r="0.6667" />
      <circle class="ring" r="0.3333" />
      <line class="ring" x1="-1" y1="0" x2="1" y2="0" />
      <line class="ring" x1="0" y1="-1" x2="0" y2="1" />
      @if (viewTick(); as t) {
      <line class="tick" [attr.x1]="t.x1" [attr.y1]="t.y1" [attr.x2]="t.x2" [attr.y2]="t.y2" />
      }
      <line class="ray" x1="0" y1="0" [attr.x2]="dot().x" [attr.y2]="dot().y" />
      <circle class="light" r="0.14" [attr.cx]="dot().x" [attr.cy]="dot().y" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    svg {
      cursor: crosshair;
      touch-action: none;
      overflow: visible;
    }

    svg[aria-disabled='true'] {
      cursor: default;
    }

    svg:focus-visible {
      outline: 1px solid rgb(var(--accent));
      outline-offset: 2px;
    }

    circle,
    line {
      fill: none;
      stroke-width: 1.2px;
      vector-effect: non-scaling-stroke;
    }

    .rim {
      stroke: rgb(var(--line-strong));
    }

    .ring {
      stroke: rgb(var(--line));
    }

    .tick {
      stroke: rgb(var(--muted));
      stroke-width: 2px;
    }

    .ray {
      stroke: rgb(var(--muted));
    }

    .light {
      fill: rgb(var(--fg));
      stroke: rgb(var(--bg));
    }
  `,
})
export class LightDialComponent {
  /** Degrees, like `Orbit.yaw`. */
  readonly azimuth = input.required<number>();
  /** Degrees above the horizon. */
  readonly elevation = input.required<number>();
  readonly disabled = input(false);
  /** Where the view looks from (degrees, like `Orbit.yaw`), for the tick on the rim; null for none. */
  readonly viewAzimuth = input<number | null>(null);
  /** Azimuth not yet wrapped into −180..180: the owner sanitizes. */
  readonly angles = output<{ azimuth: number; elevation: number }>();

  readonly dot = computed(() => anglesToDial(this.azimuth(), this.elevation()));
  readonly valueText = computed(() => `azimuth ${Math.round(this.azimuth())}°, elevation ${Math.round(this.elevation())}°`);
  readonly viewTick = computed(() => {
    const az = this.viewAzimuth();
    if (az === null) {
      return null;
    }
    const [c, s] = [Math.cos((az * Math.PI) / 180), -Math.sin((az * Math.PI) / 180)];
    return { x1: c, y1: s, x2: c * 1.18, y2: s * 1.18 };
  });

  private dragging: number | null = null;

  onDown(e: PointerEvent): void {
    if (this.disabled() || e.button > 0) {
      return;
    }
    const svg = e.currentTarget as SVGSVGElement;
    svg.setPointerCapture?.(e.pointerId);
    svg.focus({ preventScroll: true });
    this.dragging = e.pointerId;
    this.place(e, svg);
    e.preventDefault();
  }

  onMove(e: PointerEvent): void {
    if (this.dragging === e.pointerId) {
      this.place(e, e.currentTarget as SVGSVGElement);
    }
  }

  onUp(e: PointerEvent): void {
    if (this.dragging === e.pointerId) {
      this.dragging = null;
    }
  }

  onKey(e: KeyboardEvent): void {
    if (this.disabled()) {
      return;
    }
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    let azimuth = this.azimuth();
    let elevation = this.elevation();
    switch (e.key) {
      case 'ArrowLeft':
        azimuth += step;
        break;
      case 'ArrowRight':
        azimuth -= step;
        break;
      case 'ArrowUp':
        elevation = Math.min(90, elevation + step);
        break;
      case 'ArrowDown':
        elevation = Math.max(0, elevation - step);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.angles.emit({ azimuth, elevation });
  }

  private place(e: PointerEvent, svg: SVGSVGElement): void {
    const r = svg.getBoundingClientRect();
    // The viewBox is 2.4 wide around the centre; the disk's radius is 1.
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2.4;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 2.4;
    this.angles.emit(dialToAngles(x, y, this.azimuth()));
  }
}
