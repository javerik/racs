/**
 * The point-cloud camera: an orbit around a target point, Z up.
 *
 * World axes: X along the profile (columns), Y across profiles, Z the height. Profiles run
 * toward −Y (see `scaling.ts`), so the Top view reads like the 2D image: columns to the right,
 * profiles running down.
 */

import { add, cross, lookAt, normalize, perspective, scale, sub, type Mat4, type Vec3 } from './mat4';

export interface Orbit {
  target: Vec3;
  /** Direction of the eye from the target in the XY plane, radians from +X. */
  yaw: number;
  /** Elevation of the eye above the XY plane, radians. */
  pitch: number;
  distance: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export type ViewPreset = 'top' | 'front' | 'side' | 'iso';

export const VIEW_PRESETS: readonly ViewPreset[] = ['top', 'front', 'side', 'iso'];

/** Vertical field of view. */
export const FOV_Y = (45 * Math.PI) / 180;

const DEG = Math.PI / 180;
/** Straight down (or up) has no defined screen orientation; stop just short of it. */
export const MAX_PITCH = 89.5 * DEG;
const UP: Vec3 = [0, 0, 1];

/**
 * - `top`: from above, columns to the right and profiles running down, like the 2D image
 * - `front`: from the end of the scan, facing the last profile
 * - `side`: from the first column's side, profiles running left to right
 * - `iso`: from above the first column and the end of the scan
 */
export function presetAngles(preset: ViewPreset): { yaw: number; pitch: number } {
  switch (preset) {
    case 'top':
      return { yaw: -90 * DEG, pitch: MAX_PITCH };
    case 'front':
      return { yaw: -90 * DEG, pitch: 0 };
    case 'side':
      return { yaw: 180 * DEG, pitch: 0 };
    case 'iso':
      return { yaw: -120 * DEG, pitch: 35 * DEG };
  }
}

/** The preset whose angles the orbit has, if any. */
export function matchesPreset(o: Orbit): ViewPreset | null {
  for (const preset of VIEW_PRESETS) {
    const a = presetAngles(preset);
    if (Math.abs(angleDiff(o.yaw, a.yaw)) < 0.5 * DEG && Math.abs(o.pitch - a.pitch) < 0.5 * DEG) {
      return preset;
    }
  }
  return null;
}

export function eye(o: Orbit): Vec3 {
  const cp = Math.cos(o.pitch);
  return add(o.target, scale([cp * Math.cos(o.yaw), cp * Math.sin(o.yaw), Math.sin(o.pitch)], o.distance));
}

export function viewMatrix(o: Orbit): Mat4 {
  return lookAt(eye(o), o.target, UP);
}

/** The screen's right and up directions in the world. */
export function screenBasis(o: Orbit): { right: Vec3; up: Vec3 } {
  const f = normalize(sub(o.target, eye(o)));
  const right = normalize(cross(f, UP));
  return { right, up: cross(right, f) };
}

/** A projection whose depth range just holds `bounds` from where the eye is. */
export function projectionFor(o: Orbit, aspect: number, bounds: Bounds): Mat4 {
  const r = radius(bounds);
  const toCentre = Math.hypot(...sub(centre(bounds), eye(o)));
  const near = Math.max(toCentre - r * 1.01, r * 1e-3, 1e-6);
  const far = Math.max(toCentre + r * 1.01, near * 2);
  return perspective(FOV_Y, aspect, near, far);
}

/** Turn the eye around the target: a drag of `dx`, `dy` px, right and down. */
export function rotate(o: Orbit, dx: number, dy: number, radPerPx = 0.008): Orbit {
  return {
    ...o,
    yaw: wrapAngle(o.yaw - dx * radPerPx),
    pitch: clamp(o.pitch + dy * radPerPx, -MAX_PITCH, MAX_PITCH),
  };
}

/** Move the target so the content follows a drag of `dx`, `dy` px in a view `viewHeight` px tall. */
export function pan(o: Orbit, dx: number, dy: number, viewHeight: number): Orbit {
  const perPx = (2 * o.distance * Math.tan(FOV_Y / 2)) / Math.max(1, viewHeight);
  const { right, up } = screenBasis(o);
  return { ...o, target: add(o.target, add(scale(right, -dx * perPx), scale(up, dy * perPx))) };
}

/** Move the eye closer (`factor` < 1) or further away, within `min`..`max`. */
export function dolly(o: Orbit, factor: number, min: number, max: number): Orbit {
  return { ...o, distance: clamp(o.distance * factor, min, max) };
}

/** An orbit at `angles` that shows all of `bounds` in a view of `aspect` (width / height). */
export function fit(bounds: Bounds, aspect: number, angles: { yaw: number; pitch: number }): Orbit {
  const r = Math.max(radius(bounds), 1e-6);
  const halfY = FOV_Y / 2;
  const halfX = Math.atan(Math.tan(halfY) * aspect);
  const distance = r / Math.sin(Math.min(halfX, halfY));
  return { target: centre(bounds), yaw: angles.yaw, pitch: angles.pitch, distance };
}

export function centre(b: Bounds): Vec3 {
  return scale(add(b.min, b.max), 0.5);
}

/** Half the diagonal: the radius of a sphere holding the box. */
export function radius(b: Bounds): number {
  return Math.hypot(...sub(b.max, b.min)) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function angleDiff(a: number, b: number): number {
  return wrapAngle(a - b);
}
