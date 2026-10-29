/**
 * The laserline tool's remote protocol (version 1), as RACS speaks it. The laserline window
 * (`/tools/laserline/`) listens on a same-origin `BroadcastChannel`.
 *
 * Mirrors `laserthing/packages/laserline/src/remote.ts` (the two are separate npm projects); keep
 * them in step. All coordinates are laserline view pixels (its canvas' drawing buffer, y down).
 */

export const LASERLINE_CHANNEL = 'laserline-remote';
export const LASERLINE_PROTOCOL = 1;

export type ViewPoint = [number, number];

/** The area the user's line covers over its whole motion, deformation and scan playback. */
export interface Envelope {
  /** (along min, across min), (along max, across min), (along max, across max), (along min, across max). */
  corners: [ViewPoint, ViewPoint, ViewPoint, ViewPoint];
  center_px: ViewPoint;
  dir: ViewPoint;
  normal: ViewPoint;
  along_px: [number, number];
  across_px: [number, number];
}

/** The user's line at rest (no motion) and at height 0. */
export interface BaseLine {
  /** Where `u0_mm` lies. */
  center_px: ViewPoint;
  /** Unit vector of +u. */
  dir: ViewPoint;
  /** `[-dir.y, dir.x]`: heights move the line along it by `height_px_per_mm` (signed). */
  normal: ViewPoint;
}

/** What makes the metric mapping unreliable for measuring. */
export type MetricDisturbance =
  /** The line moves on its own. */
  | 'motion'
  /** The return pass runs backwards in v. */
  | 'bounce'
  /** The playback stops at the last row. */
  | 'once'
  | 'paused'
  /** Ambient light, speckle or sensor noise. */
  | 'noise'
  /** Height gain ≈ 0: heights don't move the line. */
  | 'flat';

/**
 * How the user's line maps the loaded scan into view px, and how fast it travels (laserline's
 * `RemoteMetric`). A view point `p` shows `u = u0_mm + (p − center_px)·dir ÷ along_px_per_mm` and
 * `z = (p − center_px)·normal ÷ height_px_per_mm` (mm above the base); a scan row is `dv_mm` of travel.
 * During a calibration session it stays the user's line, not the pattern shown.
 */
export interface MetricMapping {
  /** Changes whenever another field does, not with frame-rate jitter. */
  rev: number;
  base: BaseLine;
  /** View px per mm of u, along `base.dir`. */
  along_px_per_mm: number;
  /** View px per mm of height along `base.normal`, signed: `invert ? +g : −g`. */
  height_px_per_mm: number;
  /** u at the base centre. */
  u0_mm: number;
  /** Travel per scan row. */
  dv_mm: number;
  rows: number;
  travel: {
    mode: 'per_frame' | 'per_second';
    /** `per_second`: `profiles_per_s × time_scale`; `per_frame`: laserline's measured frame rate (held within 1 %). */
    rows_per_s: number;
    /** `rows_per_s × dv_mm`. */
    mm_per_s: number;
    /** True for `per_frame`. */
    approximate: boolean;
    playing: boolean;
    end: 'loop' | 'bounce' | 'once';
  };
  /** The object's (u, v, z) extent without the margins; `null` when nothing rises above 1e-3 mm. */
  object_mm: { min: [number, number, number]; max: [number, number, number] } | null;
  /** The scan frame is a mirror image of the model (laserline's slice settings). */
  model_mirrored: boolean;
  disturbances: MetricDisturbance[];
}

export type Orientation = 'Horizontal' | 'Vertical';

/**
 * Nothing; a line across the view (with `width_pct` a band that wide, percent of the view across
 * it; with `tilt_deg` rotated that much about its centre, y down); the whole view white; or the stripes of bit `bit` of a Gray code of the view's columns
 * (`Vertical`) or rows (`Horizontal`): view pixel `p` is lit where bit `bit` of `p ^ (p >> 1)` is set.
 */
export type Pattern =
  | { kind: 'blank' }
  | { kind: 'line'; orientation: Orientation; position_pct: number; width_pct?: number; tilt_deg?: number }
  | { kind: 'white' }
  | { kind: 'stripes'; orientation: Orientation; bit: number; inverted?: boolean };

export interface RemoteStatus {
  /** `[0, 0]` before the view's first frame. */
  viewPx: ViewPoint;
  envelope: Envelope | null;
  session: string | null;
  field: ViewPoint[] | null;
  /** The area the line is kept in (`constrain`); missing from a laserline that can't keep one. */
  constraint?: ViewPoint[] | null;
  /** The user's line tilt in degrees on top of its orientation; missing from a laserline that can't set it. */
  tilt_deg?: number;
  /**
   * The metric mapping of the user's line; `null` without a scan, with the scan disabled or before
   * the first frame; missing from a laserline that can't publish it.
   */
  metric?: MetricMapping | null;
}

export type ToLaserline =
  | { v: 1; type: 'hello' }
  | { v: 1; type: 'begin'; to: string; session: string }
  | { v: 1; type: 'show'; to: string; session: string; id: number; pattern: Pattern }
  | { v: 1; type: 'end'; to: string; session: string }
  | { v: 1; type: 'camera-field'; to: string; polygon: ViewPoint[] | null; label?: string }
  | { v: 1; type: 'fit-to-field'; to: string; id: number; margin: number }
  /**
   * Keep the line, its motion, deformation and scan height inside `polygon` (convex, view px) until
   * released with `null`: laserline clamps its parameters into it and its controls stop there.
   */
  | { v: 1; type: 'constrain'; to: string; id: number; polygon: ViewPoint[] | null; label?: string }
  /** Set the user's line tilt (applied when a running session ends); answered by `tilted` with the tilt kept (±45). */
  | { v: 1; type: 'tilt'; to: string; id: number; tilt_deg: number };

export type FromLaserline =
  | { v: 1; type: 'status'; host: string; status: RemoteStatus }
  | { v: 1; type: 'shown'; host: string; session: string; id: number; viewPx: ViewPoint }
  | { v: 1; type: 'fitted'; host: string; id: number; fits: boolean }
  /** `constrain` took effect; `clamped` names the parameters it changed to fit (laserline's labels). */
  | { v: 1; type: 'constrained'; host: string; id: number; clamped: string[] }
  | { v: 1; type: 'tilted'; host: string; id: number; tilt_deg: number }
  | { v: 1; type: 'error'; host: string; session?: string; id?: number; message: string };
