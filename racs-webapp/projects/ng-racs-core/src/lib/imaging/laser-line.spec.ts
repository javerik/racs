import type { GrayFrame } from './frame';
import { linePeaks, noiseSigma, toPlane, type Plane } from './laser-line';

/** A `w`×`h` 8-bit frame with a Gaussian line `y = y0 + slope·x` (or `x = …` with `vertical`). */
function lineFrame(w: number, h: number, y0: number, slope: number, opts: { sigma?: number; vertical?: boolean; noise?: number; on?: boolean } = {}): GrayFrame {
  const { sigma = 1.5, vertical = false, noise = 0, on = true } = opts;
  const pixels = new Uint8Array(w * h);
  let seed = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = vertical ? [y, x] : [x, y];
      const centre = y0 + slope * (u + 0.5);
      const lit = on ? 200 * Math.exp(-0.5 * ((v + 0.5 - centre) / sigma) ** 2) : 0;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      pixels[y * w + x] = Math.min(255, Math.round(10 + lit + noise * ((seed / 0x7fffffff) * 2 - 1)));
    }
  }
  return { width: w, height: h, bitDepth: 8, pixels };
}

describe('laser line', () => {
  it('finds sub-pixel peaks per column, at pixel centres', () => {
    const points = linePeaks(toPlane(lineFrame(64, 48, 20.3, 0)), 'x');
    expect(points.length).toBe(64);
    expect(points[0].u).toBe(0.5);
    points.forEach((p) => expect(Math.abs(p.v - 20.3)).toBeLessThan(0.1));
  });

  it('scans rows for a line running along y', () => {
    const points = linePeaks(toPlane(lineFrame(80, 100, 30, 0.1, { vertical: true })), 'y');
    expect(points.length).toBe(100);
    expect(Math.abs(points[50].v - (30 + 0.1 * 50.5))).toBeLessThan(0.1);
  });

  it('finds nothing in a blank frame, and skips peaks cut by the edge', () => {
    expect(linePeaks(toPlane(lineFrame(64, 48, 20, 0, { on: false, noise: 4 })), 'x')).toEqual([]);
    expect(linePeaks(toPlane(lineFrame(64, 48, 0.5, 0, { sigma: 3 })), 'x')).toEqual([]);
  });

  it('ignores hot pixels, even lined up in one column', () => {
    // Seen on the AT C6: column 1026 ten values bright in every 6th row of a blank frame.
    const hot = (f: GrayFrame) => {
      for (let y = 4; y < f.height; y += 6) f.pixels[y * f.width + 26] += 10;
      return f;
    };
    expect(linePeaks(toPlane(hot(lineFrame(64, 120, 20, 0, { on: false, noise: 1 }))), 'y')).toEqual([]);
    expect(linePeaks(toPlane(hot(lineFrame(64, 120, 20, 0, { on: false, noise: 1 }))), 'x')).toEqual([]);
    // A line keeps every column, the hot one too.
    const points = linePeaks(toPlane(hot(lineFrame(64, 120, 60.3, 0.2))), 'x');
    expect(points.length).toBe(64);
    points.forEach((p) => expect(Math.abs(p.v - (60.3 + 0.2 * p.u))).toBeLessThan(0.1));
  });

  it('skips columns with two peaks, and ignores a weaker ghost', () => {
    const mix = (a: GrayFrame, b: GrayFrame, k: number) => {
      for (let i = 0; i < a.pixels.length; i++) a.pixels[i] = Math.max(a.pixels[i], 10 + Math.round((b.pixels[i] - 10) * k));
      return a;
    };
    // Two equal lines: ambiguous.
    expect(linePeaks(toPlane(mix(lineFrame(64, 120, 40.3, 0), lineFrame(64, 120, 81.3, 0), 1)), 'x')).toEqual([]);
    // A display seen through glass: each line doubled 41 px away at half the height.
    const ghosted = linePeaks(toPlane(mix(lineFrame(64, 120, 40.3, 0), lineFrame(64, 120, 81.3, 0), 0.55)), 'x');
    expect(ghosted.length).toBe(64);
    ghosted.forEach((p) => expect(Math.abs(p.v - 40.3)).toBeLessThan(0.1));
  });

  it('estimates noise robustly', () => {
    const flat: Plane = { width: 100, height: 100, data: new Float32Array(10000).fill(5), max: 255 };
    expect(noiseSigma(flat)).toBe(0);
    expect(noiseSigma(toPlane(lineFrame(100, 100, 50, 0, { noise: 20 })))).toBeGreaterThan(5);
  });
});
