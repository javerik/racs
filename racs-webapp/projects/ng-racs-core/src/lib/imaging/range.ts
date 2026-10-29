/**
 * The displayed value range ("window"): which pixel values map to black and white.
 */

import { maxValue, type FrameStats } from './frame';

/**
 * - `full`: the whole range the bit depth allows.
 * - `manual`: a fixed `lo..hi`, e.g. 20↔50 LSB.
 * - `auto`: the current image's min..max.
 */
export type RangeMode = 'full' | 'manual' | 'auto';

export interface RangeSettings {
  mode: RangeMode;
  /** Used in `manual` mode, in LSB of the frame's bit depth. */
  lo: number;
  hi: number;
}

/** A resolved window: `lo` renders black, `hi` white. Always `lo < hi`. */
export interface DisplayRange {
  lo: number;
  hi: number;
}

export function defaultRangeSettings(bitDepth: number): RangeSettings {
  return { mode: 'full', lo: 0, hi: maxValue(bitDepth) };
}

export function resolveRange(
  settings: RangeSettings,
  bitDepth: number,
  stats: FrameStats | null,
): DisplayRange {
  const top = maxValue(bitDepth);
  switch (settings.mode) {
    case 'manual':
      return ordered(settings.lo, settings.hi, top);
    case 'auto':
      return stats ? ordered(stats.min, stats.max, top) : { lo: 0, hi: top };
    default:
      return { lo: 0, hi: top };
  }
}

/** Clamp both ends into `0..top` and keep them at least 1 LSB apart. */
function ordered(lo: number, hi: number, top: number): DisplayRange {
  let a = clamp(Math.round(lo), 0, top);
  let b = clamp(Math.round(hi), 0, top);
  if (a > b) {
    [a, b] = [b, a];
  }
  if (a === b) {
    // A flat image (or a zero-width manual window) still needs a usable step.
    if (b < top) {
      b += 1;
    } else {
      a -= 1;
    }
  }
  return { lo: a, hi: b };
}

/** Which end of the window a drag holds. */
export type RangeEdge = 'lo' | 'hi';

/**
 * The value under a point `frac` (0..1) across a histogram of `0..top`, for the given edge. The
 * window's `lo` line is drawn at the left of bin `lo` and its `hi` line at the right of bin `hi`,
 * so the line ends up under the pointer either way.
 */
export function edgeValue(frac: number, top: number, edge: RangeEdge): number {
  const v = Math.round(clamp(frac, 0, 1) * (top + 1));
  return clamp(edge === 'lo' ? v : v - 1, 0, top);
}

/** Move one edge to `value`, stopping it 1 LSB short of the other one. */
export function moveEdge(win: DisplayRange, edge: RangeEdge, value: number, top: number): DisplayRange {
  return edge === 'lo'
    ? { lo: clamp(Math.round(value), 0, win.hi - 1), hi: win.hi }
    : { lo: win.lo, hi: clamp(Math.round(value), win.lo + 1, top) };
}

/** Slide the whole window by `delta` LSB, keeping its width and staying inside `0..top`. */
export function shiftWindow(win: DisplayRange, delta: number, top: number): DisplayRange {
  const width = win.hi - win.lo;
  const lo = clamp(Math.round(win.lo + delta), 0, top - width);
  return { lo, hi: lo + width };
}

/** The edge closer to `value`; inside the window, the nearer one too. */
export function nearestEdge(win: DisplayRange, value: number): RangeEdge {
  return Math.abs(value - win.lo) <= Math.abs(value - win.hi) ? 'lo' : 'hi';
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const STORAGE_PREFIX = 'racs.range';

/**
 * Settings remembered per device and bit depth, since a useful window differs between them.
 * `scope` keeps a view's window apart from the others' (the 3D view's heights are not the live
 * view's intensities); `fallback` is what a view starts with.
 */
export function loadRangeSettings(
  deviceId: number,
  bitDepth: number,
  scope = STORAGE_PREFIX,
  fallback: RangeSettings = defaultRangeSettings(bitDepth),
): RangeSettings {
  try {
    const raw = localStorage.getItem(`${scope}.${deviceId}.${bitDepth}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RangeSettings>;
      if (
        (parsed.mode === 'full' || parsed.mode === 'manual' || parsed.mode === 'auto') &&
        typeof parsed.lo === 'number' &&
        typeof parsed.hi === 'number'
      ) {
        return { mode: parsed.mode, lo: parsed.lo, hi: parsed.hi };
      }
    }
  } catch {
    // Storage unavailable or corrupt: fall through to the default.
  }
  return fallback;
}

export function saveRangeSettings(
  deviceId: number,
  bitDepth: number,
  settings: RangeSettings,
  scope = STORAGE_PREFIX,
): void {
  try {
    localStorage.setItem(`${scope}.${deviceId}.${bitDepth}`, JSON.stringify(settings));
  } catch {
    // Remembering is a convenience only.
  }
}
