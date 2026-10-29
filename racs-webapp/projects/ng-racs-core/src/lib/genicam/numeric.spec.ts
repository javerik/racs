import {
  decadeWindows,
  formatQuantity,
  formatSpan,
  formatValue,
  fromSlider,
  isUsableBound,
  SLIDER_STEPS,
  sliderRange,
  snap,
  toSlider,
  windowIndex,
} from './numeric';

describe('sliderRange', () => {
  it('needs two usable bounds', () => {
    expect(sliderRange(null, 10, null, null, true)).toBeNull();
    expect(sliderRange(0, 9_223_372_036_854_775_807, 1, null, true)).toBeNull();
    expect(sliderRange(5, 5, null, null, true)).toBeNull();
    expect(sliderRange(0, 100, 0.1, 'Linear', false)).toEqual({ min: 0, max: 100, inc: 0.1, log: false, integer: false });
  });

  it('uses a log scale when asked or when the range spans decades', () => {
    // The C6's ExposureTime: 0.01 µs to 1 s.
    expect(sliderRange(0.01, 1_000_000, 0.01, 'Linear', false)?.log).toBe(true);
    expect(sliderRange(1, 10, null, 'Logarithmic', false)?.log).toBe(true);
    expect(sliderRange(64, 2048, 32, 'Linear', true)?.log).toBe(false);
    // A log scale cannot start at zero.
    expect(sliderRange(0, 1e9, null, 'Logarithmic', false)?.log).toBe(false);
  });

  it('ignores a zero or unusable increment', () => {
    expect(sliderRange(0, 10, 0, null, true)?.inc).toBeNull();
    expect(isUsableBound(Number.NaN)).toBe(false);
  });
});

describe('snap', () => {
  it('moves onto the increment grid from the minimum and clamps', () => {
    const width = { min: 64, max: 2048, inc: 32, integer: true };
    expect(snap(100, width)).toBe(96);
    expect(snap(5000, width)).toBe(2048);
    expect(snap(0, width)).toBe(64);
  });

  it('keeps floats on the grid without binary noise', () => {
    expect(snap(0.30000000000000004, { min: 0, max: 100, inc: 0.1, integer: false })).toBe(0.3);
    expect(snap(12.3456, { min: 0.01, max: 1e6, inc: 0.01, integer: false })).toBe(12.35);
  });

  it('stays inside when max is off the grid', () => {
    expect(snap(99, { min: 0, max: 99, inc: 10, integer: true })).toBe(90);
  });
});

describe('slider mapping', () => {
  it('round-trips a linear range', () => {
    const r = sliderRange(0, 100, 0.1, null, false)!;
    expect(toSlider(50, r)).toBe(SLIDER_STEPS / 2);
    expect(fromSlider(SLIDER_STEPS / 2, r)).toBe(50);
  });

  it('spreads decades evenly on a log range', () => {
    const r = sliderRange(1, 1_000_000, 1, null, false)!;
    expect(toSlider(1000, r)).toBe(SLIDER_STEPS / 2);
    expect(fromSlider(SLIDER_STEPS / 2, r)).toBe(1000);
    expect(fromSlider(0, r)).toBe(1);
    expect(fromSlider(SLIDER_STEPS, r)).toBe(1_000_000);
  });
});

describe('formatValue', () => {
  it('formats by representation and appends the unit', () => {
    expect(formatValue('3232238183', 'IPV4Address', null)).toBe('192.168.10.103');
    expect(formatValue('154066456535856', 'MACAddress', null)).toBe('8C:1F:64:69:E3:30');
    expect(formatValue('255', 'HexNumber', null)).toBe('0xFF');
    expect(formatValue('1000', 'Linear', 'us')).toBe('1000 us');
    expect(formatValue('0.30000000000000004', null, '%')).toBe('0.3 %');
    expect(formatValue('Mono8', null, null)).toBe('Mono8');
  });
});

describe('decadeWindows', () => {
  it('splits a wide range into decades and merges the lowest ones', () => {
    // The AT C6's ExposureTime: 0.01 µs to 1 s.
    expect(decadeWindows(0.01, 1_000_000)).toEqual([
      { lo: 0.01, hi: 10 },
      { lo: 10, hi: 100 },
      { lo: 100, hi: 1000 },
      { lo: 1000, hi: 10_000 },
      { lo: 10_000, hi: 100_000 },
      { lo: 100_000, hi: 1_000_000 },
    ]);
  });

  it('clips to bounds that are not powers of ten', () => {
    expect(decadeWindows(15, 4000)).toEqual([
      { lo: 15, hi: 100 },
      { lo: 100, hi: 1000 },
      { lo: 1000, hi: 4000 },
    ]);
    expect(decadeWindows(0, 10)).toEqual([{ lo: 0, hi: 10 }]);
  });

  it('finds the window of a value', () => {
    const w = decadeWindows(1, 1000);
    expect(windowIndex(5, w)).toBe(0);
    expect(windowIndex(10, w)).toBe(0);
    expect(windowIndex(11, w)).toBe(1);
    expect(windowIndex(500, w)).toBe(2);
    expect(windowIndex(5000, w)).toBe(2);
  });
});

describe('formatQuantity', () => {
  it('scales durations to a readable unit', () => {
    expect(formatQuantity(67920.359375, 'us')).toBe('67.9 ms');
    expect(formatQuantity(1_000_000, 'us')).toBe('1 s');
    expect(formatQuantity(250, 'us')).toBe('250 µs');
    expect(formatQuantity(0.01, 'us')).toBe('10 ns');
    expect(formatQuantity(99.5, '%')).toBe('99.5 %');
    expect(formatQuantity(12.3456789, null)).toBe('12.3457');
  });
});

describe('formatSpan', () => {
  it('labels a range in the unit of its upper bound', () => {
    expect(formatSpan(100, 1000, 'us')).toBe('0.1–1 ms');
    expect(formatSpan(10, 100, 'us')).toBe('10–100 µs');
    expect(formatSpan(100_000, 1_000_000, 'us')).toBe('0.1–1 s');
    expect(formatSpan(64, 2048, null)).toBe('64–2048');
  });
});
