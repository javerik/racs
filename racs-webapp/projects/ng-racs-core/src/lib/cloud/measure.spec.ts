import { crossSection, distance, neighbourhoodMedian, pointUnits, stepHeight } from './measure';
import { ringLayout, RowRing } from './ring';
import { PIXEL_SCALING, type CloudScaling } from './scaling';

const mm: CloudScaling = { unit: 'mm', xPitch: 0.05, ySpacing: 0.1, zScale: 0.001, zOffset: -2 };

describe('pointUnits', () => {
  it('is pixels, profiles and counts without a scaling', () => {
    expect(pointUnits({ column: 12.5, k: 3, value: 900 }, PIXEL_SCALING, 1, 100)).toEqual([12.5, -3, 900]);
  });

  it('applies the scaling and the store stride', () => {
    const p = pointUnits({ column: 200, k: 10, value: 15000 }, mm, 4, 800);
    expect(p[0]).toBeCloseTo(10);
    expect(p[1]).toBeCloseTo(-4);
    expect(p[2]).toBeCloseTo(13);
  });

  it('counts a mirrored x from the last column', () => {
    const p = pointUnits({ column: 0, k: 0, value: 2000 }, { ...mm, mirrorX: true }, 1, 801);
    expect(p[0]).toBeCloseTo(40);
  });
});

describe('distance', () => {
  it('gives the straight line and the differences from a to b', () => {
    expect(distance([1, 2, 3], [4, -2, 15])).toEqual({ d: 13, dx: 3, dy: -4, dz: 12 });
  });

  it('is zero for one point', () => {
    expect(distance([5, 5, 5], [5, 5, 5]).d).toBe(0);
  });
});

/** A rolling ring of `capacity` rows with `rows` pushed, value(column, seq) per cell. */
function ringOf(width: number, capacity: number, rows: number, value: (c: number, seq: number) => number): RowRing {
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

/** A floor at 12000 with a box 15000 higher over columns 20–29 and profiles 10–19. */
const box = (c: number, seq: number) => 12000 + (c >= 20 && c < 30 && seq >= 10 && seq < 20 ? 15000 : 0);

describe('neighbourhoodMedian', () => {
  it('takes the median of the valid values around the pick', () => {
    const ring = ringOf(40, 40, 40, (c, seq) => (c === 5 && seq === 5 ? 0 : 1000 + c));
    expect(neighbourhoodMedian(ring, { column: 5.3, seq: 4.8 }, 1)).toEqual({ value: 1005, n: 8 });
  });

  it('stays on the face a minority of the other one lies beside', () => {
    const ring = ringOf(40, 40, 40, box);
    // Two of five columns lie on the floor.
    expect(neighbourhoodMedian(ring, { column: 21, seq: 15 }, 2)?.value).toBe(27000);
  });

  it('reads the profile by its seq on a rolling ring', () => {
    const ring = ringOf(40, 16, 50, (c, seq) => 100 + seq);
    expect(ring.oldestSeq()).toBe(34);
    expect(neighbourhoodMedian(ring, { column: 10, seq: 40 }, 0)).toEqual({ value: 140, n: 1 });
    // Half outside the ring: only the held rows count.
    expect(neighbourhoodMedian(ring, { column: 10, seq: 34 }, 1)).toEqual({ value: 134.5, n: 6 });
  });

  it('is null with nothing valid', () => {
    const ring = ringOf(40, 40, 40, () => 0);
    expect(neighbourhoodMedian(ring, { column: 10, seq: 10 }, 2)).toBeNull();
  });
});

describe('stepHeight', () => {
  it('gives a box step its height, in counts and in mm', () => {
    const ring = ringOf(40, 40, 40, box);
    const floor = neighbourhoodMedian(ring, { column: 10, seq: 15 })!;
    const top = neighbourhoodMedian(ring, { column: 25, seq: 15 })!;
    expect(stepHeight(floor, top, PIXEL_SCALING)).toEqual({ za: 12000, zb: 27000, dz: 15000 });
    const h = stepHeight(floor, top, mm);
    expect(h.dz).toBeCloseTo(15);
    expect(h.za).toBeCloseTo(10);
    expect(h.zb).toBeCloseTo(25);
    expect(stepHeight(top, floor, mm).dz).toBeCloseTo(-15);
  });
});

describe('crossSection', () => {
  it('steps one cell at a time from a to b, with s along the segment', () => {
    const ring = ringOf(40, 40, 40, box);
    const x = crossSection(ring, { column: 15, seq: 15 }, { column: 35, seq: 15 }, mm, 1);
    expect(x.s.length).toBe(21);
    expect(x.s[0]).toBe(0);
    expect(x.s[20]).toBeCloseTo(20 * 0.05);
    expect(x.z[0]).toBeCloseTo(10);
    expect(x.z[5]).toBeCloseTo(25);
    expect(x.z[14]).toBeCloseTo(25);
    expect(x.z[15]).toBeCloseTo(10);
  });

  it('leaves invalid cells as gaps', () => {
    // A shadow beside the box, as a laser profiler sees it.
    const ring = ringOf(40, 40, 40, (c, seq) => (c >= 30 && c < 33 ? 0 : box(c, seq)));
    const x = crossSection(ring, { column: 25, seq: 15 }, { column: 35, seq: 15 }, PIXEL_SCALING, 1);
    expect(Array.from(x.z, (v) => (Number.isNaN(v) ? null : v))).toEqual([
      27000, 27000, 27000, 27000, 27000, null, null, null, 12000, 12000, 12000,
    ]);
  });

  it('is the same with a mirrored scaling: s from a, the columns from a to b', () => {
    const ring = ringOf(40, 40, 40, box);
    const a = { column: 15, seq: 12 };
    const b = { column: 35, seq: 17 };
    const plain = crossSection(ring, a, b, mm, 1);
    const mirrored = crossSection(ring, a, b, { ...mm, mirrorX: true }, 1);
    expect(Array.from(mirrored.s)).toEqual(Array.from(plain.s));
    expect(Array.from(mirrored.z)).toEqual(Array.from(plain.z));
    expect(plain.s[plain.s.length - 1]).toBeCloseTo(Math.hypot(20 * 0.05, 5 * 0.1));
    expect(plain.z[0]).toBeCloseTo(10);
    expect(plain.z[10]).toBeCloseTo(25);
  });

  it('spaces held rows by the store stride', () => {
    const ring = ringOf(40, 40, 40, (c, seq) => 1000 + seq);
    const x = crossSection(ring, { column: 5, seq: 10 }, { column: 5, seq: 20 }, mm, 3);
    expect(x.s.length).toBe(11);
    expect(x.s[10]).toBeCloseTo(10 * 0.1 * 3);
    expect(x.z[10] - x.z[0]).toBeCloseTo(10 * 0.001);
  });

  it('reads a rolling ring by seq, and has no values where the ring holds none', () => {
    const ring = ringOf(40, 16, 50, (c, seq) => 100 + seq);
    const x = crossSection(ring, { column: 5, seq: 30 }, { column: 5, seq: 40 }, PIXEL_SCALING, 1);
    expect(x.z.length).toBe(11);
    expect(x.z.slice(0, 4).every(Number.isNaN)).toBe(true);
    expect(x.z[4]).toBe(134);
    expect(x.z[10]).toBe(140);
  });

  it('is a single sample from a point to itself', () => {
    const ring = ringOf(40, 40, 40, box);
    const x = crossSection(ring, { column: 25, seq: 15 }, { column: 25, seq: 15 }, PIXEL_SCALING, 1);
    expect(Array.from(x.s)).toEqual([0]);
    expect(Array.from(x.z)).toEqual([27000]);
  });
});
