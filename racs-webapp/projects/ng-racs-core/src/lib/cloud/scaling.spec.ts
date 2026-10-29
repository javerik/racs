import {
  autoZExaggeration,
  cloudBounds,
  cloudDisplay,
  formatUnits,
  isPixelScaling,
  loadScaling,
  PIXEL_SCALING,
  pointTransform,
  sanitizeScaling,
  saveScaling,
  scalingFromCoordinates,
  scalingKey,
  toUnits,
  type CloudScaling,
} from './scaling';

/** The test environment has no localStorage of its own. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const mm: CloudScaling = { unit: 'mm', xPitch: 0.05, ySpacing: 0.1, zScale: 0.001, zOffset: 5 };

describe('sanitizeScaling', () => {
  it('keeps what is usable and replaces the rest', () => {
    expect(sanitizeScaling(mm)).toEqual(mm);
    expect(sanitizeScaling({ unit: ' µm ', xPitch: -1, ySpacing: 0, zScale: 0, zOffset: NaN })).toEqual({
      ...PIXEL_SCALING,
      unit: 'µm',
    });
    expect(sanitizeScaling(null)).toEqual(PIXEL_SCALING);
    expect(sanitizeScaling({ zScale: -2 }).zScale).toBe(-2);
  });

  it('keeps a mirror and a source, and drops what is neither', () => {
    const laser = { ...mm, mirrorX: true, source: 'laserline' } as const;
    expect(sanitizeScaling(laser)).toEqual(laser);
    const junk = sanitizeScaling({ ...mm, mirrorX: 'yes', source: 'guess' });
    expect('mirrorX' in junk).toBe(false);
    expect('source' in junk).toBe(false);
    // A field left out keeps the base's, as the others do.
    expect(sanitizeScaling({ xPitch: 2 }, laser)).toEqual({ ...laser, xPitch: 2 });
  });

  it('counts a mirror as calibrated', () => {
    expect(isPixelScaling(PIXEL_SCALING)).toBe(true);
    expect(isPixelScaling({ ...PIXEL_SCALING, mirrorX: false, source: 'manual' })).toBe(true);
    expect(isPixelScaling({ ...PIXEL_SCALING, mirrorX: true })).toBe(false);
  });
});

describe('storage', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('keys a camera by its MAC, else by its id, and not before it is known', () => {
    expect(scalingKey({ id: 3, mac: '00:11:22:AA:BB:CC' })).toBe('racs.cloud.scaling.00:11:22:aa:bb:cc');
    expect(scalingKey({ id: 3, mac: '' })).toBe('racs.cloud.scaling.id3');
    expect(scalingKey(undefined)).toBeNull();
  });

  it('round-trips, and forgets a reset to pixels', () => {
    saveScaling('k', mm);
    expect(loadScaling('k')).toEqual(mm);
    saveScaling('k', PIXEL_SCALING);
    expect(localStorage.getItem('k')).toBeNull();
    expect(loadScaling('k')).toEqual(PIXEL_SCALING);
  });

  it('loads a scaling stored before the mirror and the source, without adding them', () => {
    localStorage.setItem('k', '{"unit":"mm","xPitch":0.05,"ySpacing":0.1,"zScale":0.001,"zOffset":5}');
    const s = loadScaling('k');
    expect(s).toEqual(mm);
    expect(Object.keys(s)).toEqual(['unit', 'xPitch', 'ySpacing', 'zScale', 'zOffset']);
  });

  it('keeps a mirrored pixel scaling', () => {
    saveScaling('k', { ...PIXEL_SCALING, mirrorX: true });
    expect(loadScaling('k')).toEqual({ ...PIXEL_SCALING, mirrorX: true });
  });

  it('keeps a pixel scaling that names another source, and drops a manual one', () => {
    saveScaling('k', { ...PIXEL_SCALING, source: 'laserline' });
    expect(loadScaling('k')).toEqual({ ...PIXEL_SCALING, source: 'laserline' });
    saveScaling('k', { ...PIXEL_SCALING, source: 'manual' });
    expect(localStorage.getItem('k')).toBeNull();
  });
});

describe('scalingFromCoordinates', () => {
  it('maps A, B and C onto x, y and z', () => {
    const s = scalingFromCoordinates(
      {
        A: { scale: 0.05, offset: 0, unit: 'mm' },
        B: { scale: 0.1, offset: 0, unit: 'mm' },
        C: { scale: 0.001, offset: 2, unit: 'mm' },
      },
      PIXEL_SCALING,
    );
    expect(s).toEqual({ unit: 'mm', xPitch: 0.05, ySpacing: 0.1, zScale: 0.001, zOffset: 2 });
  });

  it('keeps what the camera leaves out or reports as zero', () => {
    const s = scalingFromCoordinates({ B: { scale: 0, offset: null, unit: null } }, mm);
    expect(s).toEqual(mm);
  });
});

describe('positions', () => {
  const mirrored: CloudScaling = { ...mm, mirrorX: true };

  it('runs profiles toward −Y and applies scale and offset to the value', () => {
    expect(toUnits(10, 4, 1000, mm, 2, 101)).toEqual([0.5, -0.8, 6]);
  });

  it('counts a mirrored x back from the last column', () => {
    expect(toUnits(10, 4, 1000, mirrored, 2, 101)).toEqual([4.5, -0.8, 6]);
    expect(toUnits(0, 0, 1, mirrored, 1, 101)[0]).toBeCloseTo(5);
    expect(toUnits(100, 0, 1, mirrored, 1, 101)[0]).toBe(0);
  });

  for (const [name, s] of [
    ['plain', mm],
    ['mirrored', mirrored],
  ] as const) {
    it(`matches what the shader computes (${name})`, () => {
      const { scale, offset } = pointTransform(s, 2, 3, 5, 101);
      const shader = (c: number, k: number, v: number) => [
        c * scale[0] + offset[0],
        k * scale[1] + offset[1],
        v * scale[2] + offset[2],
      ];
      for (const c of [0, 10, 100]) {
        const [x, y, z] = shader(c, 4, 1000);
        const units = toUnits(c, 4 + 5, 1000, s, 2, 101);
        expect(x).toBeCloseTo(units[0]);
        expect(y).toBeCloseTo(units[1]);
        expect(z).toBeCloseTo(units[2] * 3);
      }
    });
  }

  it('hands the shader a negative x scale when mirrored', () => {
    const { scale, offset } = pointTransform(mirrored, 1, 1, 0, 101);
    expect(scale[0]).toBe(-0.05);
    expect(offset[0]).toBeCloseTo(5);
  });
});

describe('bounds', () => {
  it('spans the columns, rows and value window', () => {
    expect(cloudBounds(101, 11, 1, PIXEL_SCALING, 100, 200)).toEqual({ min: [0, -10, 100], max: [100, 0, 200] });
    // A negative scale flips the value range but the box stays ordered.
    const b = cloudBounds(2, 2, 1, { ...PIXEL_SCALING, zScale: -1 }, 100, 200);
    expect(b.min[2]).toBe(-200);
    expect(b.max[2]).toBe(-100);
  });

  it('stretches raw counts down to a fraction of the footprint', () => {
    const exag = autoZExaggeration(2048, 1000, 1, PIXEL_SCALING, 9000, 33000);
    const b = cloudBounds(2048, 1000, 1, PIXEL_SCALING, 9000, 33000, exag);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0.35 * 2047);
    expect(autoZExaggeration(10, 10, 1, PIXEL_SCALING, 5, 5)).toBe(1);
  });
});

describe('cloudDisplay', () => {
  const zOf = (d: ReturnType<typeof cloudDisplay>, v: number) => v * d.scale[2] + d.offset[2];

  it('puts the lowest value at z = 0 and the highest at the top of the box', () => {
    const d = cloudDisplay(100, 50, 1, mm, 9000, 33000, 2, 0);
    expect(zOf(d, 9000)).toBeCloseTo(0);
    expect(zOf(d, 33000)).toBeCloseTo(d.box.max[2]);
    expect(d.box.max[2]).toBeCloseTo(24 * 2);
  });

  it('keeps the box shape with an automatic stretch, whatever the values span', () => {
    const narrow = cloudDisplay(1024, 640, 1, PIXEL_SCALING, 9000, 15000, 'auto', 0);
    const wide = cloudDisplay(1024, 640, 1, PIXEL_SCALING, 9000, 33000, 'auto', 0);
    expect(narrow.box).toEqual(wide.box);
    expect(wide.exag).toBeLessThan(narrow.exag);
  });

  it('stretches each axis for the view only', () => {
    const plain = cloudDisplay(100, 50, 1, mm, 9000, 33000, 2, 0);
    const d = cloudDisplay(100, 50, 1, mm, 9000, 33000, 2, 0, [2, 0.5, 3]);
    expect(d.box.max[0]).toBeCloseTo(plain.box.max[0] * 2);
    expect(d.box.min[1]).toBeCloseTo(plain.box.min[1] * 0.5);
    expect(d.box.max[2]).toBeCloseTo(plain.box.max[2] * 3);
    expect(d.exag).toBeCloseTo(6);
    expect(zOf(d, 9000)).toBeCloseTo(0);
    expect(d.scale[0]).toBeCloseTo(plain.scale[0] * 2);
    expect(d.scale[1]).toBeCloseTo(plain.scale[1] * 0.5);
  });

  it('keeps the box in place when mirrored, and fills it from the other end', () => {
    const plain = cloudDisplay(100, 50, 1, mm, 9000, 33000, 2, 0, [2, 1, 1]);
    const d = cloudDisplay(100, 50, 1, { ...mm, mirrorX: true }, 9000, 33000, 2, 0, [2, 1, 1]);
    expect(d.box).toEqual(plain.box);
    expect(d.scale[0]).toBeCloseTo(-plain.scale[0]);
    const xOf = (t: typeof d, c: number) => c * t.scale[0] + t.offset[0];
    expect(xOf(d, 0)).toBeCloseTo(d.box.max[0]);
    expect(xOf(d, 99)).toBeCloseTo(d.box.min[0]);
    expect(xOf(d, 30)).toBeCloseTo(xOf(plain, 69));
  });

  it('sizes the automatic z stretch to the stretched footprint, then applies the z factor', () => {
    const plain = cloudDisplay(1024, 640, 1, PIXEL_SCALING, 9000, 15000, 'auto', 0);
    const wide = cloudDisplay(1024, 640, 1, PIXEL_SCALING, 9000, 15000, 'auto', 0, [2, 1, 1]);
    expect(wide.box.max[2]).toBeCloseTo(plain.box.max[2] * 2);
    const tall = cloudDisplay(1024, 640, 1, PIXEL_SCALING, 9000, 15000, 'auto', 0, [1, 1, 4]);
    expect(tall.exag).toBeCloseTo(plain.exag * 4);
  });
});

describe('formatUnits', () => {
  it('is short', () => {
    expect(formatUnits(2047)).toBe('2047');
    expect(formatUnits(51.15)).toBe('51.15');
    expect(formatUnits(0.0123456)).toBe('0.0123');
    expect(formatUnits(0)).toBe('0');
  });
});
