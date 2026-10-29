import type { GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';

/** One rendered line of a category: a feature, indented under the selector it depends on. */
export interface FeatureRow {
  node: GenICamNodeInfo;
  /** 0 for a top-level feature, +1 per selector it is nested under. */
  depth: number;
  /** The selector this row is nested under, if any. */
  parent: string | null;
  /** Selectors this feature depends on that it is *not* nested under (other category, hidden). */
  selectedBy: string[];
}

export interface FeatureCategory {
  name: string;
  display_name: string;
  rows: FeatureRow[];
}

export function isSelector(node: GenICamNodeInfo): boolean {
  return (node.selected?.length ?? 0) > 0;
}

/** Feature name → the selectors that list it in `pSelected`, across every category. */
export function selectorsOf(categories: GenICamNodeCategory[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const cat of categories) {
    for (const node of cat.nodes) {
      if (seen.has(node.name)) {
        continue;
      }
      seen.add(node.name);
      for (const target of node.selected ?? []) {
        const list = index.get(target) ?? [];
        list.push(node.name);
        index.set(target, list);
      }
    }
  }
  return index;
}

/**
 * Orders one category's nodes the way a GenICam browser shows them: document order at the top
 * level, with every feature a selector controls nested directly beneath that selector (in the
 * selector's `pSelected` order). A feature selected by several selectors of the category goes
 * under the most specific one, e.g. `LUTValue` under `LUTIndex` rather than `LUTSelector` when
 * `LUTSelector` also selects `LUTIndex`.
 */
export function buildRows(nodes: GenICamNodeInfo[], selectors: Map<string, string[]>): FeatureRow[] {
  const byName = new Map(nodes.map((n) => [n.name, n]));

  // Pick each node's parent among the selectors present in this category.
  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    const candidates = (selectors.get(node.name) ?? []).filter((s) => s !== node.name && byName.has(s));
    if (candidates.length === 0) {
      continue;
    }
    const mostSpecific = candidates.find(
      (c) => !candidates.some((other) => other !== c && byName.get(c)!.selected?.includes(other)),
    );
    parentOf.set(node.name, mostSpecific ?? candidates[0]);
  }

  const childrenOf = new Map<string, GenICamNodeInfo[]>();
  for (const selector of nodes) {
    const children = (selector.selected ?? [])
      .filter((name) => parentOf.get(name) === selector.name)
      .map((name) => byName.get(name)!);
    if (children.length > 0) {
      childrenOf.set(selector.name, children);
    }
  }

  const rows: FeatureRow[] = [];
  const placed = new Set<string>();
  const visit = (node: GenICamNodeInfo, ancestors: string[]): void => {
    if (placed.has(node.name)) {
      return;
    }
    placed.add(node.name);
    rows.push({
      node,
      depth: ancestors.length,
      parent: ancestors.at(-1) ?? null,
      selectedBy: (selectors.get(node.name) ?? []).filter((s) => !ancestors.includes(s)),
    });
    for (const child of childrenOf.get(node.name) ?? []) {
      visit(child, [...ancestors, node.name]);
    }
  };

  for (const node of nodes) {
    if (!parentOf.has(node.name)) {
      visit(node, []);
    }
  }
  // Anything still unplaced sits in a pSelected cycle; show it flat rather than drop it.
  for (const node of nodes) {
    visit(node, []);
  }
  return rows;
}

/** Every feature whose value can change when `name` is written: its selected features, transitively. */
export function dependentsOf(name: string, categories: GenICamNodeCategory[]): string[] {
  const nodes = new Map<string, GenICamNodeInfo>();
  for (const cat of categories) {
    for (const node of cat.nodes) {
      if (!nodes.has(node.name)) {
        nodes.set(node.name, node);
      }
    }
  }
  const out: string[] = [];
  const seen = new Set([name]);
  const queue = [...(nodes.get(name)?.selected ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
    queue.push(...(nodes.get(next)?.selected ?? []));
  }
  return out;
}
