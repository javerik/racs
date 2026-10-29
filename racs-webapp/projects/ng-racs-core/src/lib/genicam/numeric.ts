/**
 * Pure helpers for presenting numeric GenICam features: slider mapping, snapping to the device's
 * increment, and value formatting by representation.
 */

/** Bounds beyond this lose precision as JS numbers (e.g. an Integer max of i64::MAX). */
const SAFE = Number.MAX_SAFE_INTEGER;

/** Positions of a slider; fine enough for a smooth drag, coarse enough to stay cheap. */
export const SLIDER_STEPS = 1000;

export interface NumericRange {
  min: number;
  max: number;
  /** `null` when the device declares no increment. */
  inc: number | null;
  log: boolean;
  integer: boolean;
}

export function isUsableBound(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SAFE;
}

/**
 * The slider range for a feature, or `null` when it has no usable pair of bounds (then only a
 * text field makes sense). A log scale is used when the device asks for one, or when the range
 * spans three or more decades from a positive minimum (exposure times: 0.01 µs to 1 s).
 */
export function sliderRange(
  min: number | null,
  max: number | null,
  inc: number | null,
  representation: string | null,
  integer: boolean,
): NumericRange | null {
  if (!isUsableBound(min) || !isUsableBound(max) || max <= min) {
    return null;
  }
  const usableInc = isUsableBound(inc) && inc > 0 ? inc : null;
  const wide = min > 0 && max / min >= 1000;
  const log = (representation === 'Logarithmic' && min > 0) || wide;
  return { min, max, inc: usableInc, log, integer };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Decimal places of `step`, so snapped floats print as the device would (0.1 + 0.2 ≠ 0.3). */
function decimals(step: number): number {
  const text = String(step);
  if (text.includes('e-')) {
    return Number(text.split('e-')[1]);
  }
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** `v` moved onto the grid `min + k * inc` and into `[min, max]`; integers round anyway. */
export function snap(v: number, range: Pick<NumericRange, 'min' | 'max' | 'inc' | 'integer'>): number {
  let out = clamp(v, range.min, range.max);
  if (range.inc) {
    const k = Math.round((out - range.min) / range.inc);
    out = range.min + k * range.inc;
    // Back inside after rounding (max need not sit on the grid).
    if (out > range.max) {
      out -= range.inc;
    }
    out = Number(out.toFixed(decimals(range.inc) + decimals(range.min)));
  }
  if (range.integer) {
    out = Math.round(out);
  }
  return out;
}

/** Slider position `0..SLIDER_STEPS` for value `v`. */
export function toSlider(v: number, range: NumericRange): number {
  const c = clamp(v, range.min, range.max);
  const t = range.log
    ? Math.log(c / range.min) / Math.log(range.max / range.min)
    : (c - range.min) / (range.max - range.min);
  return Math.round(t * SLIDER_STEPS);
}

/** The snapped value at slider position `pos`. */
export function fromSlider(pos: number, range: NumericRange): number {
  const t = clamp(pos, 0, SLIDER_STEPS) / SLIDER_STEPS;
  const raw = range.log
    ? range.min * Math.pow(range.max / range.min, t)
    : range.min + t * (range.max - range.min);
  return snap(raw, range);
}

/**
 * A raw feature value as text for display: integers by their GenICam representation (an IP
 * address, a MAC, hex), floats trimmed to a sensible precision. Unparseable input comes back
 * unchanged.
 */
export function formatValue(raw: string, representation: string | null, unit: string | null): string {
  const n = Number(raw);
  let text = raw;
  if (raw.trim() !== '' && Number.isFinite(n)) {
    switch (representation) {
      case 'IPV4Address':
        text = [24, 16, 8, 0].map((s) => (Math.floor(n / 2 ** s) & 0xff).toString()).join('.');
        break;
      case 'MACAddress':
        text = n
          .toString(16)
          .padStart(12, '0')
          .match(/../g)!
          .join(':')
          .toUpperCase();
        break;
      case 'HexNumber':
        text = '0x' + n.toString(16).toUpperCase();
        break;
      default:
        text = Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6)));
    }
  }
  return unit ? `${text} ${unit}` : text;
}

/** Most range chips a wide-range control offers; the lowest decades are merged beyond that. */
const MAX_WINDOWS = 6;

export interface RangeWindow {
  lo: number;
  hi: number;
}

/**
 * A wide range split into decades (1–10 ms, 10–100 ms, …), clipped to `[min, max]`. Ten decades
 * on one slider leave each a few pixels wide; picking a decade first gives the slider a range a
 * hand can work with. Rarely used low decades (an AT C6 starts its exposure at 10 ns) are merged
 * so at most six remain.
 */
export function decadeWindows(min: number, max: number): RangeWindow[] {
  if (!(min > 0) || !(max > min)) {
    return [{ lo: min, hi: max }];
  }
  const edges = [min];
  for (let e = Math.floor(Math.log10(min)) + 1; 10 ** e < max; e++) {
    edges.push(Number((10 ** e).toPrecision(12)));
  }
  edges.push(max);
  let windows = edges.slice(1).map((hi, i) => ({ lo: edges[i], hi }));
  if (windows.length > MAX_WINDOWS) {
    const merged = windows.length - MAX_WINDOWS + 1;
    windows = [{ lo: windows[0].lo, hi: windows[merged - 1].hi }, ...windows.slice(merged)];
  }
  return windows;
}

/** The window holding `v` (a value on a boundary belongs to the lower one). */
export function windowIndex(v: number, windows: RangeWindow[]): number {
  const i = windows.findIndex((w) => v <= w.hi);
  return i === -1 ? windows.length - 1 : i;
}

const DURATION_UNITS: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1 };

export function isDurationUnit(unit: string | null): boolean {
  return !!unit && unit in DURATION_UNITS;
}

/** Durations read best at 3 significant digits; other numbers keep up to 6 (a width of 2048). */
const trim = (x: number) => String(Number(x.toPrecision(3)));
const plain = (x: number) => String(Number(x.toPrecision(6)));

/** For a duration: the readable unit for `v` and the factor from `unit` into it. */
function durationScale(v: number, unit: string): { factor: number; suffix: string } {
  const seconds = Math.abs(v * DURATION_UNITS[unit]);
  const [suffix, perSecond] =
    seconds >= 1 ? ['s', 1] : seconds >= 1e-3 ? ['ms', 1e3] : seconds >= 1e-6 ? ['µs', 1e6] : ['ns', 1e9];
  return { factor: DURATION_UNITS[unit] * perSecond, suffix };
}

/**
 * `v` in `unit` as people read it: durations scaled to ns/µs/ms/s ("67.9 ms" rather than
 * "67920.36 us"), everything else as a trimmed number with its unit.
 */
export function formatQuantity(v: number, unit: string | null): string {
  if (!isDurationUnit(unit)) {
    return unit ? `${plain(v)} ${unit}` : plain(v);
  }
  const { factor, suffix } = durationScale(v, unit!);
  return `${trim(v * factor)} ${suffix}`;
}

/** A range label in the upper bound's unit: "0.1–1 ms" rather than "100 µs–1 ms". */
export function formatSpan(lo: number, hi: number, unit: string | null): string {
  if (!isDurationUnit(unit)) {
    return `${plain(lo)}–${plain(hi)}${unit ? ' ' + unit : ''}`;
  }
  const { factor, suffix } = durationScale(hi, unit!);
  return `${trim(lo * factor)}–${trim(hi * factor)} ${suffix}`;
}
