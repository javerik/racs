import { Routes } from '@angular/router';

/**
 * The RACS pages: `device-discovery`, `device` and `device/:id` (the workspace; the id is bound to
 * its `id` input, so provide the router `withComponentInputBinding()`), plus the old paths'
 * redirects. Meant for {@link RacsShellComponent}'s outlet at the router's root: the pages link to
 * each other by absolute paths.
 */
export const racsRoutes: Routes = [
  { path: '', redirectTo: 'device-discovery', pathMatch: 'full' },
  {
    path: 'device-discovery',
    loadComponent: () =>
      import('./discovery/discovery.component').then((m) => m.DeviceDiscoveryComponent),
  },
  {
    path: 'device',
    loadComponent: () =>
      import('./device/device-workspace/device-workspace.component').then(
        (m) => m.DeviceWorkspaceComponent,
      ),
  },
  {
    path: 'device/:id',
    loadComponent: () =>
      import('./device/device-workspace/device-workspace.component').then(
        (m) => m.DeviceWorkspaceComponent,
      ),
  },
  { path: 'configuration', redirectTo: 'device', pathMatch: 'full' },
  { path: 'live-view', redirectTo: 'device', pathMatch: 'full' },
  { path: '**', redirectTo: 'device-discovery' },
];
