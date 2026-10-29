import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  buildLut,
  DEFAULT_VIEW,
  type DisplayRange,
  fitScale,
  formatScale,
  fromSpacePoint,
  type GrayFrame,
  loadView,
  pinchScale,
  placeRect,
  renderInto,
  rotatedSize,
  rotateQuarter,
  saveView,
  type Size,
  toSpacePoint,
  type ViewScale,
  type ViewSettings,
  zoomStep,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { IconComponent } from '../../shared/icon.component';

/** Movement (px) under which a touch still counts as a tap. */
const TAP_SLOP = 10;
/** Two taps within this (ms) and this distance (px) are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

/** Viewport height on the page: at least this, and at most `min(maxHeightVh, 560px)`. */
const MIN_HEIGHT = 256;
const MAX_HEIGHT = 560;

/**
 * A larger coordinate space the frame sits in, such as the camera sensor with the frame at the
 * region's offset. Shown instead of the frame alone while the camera region is being edited.
 */
export interface FrameSpace {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

/** Handles a key pressed in the view first; returns true when it used it. */
export type ViewKeyHandler = (event: KeyboardEvent) => boolean;

/**
 * Draws a {@link GrayFrame} through a display range onto a canvas, with a pixel readout under
 * the pointer. Fitted into the available space by default; `interactive` adds a view toolbar
 * (rotate, fit or fixed scale, zoom, full screen) plus wheel zoom, drag to pan and shortcuts.
 * The view is CSS only: the canvas bitmap stays the frame as captured, so exports are unaffected.
 *
 * Overlays (ROIs, the camera region) are SVG components projected with the `overlay` attribute,
 * e.g. `<svg:g racsRoiOverlay overlay />`. They draw in frame pixels (or `space` pixels when one
 * is set) inside an SVG placed and rotated with the image, and use {@link spaceFromClient},
 * {@link claimPointer} and {@link addKeyHandler} for their gestures. `viewTools` content goes
 * into the toolbar, `viewBar` content in a row under it.
 */
@Component({
  selector: 'racs-frame-canvas',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (interactive()) {
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-1.5 mobile:flex-wrap mobile:justify-between mobile:gap-x-2 mobile:px-2">
      <span class="label mobile:hidden">View</span>
      <ng-content select="[viewTools]" />

      <div class="inline-flex items-center gap-1">
        <button type="button" class="icon-btn" title="Rotate left (Shift+R)" aria-label="Rotate left"
          (click)="turn(-1)"><racs-icon name="rotate-ccw" /></button>
        <button type="button" class="icon-btn" title="Rotate right (R)" aria-label="Rotate right"
          (click)="turn(1)"><racs-icon name="rotate-cw" /></button>
        <span class="w-8 text-right font-mono text-2xs mobile:hidden" [class.text-fg]="view().rotation !== 0"
          [class.text-faint]="view().rotation === 0">{{ view().rotation }}°</span>
      </div>

      <div class="inline-flex" role="radiogroup" aria-label="Scaling">
        <button type="button" role="radio" class="btn rounded-none" [attr.aria-checked]="isFit()"
          [class.!border-accent]="isFit()" [class.!text-fg]="isFit()" [class.text-muted]="!isFit()"
          title="Scale to fit the view (0)" (click)="setScale('fit')">Fit</button>
        <button type="button" role="radio" class="btn -ml-px rounded-none" [attr.aria-checked]="isFixed()"
          [class.!border-accent]="isFixed()" [class.!text-fg]="isFixed()" [class.text-muted]="!isFixed()"
          title="Fixed scale; drag to pan (1 for 100 %)" (click)="setScale(isFixed() ? view().scale : 1)">Fixed</button>
      </div>

      <div class="inline-flex items-center gap-1">
        <button type="button" class="icon-btn mobile:hidden" title="Zoom out (−)" aria-label="Zoom out" [disabled]="!frame()"
          (click)="zoom(-1)"><racs-icon name="zoom-out" /></button>
        <button type="button" class="h-6 min-w-[4.5rem] cursor-pointer mobile:h-10 mobile:min-w-[3.5rem] rounded border border-transparent bg-transparent px-1 font-mono text-2xs text-fg hover:border-line-strong hover:bg-raised"
          title="Show at 100 % (1)" (click)="setScale(1)">{{ scaleText() }}</button>
        <button type="button" class="icon-btn mobile:hidden" title="Zoom in (+)" aria-label="Zoom in" [disabled]="!frame()"
          (click)="zoom(1)"><racs-icon name="zoom-in" /></button>
      </div>

      <div class="ml-auto flex items-center gap-3 mobile:ml-0">
      <span class="hidden font-mono text-2xs text-faint 2xl:inline mobile:!hidden">
        {{ fullscreen() ? 'wheel zooms · drag pans · esc exits' : 'ctrl+wheel zooms · drag pans · dbl-click fit ↔ 100 %' }}
      </span>
      <button type="button" class="icon-btn"
        [title]="fullscreen() ? 'Exit full screen (F)' : 'Full screen (F)'"
        [attr.aria-label]="fullscreen() ? 'Exit full screen' : 'Full screen'" [attr.aria-pressed]="fullscreen()"
        (click)="toggleFullscreen()">
        <racs-icon [name]="fullscreen() ? 'fullscreen-exit' : 'fullscreen'" />
      </button>
      </div>
    </div>
    }
    <ng-content select="[viewBar]" />

    <div class="frame-box relative min-h-0 flex-1">
      <div #viewport class="viewport w-full outline-none"
        [class.overflow-hidden]="!scrollable()" [class.overflow-auto]="scrollable()"
        [class.cursor-grab]="scrollable() && !panning()" [class.cursor-grabbing]="panning()"
        [style.height]="fullscreen() ? '100%' : viewportHeight() + 'px'"
        [attr.tabindex]="interactive() ? 0 : null" [attr.aria-label]="interactive() ? 'Image view' : null"
        [style.touch-action]="interactive() ? 'pan-x pan-y' : null"
        (wheel)="onWheel($event)" (dblclick)="onDoubleClick($event)"
        (pointerdown)="onPointerDown($event)" (pointerup)="onPointerUp($event)" (pointercancel)="onPointerCancel($event)"
        (pointermove)="onPointer($event)" (pointerleave)="hover.set(null)">
        <div class="flex min-h-full w-max min-w-full">
          <div #stage class="relative m-auto shrink-0" [style.width.px]="extent().width"
            [style.height.px]="extent().height">
            <canvas #canvas class="absolute block max-w-none select-none"
              [class.hidden]="!frame()"
              [style.left.px]="frameCentre().x" [style.top.px]="frameCentre().y"
              [style.width.px]="drawn().width" [style.height.px]="drawn().height"
              [style.transform]="'translate(-50%, -50%) rotate(' + view().rotation + 'deg)'"
              [style.image-rendering]="pixelated() ? 'pixelated' : null"></canvas>
            <!-- Overlays draw in content pixels; the SVG turns with the image. -->
            <svg class="overlay absolute left-1/2 top-1/2 block overflow-visible"
              [attr.viewBox]="'0 0 ' + (content()?.width ?? 0) + ' ' + (content()?.height ?? 0)"
              preserveAspectRatio="none"
              [style.width.px]="(content()?.width ?? 0) * scale()" [style.height.px]="(content()?.height ?? 0) * scale()"
              [style.transform]="'translate(-50%, -50%) rotate(' + view().rotation + 'deg)'"
              [style.touch-action]="captureTouch() ? 'none' : null">
              <ng-content select="[overlay]" />
            </svg>
            @if (probeMark(); as m) {
            <!-- The pixel a tap probes. -->
            <span class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 border border-accent"
              [style.left.px]="m.x" [style.top.px]="m.y"></span>
            }
          </div>
        </div>
      </div>

      @if (!frame()) {
      <p class="pointer-events-none absolute inset-0 m-0 flex items-center justify-center px-4 text-center font-mono text-xs uppercase tracking-[0.12em] text-faint">
        {{ placeholder() }}
      </p>
      }
      @if (readout(); as r) {
      @if (hover()) {
      <span class="pointer-events-none absolute left-2 top-2 border border-line bg-bg/80 px-1.5 py-0.5 font-mono text-2xs text-fg">
        x {{ r.x }} · y {{ r.y }} · <span class="text-accent">{{ r.value }}</span>
      </span>
      } @else {
      <!-- A tapped probe stays, following the live value, until its chip is tapped. -->
      <button type="button"
        class="absolute left-2 top-2 inline-flex h-8 cursor-pointer items-center gap-2 border border-line bg-bg/80 px-2 font-mono text-2xs text-fg"
        title="Clear the probe" aria-label="Clear the pixel probe" (click)="probe.set(null)">
        <span>x {{ r.x }} · y {{ r.y }} · <span class="text-accent">{{ r.value }}</span></span>
        <racs-icon name="close" class="!h-2.5 !w-2.5 text-muted" />
      </button>
      }
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
    }

    :host(:fullscreen) {
      background: rgb(var(--bg));
    }

    // A faint measurement grid behind the frame, visible while there is no image and in the
    // margins around one.
    .viewport {
      background-color: rgb(var(--bg));
      background-image:
        linear-gradient(rgb(var(--line)) 1px, transparent 1px),
        linear-gradient(90deg, rgb(var(--line)) 1px, transparent 1px);
      background-size: 32px 32px;
      background-position: -1px -1px;
      background-attachment: local;
    }

    .viewport:focus-visible {
      box-shadow: inset 0 0 0 1px rgb(var(--accent));
    }

    // Only what overlays draw takes the pointer; the rest passes to the viewport (pan, probe).
    .overlay {
      pointer-events: none;
    }
  `,
})
export class FrameCanvasComponent {
  readonly frame = input<GrayFrame | null>(null);
  readonly range = input.required<DisplayRange>();
  readonly placeholder = input('No signal');
  /** Adds the view toolbar and gestures. */
  readonly interactive = input(false, { transform: booleanAttribute });
  /** Where an interactive view remembers its rotation and scale. */
  readonly viewKey = input('racs.live.view');
  /** The share of the window height the viewport may take on the page. */
  readonly maxHeightVh = input(0.7);
  /** Show the frame inside this larger space (the sensor) instead of on its own. */
  readonly space = input<FrameSpace | null>(null);
  /** One-finger drags on the image go to the overlays instead of scrolling (a drawing tool is on). */
  readonly captureTouch = input(false, { transform: booleanAttribute });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly layout = inject(LayoutService);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
  private readonly stageRef = viewChild.required<ElementRef<HTMLDivElement>>('stage');

  readonly hover = signal<{ x: number; y: number } | null>(null);
  /** The frame pixel a touch tapped: read out until cleared, with the value following each frame. */
  readonly probe = signal<{ x: number; y: number } | null>(null);
  readonly view = signal<ViewSettings>({ ...DEFAULT_VIEW });
  readonly fullscreen = signal(false);
  readonly panning = signal(false);
  /** Bumped when a two-finger pinch starts, so overlays drop a drag the first finger began. */
  readonly pinchStarts = signal(0);
  /** The viewport's inner size, and the window height the page layout is capped by. */
  private readonly box = signal<Size>({ width: 0, height: 0 });
  private readonly windowHeight = signal(typeof window === 'undefined' ? 800 : window.innerHeight);

  /** The frame's size, changing only when the geometry does rather than with every frame. */
  private readonly size = computed<Size | null>(
    () => {
      const f = this.frame();
      return f ? { width: f.width, height: f.height } : null;
    },
    { equal: (a, b) => a?.width === b?.width && a?.height === b?.height },
  );

  /** What the stage shows: the space when one is set, else the frame. */
  readonly content = computed<Size | null>(
    () => {
      const space = this.space();
      return space ? { width: space.width, height: space.height } : this.size();
    },
    { equal: (a, b) => a?.width === b?.width && a?.height === b?.height },
  );

  /** Where the frame's top-left corner sits in the content. */
  private readonly origin = computed(() => {
    const space = this.space();
    return space ? { x: space.offsetX, y: space.offsetY } : { x: 0, y: 0 };
  });

  private readonly maxHeight = computed(() =>
    Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(this.windowHeight() * this.maxHeightVh()))),
  );

  /** The scale the frame is shown at, whichever mode. */
  readonly scale = computed(() => {
    const size = this.content();
    const v = this.view();
    if (v.scale !== 'fit') {
      return v.scale;
    }
    if (!size) {
      return 1;
    }
    const box = this.box();
    const height = this.fullscreen() ? box.height : this.maxHeight();
    return fitScale(size, v.rotation, { width: box.width, height });
  });

  /** The canvas element's size before rotation. */
  readonly drawn = computed<Size>(() => {
    const size = this.size() ?? { width: 0, height: 0 };
    const s = this.scale();
    return { width: size.width * s, height: size.height * s };
  });

  /** The rotated content's extent on screen. */
  readonly extent = computed<Size>(() => {
    const size = this.content();
    if (!size) {
      return { width: 0, height: 0 };
    }
    const r = rotatedSize(size, this.view().rotation);
    const s = this.scale();
    return { width: r.width * s, height: r.height * s };
  });

  /** On the page the viewport grows with the image, between the minimum and the cap. */
  readonly viewportHeight = computed(() => {
    const max = this.maxHeight();
    if (!this.content()) {
      return MIN_HEIGHT;
    }
    return Math.round(Math.max(MIN_HEIGHT, Math.min(max, this.extent().height)));
  });

  readonly isFit = computed(() => this.view().scale === 'fit');
  readonly isFixed = computed(() => this.view().scale !== 'fit');
  readonly scrollable = computed(() => this.isFixed());
  readonly scaleText = computed(() => (this.content() ? formatScale(this.scale()) : '—'));

  /** The centre of the frame on the stage: the stage's centre unless it sits in a space. */
  readonly frameCentre = computed(() => {
    const size = this.size();
    const content = this.content();
    const extent = this.extent();
    if (!size || !content || !this.space()) {
      return { x: extent.width / 2, y: extent.height / 2 };
    }
    const o = this.origin();
    const r = placeRect({ x: o.x, y: o.y, width: size.width, height: size.height }, content, this.view().rotation, this.scale());
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  /** Show individual pixels crisply once the image is shown larger than its native size. */
  readonly pixelated = computed(() => this.scale() > 1.5);

  readonly readout = computed(() => {
    const h = this.hover() ?? this.probe();
    const f = this.frame();
    if (!h || !f || h.x >= f.width || h.y >= f.height) {
      return null;
    }
    return { ...h, value: f.pixels[h.y * f.width + h.x] };
  });

  /** Where the probe marker sits on the stage. */
  readonly probeMark = computed(() => {
    const p = this.probe();
    const size = this.size();
    const content = this.content();
    if (!p || !size || !content || p.x >= size.width || p.y >= size.height) {
      return null;
    }
    const o = this.origin();
    return fromSpacePoint({ x: p.x + o.x + 0.5, y: p.y + o.y + 0.5 }, content, this.view().rotation, this.scale());
  });

  private lut: Uint32Array | null = null;
  private lutKey = '';
  private image: ImageData | null = null;
  private pan: { id: number; x: number; y: number; left: number; top: number } | null = null;
  /** Touch pointers down on the viewport, for pinch zoom and taps. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; scale: number } | null = null;
  /** A touch that may still turn out to be a tap. */
  private tap: { id: number; x: number; y: number } | null = null;
  private lastTap: { at: number; x: number; y: number } | null = null;
  /** Pointers an overlay took for a gesture of its own. */
  private readonly claimed = new Set<number>();
  private readonly keyHandlers = new Set<ViewKeyHandler>();

  constructor() {
    effect(() => {
      const frame = this.frame();
      if (frame) {
        this.draw(frame, this.range());
      }
    });

    let loaded = false;
    effect(() => {
      if (this.interactive() && !loaded) {
        loaded = true;
        this.view.set(loadView(this.viewKey()));
      }
    });

    afterNextRender(() => {
      const viewport = this.viewportRef().nativeElement;
      const measure = () =>
        this.box.set({ width: viewport.clientWidth, height: viewport.clientHeight });
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      measure();
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  // Overlay API ---------------------------------------------------------------------------------

  /** The content position (continuous, unclamped) under a client point. */
  spaceFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const content = this.content();
    if (!content) {
      return null;
    }
    const rect = this.stageRef().nativeElement.getBoundingClientRect();
    return toSpacePoint({ x: clientX - rect.left, y: clientY - rect.top }, content, this.view().rotation, this.scale());
  }

  /**
   * An overlay handles this pointer from its pointerdown on: the view won't pan or probe with it.
   * Touches still count towards a pinch, which bumps {@link pinchStarts}.
   */
  claimPointer(id: number): void {
    this.claimed.add(id);
  }

  /** Touch-sized handles: the mobile layout. */
  readonly layoutMobile = computed(() => this.layout.isMobile());

  /** Focus the view (so overlay keys reach it) without scrolling the page. */
  viewportFocus(): void {
    if (this.interactive()) {
      this.viewportRef().nativeElement.focus({ preventScroll: true });
    }
  }

  /** Let an overlay see key presses in the view before the view's own shortcuts. */
  addKeyHandler(handler: ViewKeyHandler): () => void {
    this.keyHandlers.add(handler);
    return () => this.keyHandlers.delete(handler);
  }

  /** The canvas itself, for recording or exporting what is shown. */
  get canvas(): HTMLCanvasElement {
    return this.canvasRef().nativeElement;
  }

  /**
   * Draw synchronously. Normally driven by the inputs; exposed so an export can render frames
   * one after another without waiting for change detection.
   */
  draw(frame: GrayFrame, range: DisplayRange): void {
    const canvas = this.canvas;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    if (!this.image || this.image.width !== frame.width || this.image.height !== frame.height) {
      this.image = ctx.createImageData(frame.width, frame.height);
    }
    // The LUT only changes with the window or the storage type, not per frame.
    const key = `${frame.bitDepth > 8 ? 16 : 8}:${range.lo}:${range.hi}`;
    if (key !== this.lutKey || !this.lut) {
      this.lut = buildLut(range.lo, range.hi, frame.bitDepth);
      this.lutKey = key;
    }
    renderInto(frame, this.lut, this.image);
    ctx.putImageData(this.image, 0, 0);
  }

  // View actions -------------------------------------------------------------------------------

  /** Rotating swaps the extent, so a zoomed-in view is re-centred rather than left anywhere. */
  turn(dir: 1 | -1): void {
    this.update({ rotation: rotateQuarter(this.view().rotation, dir) });
    afterNextRender(
      () => {
        const viewport = this.viewportRef().nativeElement;
        viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
        viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      },
      { injector: this.injector },
    );
  }

  /** Switch to fit or a fixed scale, keeping the image point under `anchor` (default: centre). */
  setScale(scale: ViewScale, anchor?: { clientX: number; clientY: number }): void {
    if (scale === this.view().scale) {
      return;
    }
    this.keepAnchored(anchor, () => this.update({ scale }));
  }

  zoom(dir: 1 | -1, anchor?: { clientX: number; clientY: number }): void {
    if (!this.content()) {
      return;
    }
    this.setScale(zoomStep(this.scale(), dir), anchor);
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement === this.host.nativeElement) {
      void document.exitFullscreen();
    } else {
      void this.host.nativeElement.requestFullscreen?.().then(() => {
        this.viewportRef().nativeElement.focus();
        this.lockLandscape();
      });
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.fullscreen.set(document.fullscreenElement === this.host.nativeElement);
    if (!this.fullscreen()) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        // Nothing was locked.
      }
    }
  }

  /** On a phone, turn a wide image's full screen sideways (Chrome on Android allows it in full screen). */
  private lockLandscape(): void {
    const size = this.size();
    if (!this.layout.isMobile() || !size) {
      return;
    }
    const r = rotatedSize(size, this.view().rotation);
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (r.width > r.height && orientation?.lock) {
      orientation.lock('landscape').catch(() => {
        // Not supported here: the user can turn the phone.
      });
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.windowHeight.set(window.innerHeight);
  }

  @HostListener('keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
      return;
    }
    // Overlays get the keys pressed in the image itself; a focused button keeps Enter and Delete.
    if (target?.tagName !== 'BUTTON') {
      for (const handler of this.keyHandlers) {
        if (handler(event)) {
          event.preventDefault();
          return;
        }
      }
    }
    if (!this.interactive() || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case 'r':
        this.turn(1);
        break;
      case 'R':
        this.turn(-1);
        break;
      case 'f':
      case 'F':
        this.toggleFullscreen();
        break;
      case '0':
        this.setScale('fit');
        break;
      case '1':
        this.setScale(1);
        break;
      case '+':
      case '=':
        this.zoom(1);
        break;
      case '-':
      case '_':
        this.zoom(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // Gestures -----------------------------------------------------------------------------------

  /** Ctrl/⌘+wheel zooms at the pointer; in full screen the plain wheel does. */
  onWheel(event: WheelEvent): void {
    if (!this.interactive() || !this.content() || !(event.ctrlKey || event.metaKey || this.fullscreen())) {
      return;
    }
    event.preventDefault();
    if (event.deltaY !== 0) {
      this.zoom(event.deltaY < 0 ? 1 : -1, event);
    }
  }

  onDoubleClick(event: MouseEvent): void {
    // Touch double taps are handled in onPointerUp; the browser may also send a dblclick for them.
    if (!this.interactive() || !this.content() || (this.lastTap && performance.now() - this.lastTap.at < 1000)) {
      return;
    }
    this.setScale(this.isFit() ? 1 : 'fit', event);
  }

  onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      this.onTouchDown(event);
      return;
    }
    // The middle button always pans, so a drawing tool doesn't take panning away.
    const button = event.button === 1 || (event.button === 0 && !this.claimed.has(event.pointerId));
    if (!this.scrollable() || !button) {
      return;
    }
    const viewport = this.viewportRef().nativeElement;
    if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) {
      return;
    }
    viewport.setPointerCapture(event.pointerId);
    this.pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    this.panning.set(true);
    event.preventDefault();
  }

  onPointerUp(event: PointerEvent): void {
    this.claimed.delete(event.pointerId);
    if (event.pointerType === 'touch') {
      if (this.tap?.id === event.pointerId) {
        this.onTap(event);
      }
      this.endTouch(event);
      return;
    }
    this.endPan(event);
  }

  onPointerCancel(event: PointerEvent): void {
    this.claimed.delete(event.pointerId);
    if (event.pointerType === 'touch') {
      this.endTouch(event);
      return;
    }
    this.endPan(event);
  }

  endPan(event: PointerEvent): void {
    if (this.pan?.id === event.pointerId) {
      this.pan = null;
      this.panning.set(false);
    }
  }

  onPointer(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      this.onTouchMove(event);
      return;
    }
    if (this.pan?.id === event.pointerId) {
      const viewport = this.viewportRef().nativeElement;
      viewport.scrollLeft = this.pan.left - (event.clientX - this.pan.x);
      viewport.scrollTop = this.pan.top - (event.clientY - this.pan.y);
    }
    this.hover.set(this.framePixelAt(event.clientX, event.clientY));
  }

  /** The frame pixel under a client point, or null off the frame. */
  private framePixelAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const size = this.size();
    const p = this.spaceFromClient(clientX, clientY);
    if (!size || !p) {
      return null;
    }
    const o = this.origin();
    const x = Math.floor(p.x - o.x);
    const y = Math.floor(p.y - o.y);
    return x >= 0 && y >= 0 && x < size.width && y < size.height ? { x, y } : null;
  }

  // Touch: one finger scrolls natively (touch-action), two pinch, a tap probes a pixel, a
  // double tap switches between fit and 100 %.

  private onTouchDown(event: PointerEvent): void {
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.touches.size === 1) {
      this.tap = this.claimed.has(event.pointerId) ? null : { id: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    this.tap = null;
    if (this.touches.size === 2 && this.interactive() && this.content()) {
      this.pinch = { distance: this.touchDistance(), scale: this.scale() };
      this.pinchStarts.update((n) => n + 1);
    }
  }

  private onTouchMove(event: PointerEvent): void {
    if (!this.touches.has(event.pointerId)) {
      return;
    }
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.tap?.id === event.pointerId && Math.hypot(event.clientX - this.tap.x, event.clientY - this.tap.y) > TAP_SLOP) {
      this.tap = null;
    }
    if (this.pinch && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const scale = pinchScale(this.pinch.scale, this.pinch.distance, this.touchDistance());
      this.setScale(scale, { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
    }
  }

  private endTouch(event: PointerEvent): void {
    this.touches.delete(event.pointerId);
    if (this.tap?.id === event.pointerId) {
      this.tap = null;
    }
    if (this.touches.size < 2) {
      this.pinch = null;
    }
  }

  private onTap(event: PointerEvent): void {
    const size = this.content();
    if (!size) {
      return;
    }
    const now = performance.now();
    const last = this.lastTap;
    if (
      this.interactive() &&
      last &&
      now - last.at < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_SLOP
    ) {
      // The first tap of the pair probed; a double tap is about the view, so drop that again.
      this.lastTap = { at: now, x: -Infinity, y: -Infinity };
      this.probe.set(this.probeBefore);
      this.setScale(this.isFit() ? 1 : 'fit', event);
      return;
    }
    this.lastTap = { at: now, x: event.clientX, y: event.clientY };
    this.probeBefore = this.probe();
    const pixel = this.framePixelAt(event.clientX, event.clientY);
    if (pixel) {
      this.probe.set(pixel);
    }
  }

  /** The probe before the last tap, restored when that tap turns out to start a double tap. */
  private probeBefore: { x: number; y: number } | null = null;

  private touchDistance(): number {
    const [a, b] = [...this.touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  // Helpers ------------------------------------------------------------------------------------

  private update(patch: Partial<ViewSettings>): void {
    this.view.update((v) => ({ ...v, ...patch }));
    if (this.interactive()) {
      saveView(this.view(), this.viewKey());
    }
  }

  /**
   * Apply a scale change so that the image point under the anchor stays under it: note where
   * the anchor sits within the stage, change, then scroll the stage back under it once the new
   * size is laid out.
   */
  private keepAnchored(anchor: { clientX: number; clientY: number } | undefined, change: () => void): void {
    const viewport = this.viewportRef().nativeElement;
    const vp = viewport.getBoundingClientRect();
    const at = anchor ?? { clientX: vp.left + vp.width / 2, clientY: vp.top + vp.height / 2 };
    const before = this.stageRef().nativeElement.getBoundingClientRect();
    const fx = before.width > 0 ? (at.clientX - before.left) / before.width : 0.5;
    const fy = before.height > 0 ? (at.clientY - before.top) / before.height : 0.5;
    change();
    afterNextRender(
      () => {
        const after = this.stageRef().nativeElement.getBoundingClientRect();
        viewport.scrollLeft += after.left + fx * after.width - at.clientX;
        viewport.scrollTop += after.top + fy * after.height - at.clientY;
      },
      { injector: this.injector },
    );
  }
}
