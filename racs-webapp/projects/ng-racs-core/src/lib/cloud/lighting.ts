/**
 * The light the 3D view shades with: one white directional light, set by azimuth and elevation
 * (or following the eye), Lambert plus a Blinn-Phong highlight, and optionally a shadow map.
 *
 * Azimuth is measured like `Orbit.yaw` (from +X toward +Y, in the XY plane), elevation above the
 * XY plane, both in degrees. A direction here always points from the scene toward the light.
 */

import { add, lookAt, multiply, normalize, ortho, scale, type Mat4, type Vec3 } from './mat4';
import { centre, radius, type Bounds, type Orbit } from './orbit';

export interface LightSettings {
  enabled: boolean;
  /** The light sits just above and beside the eye, wherever the view turns. */
  followView: boolean;
  /** Degrees, −180..180. */
  azimuth: number;
  /** Degrees above the horizon, 0..90. */
  elevation: number;
  /** Diffuse strength. */
  intensity: number;
  /** Light everywhere, lit or not. */
  ambient: number;
  /** Highlight strength. */
  specular: number;
  /** Highlight tightness (Blinn-Phong exponent). */
  shininess: number;
  shadows: boolean;
}

/** Slider ranges for the settings above. */
export const LIGHT_RANGES = {
  intensity: { min: 0, max: 1.5, step: 0.05 },
  ambient: { min: 0, max: 1, step: 0.05 },
  specular: { min: 0, max: 1, step: 0.05 },
  shininess: { min: 2, max: 128, step: 1 },
} as const;

export const DEFAULT_LIGHT: LightSettings = {
  enabled: true,
  followView: false,
  azimuth: -135,
  elevation: 45,
  intensity: 0.8,
  ambient: 0.3,
  specular: 0.2,
  shininess: 32,
  shadows: false,
};

const DEG = Math.PI / 180;
/** Where a following light sits relative to the eye. */
const HEADLIGHT_TURN = 20 * DEG;
const HEADLIGHT_RAISE = 25 * DEG;

/** A usable light from anything; what isn't usable comes from `base`. */
export function sanitizeLight(raw: unknown, base: LightSettings = DEFAULT_LIGHT): LightSettings {
  const r = (raw ?? {}) as Partial<Record<keyof LightSettings, unknown>>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  const azimuth = typeof r.azimuth === 'number' && Number.isFinite(r.azimuth) ? wrapDegrees(r.azimuth) : base.azimuth;
  return {
    enabled: bool(r.enabled, base.enabled),
    followView: bool(r.followView, base.followView),
    azimuth,
    elevation: num(r.elevation, base.elevation, 0, 90),
    intensity: num(r.intensity, base.intensity, LIGHT_RANGES.intensity.min, LIGHT_RANGES.intensity.max),
    ambient: num(r.ambient, base.ambient, LIGHT_RANGES.ambient.min, LIGHT_RANGES.ambient.max),
    specular: num(r.specular, base.specular, LIGHT_RANGES.specular.min, LIGHT_RANGES.specular.max),
    shininess: num(r.shininess, base.shininess, LIGHT_RANGES.shininess.min, LIGHT_RANGES.shininess.max),
    shadows: bool(r.shadows, base.shadows),
  };
}

/** The unit direction toward a light at `azimuth`, `elevation` (degrees). */
export function lightDirection(azimuth: number, elevation: number): Vec3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
}

/** Toward a light just above and to the left of the eye, so faces turned to the view aren't flat. */
export function headlight(o: Orbit): Vec3 {
  const pitch = Math.min(89 * DEG, Math.max(-89 * DEG, o.pitch + HEADLIGHT_RAISE));
  return lightDirection((o.yaw - HEADLIGHT_TURN) / DEG, pitch / DEG);
}

/** The direction the view shades with. */
export function activeLightDirection(light: LightSettings, o: Orbit): Vec3 {
  return light.followView ? headlight(o) : lightDirection(light.azimuth, light.elevation);
}

/**
 * The light's view and projection for a shadow map of `box`: orthographic along `dir`, just
 * holding the sphere around the box, so every point of it lands in the map.
 */
export function lightMatrix(box: Bounds, dir: Vec3): Mat4 {
  const r = Math.max(radius(box), 1e-6);
  const c = centre(box);
  const d = normalize(dir);
  const eye = add(c, scale(d, 2 * r));
  // Straight down has no screen orientation along Z; any other up will do.
  const up: Vec3 = Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  return multiply(ortho(-r, r, -r, r, r * 0.99, r * 3.01), lookAt(eye, c, up));
}

/**
 * The light's place on the direction dial, a unit disk seen from above like the Top view (+X to
 * the right, +Y up on screen): the centre is straight overhead, the rim the horizon. `y` grows
 * downward, as on screen.
 */
export function anglesToDial(azimuth: number, elevation: number): { x: number; y: number } {
  const rho = 1 - Math.min(90, Math.max(0, elevation)) / 90;
  const a = azimuth * DEG;
  return { x: rho * Math.cos(a), y: -rho * Math.sin(a) };
}

/** A point on the dial to angles; at the very centre the azimuth stays `fallbackAzimuth`. */
export function dialToAngles(x: number, y: number, fallbackAzimuth = 0): { azimuth: number; elevation: number } {
  const rho = Math.min(1, Math.hypot(x, y));
  const azimuth = rho < 1e-3 ? fallbackAzimuth : Math.atan2(-y, x) / DEG;
  return { azimuth: wrapDegrees(azimuth), elevation: 90 * (1 - rho) };
}

function wrapDegrees(a: number): number {
  const w = (((a + 180) % 360) + 360) % 360 - 180;
  return w === -180 ? 180 : w;
}
