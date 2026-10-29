/** What the 3D tab remembers, and how much it may hold and draw. */

import type { PixelDepth } from '../models/racs.models';
import { DEFAULT_LIGHT, sanitizeLight, type LightSettings } from './lighting';
import { VIEW_PRESETS, type ViewPreset } from './orbit';
import { isPaletteId, type PaletteId } from './palette';

export type CloudMode = 'continuous' | 'snapshot';
/** Every n-th column and profile drawn; `auto` thins to the point budget. */
export type Density = 'auto' | 1 | 2 | 4 | 8;
/** `auto` stretches z to a share of the footprint; `true` keeps the units' proportions. */
export type ZAspect = 'auto' | 'true';
/** A point per value, or a surface through them. */
export type RenderMode = 'points' | 'surface';

/** Display-only stretch per axis, on top of the scaling (and of the automatic z stretch). */
export interface Stretch {
  x: number;
  y: number;
  z: number;
}

export interface CloudSettings {
  mode: CloudMode;
  depth: PixelDepth;
  /** Rolling buffer length, in profiles. */
  capacity: number;
  /** Frames per snapshot. */
  frames: number;
}

export interface CloudViewSettings {
  /** CSS px. */
  pointSize: number;
  density: Density;
  zAspect: ZAspect;
  /** Where a fit looks from. */
  preset: ViewPreset;
  /** How heights are coloured. */
  palette: PaletteId;
  render: RenderMode;
  /** A surface breaks where neighbouring values differ by more than this share of the display window. */
  jump: number;
  stretch: Stretch;
  light: LightSettings;
}

export interface CloudBudget {
  /** Points drawn per frame at `auto` density. */
  maxPoints: number;
  rollingDefault: number;
  /** Bytes the stored profiles may take, once on the CPU and once on the GPU. */
  maxBytes: number;
  /** Canvas pixels per CSS px at most. */
  maxDpr: number;
  /** Triangles drawn per frame at `auto` density, in surface mode. */
  maxTriangles: number;
  /** Shadow map edge, in texels. */
  shadowSize: number;
}

export const CAPACITY_CHOICES: readonly number[] = [1024, 2048, 4096, 8192, 16384, 32768];
export const DENSITY_CHOICES: readonly Density[] = ['auto', 1, 2, 4, 8];
/** The server's burst limit. */
export const MAX_FRAMES = 500;
export const POINT_SIZE = { min: 1, max: 6, step: 0.5 };
export const STRETCH = { min: 0.01, max: 100 };
export const JUMP = { min: 0.01, max: 1, step: 0.01 };
export const NO_STRETCH: Stretch = { x: 1, y: 1, z: 1 };

const SETTINGS_KEY = 'racs.cloud';
const VIEW_KEY = 'racs.cloud.view';

const MiB = 2 ** 20;

export function cloudBudget(mobile: boolean): CloudBudget {
  return mobile
    ? { maxPoints: 1_000_000, rollingDefault: 4096, maxBytes: 96 * MiB, maxDpr: 2, maxTriangles: 1_000_000, shadowSize: 1024 }
    : { maxPoints: 4_000_000, rollingDefault: 8192, maxBytes: 256 * MiB, maxDpr: 2, maxTriangles: 4_000_000, shadowSize: 2048 };
}

export function loadCloudSettings(mobile: boolean): CloudSettings {
  const fallback: CloudSettings = {
    mode: 'continuous',
    depth: 'mono16',
    capacity: cloudBudget(mobile).rollingDefault,
    frames: 10,
  };
  const raw = load(SETTINGS_KEY) as Partial<CloudSettings> | null;
  if (!raw) {
    return fallback;
  }
  return {
    mode: raw.mode === 'snapshot' ? 'snapshot' : 'continuous',
    depth: raw.depth === 'mono8' ? 'mono8' : 'mono16',
    capacity: CAPACITY_CHOICES.includes(raw.capacity as number) ? (raw.capacity as number) : fallback.capacity,
    frames: clampFrames(raw.frames, fallback.frames),
  };
}

export function saveCloudSettings(s: CloudSettings): void {
  save(SETTINGS_KEY, s);
}

export function loadCloudView(): CloudViewSettings {
  const raw = (load(VIEW_KEY) ?? {}) as Partial<CloudViewSettings>;
  const size = Number(raw.pointSize);
  return {
    pointSize: Number.isFinite(size) ? Math.min(POINT_SIZE.max, Math.max(POINT_SIZE.min, size)) : 1.5,
    density: DENSITY_CHOICES.includes(raw.density as Density) ? (raw.density as Density) : 'auto',
    zAspect: raw.zAspect === 'true' ? 'true' : 'auto',
    preset: VIEW_PRESETS.includes(raw.preset as ViewPreset) ? (raw.preset as ViewPreset) : 'iso',
    palette: isPaletteId(raw.palette) ? raw.palette : 'grey',
    render: raw.render === 'surface' ? 'surface' : 'points',
    jump: typeof raw.jump === 'number' && Number.isFinite(raw.jump) ? Math.min(JUMP.max, Math.max(JUMP.min, raw.jump)) : 0.1,
    stretch: sanitizeStretch(raw.stretch),
    light: sanitizeLight(raw.light, DEFAULT_LIGHT),
  };
}

/** Each factor within `STRETCH`; what isn't a number is 1. */
export function sanitizeStretch(raw: unknown): Stretch {
  const r = (raw ?? {}) as Partial<Record<keyof Stretch, unknown>>;
  return { x: clampStretch(r.x), y: clampStretch(r.y), z: clampStretch(r.z) };
}

export function clampStretch(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(STRETCH.max, Math.max(STRETCH.min, n)) : 1;
}

export function isNoStretch(s: Stretch): boolean {
  return s.x === 1 && s.y === 1 && s.z === 1;
}

export function saveCloudView(v: CloudViewSettings): void {
  save(VIEW_KEY, v);
}

export function clampFrames(v: unknown, fallback = 10): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_FRAMES, n) : fallback;
}

/** A remembered open/closed state. */
export function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function saveFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Remembering is a convenience only.
  }
}

function load(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering is a convenience only.
  }
}
