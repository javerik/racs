/**
 * Test helper: a camera filming the laserline view through a known homography, so the calibration
 * can be checked end to end without hardware. Only imported by specs.
 */

import {
  applyHomography,
  type GrayFrame,
  invertHomography,
  type Mat3,
  patternSegment,
  type Pattern,
  type Point,
  type ViewPoint,
} from 'ng-racs-core';

export interface SyntheticCamera {
  /** Laserline view px → full-sensor px. */
  h: Mat3;
  sensor: { width: number; height: number };
  viewPx: ViewPoint;
  /** Background level, line peak and noise sigma (8-bit values). */
  background?: number;
  peak?: number;
  noise?: number;
  /** Line width in view px. */
  lineWidth?: number;
}

/** Deterministic uniform noise in [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * The frame the camera grabs while laserline shows `segment` (a line from `a` to `b` in view px) or
 * nothing. `region` crops it as the camera region would.
 */
export function renderSegment(
  cam: SyntheticCamera,
  segment: { a: Point; b: Point } | null,
  region = { x: 0, y: 0, width: cam.sensor.width, height: cam.sensor.height },
  seed = 1,
  width?: number,
): GrayFrame {
  const inv = invertHomography(cam.h)!;
  const { background = 12, peak = 180, noise = 2 } = cam;
  const lineWidth = width ?? cam.lineWidth ?? 4;
  const random = seededRandom(seed);
  const pixels = new Uint8Array(region.width * region.height);
  const [vw, vh] = cam.viewPx;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      let v = background;
      if (segment) {
        // Supersample 3×3 so a line thinner than a sensor pixel still shows.
        let lit = 0;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            const p = applyHomography(inv, { x: region.x + x + (sx + 0.5) / 3, y: region.y + y + (sy + 0.5) / 3 });
            if (p.x < 0 || p.y < 0 || p.x > vw || p.y > vh) continue;
            if (distanceToSegment(p, segment.a, segment.b) <= lineWidth / 2) lit++;
          }
        }
        v += (peak * lit) / 9;
      }
      // Box–Muller.
      const n = Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
      pixels[y * region.width + x] = Math.max(0, Math.min(255, Math.round(v + n * noise)));
    }
  }
  return { width: region.width, height: region.height, bitDepth: 8, pixels };
}

/** The frame for a laserline calibration pattern (a line or band across the whole view, maybe tilted; white, stripes, or nothing). */
export function renderPattern(cam: SyntheticCamera, pattern: Pattern, seed = 1): GrayFrame {
  if (pattern.kind === 'blank') {
    return renderSegment(cam, null, undefined, seed);
  }
  if (pattern.kind === 'white' || pattern.kind === 'stripes') {
    return renderLit(cam, seed, (x, y) => {
      if (pattern.kind === 'white') return true;
      const p = Math.floor(pattern.orientation === 'Vertical' ? x : y);
      return (((p ^ (p >>> 1)) >>> pattern.bit) & 1) === 1;
    });
  }
  // The segment laserline draws: centred on the middle axis, as long as the view along the line.
  const segment = patternSegment(pattern, cam.viewPx)!;
  const across = pattern.orientation === 'Horizontal' ? cam.viewPx[1] : cam.viewPx[0];
  return renderSegment(cam, segment, undefined, seed, pattern.width_pct === undefined ? undefined : (pattern.width_pct / 100) * across);
}

/** The frame of a view lit where `lit(x, y)` holds (view px), seen through the camera. */
function renderLit(cam: SyntheticCamera, seed: number, lit: (x: number, y: number) => boolean): GrayFrame {
  const inv = invertHomography(cam.h)!;
  const { background = 12, peak = 180, noise = 2 } = cam;
  const random = seededRandom(seed);
  const { width, height } = cam.sensor;
  const pixels = new Uint8Array(width * height);
  const [vw, vh] = cam.viewPx;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const p = applyHomography(inv, { x: x + (sx + 0.5) / 2, y: y + (sy + 0.5) / 2 });
          if (p.x >= 0 && p.y >= 0 && p.x < vw && p.y < vh && lit(p.x, p.y)) on++;
        }
      }
      const n = Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(background + (peak * on) / 4 + n * noise)));
    }
  }
  return { width, height, bitDepth: 8, pixels };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A homography for a camera seeing part of a `view`-sized screen: `field` (view px, axis-aligned)
 * fills the sensor, turned by `angleDeg`, optionally mirrored, with a little perspective.
 */
export function cameraHomography(
  field: { x: number; y: number; width: number; height: number },
  sensor: { width: number; height: number },
  angleDeg = 0,
  mirror = false,
  perspective = 0,
): Mat3 {
  const sx = sensor.width / field.width;
  const sy = sensor.height / field.height;
  const c = Math.cos((angleDeg * Math.PI) / 180);
  const s = Math.sin((angleDeg * Math.PI) / 180);
  const m = mirror ? -1 : 1;
  // Field centre → origin, scale, rotate (and mirror) about it, origin → sensor centre.
  const cx = field.x + field.width / 2;
  const cy = field.y + field.height / 2;
  const a = m * c * sx;
  const b = -s * sy;
  const d = m * s * sx;
  const e = c * sy;
  return [
    a,
    b,
    sensor.width / 2 - a * cx - b * cy,
    d,
    e,
    sensor.height / 2 - d * cx - e * cy,
    perspective,
    perspective / 2,
    1 - perspective * cx - (perspective / 2) * cy,
  ];
}
