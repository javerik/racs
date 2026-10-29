import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  activeLightDirection,
  type Bounds,
  chooseStrides,
  clampStretch,
  cloudBounds,
  type CloudBudget,
  cloudDisplay,
  CloudRenderer,
  type CloudScaling,
  type CloudPick,
  type CloudViewSettings,
  type CrossSection,
  crossSection,
  type Density,
  DENSITY_CHOICES,
  type DisplayRange,
  distance,
  dolly,
  type DrawGrid,
  type DrawLight,
  drawRows,
  eye,
  fit,
  formatUnits,
  type GpuLimits,
  GpuMemoryError,
  gridToWorld,
  isNoStretch,
  isPixelScaling,
  isPaletteId,
  JUMP,
  LIGHT_RANGES,
  lightMatrix,
  type LightSettings,
  type Mat4,
  loadCloudView,
  matchesPreset,
  multiply,
  type Neighbourhood,
  neighbourhoodMedian,
  NO_STRETCH,
  type Orbit,
  paletteGradient,
  paletteLut,
  PALETTES,
  paletteStops,
  pan,
  pickHeightfield,
  pickRay,
  PIXEL_SCALING,
  pointUnits,
  POINT_SIZE,
  presetAngles,
  projectionFor,
  radius,
  type RenderMode,
  rotate,
  type RowRing,
  sanitizeLight,
  saveCloudView,
  screenPoint,
  stepHeight,
  STRETCH,
  type Stretch,
  tokenRgb,
  type Vec3,
  viewMatrix,
  type ViewPreset,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { ThemeService } from '../../services/theme.service';
import { IconComponent } from '../../shared/icon.component';
import { PlotComponent, type PlotLine } from '../shared/plot.component';

/** What one frame drew, for the status line. */
export interface DrawInfo {
  /** Points drawn (invalid ones included, which the GPU skips). */
  drawn: number;
  /** Values held. */
  total: number;
  colStride: number;
  rowStride: number;
}

/** Viewport height on the page, as for the 2D view: at least this, at most `min(maxHeightVh, 560px)`. */
const MIN_HEIGHT = 256;
const MAX_HEIGHT = 560;
/** Movement (px) under which a touch is still a tap, and the double-tap window. */
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;
/** Wheel zoom per pixel of scroll. */
const WHEEL_ZOOM = 0.0015;
/** Arrow keys turn the view by this many drag pixels. */
const KEY_TURN_PX = 11;
const DEG = Math.PI / 180;

/** The light's sliders. */
const LIGHT_CONTROLS: { key: 'intensity' | 'ambient' | 'specular' | 'shininess'; label: string; hint: string }[] = [
  { key: 'intensity', label: 'Diffuse', hint: 'How strongly the light shades the faces it reaches' },
  { key: 'ambient', label: 'Ambient', hint: 'Light everywhere, also in shade and shadow' },
  { key: 'specular', label: 'Gloss', hint: 'Strength of the highlights' },
  { key: 'shininess', label: 'Sharp', hint: 'How tight the highlights are' },
];

const PRESETS: { id: ViewPreset; label: string; key: string; hint: string }[] = [
  { id: 'top', label: 'Top', key: '1', hint: 'From above, like the image (1)' },
  { id: 'front', label: 'Front', key: '2', hint: 'Facing the last profile (2)' },
  { id: 'side', label: 'Side', key: '3', hint: 'Along the profiles, from the first column (3)' },
  { id: 'iso', label: 'Iso', key: '4', hint: 'From above a corner (4)' },
];

/**
 * The measuring tool: one point; or, between two (A and B), their distance, the step height
 * between the faces they lie on, or the cross-section along the segment.
 */
export type MeasureMode = 'point' | 'distance' | 'step' | 'section';

const MEASURE_MODES: { id: MeasureMode; label: string; hint: string }[] = [
  { id: 'point', label: 'Point', hint: 'Click a point to read its x, y and z' },
  { id: 'distance', label: 'Distance', hint: 'Click two points to measure between them' },
  { id: 'step', label: 'Step', hint: 'Click two faces: the height between them, from the median around each' },
  { id: 'section', label: 'Section', hint: 'Click two points: the heights along the line between them' },
];

/** A mode measuring between two points. */
function twoPoint(mode: MeasureMode): boolean {
  return mode !== 'point';
}

/** How far (CSS px) beyond a drawn point's edge a click still picks it in points mode, when nothing drawn is under it. */
const PICK_SLACK_PX = { mouse: 2, touch: 8 };

/** What the view last drew, for picking and for placing the marks. */
interface LastDraw {
  ring: RowRing;
  generation: number;
  mvp: Mat4;
  scale: Vec3;
  offset: Vec3;
  oldestSeq: number;
  filled: number;
  /** A rolling ring not yet full sits this many rows into its box. */
  rowShift: number;
  /** The canvas in CSS px. */
  size: [number, number];
  render: RenderMode;
  /** The drawn point's size in CSS px. */
  pointPx: number;
  /** The surface breaks at value steps larger than this. */
  maxStep: number;
}

/** A pick's mark on screen (CSS px), or `null` where it can't be drawn (behind the eye). */
type Mark = { x: number; y: number } | null;

interface Pointer {
  x: number;
  y: number;
  type: string;
  downAt: number;
  startX: number;
  startY: number;
}

/**
 * The point cloud of a {@link RowRing}, drawn with WebGL2 (see {@link CloudRenderer}), with its
 * tools over it: presets, fit, points or a surface, the colour scale and full screen. The rest of
 * its settings (density, point size, palette, stretch, light) are edited by
 * {@link CloudViewSettingsComponent} in the 3D tab's inspector, through the methods here.
 *
 * Mouse: drag orbits, right/shift/middle drag pans, ctrl+wheel zooms (the plain wheel in full
 * screen), double click fits. Touch: one finger orbits, two pinch and pan, a double tap fits.
 * Keys: 0 fit, 1–4 presets, +/− zoom, arrows orbit, [ ] point size, s points/surface, l light,
 * f full screen, m measure, Esc clears the measured points.
 *
 * The measuring tool picks on the CPU (`pickHeightfield`, in what the view last drew): a still
 * click or tap picks once the double-click window has passed, so a double click still fits.
 *
 * It draws only when asked ({@link requestRender}) or when an input or the view changes; the
 * owner of the ring calls `requestRender()` after writing to it.
 */
@Component({
  selector: 'racs-cloud-view',
  standalone: true,
  imports: [IconComponent, PlotComponent],
  template: `
    <!--
      The cloud, with the cross-section under it while there is one; beside it where the view is
      wide enough for both (desktop only).
    -->
    <div class="measure-body min-h-0 w-full" [class.flex-1]="fullscreen()">
    <!-- A fixed height on the page; in full screen it takes what the rest of the screen leaves. -->
    <div #viewport class="viewport relative min-h-0 min-w-0 outline-none" tabindex="0" aria-label="Point cloud view"
      [class.flex-1]="fullscreen()" [style.height]="fullscreen() ? null : viewportHeight() + 'px'">
      <canvas #canvas class="absolute inset-0 block h-full w-full select-none"
        [class.cursor-grab]="!dragging() && !measuring()" [class.cursor-grabbing]="dragging()"
        [class.cursor-crosshair]="measuring() && !dragging()"></canvas>

      @if (measuring()) {
      <!-- The measured points and the segment between them, placed on every draw. -->
      <svg class="measure-marks pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        @if (measureMode() !== 'step' && segment(); as g) {
        <line class="halo" [attr.x1]="g.a.x" [attr.y1]="g.a.y" [attr.x2]="g.b.x" [attr.y2]="g.b.y" />
        <line class="ink" [attr.x1]="g.a.x" [attr.y1]="g.a.y" [attr.x2]="g.b.x" [attr.y2]="g.b.y" />
        }
        @for (m of marks(); track $index) {
        @if (m) {
        <circle class="halo" [attr.cx]="m.x" [attr.cy]="m.y" r="4" />
        <circle class="ink" [attr.cx]="m.x" [attr.cy]="m.y" r="4" />
        @if (twoPoint(measureMode())) {
        <text class="tag-text font-mono" [attr.x]="m.x + 7" [attr.y]="m.y - 6">{{ $index === 0 ? 'A' : 'B' }}</text>
        }
        }
        }
      </svg>
      }

      @if (!hasPoints() && !error()) {
      <p class="pointer-events-none absolute inset-0 m-0 flex items-center justify-center px-4 text-center font-mono text-xs uppercase tracking-[0.12em] text-faint">
        {{ placeholder() }}
      </p>
      }

      <!-- The view's tools, over the cloud: at its top on desktop, along its bottom on a phone. -->
      <div role="toolbar" aria-label="View"
        class="absolute left-2 top-2 flex max-w-[calc(100%-13rem)] flex-wrap items-center gap-1.5 mobile:inset-x-2 mobile:bottom-2 mobile:top-auto mobile:max-w-none">
        <div class="inline-flex bg-bg/85 mobile:flex-1" role="radiogroup" aria-label="Look from">
          @for (p of presets; track p.id; let first = $first) {
          @let on = preset() === p.id;
          <button type="button" role="radio" class="btn rounded-none mobile:flex-1" [style.margin-left.px]="first ? 0 : -1"
            [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
            [title]="p.hint" (click)="look(p.id)">{{ p.label }}</button>
          }
        </div>
        <span class="inline-flex bg-bg/85">
          <button type="button" class="btn" title="Show the whole cloud (0, double click)" (click)="fitView()">Fit</button>
        </span>
        <div class="inline-flex bg-bg/85 mobile:hidden" role="radiogroup" aria-label="Draw as">
          @for (r of renders; track r.id; let first = $first) {
          @let on = settings().render === r.id;
          <button type="button" role="radio" class="btn rounded-none" [style.margin-left.px]="first ? 0 : -1"
            [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
            [title]="r.hint" (click)="setRender(r.id)">{{ r.label }}</button>
          }
        </div>
        <span class="inline-flex border border-line bg-bg/85">
          <button type="button" class="icon-btn" [class.!border-accent]="measuring()" [class.!text-fg]="measuring()"
            [title]="measuring() ? 'Stop measuring (M)' : 'Measure: click points of the cloud (M)'"
            [attr.aria-label]="measuring() ? 'Stop measuring' : 'Measure'" [attr.aria-pressed]="measuring()"
            (click)="toggleMeasure()">
            <racs-icon name="measure" />
          </button>
        </span>
        @if (measuring()) {
        <div class="inline-flex bg-bg/85" role="radiogroup" aria-label="Measure">
          @for (m of measureModes; track m.id; let first = $first) {
          @let on = measureMode() === m.id;
          <button type="button" role="radio" class="btn rounded-none" [style.margin-left.px]="first ? 0 : -1"
            [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
            [title]="m.hint" (click)="setMeasureMode(m.id)">{{ m.label }}</button>
          }
        </div>
        <span class="inline-flex bg-bg/85">
          <button type="button" class="btn" title="Clear the measured points (Esc)" [disabled]="!picks().length"
            (click)="clearPicks()">Clear</button>
        </span>
        }
      </div>

      <div class="absolute right-2 top-2 flex items-center gap-1.5">
        @if (legend(); as l) {
        <!-- The colour scale: which value each colour stands for. -->
        <span class="pointer-events-none inline-flex h-6 items-center gap-1.5 border border-line bg-bg/85 px-1.5 font-mono text-2xs text-muted"
          [title]="'Colour by z, ' + l.lo + ' to ' + l.hi + ' ' + l.unit">
          <span>{{ l.lo }}</span>
          <span class="block h-2 w-16 rounded mobile:w-12" [style.background]="gradient()"></span>
          <span>{{ l.hi }} {{ l.unit }}</span>
        </span>
        }
        <span class="inline-flex border border-line bg-bg/85">
          <button type="button" class="icon-btn"
            [title]="fullscreen() ? 'Exit full screen (F)' : 'Full screen (F)'"
            [attr.aria-label]="fullscreen() ? 'Exit full screen' : 'Full screen'" [attr.aria-pressed]="fullscreen()"
            (click)="toggleFullscreen()">
            <racs-icon [name]="fullscreen() ? 'fullscreen-exit' : 'fullscreen'" />
          </button>
        </span>
      </div>

      @if (extents(); as e) {
      <span class="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate border border-line bg-bg/85 px-1.5 py-0.5 font-mono text-2xs text-muted mobile:bottom-auto mobile:top-12 mobile:max-w-[calc(100%-1rem)]"
        [title]="e">
        {{ e }}@if (detail(); as d) { · <span class="text-fg">{{ d }}</span>}
      </span>
      }
      @if (measuring()) {
      <!-- The measurement, in the scaling's units. -->
      <div class="measure-readout pointer-events-none absolute bottom-9 left-2 max-w-[calc(100%-1rem)] border border-line bg-bg/85 px-1.5 py-0.5 font-mono text-2xs mobile:bottom-auto mobile:top-[4.5rem]"
        role="status" aria-live="polite">
        @if (readout(); as r) {
        @switch (r.kind) {
        @case ('distance') {
        <span class="text-fg">d {{ r.d }} {{ r.unit }}</span>
        <span class="text-muted"> · Δx {{ r.dx }} · Δy {{ r.dy }} · Δz {{ r.dz }}</span>
        }
        @case ('step') {
        <span class="text-fg">step {{ r.dz }} {{ r.unit }}</span>
        <span class="text-muted"> · A {{ r.za }} · B {{ r.zb }}</span>
        <span class="text-faint"> · {{ r.zLabel }} · median of {{ r.n }}</span>
        }
        @case ('section') {
        <span class="text-fg">section {{ r.length }} {{ r.unit }}</span>
        <span class="text-muted"> · {{ r.samples }} {{ r.samples === 1 ? 'sample' : 'samples' }}</span>
        @if (r.gaps) {<span class="text-faint"> · {{ r.gaps }} {{ r.gaps === 1 ? 'gap' : 'gaps' }}</span>}
        }
        @case ('point') {
        @if (r.label) {<span class="text-faint">{{ r.label }} </span>}
        <span class="text-fg">x {{ r.x }} · y {{ r.y }} · z {{ r.z }} {{ r.unit }}</span>
        <span class="text-faint"> · {{ r.zLabel }}</span>
        @if (r.hint) {<span class="text-faint"> · {{ r.hint }}</span>}
        }
        }
        } @else {
        <span class="text-faint">{{ measureHint() }}</span>
        }
      </div>
      }
      <span class="pointer-events-none absolute bottom-2 right-2 hidden font-mono text-2xs text-faint 2xl:inline mobile:!hidden">
        {{ fullscreen() ? 'drag orbits · right-drag pans · wheel zooms' : 'drag orbits · right-drag pans · ctrl+wheel zooms' }}
      </span>
      @if (error(); as err) {
      <div class="notice-err absolute inset-x-3 top-12">{{ err }}</div>
      }
    </div>
    @if (section(); as x) {
    <!-- The cross-section A–B: z along the segment, gaps where the cloud has no values. -->
    <div class="section-panel flex min-h-0 shrink-0 flex-col border-t border-line bg-surface" aria-label="Cross-section">
      <div class="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
        <span class="label">Section A–B</span>
        <span class="ml-auto truncate font-mono text-2xs text-faint">{{ zLabel() }}</span>
      </div>
      <racs-plot class="min-h-0 flex-1 px-1 pt-1" [lines]="sectionLines()" [xLabel]="'s ' + scaling().unit"
        [yLabel]="'z ' + scaling().unit" placeholder="no values along A–B" />
    </div>
    }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      container-type: inline-size;
    }

    .measure-body {
      display: flex;
      flex-direction: column;
    }

    // In full screen the view's height is fixed: the section takes at most part of it.
    .section-panel {
      height: 12rem;
      max-height: 45%;
    }

    // Beside the cloud where both fit (a wide panel, full screen); a phone keeps it below.
    @container (min-width: 48rem) {
      :host-context([data-layout='desktop']) {
        .measure-body {
          flex-direction: row;
        }

        .viewport {
          flex: 1 1 0%;
        }

        .section-panel {
          width: 20rem;
          height: auto;
          border-top: 0;
          border-left: 1px solid rgb(var(--line));
        }
      }
    }

    :host(:fullscreen) {
      background: rgb(var(--bg));
    }

    // The 2D view's faint measurement grid, showing through the transparent canvas.
    .viewport {
      background-color: rgb(var(--bg));
      background-image:
        linear-gradient(rgb(var(--line)) 1px, transparent 1px),
        linear-gradient(90deg, rgb(var(--line)) 1px, transparent 1px);
      background-size: 32px 32px;
      background-position: -1px -1px;
    }

    .viewport:focus-visible {
      box-shadow: inset 0 0 0 1px rgb(var(--accent));
    }

    // Every touch on the cloud is a gesture; the page scrolls outside it.
    canvas {
      touch-action: none;
    }

    // The marks read on any colour of the cloud: the text colour over a halo of the page's.
    .measure-marks {
      .halo {
        fill: none;
        stroke: rgb(var(--bg) / 0.85);
        stroke-width: 4px;
      }

      .ink {
        fill: none;
        stroke: rgb(var(--fg));
        stroke-width: 1.5px;
      }

      .tag-text {
        fill: rgb(var(--fg));
        paint-order: stroke;
        stroke: rgb(var(--bg) / 0.85);
        stroke-width: 3px;
        font-size: 10px;
      }
    }
  `,
})
export class CloudViewComponent {
  readonly ring = input<RowRing | null>(null);
  /** The ring keeps every n-th profile. */
  readonly storeStride = input(1);
  /** Values drawn dark (`lo`) to bright (`hi`). */
  readonly range = input.required<DisplayRange>();
  /** The values the cloud holds (no invalid ones), for its box; the window until known. */
  readonly zExtent = input<{ min: number; max: number } | null>(null);
  readonly scaling = input<CloudScaling>(PIXEL_SCALING);
  readonly budget = input.required<CloudBudget>();
  readonly placeholder = input('No profiles');
  /** The share of the window height the view may take on the page. */
  readonly maxHeightVh = input(0.7);
  /** Appended to the extents in the corner (points drawn, say). */
  readonly detail = input<string | null>(null);
  /**
   * What full screen shows: the view alone by default, or an element around it (the view with
   * its settings).
   */
  readonly fullscreenTarget = input<HTMLElement | null>(null);
  readonly drawInfo = output<DrawInfo>();
  /**
   * The card refused the ring's store; it holds at most this many bytes now. The owner makes a
   * smaller ring (nothing is drawn until then).
   */
  readonly memoryShort = output<number>();

  readonly presets = PRESETS;
  readonly densities = DENSITY_CHOICES;
  readonly palettes = PALETTES;
  readonly pointSize = POINT_SIZE;
  readonly stretchRange = STRETCH;
  readonly jumpRange = JUMP;
  readonly lightControls = LIGHT_CONTROLS.map((c) => ({ ...c, range: LIGHT_RANGES[c.key] }));
  readonly axes = ['x', 'y', 'z'] as const;
  readonly renders = [
    { id: 'points' as const, label: 'Points', hint: 'A point per value (S)' },
    { id: 'surface' as const, label: 'Surface', hint: 'A surface through the values, broken at large steps (S)' },
  ];
  readonly aspects = [
    { id: 'auto' as const, label: 'Z auto', hint: 'Stretch the heights to a third of the footprint, so a relief shows' },
    { id: 'true' as const, label: 'Z 1:1', hint: 'True proportions in the scaling units' },
  ];

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly themes = inject(ThemeService);
  protected readonly layoutTouch = inject(LayoutService).isMobile;
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  readonly settings = signal<CloudViewSettings>(loadCloudView());
  readonly fullscreen = signal(false);
  /** The preset the view currently looks from, if it does. */
  readonly preset = signal<ViewPreset | null>(null);
  readonly dragging = signal(false);
  readonly hasPoints = signal(false);
  readonly error = signal<string | null>(null);
  /** The z stretch in use. */
  readonly zExag = signal(1);
  readonly noStretch = computed(() => isNoStretch(this.settings().stretch));
  /** Where the view looks from, in whole degrees, for the light dial; only kept while it shows. */
  readonly viewAzimuth = signal<number | null>(null);
  /** The palette as a CSS gradient, for the legend. */
  readonly gradient = signal('');
  /** The measuring tool is on: a still click picks instead of nothing. */
  readonly measuring = signal(false);
  readonly measureMode = signal<MeasureMode>('point');
  readonly measureModes = MEASURE_MODES;
  readonly twoPoint = twoPoint;
  /** The measured points: one, or A and B. */
  readonly picks = signal<CloudPick[]>([]);
  /** Where the picks are on screen, as last drawn. */
  readonly marks = signal<Mark[]>([]);
  /** Each pick's row in the box as last drawn (rolling rows move along y). */
  private readonly pickRows = signal<number[]>([]);
  /** Step: the medians around A and B, as last drawn. */
  private readonly faces = signal<[Neighbourhood | null, Neighbourhood | null] | null>(null);
  /** Section: the values from A to B, as last drawn. */
  readonly section = signal<CrossSection | null>(null);
  readonly sectionLines = computed<PlotLine[]>(() => {
    const x = this.section();
    return x ? [{ id: 'z', label: 'z', color: 'rgb(var(--fg))', xs: x.s, ys: x.z, style: 'data' }] : [];
  });
  /**
   * What z is: the height above the base with the *Laserline* source (its offset puts the base at
   * 0), the scaling's plain z otherwise.
   */
  readonly zLabel = computed(() => {
    const s = this.scaling();
    return s.source === 'laserline' && !isPixelScaling(s) ? 'z above base' : 'raw z';
  });
  readonly segment = computed(() => {
    const [a, b] = this.marks();
    return a && b ? { a, b } : null;
  });
  readonly measureHint = computed(() => {
    const tap = this.layoutTouch() ? 'tap' : 'click';
    return {
      point: `${tap} a point`,
      distance: `${tap} two points`,
      step: `${tap} a point on each face`,
      section: `${tap} the ends of the section`,
    }[this.measureMode()];
  });
  /** The measurement in the scaling's units, formatted. y counts along the box, like the extents. */
  readonly readout = computed(() => {
    const ring = this.ring();
    const picks = this.picks();
    const rows = this.pickRows();
    if (!ring || !picks.length || rows.length !== picks.length) {
      return null;
    }
    const s = this.scaling();
    const stride = this.storeStride();
    const units = picks.map((p, i) => {
      const u = pointUnits({ ...p, k: rows[i] }, s, stride, ring.width);
      // Profiles run toward −y; the readout counts them from the box's start, as the extents do.
      return [u[0], -u[1], u[2]] as Vec3;
    });
    const mode = this.measureMode();
    if (mode === 'step' && units.length === 2) {
      const [fa, fb] = this.faces() ?? [null, null];
      const h = fa && fb ? stepHeight(fa, fb, s) : null;
      return {
        kind: 'step' as const,
        unit: s.unit,
        dz: formatUnits(h?.dz ?? NaN),
        za: formatUnits(h?.za ?? NaN),
        zb: formatUnits(h?.zb ?? NaN),
        n: Math.min(fa?.n ?? 0, fb?.n ?? 0),
        zLabel: this.zLabel(),
      };
    }
    if (mode === 'section' && units.length === 2) {
      const x = this.section();
      let gaps = 0;
      x?.z.forEach((z, i) => {
        if (Number.isNaN(z) && (i === 0 || !Number.isNaN(x.z[i - 1]))) {
          gaps++;
        }
      });
      return {
        kind: 'section' as const,
        unit: s.unit,
        length: formatUnits(x ? x.s[x.s.length - 1] : NaN),
        samples: x?.s.length ?? 0,
        gaps,
      };
    }
    if (mode === 'distance' && units.length === 2) {
      const d = distance(units[0], units[1]);
      return {
        kind: 'distance' as const,
        unit: s.unit,
        d: formatUnits(d.d),
        dx: formatUnits(d.dx),
        dy: formatUnits(d.dy),
        dz: formatUnits(d.dz),
      };
    }
    const u = units[units.length - 1];
    const pair = twoPoint(mode);
    return {
      kind: 'point' as const,
      unit: s.unit,
      label: pair ? 'A' : null,
      hint: pair ? `${this.layoutTouch() ? 'tap' : 'click'} B` : null,
      x: formatUnits(u[0]),
      y: formatUnits(u[1]),
      z: formatUnits(u[2]),
      zLabel: this.zLabel(),
    };
  });
  private readonly windowHeight = signal(typeof window === 'undefined' ? 800 : window.innerHeight);

  readonly viewportHeight = computed(() =>
    Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(this.windowHeight() * this.maxHeightVh()))),
  );

  /** The cloud's extent in units, as the corner readout shows it. */
  readonly extents = computed(() => {
    const ring = this.ring();
    if (!ring || !this.hasPoints()) {
      return null;
    }
    const s = this.scaling();
    const z = this.zExtent() ?? { min: this.range().lo, max: this.range().hi };
    const b = cloudBounds(ring.width, ring.rows, this.storeStride(), s, z.min, z.max);
    const exag = this.zExag();
    const st = this.settings().stretch;
    const stretch =
      (st.x !== 1 ? ` · x ×${formatUnits(st.x)}` : '') +
      (st.y !== 1 ? ` · y ×${formatUnits(st.y)}` : '') +
      (Math.abs(exag - 1) > 1e-9 ? ` · z ×${formatUnits(exag)}` : '');
    return (
      `x 0–${formatUnits(b.max[0])} · y 0–${formatUnits(-b.min[1])} · ` +
      `z ${formatUnits(b.min[2])}–${formatUnits(b.max[2])} ${s.unit}${stretch}`
    );
  });

  /** The display window's ends in units, for the colour scale. */
  readonly legend = computed(() => {
    if (!this.hasPoints()) {
      return null;
    }
    const s = this.scaling();
    const { lo, hi } = this.range();
    return { lo: formatUnits(lo * s.zScale + s.zOffset), hi: formatUnits(hi * s.zScale + s.zOffset), unit: s.unit };
  });

  private renderer: CloudRenderer | null = null;
  private limitsKnown: GpuLimits | null = null;
  private lost = false;
  private orbit: Orbit | null = null;
  /** The box the orbit was fitted to, for depth range and zoom limits. */
  private bounds: Bounds | null = null;
  private needsFit = true;
  /** The last fit knew the values' extent, rather than falling back to the window. */
  private fittedWithExtent = false;
  /** The ring on the card, or `failed` when the card refused its store. */
  private uploaded: { ring: RowRing; generation: number; failed?: boolean } | null = null;
  private frameRequested = false;
  private lastInfo: DrawInfo | null = null;
  private boxColour: [number, number, number] = [0.2, 0.23, 0.26];
  private readonly pointers = new Map<number, Pointer>();
  private pinch: { distance: number; x: number; y: number } | null = null;
  private lastTap: { at: number; x: number; y: number } | null = null;
  /** The current gesture had two pointers at some point (a pinch is never a click). */
  private gestureMulti = false;
  /** A still click waits this long for a second one, which makes it a double click (fit). */
  private pendingPick: { at: number; x: number; y: number; type: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastDraw: LastDraw | null = null;
  /** The ring (and its generation) the picks were made on. */
  private pickedOn: { ring: RowRing; generation: number } | null = null;

  constructor() {
    // A new ring is new geometry: fit to it once it has something to show.
    effect(() => {
      this.ring();
      untracked(() => {
        this.needsFit = true;
        this.requestRender();
      });
    });
    // Anything else drawn from changes the picture, not the view.
    effect(() => {
      this.range();
      this.zExtent();
      this.settings();
      this.budget();
      untracked(() => this.requestRender());
    });
    // A fit made before the first values were analysed sized z by the window: fit again once.
    effect(() => {
      const known = !!this.zExtent();
      untracked(() => {
        if (known && !this.fittedWithExtent && this.orbit) {
          this.fitView();
        }
      });
    });
    // New units or a new store stride move everything: look again from the same side. The live
    // follow of the *Laserline* scaling only nudges the scales, and keeps the view where it is.
    let shown: { scaling: CloudScaling; stride: number } | null = null;
    effect(() => {
      const scaling = this.scaling();
      const stride = this.storeStride();
      untracked(() => {
        if (!shown || shown.stride !== stride || !followUpdate(shown.scaling, scaling)) {
          this.needsFit = true;
        }
        shown = { scaling, stride };
        this.requestRender();
      });
    });

    // The palette's colours come from the tokens; the renderer gets them as a lookup table. The
    // tokens change with the theme, so both are read again then.
    effect(() => {
      const id = this.settings().palette;
      this.themes.theme();
      untracked(() => {
        this.readBoxColour();
        this.applyPalette(id);
      });
    });

    afterNextRender(() => this.init());
  }

  /** The GPU's limits, once known: the ring's layout must fit in them. */
  limits(): GpuLimits | null {
    return this.limitsKnown;
  }

  /** Draw at the next animation frame (once, however often it is asked). */
  requestRender(): void {
    if (this.frameRequested || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    this.frameRequested = true;
    requestAnimationFrame(() => this.frame());
  }

  /** Show the whole cloud from the current direction. */
  fitView(): void {
    this.needsFit = true;
    this.requestRender();
  }

  /** Look from a preset, fitted. */
  look(preset: ViewPreset): void {
    this.updateSettings({ preset });
    this.preset.set(preset);
    this.orbit = this.orbit ? { ...this.orbit, ...presetAngles(preset) } : null;
    this.fitView();
  }

  setZAspect(zAspect: CloudViewSettings['zAspect']): void {
    this.updateSettings({ zAspect });
    this.fitView();
  }

  setRender(render: RenderMode): void {
    this.updateSettings({ render });
  }

  /** One axis's stretch; the view fits again, as the box changed shape. */
  setStretch(axis: keyof Stretch, value: unknown): void {
    this.updateSettings({ stretch: { ...this.settings().stretch, [axis]: clampStretch(value) } });
    this.fitView();
  }

  resetStretch(): void {
    this.updateSettings({ stretch: { ...NO_STRETCH } });
    this.fitView();
  }

  setJump(value: number): void {
    if (Number.isFinite(value)) {
      this.updateSettings({ jump: Math.min(JUMP.max, Math.max(JUMP.min, value)) });
    }
  }

  setLight(patch: Partial<LightSettings>): void {
    this.updateSettings({ light: sanitizeLight({ ...this.settings().light, ...patch }, this.settings().light) });
  }

  setLightValue(key: (typeof LIGHT_CONTROLS)[number]['key'], value: number): void {
    if (Number.isFinite(value)) {
      this.setLight({ [key]: value });
    }
  }

  setPointSize(size: number): void {
    if (Number.isFinite(size)) {
      this.updateSettings({ pointSize: Math.min(POINT_SIZE.max, Math.max(POINT_SIZE.min, size)) });
    }
  }

  setDensity(value: string): void {
    const density = (value === 'auto' ? 'auto' : Number(value)) as Density;
    if (DENSITY_CHOICES.includes(density)) {
      this.updateSettings({ density });
    }
  }

  setPalette(value: string): void {
    if (isPaletteId(value)) {
      this.updateSettings({ palette: value });
    }
  }

  toggleFullscreen(): void {
    const target = this.fullscreenTarget() ?? this.host.nativeElement;
    if (document.fullscreenElement === target) {
      void document.exitFullscreen();
    } else {
      void target.requestFullscreen?.().then(() => this.viewportRef().nativeElement.focus());
    }
  }

  /** The measuring tool on or off; off forgets the points. */
  toggleMeasure(): void {
    const on = !this.measuring();
    this.measuring.set(on);
    if (!on) {
      this.clearPicks();
    }
  }

  setMeasureMode(mode: MeasureMode): void {
    const was = this.measureMode();
    if (mode === was) {
      return;
    }
    this.measureMode.set(mode);
    // A single point keeps the last one, and a pair starts from it; a pair keeps both into another.
    this.setPicks(twoPoint(mode) && twoPoint(was) ? this.picks() : this.picks().slice(-1));
  }

  clearPicks(): void {
    this.cancelPendingPick();
    this.setPicks([]);
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.fullscreen.set(document.fullscreenElement === (this.fullscreenTarget() ?? this.host.nativeElement));
    this.requestRender();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.windowHeight.set(window.innerHeight);
  }

  // Setup --------------------------------------------------------------------------------------

  private init(): void {
    const canvas = this.canvasRef().nativeElement;
    this.readBoxColour();
    try {
      this.renderer = CloudRenderer.create(canvas);
    } catch (e) {
      this.error.set((e as Error).message);
    }
    if (!this.renderer) {
      this.error.set(this.error() ?? 'This browser has no WebGL2, which the 3D view needs');
      return;
    }
    this.limitsKnown = this.renderer.limits;
    this.applyPalette(this.settings().palette);

    const onLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.error.set('The graphics context was lost; waiting for it to come back');
    };
    const onRestored = () => {
      this.lost = false;
      this.error.set(null);
      this.renderer?.restore();
      this.uploaded = null;
      this.requestRender();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    // Gestures go straight to the view, without change detection on every move.
    const viewport = this.viewportRef().nativeElement;
    const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
      [canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent)],
      [canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent)],
      [canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent)],
      [canvas, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent, true)],
      [
        canvas,
        'dblclick',
        () => {
          this.cancelPendingPick();
          this.fitView();
        },
      ],
      [canvas, 'contextmenu', (e) => e.preventDefault()],
      [canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false }],
      [viewport, 'keydown', (e) => this.onKey(e as KeyboardEvent)],
    ];
    for (const [target, type, fn, opts] of listeners) {
      target.addEventListener(type, fn, opts);
    }
    const resize = new ResizeObserver(() => this.requestRender());
    resize.observe(viewport);

    this.destroyRef.onDestroy(() => {
      this.cancelPendingPick();
      resize.disconnect();
      for (const [target, type, fn] of listeners) {
        target.removeEventListener(type, fn);
      }
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      this.renderer?.dispose();
      this.renderer = null;
    });
    this.requestRender();
  }

  // Drawing ------------------------------------------------------------------------------------

  private frame(): void {
    this.frameRequested = false;
    const renderer = this.renderer;
    if (!renderer || this.lost) {
      return;
    }
    const canvas = this.canvasRef().nativeElement;
    const dpr = Math.min(window.devicePixelRatio || 1, this.budget().maxDpr);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ring = this.ring();
    this.setHasPoints(!!ring && ring.filled > 0);
    if (!ring) {
      this.lastDraw = null;
      this.setPicks([]);
      if (this.uploaded) {
        renderer.release();
        this.uploaded = null;
      }
      renderer.clear(width, height);
      return;
    }

    try {
      if (this.uploaded?.ring !== ring || this.uploaded.generation !== ring.generation) {
        renderer.allocate(ring.layout);
        ring.takeDirty();
        renderer.upload(ring.allSegments(), ring.mirror, ring.width);
        this.uploaded = { ring, generation: ring.generation };
      } else {
        renderer.upload(ring.takeDirty(), ring.mirror, ring.width);
      }
    } catch (e) {
      if (e instanceof GpuMemoryError) {
        // Not again for this ring: the owner replaces it.
        this.uploaded = { ring, generation: ring.generation, failed: true };
        this.memoryShort.emit(e.maxBytes);
      } else {
        this.error.set((e as Error).message);
      }
      return;
    }
    if (this.uploaded.failed) {
      renderer.clear(width, height);
      return;
    }

    const s = this.scaling();
    const stride = this.storeStride();
    const z = this.zExtent() ?? { min: this.range().lo, max: this.range().hi };
    const aspect = width / height;
    const settings = this.settings();
    const rowShift = ring.mode === 'rolling' ? ring.rows - ring.filled : 0;
    const st = settings.stretch;
    const zAspect = settings.zAspect === 'true' ? 1 : 'auto';
    const d = cloudDisplay(ring.width, ring.rows, stride, s, z.min, z.max, zAspect, rowShift, [st.x, st.y, st.z]);
    if (Math.abs(d.exag - this.zExag()) > 1e-9 * Math.abs(d.exag)) {
      this.zExag.set(d.exag);
    }
    if (this.needsFit && ring.filled > 0) {
      this.needsFit = false;
      this.fittedWithExtent = !!this.zExtent();
      const angles = this.orbit ? { yaw: this.orbit.yaw, pitch: this.orbit.pitch } : presetAngles(settings.preset);
      this.bounds = d.box;
      this.setOrbit(fit(d.box, aspect, angles));
    }
    const orbit = this.orbit ?? fit(d.box, aspect, presetAngles(settings.preset));

    const budget = this.budget();
    // A quad is two triangles: the surface draws within the triangle budget.
    const surfaceQuads = budget.maxTriangles / 2;
    const density = settings.density;
    const autoMax = settings.render === 'surface' ? surfaceQuads : budget.maxPoints;
    const strides = density === 'auto' ? chooseStrides(ring.width, ring.rows, autoMax) : { col: density, row: density };
    const grid = gridFor(ring, strides);
    const [minSize, maxSize] = renderer.limits.pointSize;
    const mvp = multiply(projectionFor(orbit, aspect, union(d.box, this.bounds)), viewMatrix(orbit));

    let light: DrawLight | null = null;
    if (settings.light.enabled) {
      const l = settings.light;
      const dir = activeLightDirection(l, orbit);
      // The surface casts, also under points; at its own budget there.
      const casters = settings.render === 'surface' ? grid : gridFor(ring, chooseStrides(ring.width, ring.rows, surfaceQuads));
      light = {
        dir,
        intensity: l.intensity,
        ambient: l.ambient,
        specular: l.specular,
        shininess: l.shininess,
        shadow: l.shadows
          ? { mvp: lightMatrix(d.box, dir), size: Math.min(budget.shadowSize, renderer.limits.maxTextureSize), grid: casters }
          : null,
      };
    }

    renderer.draw(width, height, {
      layout: ring.layout,
      oldestSlot: ring.oldestSlot(),
      width: ring.width,
      filled: ring.filled,
      mode: settings.render,
      grid,
      mvp,
      eye: eye(orbit),
      scale: d.scale,
      offset: d.offset,
      window: [this.range().lo, this.range().hi],
      pointSize: Math.min(maxSize, Math.max(minSize, settings.pointSize * dpr)),
      jump: settings.jump,
      light,
      box: ring.filled > 0 ? d.box : null,
      boxColor: this.boxColour,
    });

    this.lastDraw = {
      ring,
      generation: ring.generation,
      mvp,
      scale: d.scale,
      offset: d.offset,
      oldestSeq: ring.oldestSeq(),
      filled: ring.filled,
      rowShift,
      size: [canvas.clientWidth, canvas.clientHeight],
      render: settings.render,
      pointPx: Math.min(maxSize, Math.max(minSize, settings.pointSize * dpr)) / dpr,
      maxStep: settings.jump * Math.max(this.range().hi - this.range().lo, 1),
    };
    this.placeMarks();

    const info: DrawInfo = {
      drawn: grid.cols * grid.count,
      total: ring.width * ring.filled,
      colStride: strides.col,
      rowStride: strides.row,
    };
    const last = this.lastInfo;
    if (!last || last.drawn !== info.drawn || last.total !== info.total || last.colStride !== info.colStride || last.rowStride !== info.rowStride) {
      this.lastInfo = info;
      this.drawInfo.emit(info);
    }
  }

  private setHasPoints(has: boolean): void {
    if (this.hasPoints() !== has) {
      this.hasPoints.set(has);
    }
  }

  private setOrbit(o: Orbit): void {
    this.orbit = o;
    const preset = matchesPreset(o);
    if (this.preset() !== preset) {
      this.preset.set(preset);
    }
    this.syncViewAzimuth();
    this.requestRender();
  }

  /** The light dial's view tick follows the orbit, in whole degrees. */
  private syncViewAzimuth(): void {
    const az = this.orbit ? Math.round(this.orbit.yaw / DEG) : null;
    if (this.viewAzimuth() !== az) {
      this.viewAzimuth.set(az);
    }
  }

  private readBoxColour(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const style = getComputedStyle(document.documentElement);
    this.boxColour = tokenRgb(style.getPropertyValue('--line-strong'), this.boxColour);
  }

  private applyPalette(id: CloudViewSettings['palette']): void {
    if (typeof document === 'undefined') {
      return;
    }
    const style = getComputedStyle(document.documentElement);
    const stops = paletteStops(id, (name) => style.getPropertyValue(name));
    this.gradient.set(paletteGradient(stops));
    this.renderer?.setPalette(paletteLut(stops));
    this.requestRender();
  }

  private updateSettings(patch: Partial<CloudViewSettings>): void {
    const next = { ...this.settings(), ...patch };
    this.settings.set(next);
    saveCloudView(next);
  }

  // Measuring ----------------------------------------------------------------------------------

  private setPicks(picks: CloudPick[]): void {
    if (picks.length === 0 && this.picks().length === 0) {
      return;
    }
    this.picks.set(picks);
    this.pickedOn = picks.length && this.lastDraw ? { ring: this.lastDraw.ring, generation: this.lastDraw.generation } : null;
    this.placeMarks();
  }

  /**
   * Put the marks where the last draw shows the picks. A pick goes once its profile has left the
   * ring; all of them go with a new ring or a cleared one.
   */
  private placeMarks(): void {
    const ld = this.lastDraw;
    let picks = this.picks();
    if (picks.length && (!ld || !this.pickedOn || this.pickedOn.ring !== ld.ring || this.pickedOn.generation !== ld.generation)) {
      picks = [];
    } else if (ld) {
      picks = picks.filter((p) => Math.floor(p.seq) >= ld.oldestSeq && p.seq - ld.oldestSeq <= ld.filled - 1);
    }
    if (picks.length !== this.picks().length) {
      this.picks.set(picks);
      if (!picks.length) {
        this.pickedOn = null;
      }
    }
    const marks: Mark[] = [];
    const rows: number[] = [];
    for (const p of picks) {
      const k = p.seq - ld!.oldestSeq;
      rows.push(k + ld!.rowShift);
      const at = screenPoint(ld!.mvp, gridToWorld(ld!, p.column, k, p.value), ld!.size);
      marks.push(at ? { x: at.x, y: at.y } : null);
    }
    const old = this.marks();
    const moved =
      old.length !== marks.length ||
      marks.some((m, i) => {
        const o = old[i];
        return !m || !o ? m !== o : Math.abs(m.x - o.x) > 0.25 || Math.abs(m.y - o.y) > 0.25;
      });
    if (moved) {
      this.marks.set(marks);
    }
    const oldRows = this.pickRows();
    if (oldRows.length !== rows.length || rows.some((r, i) => r !== oldRows[i])) {
      this.pickRows.set(rows);
    }
    this.measureBetween(picks);
  }

  /**
   * The step's medians and the section between A and B, in what the view last drew. A snapshot
   * still filling can change the values under the picks, so this runs on every draw; the signals
   * only change with the numbers, so the readout and the plot don't follow the frame rate.
   */
  private measureBetween(picks: CloudPick[]): void {
    const ld = this.lastDraw;
    const mode = this.measureMode();
    const pair = ld && picks.length === 2 ? ([picks[0], picks[1]] as const) : null;
    const faces: [Neighbourhood | null, Neighbourhood | null] | null =
      pair && mode === 'step' ? [neighbourhoodMedian(ld!.ring, pair[0]), neighbourhoodMedian(ld!.ring, pair[1])] : null;
    const old = this.faces();
    const same = (a: Neighbourhood | null, b: Neighbourhood | null) => a?.value === b?.value && a?.n === b?.n;
    if (!faces || !old ? faces !== old : !same(faces[0], old[0]) || !same(faces[1], old[1])) {
      this.faces.set(faces);
    }
    const section = pair && mode === 'section' ? crossSection(ld!.ring, pair[0], pair[1], this.scaling(), this.storeStride()) : null;
    if (!sameSection(section, this.section())) {
      this.section.set(section);
    }
  }

  /** A still click or tap: pick after the double-click window, unless a second one fits instead. */
  private onStillUp(e: PointerEvent): void {
    const now = performance.now();
    const pending = this.pendingPick;
    if (pending && now - pending.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DOUBLE_TAP_SLOP) {
      // The second of a double click or tap, which fits (`dblclick`, or the tap logic).
      this.cancelPendingPick();
      return;
    }
    this.cancelPendingPick();
    const at = { at: now, x: e.clientX, y: e.clientY, type: e.pointerType };
    this.pendingPick = {
      ...at,
      timer: setTimeout(() => {
        this.pendingPick = null;
        this.pickAt(at.x, at.y, at.type);
      }, DOUBLE_TAP_MS),
    };
  }

  private cancelPendingPick(): void {
    if (this.pendingPick) {
      clearTimeout(this.pendingPick.timer);
      this.pendingPick = null;
    }
  }

  /** Pick the cloud under the client point, in what the view last drew. */
  private pickAt(clientX: number, clientY: number, pointerType: string): void {
    const ld = this.lastDraw;
    if (!ld || !this.measuring()) {
      return;
    }
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return;
    }
    const ndc: [number, number] = [((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2];
    const ray = pickRay(ld.mvp, ndc);
    if (!ray) {
      return;
    }
    // Points mode: what is drawn under the pointer first; a point a little beside it only when
    // nothing is (a wider reach on a dense cloud would take the frontmost of many points).
    const pick = (reachPx: number | null) =>
      pickHeightfield(ray, ld.ring, ld, {
        maxStep: ld.maxStep,
        points:
          reachPx === null ? undefined : { mvp: ld.mvp, ndc, radius: [(2 * reachPx) / rect.width, (2 * reachPx) / rect.height] },
      });
    const points = ld.render === 'points';
    const slack = pointerType === 'mouse' ? PICK_SLACK_PX.mouse : PICK_SLACK_PX.touch;
    const hit = points ? pick(ld.pointPx / 2) ?? pick(ld.pointPx / 2 + slack) : pick(null);
    if (!hit) {
      return;
    }
    const picks = this.picks();
    this.setPicks(!twoPoint(this.measureMode()) || picks.length >= 2 ? [hit] : [...picks, hit]);
  }

  // Gestures -----------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const canvas = this.canvasRef().nativeElement;
    canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
      downAt: performance.now(),
      startX: e.clientX,
      startY: e.clientY,
    });
    if (this.pointers.size === 1) {
      this.gestureMulti = false;
    }
    if (this.pointers.size === 2) {
      this.pinch = this.pinchState();
      this.gestureMulti = true;
      this.cancelPendingPick();
    }
    this.dragging.set(true);
    // A clicked view takes the keys; a touched one has none to take.
    if (e.pointerType === 'mouse') {
      this.viewportRef().nativeElement.focus({ preventScroll: true });
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.orbit) {
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.pointers.size >= 2) {
      const next = this.pinchState();
      if (this.pinch && next) {
        let o = dolly(this.orbit, this.pinch.distance / Math.max(1, next.distance), ...this.zoomLimits());
        o = pan(o, next.x - this.pinch.x, next.y - this.pinch.y, this.canvasRef().nativeElement.clientHeight);
        this.setOrbit(o);
      }
      this.pinch = next;
      return;
    }
    const panning = p.type === 'mouse' && ((e.buttons & 2) !== 0 || (e.buttons & 4) !== 0 || e.shiftKey);
    this.setOrbit(panning ? pan(this.orbit, dx, dy, this.canvasRef().nativeElement.clientHeight) : rotate(this.orbit, dx, dy));
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;
    if (this.pointers.size === 0) {
      this.dragging.set(false);
    }
    // A still click or tap measures while the tool is on.
    const still = !!p && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < TAP_SLOP;
    if (!cancelled && p && still && this.measuring() && !this.gestureMulti && this.pointers.size === 0 && (p.type !== 'mouse' || e.button === 0)) {
      this.onStillUp(e);
    }
    // A double tap fits, as a double click does.
    if (!cancelled && p && p.type !== 'mouse' && this.pointers.size === 0) {
      const now = performance.now();
      if (still && now - p.downAt < DOUBLE_TAP_MS) {
        const last = this.lastTap;
        if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_SLOP) {
          this.lastTap = null;
          this.fitView();
        } else {
          this.lastTap = { at: now, x: e.clientX, y: e.clientY };
        }
      }
    }
  }

  private pinchState(): { distance: number; x: number; y: number } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) {
      return null;
    }
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** Ctrl/⌘+wheel zooms, as in the 2D view; in full screen the plain wheel does. */
  private onWheel(e: WheelEvent): void {
    if (!this.orbit || !(e.ctrlKey || e.metaKey || this.fullscreen())) {
      return;
    }
    e.preventDefault();
    const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    this.setOrbit(dolly(this.orbit, Math.exp(px * WHEEL_ZOOM), ...this.zoomLimits()));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const o = this.orbit;
    const preset = PRESETS.find((p) => p.key === e.key);
    if (preset) {
      this.look(preset.id);
    } else if (e.key === '0') {
      this.fitView();
    } else if (e.key === 'f' || e.key === 'F') {
      this.toggleFullscreen();
    } else if (e.key === 'm' || e.key === 'M') {
      this.toggleMeasure();
    } else if (e.key === 'Escape' && this.picks().length) {
      this.clearPicks();
    } else if (e.key === 's' || e.key === 'S') {
      this.setRender(this.settings().render === 'surface' ? 'points' : 'surface');
    } else if (e.key === 'l' || e.key === 'L') {
      this.setLight({ enabled: !this.settings().light.enabled });
    } else if (e.key === '[' || e.key === ']') {
      this.setPointSize(this.settings().pointSize + (e.key === ']' ? POINT_SIZE.step : -POINT_SIZE.step));
    } else if (o && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
      this.setOrbit(dolly(o, e.key === '+' || e.key === '=' ? 0.8 : 1.25, ...this.zoomLimits()));
    } else if (o && e.key.startsWith('Arrow')) {
      const turn = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!turn) {
        return;
      }
      this.setOrbit(rotate(o, turn[0] * KEY_TURN_PX, turn[1] * KEY_TURN_PX));
    } else {
      return;
    }
    e.preventDefault();
  }

  private zoomLimits(): [number, number] {
    const r = this.bounds ? radius(this.bounds) : this.orbit?.distance ?? 1;
    return [Math.max(r * 0.01, 1e-6), r * 50];
  }
}

/** The held values a pass draws at `strides`: rows sampled by global seq (see `drawRows`). */
function gridFor(ring: RowRing, strides: { col: number; row: number }): DrawGrid {
  const rows = drawRows(ring.oldestSeq(), ring.filled, strides.row);
  return {
    cols: Math.ceil(ring.width / strides.col),
    colStride: strides.col,
    rowStride: strides.row,
    kStart: rows.kStart,
    count: rows.count,
  };
}

/** The box holding both, for a depth range that covers the cloud and where the view was fitted. */
function union(a: Bounds, b: Bounds | null): Bounds {
  if (!b) {
    return a;
  }
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** The same samples (NaN equal to NaN), or both absent. */
function sameSection(a: CrossSection | null, b: CrossSection | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  if (a.s.length !== b.s.length) {
    return false;
  }
  for (let i = 0; i < a.s.length; i++) {
    if (!Object.is(a.s[i], b.s[i]) || !Object.is(a.z[i], b.z[i])) {
      return false;
    }
  }
  return true;
}

/** A follow update scales an axis by at most this factor; more refits the view. */
const FOLLOW_KEEPS_VIEW = 1.25;

/** `next` is the *Laserline* live follow nudging `prev`: same unit and mirror, every scale within `FOLLOW_KEEPS_VIEW`. */
function followUpdate(prev: CloudScaling, next: CloudScaling): boolean {
  const near = (a: number, b: number) => a !== 0 && b / a > 0 && Math.max(b / a, a / b) <= FOLLOW_KEEPS_VIEW;
  return (
    prev.source === 'laserline' &&
    next.source === 'laserline' &&
    prev.unit === next.unit &&
    !!prev.mirrorX === !!next.mirrorX &&
    near(prev.xPitch, next.xPitch) &&
    near(prev.ySpacing, next.ySpacing) &&
    near(prev.zScale, next.zScale)
  );
}
