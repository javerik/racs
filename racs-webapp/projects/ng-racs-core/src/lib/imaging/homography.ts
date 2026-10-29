/**
 * Plane-to-plane mapping (a homography): how points on a flat screen land on a camera's sensor,
 * including rotation, mirroring, scale and perspective. Solved from point pairs by the
 * normalised direct linear transform; no dependencies.
 */

export interface Point {
  x: number;
  y: number;
}

/** Row-major 3×3 matrix, mapping `(x, y, 1)` to homogeneous coordinates. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export interface PointPair {
  from: Point;
  to: Point;
}

export function applyHomography(h: Mat3, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
    }
  }
  return out as unknown as Mat3;
}

/** The inverse mapping, or null for a degenerate matrix. */
export function invertHomography(h: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    return null;
  }
  const inv = [
    A,
    -(b * j - c * i),
    b * f - c * e,
    B,
    a * j - c * g,
    -(a * f - c * d),
    C,
    -(a * i - b * g),
    a * e - b * d,
  ].map((v) => v / det);
  return inv as unknown as Mat3;
}

/** Translate to the centroid and scale to a mean distance of √2 (Hartley), for conditioning. */
function normalizer(points: Point[]): Mat3 {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  const mean = points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  const k = mean > 0 ? Math.SQRT2 / mean : 1;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

/**
 * The homography mapping each `from` onto its `to` in the least-squares sense, or null with fewer
 * than four pairs or a degenerate layout (three of four on a line, say).
 */
export function solveHomography(pairs: PointPair[]): Mat3 | null {
  if (pairs.length < 4) {
    return null;
  }
  const tFrom = normalizer(pairs.map((p) => p.from));
  const tTo = normalizer(pairs.map((p) => p.to));
  // Normal equations of A·h = b with h = (h0..h7), h8 = 1.
  const ata = Array.from({ length: 8 }, () => new Float64Array(8));
  const atb = new Float64Array(8);
  const add = (row: number[], rhs: number) => {
    for (let r = 0; r < 8; r++) {
      atb[r] += row[r] * rhs;
      for (let c = 0; c < 8; c++) {
        ata[r][c] += row[r] * row[c];
      }
    }
  };
  for (const pair of pairs) {
    const { x, y } = applyHomography(tFrom, pair.from);
    const { x: u, y: v } = applyHomography(tTo, pair.to);
    add([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    add([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solve(ata, atb);
  if (!h) {
    return null;
  }
  const normalized: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const back = invertHomography(tTo);
  if (!back) {
    return null;
  }
  const out = multiplyMat3(multiplyMat3(back, normalized), tFrom);
  // Scale so h8 = 1 where possible, for readable stored values.
  const s = Math.abs(out[8]) > 1e-12 ? out[8] : 1;
  return out.map((v) => v / s) as unknown as Mat3;
}

/** Gaussian elimination with partial pivoting; null for a singular system. */
function solve(a: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      return null;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) {
        m[r][c] -= f * m[col][c];
      }
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) {
      s -= m[r][c] * x[c];
    }
    x[r] = s / m[r][r];
  }
  return x;
}

/** RMS distance between each `to` and where `h` maps its `from`. */
export function reprojectionRms(h: Mat3, pairs: PointPair[]): number {
  if (!pairs.length) {
    return 0;
  }
  const sum = pairs.reduce((s, { from, to }) => {
    const p = applyHomography(h, from);
    return s + (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
  }, 0);
  return Math.sqrt(sum / pairs.length);
}
