import { isPaletteId, paletteGradient, paletteLut, paletteStops, RAMP_STOPS, sampleStops, tokenRgb } from './palette';

/** Tokens as getComputedStyle would return them. */
function reader(tokens: Record<string, string>) {
  return (name: string) => tokens[name] ?? '';
}

const ramp = Object.fromEntries(
  Array.from({ length: RAMP_STOPS }, (_, i) => [`--ramp-viridis-${i + 1}`, ` ${i * 30} ${i * 30} ${i * 30}`]),
);

describe('paletteStops', () => {
  it('reads a ramp from its tokens, low to high', () => {
    const stops = paletteStops('viridis', reader(ramp));
    expect(stops.length).toBe(RAMP_STOPS);
    expect(stops[0]).toEqual([0, 0, 0]);
    expect(stops[8][0]).toBeCloseTo(240 / 255);
  });

  it('runs grey from faint to fg', () => {
    expect(paletteStops('grey', reader({ '--faint': '0 0 0', '--fg': '255 255 255' }))).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]);
  });

  it('falls back to grey when a ramp is missing', () => {
    const grey = paletteStops('grey', reader({ '--faint': '0 0 0', '--fg': '255 255 255' }));
    expect(paletteStops('magma', reader({ '--faint': '0 0 0', '--fg': '255 255 255' }))).toEqual(grey);
    expect(paletteStops('grey', reader({})).length).toBe(2);
  });
});

describe('the lookup table', () => {
  const stops: [number, number, number][] = [
    [0, 0, 0],
    [1, 0.5, 0],
    [1, 1, 1],
  ];

  it('interpolates between stops', () => {
    expect(sampleStops(stops, 0.25)).toEqual([0.5, 0.25, 0]);
    expect(sampleStops(stops, -1)).toEqual([0, 0, 0]);
    expect(sampleStops(stops, 2)).toEqual([1, 1, 1]);
  });

  it('spans the stops from the first entry to the last, opaque', () => {
    const lut = paletteLut(stops, 5);
    expect([...lut.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...lut.subarray(8, 12)]).toEqual([255, 128, 0, 255]);
    expect([...lut.subarray(16, 20)]).toEqual([255, 255, 255, 255]);
  });

  it('is a CSS gradient for the legend', () => {
    expect(paletteGradient(stops)).toBe(
      'linear-gradient(to right, rgb(0 0 0) 0.0%, rgb(255 128 0) 50.0%, rgb(255 255 255) 100.0%)',
    );
  });
});

describe('isPaletteId', () => {
  it('knows its palettes', () => {
    expect(isPaletteId('viridis')).toBe(true);
    expect(isPaletteId('jet')).toBe(false);
  });
});

describe('tokenRgb', () => {
  it('reads a colour token as shader channels', () => {
    expect(tokenRgb(' 255 0 51 ')).toEqual([1, 0, 0.2]);
    expect(tokenRgb('', [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
  });
});
