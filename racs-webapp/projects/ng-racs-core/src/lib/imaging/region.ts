/**
 * The camera's sensor region (GenICam `Width`/`Height`/`OffsetX`/`OffsetY`) as a rectangle on the
 * sensor, and the editing steps the region overlay needs: dragging edges or the whole region,
 * snapping to the device's increments, and the order to write the features in.
 */

import type { FeatureState } from '../models/racs.models';
import type { Size } from './view';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the device allows along one axis. */
export interface AxisLimits {
  /** The sensor's extent: the largest size at offset 0. */
  extent: number;
  minSize: number;
  sizeInc: number;
  offsetInc: number;
  /** The camera has an offset feature for this axis; without one the region is anchored at 0. */
  hasOffset: boolean;
}

export interface RegionLimits {
  x: AxisLimits;
  y: AxisLimits;
}

/** A side or corner of the region (compass points), or the whole region. */
export type RegionHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

export const REGION_FEATURES = ['Width', 'Height', 'OffsetX', 'OffsetY', 'WidthMax', 'HeightMax'] as const;

type States = Partial<Record<string, FeatureState>>;

function num(state: FeatureState | undefined): number | null {
  if (!state || state.value === null || state.value === undefined || state.available === false) {
    return null;
  }
  const n = Number(state.value);
  return Number.isFinite(n) ? n : null;
}

function positive(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The region the device holds now, or null while its size isn't known. */
export function regionFromStates(states: States): Region | null {
  const width = num(states['Width']);
  const height = num(states['Height']);
  if (width === null || height === null) {
    return null;
  }
  return { x: num(states['OffsetX']) ?? 0, y: num(states['OffsetY']) ?? 0, width, height };
}

function axisLimits(states: States, size: string, offset: string, max: string): AxisLimits | null {
  const sizeState = states[size];
  const current = num(sizeState);
  if (!sizeState || current === null) {
    return null;
  }
  const off = num(states[offset]);
  // `WidthMax` is the sensor; failing that, `Width`'s own max is what is left beside the offset.
  const extent =
    num(states[max]) ?? (typeof sizeState.max === 'number' ? sizeState.max + (off ?? 0) : current + (off ?? 0));
  return {
    extent: Math.max(extent, current),
    minSize: positive(sizeState.min, 1),
    sizeInc: positive(sizeState.inc, 1),
    offsetInc: positive(states[offset]?.inc, 1),
    hasOffset: off !== null,
  };
}

/**
 * Whether the device has a camera region, from its feature list alone: the tool must be offered
 * before the region's states are read, since opening it is what reads them.
 */
export function hasRegion(nodes: { has(name: string): boolean }): boolean {
  return nodes.has('Width') && nodes.has('Height');
}

export function regionLimits(states: States): RegionLimits | null {
  const x = axisLimits(states, 'Width', 'OffsetX', 'WidthMax');
  const y = axisLimits(states, 'Height', 'OffsetY', 'HeightMax');
  return x && y ? { x, y } : null;
}

export function sensorSize(limits: RegionLimits): Size {
  return { width: limits.x.extent, height: limits.y.extent };
}

/** The largest size on the grid `minSize + k * sizeInc` that is at most `max`. */
function maxSize(a: AxisLimits, max: number): number {
  return a.minSize + Math.max(0, Math.floor((max - a.minSize) / a.sizeInc)) * a.sizeInc;
}

function snapSize(v: number, a: AxisLimits, max: number): number {
  const k = Math.round((v - a.minSize) / a.sizeInc);
  return Math.min(maxSize(a, max), Math.max(a.minSize, a.minSize + k * a.sizeInc));
}

function snapOffset(v: number, a: AxisLimits, max: number): number {
  if (!a.hasOffset) {
    return 0;
  }
  const top = Math.max(0, Math.floor(max / a.offsetInc) * a.offsetInc);
  return Math.min(top, Math.max(0, Math.round(v / a.offsetInc) * a.offsetInc));
}

/**
 * The (offset, size) for the span `lo..hi` on one axis. `keep` names the edge that stays where it
 * is while the other one snaps, so dragging one side never moves the opposite one by more than
 * the offset grid.
 */
function fitAxis(lo: number, hi: number, a: AxisLimits, keep: 'lo' | 'hi'): [number, number] {
  if (!a.hasOffset) {
    return [0, snapSize(hi, a, a.extent)];
  }
  lo = Math.min(a.extent, Math.max(0, lo));
  hi = Math.min(a.extent, Math.max(0, hi));
  if (keep === 'lo') {
    let off = snapOffset(lo, a, a.extent - a.minSize);
    return [off, snapSize(hi - off, a, a.extent - off)];
  }
  const size = snapSize(hi - lo, a, hi);
  return [snapOffset(hi - size, a, a.extent - size), size];
}

function moveAxis(off: number, size: number, a: AxisLimits): number {
  return snapOffset(off, a, a.extent - size);
}

/** Bring a region onto the device's grid and inside the sensor. */
export function snapRegion(r: Region, limits: RegionLimits): Region {
  const [x, width] = fitAxis(r.x, r.x + r.width, limits.x, 'lo');
  const [y, height] = fitAxis(r.y, r.y + r.height, limits.y, 'lo');
  return { x, y, width, height };
}

/**
 * `start` with `handle` dragged by (dx, dy) sensor pixels. The opposite edge stays put; the whole
 * region moves without changing size. Edges the camera can't move (no offset feature) stay at 0.
 */
export function dragRegion(
  start: Region,
  handle: RegionHandle,
  dx: number,
  dy: number,
  limits: RegionLimits,
): Region {
  if (handle === 'move') {
    return {
      x: limits.x.hasOffset ? moveAxis(start.x + dx, start.width, limits.x) : start.x,
      y: limits.y.hasOffset ? moveAxis(start.y + dy, start.height, limits.y) : start.y,
      width: start.width,
      height: start.height,
    };
  }
  let [l, r, t, b] = [start.x, start.x + start.width, start.y, start.y + start.height];
  let keepX: 'lo' | 'hi' = 'lo';
  let keepY: 'lo' | 'hi' = 'lo';
  if (handle.includes('w') && limits.x.hasOffset) {
    l = Math.min(l + dx, r - limits.x.minSize);
    keepX = 'hi';
  }
  if (handle.includes('e')) {
    r = Math.max(r + dx, l + limits.x.minSize);
  }
  if (handle.includes('n') && limits.y.hasOffset) {
    t = Math.min(t + dy, b - limits.y.minSize);
    keepY = 'hi';
  }
  if (handle.includes('s')) {
    b = Math.max(b + dy, t + limits.y.minSize);
  }
  const [x, width] = fitAxis(l, r, limits.x, keepX);
  const [y, height] = fitAxis(t, b, limits.y, keepY);
  return { x, y, width, height };
}

/** A new region spanned by two points, as when one is drawn on the sensor. */
export function regionFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  limits: RegionLimits,
): Region {
  const l = limits.x.hasOffset ? Math.min(a.x, b.x) : 0;
  const t = limits.y.hasOffset ? Math.min(a.y, b.y) : 0;
  const [x, width] = fitAxis(l, Math.max(a.x, b.x, l + limits.x.minSize), limits.x, 'lo');
  const [y, height] = fitAxis(t, Math.max(a.y, b.y, t + limits.y.minSize), limits.y, 'lo');
  return { x, y, width, height };
}

/** Smallest (offset, size) on the device's grid covering `lo..hi` on one axis, within the sensor. */
function coverAxis(lo: number, hi: number, a: AxisLimits): [number, number] {
  const top = maxSize(a, a.extent);
  lo = Math.min(a.extent, Math.max(0, Math.floor(lo)));
  hi = Math.min(a.extent, Math.max(lo, Math.ceil(hi)));
  let off = a.hasOffset ? Math.floor(lo / a.offsetInc) * a.offsetInc : 0;
  const grow = (need: number) => a.minSize + Math.max(0, Math.ceil((need - a.minSize) / a.sizeInc)) * a.sizeInc;
  let size = grow(hi - off);
  if (size >= top) {
    return [0, top];
  }
  if (off + size > a.extent) {
    // Pushed past the far edge by the grid: slide back, growing if the offset grid falls short.
    off = Math.max(0, Math.floor((a.extent - size) / a.offsetInc) * a.offsetInc);
    size = Math.min(top, grow(hi - off));
  }
  return [off, size];
}

/**
 * The smallest region on the device's grid that contains the sensor rectangle `x0..x1` ×
 * `y0..y1` (rounded outwards, unlike {@link snapRegion}), clipped to the sensor.
 */
export function coverRegion(
  box: { x0: number; y0: number; x1: number; y1: number },
  limits: RegionLimits,
): Region {
  const [x, width] = coverAxis(box.x0, box.x1, limits.x);
  const [y, height] = coverAxis(box.y0, box.y1, limits.y);
  return { x, y, width, height };
}

export function fullRegion(limits: RegionLimits): Region {
  return {
    x: 0,
    y: 0,
    width: maxSize(limits.x, limits.x.extent),
    height: maxSize(limits.y, limits.y.extent),
  };
}

export function centerRegion(r: Region, limits: RegionLimits): Region {
  return {
    ...r,
    x: limits.x.hasOffset ? moveAxis((limits.x.extent - r.width) / 2, r.width, limits.x) : r.x,
    y: limits.y.hasOffset ? moveAxis((limits.y.extent - r.height) / 2, r.height, limits.y) : r.y,
  };
}

export function sameRegion(a: Region | null, b: Region | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The feature writes taking the device from `current` to `next`, in an order that keeps
 * `offset + size` within the sensor after every single write: on each axis a shrinking size goes
 * before the offset moves, a growing one after. Unchanged features are left out.
 */
export function regionWrites(current: Region, next: Region): [string, string][] {
  const out: [string, string][] = [];
  const axis = (size: string, offset: string, curSize: number, nextSize: number, curOff: number, nextOff: number) => {
    const writeSize = () => nextSize !== curSize && out.push([size, String(nextSize)]);
    const writeOffset = () => nextOff !== curOff && out.push([offset, String(nextOff)]);
    if (nextSize < curSize) {
      writeSize();
      writeOffset();
    } else {
      writeOffset();
      writeSize();
    }
  };
  axis('Width', 'OffsetX', current.width, next.width, current.x, next.x);
  axis('Height', 'OffsetY', current.height, next.height, current.y, next.y);
  return out;
}
