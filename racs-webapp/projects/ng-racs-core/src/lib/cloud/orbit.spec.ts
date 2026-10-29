import { multiply, transformPoint, type Vec3 } from './mat4';
import {
  dolly,
  eye,
  fit,
  matchesPreset,
  MAX_PITCH,
  pan,
  presetAngles,
  projectionFor,
  rotate,
  screenBasis,
  viewMatrix,
  type Bounds,
  type Orbit,
} from './orbit';

const box: Bounds = { min: [0, -100, 0], max: [200, 0, 50] };

function project(o: Orbit, aspect: number, p: Vec3): Vec3 {
  return transformPoint(multiply(projectionFor(o, aspect, box), viewMatrix(o)), p);
}

function close(a: Vec3, b: Vec3, digits = 6): void {
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

describe('presets', () => {
  it('shows the top view like the 2D image: columns right, profiles down', () => {
    const o = fit(box, 1, presetAngles('top'));
    const { right, up } = screenBasis(o);
    close(right, [1, 0, 0], 2);
    // 89.5°, not straight down: the up vector keeps a sliver of z.
    close(up, [0, 1, 0], 1);
    // Profiles run toward −Y, so a later profile is lower on screen.
    expect(project(o, 1, [100, -90, 0])[1]).toBeLessThan(project(o, 1, [100, -10, 0])[1]);
  });

  it('shows the side view with the profiles running left to right', () => {
    const o = fit(box, 1, presetAngles('side'));
    expect(project(o, 1, [0, -90, 25])[0]).toBeGreaterThan(project(o, 1, [0, -10, 25])[0]);
    close(screenBasis(o).up, [0, 0, 1]);
  });

  it('recognises its own angles and nothing between them', () => {
    for (const preset of ['top', 'front', 'side', 'iso'] as const) {
      expect(matchesPreset(fit(box, 1, presetAngles(preset)))).toBe(preset);
    }
    expect(matchesPreset(rotate(fit(box, 1, presetAngles('iso')), 30, 0))).toBeNull();
  });
});

describe('fit', () => {
  it('keeps every corner of the box on screen at any aspect', () => {
    for (const aspect of [0.5, 1, 2.5]) {
      for (const preset of ['top', 'front', 'side', 'iso'] as const) {
        const o = fit(box, aspect, presetAngles(preset));
        for (const x of [box.min[0], box.max[0]]) {
          for (const y of [box.min[1], box.max[1]]) {
            for (const z of [box.min[2], box.max[2]]) {
              const [sx, sy, sz] = project(o, aspect, [x, y, z]);
              expect(Math.abs(sx)).toBeLessThanOrEqual(1);
              expect(Math.abs(sy)).toBeLessThanOrEqual(1);
              expect(Math.abs(sz)).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it('aims at the centre of the box', () => {
    close(fit(box, 1, presetAngles('iso')).target, [100, -50, 25]);
  });
});

describe('gestures', () => {
  const o = fit(box, 1, presetAngles('iso'));

  it('never tips over the pole', () => {
    expect(rotate(o, 0, 100_000).pitch).toBeCloseTo(MAX_PITCH);
    expect(rotate(o, 0, -100_000).pitch).toBeCloseTo(-MAX_PITCH);
  });

  it('turns the eye around the target at a constant distance', () => {
    const r = rotate(o, 120, 40);
    const d = (p: Vec3) => Math.hypot(p[0] - o.target[0], p[1] - o.target[1], p[2] - o.target[2]);
    expect(d(eye(r))).toBeCloseTo(o.distance);
  });

  it('pans so the point under the pointer follows it', () => {
    const height = 400;
    const before = project(o, 1, o.target);
    const after = project(pan(o, 40, 0, height), 1, o.target);
    // 40 px of a 400 px view is 0.2 of clip space's 2 units.
    expect(after[0] - before[0]).toBeCloseTo(0.2, 2);
    expect(after[1]).toBeCloseTo(before[1], 4);
  });

  it('dollies within its limits', () => {
    expect(dolly(o, 0.001, 10, 1000).distance).toBe(10);
    expect(dolly(o, 1000, 10, 1000).distance).toBe(1000);
  });
});
