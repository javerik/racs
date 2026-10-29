import { TestBed } from '@angular/core/testing';
import { DeviceSelectionService } from './device-selection.service';
import { RoiSession, sanitizePlot, seriesColor } from './roi-session.service';

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

function setup(deviceId = 0) {
  TestBed.configureTestingModule({ providers: [RoiSession] });
  const selection = TestBed.inject(DeviceSelectionService);
  selection.setSelectedDeviceId(deviceId);
  const session = TestBed.inject(RoiSession);
  TestBed.tick();
  return { session, selection };
}

describe('RoiSession', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('names and colours ROIs with the lowest free slot', () => {
    const { session } = setup();
    const a = session.add('rect', 0, 0, 4, 4);
    const b = session.add('line', 0, 0, 4, 4);
    expect([a.name, a.series, b.name, b.series]).toEqual(['R1', 0, 'R2', 1]);
    session.remove(a.id);
    const c = session.add('rect', 1, 1, 2, 2);
    expect([c.name, c.series]).toEqual(['R1', 0]);
    expect(session.selectedId()).toBe(c.id);
  });

  it('switches to a plot the first ROI of its shape can show', () => {
    const { session } = setup();
    expect(session.plot().kind).toBe('profile');
    session.add('rect', 0, 0, 4, 4);
    expect(session.plot().kind).toBe('projection');
    session.updatePlot({ kind: 'histogram' });
    session.add('line', 0, 0, 4, 4);
    expect(session.plot().kind).toBe('histogram');
  });

  it('keeps ROIs per device', () => {
    const { session, selection } = setup(3);
    session.add('rect', 0, 0, 4, 4);
    selection.setSelectedDeviceId(4);
    TestBed.tick();
    expect(session.rois()).toEqual([]);
    selection.setSelectedDeviceId(3);
    TestBed.tick();
    expect(session.rois().map((r) => r.name)).toEqual(['R1']);
  });

  it('drops malformed stored entries and settings', () => {
    localStorage.setItem('racs.rois.0', JSON.stringify([{ id: 'x' }, 'junk']));
    const { session } = setup();
    expect(session.rois()).toEqual([]);
    expect(sanitizePlot({ kind: 'pie', degree: 9, window: 1 })).toMatchObject({ kind: 'profile', degree: 5, window: 2 });
  });

  it('cycles the series colours', () => {
    expect(seriesColor(0)).toBe('rgb(var(--series-1))');
    expect(seriesColor(7)).toBe('rgb(var(--series-2))');
  });
});
