/**
 * How a frame is shown: rotated in quarter turns and either fitted to the viewport or at a fixed
 * scale. Display only: the frame (and an exported canvas bitmap) is never rotated or resampled.
 */

export type Rotation = 0 | 90 | 180 | 270;

/** `fit` follows the viewport; a number is a fixed scale, 1 being one screen pixel per pixel. */
export type ViewScale = 'fit' | number;

export interface ViewSettings {
  rotation: Rotation;
  scale: ViewScale;
}

export const DEFAULT_VIEW: ViewSettings = { rotation: 0, scale: 'fit' };

/** The fixed scales zooming steps through. */
export const ZOOM_STEPS: readonly number[] = [0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

export interface Size {
  width: number;
  height: number;
}

/** A clockwise quarter turn (`dir` 1) or anticlockwise (`dir` -1). */
export function rotateQuarter(rotation: Rotation, dir: 1 | -1): Rotation {
  return ((((rotation + dir * 90) % 360) + 360) % 360) as Rotation;
}

/** The frame's extent on screen once rotated, at scale 1. */
export function rotatedSize(frame: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

/** The largest scale at which the rotated frame fits inside `box`. */
export function fitScale(frame: Size, rotation: Rotation, box: Size): number {
  const r = rotatedSize(frame, rotation);
  if (r.width <= 0 || r.height <= 0 || box.width <= 0 || box.height <= 0) {
    return 1;
  }
  return Math.min(box.width / r.width, box.height / r.height);
}

/** The next fixed scale above (`dir` 1) or below (`dir` -1) `current`, which may be any value. */
export function zoomStep(current: number, dir: 1 | -1): number {
  // Tolerance, so a scale that is a step already moves on to the next one.
  const eps = 1e-6;
  if (dir > 0) {
    return ZOOM_STEPS.find((s) => s > current + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  return [...ZOOM_STEPS].reverse().find((s) => s < current - eps) ?? ZOOM_STEPS[0];
}

/** The scale a two-finger pinch gives: `start` grown by the change in finger distance, kept to the steps' span. */
export function pinchScale(start: number, startDistance: number, distance: number): number {
  if (startDistance <= 0 || distance <= 0) {
    return start;
  }
  const min = ZOOM_STEPS[0];
  const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return Math.min(max, Math.max(min, (start * distance) / startDistance));
}

/**
 * The frame position (continuous, in pixels) under a point given relative to the top-left corner
 * of the rotated, scaled frame on screen. Not clamped: points outside the frame map outside it.
 */
export function toSpacePoint(
  point: { x: number; y: number },
  frame: Size,
  rotation: Rotation,
  scale: number,
): { x: number; y: number } {
  const r = rotatedSize(frame, rotation);
  const u = point.x / scale;
  const v = point.y / scale;
  // Undo the clockwise turn: where the frame's own (x, y) lands on screen is, per rotation,
  // 90: (h - y, x), 180: (w - x, h - y), 270: (y, w - x).
  switch (rotation) {
    case 90:
      return { x: v, y: r.width - u };
    case 180:
      return { x: r.width - u, y: r.height - v };
    case 270:
      return { x: r.height - v, y: u };
    default:
      return { x: u, y: v };
  }
}

/**
 * The frame pixel under a point given relative to the top-left corner of the rotated, scaled
 * frame on screen, or null outside it.
 */
export function toFramePixel(
  point: { x: number; y: number },
  frame: Size,
  rotation: Rotation,
  scale: number,
): { x: number; y: number } | null {
  const p = toSpacePoint(point, frame, rotation, scale);
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  return px >= 0 && py >= 0 && px < frame.width && py < frame.height ? { x: px, y: py } : null;
}

/** Where a frame position (continuous) lands on screen, relative to the rotated, scaled frame. */
export function fromSpacePoint(
  point: { x: number; y: number },
  frame: Size,
  rotation: Rotation,
  scale: number,
): { x: number; y: number } {
  const { x, y } = point;
  let u: number;
  let v: number;
  switch (rotation) {
    case 90:
      u = frame.height - y;
      v = x;
      break;
    case 180:
      u = frame.width - x;
      v = frame.height - y;
      break;
    case 270:
      u = y;
      v = frame.width - x;
      break;
    default:
      u = x;
      v = y;
  }
  return { x: u * scale, y: v * scale };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a rectangle of `space` lands on screen once the space is rotated and scaled, relative to
 * the space's top-left corner on screen. A quarter turn keeps a rectangle a rectangle.
 */
export function placeRect(rect: Rect, space: Size, rotation: Rotation, scale: number): Rect {
  const a = fromSpacePoint({ x: rect.x, y: rect.y }, space, rotation, scale);
  const b = fromSpacePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, space, rotation, scale);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Where the centre of frame pixel `pixel` lands on screen, relative to the top-left corner of the
 * rotated, scaled frame: the inverse of {@link toFramePixel}.
 */
export function fromFramePixel(
  pixel: { x: number; y: number },
  frame: Size,
  rotation: Rotation,
  scale: number,
): { x: number; y: number } {
  return fromSpacePoint({ x: pixel.x + 0.5, y: pixel.y + 0.5 }, frame, rotation, scale);
}

/** A step on screen (arrow keys) as a step in frame axes, for a view turned by `rotation`. */
export function unrotateStep([dx, dy]: [number, number], rotation: Rotation): [number, number] {
  switch (rotation) {
    case 90:
      return [dy, -dx];
    case 180:
      return [-dx, -dy];
    case 270:
      return [-dy, dx];
    default:
      return [dx, dy];
  }
}

/** Percent text for a scale: `100 %`, `12.5 %`, `1600 %`. */
export function formatScale(scale: number): string {
  const pct = scale * 100;
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10} %`;
}

const VIEW_KEY = 'racs.live.view';

export function loadView(key = VIEW_KEY): ViewSettings {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<ViewSettings> | null;
    const rotation = [0, 90, 180, 270].includes(v?.rotation as number) ? (v!.rotation as Rotation) : 0;
    const scale =
      typeof v?.scale === 'number' && v.scale >= ZOOM_STEPS[0] && v.scale <= ZOOM_STEPS[ZOOM_STEPS.length - 1]
        ? v.scale
        : 'fit';
    return { rotation, scale };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

export function saveView(view: ViewSettings, key = VIEW_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    // Remembering the view is a convenience only.
  }
}
