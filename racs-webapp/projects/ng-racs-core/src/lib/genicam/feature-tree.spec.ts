import type { GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';
import { buildRows, dependentsOf, selectorsOf } from './feature-tree';

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

function rows(nodes: GenICamNodeInfo[], categories?: GenICamNodeCategory[]) {
  const all = categories ?? [{ name: 'C', display_name: 'C', nodes }];
  return buildRows(nodes, selectorsOf(all)).map((r) => ({
    name: r.node.name,
    depth: r.depth,
    selectedBy: r.selectedBy,
  }));
}

describe('buildRows', () => {
  it('nests selected features under their selector, even when the document lists them first', () => {
    const nodes = [node('Gain'), node('Width'), node('GainSelector', ['Gain', 'BlackLevel']), node('BlackLevel')];
    expect(rows(nodes)).toEqual([
      { name: 'Width', depth: 0, selectedBy: [] },
      { name: 'GainSelector', depth: 0, selectedBy: [] },
      { name: 'Gain', depth: 1, selectedBy: [] },
      { name: 'BlackLevel', depth: 1, selectedBy: [] },
    ]);
  });

  it('puts a feature under the most specific of several selectors', () => {
    const nodes = [
      node('LUTSelector', ['LUTEnable', 'LUTIndex', 'LUTValue']),
      node('LUTEnable'),
      node('LUTIndex', ['LUTValue']),
      node('LUTValue'),
    ];
    expect(rows(nodes)).toEqual([
      { name: 'LUTSelector', depth: 0, selectedBy: [] },
      { name: 'LUTEnable', depth: 1, selectedBy: [] },
      { name: 'LUTIndex', depth: 1, selectedBy: [] },
      { name: 'LUTValue', depth: 2, selectedBy: [] },
    ]);
  });

  it('keeps a feature whose selector is elsewhere at the top level and names the selector', () => {
    const analog = [node('Gain')];
    const categories = [
      { name: 'A', display_name: 'A', nodes: analog },
      { name: 'S', display_name: 'S', nodes: [node('GainSelector', ['Gain'])] },
    ];
    expect(rows(analog, categories)).toEqual([{ name: 'Gain', depth: 0, selectedBy: ['GainSelector'] }]);
  });

  it('shows every node of a pSelected cycle instead of dropping it', () => {
    const nodes = [node('A', ['B']), node('B', ['A'])];
    expect(rows(nodes).map((r) => r.name).sort()).toEqual(['A', 'B']);
  });
});

describe('dependentsOf', () => {
  it('follows selectors transitively', () => {
    const categories = [
      {
        name: 'C',
        display_name: 'C',
        nodes: [node('LUTSelector', ['LUTIndex']), node('LUTIndex', ['LUTValue']), node('LUTValue')],
      },
    ];
    expect(dependentsOf('LUTSelector', categories)).toEqual(['LUTIndex', 'LUTValue']);
    expect(dependentsOf('LUTValue', categories)).toEqual([]);
  });
});
