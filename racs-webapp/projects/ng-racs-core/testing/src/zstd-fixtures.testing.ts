/**
 * Test fixtures: `zstd` frames as the server encodes them (`frame_codec::encode_zstd`), and the
 * images they hold, so the decoder is checked against real compressed blocks. Only imported by
 * specs.
 */

export const FIXTURE_WIDTH = 64;
export const FIXTURE_HEIGHT = 16;

/** Pseudo-random but reproducible in Rust (`wrapping_mul`, `^`) and here. */
function hash(x: number, y: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
}

/** The 8-bit fixture image: a ramp plus a little noise. */
export function fixtureMono8(): Uint8Array {
  const pixels = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT);
  for (let y = 0; y < FIXTURE_HEIGHT; y++) {
    for (let x = 0; x < FIXTURE_WIDTH; x++) {
      pixels[y * FIXTURE_WIDTH + x] = (x * 3 + y * 5 + (hash(x, y) % 7)) & 255;
    }
  }
  return pixels;
}

/** The 12-bit fixture image, a steeper ramp that wraps at 4096. */
export function fixtureMono12(): Uint16Array {
  const pixels = new Uint16Array(FIXTURE_WIDTH * FIXTURE_HEIGHT);
  for (let y = 0; y < FIXTURE_HEIGHT; y++) {
    for (let x = 0; x < FIXTURE_WIDTH; x++) {
      pixels[y * FIXTURE_WIDTH + x] = (x * 97 + y * 41 + (hash(x, y) % 23)) & 4095;
    }
  }
  return pixels;
}

/** {@link fixtureMono8} as the server sends it with `format=zstd`. */
export const FIXTURE_MONO8_ZSTD =
  'KLUv/WAAA+URAApA3AgsYFelAzAMwzCMmQcd9cNCKPufZcUCrvufZcUCrvufZcUCrnsG2VKmlJKUcgejAHQAdgCc1rlEQzSn' +
  '3m8m98ZV6qpIj6OZWDdEM7PQTapHp6W6frh+yx82268S67pqPEVWxaSkdqLdRKhMWY97f+YPWXtDXoot+zp52ea8+tnIyAsL' +
  'tcdfLmvbMjf+KFbJjoeOHThy3LBBo4aMGTBivGjhYgWLFCpQmDhBooSIESE+gOjgYQMHDRgyWLhAocKECBIeQGjggIGCBQgS' +
  'GDhQYACBAAI+AJgEptOtlr1Pq9DOrOV6+VSGx/4n056ptNOKySxEfqLiU5nkH+YHXVKPU+2Pa/cHkXqdxXXSSfWgFuGN5+WR' +
  'VW80v6nikJJ+76poR0OqxaVCTmNb21za65ynUa9KNXZ/7OuDdNfYpE81kyz8nDbZj+sptf6N+FI8qbbKRmgbMryL/IjFfNJ/' +
  'Q6wj5DSm8ulTZEqJL6VTOSnncnHx5comkzdxa+OUeVa5GskbYZ2tpKwkdzbiI+KUvNQ5Zd3ZZWG9sHbXf02ruIivdlg1XaUH' +
  '0WaZlVIkZLdWNYSUTjyV6DFTlQtLLL9dxr9jtVQvZhxSy/Ro2f/bb2Zu8dRu3QdvtflMiqfdJj32PN8RIc0+xiU7IdJ42CmW' +
  '7i0yyaSF2LT7rmbRzndMClG5frj46kcPetVNs/Jmq7IZoRUTsSlrbaqpLk86O0lkPqaq4l75jFeurefUyfRMeC9TXD3VCH30' +
  'bLfFTi8A';

/** {@link fixtureMono12} as the server sends it with `format=zstd` (`bit_depth` 12). */
export const FIXTURE_MONO12_ZSTD =
  'KLUv/WAAB90bAPpEjA07MFPakGexa54sjeVdLtg2HPPWUNdN0yglQiglknKmlHKmlHKmRCgRomUiGqttYotVqf7/96tXr15r' +
  'dQvPAMAAugARxNVDlWI02don0zn+LYPatUmiBn29t+7V79hXFxZ/e4fba2oYK9uodJKyF311q2cW2jy0VMbR6z6f6xDPawP9' +
  'x+XoUhfnzDF+klu6KjSa7qQg3raWsVBWefeFeiXhOsqwc1kS7+MYtRBOKzF3HtrPZEmuQ2g9+9OijSe9Eyzhl6fhGqzlZq1o' +
  'Zlto209J6Xpws+GROdB4IIFYsQDyoAKB65DihqNR1CjBJ2ZUrAkZGSiJGBikCBgX4Hexg8Ja6JCsFTmgSgUOx1PccDSKGpMh' +
  'NApLcNOsXb3qBJV8aV3UVstSz3UWr4XumuT7coPc18H8mXWpQ51SlczKosiddtqaNvvRwgpV1gXLUiXdyEonqzGzeNSYv9ni' +
  'hRb0tmvhsD+6VaohTz7SElnTMpL4lt3mU/+qdMPxv8ybofc6+EQJbhXT05uSwnyrpPqSfTQTPo/hvgI1mzpPo/ujNeO4+VwL' +
  'q5KLGX0hqXKu5GbnL6GsBB9lKTn5HdlY7SnH7B4lsTx2KvxLrFrMjS7dWD9T9HVTX99zpZxLM2nzL+Q3vWIne5VlRS/TW6bs' +
  'UX+S++vJS4y6/4fBHB358rYQvLDU2meYvoqy1Of5mTjbh53FX9brQzuv/BIzGIdt789u22tU96T7VfH+rTHbrzlJzMJupaOO' +
  'd2zEwyYN31u5kP45O7S1gnnMVjm2LNVEtQu6mr3l/EyNkdFyeViTYOaXYzITQZNjVc2TUL1W1RT2tOaH581cxPnh0psP1uxz' +
  'XsThvpf7nsl5b+Wk9KFLZVkTyoQyoUwoE8qEMqFMRkYQHBARMVAgJITAABAQAQE+PDwATCiUCxYqVKAwQYKECBAePHDQgAGD' +
  'BQoSjIwgOCAiYqBASAiBASAgAgJ8fHgAmEwelCsXjzbdT0Qt9GoknGUsRsY4vYj3sduuV2LLh3S7zXZi9Jc8u8Zk3jmK+pt9' +
  '4hTbfmWM7KZp3NU6rcHvzRy1rqW+ca/WdDO1wYLZXJTPsYrWVfZ6zc+bJrN6ofomVXl+ycRNSVE1HR2tD9mEICrBTePWrba3' +
  '8gxRHtIyM8K6J5bTlc9yeQ8IEAA21inWUVinWKdYR2GdYkGAqA==';

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
