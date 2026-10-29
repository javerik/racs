import { identity, invert, invertInto, lookAt, multiply, perspective, transformPoint, type Mat4 } from './mat4';

function close(a: ArrayLike<number>, b: ArrayLike<number>, digits = 4): void {
  Array.from(a).forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

/** `a × b` in doubles, so only the inverse's own Float32 rounding shows. */
function product(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out: number[] = [];
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

describe('invert', () => {
  it('undoes a view-projection', () => {
    const m = multiply(perspective(0.8, 1.5, 0.1, 500), lookAt([30, -40, 25], [5, 2, 1], [0, 0, 1]));
    const inv = invert(m);
    expect(inv).not.toBeNull();
    // Stored in Float32, which a projection's large terms show.
    close(product(m, inv!), identity(), 2);
    const exact = invertInto(m, new Float64Array(16))!;
    close(product(m, exact), identity(), 9);
    close(product(exact, m), identity(), 9);
    const p = transformPoint(m, [3, -7, 2]);
    const back = transformPoint(inv!, p);
    [3, -7, 2].forEach((v, i) => expect(back[i]).toBeCloseTo(v, 2));
  });

  it('keeps a translation column-major', () => {
    const t = identity();
    t[12] = 4;
    t[13] = -2;
    t[14] = 9;
    const inv = invert(t)!;
    expect([inv[12], inv[13], inv[14]]).toEqual([-4, 2, -9]);
  });

  it('refuses a singular matrix', () => {
    const m = identity();
    m[10] = 0;
    expect(invert(m)).toBeNull();
  });
});
