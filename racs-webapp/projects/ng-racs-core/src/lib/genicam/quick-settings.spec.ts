import type { FeatureState, GenICamNodeInfo } from '../models/racs.models';
import { candidateNames, loadPins, PINNED_SECTION_ID, pinsKey, resolveSections, savePins } from './quick-settings';

function node(name: string, selected: string[] = []): GenICamNodeInfo {
  return {
    name,
    display_name: name,
    node_type: 'Integer',
    visibility: 'Beginner',
    access_mode: 'ReadWrite',
    enums: null,
    selected,
  };
}

function nodes(...list: GenICamNodeInfo[]): Map<string, GenICamNodeInfo> {
  return new Map(list.map((n) => [n.name, n]));
}

function unavailable(name: string): FeatureState {
  return {
    name,
    node_type: 'Float',
    value: null,
    available: false,
    locked: false,
    min: null,
    max: null,
    inc: null,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
  };
}

const names = (sections: ReturnType<typeof resolveSections>) =>
  sections.map((s) => [s.id, s.rows.map((r) => `${'  '.repeat(r.depth)}${r.node.name}`)]);

describe('resolveSections', () => {
  it('shows only what the camera has and offers right now', () => {
    const cam = nodes(node('AcquisitionMode'), node('AcquisitionFrameRate'), node('AcquisitionLineRate'), node('Vendor'));
    const sections = resolveSections(cam, { AcquisitionLineRate: unavailable('AcquisitionLineRate') }, []);
    // Not read yet still shows (as loading); unavailable and absent features don't.
    expect(names(sections)).toEqual([['acquisition', ['AcquisitionFrameRate', 'AcquisitionMode']]]);
  });

  it('gives the packet size a transport section of its own', () => {
    const cam = nodes(node('GevSCPSPacketSize'), node('DeviceTemperature'));
    expect(names(resolveSections(cam, {}, []))).toEqual([
      ['transport', ['GevSCPSPacketSize']],
      ['status', ['DeviceTemperature']],
    ]);
  });

  it('puts a missing selector right before what it selects', () => {
    const cam = nodes(
      node('LightControllerSelector', ['LightBrightness', 'LightControllerSource']),
      node('LightBrightness'),
      node('LightControllerSource'),
      node('RegionSelector', ['Width']),
      node('Width'),
    );
    expect(names(resolveSections(cam, {}, []))).toEqual([
      ['region', ['RegionSelector', '  Width']],
      ['light', ['LightControllerSelector', '  LightBrightness', '  LightControllerSource']],
    ]);
  });

  it('adds pins that are not curated as a first section', () => {
    const cam = nodes(node('AcquisitionMode'), node('Scan3dExtractionMethod'), node('Gone'));
    const sections = resolveSections(cam, {}, ['Scan3dExtractionMethod', 'AcquisitionMode', 'NotOnThisCamera']);
    expect(names(sections)).toEqual([
      [PINNED_SECTION_ID, ['Scan3dExtractionMethod']],
      ['acquisition', ['AcquisitionMode']],
    ]);
  });

  it('leaves the essentials to their own strip, pinned or not', () => {
    const cam = nodes(node('ExposureTime'), node('DeviceScanType'), node('AcquisitionMode'));
    const sections = resolveSections(cam, {}, ['ExposureTime']);
    expect(names(sections)).toEqual([['acquisition', ['AcquisitionMode']]]);
  });

  it('lists every candidate with its selectors for reading', () => {
    const cam = nodes(node('TriggerSelector', ['TriggerMode']), node('TriggerMode'), node('Pinned'));
    expect(candidateNames(cam, ['Pinned'])).toEqual(['Pinned', 'TriggerSelector', 'TriggerMode']);
  });
});

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

describe('pins', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('round-trip per camera model', () => {
    const key = pinsKey('AT', 'C6-2040-GigE');
    expect(loadPins(key)).toEqual([]);
    savePins(key, ['Scan3dExtractionMethod']);
    expect(loadPins(key)).toEqual(['Scan3dExtractionMethod']);
    expect(loadPins(pinsKey('AT', 'C5'))).toEqual([]);
  });

  it('ignore garbage and a throwing localStorage', () => {
    localStorage.setItem('k', '{"not":"a list"}');
    expect(loadPins('k')).toEqual([]);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadPins('k')).toEqual([]);
    expect(() => savePins('k', ['X'])).not.toThrow();
  });
});
