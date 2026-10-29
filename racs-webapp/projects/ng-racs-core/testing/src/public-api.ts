/*
 * ng-racs-core/testing: fixtures for specs. A synthetic camera that films laserline patterns
 * through a known homography, a synthetic range camera (`Linescan3D`) that films its lines through
 * a known (column, row) → view map, and zstd-encoded frames with their decoded pixels.
 */
export * from './synthetic-camera.testing';
export * from './synthetic-range-camera.testing';
export * from './zstd-fixtures.testing';
