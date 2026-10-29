import { analyzeProfiles, RollingStats } from './stats';

describe('analyzeProfiles', () => {
  it('leaves the invalid value out', () => {
    const s = analyzeProfiles(new Uint16Array([0, 9000, 0, 33000, 12000]), 16)!;
    expect([s.min, s.max]).toEqual([9000, 33000]);
    expect(s.hist.reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.hist[9000 >> 8]).toBe(1);
  });

  it('has nothing to say about a frame without a measurement', () => {
    expect(analyzeProfiles(new Uint16Array(10), 16)).toBeNull();
  });
});

describe('RollingStats', () => {
  const frame = (...values: number[]) => analyzeProfiles(new Uint16Array(values), 16);

  it('covers what the buffer holds and forgets what left it', () => {
    const r = new RollingStats();
    r.push(frame(1000, 2000), 0, 100);
    r.push(frame(5000), 100, 100);
    expect(r.current()!.min).toBe(1000);
    expect(r.current()!.max).toBe(5000);
    r.evictBefore(100);
    expect(r.current()!.min).toBe(5000);
    expect(r.current()!.hist.reduce((a, b) => a + b, 0)).toBe(1);
    r.evictBefore(200);
    expect(r.current()).toBeNull();
  });

  it('joins small frames, keeping a segment until all its rows are gone', () => {
    const r = new RollingStats();
    for (let seq = 0; seq < 10; seq++) {
      r.push(frame(1000 + seq), seq, 1);
    }
    r.evictBefore(5);
    expect(r.current()!.min).toBe(1000);
    r.evictBefore(10);
    expect(r.current()).toBeNull();
  });

  it('counts empty frames as rows without values', () => {
    const r = new RollingStats();
    r.push(null, 0, 100);
    r.push(frame(3000), 100, 100);
    r.evictBefore(100);
    expect(r.current()!.min).toBe(3000);
  });
});
