import type { FeatureState } from '../models/racs.models';
import {
  hasRegion,
  centerRegion,
  coverRegion,
  dragRegion,
  fullRegion,
  regionFromPoints,
  regionFromStates,
  regionLimits,
  regionWrites,
  snapRegion,
  type RegionLimits,
} from './region';

function state(name: string, value: number | null, extra: Partial<FeatureState> = {}): FeatureState {
  return {
    name,
    node_type: 'Integer',
    value: value === null ? null : String(value),
    available: true,
    locked: false,
    min: null,
    max: null,
    inc: null,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
    ...extra,
  };
}

const LIMITS: RegionLimits = {
  x: { extent: 2048, minSize: 16, sizeInc: 16, offsetInc: 8, hasOffset: true },
  y: { extent: 1024, minSize: 8, sizeInc: 4, offsetInc: 2, hasOffset: true },
};

describe('region', () => {
  it('reads the region and its limits from feature states', () => {
    const states = {
      Width: state('Width', 640, { min: 16, max: 1984, inc: 16 }),
      Height: state('Height', 480, { min: 8, max: 1000, inc: 4 }),
      OffsetX: state('OffsetX', 64, { inc: 8 }),
      OffsetY: state('OffsetY', 24, { inc: 2 }),
      WidthMax: state('WidthMax', 2048),
    };
    expect(regionFromStates(states)).toEqual({ x: 64, y: 24, width: 640, height: 480 });
    const limits = regionLimits(states)!;
    expect(limits.x).toEqual({ extent: 2048, minSize: 16, sizeInc: 16, offsetInc: 8, hasOffset: true });
    // No HeightMax: Height's max plus the offset beside it.
    expect(limits.y.extent).toBe(1024);
  });

  it('offers the region from the feature list, before any state is read', () => {
    expect(hasRegion(new Map([['Width', 1], ['Height', 1]]))).toBe(true);
    expect(hasRegion(new Set(['Width', 'Height', 'OffsetX']))).toBe(true);
    expect(hasRegion(new Set(['Width']))).toBe(false);
    expect(hasRegion(new Map())).toBe(false);
    expect(regionLimits({})).toBeNull();
  });

  it('anchors the region at 0 without offset features', () => {
    const limits = regionLimits({ Width: state('Width', 64, { max: 64 }), Height: state('Height', 32, { max: 128 }) })!;
    expect(limits.x.hasOffset).toBe(false);
    const moved = dragRegion({ x: 0, y: 0, width: 64, height: 32 }, 'move', 10, 10, limits);
    expect(moved).toEqual({ x: 0, y: 0, width: 64, height: 32 });
    const grown = dragRegion({ x: 0, y: 0, width: 64, height: 32 }, 'nw', -10, 20, limits);
    expect(grown).toEqual({ x: 0, y: 0, width: 64, height: 32 });
    expect(dragRegion({ x: 0, y: 0, width: 32, height: 32 }, 'se', -8, 20, limits)).toEqual({
      x: 0,
      y: 0,
      width: 24,
      height: 52,
    });
  });

  it('snaps onto the increments and inside the sensor', () => {
    expect(snapRegion({ x: 13, y: 3, width: 100, height: 51 }, LIMITS)).toEqual({ x: 16, y: 4, width: 96, height: 52 });
    expect(snapRegion({ x: 2040, y: 0, width: 500, height: 9 }, LIMITS)).toEqual({ x: 2032, y: 0, width: 16, height: 8 });
    expect(fullRegion(LIMITS)).toEqual({ x: 0, y: 0, width: 2048, height: 1024 });
  });

  it('keeps the opposite edge when dragging one side', () => {
    const start = { x: 512, y: 256, width: 512, height: 256 };
    const w = dragRegion(start, 'w', -100, 0, LIMITS);
    expect(w.x + w.width).toBeGreaterThanOrEqual(1024 - 8);
    expect(w.x + w.width).toBeLessThanOrEqual(1024 + 8);
    expect(w.x % 8).toBe(0);
    expect((w.width - 16) % 16).toBe(0);
    const se = dragRegion(start, 'se', 33, 9, LIMITS);
    expect(se).toEqual({ x: 512, y: 256, width: 544, height: 264 });
  });

  it('never shrinks below the minimum or leaves the sensor', () => {
    const start = { x: 512, y: 256, width: 512, height: 256 };
    expect(dragRegion(start, 'e', -10000, 0, LIMITS).width).toBe(16);
    const big = dragRegion(start, 'se', 10000, 10000, LIMITS);
    expect(big.x + big.width).toBeLessThanOrEqual(2048);
    expect(big.y + big.height).toBeLessThanOrEqual(1024);
    const moved = dragRegion(start, 'move', 5000, -5000, LIMITS);
    expect(moved).toEqual({ x: 1536, y: 0, width: 512, height: 256 });
  });

  it('draws a region from two points in any order', () => {
    expect(regionFromPoints({ x: 300, y: 200 }, { x: 100, y: 40 }, LIMITS)).toEqual({ x: 104, y: 40, width: 192, height: 160 });
  });

  it('centres a region', () => {
    expect(centerRegion({ x: 0, y: 0, width: 1024, height: 512 }, LIMITS)).toEqual({ x: 512, y: 256, width: 1024, height: 512 });
  });

  it('orders writes so offset + size stays inside the sensor', () => {
    // Moving right while growing: the offset first would overflow, so the order matters both ways.
    const grow = regionWrites({ x: 1024, y: 0, width: 512, height: 100 }, { x: 0, y: 0, width: 2048, height: 100 });
    expect(grow).toEqual([['OffsetX', '0'], ['Width', '2048']]);
    const shrink = regionWrites({ x: 0, y: 0, width: 2048, height: 100 }, { x: 1024, y: 0, width: 512, height: 100 });
    expect(shrink).toEqual([['Width', '512'], ['OffsetX', '1024']]);
    expect(regionWrites({ x: 0, y: 0, width: 64, height: 64 }, { x: 0, y: 8, width: 64, height: 32 })).toEqual([
      ['Height', '32'],
      ['OffsetY', '8'],
    ]);
  });

  describe('coverRegion', () => {
    it('rounds outwards onto the grid', () => {
      // x: offset grid 8, size 16 + k·16; y: offset grid 2, size 8 + k·4.
      const r = coverRegion({ x0: 101.5, y0: 33.2, x1: 300.2, y1: 70.9 }, LIMITS);
      expect(r).toEqual({ x: 96, y: 32, width: 208, height: 40 });
      expect(r.x <= 101.5 && r.x + r.width >= 300.2).toBe(true);
      expect(r.y <= 33.2 && r.y + r.height >= 70.9).toBe(true);
    });

    it('clips to the sensor and keeps the far edge inside', () => {
      expect(coverRegion({ x0: -50, y0: -3, x1: 3000, y1: 2000 }, LIMITS)).toEqual({ x: 0, y: 0, width: 2048, height: 1024 });
      const r = coverRegion({ x0: 2040, y0: 1019, x1: 2047.5, y1: 1023.5 }, LIMITS);
      expect(r.x + r.width).toBeLessThanOrEqual(2048);
      expect(r.y + r.height).toBeLessThanOrEqual(1024);
      expect(r.x).toBeLessThanOrEqual(2040);
      expect(r.y).toBeLessThanOrEqual(1019);
      expect(r.width).toBe(16);
    });

    it('anchors axes without an offset at 0', () => {
      const limits: RegionLimits = { ...LIMITS, y: { ...LIMITS.y, hasOffset: false } };
      expect(coverRegion({ x0: 10, y0: 500, x1: 20, y1: 510 }, limits)).toMatchObject({ y: 0, height: 512 });
    });
  });
});
