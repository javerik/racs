import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import {
  analyze,
  decodeZstd,
  DeviceRegistryService,
  type GrayFrame,
  RacsService,
  resolveRange,
  type StreamInfo,
} from 'ng-racs-core';
import { FrameCanvasComponent, ThemeSwitchComponent } from 'ng-racs-ui';

/**
 * A page of its own on a RACS server: pick a connected camera, watch it live. The services and the
 * decoding come from ng-racs-core, the frame canvas (zoom, pan, rotate, pixel readout) and the
 * theme switch from ng-racs-ui, the look from its prebuilt racs-ui.css.
 */
@Component({
  selector: 'app-root',
  imports: [FrameCanvasComponent, ThemeSwitchComponent],
  template: `
    <header class="page-head">
      <span class="mark"></span>
      <h1>My camera page</h1>
      <span style="flex: 1"></span>
      <racs-theme-switch />
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2 class="label m-0 flex-1">Live</h2>
        <select class="field w-auto" aria-label="Camera" (change)="select(+$any($event.target).value)">
          @for (d of registry.connected(); track d.id) {
          <option [value]="d.id" [selected]="d.id === device()">#{{ d.id }} · {{ d.model }}</option>
          } @empty {
          <option>no camera connected</option>
          }
        </select>
        <button type="button" class="btn btn-primary" [disabled]="device() === null" (click)="toggle()">
          {{ live() ? 'Stop' : 'Start live' }}
        </button>
      </div>
      <racs-frame-canvas [frame]="frame()" [range]="range()" interactive placeholder="Press start" />
      <div class="status">{{ status() }}</div>
    </section>
  `,
})
export class AppComponent {
  readonly registry = inject(DeviceRegistryService);
  private readonly racs = inject(RacsService);

  readonly device = signal<number | null>(null);
  readonly frame = signal<GrayFrame | null>(null);
  readonly live = signal(false);
  readonly status = signal('idle');
  readonly range = computed(() => {
    const f = this.frame();
    return f ? resolveRange({ mode: 'auto', lo: 0, hi: 0 }, f.bitDepth, analyze(f)) : { lo: 0, hi: 255 };
  });

  private stream: Subscription | null = null;
  private info: StreamInfo | null = null;
  private decoding = false;

  constructor() {
    // The first connected camera until the user picks one.
    effect(() => {
      const ids = this.registry.connected().map((d) => d.id);
      if (this.device() === null && ids.length) {
        this.device.set(ids[0]);
      }
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  select(id: number): void {
    this.stop();
    this.device.set(id);
  }

  toggle(): void {
    if (this.live()) {
      this.stop();
      return;
    }
    const id = this.device();
    if (id === null) {
      return;
    }
    this.live.set(true);
    this.status.set('connecting…');
    this.stream = this.racs.liveStream(id, { format: 'zstd', pixelDepth: 'mono8', fps: 15 }).subscribe({
      next: (event) => {
        if (event.kind === 'info') {
          this.info = event.info;
          return;
        }
        // Skip frames while one is still decoding, so the page keeps up with the stream.
        const info = this.info;
        if (!info || this.decoding) {
          return;
        }
        this.decoding = true;
        decodeZstd(event.frame.payload, info.width, info.height, info.bit_depth ?? 8)
          .then((frame) => {
            this.frame.set(frame);
            this.status.set(`frame ${event.frame.frameNumber} · ${info.width} × ${info.height} · ${info.pixel_format}`);
          })
          .finally(() => (this.decoding = false));
      },
      error: (e: unknown) => {
        this.status.set(e instanceof Error ? e.message : String(e));
        this.live.set(false);
      },
      complete: () => this.live.set(false),
    });
  }

  private stop(): void {
    this.stream?.unsubscribe();
    this.stream = null;
    this.live.set(false);
    this.status.set('idle');
  }
}
