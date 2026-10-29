import type { FeatureState, GenICamNodeInfo } from '../models/racs.models';

/**
 * The features worth having at hand while acquiring, by SFNC name. A camera shows the ones it
 * has; vendor names (the AT C6's `SensorGain`, its laser `Light*`) sit next to the standard ones
 * they stand in for. `PixelFormat` is left out on purpose: the live view's depth setting owns it.
 */
/** The stream packet size. Its row gets the link MTU and Auto (`PacketSizeToolsComponent`). */
export const PACKET_SIZE_FEATURE = 'GevSCPSPacketSize';

/**
 * Shown in the essentials strip above the acquisition tabs, so they are left out of the
 * sections (and of the pins) here.
 */
export const ESSENTIAL_FEATURES: readonly string[] = ['DeviceScanType', 'ExposureTime'];

export interface QuickSection {
  id: string;
  title: string;
  features: readonly string[];
}

export const CURATED_SECTIONS: readonly QuickSection[] = [
  {
    id: 'acquisition',
    title: 'Acquisition',
    features: [
      'AcquisitionFrameRateEnable',
      'AcquisitionFrameRate',
      'AcquisitionLineRateEnable',
      'AcquisitionLineRate',
      'AcquisitionMode',
      'ExposureMode',
      'MultiSlopeMode',
    ],
  },
  {
    id: 'gain',
    title: 'Gain & levels',
    features: ['GainSelector', 'Gain', 'SensorGain', 'BlackLevelSelector', 'BlackLevel'],
  },
  {
    id: 'trigger',
    title: 'Trigger',
    features: ['TriggerSelector', 'TriggerMode', 'TriggerSource', 'TriggerActivation', 'TriggerSoftware'],
  },
  {
    id: 'region',
    title: 'Region',
    features: ['RegionSelector', 'RegionMode', 'Width', 'Height', 'OffsetX', 'OffsetY', 'ReverseX', 'ReverseY'],
  },
  {
    id: 'light',
    title: 'Light',
    features: ['LightBrightness', 'LightControllerSource', 'LightConnectionStatus'],
  },
  {
    id: 'user-sets',
    title: 'User sets',
    features: ['UserSetSelector', 'UserSetLoad', 'UserSetSave', 'UserSetDefault'],
  },
  {
    id: 'transport',
    title: 'Transport',
    features: [PACKET_SIZE_FEATURE],
  },
  {
    id: 'status',
    title: 'Status',
    features: ['DeviceTemperature', 'SensorRateMax'],
  },
];

/** Status readings refreshed periodically while live. */
export const POLLED_FEATURES: readonly string[] = ['DeviceTemperature', 'LightConnectionStatus'];

export const PINNED_SECTION_ID = 'pinned';

/** One line of a section. `depth` 1 nests a feature under a selector shown just above it. */
export interface QuickRow {
  node: GenICamNodeInfo;
  depth: number;
}

export interface ResolvedSection {
  id: string;
  title: string;
  rows: QuickRow[];
}

/** Feature name → the selectors that list it in `pSelected`. */
function selectorIndex(nodes: ReadonlyMap<string, GenICamNodeInfo>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const target of node.selected ?? []) {
      const list = index.get(target) ?? [];
      list.push(node.name);
      index.set(target, list);
    }
  }
  return index;
}

function sectionsWithPins(pins: readonly string[]): QuickSection[] {
  const curated = new Set(CURATED_SECTIONS.flatMap((s) => s.features));
  const extra = pins.filter((p) => !curated.has(p) && !ESSENTIAL_FEATURES.includes(p));
  return extra.length
    ? [{ id: PINNED_SECTION_ID, title: 'Pinned', features: extra }, ...CURATED_SECTIONS]
    : [...CURATED_SECTIONS];
}

/** Every feature the panel may show on this camera, selectors included: what to read state for. */
export function candidateNames(nodes: ReadonlyMap<string, GenICamNodeInfo>, pins: readonly string[]): string[] {
  const selectors = selectorIndex(nodes);
  const out = new Set<string>();
  for (const section of sectionsWithPins(pins)) {
    for (const name of section.features) {
      if (!nodes.has(name)) {
        continue;
      }
      for (const s of selectors.get(name) ?? []) {
        out.add(s);
      }
      out.add(name);
    }
  }
  return [...out];
}

/**
 * The sections as this camera shows them: only features it has and that are available right now
 * (one whose state hasn't arrived yet still shows, as loading), each preceded by the selectors
 * that pick which instance it addresses, so `LightBrightness` comes with its
 * `LightControllerSelector`. Pins not already curated form a first "Pinned" section; empty
 * sections are dropped.
 */
export function resolveSections(
  nodes: ReadonlyMap<string, GenICamNodeInfo>,
  states: Partial<Record<string, FeatureState>>,
  pins: readonly string[],
): ResolvedSection[] {
  const selectors = selectorIndex(nodes);
  const shown = (name: string) => nodes.has(name) && states[name]?.available !== false;

  const out: ResolvedSection[] = [];
  for (const section of sectionsWithPins(pins)) {
    const rows: QuickRow[] = [];
    const placed = new Set<string>();
    for (const name of section.features) {
      if (!shown(name) || placed.has(name)) {
        continue;
      }
      const own = (selectors.get(name) ?? []).filter(shown);
      for (const s of own) {
        if (!placed.has(s)) {
          placed.add(s);
          rows.push({ node: nodes.get(s)!, depth: 0 });
        }
      }
      placed.add(name);
      rows.push({ node: nodes.get(name)!, depth: own.length > 0 ? 1 : 0 });
    }
    if (rows.length > 0) {
      out.push({ id: section.id, title: section.title, rows });
    }
  }
  return out;
}

/** localStorage key for the pins of one camera model; pins are shared by identical cameras. */
export function pinsKey(vendor: string, model: string): string {
  return `racs.quick.pins.${vendor}/${model}`;
}

export function loadPins(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function savePins(key: string, pins: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(pins));
  } catch {
    // Remembering pins is a convenience only.
  }
}
