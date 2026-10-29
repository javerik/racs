/*
 * Public API of ng-racs-ui: the RACS web UI as Angular components, from single building blocks
 * up to the pages and the shell. Styles: styles/racs-ui.scss with tailwind-preset.cjs, or the
 * prebuilt styles/racs-ui.css. Services and algorithms come from ng-racs-core.
 */

// Shell and routes: the whole UI
export * from './lib/shell/shell.component';
export * from './lib/routes';

// Theme and layout mode (data-theme / data-layout on <html>)
export * from './lib/services/layout.service';
export * from './lib/services/theme.service';

// Building blocks: icon, slider, armed button, inspector, switches
export * from './lib/shared/armed.directive';
export * from './lib/shared/client-name.component';
export * from './lib/shared/connect-mode.component';
export * from './lib/shared/icon.component';
export * from './lib/shared/inspector.component';
export * from './lib/shared/layout-switch.component';
export * from './lib/shared/slider.directive';
export * from './lib/shared/theme-switch.component';

// Frame display and analysis: frame canvas, overlays, view tools, range control, plot, ROI analysis
export * from './lib/device/shared/frame-canvas.component';
export * from './lib/device/shared/plot.component';
export * from './lib/device/shared/range-control.component';
export * from './lib/device/shared/roi-analysis.component';
export * from './lib/device/shared/roi-overlay.component';
export * from './lib/device/shared/view-tools.component';

// GenICam controls
export * from './lib/device/genicam/feature-control.component';

// Device panels: live view (with laserline calibration), burst, 3D, quick settings, feature tree, access
export * from './lib/device/device-live-view/device-live-view.component';
export * from './lib/device/device-live-view/envelope-overlay.component';
export * from './lib/device/device-live-view/laser-calibration.component';
export * from './lib/device/device-live-view/laser-wizard.component';
export * from './lib/device/device-live-view/region-overlay.component';
export * from './lib/device/device-burst/device-burst.component';
export * from './lib/device/device-cloud/camera-features.component';
export * from './lib/device/device-cloud/cloud-view-settings.component';
export * from './lib/device/device-cloud/cloud-view.component';
export * from './lib/device/device-cloud/device-cloud.component';
export * from './lib/device/device-cloud/light-dial.component';
export * from './lib/device/quick-settings/essentials.component';
export * from './lib/device/quick-settings/packet-size-tools.component';
export * from './lib/device/quick-settings/quick-settings.component';
export * from './lib/device/device-configuration/device-configuration.component';
export * from './lib/device/device-workspace/device-access.component';

// Pages
export * from './lib/discovery/discovery.component';
export * from './lib/device/device-workspace/device-workspace.component';
