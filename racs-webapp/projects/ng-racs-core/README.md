# ng-racs-core

Angular services, models and algorithms for clients of a [RACS](https://git.javerik.dev/opensource/rustcamserve)
server (`rust-cam-serve`, `racs-api`): the REST and WebSocket server that exposes GigE Vision /
GenICam cameras over HTTP. It is the non-visual half of the RACS web UI. The components are in
[`ng-racs-ui`](https://www.npmjs.com/package/ng-racs-ui).

```sh
npm install ng-racs-core
```

Angular 21.2+, RxJS 7.8. The library version follows the RACS server version.

## Setup

```ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRacs, racsSessionInterceptor } from 'ng-racs-core';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptors([racsSessionInterceptor])),
    provideRacs(), // or provideRacs({ apiBase: 'http://192.168.10.5:8742/api/v1' })
  ],
});
```

`provideRacs(config)` takes:

| Option | Default | |
| --- | --- | --- |
| `apiBase` | `'/api/v1'` | The REST API: a path on the page's origin (the server serves the page, or a dev-server proxy forwards `/api` incl. WebSockets) or an absolute `http(s)://` URL. WebSocket URLs are derived from it. |
| `tools` | laserline at `tools/laserline/` | Web apps bundled beside the UI, opened in a window of their own (the shell's *Tools*, the laserline calibration). |
| `autoStart` | `true` | Starts the client session and the events socket at app start. |

The session interceptor sends the tab's session (`X-Racs-Session`) with every request under
`apiBase`, waits for it at start-up and renews it once after a `401`.

## What's inside

**Services** (all `providedIn: 'root'` except where noted):

- `RacsService`: one method per REST route, plus `liveStream(id, options)` (the live WebSocket as an
  `Observable` of `info` and `frame` events; unsubscribing closes it and releases the camera).
- `SessionService`, `ServerEventsService`: the client session (multi-user) and the events socket
  (`device_state`, `feature_changed`, …), which is also the heartbeat.
- `DeviceRegistryService`: connected devices (polled), discovery, connect/disconnect, access modes.
- `DeviceSelectionService`, `GenicamSession` and `RoiSession` (provide the latter two on the
  component that owns a device's view, as the RACS workspace does), `LaserCalibrationService`
  (provided by the live view), `RangeCalibrationService` (provided by the 3D tab),
  `LaserlineLinkService`, `ToolWindowService`.

**Algorithms**, plain functions over typed arrays:

- Frames: `decodeRaw`, `decodeZstd` (the server's lossless format), `decodeJpeg`, `analyze`
  (min/max/histogram), `buildLut`/`renderToCanvas` (window/level), `resolveRange`.
- Analysis: ROI statistics, line profiles and projections (`roi`), fits (moving average, linear,
  polynomial, Gaussian), plot scales, the camera-region helpers (`regionWrites`, …), a stored-only
  zip writer.
- Laserline calibration: Gray code decoding, homography (`solveHomography`, `multiplyMat3`, …), laser
  line peaks and tilt, and the laserline remote protocol.
- 3D: `RowRing` (rolling profile buffer), orbit camera and `mat4`, scaling, lighting, palettes,
  `ply` export, and `CloudRenderer` (WebGL2 point cloud and surface).
- GenICam: feature tree, quick-settings lists, numeric steps, camera sections.
- Storage: `deviceStorageKey` (browser storage per camera, by MAC) and `migrateStorage`.

`ng-racs-core/testing` has fixtures for specs: a synthetic camera that films laserline patterns
through a known homography, and zstd-encoded frames.

## Example: decode a live frame

```ts
const racs = inject(RacsService);
let info: StreamInfo;
racs.liveStream(0, { format: 'zstd', pixelDepth: 'mono16', fps: 10 }).subscribe(async (e) => {
  if (e.kind === 'info') { info = e.info; return; }
  const frame = await decodeZstd(e.frame.payload, info.width, info.height, info.bit_depth ?? 8);
  const { min, max } = analyze(frame);
});
```

## License

GPL-2.0-only.
