import type { FeatureState, GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';
import { categoryNames, categoryRows, selectorNames, selectorRows } from './camera-sections';

function node(name: string, selected: string[] = [], visibility: GenICamNodeInfo['visibility'] = 'Expert'): GenICamNodeInfo {
  return { name, display_name: name, node_type: 'Integer', visibility, access_mode: 'ReadWrite', enums: null, selected };
}

function unavailable(name: string): FeatureState {
  return {
    name,
    node_type: 'Integer',
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

// The AT C6's Scan3dControl and the RegionSelector branch of ImageFormatControl, shortened.
const scan3d: GenICamNodeCategory = {
  name: 'Scan3dControl',
  display_name: 'Scan 3d Control',
  nodes: [
    node('Scan3dCapabilities', [], 'Invisible'),
    node('Scan3dScanDirection'),
    node('Scan3dExtractionSelector', ['Scan3dExtractionMethod', 'Scan3dFilterCoefficientSelector', 'Scan3dCoordinateSelector']),
    node('Scan3dExtractionMethod'),
    node('Scan3dFilterCoefficientSelector', ['Scan3dFilterCoefficientValue']),
    node('Scan3dFilterCoefficientValue'),
    node('Scan3dCoordinateSelector', ['Scan3dCoordinateScale']),
    node('Scan3dCoordinateScale'),
  ],
};

const imageFormat: GenICamNodeCategory = {
  name: 'ImageFormatControl',
  display_name: 'Image Format Control',
  nodes: [
    node('SensorWidth'),
    node('RegionSelector', ['RegionMode', 'Width', 'ComponentSelector']),
    node('RegionMode'),
    node('Width'),
    node('ComponentSelector', ['ComponentEnable', 'PixelFormat', 'RegionIDHidden']),
    node('ComponentEnable'),
    node('PixelFormat'),
    node('RegionIDHidden', [], 'Invisible'),
  ],
};

const nodes = new Map([...scan3d.nodes, ...imageFormat.nodes].map((n) => [n.name, n]));

describe('categoryRows', () => {
  it('lists the visible features, each under the selectors that select it', () => {
    const rows = categoryRows([imageFormat, scan3d], 'Scan3dControl', {});
    expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
      ['Scan3dScanDirection', 0],
      ['Scan3dExtractionSelector', 0],
      ['Scan3dExtractionMethod', 1],
      ['Scan3dFilterCoefficientSelector', 1],
      ['Scan3dFilterCoefficientValue', 2],
      ['Scan3dCoordinateSelector', 1],
      ['Scan3dCoordinateScale', 2],
    ]);
  });

  it('leaves out what the camera does not offer now, and its nesting with it', () => {
    const rows = categoryRows([scan3d], 'Scan3dControl', {
      Scan3dScanDirection: unavailable('Scan3dScanDirection'),
      Scan3dExtractionSelector: unavailable('Scan3dExtractionSelector'),
    });
    expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
      ['Scan3dExtractionMethod', 0],
      ['Scan3dFilterCoefficientSelector', 0],
      ['Scan3dFilterCoefficientValue', 1],
      ['Scan3dCoordinateSelector', 0],
      ['Scan3dCoordinateScale', 1],
    ]);
  });

  it('is empty for a category the camera lacks', () => {
    expect(categoryRows([imageFormat], 'Scan3dControl', {})).toEqual([]);
    expect(categoryNames([imageFormat], 'Scan3dControl')).toEqual([]);
  });

  it('names every visible feature, offered or not, to read their states', () => {
    expect(categoryNames([scan3d], 'Scan3dControl')).not.toContain('Scan3dCapabilities');
    expect(categoryNames([scan3d], 'Scan3dControl')).toHaveLength(7);
  });
});

describe('selectorRows', () => {
  it('follows the selector through nested selectors, depth first', () => {
    const rows = selectorRows(nodes, 'RegionSelector', {});
    expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
      ['RegionSelector', 0],
      ['RegionMode', 1],
      ['Width', 1],
      ['ComponentSelector', 1],
      ['ComponentEnable', 2],
      ['PixelFormat', 2],
    ]);
    expect(selectorNames(nodes, 'RegionSelector')).toHaveLength(6);
  });

  it('drops features the camera does not offer now', () => {
    const rows = selectorRows(nodes, 'RegionSelector', { Width: unavailable('Width') });
    expect(rows.map((r) => r.node.name)).not.toContain('Width');
  });

  it('is empty without the selector', () => {
    expect(selectorRows(new Map(), 'RegionSelector', {})).toEqual([]);
  });
});
