/**
 * Calibrating a camera against the laserline tool, which usually sees only part of the display:
 * the calibration (a screen → sensor homography, solved from Gray-code stripes in `gray-code.ts`),
 * the part of the screen the camera sees, the camera region that holds the line's whole envelope,
 * the region a line can travel in (and that region mapped back into the view, laserline's limits),
 * and whether a frame shows the whole line.
 *
 * Screen coordinates are laserline view pixels; sensor coordinates are full-sensor pixels (the
 * calibration grabs with the region at full size).
 */

import type { Envelope, ViewPoint } from '../laserline/protocol';
import { applyHomography, invertHomography, type Mat3, type Point, type PointPair } from './homography';
import { linePeaks, type Plane, type ScanAxis } from './laser-line';
import { coverRegion, fullRegion, type Region, type RegionLimits } from './region';
import type { Size } from './view';

/** Free sensor pixels kept around the line's envelope. */
export const REGION_MARGIN_PX = 8;
/** Above this reprojection error (sensor px) the mapping is reported as rough. */
export const RMS_WARN_PX = 2;
/**
 * Above this reprojection error (sensor px) the mapping is refused. A homography has no lens
 * distortion, so a few px over a wide field are normal; the region's margin grows with the error.
 */
export const MAX_RMS_PX = 8;

/** A finished calibration, as stored per device. */
export interface Calibration {
  /** Laserline view px → full-sensor px. */
  h: Mat3;
  /** The laserline view size it was measured with; another size invalidates it. */
  viewPx: ViewPoint;
  sensor: Size;
  /** Reprojection error of the point pairs, sensor px. */
  rms: number;
  pairs: number;
  /** Epoch ms. */
  at: number;
  /** Mean reprojection error per 3×3 sensor tile (row by row), sensor px; null where no cell fell. */
  tiles?: (number | null)[];
}

/** The part of the laserline view the camera's sensor sees, as a convex polygon in view px. */
export function cameraField(cal: Calibration): ViewPoint[] {
  const inv = invertHomography(cal.h);
  if (!inv) {
    return [];
  }
  const { width, height } = cal.sensor;
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((p) => applyHomography(inv, p));
  const [vw, vh] = cal.viewPx;
  return clipToRect(corners, vw, vh).map((p) => [round1(p.x), round1(p.y)] as ViewPoint);
}

/** Share (0..1) of the laserline view the camera sees. */
export function fieldFraction(field: ViewPoint[], viewPx: ViewPoint): number {
  const area = Math.abs(field.reduce((s, p, i) => {
    const q = field[(i + 1) % field.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  return viewPx[0] > 0 && viewPx[1] > 0 ? area / (viewPx[0] * viewPx[1]) : 0;
}

/** The laserline view on the sensor: its corners mapped through the calibration, clipped to the sensor. */
export function viewOnSensor(cal: Calibration): Point[] {
  const [vw, vh] = cal.viewPx;
  const corners = [
    { x: 0, y: 0 },
    { x: vw, y: 0 },
    { x: vw, y: vh },
    { x: 0, y: vh },
  ].map((p) => applyHomography(cal.h, p));
  return clipToRect(corners, cal.sensor.width, cal.sensor.height);
}

/** Where a line can travel and the camera still sees it. */
export interface TravelArea {
  /** The part of the sensor the laserline view covers. */
  polygon: Point[];
  /** The region holding it, on the device's grid and inside the sensor. */
  region: Region;
}

/** The region covering every sensor pixel that sees the laserline view; null if it sees none. */
export function travelArea(cal: Calibration, limits: RegionLimits): TravelArea | null {
  const polygon = viewOnSensor(cal);
  if (polygon.length < 3) {
    return null;
  }
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return { polygon, region: coverRegion(box, limits) };
}

/**
 * A camera region `margin` sensor px inside its edges, mapped into the laserline view and clipped
 * to it: where laserline may draw the line so that the camera sees it whole in that region.
 */
export function regionInView(cal: Calibration, region: Region, margin: number): ViewPoint[] {
  const inv = invertHomography(cal.h);
  if (!inv || region.width <= 2 * margin || region.height <= 2 * margin) {
    return [];
  }
  const x0 = region.x + margin;
  const y0 = region.y + margin;
  const x1 = region.x + region.width - margin;
  const y1 = region.y + region.height - margin;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ].map((p) => applyHomography(inv, p));
  const [vw, vh] = cal.viewPx;
  return clipToRect(corners, vw, vh).map((p) => [round1(p.x), round1(p.y)] as ViewPoint);
}

/** The region over the sensor's whole width: only the rows are cropped. */
export function fullWidth(region: Region, limits: RegionLimits): Region {
  const full = fullRegion(limits);
  return { ...region, x: full.x, width: full.width };
}

/** Mean reprojection error (sensor px) of point pairs per 3×3 tile of the sensor, row by row. */
export function residualTiles(h: Mat3, pairs: PointPair[], sensor: Size): (number | null)[] {
  const sums = Array.from({ length: 9 }, () => ({ e: 0, n: 0 }));
  for (const { from, to } of pairs) {
    const p = applyHomography(h, from);
    const t = sums[Math.min(2, Math.floor((3 * to.y) / sensor.height)) * 3 + Math.min(2, Math.floor((3 * to.x) / sensor.width))];
    t.e += Math.hypot(p.x - to.x, p.y - to.y);
    t.n++;
  }
  return sums.map((t) => (t.n ? t.e / t.n : null));
}

/** Sutherland–Hodgman clipping of a polygon to `0..w × 0..h`. */
function clipToRect(polygon: Point[], w: number, h: number): Point[] {
  const edges: [(p: Point) => number, (a: Point, b: Point) => Point][] = [
    [(p) => p.x, (a, b) => lerpAt(a, b, (0 - a.x) / (b.x - a.x))],
    [(p) => w - p.x, (a, b) => lerpAt(a, b, (w - a.x) / (b.x - a.x))],
    [(p) => p.y, (a, b) => lerpAt(a, b, (0 - a.y) / (b.y - a.y))],
    [(p) => h - p.y, (a, b) => lerpAt(a, b, (h - a.y) / (b.y - a.y))],
  ];
  let out = polygon;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const ia = inside(a) >= 0;
      const ib = inside(b) >= 0;
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
  }
  return out;
}

function lerpAt(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** How far (sensor px) the envelope plus margin reaches past each sensor edge; 0 = inside. */
export interface Overflow {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RegionProposal {
  /** The envelope on the sensor (its four corners). */
  polygon: Point[];
  /** The region holding it, on the device's grid and inside the sensor. */
  region: Region;
  overflow: Overflow;
  /** The envelope and margin fit on the sensor. */
  complete: boolean;
  /** Which way the line runs on the sensor, for checking frames. */
  axis: ScanAxis;
}

/** The camera region that holds the line's whole envelope, `margin` px around it. */
export function proposeRegion(
  cal: Calibration,
  envelope: Envelope,
  limits: RegionLimits,
  margin = REGION_MARGIN_PX,
): RegionProposal {
  const polygon = envelope.corners.map(([x, y]) => applyHomography(cal.h, { x, y }));
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const box = {
    x0: Math.min(...xs) - margin,
    y0: Math.min(...ys) - margin,
    x1: Math.max(...xs) + margin,
    y1: Math.max(...ys) + margin,
  };
  const width = limits.x.extent;
  const height = limits.y.extent;
  const overflow: Overflow = {
    left: Math.max(0, Math.ceil(-box.x0)),
    top: Math.max(0, Math.ceil(-box.y0)),
    right: Math.max(0, Math.ceil(box.x1 - width)),
    bottom: Math.max(0, Math.ceil(box.y1 - height)),
  };
  // The line's direction on the sensor: the envelope's first edge runs along it.
  const along = { x: polygon[1].x - polygon[0].x, y: polygon[1].y - polygon[0].y };
  return {
    polygon,
    region: coverRegion(box, limits),
    overflow,
    complete: overflow.left + overflow.top + overflow.right + overflow.bottom === 0,
    axis: Math.abs(along.x) >= Math.abs(along.y) ? 'x' : 'y',
  };
}

/** Sensor edges named for messages. */
export type Edge = 'left' | 'top' | 'right' | 'bottom';

export function overflowEdges(o: Overflow): Edge[] {
  return (['left', 'top', 'right', 'bottom'] as const).filter((e) => o[e] > 0);
}

export interface FrameCheck {
  state: 'complete' | 'cut' | 'none';
  /** Frame edges the line touches. */
  edges: Edge[];
}

/**
 * Whether a frame shows the whole line: found at all, and touching none of the frame's edges
 * (a line running into an edge is cut there). `axis` is the way the line runs.
 */
export function checkFrame(plane: Plane, axis: ScanAxis): FrameCheck {
  const points = linePeaks(plane, axis);
  const [count, length] = axis === 'x' ? [plane.width, plane.height] : [plane.height, plane.width];
  if (points.length < Math.max(10, 0.02 * count)) {
    return { state: 'none', edges: [] };
  }
  const edges = new Set<Edge>();
  const us = points.map((p) => p.u);
  const vs = points.map((p) => p.v);
  const [start, end, low, high]: Edge[] = axis === 'x' ? ['left', 'right', 'top', 'bottom'] : ['top', 'bottom', 'left', 'right'];
  if (Math.min(...us) <= 1) edges.add(start);
  if (Math.max(...us) >= count - 2) edges.add(end);
  if (Math.min(...vs) <= 1.5) edges.add(low);
  if (Math.max(...vs) >= length - 1.5) edges.add(high);
  return { state: edges.size ? 'cut' : 'complete', edges: [...edges] };
}
