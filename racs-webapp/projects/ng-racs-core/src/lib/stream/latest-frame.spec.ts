import { LatestFrame } from './latest-frame';

/** A manual animation-frame queue. */
function frames() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => queue.push(cb),
    /** Run the animation frames due now. */
    tick: () => queue.splice(0).forEach((cb) => cb()),
    get waiting() {
      return queue.length;
    },
  };
}

describe('LatestFrame', () => {
  it('draws once per animation frame, only the newest of what arrived', () => {
    const raf = frames();
    const drawn: number[] = [];
    const latest = new LatestFrame<number>((n) => void drawn.push(n), raf.schedule);

    latest.push(1);
    latest.push(2);
    latest.push(3);
    expect(raf.waiting).toBe(1);
    raf.tick();
    expect(drawn).toEqual([3]);

    latest.push(4);
    raf.tick();
    raf.tick();
    expect(drawn).toEqual([3, 4]);
  });

  it('waits for an asynchronous draw before starting the next', async () => {
    const raf = frames();
    const drawn: number[] = [];
    let finish!: () => void;
    const latest = new LatestFrame<number>((n) => {
      drawn.push(n);
      return new Promise<void>((resolve) => (finish = resolve));
    }, raf.schedule);

    latest.push(1);
    raf.tick();
    latest.push(2);
    latest.push(3);
    raf.tick();
    expect(drawn).toEqual([1]);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    raf.tick();
    expect(drawn).toEqual([1, 3]);
  });

  it('draws nothing after clear', () => {
    const raf = frames();
    const drawn: number[] = [];
    const latest = new LatestFrame<number>((n) => void drawn.push(n), raf.schedule);
    latest.push(1);
    latest.clear();
    raf.tick();
    expect(drawn).toEqual([]);
  });

  it('keeps going after a draw that throws', () => {
    const raf = frames();
    const drawn: number[] = [];
    const latest = new LatestFrame<number>((n) => {
      if (n === 1) {
        throw new Error('bad frame');
      }
      drawn.push(n);
    }, raf.schedule);
    latest.push(1);
    expect(() => raf.tick()).toThrow('bad frame');
    latest.push(2);
    raf.tick();
    expect(drawn).toEqual([2]);
  });
});
