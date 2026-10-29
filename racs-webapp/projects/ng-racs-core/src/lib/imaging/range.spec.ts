import { analyze } from './frame';
import {
  defaultRangeSettings,
  edgeValue,
  loadRangeSettings,
  moveEdge,
  nearestEdge,
  resolveRange,
  saveRangeSettings,
  shiftWindow,
} from './range';

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

describe('resolveRange', () => {
  const stats = analyze({ width: 3, height: 1, bitDepth: 8, pixels: new Uint8Array([30, 40, 90]) });

  it('full spans the bit depth', () => {
    expect(resolveRange(defaultRangeSettings(8), 8, stats)).toEqual({ lo: 0, hi: 255 });
    expect(resolveRange(defaultRangeSettings(12), 12, null)).toEqual({ lo: 0, hi: 4095 });
  });

  it('manual uses the given window, clamped and ordered', () => {
    expect(resolveRange({ mode: 'manual', lo: 20, hi: 50 }, 8, stats)).toEqual({ lo: 20, hi: 50 });
    expect(resolveRange({ mode: 'manual', lo: 50, hi: 20 }, 8, stats)).toEqual({ lo: 20, hi: 50 });
    expect(resolveRange({ mode: 'manual', lo: -5, hi: 9000 }, 8, stats)).toEqual({ lo: 0, hi: 255 });
  });

  it('auto follows the image min and max', () => {
    expect(resolveRange({ mode: 'auto', lo: 0, hi: 0 }, 8, stats)).toEqual({ lo: 30, hi: 90 });
    // Nothing to measure yet: show everything rather than nothing.
    expect(resolveRange({ mode: 'auto', lo: 0, hi: 0 }, 8, null)).toEqual({ lo: 0, hi: 255 });
  });

  it('never returns an empty window', () => {
    const flat = analyze({ width: 2, height: 1, bitDepth: 8, pixels: new Uint8Array([255, 255]) });
    expect(resolveRange({ mode: 'auto', lo: 0, hi: 0 }, 8, flat)).toEqual({ lo: 254, hi: 255 });
    expect(resolveRange({ mode: 'manual', lo: 7, hi: 7 }, 8, null)).toEqual({ lo: 7, hi: 8 });
  });
});

describe('dragging the window', () => {
  it('puts the dragged line under the pointer', () => {
    // 0..255 across the histogram: lo=64 is drawn at 1/4, and so is the right of bin hi=63.
    expect(edgeValue(0.25, 255, 'lo')).toBe(64);
    expect(edgeValue(0.25, 255, 'hi')).toBe(63);
    expect(edgeValue(-1, 255, 'lo')).toBe(0);
    expect(edgeValue(2, 255, 'hi')).toBe(255);
    expect(edgeValue(0, 255, 'hi')).toBe(0);
  });

  it('stops an edge 1 LSB short of the other', () => {
    expect(moveEdge({ lo: 20, hi: 50 }, 'lo', 70, 255)).toEqual({ lo: 49, hi: 50 });
    expect(moveEdge({ lo: 20, hi: 50 }, 'hi', 3, 255)).toEqual({ lo: 20, hi: 21 });
    expect(moveEdge({ lo: 20, hi: 50 }, 'hi', 999, 255)).toEqual({ lo: 20, hi: 255 });
  });

  it('slides the window without changing its width', () => {
    expect(shiftWindow({ lo: 20, hi: 50 }, 10, 255)).toEqual({ lo: 30, hi: 60 });
    expect(shiftWindow({ lo: 20, hi: 50 }, -100, 255)).toEqual({ lo: 0, hi: 30 });
    expect(shiftWindow({ lo: 20, hi: 50 }, 500, 255)).toEqual({ lo: 225, hi: 255 });
  });

  it('picks the nearer edge', () => {
    expect(nearestEdge({ lo: 20, hi: 50 }, 5)).toBe('lo');
    expect(nearestEdge({ lo: 20, hi: 50 }, 40)).toBe('hi');
    expect(nearestEdge({ lo: 20, hi: 50 }, 200)).toBe('hi');
  });
});

describe('remembered settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps each scope apart, starting from its own fallback', () => {
    saveRangeSettings(0, 16, { mode: 'manual', lo: 10, hi: 20 });
    const auto = { mode: 'auto' as const, lo: 0, hi: 65535 };
    expect(loadRangeSettings(0, 16, 'racs.cloud.range', auto)).toEqual(auto);
    saveRangeSettings(0, 16, { mode: 'manual', lo: 9000, hi: 33000 }, 'racs.cloud.range');
    expect(loadRangeSettings(0, 16)).toEqual({ mode: 'manual', lo: 10, hi: 20 });
    expect(loadRangeSettings(0, 16, 'racs.cloud.range', auto)).toEqual({ mode: 'manual', lo: 9000, hi: 33000 });
  });
});
