# ng-racs-ui

The [RACS](https://git.javerik.dev/opensource/rustcamserve) web UI as Angular components: from
single building blocks (frame canvas with zoom/pan/rotate, histogram range control, plots, GenICam
feature controls) through the panels (live view, burst player, 3D point cloud, quick settings,
feature tree, access) to the pages and the whole shell. It talks to a RACS server
(`rust-cam-serve`, `racs-api`) through [`ng-racs-core`](https://www.npmjs.com/package/ng-racs-core).

```sh
npm install ng-racs-core ng-racs-ui
```

Angular 21.2+ (standalone components, signals), RxJS 7.8. The library version follows the RACS
server version; `ng-racs-ui` needs `ng-racs-core` of the same minor.

## The whole UI in one app

This is what `racs-webapp`, the UI the server ships, is made of:

```ts
// main.ts
bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(racsRoutes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([racsSessionInterceptor])),
    provideRacs(),
  ],
});

// app.component.ts
@Component({ selector: 'app-root', imports: [RacsShellComponent], template: '<racs-shell />' })
export class AppComponent {}
```

`racsRoutes` must sit at the router's root (the pages link to each other by absolute paths). In
development, proxy `/api` (with `ws: true`) to the server, or pass an absolute `apiBase` to
`provideRacs`.

## Your own pages

Use the parts you need, e.g. a live image with RACS's frame canvas:

```html
<racs-frame-canvas [frame]="frame()" [range]="range()" interactive />
```

with `frame` decoded by `ng-racs-core` (`decodeZstd`, `decodeRaw`, `decodeJpeg`) from
`RacsService.liveStream`. `examples/consumer` in the repository is a complete small app of this
kind. Notable exports:

- **Shell and pages:** `RacsShellComponent` (`racs-shell`), `racsRoutes`, `DeviceDiscoveryComponent`,
  `DeviceWorkspaceComponent` (`racs-device-workspace`, input `id`).
- **Panels:** `DeviceLiveViewComponent`, `DeviceBurstComponent`, `DeviceCloudComponent`,
  `QuickSettingsComponent`, `EssentialsComponent`, `DeviceConfigurationComponent` (feature tree),
  `DeviceAccessComponent`. They expect a `GenicamSession` and a `RoiSession` provided by an
  ancestor, as the workspace provides them.
- **Building blocks:** `FrameCanvasComponent` and its SVG overlays (`[racsRoiOverlay]`,
  `[racsRegionOverlay]`), `ViewToolsComponent`, `RangeControlComponent`, `PlotComponent`,
  `RoiAnalysisComponent`, `CloudViewComponent`, `FeatureControlComponent`, `InspectorComponent`,
  `IconComponent`, `SliderDirective` (`input[type=range].slider`), `ArmedDirective`
  (`button[racsArmed]`, click twice to confirm), `ThemeSwitchComponent`, `LayoutSwitchComponent`.
- **Services:** `ThemeService` (`data-theme` on `<html>`: `technical-dark`, `technical-light`,
  `light`, or auto) and `LayoutService` (`data-layout`: `desktop`/`mobile`, auto or forced).

## Styles

The components use the RACS design system: semantic colour tokens as CSS variables (one block per
theme), shared component classes (`.panel`, `.btn`, `.field`, `.label`, `.tag`, `.slider`, …) and
Tailwind utilities. Pick one way to load it.

**Without Tailwind:** add the prebuilt stylesheet (tokens, classes and every utility the components
use) to `angular.json`:

```json
"styles": ["node_modules/ng-racs-ui/styles/racs-ui.css", "src/styles.css"]
```

**With Tailwind 3:** use the preset, scan the library, and load the SCSS source:

```js
// tailwind.config.js
module.exports = {
  presets: [require('ng-racs-ui/tailwind-preset.cjs')],
  content: ['./src/**/*.{html,ts}', './node_modules/ng-racs-ui/**/*.mjs'],
};
```

```scss
// styles.scss
@use 'ng-racs-ui/styles/racs-ui';
```

Your own templates then get the tokens as utilities (`bg-surface`, `text-muted`, `border-line`,
`text-2xs`, `mobile:`/`desktop:` variants).

Both need the IBM Plex fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
```

To apply the stored theme before the first paint (and avoid a flash), put this in `<head>`; it
uses the same key and default as `ThemeService`:

```html
<script>
  (function () {
    var t = 'technical-dark';
    try {
      var p = localStorage.getItem('racs.theme');
      if (p === 'technical-dark' || p === 'technical-light' || p === 'light') t = p;
      else if (matchMedia('(prefers-color-scheme: light)').matches) t = 'technical-light';
    } catch (e) {}
    document.documentElement.setAttribute('data-theme', t);
  })();
</script>
```

The UI keeps its settings (theme, layout, view, ROIs, pins, …) in `localStorage` under `racs.*`.

## License

GPL-2.0-only.
