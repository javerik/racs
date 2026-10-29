import { multiply, transformPoint, type Mat4, type Vec3 } from './mat4';
import { fit, presetAngles, projectionFor, viewMatrix } from './orbit';
import { gridToWorld, pickHeightfield, pickRay, screenPoint, type PickOptions, type PickTransform } from './pick';
import { ringLayout, RowRing } from './ring';
import { cloudDisplay, PIXEL_SCALING, type CloudScaling } from './scaling';
import { pointUnits } from './measure';

const W = 40;
const DEG = Math.PI / 180;

/** A rolling ring of `capacity` rows with `rows` pushed, value(column, seq) per cell. */
function ringOf(capacity: number, rows: number, value: (c: number, seq: number) => number, width = W): RowRing {
  const ring = new RowRing(ringLayout(width, capacity, 4096, 16), 'rolling');
  const row = new Uint16Array(width);
  for (let seq = 0; seq < rows; seq++) {
    for (let c = 0; c < width; c++) {
      row[c] = value(c, seq);
    }
    ring.push(row, 1);
  }
  return ring;
}

interface View {
  mvp: Mat4;
  display: PickTransform;
}

/** The view of `ring` the cloud view would draw, looking from `angles`. */
function viewOf(
  ring: RowRing,
  angles: { yaw: number; pitch: number },
  s: CloudScaling = PIXEL_SCALING,
  storeStride = 1,
): View {
  const rowShift = ring.rows - ring.filled;
  const d = cloudDisplay(ring.width, ring.rows, storeStride, s, 0, 4000, 'auto', rowShift);
  const orbit = fit(d.box, 1.5, angles);
  return { mvp: multiply(projectionFor(orbit, 1.5, d.box), viewMatrix(orbit)), display: d };
}

/** Pick through where (column, k, value) is drawn. */
function shoot(ring: RowRing, v: View, c: number, k: number, value: number, opts?: PickOptions) {
  const ndc = transformPoint(v.mvp, gridToWorld(v.display, c, k, value));
  const ray = pickRay(v.mvp, [ndc[0], ndc[1]]);
  expect(ray).not.toBeNull();
  return pickHeightfield(ray!, ring, v.display, opts);
}

const iso = presetAngles('iso');
const top = presetAngles('top');

describe('pickRay', () => {
  it('runs from the eye side through the point under the pointer', () => {
    const ring = ringOf(30, 30, () => 1000);
    const v = viewOf(ring, iso);
    const p: Vec3 = gridToWorld(v.display, 10, 10, 1000);
    const ndc = transformPoint(v.mvp, p);
    const ray = pickRay(v.mvp, [ndc[0], ndc[1]])!;
    const t = (p[0] - ray.origin[0]) * ray.dir[0] + (p[1] - ray.origin[1]) * ray.dir[1] + (p[2] - ray.origin[2]) * ray.dir[2];
    expect(t).toBeGreaterThan(0);
    const closest = ray.origin.map((o, i) => o + ray.dir[i] * t);
    closest.forEach((x, i) => expect(x).toBeCloseTo(p[i], 3));
    expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 9);
  });
});

describe('pickHeightfield', () => {
  it('hits a plane where the pointer is', () => {
    const ring = ringOf(30, 30, () => 1000);
    const hit = shoot(ring, viewOf(ring, iso), 13.3, 7.6, 1000)!;
    expect(hit.column).toBeCloseTo(13.3, 3);
    expect(hit.k).toBeCloseTo(7.6, 3);
    expect(hit.value).toBeCloseTo(1000, 6);
    expect(hit.seq).toBeCloseTo(7.6, 3);
  });

  it('interpolates inside a sloped cell', () => {
    const ring = ringOf(30, 30, (c, k) => 500 + 20 * c + 7 * k);
    const hit = shoot(ring, viewOf(ring, iso), 21.5, 12.25, 500 + 20 * 21.5 + 7 * 12.25)!;
    expect(hit.column).toBeCloseTo(21.5, 3);
    expect(hit.k).toBeCloseTo(12.25, 3);
    expect(hit.value).toBeCloseTo(500 + 20 * 21.5 + 7 * 12.25, 2);
  });

  it('finds the top and the foot of a step', () => {
    const ring = ringOf(30, 30, (c) => (c < 20 ? 1000 : 3000));
    const v = viewOf(ring, iso);
    expect(shoot(ring, v, 30, 15, 3000)!.value).toBeCloseTo(3000, 6);
    expect(shoot(ring, v, 8, 15, 1000)!.value).toBeCloseTo(1000, 6);
  });

  it('takes the first crossing: a wall in front hides the floor behind it', () => {
    // From the low side (eye toward −x), low and close to the step's foot.
    const ring = ringOf(30, 30, (c) => (c < 20 ? 1000 : 3000));
    const v = viewOf(ring, { yaw: 180 * DEG, pitch: 20 * DEG });
    const hit = shoot(ring, v, 19.5, 15, 2000)!;
    expect(hit.column).toBeCloseTo(19.5, 3);
    expect(hit.value).toBeCloseTo(2000, 3);
  });

  it('passes through a step larger than the surface draws', () => {
    const ring = ringOf(30, 30, (c) => (c < 20 ? 1000 : 3000));
    const v = viewOf(ring, { yaw: 180 * DEG, pitch: 20 * DEG });
    // The wall isn't drawn, and behind it the ray runs under the top: nothing.
    expect(shoot(ring, v, 19.5, 15, 2000, { maxStep: 500 })).toBeNull();
  });

  it('sees nothing in a hole', () => {
    const ring = ringOf(30, 30, (c, k) => (c >= 10 && c <= 14 && k >= 5 && k <= 9 ? 0 : 1000));
    const v = viewOf(ring, top);
    expect(shoot(ring, v, 12, 7, 1000)).toBeNull();
    // A cell next to it with a corner in the hole is no surface either.
    expect(shoot(ring, v, 9.5, 7, 1000)).toBeNull();
    expect(shoot(ring, v, 8.5, 7, 1000)!.column).toBeCloseTo(8.5, 3);
  });

  it('counts held rows from the oldest of a rolling ring, and keeps the global row', () => {
    // 50 profiles through 32 slots: the oldest held is profile 18.
    const ring = ringOf(32, 50, (c, seq) => 1000 + 10 * seq);
    expect(ring.oldestSeq()).toBe(18);
    const hit = shoot(ring, viewOf(ring, iso), 6, 10.25, 1000 + 10 * 28.25)!;
    expect(hit.k).toBeCloseTo(10.25, 3);
    expect(hit.seq).toBeCloseTo(28.25, 3);
    expect(hit.value).toBeCloseTo(1282.5, 2);
  });

  it('follows the rolling offset of a ring not yet full', () => {
    const ring = ringOf(32, 20, (c, seq) => 1000 + 10 * seq);
    expect(ring.rows - ring.filled).toBe(12);
    const hit = shoot(ring, viewOf(ring, iso), 25, 4.5, 1045)!;
    expect(hit.k).toBeCloseTo(4.5, 3);
    expect(hit.value).toBeCloseTo(1045, 2);
  });

  it('works on a store keeping every third profile', () => {
    const s: CloudScaling = { unit: 'mm', xPitch: 0.05, ySpacing: 0.1, zScale: 0.001, zOffset: 0 };
    const ring = ringOf(30, 30, (c, k) => 1000 + 5 * k);
    const hit = shoot(ring, viewOf(ring, iso, s, 3), 17, 11.5, 1057.5)!;
    expect(hit.k).toBeCloseTo(11.5, 3);
    expect(pointUnits(hit, s, 3, W)[1]).toBeCloseTo(-11.5 * 0.3, 3);
  });

  it('marches a mirrored x the other way', () => {
    const s: CloudScaling = { ...PIXEL_SCALING, mirrorX: true };
    const ring = ringOf(30, 30, (c) => 1000 + 25 * c);
    const v = viewOf(ring, iso, s);
    expect(v.display.scale[0]).toBeLessThan(0);
    const hit = shoot(ring, v, 5.5, 20, 1000 + 25 * 5.5)!;
    expect(hit.column).toBeCloseTo(5.5, 3);
    expect(pointUnits(hit, s, 1, W)[0]).toBeCloseTo(W - 1 - 5.5, 3);
    // From the other side too, where the ray runs toward the first column.
    const back = viewOf(ring, { yaw: 0, pitch: 25 * DEG }, s);
    expect(shoot(ring, back, 30.25, 9, 1000 + 25 * 30.25)!.column).toBeCloseTo(30.25, 3);
  });

  it('misses beside the cloud', () => {
    const ring = ringOf(30, 30, () => 1000);
    const v = viewOf(ring, top);
    expect(shoot(ring, v, -5, 10, 1000)).toBeNull();
    expect(shoot(ring, v, 10, 45, 1000)).toBeNull();
  });

  it('catches a lone point within the point size in points mode', () => {
    const ring = ringOf(30, 30, (c, k) => (c === 20 && k === 12 ? 2000 : 0));
    const v = viewOf(ring, iso);
    const at = transformPoint(v.mvp, gridToWorld(v.display, 20, 12, 2000));
    const ndc: [number, number] = [at[0] + 0.004, at[1] - 0.003];
    const ray = pickRay(v.mvp, ndc)!;
    // No surface around a lone point.
    expect(pickHeightfield(ray, ring, v.display)).toBeNull();
    const hit = pickHeightfield(ray, ring, v.display, { points: { mvp: v.mvp, ndc, radius: [0.01, 0.01] } })!;
    expect(hit).toEqual({ column: 20, k: 12, seq: 12, value: 2000 });
    // Out of reach of a smaller point.
    expect(pickHeightfield(ray, ring, v.display, { points: { mvp: v.mvp, ndc, radius: [0.002, 0.002] } })).toBeNull();
  });
});

describe('screenPoint', () => {
  it('maps NDC to CSS px, y down, and drops points behind the eye', () => {
    const ring = ringOf(30, 30, () => 1000);
    const v = viewOf(ring, top);
    const p = gridToWorld(v.display, 10, 10, 1000);
    const ndc = transformPoint(v.mvp, p);
    const s = screenPoint(v.mvp, p, [600, 400])!;
    expect(s.x).toBeCloseTo(((ndc[0] + 1) / 2) * 600, 6);
    expect(s.y).toBeCloseTo(((1 - ndc[1]) / 2) * 400, 6);
    const behind = screenPoint(v.mvp, [p[0], p[1], p[2] + 1e7], [600, 400]);
    expect(behind).toBeNull();
  });
});
