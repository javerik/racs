/**
 * Smoothing and least-squares fits for the ROI plot: a moving average, a straight line, a
 * polynomial and a Gaussian peak (or dip) on a constant baseline. NaN samples are ignored.
 */

export interface LinearFit {
  kind: 'linear';
  slope: number;
  intercept: number;
  r2: number;
  evaluate: (x: number) => number;
}

export interface PolyFit {
  kind: 'poly';
  degree: number;
  /** In plain x: `c[0] + c[1]·x + c[2]·x² …`. */
  coefficients: number[];
  r2: number;
  evaluate: (x: number) => number;
}

export interface GaussianFit {
  kind: 'gaussian';
  /** Height above the baseline; negative for a dip. */
  amplitude: number;
  center: number;
  sigma: number;
  fwhm: number;
  offset: number;
  r2: number;
  evaluate: (x: number) => number;
}

export type Fit = LinearFit | PolyFit | GaussianFit;

/** FWHM of a Gaussian per unit sigma: 2·√(2·ln 2). */
export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

type Values = ArrayLike<number>;

/** The finite (x, y) pairs. */
function points(xs: Values, ys: Values): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      x.push(xs[i]);
      y.push(ys[i]);
    }
  }
  return { x, y };
}

function rSquared(x: number[], y: number[], f: (x: number) => number): number {
  let mean = 0;
  for (const v of y) mean += v;
  mean /= y.length;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < x.length; i++) {
    sse += (y[i] - f(x[i])) ** 2;
    sst += (y[i] - mean) ** 2;
  }
  return sst > 0 ? 1 - sse / sst : sse === 0 ? 1 : 0;
}

/** Centred moving average over `window` samples, the window shrinking at the ends. */
export function movingAverage(ys: Values, window: number): Float64Array {
  const n = ys.length;
  const out = new Float64Array(n);
  const half = Math.max(0, Math.floor(Math.max(1, Math.round(window)) / 2));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (Number.isFinite(ys[j])) {
        sum += ys[j];
        count++;
      }
    }
    out[i] = count ? sum / count : NaN;
  }
  return out;
}

export function linearFit(xs: Values, ys: Values): LinearFit | null {
  const { x, y } = points(xs, ys);
  const n = x.length;
  if (n < 2) {
    return null;
  }
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx === 0) {
    return null;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const evaluate = (v: number) => intercept + slope * v;
  return { kind: 'linear', slope, intercept, r2: rSquared(x, y, evaluate), evaluate };
}

/** Solve `a·s = b` in place (Gaussian elimination, partial pivoting); null when singular. */
export function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    }
    if (Math.abs(a[p][c]) < 1e-12) {
      return null;
    }
    [a[c], a[p]] = [a[p], a[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  const s = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r];
    for (let k = r + 1; k < n; k++) v -= a[r][k] * s[k];
    s[r] = v / a[r][r];
  }
  return s;
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Least-squares polynomial of `degree`. Solved in x mapped onto [-1, 1], which keeps the normal
 * equations well conditioned for pixel positions in the thousands.
 */
export function polyFit(xs: Values, ys: Values, degree: number): PolyFit | null {
  const { x, y } = points(xs, ys);
  const d = Math.max(1, Math.round(degree));
  if (x.length <= d) {
    return null;
  }
  const lo = Math.min(...x);
  const hi = Math.max(...x);
  const c = (lo + hi) / 2;
  const h = (hi - lo) / 2 || 1;
  const m = d + 1;
  const a = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  const powers = new Array<number>(2 * m - 1);
  for (let i = 0; i < x.length; i++) {
    const t = (x[i] - c) / h;
    powers[0] = 1;
    for (let k = 1; k < powers.length; k++) powers[k] = powers[k - 1] * t;
    for (let r = 0; r < m; r++) {
      b[r] += y[i] * powers[r];
      for (let k = 0; k < m; k++) a[r][k] += powers[r + k];
    }
  }
  const q = solve(a, b);
  if (!q) {
    return null;
  }
  const evaluate = (v: number) => {
    const t = (v - c) / h;
    let out = 0;
    for (let k = d; k >= 0; k--) out = out * t + q[k];
    return out;
  };
  // Expand Σ q_k ((x - c)/h)^k into plain powers of x, for display.
  const coefficients = new Array<number>(m).fill(0);
  for (let k = 0; k < m; k++) {
    for (let j = 0; j <= k; j++) {
      coefficients[j] += (q[k] / h ** k) * binomial(k, j) * (-c) ** (k - j);
    }
  }
  return { kind: 'poly', degree: d, coefficients, r2: rSquared(x, y, evaluate), evaluate };
}

/**
 * A Gaussian peak or dip on a constant baseline, `offset + amplitude·exp(-(x-center)²/2σ²)`.
 * Starts from the moments of the data above (or below) the baseline and refines with
 * Levenberg–Marquardt; returns the moment estimate if that does not improve on it.
 */
export function gaussianFit(xs: Values, ys: Values): GaussianFit | null {
  const { x, y } = points(xs, ys);
  const n = x.length;
  if (n < 4) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  let mean = 0;
  for (const v of y) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    mean += v;
  }
  mean /= n;
  // A dip when the bulk sits nearer the top than the bottom.
  const dip = max - mean < mean - min;
  const offset0 = dip ? max : min;
  let sw = 0;
  let swx = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.abs(y[i] - offset0);
    sw += w;
    swx += w * x[i];
  }
  if (sw === 0) {
    return null;
  }
  const center0 = swx / sw;
  let swxx = 0;
  for (let i = 0; i < n; i++) {
    swxx += Math.abs(y[i] - offset0) * (x[i] - center0) ** 2;
  }
  const span = Math.max(...x) - Math.min(...x) || 1;
  const sigma0 = Math.sqrt(swxx / sw) || span / 6;
  let p = [dip ? min - max : max - min, center0, sigma0, offset0];

  const model = (q: number[], v: number) => q[3] + q[0] * Math.exp(-((v - q[1]) ** 2) / (2 * q[2] * q[2]));
  const sse = (q: number[]) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += (y[i] - model(q, x[i])) ** 2;
    return s;
  };

  let err = sse(p);
  let lambda = 1e-3;
  for (let iter = 0; iter < 100; iter++) {
    const jtj = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const jtr = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dx = x[i] - p[1];
      const e = Math.exp(-(dx * dx) / (2 * p[2] * p[2]));
      const j = [e, (p[0] * e * dx) / (p[2] * p[2]), (p[0] * e * dx * dx) / p[2] ** 3, 1];
      const r = y[i] - (p[3] + p[0] * e);
      for (let a = 0; a < 4; a++) {
        jtr[a] += j[a] * r;
        for (let b = 0; b < 4; b++) jtj[a][b] += j[a] * j[b];
      }
    }
    const damped = jtj.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
    const step = solve(damped, jtr.slice());
    if (!step) {
      break;
    }
    const next = p.map((v, k) => v + step[k]);
    next[2] = Math.abs(next[2]) || p[2];
    const nextErr = sse(next);
    if (nextErr < err) {
      const gain = err - nextErr;
      p = next;
      err = nextErr;
      lambda = Math.max(lambda / 10, 1e-9);
      if (gain < 1e-12 * (err + 1e-12)) {
        break;
      }
    } else {
      lambda *= 10;
      if (lambda > 1e9) {
        break;
      }
    }
  }
  const [amplitude, center, sigma, offset] = p;
  const evaluate = (v: number) => model(p, v);
  return {
    kind: 'gaussian',
    amplitude,
    center,
    sigma,
    fwhm: sigma * FWHM_PER_SIGMA,
    offset,
    r2: rSquared(x, y, evaluate),
    evaluate,
  };
}

/** A short number for the fit summary: 4 significant digits, no exponent clutter for normal values. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) {
    return '—';
  }
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) {
    return v.toExponential(2);
  }
  return String(Number(v.toPrecision(4)));
}

/** The fit's parameters as `name value` parts, for a ` · ` joined caption. */
export function fitSummary(fit: Fit): [string, string][] {
  switch (fit.kind) {
    case 'linear':
      return [
        ['slope', fmt(fit.slope)],
        ['intercept', fmt(fit.intercept)],
        ['R²', fit.r2.toFixed(4)],
      ];
    case 'poly':
      return [...fit.coefficients.map((c, k): [string, string] => [`c${k}`, fmt(c)]), ['R²', fit.r2.toFixed(4)]];
    case 'gaussian':
      return [
        ['μ', fmt(fit.center)],
        ['σ', fmt(fit.sigma)],
        ['FWHM', fmt(fit.fwhm)],
        ['A', fmt(fit.amplitude)],
        ['base', fmt(fit.offset)],
        ['R²', fit.r2.toFixed(4)],
      ];
  }
}
