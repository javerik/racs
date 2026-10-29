import type { Envelope, ViewPoint } from '../laserline/protocol';
import { decodeGray, downsample, grayBits, solveTrimmed } from './gray-code';
import { applyHomography, invertHomography } from './homography';
import {
  cameraField,
  checkFrame,
  fieldFraction,
  fullWidth,
  overflowEdges,
  proposeRegion,
  regionInView,
  residualTiles,
  travelArea,
  type Calibration,
} from './laser-calibration';
import { toPlane } from './laser-line';
import type { RegionLimits } from './region';
import { cameraHomography, renderPattern, renderSegment, type SyntheticCamera } from 'ng-racs-core/testing';

const VIEW: ViewPoint = [1200, 800];
const SENSOR = { width: 320, height: 240 };
const LIMITS: RegionLimits = {
  x: { extent: 320, minSize: 16, sizeInc: 4, offsetInc: 4, hasOffset: true },
  y: { extent: 240, minSize: 8, sizeInc: 2, offsetInc: 2, hasOffset: true },
};

function envelope(x0: number, y0: number, x1: number, y1: number): Envelope {
  return {
    corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    center_px: [(x0 + x1) / 2, (y0 + y1) / 2],
    dir: [1, 0],
    normal: [0, 1],
    along_px: [-(x1 - x0) / 2, (x1 - x0) / 2],
    across_px: [-(y1 - y0) / 2, (y1 - y0) / 2],
  };
}

/** Calibrates `cam` from its Gray-code frames, as the service does. */
function calibrate(cam: SyntheticCamera): Calibration {
  const shot = (p: Parameters<typeof renderPattern>[1], seed: number) => downsample(renderPattern(cam, p, seed), 2);
  const bits = (orientation: 'Vertical' | 'Horizontal', extent: number) =>
    Array.from({ length: grayBits(extent) }, (_, bit) => shot({ kind: 'stripes', orientation, bit }, 10 + bit));
  const decoded = decodeGray({ black: shot({ kind: 'blank' }, 1), white: shot({ kind: 'white' }, 2), x: bits('Vertical', VIEW[0]), y: bits('Horizontal', VIEW[1]) }, 20);
  const solved = solveTrimmed(decoded.pairs)!;
  return { h: solved.h, viewPx: VIEW, sensor: SENSOR, rms: solved.rms, pairs: solved.used.length, at: 0 };
}

describe('laser calibration', () => {
  it('outlines the part of the view the camera sees', () => {
    const cam: SyntheticCamera = { h: cameraHomography({ x: 250, y: 150, width: 640, height: 480 }, SENSOR, 12, true, 0.00002), sensor: SENSOR, viewPx: VIEW };
    const cal = calibrate(cam);
    const f = cameraField(cal);
    const inv = invertHomography(cam.h)!;
    expect(f.length).toBe(4);
    for (const c of [{ x: 0, y: 0 }, { x: SENSOR.width, y: 0 }, { x: SENSOR.width, y: SENSOR.height }, { x: 0, y: SENSOR.height }]) {
      const want = applyHomography(inv, c);
      expect(Math.min(...f.map((p) => Math.hypot(p[0] - want.x, p[1] - want.y)))).toBeLessThan(3);
    }
    expect(fieldFraction(f, VIEW)).toBeGreaterThan(0.25);
    expect(fieldFraction(f, VIEW)).toBeLessThan(0.4);
  });

  it('clips the field to the view when the camera sees past its edge', () => {
    const cam: SyntheticCamera = { h: cameraHomography({ x: -200, y: -100, width: 800, height: 600 }, SENSOR), sensor: SENSOR, viewPx: VIEW };
    const f = cameraField(calibrate(cam));
    expect(Math.min(...f.map((p) => p[0]))).toBeGreaterThanOrEqual(0);
    expect(Math.min(...f.map((p) => p[1]))).toBeGreaterThanOrEqual(0);
    expect(fieldFraction(f, VIEW)).toBeCloseTo((600 * 500) / (1200 * 800), 1);
  });

  it('finds the sensor part that sees the view and maps a region back into the view', () => {
    // The camera sees view -200..600 × -100..500: its left 80 and top 40 sensor px see nothing.
    const cam: SyntheticCamera = { h: cameraHomography({ x: -200, y: -100, width: 800, height: 600 }, SENSOR), sensor: SENSOR, viewPx: VIEW };
    const cal = calibrate(cam);
    const t = travelArea(cal, LIMITS)!;
    expect(t.region.x).toBeGreaterThanOrEqual(76);
    expect(t.region.x).toBeLessThanOrEqual(80);
    expect(t.region.y).toBeGreaterThanOrEqual(38);
    expect(t.region.y).toBeLessThanOrEqual(40);
    expect(t.region.x + t.region.width).toBe(SENSOR.width);
    expect(t.region.y + t.region.height).toBe(SENSOR.height);
    // Back into the view, 8 px inside: view 0..600 × 0..500 shrunk by 8 × 2.5 view px.
    const poly = regionInView(cal, t.region, 8);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(t.region.x * 2.5 - 200 + 20, -1);
    expect(Math.max(...xs)).toBeCloseTo(600 - 20, -1);
    expect(Math.max(...ys)).toBeCloseTo(500 - 20, -1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    // A region too small for the margin keeps nothing.
    expect(regionInView(cal, { x: 100, y: 100, width: 16, height: 8 }, 8)).toEqual([]);
  });

  it('widens a region to the whole sensor width', () => {
    expect(fullWidth({ x: 68, y: 102, width: 184, height: 36 }, LIMITS)).toEqual({ x: 0, y: 102, width: 320, height: 36 });
  });

  it('averages the reprojection error per sensor tile', () => {
    const id = [1, 0, 0, 0, 1, 0, 0, 0, 1] as Calibration['h'];
    const tiles = residualTiles(id, [
      { from: { x: 10, y: 10 }, to: { x: 13, y: 14 } },
      { from: { x: 20, y: 20 }, to: { x: 20, y: 21 } },
      { from: { x: 300, y: 200 }, to: { x: 300, y: 200 } },
    ], SENSOR);
    expect(tiles[0]).toBeCloseTo(3);
    expect(tiles[8]).toBe(0);
    expect(tiles.filter((t) => t === null).length).toBe(7);
  });

  it('proposes a region around the envelope and reports overflow', () => {
    const cam: SyntheticCamera = { h: cameraHomography({ x: 200, y: 100, width: 800, height: 600 }, SENSOR), sensor: SENSOR, viewPx: VIEW };
    const cal = calibrate(cam);
    // 2.5 view px per sensor px: the envelope 400..800 × 380..420 is sensor 80..240 × 112..128.
    const ok = proposeRegion(cal, envelope(400, 380, 800, 420), LIMITS, 8);
    expect(ok.complete).toBe(true);
    expect(ok.axis).toBe('x');
    const r = ok.region;
    expect(r.x).toBeLessThanOrEqual(72);
    expect(r.x + r.width).toBeGreaterThanOrEqual(248);
    expect(r.y).toBeLessThanOrEqual(104);
    expect(r.y + r.height).toBeGreaterThanOrEqual(136);
    expect(r.width).toBeLessThan(190);
    const wide = proposeRegion(cal, envelope(100, 380, 900, 420), LIMITS, 8);
    expect(wide.complete).toBe(false);
    expect(overflowEdges(wide.overflow)).toEqual(['left']);
    expect(wide.overflow.left).toBeGreaterThan(40);
    expect(wide.region.x).toBe(0);
  });

  it('checks whether a frame shows the whole line', () => {
    const cam: SyntheticCamera = { h: cameraHomography({ x: 0, y: 0, width: 1200, height: 800 }, SENSOR), sensor: SENSOR, viewPx: VIEW };
    const inside = renderSegment(cam, { a: { x: 200, y: 400 }, b: { x: 1000, y: 400 } });
    expect(checkFrame(toPlane(inside), 'x')).toEqual({ state: 'complete', edges: [] });
    const cut = renderSegment(cam, { a: { x: 0, y: 400 }, b: { x: 1000, y: 400 } });
    expect(checkFrame(toPlane(cut), 'x')).toEqual({ state: 'cut', edges: ['left'] });
    expect(checkFrame(toPlane(renderSegment(cam, null)), 'x').state).toBe('none');
  });
});
