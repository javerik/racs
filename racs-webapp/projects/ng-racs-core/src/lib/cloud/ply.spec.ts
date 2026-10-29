import { countValid, encodePly, plyHeader } from './ply';
import { RowRing } from './ring';
import { PIXEL_SCALING } from './scaling';

async function parse(blob: Blob): Promise<{ header: string[]; points: number[][] }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const end = new TextDecoder().decode(bytes).indexOf('end_header\n') + 'end_header\n'.length;
  const header = new TextDecoder().decode(bytes.subarray(0, end)).trim().split('\n');
  const body = new DataView(bytes.buffer, bytes.byteOffset + end);
  const points: number[][] = [];
  for (let at = 0; at < body.byteLength; at += 12) {
    points.push([body.getFloat32(at, true), body.getFloat32(at + 4, true), body.getFloat32(at + 8, true)]);
  }
  return { header, points };
}

describe('plyHeader', () => {
  it('declares the vertices and keeps comments on one line', () => {
    expect(plyHeader(3, ['RACS\n#0'])).toBe(
      'ply\nformat binary_little_endian 1.0\ncomment RACS #0\nelement vertex 3\n' +
        'property float x\nproperty float y\nproperty float z\nend_header\n',
    );
  });
});

describe('encodePly', () => {
  it('writes the valid points of the oldest profile first, in units', async () => {
    const ring = new RowRing({ width: 3, layerRows: 2, layers: 1, capacity: 2 }, 'rolling');
    ring.push(new Uint16Array([10, 0, 30]), 1);
    ring.push(new Uint16Array([0, 50, 0]), 1);
    ring.push(new Uint16Array([70, 80, 0]), 1); // overwrites the first profile
    expect(countValid(ring)).toBe(3);

    const { header, points } = await parse(
      encodePly(ring, { ...PIXEL_SCALING, unit: 'mm', zScale: 0.5, zOffset: 1 }, { storeStride: 1, comments: ['x'] }),
    );
    expect(header).toContain('element vertex 3');
    expect(header).toContain('comment x');
    expect(points).toEqual([
      [1, 0, 26],
      [0, -1, 36],
      [1, -1, 41],
    ]);
  });

  it('runs a mirrored x from the last column', async () => {
    const ring = new RowRing({ width: 3, layerRows: 2, layers: 1, capacity: 2 }, 'stacked');
    ring.push(new Uint16Array([10, 0, 30]), 1);
    const s = { ...PIXEL_SCALING, unit: 'mm', xPitch: 0.5, mirrorX: true };
    const { points } = await parse(encodePly(ring, s, { storeStride: 1 }));
    expect(points).toEqual([
      [1, 0, 10],
      [0, 0, 30],
    ]);
  });

  it('writes an empty cloud as a valid file', async () => {
    const ring = new RowRing({ width: 2, layerRows: 2, layers: 1, capacity: 2 }, 'stacked');
    const { header, points } = await parse(encodePly(ring, PIXEL_SCALING, { storeStride: 1 }));
    expect(header).toContain('element vertex 0');
    expect(points).toEqual([]);
  });
});
