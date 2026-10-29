import { fitScale, formatScale, fromFramePixel, loadView, pinchScale, rotateQuarter, rotatedSize, saveView, toFramePixel, zoomStep } from './view';

const FRAME = { width: 4, height: 2 };

describe('view geometry', () => {
  it('turns in quarter turns both ways', () => {
    expect(rotateQuarter(0, 1)).toBe(90);
    expect(rotateQuarter(270, 1)).toBe(0);
    expect(rotateQuarter(0, -1)).toBe(270);
    expect(rotateQuarter(90, -1)).toBe(0);
  });

  it('swaps the extent on a quarter turn', () => {
    expect(rotatedSize(FRAME, 90)).toEqual({ width: 2, height: 4 });
    expect(rotatedSize(FRAME, 180)).toEqual(FRAME);
  });

  it('fits the rotated frame into the box', () => {
    expect(fitScale({ width: 2048, height: 1088 }, 0, { width: 1024, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 2048, height: 1088 }, 90, { width: 1024, height: 1024 })).toBeCloseTo(1024 / 2048);
    expect(fitScale(FRAME, 0, { width: 0, height: 0 })).toBe(1);
  });

  it('places a frame pixel on screen as the inverse of the readout', () => {
    const frame = { width: 5, height: 3 };
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const scale of [0.5, 1, 3]) {
        for (let y = 0; y < frame.height; y++) {
          for (let x = 0; x < frame.width; x++) {
            const at = fromFramePixel({ x, y }, frame, rotation, scale);
            expect(toFramePixel(at, frame, rotation, scale)).toEqual({ x, y });
          }
        }
      }
    }
  });

  it('scales with the pinch, within the zoom steps', () => {
    expect(pinchScale(1, 100, 200)).toBe(2);
    expect(pinchScale(0.5, 200, 100)).toBe(0.25);
    expect(pinchScale(8, 10, 1000)).toBe(16);
    expect(pinchScale(0.1, 1000, 10)).toBe(0.0625);
    expect(pinchScale(1, 0, 50)).toBe(1);
  });

  it('zooms through the steps from any scale', () => {
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1, -1)).toBe(0.75);
    expect(zoomStep(0.3, 1)).toBe(0.5);
    expect(zoomStep(0.3, -1)).toBe(0.25);
    expect(zoomStep(16, 1)).toBe(16);
    expect(zoomStep(0.0625, -1)).toBe(0.0625);
  });

  it('maps a screen point back to the frame pixel for every rotation', () => {
    // Frame 4×2 at scale 10. Its pixel (3, 0), the top-right corner, sits on screen at:
    //   0°: top-right; 90° (clockwise): bottom-right; 180°: bottom-left; 270°: top-left.
    const corner = { x: 3, y: 0 };
    expect(toFramePixel({ x: 35, y: 5 }, FRAME, 0, 10)).toEqual(corner);
    expect(toFramePixel({ x: 15, y: 35 }, FRAME, 90, 10)).toEqual(corner);
    expect(toFramePixel({ x: 5, y: 15 }, FRAME, 180, 10)).toEqual(corner);
    expect(toFramePixel({ x: 5, y: 5 }, FRAME, 270, 10)).toEqual(corner);
  });

  it('reports nothing outside the frame', () => {
    expect(toFramePixel({ x: -1, y: 5 }, FRAME, 0, 10)).toBeNull();
    expect(toFramePixel({ x: 25, y: 5 }, FRAME, 90, 10)).toBeNull();
  });

  it('formats scales as percent', () => {
    expect(formatScale(1)).toBe('100 %');
    expect(formatScale(0.0625)).toBe('6.3 %');
    expect(formatScale(0.4567)).toBe('46 %');
  });
});

describe('view persistence', () => {
  function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k) => data.get(k) ?? null,
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
      setItem: (k, v) => void data.set(k, String(v)),
    };
  }

  it('round-trips and rejects junk', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveView({ rotation: 90, scale: 2 }, 'k');
    expect(loadView('k')).toEqual({ rotation: 90, scale: 2 });
    localStorage.setItem('k', '{"rotation":45,"scale":1000}');
    expect(loadView('k')).toEqual({ rotation: 0, scale: 'fit' });
    localStorage.setItem('k', 'not json');
    expect(loadView('k')).toEqual({ rotation: 0, scale: 'fit' });
    vi.unstubAllGlobals();
  });
});

describe('space mapping', () => {
  it('maps continuous points both ways at every rotation', async () => {
    const { fromSpacePoint, toSpacePoint, placeRect } = await import('./view');
    const space = { width: 40, height: 20 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const p = { x: 12.25, y: 7.5 };
      const screen = fromSpacePoint(p, space, rotation, 2);
      const back = toSpacePoint(screen, space, rotation, 2);
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
    expect(placeRect({ x: 10, y: 5, width: 8, height: 4 }, space, 0, 2)).toEqual({ x: 20, y: 10, width: 16, height: 8 });
    // A quarter turn clockwise: the rect's left edge becomes its top, measured from the right.
    expect(placeRect({ x: 10, y: 5, width: 8, height: 4 }, space, 90, 1)).toEqual({ x: 11, y: 10, width: 4, height: 8 });
  });
});
