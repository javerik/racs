/**
 * The last frame size seen per device, remembered so the burst form can estimate memory use
 * before a job has reported its own geometry. Purely advisory.
 */

const KEY = 'racs.geometry';

export interface Geometry {
  width: number;
  height: number;
}

export function rememberGeometry(deviceId: number, width: number, height: number): void {
  try {
    localStorage.setItem(`${KEY}.${deviceId}`, JSON.stringify({ width, height }));
  } catch {
    // Advisory only.
  }
}

export function recallGeometry(deviceId: number): Geometry | null {
  try {
    const raw = localStorage.getItem(`${KEY}.${deviceId}`);
    if (raw) {
      const g = JSON.parse(raw) as Partial<Geometry>;
      if (typeof g.width === 'number' && typeof g.height === 'number') {
        return { width: g.width, height: g.height };
      }
    }
  } catch {
    // Advisory only.
  }
  return null;
}
