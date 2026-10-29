import type { FeatureState, GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';

/**
 * The camera's own settings shown in the 3D tab's inspector, built from its GenICam tree rather
 * than a fixed list: a category (`Scan3dControl`) or a selector with everything it selects
 * (`RegionSelector` → Width, Height, … → `ComponentSelector` → `PixelFormat`, …). What a camera
 * offers in its current mode (a C6 in `Linescan3D` offers only `Scan3dExtraction0..3` as regions
 * and locks their width) then comes from the camera, through the features' live states.
 */

/** One line: `depth` counts the selectors above it that are shown too. */
export interface CameraRow {
  node: GenICamNodeInfo;
  depth: number;
}

/** Features a GUI never shows. */
function hidden(node: GenICamNodeInfo): boolean {
  return node.visibility === 'Invisible';
}

/** Shown unless its state says the camera doesn't offer it now; one not read yet shows as loading. */
function offered(name: string, states: Partial<Record<string, FeatureState>>): boolean {
  return states[name]?.available !== false;
}

/** Every visible feature of `category`, in the camera's order: what to read state for. */
export function categoryNames(categories: readonly GenICamNodeCategory[], category: string): string[] {
  const cat = categories.find((c) => c.name === category);
  return cat ? cat.nodes.filter((n) => !hidden(n)).map((n) => n.name) : [];
}

/**
 * The rows of `category`: its visible features the camera offers now, each nested under the
 * selectors of the same category that select it.
 */
export function categoryRows(
  categories: readonly GenICamNodeCategory[],
  category: string,
  states: Partial<Record<string, FeatureState>>,
): CameraRow[] {
  const cat = categories.find((c) => c.name === category);
  if (!cat) {
    return [];
  }
  const shown = cat.nodes.filter((n) => !hidden(n) && offered(n.name, states));
  const parent = new Map<string, string>();
  for (const node of shown) {
    for (const target of node.selected ?? []) {
      if (!parent.has(target) && target !== node.name) {
        parent.set(target, node.name);
      }
    }
  }
  const depth = (name: string): number => {
    let d = 0;
    const seen = new Set([name]);
    for (let p = parent.get(name); p !== undefined && !seen.has(p); p = parent.get(p)) {
      seen.add(p);
      d++;
    }
    return d;
  };
  return shown.map((node) => ({ node, depth: depth(node.name) }));
}

/** `selector` and everything it selects, transitively, depth first: what to read state for. */
export function selectorNames(nodes: ReadonlyMap<string, GenICamNodeInfo>, selector: string): string[] {
  return selectorRows(nodes, selector, {}).map((r) => r.node.name);
}

/**
 * The rows of `selector`: the selector, then each feature it selects that the camera offers now
 * (a selector among them followed by its own), nested one level per selector.
 */
export function selectorRows(
  nodes: ReadonlyMap<string, GenICamNodeInfo>,
  selector: string,
  states: Partial<Record<string, FeatureState>>,
): CameraRow[] {
  const rows: CameraRow[] = [];
  const placed = new Set<string>();
  const visit = (name: string, depth: number) => {
    const node = nodes.get(name);
    if (!node || placed.has(name) || hidden(node) || !offered(name, states)) {
      return;
    }
    placed.add(name);
    rows.push({ node, depth });
    for (const target of node.selected ?? []) {
      visit(target, depth + 1);
    }
  };
  visit(selector, 0);
  return rows;
}
