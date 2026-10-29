import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import {
  type AxisCheck,
  checkAgainstObject,
  type CloudScaling,
  formatUnits,
  isPixelScaling,
  type MetricMapping,
  proposeSnapshot,
  type RowRing,
  STL_CHECK_TOLERANCE,
  type StlCheckResult,
} from 'ng-racs-core';

/** A finished snapshot taken for the check. */
export interface StlCloud {
  ring: RowRing;
  storeStride: number;
}

/**
 * The check against the STL (#33 §5), in the *Laserline* block of the Scaling section: it proposes
 * a snapshot of one full pass, has the tab capture it (`capture` with the frame count), and
 * compares the object in it with laserline's `object_mm` per axis.
 *
 * The check runs once, when the tab hands the finished snapshot back (`cloud`), with the scaling
 * and mapping of that moment; the table stays until the next capture.
 */
@Component({
  selector: 'racs-stl-check',
  standalone: true,
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <span class="label">STL check</span>
    @if (proposal(); as p) {
    <span class="font-mono text-2xs text-muted">
      one pass + object · {{ p.seconds.toFixed(1) }} s · {{ p.frames }} {{ p.frames === 1 ? 'frame' : 'frames' }} at {{ fps(p.frameRate) }} fps
    </span>
    @if (p.hint) {
    <p class="m-0 font-mono text-2xs text-warn">{{ p.hint }}</p>
    }
    }
    @if (checking()) {
    <div class="flex items-baseline gap-2 font-mono text-2xs" role="status">
      <span class="dot shrink-0 animate-pulse bg-accent"></span>
      <span class="text-fg">capturing one pass <span class="text-faint">· keep laserline playing</span></span>
    </div>
    } @else {
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn mobile:flex-1" [disabled]="!!blocked()"
        [title]="blocked() ?? 'Captures a snapshot of one full pass (stopping the stream) and compares the object with the STL laserline slices'"
        (click)="start()">Check against STL</button>
    </div>
    @if (blocked(); as why) {
    <p class="m-0 font-mono text-2xs text-faint">{{ why }}</p>
    }
    }

    @if (result(); as r) {
    @if (r.refused !== null) {
    <p class="m-0 font-mono text-2xs text-warn" data-check="refused">{{ r.refused }}</p>
    } @else {
    <div class="overflow-x-auto border border-line">
      <table class="tbl font-mono text-2xs">
        <thead>
          <tr>
            <th class="!h-7 !px-2">Axis</th>
            <th class="!h-7 !px-2 text-right">STL</th>
            <th class="!h-7 !px-2 text-right">Measured</th>
            <th class="!h-7 !px-2 text-right">Error</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
          <tr [attr.data-axis]="row.id">
            <td class="!h-8 !px-2 text-muted">{{ row.label }}</td>
            <td class="!h-8 !px-2 text-right">{{ fmt(row.axis.stl) }}</td>
            <td class="!h-8 !px-2 text-right text-fg">{{ fmt(row.axis.measured) }}</td>
            <td class="!h-8 !px-2 text-right">
              <span class="inline-flex items-center gap-1.5" [class]="row.axis.ok ? 'text-fg' : 'text-err'">
                <span class="dot" [class]="row.axis.ok ? 'bg-ok' : 'bg-err'"></span>{{ pct(row.axis.error) }}
              </span>
            </td>
          </tr>
          }
        </tbody>
      </table>
    </div>
    <div class="flex items-center gap-2 font-mono text-2xs" data-check="checked">
      <span class="dot shrink-0" [class]="r.pass ? 'bg-ok' : 'bg-err'"></span>
      <span class="uppercase tracking-[0.08em] text-fg">{{ r.pass ? 'within ' + tolerance + ' %' : 'off by more than ' + tolerance + ' %' }}</span>
    </div>
    <span class="font-mono text-2xs text-faint">
      mm · u along the line, v along the travel, z the top above the base · {{ r.component.points.toLocaleString() }} points above {{ r.threshold.toFixed(1) }} mm
    </span>
    @if (metric()?.model_mirrored) {
    <p class="m-0 font-mono text-2xs text-faint">extents can't show a mirror image, and laserline's scan mirrors the model (its slice settings)</p>
    }
    }
    }
  `,
})
export class StlCheckComponent {
  readonly scaling = input.required<CloudScaling>();
  /** Laserline's mapping now: `undefined` offline or from an old laserline, `null` without a scan. */
  readonly metric = input<MetricMapping | null | undefined>(undefined);
  /** The camera's profiles per second (`pickRate`), null while unknown. */
  readonly rate = input<number | null>(null);
  /** Profiles per frame (the frame height), null while unknown. */
  readonly height = input<number | null>(null);
  /** Why the tab can't take a snapshot now, if it can't. */
  readonly captureBlocked = input<string | null>(null);
  /** The tab is capturing the snapshot this check asked for. */
  readonly checking = input(false);
  /** That snapshot, once it is complete; null before and from the next capture on. */
  readonly cloud = input<StlCloud | null>(null);
  /** Take a snapshot of this many frames for the check. */
  readonly capture = output<number>();

  readonly tolerance = STL_CHECK_TOLERANCE * 100;
  readonly result = signal<StlCheckResult | null>(null);
  /** The mapping when the capture was asked for: the pass's, if laserline is gone by the end. */
  private requested: MetricMapping | null = null;

  readonly proposal = computed(() => proposeSnapshot(this.metric(), this.rate(), this.height() ?? NaN));

  readonly blocked = computed(() => {
    const m = this.metric();
    if (m === undefined) {
      return 'laserline offline, or it publishes no mapping: open it with the scan loaded';
    }
    if (m === null) {
      return 'load a scan in laserline and enable it';
    }
    if (!m.object_mm) {
      return 'laserline reports no object: nothing in its scan rises above the base';
    }
    if (m.travel.end === 'bounce' || m.disturbances.includes('bounce')) {
      return 'bounce playback runs the return pass backwards: set laserline to loop or once';
    }
    if (!m.travel.playing) {
      return 'laserline’s playback is paused';
    }
    const s = this.scaling();
    if (s.unit !== 'mm' || isPixelScaling(s)) {
      return 'the scaling is not in mm yet: calibrate first';
    }
    if (!this.proposal()) {
      return this.rate() ? 'the frame height is unknown: stream once' : 'profile rate unknown: stream for 10 s first';
    }
    return this.captureBlocked();
  });

  readonly rows = computed<{ id: string; label: string; axis: AxisCheck }[]>(() => {
    const r = this.result();
    if (!r || r.refused !== null) {
      return [];
    }
    return [
      { id: 'u', label: 'Δu', axis: r.u },
      { id: 'v', label: 'Δv', axis: r.v },
      { id: 'z', label: 'z', axis: r.z },
    ];
  });

  constructor() {
    // Checked once per snapshot: a live follow moving the scaling afterwards doesn't redo it.
    effect(() => {
      const cloud = this.cloud();
      untracked(() => {
        if (!cloud) {
          this.result.set(null);
          return;
        }
        const metric = this.metric() || this.requested;
        this.result.set(
          metric
            ? checkAgainstObject(cloud.ring, this.scaling(), metric, cloud.storeStride)
            : { refused: 'laserline went away before the snapshot ended: nothing to compare' },
        );
      });
    });
  }

  start(): void {
    const p = this.proposal();
    if (this.blocked() || !p) {
      return;
    }
    this.requested = this.metric() ?? null;
    this.capture.emit(p.frames);
  }

  fmt(v: number): string {
    return formatUnits(v);
  }

  pct(error: number): string {
    if (!Number.isFinite(error)) {
      return '—';
    }
    const p = error * 100;
    return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)} %`;
  }

  fps(rate: number): string {
    return rate.toFixed(rate < 100 ? 1 : 0);
  }
}
