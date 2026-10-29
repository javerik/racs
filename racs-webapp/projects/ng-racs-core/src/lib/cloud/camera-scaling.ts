import { concat, EMPTY, map, throwError, toArray } from 'rxjs';
import { catchError, concatMap, ignoreElements } from 'rxjs/operators';
import type { CameraCoordinate } from './scaling';
import type { FeatureState, GenICamNodeInfo } from '../models/racs.models';
import type { GenicamSession } from '../services/genicam-session.service';
import type { RacsService } from '../services/racs.service';

/** SFNC 3D: the selector picks a coordinate, scale and offset turn its values into units. */
export const SCAN3D_SELECTOR = 'Scan3dCoordinateSelector';
export const SCAN3D_SCALE = 'Scan3dCoordinateScale';
export const SCAN3D_OFFSET = 'Scan3dCoordinateOffset';

type Axis = 'A' | 'B' | 'C';

/** The coordinates a camera's selector offers (`CoordinateA` → A, …) with their entry values. */
export function scan3dCoordinates(selector: GenICamNodeInfo | undefined): { axis: Axis; value: number }[] {
  const out: { axis: Axis; value: number }[] = [];
  for (const e of selector?.enums ?? []) {
    const m = /^coordinate([abc])$/i.exec(e.string_value ?? e.display_name);
    if (m) {
      out.push({ axis: m[1].toUpperCase() as Axis, value: e.value });
    }
  }
  return out;
}

/** Whether the camera reports its 3D calibration. */
export function hasCameraScaling(nodes: ReadonlyMap<string, GenICamNodeInfo>): boolean {
  return nodes.has(SCAN3D_SCALE) && scan3dCoordinates(nodes.get(SCAN3D_SELECTOR)).length > 0;
}

/**
 * Read the camera's scale and offset for each coordinate. One queued change of the selector:
 * select each coordinate, read its scale and offset, and put the selector back as it was, with
 * no other request of the session in between.
 */
export function readCameraCoordinates(
  session: GenicamSession,
  racs: RacsService,
): Promise<Partial<Record<Axis, CameraCoordinate>>> {
  const coordinates = scan3dCoordinates(session.nodes().get(SCAN3D_SELECTOR));
  return session.change(SCAN3D_SELECTOR, (id) =>
    racs.getFeatureValue(id, SCAN3D_SELECTOR).pipe(
      concatMap((original) => {
        const restore = () => racs.setFeatureValue(id, SCAN3D_SELECTOR, original);
        const reads = coordinates.map(({ axis, value }) =>
          racs.setFeatureValue(id, SCAN3D_SELECTOR, String(value)).pipe(
            concatMap(() => racs.getFeatureStates(id, [SCAN3D_SCALE, SCAN3D_OFFSET])),
            map((states) => [axis, coordinateFrom(states)] as const),
          ),
        );
        return concat(...reads).pipe(
          toArray(),
          concatMap((all) => restore().pipe(map(() => Object.fromEntries(all)))),
          // A failed read must not leave another coordinate selected.
          catchError((e) =>
            concat(restore().pipe(ignoreElements(), catchError(() => EMPTY)), throwError(() => e)),
          ),
        );
      }),
    ),
  );
}

function coordinateFrom(states: FeatureState[]): CameraCoordinate {
  const number = (name: string) => {
    const v = Number(states.find((s) => s.name === name)?.value ?? NaN);
    return Number.isFinite(v) ? v : null;
  };
  return {
    scale: number(SCAN3D_SCALE),
    offset: number(SCAN3D_OFFSET),
    unit: states.find((s) => s.name === SCAN3D_SCALE)?.unit ?? null,
  };
}
