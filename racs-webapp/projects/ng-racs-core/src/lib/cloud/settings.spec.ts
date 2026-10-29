import { DEFAULT_LIGHT } from './lighting';
import {
  clampFrames,
  cloudBudget,
  loadCloudSettings,
  loadCloudView,
  saveCloudSettings,
  saveCloudView,
  sanitizeStretch,
  type CloudViewSettings,
} from './settings';

/** The test environment has no localStorage of its own. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('cloud settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to a 16-bit rolling buffer sized for the device', () => {
    expect(loadCloudSettings(false)).toEqual({ mode: 'continuous', depth: 'mono16', capacity: 8192, frames: 10 });
    expect(loadCloudSettings(true).capacity).toBe(cloudBudget(true).rollingDefault);
  });

  it('round-trips and repairs what it cannot use', () => {
    saveCloudSettings({ mode: 'snapshot', depth: 'mono8', capacity: 2048, frames: 50 });
    expect(loadCloudSettings(false)).toEqual({ mode: 'snapshot', depth: 'mono8', capacity: 2048, frames: 50 });
    localStorage.setItem('racs.cloud', JSON.stringify({ mode: 'x', capacity: 1234, frames: 9999 }));
    expect(loadCloudSettings(false)).toEqual({ mode: 'continuous', depth: 'mono16', capacity: 8192, frames: 500 });
  });

  it('remembers the view', () => {
    const defaults: CloudViewSettings = {
      pointSize: 1.5,
      density: 'auto',
      zAspect: 'auto',
      preset: 'iso',
      palette: 'grey',
      render: 'points',
      jump: 0.1,
      stretch: { x: 1, y: 1, z: 1 },
      light: DEFAULT_LIGHT,
    };
    expect(loadCloudView()).toEqual(defaults);
    const light = { ...DEFAULT_LIGHT, enabled: false, azimuth: 30, shadows: true };
    saveCloudView({ ...defaults, pointSize: 99, density: 4, zAspect: 'true', preset: 'top', palette: 'viridis', render: 'surface', jump: 5, stretch: { x: 2, y: 0.25, z: 3 }, light });
    expect(loadCloudView()).toEqual({
      pointSize: 6,
      density: 4,
      zAspect: 'true',
      preset: 'top',
      palette: 'viridis',
      render: 'surface',
      jump: 1,
      stretch: { x: 2, y: 0.25, z: 3 },
      light,
    });
    localStorage.setItem('racs.cloud.view', JSON.stringify({ palette: 'jet', render: 'mesh' }));
    expect(loadCloudView().palette).toBe('grey');
    expect(loadCloudView().render).toBe('points');
  });

  it('loads a view saved before stretch and light existed', () => {
    localStorage.setItem('racs.cloud.view', JSON.stringify({ pointSize: 2, density: 2, zAspect: 'true', preset: 'top', palette: 'magma' }));
    const v = loadCloudView();
    expect(v.zAspect).toBe('true');
    expect(v.stretch).toEqual({ x: 1, y: 1, z: 1 });
    expect(v.light).toEqual(DEFAULT_LIGHT);
  });

  it('keeps each stretch positive and in range', () => {
    expect(sanitizeStretch({ x: 0, y: -2, z: 'x' })).toEqual({ x: 1, y: 1, z: 1 });
    expect(sanitizeStretch({ x: 1e6, y: 1e-6, z: '2.5' })).toEqual({ x: 100, y: 0.01, z: 2.5 });
  });

  it('keeps snapshots within the burst limit', () => {
    expect(clampFrames(0)).toBe(10);
    expect(clampFrames('12')).toBe(12);
    expect(clampFrames(501)).toBe(500);
  });
});
