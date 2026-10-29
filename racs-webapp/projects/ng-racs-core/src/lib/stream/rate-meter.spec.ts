import { formatDataRate, RateMeter } from './rate-meter';

describe('RateMeter', () => {
  it('measures frames and bytes per second over its window', () => {
    const meter = new RateMeter(2000);
    // 15 fps of 3 MB frames for 3 s; only the last 2 s count.
    for (let i = 0; i <= 45; i++) {
      meter.add(i * (1000 / 15), 3_000_000);
    }
    const rate = meter.rate(3000)!;
    expect(rate.fps).toBeCloseTo(15, 5);
    expect(rate.bytesPerSecond).toBeCloseTo(45_000_000, 0);
  });

  it('knows nothing until two frames arrived', () => {
    const meter = new RateMeter();
    expect(meter.rate(0)).toBeNull();
    meter.add(0, 100);
    expect(meter.rate(10)).toBeNull();
    meter.add(100, 100);
    expect(meter.rate(100)).toEqual({ fps: 10, bytesPerSecond: 1000 });
  });

  it('goes back to unknown after a stall instead of keeping the last rate', () => {
    const meter = new RateMeter(2000);
    meter.add(0, 100);
    meter.add(100, 100);
    expect(meter.rate(1000)).not.toBeNull();
    expect(meter.rate(2500)).toBeNull();
  });

  it('starts over on reset', () => {
    const meter = new RateMeter();
    meter.add(0, 100);
    meter.add(100, 100);
    meter.reset();
    expect(meter.rate(100)).toBeNull();
  });
});

describe('formatDataRate', () => {
  it('uses decimal units', () => {
    expect(formatDataRate(45_210_000)).toBe('45.2 MB/s');
    expect(formatDataRate(820_400)).toBe('820 kB/s');
    expect(formatDataRate(512)).toBe('512 B/s');
  });
});
