/**
 * Value statistics of point-cloud profiles for the display window: like `analyze()` in
 * `imaging/frame.ts`, but without the invalid value (no laser line), which would otherwise pin
 * the minimum to 0 and drown the histogram.
 */

import { HISTOGRAM_BINS, type FrameStats } from '../imaging/frame';

/** Min, max and histogram of the values that aren't `invalid`; `null` when there are none. */
export function analyzeProfiles(
  pixels: Uint8Array | Uint16Array,
  bitDepth: number,
  invalid = 0,
): FrameStats | null {
  const hist = new Uint32Array(HISTOGRAM_BINS);
  const shift = Math.max(0, bitDepth - Math.log2(HISTOGRAM_BINS));
  const lastBin = HISTOGRAM_BINS - 1;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v === invalid) {
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    const bin = v >> shift;
    hist[bin > lastBin ? lastBin : bin]++;
  }
  return min === Infinity ? null : { min, max, hist };
}

interface Segment {
  start: number;
  end: number;
  min: number;
  max: number;
  hist: Uint32Array;
}

/** Rows per segment: 1-row frames at several kHz must not keep thousands of histograms. */
const SEGMENT_ROWS = 64;

/**
 * Statistics of what a rolling buffer holds: frames come in as stats over their rows (by `seq`,
 * see `RowRing`), rows that leave the buffer are evicted. Adjacent small frames share a
 * segment, which is evicted once all its rows are gone, so the result can lag by a segment.
 */
export class RollingStats {
  private segments: Segment[] = [];
  private readonly total = new Uint32Array(HISTOGRAM_BINS);

  push(stats: FrameStats | null, seq: number, rows: number): void {
    const last = this.segments[this.segments.length - 1];
    if (last && last.end === seq && last.end - last.start < SEGMENT_ROWS) {
      last.end += rows;
      if (stats) {
        last.min = Math.min(last.min, stats.min);
        last.max = Math.max(last.max, stats.max);
        addInto(last.hist, stats.hist);
      }
    } else {
      this.segments.push({
        start: seq,
        end: seq + rows,
        min: stats?.min ?? Infinity,
        max: stats?.max ?? -Infinity,
        hist: stats ? Uint32Array.from(stats.hist) : new Uint32Array(HISTOGRAM_BINS),
      });
    }
    if (stats) {
      addInto(this.total, stats.hist);
    }
  }

  /** Forget the segments whose rows all lie before `seq`. */
  evictBefore(seq: number): void {
    let drop = 0;
    while (drop < this.segments.length && this.segments[drop].end <= seq) {
      const hist = this.segments[drop].hist;
      for (let i = 0; i < HISTOGRAM_BINS; i++) {
        this.total[i] -= hist[i];
      }
      drop++;
    }
    if (drop > 0) {
      this.segments = this.segments.slice(drop);
    }
  }

  current(): FrameStats | null {
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.segments) {
      min = Math.min(min, s.min);
      max = Math.max(max, s.max);
    }
    return min === Infinity ? null : { min, max, hist: Uint32Array.from(this.total) };
  }

  clear(): void {
    this.segments = [];
    this.total.fill(0);
  }
}

function addInto(into: Uint32Array, hist: Uint32Array): void {
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    into[i] += hist[i];
  }
}
