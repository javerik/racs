import { applyHomography, invertHomography, multiplyMat3, reprojectionRms, solveHomography, type Mat3, type PointPair } from './homography';

const H: Mat3 = [1.8, 0.3, -120, -0.2, 2.1, 40, 0.0004, -0.0002, 1];

function pairs(h: Mat3, noise = 0): PointPair[] {
  const out: PointPair[] = [];
  let k = 0;
  for (let x = 0; x <= 600; x += 150) {
    for (let y = 0; y <= 400; y += 100) {
      const to = applyHomography(h, { x, y });
      // Deterministic jitter.
      const j = noise * Math.sin(++k * 12.9898);
      out.push({ from: { x, y }, to: { x: to.x + j, y: to.y - j } });
    }
  }
  return out;
}

describe('homography', () => {
  it('recovers an exact mapping', () => {
    const h = solveHomography(pairs(H))!;
    expect(h).not.toBeNull();
    h.forEach((v, i) => expect(v).toBeCloseTo(H[i], 6));
    expect(reprojectionRms(h, pairs(H))).toBeLessThan(1e-6);
  });

  it('fits noisy pairs in the least-squares sense', () => {
    const noisy = pairs(H, 0.5);
    const h = solveHomography(noisy)!;
    expect(reprojectionRms(h, noisy)).toBeLessThan(0.6);
    const p = applyHomography(h, { x: 300, y: 200 });
    const q = applyHomography(H, { x: 300, y: 200 });
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(0.5);
  });

  it('inverts', () => {
    const inv = invertHomography(H)!;
    const id = multiplyMat3(H, inv);
    const s = id[8];
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(id[i] / s).toBeCloseTo(v, 9));
    const p = applyHomography(inv, applyHomography(H, { x: 17, y: -5 }));
    expect(p.x).toBeCloseTo(17, 6);
    expect(p.y).toBeCloseTo(-5, 6);
    expect(invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
  });

  it('refuses too few or degenerate pairs', () => {
    expect(solveHomography(pairs(H).slice(0, 3))).toBeNull();
    const collinear = [0, 1, 2, 3, 4].map((i) => ({ from: { x: i, y: i }, to: { x: 2 * i, y: 2 * i } }));
    expect(solveHomography(collinear)).toBeNull();
  });
});
