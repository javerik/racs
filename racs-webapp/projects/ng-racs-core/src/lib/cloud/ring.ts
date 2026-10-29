/**
 * Profiles (rows) kept for the point cloud, in the layout the GPU texture has.
 *
 * Rows are stored by *slot*. The GPU holds them in a 2D array texture, `layerRows` rows per layer,
 * so a buffer taller than the texture size limit still fits; `mirror` is the same data on the CPU,
 * slot after slot, for uploads, a lost GL context, and the PLY export.
 *
 * - `rolling`: a ring. New rows go in at `seq % capacity`; once full, each overwrites the oldest.
 * - `stacked`: a snapshot. Frame `i` of a burst lands at its own rows, whatever order the frames
 *   arrive in; rows not written yet are zero, which the view treats as invalid and skips.
 *
 * A value of 0 means "no measurement" (Coord3D's invalid value), so zero rows double as gaps.
 */

export interface RingLayout {
  width: number;
  /** Rows per texture layer. */
  layerRows: number;
  layers: number;
  /** `layers * layerRows`: at least the rows asked for. */
  capacity: number;
}

/** A run of slots inside one texture layer. */
export interface RowSegment {
  slot: number;
  layer: number;
  /** The first slot's row within its layer. */
  y: number;
  rows: number;
}

export type RingMode = 'rolling' | 'stacked';

/** The texture layout for `rows` rows of `width` values, within the GPU's limits. */
export function ringLayout(width: number, rows: number, maxTextureSize: number, maxLayers: number): RingLayout {
  if (!(width >= 1) || !(rows >= 1)) {
    throw new Error(`invalid cloud size ${width}×${rows}`);
  }
  if (width > maxTextureSize) {
    throw new Error(`profiles of ${width} values exceed this GPU's texture limit of ${maxTextureSize}`);
  }
  const layers = Math.ceil(rows / maxTextureSize);
  if (layers > maxLayers) {
    throw new Error(`${rows} profiles exceed this GPU's ${maxLayers} × ${maxTextureSize} row limit`);
  }
  const layerRows = Math.ceil(rows / layers);
  return { width, layerRows, layers, capacity: layers * layerRows };
}

/** The slots `start..start+rows` (wrapping at the capacity), split at layer ends. */
export function ringSegments(start: number, rows: number, layout: RingLayout): RowSegment[] {
  const out: RowSegment[] = [];
  let slot = ((start % layout.capacity) + layout.capacity) % layout.capacity;
  let left = Math.min(rows, layout.capacity);
  while (left > 0) {
    const y = slot % layout.layerRows;
    const n = Math.min(left, layout.layerRows - y);
    out.push({ slot, layer: Math.floor(slot / layout.layerRows), y, rows: n });
    left -= n;
    slot = (slot + n) % layout.capacity;
  }
  return out;
}

export class RowRing {
  readonly mirror: Uint16Array;
  /** Rows ever written (rolling): the next row goes to slot `seq % capacity`. */
  seq = 0;
  /** Rows held: rolling, up to the capacity; stacked, up to the last slot written. */
  filled = 0;
  /** Changes when everything has to be uploaded again. */
  generation = 0;
  /** Dirty runs of slots, oldest first: `[start, rows]`. */
  private dirty: [number, number][] = [];
  private dirtyRows = 0;

  /**
   * @param rows what the cloud spans: a rolling buffer's length, or a snapshot's stored rows.
   *   Defaults to the capacity.
   */
  constructor(
    readonly layout: RingLayout,
    readonly mode: RingMode,
    readonly rows = layout.capacity,
  ) {
    this.mirror = new Uint16Array(layout.width * layout.capacity);
  }

  get width(): number {
    return this.layout.width;
  }

  get capacity(): number {
    return this.layout.capacity;
  }

  /** The slot of the oldest row held. */
  oldestSlot(): number {
    return this.mode === 'rolling' ? mod(this.seq - this.filled, this.capacity) : 0;
  }

  /** The `seq` of the oldest row held (always 0 for a snapshot). */
  oldestSeq(): number {
    return this.mode === 'rolling' ? this.seq - this.filled : 0;
  }

  /** Append `rows` rows (rolling). More than the capacity keeps the last of them. */
  push(pixels: Uint8Array | Uint16Array, rows: number): void {
    const w = this.width;
    const skip = Math.max(0, rows - this.capacity);
    const start = this.seq + skip;
    for (let r = skip; r < rows; r++) {
      const slot = (this.seq + r) % this.capacity;
      this.copyRow(pixels, r * w, slot);
    }
    this.markDirty(start, rows - skip);
    this.advance(rows);
  }

  /** Append `rows` rows of nothing (rolling): frames the stream dropped, so the cloud keeps scale. */
  gap(rows: number): void {
    if (rows <= 0) {
      return;
    }
    const n = Math.min(rows, this.capacity);
    const start = this.seq + rows - n;
    for (const seg of ringSegments(start, n, this.layout)) {
      this.mirror.fill(0, seg.slot * this.width, (seg.slot + seg.rows) * this.width);
    }
    this.markDirty(start, n);
    this.advance(rows);
  }

  /**
   * Store frame `index` of a snapshot of `rowsPerFrame`-row frames, keeping every `storeStride`-th
   * row of the whole snapshot (so the kept rows stay evenly spaced across frame borders).
   */
  writeStacked(index: number, rowsPerFrame: number, storeStride: number, pixels: Uint8Array | Uint16Array): void {
    const first = index * rowsPerFrame;
    const startRow = Math.ceil(first / storeStride) * storeStride - first;
    let lowest = -1;
    let highest = -1;
    for (let r = startRow; r < rowsPerFrame; r += storeStride) {
      const slot = (first + r) / storeStride;
      if (slot >= this.capacity) {
        break;
      }
      this.copyRow(pixels, r * this.width, slot);
      lowest = lowest < 0 ? slot : lowest;
      highest = slot;
    }
    if (highest >= 0) {
      this.markDirty(lowest, highest - lowest + 1);
      this.filled = Math.max(this.filled, highest + 1);
    }
  }

  /** The slots changed since the last call, as upload runs. */
  takeDirty(): RowSegment[] {
    const runs = this.dirtyRows >= this.capacity ? [[0, this.capacity] as [number, number]] : this.dirty;
    this.dirty = [];
    this.dirtyRows = 0;
    return runs.flatMap(([start, rows]) => ringSegments(start, rows, this.layout));
  }

  /** Every slot, for a fresh texture. */
  allSegments(): RowSegment[] {
    return ringSegments(0, this.capacity, this.layout);
  }

  clear(): void {
    this.mirror.fill(0);
    this.seq = 0;
    this.filled = 0;
    this.dirty = [];
    this.dirtyRows = 0;
    this.generation++;
  }

  private copyRow(pixels: Uint8Array | Uint16Array, from: number, slot: number): void {
    const w = this.width;
    // A Uint16Array.set widens 8-bit values as it copies.
    this.mirror.set(pixels.subarray(from, from + w), slot * w);
  }

  private advance(rows: number): void {
    this.seq += rows;
    this.filled = Math.min(this.capacity, this.filled + rows);
  }

  private markDirty(start: number, rows: number): void {
    if (rows <= 0 || this.dirtyRows >= this.capacity) {
      return;
    }
    const at = mod(start, this.capacity);
    const last = this.dirty[this.dirty.length - 1];
    if (last && mod(last[0] + last[1], this.capacity) === at) {
      last[1] += rows;
    } else {
      this.dirty.push([at, rows]);
    }
    this.dirtyRows += rows;
  }
}

/**
 * Which held rows to draw at a row stride: those whose global `seq` is a multiple of it, so a
 * decimated rolling cloud keeps sampling the same profiles as it scrolls instead of shimmering.
 * `kStart` counts from the oldest row held.
 */
export function drawRows(oldestSeq: number, filled: number, rowStride: number): { kStart: number; count: number } {
  const kStart = mod(-oldestSeq, rowStride);
  const count = kStart < filled ? Math.ceil((filled - kStart) / rowStride) : 0;
  return { kStart, count };
}

/** Column and row strides that bring `cols × rows` points within `maxPoints`, as fine as possible. */
export function chooseStrides(cols: number, rows: number, maxPoints: number): { col: number; row: number } {
  const points = (c: number, r: number) => Math.ceil(cols / c) * Math.ceil(rows / r);
  if (points(1, 1) <= maxPoints) {
    return { col: 1, row: 1 };
  }
  let s = 2;
  while (points(s, s) > maxPoints) {
    s++;
  }
  // One step finer along one axis may still fit.
  if (points(s - 1, s) <= maxPoints) {
    return { col: s - 1, row: s };
  }
  if (points(s, s - 1) <= maxPoints) {
    return { col: s, row: s - 1 };
  }
  return { col: s, row: s };
}

/** The smallest row stride that stores `totalRows` rows of `width` 16-bit values in `maxBytes`. */
export function storeStride(totalRows: number, width: number, maxBytes: number): number {
  const perRow = Math.max(1, width) * 2;
  let k = 1;
  while (Math.ceil(totalRows / k) * perRow > maxBytes) {
    k++;
  }
  return k;
}

/** The slot of held row `k` (counted from the oldest); the vertex shader does the same. */
export function slotOf(k: number, oldestSlot: number, capacity: number): number {
  return (oldestSlot + k) % capacity;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
