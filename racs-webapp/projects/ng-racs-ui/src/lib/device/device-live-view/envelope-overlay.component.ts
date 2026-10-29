import { Component, computed, inject } from '@angular/core';
import { LaserCalibrationService } from 'ng-racs-core';
import { FrameCanvasComponent } from '../shared/frame-canvas.component';

/**
 * The laserline line's envelope mapped onto the sensor (dashed; red where it leaves the sensor) or,
 * while the wizard sets a travel region, the part of the sensor that sees the laserline view, and
 * the cells the last calibration measured, for a frame canvas showing the sensor as
 * its space (`<svg:g racsEnvelopeOverlay overlay />`). Draws only; pointers pass through.
 */
@Component({
  selector: 'svg:g[racsEnvelopeOverlay]',
  standalone: true,
  template: `
    @for (p of points(); track $index) {
      <svg:circle class="point" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="2.5 / scale()" />
    }
    @if (showTravel()) {
      @if (travel()) {
        <svg:polygon class="view" [attr.points]="travelPolygon()" />
      }
    } @else if (proposal(); as p) {
      <svg:polygon class="envelope" [class.outside]="!p.complete" [attr.points]="polygon()" />
    }
  `,
  styles: `
    :host {
      pointer-events: none;
    }

    .envelope {
      fill: rgb(var(--fg) / 0.06);
      stroke: rgb(var(--fg));
      stroke-width: 1px;
      stroke-dasharray: 5 3;
      vector-effect: non-scaling-stroke;
    }

    .envelope.outside {
      stroke: rgb(var(--err));
      fill: rgb(var(--err) / 0.08);
    }

    .view {
      fill: none;
      stroke: rgb(var(--muted));
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
    }

    .point {
      fill: rgb(var(--muted));
    }
  `,
})
export class EnvelopeOverlayComponent {
  private readonly calib = inject(LaserCalibrationService);
  private readonly canvas = inject(FrameCanvasComponent);
  readonly scale = this.canvas.scale;
  readonly proposal = this.calib.proposal;
  readonly points = this.calib.points;
  readonly travel = this.calib.travel;
  readonly showTravel = computed(() => this.calib.wizard() !== null && this.calib.regionMode() === 'travel');
  readonly travelPolygon = computed(() => (this.travel()?.polygon ?? []).map((p) => `${p.x},${p.y}`).join(' '));
  readonly polygon = computed(() => (this.proposal()?.polygon ?? []).map((p) => `${p.x},${p.y}`).join(' '));
}
