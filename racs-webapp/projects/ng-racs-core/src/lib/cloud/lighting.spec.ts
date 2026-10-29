import {
  activeLightDirection,
  anglesToDial,
  DEFAULT_LIGHT,
  dialToAngles,
  headlight,
  lightDirection,
  lightMatrix,
  sanitizeLight,
} from './lighting';
import { length, transformPoint, type Vec3 } from './mat4';
import { eye, type Bounds, type Orbit } from './orbit';

const DEG = Math.PI / 180;

describe('lightDirection', () => {
  it('is a unit vector toward the light, azimuth like the orbit yaw', () => {
    const overhead = lightDirection(30, 90);
    expect(overhead[2]).toBeCloseTo(1);
    const east = lightDirection(0, 0);
    expect(east[0]).toBeCloseTo(1);
    expect(east[1]).toBeCloseTo(0);
    const d = lightDirection(-135, 45);
    expect(length(d)).toBeCloseTo(1);
    // Where an orbit at the same yaw and pitch puts its eye.
    const o: Orbit = { target: [0, 0, 0], yaw: -135 * DEG, pitch: 45 * DEG, distance: 1 };
    const e = eye(o);
    d.forEach((v, i) => expect(v).toBeCloseTo(e[i]));
  });

  it('follows the eye when asked, a little above it', () => {
    const o: Orbit = { target: [5, 5, 5], yaw: 0, pitch: 0, distance: 10 };
    const h = headlight(o);
    expect(length(h)).toBeCloseTo(1);
    expect(h[2]).toBeGreaterThan(0);
    expect(h[0]).toBeGreaterThan(0.5);
    expect(activeLightDirection({ ...DEFAULT_LIGHT, followView: true }, o)).toEqual(h);
    expect(activeLightDirection(DEFAULT_LIGHT, o)).toEqual(lightDirection(DEFAULT_LIGHT.azimuth, DEFAULT_LIGHT.elevation));
  });
});

describe('sanitizeLight', () => {
  it('keeps what is usable, clamps ranges and wraps the azimuth', () => {
    expect(sanitizeLight(null)).toEqual(DEFAULT_LIGHT);
    const s = sanitizeLight({ enabled: false, azimuth: 270, elevation: 120, intensity: -1, shininess: 'x', shadows: true });
    expect(s.enabled).toBe(false);
    expect(s.azimuth).toBe(-90);
    expect(s.elevation).toBe(90);
    expect(s.intensity).toBe(0);
    expect(s.shininess).toBe(DEFAULT_LIGHT.shininess);
    expect(s.shadows).toBe(true);
  });
});

describe('the direction dial', () => {
  it('puts overhead in the centre and the horizon on the rim, like the Top view', () => {
    const top = anglesToDial(0, 90);
    expect(Math.hypot(top.x, top.y)).toBe(0);
    const east = anglesToDial(0, 0);
    expect(east.x).toBeCloseTo(1);
    // +Y is up on screen, so a light toward +Y is above the centre.
    expect(anglesToDial(90, 0).y).toBeCloseTo(-1);
  });

  it('round-trips, and keeps the azimuth at the centre', () => {
    for (const [az, el] of [[-135, 45], [10, 5], [170, 80]]) {
      const p = anglesToDial(az, el);
      const back = dialToAngles(p.x, p.y);
      expect(back.azimuth).toBeCloseTo(az);
      expect(back.elevation).toBeCloseTo(el);
    }
    expect(dialToAngles(0, 0, 42)).toEqual({ azimuth: 42, elevation: 90 });
    // Outside the disk is the horizon.
    expect(dialToAngles(3, 0).elevation).toBe(0);
  });
});

describe('lightMatrix', () => {
  const box: Bounds = { min: [0, -500, 0], max: [2047, 0, 700] };
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  }

  it('holds every corner of the box, from any side', () => {
    for (const dir of [lightDirection(-135, 45), lightDirection(0, 90), lightDirection(60, 3)]) {
      const m = lightMatrix(box, dir);
      for (const c of corners) {
        for (const v of transformPoint(m, c)) {
          expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });

  it('puts what faces the light in front', () => {
    const m = lightMatrix(box, [0, 0, 1]);
    const high = transformPoint(m, [1000, -250, 700]);
    const low = transformPoint(m, [1000, -250, 0]);
    expect(high[2]).toBeLessThan(low[2]);
  });
});
