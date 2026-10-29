import { crc32, zipStore } from './zip';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('zipStore', () => {
  it('writes stored entries with a central directory that points back at them', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new TextEncoder().encode('{"x":1}');
    const zip = await bytesOf(zipStore([{ name: 'a.raw', data: a }, { name: 'meta.json', data: b }]));
    const view = new DataView(zip.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // The data follows the 30-byte header and the name, uncompressed.
    expect(Array.from(zip.subarray(30 + 5, 30 + 5 + 3))).toEqual([1, 2, 3]);

    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const cdOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(cdOffset + 16, true)).toBe(crc32(a));
    expect(view.getUint32(cdOffset + 42, true)).toBe(0);

    const second = cdOffset + 46 + 5;
    expect(view.getUint32(second, true)).toBe(0x02014b50);
    expect(view.getUint32(second + 42, true)).toBe(30 + 5 + 3);
  });
});
