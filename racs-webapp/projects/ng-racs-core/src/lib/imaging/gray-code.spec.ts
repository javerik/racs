import { applyHomography } from './homography';
import { decodeGray, downsample, grayBits, grayToBinary, meanDifference, solveTrimmed, type CodeFrames } from './gray-code';
import { cameraHomography, renderPattern, type SyntheticCamera } from 'ng-racs-core/testing';
import type { ViewPoint } from '../laserline/protocol';

const VIEW: ViewPoint = [1200, 800];
const SENSOR = { width: 320, height: 240 };

function film(cam: SyntheticCamera, factor: number): CodeFrames {
  const shot = (p: Parameters<typeof renderPattern>[1], seed: number) => downsample(renderPattern(cam, p, seed), factor);
  const bits = (orientation: 'Vertical' | 'Horizontal', extent: number) =>
    Array.from({ length: grayBits(extent) }, (_, bit) => shot({ kind: 'stripes', orientation, bit }, 10 + bit + (orientation === 'Vertical' ? 0 : 50)));
  return { black: shot({ kind: 'blank' }, 1), white: shot({ kind: 'white' }, 2), x: bits('Vertical', VIEW[0]), y: bits('Horizontal', VIEW[1]) };
}

describe('gray code', () => {
  it('converts codes and counts bits', () => {
    expect(grayToBinary(7)).toBe(5);
    expect([0, 1, 2, 3, 4, 1000].map((v) => grayToBinary(v ^ (v >>> 1)))).toEqual([0, 1, 2, 3, 4, 1000]);
    expect(grayBits(1920)).toBe(11);
    expect(grayBits(1024)).toBe(10);
  });

  it('downsamples by block means', () => {
    const frame = { width: 4, height: 2, bitDepth: 8, pixels: Uint8Array.from([0, 2, 4, 6, 2, 4, 6, 8]) };
    const s = downsample(frame, 2);
    expect([s.width, s.height, s.factor]).toEqual([2, 1, 2]);
    expect(Array.from(s.data)).toEqual([2, 6]);
    expect(meanDifference(s, s)).toBe(0);
  });

  for (const [name, field, angle] of [
    ['most of the view', { x: 100, y: 80, width: 1000, height: 640 }, 0],
    ['a small part of it, turned', { x: 560, y: 380, width: 120, height: 90 }, 4],
  ] as const) {
    it(`maps a camera seeing ${name}`, () => {
      const cam: SyntheticCamera = { h: cameraHomography(field, SENSOR, angle, false, 0.00001), sensor: SENSOR, viewPx: VIEW };
      const decoded = decodeGray(film(cam, 2), 20);
      expect(decoded.pairs.length).toBeGreaterThan(30);
      const solved = solveTrimmed(decoded.pairs)!;
      expect(solved.rms).toBeLessThan(1);
      const c = { x: field.x + field.width / 2, y: field.y + field.height / 2 };
      const a = applyHomography(solved.h, c);
      const b = applyHomography(cam.h, c);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
    });
  }

  it('finds nothing when the white view lights nothing', () => {
    const cam: SyntheticCamera = { h: cameraHomography({ x: 2000, y: 2000, width: 100, height: 100 }, SENSOR), sensor: SENSOR, viewPx: VIEW };
    const decoded = decodeGray(film(cam, 4), 20);
    expect(decoded.litPixels).toBe(0);
    expect(decoded.pairs).toEqual([]);
    expect(solveTrimmed([])).toBeNull();
  });
});
