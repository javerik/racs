/**
 * Height palettes for the point cloud: sequential ramps, trimmed per theme so every stop stays
 * visible on the surface. The colours are tokens in `styles.scss` (`--ramp-<id>-1..9`; grey is
 * `--faint` → `--fg`), read at run time, and again when the theme changes; here they become the
 * shader's lookup table and the legend's gradient.
 */

import type { Vec3 } from './mat4';

export type PaletteId = 'grey' | 'viridis' | 'cividis' | 'magma';

export const PALETTES: readonly { id: PaletteId; label: string; hint: string }[] = [
  { id: 'grey', label: 'Grey', hint: 'Dim to bright, like the 2D view' },
  { id: 'viridis', label: 'Viridis', hint: 'Violet through green to yellow; readable with colour vision deficiency' },
  { id: 'cividis', label: 'Cividis', hint: 'Blue to yellow, made for colour vision deficiency' },
  { id: 'magma', label: 'Magma', hint: 'Purple through orange to pale yellow' },
];

/** Stops per ramp token set. */
export const RAMP_STOPS = 9;
/** Entries in the shader's lookup table. */
export const LUT_SIZE = 256;

const MISSING: Vec3 = [NaN, NaN, NaN];

export function isPaletteId(v: unknown): v is PaletteId {
  return PALETTES.some((p) => p.id === v);
}

/**
 * A palette's stops, low to high, from the colour tokens; `read` returns a custom property's value
 * (`getComputedStyle(root).getPropertyValue`). A palette whose tokens are missing falls back to
 * grey, and grey to its token values.
 */
export function paletteStops(id: PaletteId, read: (name: string) => string): Vec3[] {
  const names =
    id === 'grey' ? ['--faint', '--fg'] : Array.from({ length: RAMP_STOPS }, (_, i) => `--ramp-${id}-${i + 1}`);
  const stops = names.map((name) => tokenRgb(read(name), MISSING));
  if (stops.every((s) => s.every(Number.isFinite))) {
    return stops;
  }
  return id === 'grey'
    ? [
        [90 / 255, 97 / 255, 105 / 255],
        [228 / 255, 231 / 255, 234 / 255],
      ]
    : paletteStops('grey', read);
}

/** The colour at `t` (0..1) along the stops, linearly between neighbours. */
export function sampleStops(stops: readonly Vec3[], t: number): Vec3 {
  const pos = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  if (i < 0) {
    return stops[0];
  }
  const f = pos - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** `size` RGBA8 entries spread evenly along the stops: entry 0 is the lowest value, the last the highest. */
export function paletteLut(stops: readonly Vec3[], size = LUT_SIZE): Uint8Array {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const c = sampleStops(stops, size > 1 ? i / (size - 1) : 0);
    out[i * 4] = Math.round(c[0] * 255);
    out[i * 4 + 1] = Math.round(c[1] * 255);
    out[i * 4 + 2] = Math.round(c[2] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The stops as a CSS gradient, low on the left: the legend's colour bar. */
export function paletteGradient(stops: readonly Vec3[]): string {
  const at = (i: number) => (stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0);
  const parts = stops.map(
    (c, i) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)}) ${at(i).toFixed(1)}%`,
  );
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** A colour token's value (`"228 231 234"`) as 0..1 channels for a shader. */
export function tokenRgb(css: string, fallback: Vec3 = [1, 1, 1]): Vec3 {
  const parts = css.trim().split(/[\s,/]+/).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) {
    return fallback;
  }
  return parts.map((p) => Math.min(1, Math.max(0, p / 255))) as Vec3;
}
