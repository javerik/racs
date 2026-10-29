import { Component, DestroyRef, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import {
  dragRegion,
  type Region,
  regionFromPoints,
  type RegionHandle,
  type RegionLimits,
  sameRegion,
  unrotateStep,
} from 'ng-racs-core';
import { FrameCanvasComponent } from '../shared/frame-canvas.component';

interface Drag {
  pointer: number;
  handle: RegionHandle | 'draw';
  from: { x: number; y: number };
  start: Region;
}

const HANDLE_PX = 8;

const CURSORS: Record<RegionHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  move: 'move',
};

/**
 * The camera region over the sensor, for a frame canvas showing the sensor as its space
 * (`<svg:g racsRegionOverlay overlay />`): the sensor outline, everything outside the draft region
 * dimmed, the region the device holds dashed, and the draft with handles. Drag a side or corner
 * to resize, inside to move, outside to draw a new region. Arrow keys move it by one increment
 * (Shift: ten), Enter applies, Esc cancels. Sides the camera can't move have no handle.
 */
@Component({
  selector: 'svg:g[racsRegionOverlay]',
  standalone: true,
  template: `
    @let s = sensor();
    @let d = draft();
    <!-- The sensor as a plate, open where the frame shows. -->
    <svg:path class="plate" fill-rule="evenodd" [attr.d]="platePath()" />
    <svg:rect class="sensor" x="0" y="0" [attr.width]="s.width" [attr.height]="s.height"
      (pointerdown)="onDown($event, 'draw')" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
    @if (d) {
    <svg:path class="dim" fill-rule="evenodd"
      [attr.d]="'M0 0H' + s.width + 'V' + s.height + 'H0Z M' + d.x + ' ' + d.y + 'h' + d.width + 'v' + d.height + 'h' + -d.width + 'Z'" />
    @if (current(); as c) {
    @if (!same()) {
    <svg:rect class="current" [attr.x]="c.x" [attr.y]="c.y" [attr.width]="c.width" [attr.height]="c.height" />
    }
    }
    <svg:rect class="draft" [class.dragging]="dragging()" [attr.x]="d.x" [attr.y]="d.y" [attr.width]="d.width"
      [attr.height]="d.height" [style.cursor]="canMove() ? 'move' : 'default'"
      (pointerdown)="onDown($event, 'move')" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
    @let at = labelAt();
    <svg:text class="size" [attr.x]="at.x" [attr.y]="at.y" [attr.font-size]="11 / scale()"
      [attr.transform]="'rotate(' + -rotation() + ' ' + at.x + ' ' + at.y + ')'"
      [attr.dy]="(handlePx() / 2 + 13 / scale())">{{ d.width }}×{{ d.height }} · {{ d.x }},{{ d.y }}</svg:text>
    @for (h of handles(); track h.handle) {
    <svg:rect class="handle" [class.active]="activeHandle() === h.handle"
      [attr.x]="h.x - handlePx() / 2" [attr.y]="h.y - handlePx() / 2"
      [attr.width]="handlePx()" [attr.height]="handlePx()" [style.cursor]="cursors[h.handle]"
      (pointerdown)="onDown($event, h.handle)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
    }
    }
  `,
  styles: `
    .sensor {
      fill: transparent;
      stroke: rgb(var(--line-strong));
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
      pointer-events: all;
      cursor: crosshair;
    }

    .plate {
      fill: rgb(var(--surface));
      pointer-events: none;
    }

    .dim {
      fill: rgb(var(--bg) / 0.6);
      pointer-events: none;
    }

    .current {
      fill: none;
      stroke: rgb(var(--muted));
      stroke-width: 1px;
      stroke-dasharray: 4 3;
      vector-effect: non-scaling-stroke;
      pointer-events: none;
    }

    .draft {
      fill: transparent;
      stroke: rgb(var(--fg));
      stroke-width: 1.5px;
      vector-effect: non-scaling-stroke;
      pointer-events: all;
    }

    .draft.dragging {
      stroke: rgb(var(--accent));
    }

    .size {
      fill: rgb(var(--fg));
      stroke: rgb(var(--bg) / 0.85);
      stroke-width: 3px;
      paint-order: stroke;
      vector-effect: non-scaling-stroke;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      pointer-events: none;
      user-select: none;
    }

    .handle {
      fill: rgb(var(--fg));
      stroke: rgb(var(--bg));
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
      pointer-events: all;
      touch-action: none;
    }

    .handle.active,
    .handle:hover {
      fill: rgb(var(--accent));
    }
  `,
})
export class RegionOverlayComponent {
  /** The device's limits; the sensor is their extent. */
  readonly limits = input.required<RegionLimits>();
  /** The region the device holds. */
  readonly current = input<Region | null>(null);
  /** The region being edited. */
  readonly draft = model<Region | null>(null);
  readonly apply = output<void>();
  readonly cancel = output<void>();

  private readonly canvas = inject(FrameCanvasComponent);
  readonly scale = this.canvas.scale;
  readonly rotation = computed(() => this.canvas.view().rotation);
  readonly cursors = CURSORS;

  readonly sensor = computed(() => ({ width: this.limits().x.extent, height: this.limits().y.extent }));
  /** The sensor minus the frame's place on it (the region the device holds). */
  readonly platePath = computed(() => {
    const s = this.sensor();
    const c = this.current();
    const outer = `M0 0H${s.width}V${s.height}H0Z`;
    return c ? `${outer} M${c.x} ${c.y}h${c.width}v${c.height}h${-c.width}Z` : outer;
  });
  readonly same = computed(() => sameRegion(this.current(), this.draft()));
  readonly canMove = computed(() => this.limits().x.hasOffset || this.limits().y.hasOffset);
  readonly handlePx = computed(() => ((this.canvas.layoutMobile() ? 2 : 1) * HANDLE_PX) / this.scale());
  readonly activeHandle = signal<RegionHandle | 'draw' | null>(null);
  readonly dragging = computed(() => this.activeHandle() !== null);

  /** Handles on the sides the camera can move: without an offset only right and bottom. */
  readonly handles = computed(() => {
    const d = this.draft();
    if (!d) {
      return [];
    }
    const { x, y } = this.limits();
    const [l, t, r, b] = [d.x, d.y, d.x + d.width, d.y + d.height];
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;
    const all: { handle: RegionHandle; x: number; y: number }[] = [
      { handle: 'nw', x: l, y: t },
      { handle: 'n', x: cx, y: t },
      { handle: 'ne', x: r, y: t },
      { handle: 'e', x: r, y: cy },
      { handle: 'se', x: r, y: b },
      { handle: 's', x: cx, y: b },
      { handle: 'sw', x: l, y: b },
      { handle: 'w', x: l, y: cy },
    ];
    // Side handles only where the side has room for them between the corners.
    const room = 4 * this.handlePx();
    return all.filter(
      (h) =>
        (x.hasOffset || !h.handle.includes('w')) &&
        (y.hasOffset || !h.handle.includes('n')) &&
        !((h.handle === 'n' || h.handle === 's') && d.width < room) &&
        !((h.handle === 'e' || h.handle === 'w') && d.height < room),
    );
  });

  /** The size label sits under the region's bottom-left corner, as it is on screen. */
  readonly labelAt = computed(() => {
    const d = this.draft()!;
    // The corner that is bottom-left once the view is turned.
    switch (this.rotation()) {
      case 90:
        return { x: d.x, y: d.y };
      case 180:
        return { x: d.x + d.width, y: d.y };
      case 270:
        return { x: d.x + d.width, y: d.y + d.height };
      default:
        return { x: d.x, y: d.y + d.height };
    }
  });

  private drag: Drag | null = null;

  constructor() {
    const off = this.canvas.addKeyHandler((e) => this.onKey(e));
    inject(DestroyRef).onDestroy(off);
    effect(() => {
      this.canvas.pinchStarts();
      untracked(() => this.abort());
    });
  }

  onDown(event: PointerEvent, handle: RegionHandle | 'draw'): void {
    const draft = this.draft();
    if (event.button !== 0 || this.drag || !draft) {
      return;
    }
    const from = this.canvas.spaceFromClient(event.clientX, event.clientY);
    if (!from || (handle === 'move' && !this.canMove())) {
      return;
    }
    this.canvas.claimPointer(event.pointerId);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.drag = { pointer: event.pointerId, handle, from, start: draft };
    this.activeHandle.set(handle);
    this.canvas.viewportFocus();
  }

  onMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) {
      return;
    }
    const p = this.canvas.spaceFromClient(event.clientX, event.clientY);
    if (!p) {
      return;
    }
    const limits = this.limits();
    this.draft.set(
      drag.handle === 'draw'
        ? regionFromPoints(drag.from, p, limits)
        : dragRegion(drag.start, drag.handle, p.x - drag.from.x, p.y - drag.from.y, limits),
    );
  }

  onUp(event: PointerEvent): void {
    if (this.drag?.pointer === event.pointerId) {
      this.drag = null;
      this.activeHandle.set(null);
    }
  }

  onCancel(event: PointerEvent): void {
    if (this.drag?.pointer === event.pointerId) {
      this.abort();
    }
  }

  private abort(): void {
    if (this.drag) {
      this.draft.set(this.drag.start);
      this.drag = null;
      this.activeHandle.set(null);
    }
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.apply.emit();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel.emit();
      return true;
    }
    const draft = this.draft();
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (!draft || !(e.key in steps) || !this.canMove()) {
      return false;
    }
    const limits = this.limits();
    const [sx, sy] = unrotateStep(steps[e.key], this.rotation());
    const k = e.shiftKey ? 10 : 1;
    this.draft.set(dragRegion(draft, 'move', sx * k * limits.x.offsetInc, sy * k * limits.y.offsetInc, limits));
    return true;
  }
}
