import { decimate, niceTicks, paddedExtent, tickLabel } from './plot-scale';

describe('plot scale', () => {
  it('picks round ticks', () => {
    expect(niceTicks(0, 255, 5)).toEqual([0, 50, 100, 150, 200, 250]);
    expect(niceTicks(0.1, 0.95, 4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(3, 3, 5)).toEqual([3]);
  });

  it('pads the extent and widens a flat one', () => {
    expect(paddedExtent([0, 100], 0.1)).toEqual([-10, 110]);
    expect(paddedExtent([5, 5])).toEqual([4.75, 5.25]);
    expect(paddedExtent([NaN])).toBeNull();
  });

  it('keeps spikes when reducing a long series', () => {
    const n = 10000;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = xs.map((x) => (x === 5003 ? 999 : 1));
    const out = decimate(xs, ys, 0, n, 100);
    expect(out.xs.length).toBeLessThan(500);
    expect(Math.max(...out.ys)).toBe(999);
    expect(decimate([0, 1], [1, 2], 0, 1, 100).xs).toEqual([0, 1]);
  });

  it('labels ticks without float noise', () => {
    expect(tickLabel(0.30000000000000004)).toBe('0.3');
    expect(tickLabel(2e7)).toBe('2.0e+7');
  });
});
