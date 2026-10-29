import type { ViewPoint } from '../laserline/protocol';
import type { Plane } from './laser-line';
import { toPlane } from './laser-line';
import { fitTilt, lineAngle, lineAxis, nextTilt, type TiltSample } from './line-tilt';
import { cameraHomography, renderPattern, renderSegment, type SyntheticCamera } from 'ng-racs-core/testing';

const VIEW: ViewPoint = [1200, 800];
const SENSOR = { width: 320, height: 240 };
const FIELD = { x: 250, y: 150, width: 640, height: 480 };
/** The field's middle row, in percent of the view. */
const MIDDLE_PCT = ((FIELD.y + FIELD.height / 2) / VIEW[1]) * 100;

function camera(roll: number, mirror = false, perspective = 0, noise = 2): SyntheticCamera {
  return { h: cameraHomography(FIELD, SENSOR, roll, mirror, perspective), sensor: SENSOR, viewPx: VIEW, noise };
}

function filmed(cam: SyntheticCamera, tilt: number, seed = 1): Plane {
  return toPlane(renderPattern(cam, { kind: 'line', orientation: 'Horizontal', position_pct: MIDDLE_PCT, tilt_deg: tilt }, seed));
}

/** The service's search, without frames: a coarse sweep, then secant steps. */
function level(cam: SyntheticCamera, start = 0): { tilt: number; samples: TiltSample[] } {
  const samples: TiltSample[] = [];
  const measure = (tilt: number) => {
    const a = lineAngle(filmed(cam, tilt, samples.length + 1), 'x')!;
    samples.push({ tilt, angle: a.angleDeg, rms: a.rms });
    return a.angleDeg;
  };
  for (const d of [-4, -2, 0, 2, 4]) measure(start + d);
  let tilt = nextTilt(samples)!;
  for (let i = 0; i < 4 && Math.abs(measure(tilt)) > 0.02; i++) tilt = nextTilt(samples)!;
  return { tilt, samples };
}

describe('line tilt', () => {
  it('measures the slant of a filmed line', () => {
    const level = lineAngle(filmed(camera(0), 0), 'x')!;
    expect(Math.abs(level.angleDeg)).toBeLessThan(0.05);
    expect(level.span).toBeGreaterThan(0.9);
    expect(level.rms).toBeLessThan(0.3);
    // A camera rolled 3° sees the level line 3° slanted (y down).
    expect(lineAngle(filmed(camera(3), 0), 'x')!.angleDeg).toBeCloseTo(3, 1);
    // Tilting the line by −3° in laserline levels it again.
    expect(Math.abs(lineAngle(filmed(camera(3), -3), 'x')!.angleDeg)).toBeLessThan(0.05);
  });

  it('measures lines running along the columns by rows', () => {
    const cam = camera(-2);
    const plane = toPlane(renderPattern(cam, { kind: 'line', orientation: 'Vertical', position_pct: 47, tilt_deg: 0 }));
    // A vertical line turned by −2° (y down) leans 2° towards −x as y grows: dv/du = tan(2°) in (row, column).
    expect(lineAngle(plane, 'y')!.angleDeg).toBeCloseTo(2, 1);
    expect(lineAxis(plane)).toBe('y');
    expect(lineAxis(filmed(cam, 0))).toBe('x');
    expect(lineAxis(toPlane(renderSegment(cam, null)))).toBeNull();
  });

  it('gives no angle without enough of a line', () => {
    const cam = camera(0);
    expect(lineAngle(toPlane(renderSegment(cam, null)), 'x')).toBeNull();
    // A stub covering a fifth of the frame.
    const y = FIELD.y + FIELD.height / 2;
    const stub = renderSegment(cam, { a: { x: FIELD.x + 260, y }, b: { x: FIELD.x + 380, y } });
    expect(lineAngle(toPlane(stub), 'x')).toBeNull();
  });

  it('finds the tilt that levels the line', () => {
    for (const [roll, mirror, perspective] of [
      [3, false, 0],
      [-7.5, false, 0],
      [4, true, 0],
      [-2, false, 0.00003],
    ] as const) {
      const cam = camera(roll, mirror, perspective);
      const { tilt, samples } = level(cam);
      const angle = lineAngle(filmed(cam, tilt, 99), 'x')!.angleDeg;
      expect(Math.abs(angle), `roll ${roll}, mirror ${mirror}`).toBeLessThan(0.03);
      // Mirrored, the line turns against the tilt.
      expect(Math.sign(fitTilt(samples)!.gain)).toBe(mirror ? -1 : 1);
      expect(samples.length).toBeLessThan(11);
    }
  });

  it('finds it through noise', () => {
    const cam = camera(1.5, false, 0, 8);
    const { tilt } = level(cam, 1);
    expect(tilt).toBeCloseTo(-1.5, 1);
  });

  it('has no model when the tilt does not turn the line', () => {
    const flat: TiltSample[] = [-2, 0, 2].map((tilt) => ({ tilt, angle: 1.2 + tilt * 0.01, rms: 0.1 }));
    expect(fitTilt(flat)).toBeNull();
    expect(nextTilt(flat)).toBeNull();
    expect(fitTilt([{ tilt: 0, angle: 1, rms: 0 }])).toBeNull();
  });

  it('steps by the secant near level', () => {
    const samples: TiltSample[] = [
      { tilt: -4, angle: -1.1, rms: 0 },
      { tilt: 0, angle: 2.9, rms: 0 },
      { tilt: -3, angle: -0.08, rms: 0 },
      { tilt: -2.9, angle: 0.02, rms: 0 },
    ];
    expect(nextTilt(samples)).toBeCloseTo(-2.92, 5);
  });
});
