import type { GrayFrame } from './frame';
import { clampRoi, lineProfile, rectBounds, rectProjection, roiHistogram, roiStats, TimeSeries, type Roi } from './roi';

/** value = x + 10·y on a 8×4 frame. */
function gradient(): GrayFrame {
  const width = 8;
  const height = 4;
  const pixels = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = x + 10 * y;
  return { width, height, bitDepth: 12, pixels };
}

function rect(x0: number, y0: number, x1: number, y1: number): Roi {
  return { id: 'a', name: 'R1', shape: 'rect', x0, y0, x1, y1, series: 0, thickness: 1 };
}

function line(x0: number, y0: number, x1: number, y1: number, thickness = 1): Roi {
  return { id: 'b', name: 'R2', shape: 'line', x0, y0, x1, y1, series: 1, thickness };
}

describe('roi', () => {
  it('clips a rect to the frame', () => {
    expect(rectBounds(rect(6, 3, 12, -2), { width: 8, height: 4 })).toEqual({ x0: 6, y0: 0, x1: 8, y1: 3 });
    expect(rectBounds(rect(9, 0, 12, 2), { width: 8, height: 4 })).toBeNull();
  });

  it('measures a rect', () => {
    const s = roiStats(gradient(), rect(1, 1, 3, 3))!;
    // 11 12 / 21 22
    expect(s.n).toBe(4);
    expect(s.min).toBe(11);
    expect(s.max).toBe(22);
    expect(s.mean).toBeCloseTo(16.5);
    expect(s.std).toBeCloseTo(Math.sqrt((5.5 ** 2 * 2 + 4.5 ** 2 * 2) / 4));
    expect(roiStats(gradient(), rect(20, 20, 30, 30))).toBeNull();
  });

  it('samples a line through pixel centres', () => {
    const p = lineProfile(gradient(), line(0.5, 1.5, 6.5, 1.5));
    expect(Array.from(p.xs)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(p.ys)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    const thick = lineProfile(gradient(), line(0.5, 1.5, 6.5, 1.5, 3));
    // Rows 0..2 averaged: +10 on the middle row.
    expect(thick.ys[0]).toBeCloseTo(10);
    const s = roiStats(gradient(), line(0.5, 1.5, 6.5, 1.5))!;
    expect(s.mean).toBeCloseTo(13);
    expect(s.n).toBe(7);
  });

  it('projects a rect onto columns or rows', () => {
    const x = rectProjection(gradient(), rect(2, 0, 4, 4), 'x');
    expect(Array.from(x.xs)).toEqual([2, 3]);
    expect(Array.from(x.ys)).toEqual([17, 18]);
    const y = rectProjection(gradient(), rect(0, 1, 2, 3), 'y');
    expect(Array.from(y.xs)).toEqual([1, 2]);
    expect(Array.from(y.ys)).toEqual([10.5, 20.5]);
  });

  it('bins a ROI histogram by the frame depth', () => {
    const h = roiHistogram(gradient(), rect(0, 0, 8, 4));
    expect(h.ys.reduce((a, b) => a + b, 0)).toBe(32);
    // 12 bit: 16 values per bin, so 0..7 and 10..15 land in bin 0.
    expect(h.ys[0]).toBe(14);
    expect(h.xs[0]).toBeCloseTo(7.5);
  });

  it('clamps into a smaller frame', () => {
    expect(clampRoi(rect(-4, 2, 20, 9), { width: 8, height: 4 })).toMatchObject({ x0: 0, y0: 2, x1: 8, y1: 4 });
  });

  it('keeps the last values of a time series', () => {
    const ts = new TimeSeries<number>(3);
    for (let i = 0; i < 5; i++) ts.push(i, i * 2);
    const s = ts.toSeries((v) => v);
    expect(Array.from(s.xs)).toEqual([2, 3, 4]);
    expect(Array.from(s.ys)).toEqual([4, 6, 8]);
  });
});
