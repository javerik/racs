/** What arrived per second over the meter's window. */
export interface Rates {
  fps: number;
  bytesPerSecond: number;
}

/**
 * Frames and bytes per second over a sliding window of recent arrivals: the live stream's actual
 * rate as this browser receives it, as opposed to the fps limit asked for. Times are in ms
 * (`performance.now()`).
 */
export class RateMeter {
  private times: number[] = [];
  private sizes: number[] = [];

  constructor(private readonly windowMs = 2000) {}

  reset(): void {
    this.times = [];
    this.sizes = [];
  }

  /** A frame of `bytes` arrived at `now`. */
  add(now: number, bytes: number): void {
    this.times.push(now);
    this.sizes.push(bytes);
    this.prune(now);
  }

  /**
   * The rates at `now`, or `null` until two frames lie within the window: after a stall the
   * window empties and the rate goes back to unknown rather than freezing at its last value.
   */
  rate(now: number): Rates | null {
    this.prune(now);
    const n = this.times.length;
    if (n < 2) {
      return null;
    }
    const seconds = (this.times[n - 1] - this.times[0]) / 1000;
    if (seconds <= 0) {
      return null;
    }
    // The first frame opens the window; what follows it is what arrived in that time.
    let bytes = 0;
    for (let i = 1; i < n; i++) {
      bytes += this.sizes[i];
    }
    return { fps: (n - 1) / seconds, bytesPerSecond: bytes / seconds };
  }

  private prune(now: number): void {
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < now - this.windowMs) {
      drop++;
    }
    if (drop > 0) {
      this.times.splice(0, drop);
      this.sizes.splice(0, drop);
    }
  }
}

/** A data rate in decimal units: `45.2 MB/s`, `820 kB/s`. */
export function formatDataRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e6) {
    return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1e3) {
    return `${Math.round(bytesPerSecond / 1e3)} kB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}
