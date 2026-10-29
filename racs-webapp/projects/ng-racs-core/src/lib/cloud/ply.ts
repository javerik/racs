/**
 * Point clouds as binary PLY, the format CloudCompare, MeshLab and Open3D all read.
 *
 * Only valid points are written, in units and without the view's z stretch, oldest profile first,
 * with the axes the view uses (see `scaling.ts`; y runs negative from the first profile, and a
 * mirrored x runs from the last column).
 */

import type { RowRing } from './ring';
import { slotOf } from './ring';
import { toUnits, type CloudScaling } from './scaling';

export interface PlyOptions {
  /** The store keeps every `storeStride`-th profile. */
  storeStride: number;
  invalid?: number;
  /** `comment` lines for the header (no line breaks). */
  comments?: string[];
}

/** Points per body chunk, so a large cloud isn't one huge allocation. */
const CHUNK_POINTS = 1 << 20;
const BYTES_PER_POINT = 12;

/** How many points of the ring a PLY would hold. */
export function countValid(ring: RowRing, invalid = 0): number {
  let n = 0;
  forEachRow(ring, (slot) => {
    const row = ring.mirror.subarray(slot * ring.width, (slot + 1) * ring.width);
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== invalid) n++;
    }
  });
  return n;
}

export function plyHeader(vertices: number, comments: readonly string[] = []): string {
  return [
    'ply',
    'format binary_little_endian 1.0',
    ...comments.map((c) => `comment ${c.replace(/[\r\n]+/g, ' ')}`),
    `element vertex ${vertices}`,
    'property float x',
    'property float y',
    'property float z',
    'end_header',
    '',
  ].join('\n');
}

export function encodePly(ring: RowRing, s: CloudScaling, o: PlyOptions): Blob {
  const invalid = o.invalid ?? 0;
  let remaining = countValid(ring, invalid);
  const parts: BlobPart[] = [plyHeader(remaining, o.comments)];
  const nextChunk = () => {
    const n = Math.min(remaining, CHUNK_POINTS);
    remaining -= n;
    return new DataView(new ArrayBuffer(n * BYTES_PER_POINT));
  };
  let chunk = nextChunk();
  let at = 0;
  forEachRow(ring, (slot, k) => {
    const base = slot * ring.width;
    for (let c = 0; c < ring.width; c++) {
      const v = ring.mirror[base + c];
      if (v === invalid) {
        continue;
      }
      if (at === chunk.byteLength) {
        parts.push(chunk.buffer as ArrayBuffer);
        chunk = nextChunk();
        at = 0;
      }
      const [x, y, z] = toUnits(c, k, v, s, o.storeStride, ring.width);
      chunk.setFloat32(at, x, true);
      chunk.setFloat32(at + 4, y, true);
      chunk.setFloat32(at + 8, z, true);
      at += BYTES_PER_POINT;
    }
  });
  if (at > 0) {
    parts.push(chunk.buffer as ArrayBuffer);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Each held row, oldest first: its slot and its index `k` from the oldest. */
function forEachRow(ring: RowRing, fn: (slot: number, k: number) => void): void {
  const oldest = ring.oldestSlot();
  for (let k = 0; k < ring.filled; k++) {
    fn(slotOf(k, oldest, ring.capacity), k);
  }
}
