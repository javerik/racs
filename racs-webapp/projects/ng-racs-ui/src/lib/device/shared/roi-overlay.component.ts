import { Component, DestroyRef, computed, effect, inject, untracked } from '@angular/core';
import { type Roi, RoiSession, seriesColor, unrotateStep } from 'ng-racs-core';
import { FrameCanvasComponent } from './frame-canvas.component';

/** A rect's sides and corners (compass points), a line's ends, or the whole ROI. */
type Grip = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'p0' | 'p1' | 'move';

interface Drag {
  pointer: number;
  kind: 'draw' | 'edit';
  grip: Grip;
  /** Where the pointer went down, in frame pixels. */
  from: { x: number; y: number };
  /** The ROI as it was when the drag started (normalised for a rect). */
  start: Roi | null;
  /** Set once a draw has moved far enough to be a ROI rather than a click. */
  roiId: string | null;
}

/** Screen pixels a press must move before it draws a ROI instead of being a click. */
const DRAW_SLOP = 4;
/** Handle size and hit width on screen, px; doubled for touch. */
const HANDLE_PX = 7;
const HIT_PX = 9;

const CURSORS: Record<Grip, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  p0: 'move',
  p1: 'move',
  move: 'move',
};

/**
 * The soft ROIs drawn over a frame canvas (`<svg:g racsRoiOverlay overlay />`), in their series
 * colours with their names. With the Rect or Line tool on, a drag on the image draws one; any
 * ROI can be selected, moved and resized by its handles; Delete removes the selected one, Esc
 * deselects it or leaves the tool.
 */
@Component({
  selector: 'svg:g[racsRoiOverlay]',
  standalone: true,
  template: `
    @if (size(); as size) {
    @if (drawing()) {
    <svg:rect class="draw-area" x="0" y="0" [attr.width]="size.width" [attr.height]="size.height"
      (pointerdown)="onDown($event, null, 'move')" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
    }
    @for (r of rois(); track r.id) {
    @let sel = r.id === session.selectedId();
    @let color = colorOf(r);
    <svg:g [style.cursor]="'move'">
      @if (r.shape === 'rect') {
      <svg:rect class="mark" [attr.x]="min(r.x0, r.x1)" [attr.y]="min(r.y0, r.y1)"
        [attr.width]="abs(r.x1 - r.x0)" [attr.height]="abs(r.y1 - r.y0)"
        [attr.stroke]="color" [attr.stroke-width]="sel ? 2 : 1.25" />
      <!-- A wider transparent outline (the whole area while drawing) to grab it by. -->
      <svg:rect class="hit" [class.fill-hit]="drawing()" [attr.x]="min(r.x0, r.x1)" [attr.y]="min(r.y0, r.y1)"
        [attr.width]="abs(r.x1 - r.x0)" [attr.height]="abs(r.y1 - r.y0)" [attr.stroke-width]="hitPx()"
        (pointerdown)="onDown($event, r, 'move')" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
        (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
      } @else {
      <svg:line class="mark" [attr.x1]="r.x0" [attr.y1]="r.y0" [attr.x2]="r.x1" [attr.y2]="r.y1"
        [attr.stroke]="color" [attr.stroke-width]="sel ? 2 : 1.25" />
      <svg:line class="hit" [attr.x1]="r.x0" [attr.y1]="r.y0" [attr.x2]="r.x1" [attr.y2]="r.y1"
        [attr.stroke-width]="hitPx()"
        (pointerdown)="onDown($event, r, 'move')" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
        (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
      }
      @let at = labelAt(r);
      <svg:text class="name" [attr.x]="at.x" [attr.y]="at.y" [attr.font-size]="11 / scale()"
        [attr.transform]="'rotate(' + -rotation() + ' ' + at.x + ' ' + at.y + ')'"
        [attr.dx]="3 / scale()" [attr.dy]="-4 / scale()">{{ r.name }}</svg:text>
    </svg:g>
    @if (sel) {
    @for (h of grips(r); track h.grip) {
    <svg:rect class="handle" [attr.x]="h.x - handlePx() / 2" [attr.y]="h.y - handlePx() / 2"
      [attr.width]="handlePx()" [attr.height]="handlePx()" [style.cursor]="cursor(h.grip)"
      (pointerdown)="onDown($event, r, h.grip)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
      (pointercancel)="onCancel($event)" (lostpointercapture)="onUp($event)" />
    }
    }
    }
    }
  `,
  styles: `
    .draw-area {
      fill: transparent;
      pointer-events: all;
      cursor: crosshair;
    }

    .mark {
      fill: none;
      vector-effect: non-scaling-stroke;
      pointer-events: none;
    }

    .hit {
      fill: none;
      stroke: transparent;
      vector-effect: non-scaling-stroke;
      pointer-events: stroke;
    }

    .hit.fill-hit {
      pointer-events: all;
    }

    .name {
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
      fill: rgb(var(--accent));
      stroke: rgb(var(--bg));
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
      pointer-events: all;
      touch-action: none;
    }
  `,
})
export class RoiOverlayComponent {
  readonly session = inject(RoiSession);
  private readonly canvas = inject(FrameCanvasComponent);

  readonly size = this.canvas.content;
  readonly scale = this.canvas.scale;
  readonly rotation = computed(() => this.canvas.view().rotation);
  readonly rois = this.session.rois;
  readonly drawing = computed(() => this.session.tool() === 'rect' || this.session.tool() === 'line');
  private readonly touch = computed(() => this.canvas.layoutMobile());
  readonly handlePx = computed(() => ((this.touch() ? 2 : 1) * HANDLE_PX) / this.scale());
  readonly hitPx = computed(() => (this.touch() ? 2 : 1) * HIT_PX);

  private drag: Drag | null = null;

  constructor() {
    const off = this.canvas.addKeyHandler((e) => this.onKey(e));
    inject(DestroyRef).onDestroy(off);

    // A second finger means a pinch: drop what the first one started.
    effect(() => {
      this.canvas.pinchStarts();
      untracked(() => this.abort());
    });
  }

  colorOf(r: Roi): string {
    return seriesColor(r.series);
  }

  cursor(grip: Grip): string {
    return CURSORS[grip];
  }

  min(a: number, b: number): number {
    return Math.min(a, b);
  }

  abs(v: number): number {
    return Math.abs(v);
  }

  /** The label sits at the rect's top-left corner as seen on screen, at the start of a line. */
  labelAt(r: Roi): { x: number; y: number } {
    if (r.shape === 'line') {
      return { x: r.x0, y: r.y0 };
    }
    const [l, t, rr, b] = [Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.max(r.x0, r.x1), Math.max(r.y0, r.y1)];
    switch (this.rotation()) {
      case 90:
        return { x: l, y: b };
      case 180:
        return { x: rr, y: b };
      case 270:
        return { x: rr, y: t };
      default:
        return { x: l, y: t };
    }
  }

  grips(r: Roi): { grip: Grip; x: number; y: number }[] {
    if (r.shape === 'line') {
      return [
        { grip: 'p0', x: r.x0, y: r.y0 },
        { grip: 'p1', x: r.x1, y: r.y1 },
      ];
    }
    const [l, t, rr, b] = [Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.max(r.x0, r.x1), Math.max(r.y0, r.y1)];
    const cx = (l + rr) / 2;
    const cy = (t + b) / 2;
    // Side handles only where the side has room for them between the corners.
    const room = 4 * this.handlePx();
    const grips: { grip: Grip; x: number; y: number }[] = [
      { grip: 'nw', x: l, y: t },
      { grip: 'n', x: cx, y: t },
      { grip: 'ne', x: rr, y: t },
      { grip: 'e', x: rr, y: cy },
      { grip: 'se', x: rr, y: b },
      { grip: 's', x: cx, y: b },
      { grip: 'sw', x: l, y: b },
      { grip: 'w', x: l, y: cy },
    ];
    return grips.filter(
      (g) => !((g.grip === 'n' || g.grip === 's') && rr - l < room) && !((g.grip === 'e' || g.grip === 'w') && b - t < room),
    );
  }

  // Gestures ------------------------------------------------------------------------------------

  onDown(event: PointerEvent, roi: Roi | null, grip: Grip): void {
    if (event.button !== 0 || this.drag) {
      return;
    }
    // Moving a ROI with a finger needs the drawing tool on; otherwise the finger scrolls the view.
    if (event.pointerType === 'touch' && !this.drawing() && grip === 'move') {
      return;
    }
    const from = this.canvas.spaceFromClient(event.clientX, event.clientY);
    if (!from) {
      return;
    }
    this.canvas.claimPointer(event.pointerId);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    if (roi) {
      this.session.select(roi.id);
      this.drag = { pointer: event.pointerId, kind: 'edit', grip, from, start: normalise(roi), roiId: roi.id };
    } else {
      this.drag = { pointer: event.pointerId, kind: 'draw', grip, from, start: null, roiId: null };
    }
    this.canvas.viewportFocus();
  }

  onMove(event: PointerEvent): void {
    const drag = this.drag;
    const size = this.size();
    if (!drag || drag.pointer !== event.pointerId || !size) {
      return;
    }
    const p = this.canvas.spaceFromClient(event.clientX, event.clientY);
    if (!p) {
      return;
    }
    if (drag.kind === 'draw') {
      const shape = this.session.tool() === 'line' ? 'line' : 'rect';
      const a = shape === 'line' ? centre(drag.from, size) : edge(drag.from, size);
      const b = shape === 'line' ? centre(p, size) : edge(p, size);
      if (!drag.roiId) {
        if (Math.hypot(p.x - drag.from.x, p.y - drag.from.y) * this.scale() < DRAW_SLOP) {
          return;
        }
        drag.roiId = this.session.add(shape, a.x, a.y, b.x, b.y).id;
      } else {
        this.session.update(drag.roiId, { x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      }
      return;
    }
    const start = drag.start!;
    this.session.update(start.id, edit(start, drag.grip, p.x - drag.from.x, p.y - drag.from.y, size));
  }

  onUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) {
      return;
    }
    this.drag = null;
    // A click on the image with a tool on, not a drag: deselect.
    if (drag.kind === 'draw' && !drag.roiId) {
      this.session.select(null);
    }
  }

  onCancel(event: PointerEvent): void {
    if (this.drag?.pointer === event.pointerId) {
      this.abort();
    }
  }

  /** Undo the drag in progress: a ROI being drawn goes, an edited one goes back. */
  private abort(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) {
      return;
    }
    if (drag.kind === 'draw' && drag.roiId) {
      this.session.remove(drag.roiId);
    } else if (drag.kind === 'edit' && drag.start) {
      const { id, ...rest } = drag.start;
      this.session.update(id, rest);
    }
  }

  private onKey(e: KeyboardEvent): boolean {
    const selected = this.session.selected();
    const size = this.size();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      this.session.remove(selected.id);
      return true;
    }
    if (e.key === 'Escape') {
      if (selected) {
        this.session.select(null);
        return true;
      }
      if (this.drawing()) {
        this.session.tool.set(null);
        return true;
      }
      return false;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (selected && size && e.key in delta) {
      // The arrows follow the screen, so undo the view's rotation.
      const [dx, dy] = unrotateStep(delta[e.key], this.rotation());
      this.session.update(selected.id, edit(normalise(selected), 'move', dx, dy, size));
      return true;
    }
    return false;
  }
}

/** A rect with x0 < x1 and y0 < y1, so its grips are named by position. */
function normalise(r: Roi): Roi {
  if (r.shape === 'line') {
    return { ...r };
  }
  return { ...r, x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

/** Rect corners sit on pixel edges. */
function edge(p: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.min(size.width, Math.max(0, Math.round(p.x))), y: Math.min(size.height, Math.max(0, Math.round(p.y))) };
}

/** Line ends sit on pixel centres. */
function centre(p: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  const c = (v: number, max: number) => Math.min(max - 0.5, Math.max(0.5, Math.floor(v) + 0.5));
  return { x: c(p.x, size.width), y: c(p.y, size.height) };
}

/** `start` with `grip` moved by (dx, dy), kept inside the frame. */
function edit(
  start: Roi,
  grip: Grip,
  dx: number,
  dy: number,
  size: { width: number; height: number },
): Partial<Roi> {
  if (grip === 'move') {
    const lo = start.shape === 'line' ? 0.5 : 0;
    const minX = Math.min(start.x0, start.x1);
    const maxX = Math.max(start.x0, start.x1);
    const minY = Math.min(start.y0, start.y1);
    const maxY = Math.max(start.y0, start.y1);
    const sx = Math.round(Math.min(size.width - lo - maxX, Math.max(lo - minX, dx)));
    const sy = Math.round(Math.min(size.height - lo - maxY, Math.max(lo - minY, dy)));
    return { x0: start.x0 + sx, y0: start.y0 + sy, x1: start.x1 + sx, y1: start.y1 + sy };
  }
  if (grip === 'p0' || grip === 'p1') {
    const p = centre({ x: (grip === 'p0' ? start.x0 : start.x1) + dx, y: (grip === 'p0' ? start.y0 : start.y1) + dy }, size);
    return grip === 'p0' ? { x0: p.x, y0: p.y } : { x1: p.x, y1: p.y };
  }
  let { x0, y0, x1, y1 } = start;
  if (grip.includes('w')) x0 = edge({ x: x0 + dx, y: 0 }, size).x;
  if (grip.includes('e')) x1 = edge({ x: x1 + dx, y: 0 }, size).x;
  if (grip.includes('n')) y0 = edge({ x: 0, y: y0 + dy }, size).y;
  if (grip.includes('s')) y1 = edge({ x: 0, y: y1 + dy }, size).y;
  // A rect is at least one pixel; dragging past the far side flips it rather than collapsing.
  if (x0 === x1) x1 = Math.min(size.width, x0 + 1);
  if (y0 === y1) y1 = Math.min(size.height, y0 + 1);
  return { x0, y0, x1, y1 };
}
