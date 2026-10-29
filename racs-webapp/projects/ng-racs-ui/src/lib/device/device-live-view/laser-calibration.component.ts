import { Component, computed, inject } from '@angular/core';
import { LaserCalibrationService, LaserlineLinkService, RMS_WARN_PX } from 'ng-racs-core';
import { IconComponent } from '../../shared/icon.component';

/**
 * The laserline row of the region editor: the device's calibration at a glance and the button
 * that opens the calibration wizard (`laser-wizard.component.ts`).
 */
@Component({
  selector: 'racs-laser-calibration',
  standalone: true,
  imports: [IconComponent],
  host: { class: 'flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-1.5' },
  template: `
    <span class="inline-flex items-center gap-1.5">
      <racs-icon name="laser" class="!h-3.5 !w-3.5 text-muted" />
      <span class="label text-fg">Laserline</span>
    </span>

    @if (calib.calibration(); as cal) {
      @if (calib.stale()) {
        <span class="font-mono text-2xs text-warn">laserline view resized · calibrate again</span>
      } @else {
        <span class="font-mono text-2xs text-muted"
          title="Reprojection error of the decoded cells, the share of the laserline view the camera sees, and the number of cells">
          rms <span [class.text-warn]="rough()" [class.text-fg]="!rough()">{{ cal.rms.toFixed(2) }}</span> px
          · field {{ fieldPct() }} % · {{ cal.pairs }} pts
        </span>
      }
      @if (calib.limited()) {
        <span class="tag" title="Laserline keeps its line inside an area">Limited</span>
      }
    } @else {
      <span class="font-mono text-2xs text-faint">aim the camera at the laserline view, then calibrate</span>
    }

    <span class="ml-auto inline-flex items-center gap-2 mobile:ml-0 mobile:w-full">
      <button type="button" class="btn mobile:flex-1" (click)="calib.openWizard()"
        title="Calibrate the camera against the laserline view, set the region and keep laserline's line inside it">
        {{ calib.calibration() ? 'Calibration…' : 'Calibrate…' }}
      </button>
    </span>
  `,
})
export class LaserCalibrationComponent {
  readonly calib = inject(LaserCalibrationService);
  readonly link = inject(LaserlineLinkService);

  readonly fieldPct = computed(() => Math.round((this.calib.fieldShare() ?? 0) * 100));
  readonly rough = computed(() => (this.calib.calibration()?.rms ?? 0) > RMS_WARN_PX);

  constructor() {
    // Pick up an open laserline window, so the row knows whether it keeps limits.
    if (this.link.supported && !this.link.host()) {
      void this.link.hello();
    }
  }
}
