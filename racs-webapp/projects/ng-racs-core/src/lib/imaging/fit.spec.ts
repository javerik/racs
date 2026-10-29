import { fitSummary, gaussianFit, linearFit, movingAverage, polyFit } from './fit';

const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

describe('fits', () => {
  it('averages over a centred window that shrinks at the ends', () => {
    expect(Array.from(movingAverage([0, 3, 6, 9], 3))).toEqual([1.5, 3, 6, 7.5]);
    expect(Array.from(movingAverage([1, NaN, 3], 3))).toEqual([1, 2, 3]);
  });

  it('fits a line exactly', () => {
    const xs = range(10);
    const fit = linearFit(xs, xs.map((x) => 3 * x - 2))!;
    expect(fit.slope).toBeCloseTo(3);
    expect(fit.intercept).toBeCloseTo(-2);
    expect(fit.r2).toBeCloseTo(1);
    expect(linearFit([1], [1])).toBeNull();
  });

  it('recovers polynomial coefficients at pixel-scale x', () => {
    const xs = range(200, 1000);
    const fit = polyFit(xs, xs.map((x) => 5 - 0.5 * x + 0.001 * x * x), 2)!;
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.evaluate(1100)).toBeCloseTo(5 - 550 + 1210, 4);
    expect(fit.coefficients[2]).toBeCloseTo(0.001, 6);
    expect(fit.coefficients[1]).toBeCloseTo(-0.5, 3);
  });

  it('fits a Gaussian peak and a dip', () => {
    const xs = range(100);
    const peak = xs.map((x) => 20 + 200 * Math.exp(-((x - 41.3) ** 2) / (2 * 4.2 ** 2)));
    const g = gaussianFit(xs, peak)!;
    expect(g.center).toBeCloseTo(41.3, 2);
    expect(g.sigma).toBeCloseTo(4.2, 2);
    expect(g.amplitude).toBeCloseTo(200, 1);
    expect(g.offset).toBeCloseTo(20, 1);
    expect(g.fwhm).toBeCloseTo(4.2 * 2.3548, 2);

    const dip = xs.map((x) => 500 - 100 * Math.exp(-((x - 60) ** 2) / (2 * 8 ** 2)));
    const d = gaussianFit(xs, dip)!;
    expect(d.center).toBeCloseTo(60, 1);
    expect(d.amplitude).toBeCloseTo(-100, 0);
  });

  it('summarises a fit', () => {
    const fit = linearFit([0, 1, 2], [1, 3, 5])!;
    expect(fitSummary(fit)).toEqual([
      ['slope', '2'],
      ['intercept', '1'],
      ['R²', '1.0000'],
    ]);
  });
});
