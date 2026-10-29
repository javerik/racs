import {
  chooseStrides,
  drawRows,
  ringLayout,
  ringSegments,
  RowRing,
  slotOf,
  storeStride,
  type RingLayout,
} from './ring';

/** `rows` rows of `width` values, row r filled with `base + r`. */
function rowsOf(width: number, rows: number, base: number): Uint16Array {
  const out = new Uint16Array(width * rows);
  for (let r = 0; r < rows; r++) {
    out.fill(base + r, r * width, (r + 1) * width);
  }
  return out;
}

/** The first value of each held row, oldest first, as the shader walks them. */
function heldRows(ring: RowRing): number[] {
  const out: number[] = [];
  for (let k = 0; k < ring.filled; k++) {
    out.push(ring.mirror[slotOf(k, ring.oldestSlot(), ring.capacity) * ring.width]);
  }
  return out;
}

describe('ringLayout', () => {
  it('fits a short buffer in one layer', () => {
    expect(ringLayout(2048, 4096, 8192, 256)).toEqual({ width: 2048, layerRows: 4096, layers: 1, capacity: 4096 });
  });

  it('spreads a tall buffer over layers of equal height', () => {
    const l = ringLayout(100, 20_000, 8192, 256);
    expect(l.layers).toBe(3);
    expect(l.layerRows).toBeLessThanOrEqual(8192);
    expect(l.capacity).toBeGreaterThanOrEqual(20_000);
  });

  it('refuses what the GPU cannot hold', () => {
    expect(() => ringLayout(9000, 10, 8192, 256)).toThrow(/texture limit/);
    expect(() => ringLayout(10, 8192 * 3, 8192, 2)).toThrow(/row limit/);
    expect(() => ringLayout(0, 10, 8192, 2)).toThrow();
  });
});

describe('ringSegments', () => {
  const layout: RingLayout = { width: 4, layerRows: 10, layers: 3, capacity: 30 };

  it('splits at layer ends and wraps at the capacity', () => {
    expect(ringSegments(25, 10, layout)).toEqual([
      { slot: 25, layer: 2, y: 5, rows: 5 },
      { slot: 0, layer: 0, y: 0, rows: 5 },
    ]);
    expect(ringSegments(8, 4, layout)).toEqual([
      { slot: 8, layer: 0, y: 8, rows: 2 },
      { slot: 10, layer: 1, y: 0, rows: 2 },
    ]);
  });

  it('never covers more than the ring', () => {
    const segs = ringSegments(3, 100, layout);
    expect(segs.reduce((n, s) => n + s.rows, 0)).toBe(30);
  });
});

describe('RowRing, rolling', () => {
  const layout: RingLayout = { width: 3, layerRows: 4, layers: 2, capacity: 8 };

  it('keeps the newest rows, oldest first, across the wrap', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(rowsOf(3, 5, 100), 5);
    expect(heldRows(ring)).toEqual([100, 101, 102, 103, 104]);
    ring.push(rowsOf(3, 5, 200), 5);
    expect(ring.filled).toBe(8);
    expect(ring.oldestSeq()).toBe(2);
    expect(heldRows(ring)).toEqual([102, 103, 104, 200, 201, 202, 203, 204]);
  });

  it('keeps only the last rows of a frame taller than the ring', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(rowsOf(3, 11, 0), 11);
    expect(heldRows(ring)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('widens 8-bit rows', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(new Uint8Array([1, 2, 255]), 1);
    expect([...ring.mirror.subarray(0, 3)]).toEqual([1, 2, 255]);
  });

  it('writes zero rows for a gap', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(rowsOf(3, 8, 1), 8);
    ring.gap(2);
    ring.push(rowsOf(3, 1, 50), 1);
    expect(heldRows(ring)).toEqual([4, 5, 6, 7, 8, 0, 0, 50]);
  });

  it('reports what changed as upload runs, then nothing', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(rowsOf(3, 3, 0), 3);
    ring.push(rowsOf(3, 3, 0), 3);
    expect(ring.takeDirty()).toEqual([
      { slot: 0, layer: 0, y: 0, rows: 4 },
      { slot: 4, layer: 1, y: 0, rows: 2 },
    ]);
    expect(ring.takeDirty()).toEqual([]);
    ring.push(rowsOf(3, 3, 0), 3); // slots 6, 7, 0
    expect(ring.takeDirty()).toEqual([
      { slot: 6, layer: 1, y: 2, rows: 2 },
      { slot: 0, layer: 0, y: 0, rows: 1 },
    ]);
  });

  it('uploads everything once more changed than it holds', () => {
    const ring = new RowRing(layout, 'rolling');
    for (let i = 0; i < 5; i++) {
      ring.push(rowsOf(3, 3, 0), 3);
    }
    expect(ring.takeDirty().reduce((n, s) => n + s.rows, 0)).toBe(8);
  });

  it('starts over on clear', () => {
    const ring = new RowRing(layout, 'rolling');
    ring.push(rowsOf(3, 3, 1), 3);
    const generation = ring.generation;
    ring.clear();
    expect(ring.generation).toBe(generation + 1);
    expect(ring.filled).toBe(0);
    expect(ring.mirror.every((v) => v === 0)).toBe(true);
  });
});

describe('RowRing, stacked', () => {
  it('puts each frame at its own rows, in any order', () => {
    const ring = new RowRing({ width: 2, layerRows: 12, layers: 1, capacity: 12 }, 'stacked', 12);
    ring.writeStacked(2, 4, 1, rowsOf(2, 4, 20));
    expect(ring.filled).toBe(12);
    ring.writeStacked(0, 4, 1, rowsOf(2, 4, 0));
    expect(heldRows(ring)).toEqual([0, 1, 2, 3, 0, 0, 0, 0, 20, 21, 22, 23]);
  });

  it('keeps every n-th row of the whole snapshot across frame borders', () => {
    const ring = new RowRing({ width: 1, layerRows: 6, layers: 1, capacity: 6 }, 'stacked', 6);
    // Three 4-row frames are rows 0..11; a stride of 2 keeps 0, 2, 4, 6, 8, 10.
    for (let i = 0; i < 3; i++) {
      ring.writeStacked(i, 4, 2, rowsOf(1, 4, i * 4));
    }
    expect(heldRows(ring)).toEqual([0, 2, 4, 6, 8, 10]);
    // A stride of 3 starts frame 1 at its second row (row 6 of the snapshot is frame 1's row 2).
    const odd = new RowRing({ width: 1, layerRows: 4, layers: 1, capacity: 4 }, 'stacked', 4);
    for (let i = 0; i < 3; i++) {
      odd.writeStacked(i, 4, 3, rowsOf(1, 4, i * 4));
    }
    expect(heldRows(odd)).toEqual([0, 3, 6, 9]);
  });
});

describe('drawRows', () => {
  it('samples rows by their global sequence number', () => {
    expect(drawRows(0, 10, 1)).toEqual({ kStart: 0, count: 10 });
    expect(drawRows(0, 10, 3)).toEqual({ kStart: 0, count: 4 });
    // Oldest row is seq 7: the first sampled is seq 9, two rows in.
    expect(drawRows(7, 10, 3)).toEqual({ kStart: 2, count: 3 });
    expect(drawRows(7, 2, 3)).toEqual({ kStart: 2, count: 0 });
  });
});

describe('chooseStrides', () => {
  it('draws everything that fits', () => {
    expect(chooseStrides(2048, 1000, 4e6)).toEqual({ col: 1, row: 1 });
  });

  it('thins as little as it can', () => {
    const s = chooseStrides(2048, 8192, 4e6);
    expect(Math.ceil(2048 / s.col) * Math.ceil(8192 / s.row)).toBeLessThanOrEqual(4e6);
    expect(Math.max(s.col, s.row)).toBe(3);
  });
});

describe('storeStride', () => {
  it('keeps every row that fits, and thins the rest', () => {
    expect(storeStride(1000, 2048, 256 * 2 ** 20)).toBe(1);
    expect(storeStride(500 * 1024, 2048, 256 * 2 ** 20)).toBe(8);
  });
});
