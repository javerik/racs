import { analyze, buildLut, decodeRaw, decodeZstd, grayFromPlanes, mergeStats, renderInto, type GrayFrame } from './frame';
import {
  FIXTURE_HEIGHT,
  FIXTURE_MONO12_ZSTD,
  FIXTURE_MONO8_ZSTD,
  FIXTURE_WIDTH,
  fixtureMono12,
  fixtureMono8,
  fromBase64,
} from 'ng-racs-core/testing';

function le16(values: number[], leadingBytes = 0): Uint8Array {
  const bytes = new Uint8Array(leadingBytes + values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint16(leadingBytes + i * 2, v, true));
  return bytes.subarray(leadingBytes);
}

/** The grey level an RGBA-packed LUT entry carries (R == G == B). */
function grey(packed: number): number {
  return new Uint8Array(new Uint32Array([packed]).buffer)[0];
}

describe('decodeRaw', () => {
  it('views 8-bit frames as one byte per pixel and ignores trailing bytes', () => {
    const frame = decodeRaw(new Uint8Array([1, 2, 3, 4, 99]), 2, 2, 8);
    expect(Array.from(frame.pixels)).toEqual([1, 2, 3, 4]);
    expect(frame.pixels).toBeInstanceOf(Uint8Array);
  });

  it('reads deep frames as little-endian u16s', () => {
    const frame = decodeRaw(le16([0, 255, 256, 4095]), 2, 2, 12);
    expect(frame.pixels).toBeInstanceOf(Uint16Array);
    expect(Array.from(frame.pixels)).toEqual([0, 255, 256, 4095]);
  });

  it('copies when the bytes are not 2-byte aligned', () => {
    // The live stream's payload starts after an 8-byte header; an odd offset must still decode.
    const frame = decodeRaw(le16([1000, 2000], 1), 2, 1, 16);
    expect(Array.from(frame.pixels)).toEqual([1000, 2000]);
  });

  it('rejects a short frame instead of reading garbage', () => {
    expect(() => decodeRaw(new Uint8Array(4), 2, 2, 16)).toThrow();
    expect(() => decodeRaw(new Uint8Array(4), 0, 2, 8)).toThrow();
  });
});

/** A zstd frame holding `content` uncompressed (one raw block), with its content size. */
function zstdStored(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 1 + 4 + 3 + content.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xfd2fb528, true);
  // Single segment, a 4-byte content size, no checksum, no dictionary.
  out[4] = 0xa0;
  view.setUint32(5, content.length, true);
  // Last block, type raw, its size.
  const header = (content.length << 3) | 1;
  out.set([header & 0xff, (header >> 8) & 0xff, header >> 16], 9);
  out.set(content, 12);
  return out;
}

describe('decodeZstd', () => {
  it('adds each 8-bit residual to the pixel above, wrapping', async () => {
    const frame = await decodeZstd(zstdStored(new Uint8Array([10, 20, 3, 254])), 2, 2, 8);
    expect(frame.pixels).toBeInstanceOf(Uint8Array);
    expect(Array.from(frame.pixels)).toEqual([10, 20, 13, 18]);
  });

  it('un-zigzags 16-bit residuals from their low and high byte planes', async () => {
    // Row 0: zigzag(300) = 600, zigzag(5) = 10. Row 1: -1 -> 1, +1 -> 2.
    const frame = await decodeZstd(zstdStored(new Uint8Array([88, 10, 1, 2, 2, 0, 0, 0])), 2, 2, 12);
    expect(frame.pixels).toBeInstanceOf(Uint16Array);
    expect(Array.from(frame.pixels)).toEqual([300, 5, 299, 6]);
  });

  it('wraps 16-bit differences in both directions', async () => {
    // 65535 is -1 from 0 (zigzag 1), and 0 is +1 from 65535 (zigzag 2).
    const frame = await decodeZstd(zstdStored(new Uint8Array([0, 1, 1, 2, 0, 0, 0, 0])), 2, 2, 16);
    expect(Array.from(frame.pixels)).toEqual([0, 65535, 65535, 0]);
  });

  it('decodes frames the server compressed', async () => {
    const mono8 = await decodeZstd(fromBase64(FIXTURE_MONO8_ZSTD), FIXTURE_WIDTH, FIXTURE_HEIGHT, 8);
    expect(mono8.pixels).toEqual(fixtureMono8());
    const mono12 = await decodeZstd(fromBase64(FIXTURE_MONO12_ZSTD), FIXTURE_WIDTH, FIXTURE_HEIGHT, 12);
    expect(mono12.pixels).toEqual(fixtureMono12());
    expect(mono12.bitDepth).toBe(12);
  });

  it('rejects a frame of another size, a truncated one and nonsense', async () => {
    const payload = fromBase64(FIXTURE_MONO8_ZSTD);
    await expect(decodeZstd(payload, FIXTURE_WIDTH, FIXTURE_HEIGHT - 1, 8)).rejects.toThrow(/not a zstd frame/);
    await expect(decodeZstd(payload, FIXTURE_WIDTH, FIXTURE_HEIGHT, 16)).rejects.toThrow(/not a zstd frame/);
    await expect(
      decodeZstd(payload.subarray(0, payload.length - 4), FIXTURE_WIDTH, FIXTURE_HEIGHT, 8),
    ).rejects.toThrow();
    await expect(decodeZstd(new Uint8Array([1, 2, 3, 4, 5]), 2, 2, 8)).rejects.toThrow();
    await expect(decodeZstd(payload, 0, FIXTURE_HEIGHT, 8)).rejects.toThrow();
  });
});

describe('analyze', () => {
  it('finds min and max and bins by the top 8 bits', () => {
    const frame: GrayFrame = {
      width: 4,
      height: 1,
      bitDepth: 12,
      pixels: new Uint16Array([16, 17, 4095, 100]),
    };
    const stats = analyze(frame);
    expect(stats.min).toBe(16);
    expect(stats.max).toBe(4095);
    expect(stats.hist[1]).toBe(2);
    expect(stats.hist[255]).toBe(1);
    expect(stats.hist.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('takes min and max of an 8-bit frame from its histogram', () => {
    const stats = analyze({ width: 5, height: 1, bitDepth: 8, pixels: new Uint8Array([7, 200, 7, 0, 255]) });
    expect([stats.min, stats.max]).toEqual([0, 255]);
    expect([stats.hist[7], stats.hist[200]]).toEqual([2, 1]);
    const flat = analyze({ width: 2, height: 1, bitDepth: 8, pixels: new Uint8Array([42, 42]) });
    expect([flat.min, flat.max]).toEqual([42, 42]);
    const empty = analyze({ width: 0, height: 0, bitDepth: 8, pixels: new Uint8Array(0) });
    expect([empty.min, empty.max]).toEqual([0, 0]);
  });

  it('clamps values above the declared depth into the last bin', () => {
    const frame: GrayFrame = { width: 1, height: 1, bitDepth: 10, pixels: new Uint16Array([60000]) };
    expect(analyze(frame).hist[255]).toBe(1);
  });

  it('merges stats across frames', () => {
    const a = analyze({ width: 2, height: 1, bitDepth: 8, pixels: new Uint8Array([5, 10]) });
    const b = analyze({ width: 2, height: 1, bitDepth: 8, pixels: new Uint8Array([2, 7]) });
    const merged = mergeStats([a, b])!;
    expect([merged.min, merged.max]).toEqual([2, 10]);
    expect(merged.hist.reduce((x, y) => x + y, 0)).toBe(4);
    expect(mergeStats([])).toBeNull();
  });
});

describe('buildLut', () => {
  it('maps lo to black, hi to white, and clamps outside the window', () => {
    const lut = buildLut(20, 50, 8);
    expect(lut.length).toBe(256);
    expect(grey(lut[0])).toBe(0);
    expect(grey(lut[20])).toBe(0);
    expect(grey(lut[35])).toBe(128);
    expect(grey(lut[50])).toBe(255);
    expect(grey(lut[255])).toBe(255);
  });

  it('is opaque', () => {
    const lut = buildLut(0, 255, 8);
    const alpha = new Uint8Array(new Uint32Array([lut[7]]).buffer)[3];
    expect(alpha).toBe(255);
  });

  it('covers the whole u16 range for deep frames', () => {
    const lut = buildLut(0, 4095, 12);
    expect(lut.length).toBe(65536);
    expect(grey(lut[65535])).toBe(255);
  });
});

describe('renderInto', () => {
  it('writes RGBA through the LUT', () => {
    const frame: GrayFrame = { width: 2, height: 1, bitDepth: 8, pixels: new Uint8Array([0, 255]) };
    const out = { width: 2, height: 1, data: new Uint8ClampedArray(8) } as ImageData;
    renderInto(frame, buildLut(0, 255, 8), out);
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe('grayFromPlanes', () => {
  it('takes one channel of a 4-byte RGB layout, row by row with its stride', () => {
    // 2x2 BGRX with 4 bytes of row padding; grey value in every channel.
    const data = new Uint8Array([10, 10, 10, 0, 20, 20, 20, 0, 9, 9, 9, 9, 30, 30, 30, 0, 40, 40, 40, 0, 9, 9, 9, 9]);
    const frame = grayFromPlanes(data, 'BGRX', [{ offset: 0, stride: 12 }], 2, 2);
    expect([...frame.pixels]).toEqual([10, 20, 30, 40]);
    expect(frame.bitDepth).toBe(8);
  });

  it('takes the luma plane of a YUV layout', () => {
    // 2x2 I420: Y with a stride of 3 at offset 1, then chroma that must be ignored.
    const data = new Uint8Array([0, 1, 2, 99, 3, 4, 99, 128, 128]);
    const frame = grayFromPlanes(data, 'I420', [{ offset: 1, stride: 3 }, { offset: 7, stride: 1 }], 2, 2);
    expect([...frame.pixels]).toEqual([1, 2, 3, 4]);
  });

  it('refuses a layout it does not know', () => {
    expect(() => grayFromPlanes(new Uint8Array(8), 'I420P10', [{ offset: 0, stride: 4 }], 2, 1)).toThrow('I420P10');
  });
});
