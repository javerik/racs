/**
 * The little linear algebra the point-cloud view needs: 3-vectors and column-major 4×4 matrices
 * as WebGL takes them (`uniformMatrix4fv(…, false, m)`).
 */

export type Vec3 = [number, number, number];
/** Column-major: element (row r, column c) is `m[c * 4 + r]`. */
export type Mat4 = Float32Array;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** `a × b`: applies `b` first, then `a`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + r] * b[c * 4 + k];
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** A right-handed perspective projection to WebGL's clip space (z −1..1). `fovY` in radians. */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** A right-handed orthographic projection of the box `left..right`, `bottom..top`, `near..far` in front of the eye. */
export function ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
  const m = identity();
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -2 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -(far + near) / (far - near);
  return m;
}

/** The view matrix of a camera at `eye` looking at `target`, `up` pointing up on screen. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(target, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  const m = identity();
  m[0] = s[0];
  m[4] = s[1];
  m[8] = s[2];
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[12] = -dot(s, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  return m;
}

/** `m` applied to the point `p`, with the perspective divide. */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
}

/** The inverse of `m`, or `null` when it has none. Computed in doubles. */
export function invert(m: Mat4): Mat4 | null {
  const inv = invertInto(m, new Float64Array(16));
  return inv ? Float32Array.from(inv) : null;
}

/**
 * The inverse of the column-major 4×4 `m` written into `out` (cofactors over the determinant),
 * or `null` when `m` is singular. Element (r, c) is `m[c * 4 + r]` in both.
 */
export function invertInto<T extends { [i: number]: number }>(m: ArrayLike<number>, out: T): T | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) {
    return null;
  }
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}
