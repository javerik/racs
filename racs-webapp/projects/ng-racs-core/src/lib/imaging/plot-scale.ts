/**
 * Axis ticks and point reduction for the SVG plot.
 */

/** A step of 1, 2 or 5 × 10^k close to `span / count`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) {
    return 1;
  }
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * mag;
}

/** Round tick values inside `[min, max]`, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }
  if (max === min) {
    return [min];
  }
  if (max < min) {
    [min, max] = [max, min];
  }
  const step = niceStep(max - min, count);
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  for (let k = first; k <= last && out.length < 100; k++) {
    // Rounded so 0.1 * 3 prints as 0.3.
    out.push(Number((k * step).toPrecision(12)));
  }
  return out;
}

/** The span to show for a set of values, widened a little and never empty. */
export function paddedExtent(values: Iterable<number>, pad = 0.05): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) {
    return null;
  }
  if (lo === hi) {
    const d = Math.abs(lo) * 0.05 || 1;
    return [lo - d, hi + d];
  }
  const d = (hi - lo) * pad;
  return [lo - d, hi + d];
}

/**
 * Points to draw a long series with at most a few per screen column: each column keeps its first,
 * lowest, highest and last point, so spikes survive. Short series come back unchanged.
 * NaN samples break the line and are kept as NaN.
 */
export function decimate(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  x0: number,
  x1: number,
  columns: number,
): { xs: number[]; ys: number[] } {
  const n = Math.min(xs.length, ys.length);
  if (n <= columns * 4 || columns <= 0 || !(x1 > x0)) {
    return { xs: Array.from({ length: n }, (_, i) => xs[i]), ys: Array.from({ length: n }, (_, i) => ys[i]) };
  }
  const outX: number[] = [];
  const outY: number[] = [];
  const width = (x1 - x0) / columns;
  let i = 0;
  while (i < n) {
    if (!Number.isFinite(ys[i])) {
      outX.push(xs[i]);
      outY.push(NaN);
      i++;
      continue;
    }
    const col = Math.floor((xs[i] - x0) / width);
    let lo = i;
    let hi = i;
    let j = i;
    while (j < n && Number.isFinite(ys[j]) && Math.floor((xs[j] - x0) / width) === col) {
      if (ys[j] < ys[lo]) lo = j;
      if (ys[j] > ys[hi]) hi = j;
      j++;
    }
    for (const k of [...new Set([i, lo, hi, j - 1])].sort((a, b) => a - b)) {
      outX.push(xs[k]);
      outY.push(ys[k]);
    }
    i = j;
  }
  return { xs: outX, ys: outY };
}

/** A tick label: short, without float noise. */
export function tickLabel(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
    return v.toExponential(1);
  }
  return String(Number(v.toPrecision(6)));
}
