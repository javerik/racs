# 0.5.0

## Targets
* `racs-webapp-windows-x86_64.zip`: the Windows server with the website and the bundled laserline,
  next to `racs-api-windows-x86_64.zip`
* Angular libraries `ng-racs-core` and `ng-racs-ui` on npm (see below)

## Features
* The server serves a `web/` folder placed next to its executable when neither `--web-root` nor
  `RACS_WEB_ROOT` is set (how `racs-webapp-windows-x86_64.zip` serves the website)
* The bundled laserline has a test model, `l-block.stl`: a stepped, asymmetric L with known
  dimensions for checking a metric 3D scan with *Check against STL* and the measuring tool (#33)
* The website is now built from two Angular libraries, ready to publish on npm, for websites of
  your own on a RACS server (#27):
  * `ng-racs-core`: models, the API/session/events services, device, GenICam, ROI and laserline
    state, and every algorithm (frame decoding incl. `zstd`, ranges, ROI statistics, fits, regions,
    laserline calibration, the 3D ring buffer, camera, lighting, palettes, PLY export and the WebGL
    renderer); `ng-racs-core/testing` has spec fixtures
  * `ng-racs-ui`: every component, from building blocks to the live, burst and 3D panels, the pages,
    the shell (`racs-shell`) and `racsRoutes`, with the design system as SCSS + a Tailwind preset
    or as a prebuilt `racs-ui.css`
  * `provideRacs({ apiBase, tools, autoStart })` configures them; `apiBase` may point at a server on
    another origin
  * `racs-webapp/examples/consumer`: a small app on the packed libraries, built by CI
  * Manual GitLab jobs `publish:ng-racs-npmjs` (`NPM_TOKEN`) and `publish:ng-racs-gitlab` publish
    them on tags; their version is the RACS version
* The bundled laserline publishes its metric mapping (#33): how many view pixels a millimetre of the
  scanned object is along the line and in height, where the line rests, the object's extent and how
  fast the scan travels, with what makes it unreliable. `ng-racs-core` mirrors it
  (`MetricMapping` in the laserline protocol) and exposes it as `LaserlineLinkService.metric`
* Website: the 3D tab's scaling can mirror x (`mirrorX` in `racs.cloud.scaling.<mac>`): the columns
  run from the last to the first, so a scan keeps the scanned object's handedness. The box keeps its
  place, the lighting stays on top, and the PLY export is mirrored the same way (#33). `ng-racs-core`
  adds the math the metric scaling builds on: `composeMetric`/`fitLinearScaling`/`metricScaling` and
  the profile rate (`ProfileRateEstimator`, `pickRate`)
* `ng-racs-core`: `RangeCalibrationService` measures how a camera in `Linescan3D` maps its range
  values onto the bundled laserline's view: laserline shows lines around its line, the service fits
  the map from the range profiles and keeps it per camera (`racs.laserline.range.<mac>`). It needs
  a live 16-bit stream in `Linescan3D` and writes nothing to the camera (#33). `verify()` films check
  lines against the kept map and marks it stale when they are more than twice its rms off
* Website: the 3D tab's Scaling has a source, *Manual* · *From camera* · *Laserline* (#33). With
  *Laserline* the cloud is in the STL's mm when the camera films the emulated laserline: *Calibrate*
  measures the range calibration (laserline opens itself and shows lines; the cloud pauses), the
  review shows its error, the band the camera sees and the error per column, and the scaling follows
  laserline live (changes above 0.2 %). y comes from laserline's travel speed and the camera's
  measured profile rate. States say when it is live, laserline offline (the last mapping is kept),
  the calibration stale, y approximate, the scan out of the camera's band, or laserline disturbed.
  *Verify* checks a kept calibration, *Forget* drops it. Typing a value switches to *Manual*, and
  *X order* mirrors x by hand. The PLY header names the source, the calibration's rms, laserline's
  mapping revision, the travel speed and the profile rate's source
* Website: the 3D view has a measuring tool (#33). *Measure* (or `m`) and a click or tap on the
  cloud reads the point's x, y and z in the scaling's units; *Distance* measures between two points,
  with Δx, Δy and Δz. The points are marked on the cloud and stay with their profiles while a rolling
  buffer scrolls. A double click still fits, and Esc clears them. *Step* gives the height between two
  faces (the medians around each point), and *Section* plots z along the line between two points,
  with gaps where the cloud has none; the readout says whether z is above the base (*Laserline*
  scaling) or raw. `ng-racs-core` adds the CPU picking (`pickRay`, `pickHeightfield`),
  `pointUnits`/`distance`, `neighbourhoodMedian`/`stepHeight`/`crossSection` and `invert` for 4×4
  matrices; `racs-plot` takes a `yLabel`
* Website: the 3D tab checks the cloud against the STL (#33). In the Scaling section's *Laserline*
  block, *Check against STL* proposes a snapshot of one full pass of the object (stopping the
  stream), captures it, and compares the object's length along the line, its length along the
  travel and its height with what laserline reports for the STL: a table with each axis's error,
  within 2 % or not. It refuses an incomplete pass, an object leaving the camera's columns and
  bounce playback. `ng-racs-core` adds `proposeSnapshot` and `checkAgainstObject`
* Website: in mobile full screen the 3D view keeps at least 60 % of the screen, and the range and the
  settings scroll under it (the settings used to squeeze the cloud to a strip)

## Changes
* GitLab CI: the tests are a stage of their own (`test:rust`, `test:client-libs`, `test:webapp`,
  `test:web-libs-consumer`) instead of part of the build stage. The client and web libraries can be
  published from any pipeline branch to the project's GitLab registries (npm, PyPI, NuGet) by
  typing a version such as `0.5.0-feat-laser.1` into the manual `publish:*-gitlab` job's
  `LIB_VERSION`; on npm it goes under the branch's dist-tag, not `latest`
* `racs-website` is unchanged in features and look; it is now a thin app on the libraries. Its
  component selectors are `racs-*` instead of `app-*`; stored settings carry over
* Website: the laserline calibration and the line's levelling are kept per camera (by its MAC)
  instead of per server device id, so they survive a server restart and don't pass to another
  camera that gets the id (#33). This renames the published storage keys on purpose:
  `racs.laserline.calib.<id>`/`racs.laserline.tilt.<id>` become `….<mac>`. Old keys are migrated
  when the camera's sensor size matches the calibration's, and dropped otherwise
* Website: the 3D tab no longer reads or writes its scaling under a stand-in key
  (`racs.cloud.scaling.id<id>`) before the device list has loaded

## Fixes
* Website: levelling the laserline line no longer takes hot pixels for a line (the AT C6 has a
  column with one in every 6th row, so the blank view never looked blank), and finds the line about
  three times faster: on a full 3072×1020 frame it fell behind the stream and measured the tilts
  of earlier patterns
* Website: the 3D tab's range calibration draws its lines in the width the camera sees best
  (a slope-based peak finder loses a wide, flat-topped line), and tells a frame that straddles a
  pattern switch by the shift of the whole line instead of counting noisy columns, which failed
  every frame on the AT C6 ("the range image does not settle")

# 0.4.0

## Features
* `format=zstd` on the live stream and for burst jobs: the raw pixels losslessly compressed, about
  half the size of `raw` on a camera image (2.35× at 8 bit, 2.1× at 12 bit) for about 3 ms of CPU
  per 1.2-megapixel frame. The layout is described in the readme and in `specs/live-compression.md`
* The client libraries decode `zstd` frames: `Frame.to_numpy()`/`to_raw()` (Python),
  `ToUInt16Array()`/`ToRaw()` (.NET), `Frame::to_u16()`/`to_raw()` (Rust)
* `racs-website` streams `zstd` by default in the live view (*Lossless*), and the burst player and
  its raw export handle `zstd` jobs
* `examples/codec_bench.rs` measures the encodings on a burst export or synthetic frames
* Client sessions (`POST /sessions`, heartbeat, `DELETE`, `GET /sessions`), sent as
  `X-Racs-Session` or `?session=`. Clients without one keep working unchanged
* `GET /events?session=`: a WebSocket of device state changes, feature writes, commands and
  session ends, so a client learns what the others changed
* A session that uses a device is a member of it. `PUT /devices/{id}/disconnect` from a session
  leaves the device and closes it only when nobody else uses it; without a session it closes the
  device unless a session uses it; `?force=true` closes it for everyone. It now answers
  `{"closed","members"}` instead of an empty body
* `--device-idle-timeout` (`RACS_DEVICE_IDLE_TIMEOUT_S`, default 300 s, `0` = never) disconnects a
  camera nobody uses; `--session-timeout` (`RACS_SESSION_TIMEOUT_S`, default 30 s) sets how long a
  session lives without a heartbeat. `examples/fake_server.rs` takes both (idle default `0`)
* Access modes per device: `shared` (the default, unchanged for every client), `ro-shared` (one
  session writes, the others read) and `exclusive` (one session only), held as a lease by a session.
  `PUT /devices/{id}/connect?mode=` connects and takes it in one step; `GET`, `PUT` and `DELETE
  /devices/{id}/access` show, take or change, and release it. Refusals are JSON: `400
  session_required`, `403 read_only`, `409 device_in_use`, `423 device_locked`
* `force` takes a lease anyway; going `exclusive` with it closes the other clients' live streams
  with `4003` (`access revoked`), cancels their bursts and sends them `access_revoked` events
* `PUT /devices/{id}/connect` answers the device's access state instead of an empty body, and
  `GET /devices/connected` lists each device's `access`
* Several live viewers per device: a second `GET /devices/{id}/stream/live` joins the running
  capture instead of failing as busy. Each socket has its own `format`, `quality`, `fps`, frame
  numbers and dropped counter, and a slow client only drops its own frames. The pixel depth is the
  starter's (announced in `bit_depth`). Joining needs read permission, starting write.
  `GET /devices/{id}/stream/error` gains `viewers`, and `device_state.stream.viewers` counts them.
  A forced `exclusive` lease closes the other clients' sockets with `4003` and keeps the capture
  running for the forcing session's own
* `PATCH /sessions/{session_id} {"name"}` renames a session; the devices it uses send
  `device_state` (`cause: access`), so other clients show the new name
* The client libraries are multi-user clients (Python, .NET and Rust alike):
  * each client is a session, named with `name`. It is created with the first request, kept alive
    by a heartbeat (Python: a daemon thread; .NET: a `PeriodicTimer` task; Rust: the
    `keep_alive()` future you spawn), created anew and the request retried once after a `401`, and
    ended by `close()`/`DisposeAsync()`. `anonymous` keeps the 0.3 behaviour
  * leases: `connect` with a `mode`, `access()`, `take(mode, force)`, `release(force)` and a forced
    disconnect on `Camera`, and every session and access route on the low-level client
  * `client.events()`: the events socket as a Python iterator, an `IAsyncEnumerable` (.NET) or a
    `Stream` (Rust), with typed events
  * refusals raise their own errors with the parsed body: `SessionExpired`, `ReadOnly`,
    `DeviceInUse` and `DeviceLocked`. A live stream or events socket closed with `4001` raises
    `SessionEnded`, one closed with `4003` `AccessRevoked`. `CameraBusy` is unchanged
  * connecting answers the device's `DeviceAccess` and disconnecting `{closed, members}` (.NET and
    Rust: return types instead of `Task`/`()`; Rust also adds `Error` variants and a
    `DeviceDiscoverInfo` field, which breaks exhaustive matches and struct literals, and .NET adds
    optional constructor parameters, which needs a rebuild of compiled callers)
* The readme lists the session flags and the WebSocket close codes
* `racs-website` is a multi-user client:
  * every tab has a session of its own, named `webapp · <browser>` (editable in the sidebar). A
    reload keeps it, a duplicated tab starts its own, and the events socket keeps it alive
  * Discovery and the sidebar connect as `shared`, `ro-shared` or `exclusive`
  * the device workspace shows the mode, who holds the device, and the members and viewers, with
    *Take control*, *Release* and *Force release* (a forceful action asks for a second click)
  * without write access, the settings are read-only and say who holds the device. Starting a
    burst or a stream says why it can't, but a running stream can still be joined (*Join live*)
  * a feature another client changes is read again, with a short note naming that client
  * the live view counts its viewers, and explains a stream ended by a disconnect, an expired
    session or a revoked lease
  * the sidebar marks devices another client has locked
  * a device closed by someone else or for being idle shows why, with *Reconnect*. Opening its
    page no longer connects it again by itself
* `racs-website` 3D tab redesigned:
  * one command bar: the mode, the depth and buffer (or frame count) behind a summary button, what
    the capture is doing, and Start/Stop. The status row under the view is gone
  * the view's presets, Fit and Points/Surface sit on the cloud, with the colour scale and full
    screen in its corner; full screen keeps the range and the settings
  * an inspector beside the cloud (tabs under it on a phone) holds the settings in folding
    sections: the camera's own *Scan 3D* (the `Scan3dControl` category) and *Region* (everything
    `RegionSelector` selects), then Draw, Scene, Light, Scaling and Export. The camera sections
    are built from its GenICam tree, so they show what it offers in its current mode
* `racs-website` laserline calibration is a wizard beside the live image (under it on a phone),
  opened from the Region tool's *Laserline* row: Prepare (live stream, scan type and the laserline
  window, each with its fix), Capture (every pattern and its progress), Review (rms, field, error
  per sensor tile), Region, Limits and Check. The region can now also be the *travel area*: every
  part of the sensor that sees the laserline view, so any line laserline draws there is seen
  whole. In *current line* mode it can crop rows only. *Limits* asks laserline to keep its line,
  movement and height inside that region (the new `constrain` message of the remote protocol):
  laserline then adjusts every change to stay inside, outlines the limit and offers *Release
  limit*
* `racs-website` laserline wizard: a *Tilt* step after the review levels the line. Laserline
  shows its line (where the user's runs) at a sweep of tilts while the camera films it, and RACS
  finds the tilt at which the line runs along the sensor rows (or columns) to a few hundredths of
  a degree, with its straightness; *Apply tilt* sets it as laserline's line tilt. Uses the new
  `tilt` message and the `tilt_deg` of `line` patterns in laserline's remote protocol
* Web UI favicon and README logo: the red RACS square from the sidebar

## Fixes
* `racs-website` 3D tab: "the graphics card has no room for this many profiles" when the card
  (or the browser's share of it) held less than the 256 MiB the buffer may take. The tab now
  measures what the card takes when it opens and sizes the buffer to it; if the card refuses a
  buffer later, a running stream continues with a shorter one (the capture settings say how many
  profiles fit) and a snapshot asks to be taken again. Leaving the tab hands its graphics context
  back at once instead of at garbage collection
* `racs-website` 3D tab: a dense cloud (density *All*, from about 30 M points) disappeared on
  graphics drivers that drop one very large draw without an error. Points and surfaces are now
  drawn in parts of at most 6 M vertices
* `racs-website`: the live view's *Region* tool can be opened right after a connect. It used to
  stay disabled until something else (such as the GenICam tree) had read the region features (#26)
* A device connected with `?ip=` (or by address, like the fake server's) can be connected again by
  id after a disconnect; the server remembers where it was connected. Device routes, which connect
  implicitly, work again after such a disconnect too
* Concurrent requests for a device that isn't connected yet (the web UI's first requests) open the
  camera once instead of failing on its control privilege
* A live socket refused because the camera is busy (held by a burst) no longer reports a running
  stream as inactive in `GET /devices/{id}/stream/error`
* A camera handed back after its device was disconnected (and perhaps reconnected) meanwhile is
  closed instead of being put into the new connection's place
* Disconnecting a device stops its live stream and cancels its running burst job, instead of
  leaving them running on the closed connection. The socket is closed with `1001` and the reason
  `device disconnected`; the burst job keeps its record and images, with status `cancelled` and
  that error. Requests for the device that arrive during the disconnect wait for it and then
  connect the device again
* Concurrent GenICam requests and single-frame grabs on one device wait their turn, in order of
  arrival (up to 5 s), instead of failing as busy. Parallel writes all succeed and the last one
  wins. A burst job or a live stream started while such a request runs waits for it, so a burst no
  longer fails because it overlapped a feature read. A camera held by a live stream or a burst is
  still busy for everything else
* A request whose client hung up while it was running no longer leaves the device busy until it is
  disconnected

## Performance
* Frames are encoded on up to four threads at once, off the capture loop, which now only copies
  each frame out of its buffer. A slow encoding no longer starves the GVSP receiver of buffers
* JPEG encoding uses `jpeg-encoder` (AVX2 where available), about twice as fast as before. The
  `image` crate and its dependencies are gone from the build
* Burst images are served without copying them, and with a `Content-Length`

# 0.3.0

## Targets
* Webapp `AppImage` for `x86_64`, `aarch64` and `armhf` (`racs-webapp-<version>-<arch>.AppImage`):
  the server serving the website and the bundled Laserline tool from one process
* Rust client library `racs-client` on crates.io, next to `racs-python` (PyPI) and `Racs.Dotnet`
  (NuGet)

## Features
* Live streaming over WebSocket at `/api/v1/devices/{id}/stream/live`, with `jpeg`/`raw` frames,
  an `fps` limit and a dropped-frame counter per message
* `/api/v1/devices/{id}/stream/error` reports why the last live stream ended
* Background burst capture at `/api/v1/devices/{id}/grab/jobs`: start a job for up to 500 `jpeg` or
  `raw` frames, poll its status, fetch the frames individually while it runs or after it finishes,
  and cancel or discard it with one `DELETE`. Finished jobs expire after 10 minutes
* `racs-website` live view can stream continuously instead of only capturing single frames
* `racs-website` redesigned with a flat, minimal, technical look: hairline panels, IBM Plex
  Sans/Mono, a stream status strip in the live view, and RW/RO tags on GenICam features
* GenICam `<String>` features are listed in `/gc/categories` and readable/writable via the
  feature endpoints (a literal `<String>` is reported read-only)
* GenICam nodes in `/gc/categories` carry a `selected` list: for a selector such as
  `GainSelector`, the features whose value depends on it (its `<pSelected>` elements)
* `racs-website` GenICam view nests each selector's features beneath it, applies an enum
  selector as soon as it changes, and re-reads the affected values after every write
* `GET /api/v1/devices/connected` lists connected devices without running a network discovery
* `pixel_depth=mono16` on the live stream and in burst requests streams the deepest unpacked mono
  format the camera accepts (Mono16/14/12/10). Raw frames are then little-endian `u16`s. The live
  stream info and burst status report the granted `pixel_format` and `bit_depth`
* A camera in `DeviceScanType = Linescan3D` streams its range format, `Coord3D_C16`/`Coord3D_C8`,
  which both pixel depths fall back to. Such frames were reported as 8 bit and cut to half
* `racs-website` has a 3D tab: frames as a WebGL2 point cloud (a profile per row, the value as
  height), continuously from a rolling buffer or as a snapshot of up to 500 frames, with a switch to
  Linescan3D, scaling to units (also read from the camera's `Scan3dCoordinate*`), height palettes
  (grey, viridis, cividis, magma) with a colour scale, and PLY export
* `racs-website` 3D view draws points or a surface (broken at large steps), stretches x, y and z
  in the view, and shades with a configurable light: direction dial or following the view,
  diffuse, ambient and specular strength, and shadows
* `racs-website` calibrates a camera filming the Laserline tool (Region tool → *Laserline*), in
  10–20 s: Laserline shows Gray-code stripes, every camera pixel decodes the view position it sees
  (so a camera covering a small part of the display works), and RACS maps the Laserline view onto
  the sensor, fits the line into the camera's field when it doesn't fit, and proposes the camera
  region holding the line's whole envelope (movement, deformation, scan). Laserline outlines the
  camera's field; a check counts frames showing the whole line
* Laserline's default laser colour is white
* `racs-website` sidebar has a Tools section. *Laserline* (laser-line emulator and STL slicer, the
  `laserthing` submodule) is bundled under `/tools/laserline/`, opens in its own window and ships
  in the Docker website images and the webapp AppImage
* `racs-website` selects whose options are generated (live and burst playback FPS, the mobile device
  picker, the ROI plot's mode, degree and statistic) show the stored choice instead of the first
* Burst job status carries `width`, `height`, `pixel_format` and `bit_depth` once the first frame
  is captured, so raw bursts can be decoded without a separate trip to the camera
* `racs-website` lists connected devices under Device in the sidebar. Each device has its own URL
  (`/device/{id}`), so a reload or a shared link opens the same device
* `racs-website` live view renders onto a canvas with a display range: full, manual (e.g.
  20↔50 LSB) or auto (image min–max), plus a histogram and a pixel readout. It streams raw 8- or
  16-bit, or JPEG, at a chosen frame rate
* `racs-website` Burst tab captures up to 500 frames, plays them back as a video (scrub, step,
  loop, playback fps) with the same display range, and exports WebM, the original frames as a zip
  (raw + `meta.json`, or JPEG) or rendered PNGs
* `racs-website` device page reorganised: an Essentials strip above the Live/Burst/3D tabs puts
  `ExposureTime` and `DeviceScanType` at hand on every tab, and the settings column beside them
  switches between Quick settings and All features. The sidebar collapses to an icon rail
* `racs-website` themes: Technical dark (the default), Technical light, and Light (warm tones,
  sans-serif captions, rounder corners), or Auto following the system's light/dark setting. The
  switch sits next to Layout in the sidebar and the mobile menu
* `racs-website` device page is denser on desktop: Essentials is one row (the exposure value,
  decades, slider and input side by side), and the Live and 3D tabs put their settings and actions
  in one bar. The 3D scan-type row only shows while the camera is not in Linescan3D
* GenICam reads, writes and commands no longer fail as busy while a live stream runs: they are
  carried out inside the stream. Features the camera locks during acquisition (`pIsLocked` on
  `TLParamsLocked`, e.g. `ExposureTime`) are written with acquisition briefly paused so they take
  effect (changes queued meanwhile share one pause, and a restart that delivers no frame within
  3 s is retried), and changes that alter the payload restart acquisition; the stream re-announces its
  geometry with another text message when it changes. `PixelFormat` and the stream
  transport features are refused while streaming; during a burst everything stays busy
* GenICam `Boolean` features are listed (read/write as `true`/`false`), and `Command` features are
  listed and executed with `POST /api/v1/devices/{id}/gc/command/{name}`
* `POST /api/v1/devices/{id}/gc/features/state` returns the live state of up to 256 features at
  once: value, availability, lock, evaluated min/max/increment, unit and representation, and the
  enum entries currently offered
* `racs-website` Quick settings under the live view: exposure, frame/line rate, gain, trigger,
  region, light and user sets with sliders bounded by the camera's own ranges, applied live while
  streaming. A range spanning decades (exposure: 10 ns to 1 s) is picked by decade first, then
  set with a linear slider within it, ½×/2× steps, or typed; values read as µs/ms/s. Sliders
  write on release. Features pinned with ★ in the GenICam list join them (kept per camera model)
* `racs-website` GenICam list can be maximized to a full-screen, multi-column view with a name
  filter; Boolean features show as switches and commands as buttons. Beside the live view it can
  be minimized to a strip instead
* `racs-website` live view has a View toolbar: rotate in quarter turns, fit to the view or a fixed
  scale (6–1600 %, zoom with Ctrl+wheel at the pointer, drag to pan, double-click for fit ↔
  100 %), and full screen; keyboard shortcuts `r`/`R`, `0`, `1`, `+`/`-`, `f`. The pixel readout
  follows the rotation, and the view is remembered
* `racs-website` display range is set on the histogram: drag either edge or the whole window,
  press beside it to bring the nearer edge there, double-click for the full range; arrow keys on
  a focused edge and two small fields give exact values. The From/To slider rows are gone, and all
  sliders have a slimmer look matching the rest of the UI
* `racs-website` sidebar has a discover button under Discovery and lists the devices found
  beneath it, each with a connect button on hover; connected devices under Device get a
  disconnect button the same way
* `racs-website` has a mobile layout, detected from the screen and input (a phone stays mobile in
  landscape) and switchable under Layout (Auto / Desktop / Mobile) in the sidebar or the mobile
  menu. Mobile has a bottom tab bar, device cards on Discovery, touch-sized controls, and a live
  image that stays pinned above the quick settings while they scroll; its handle folds it into a
  slim bar (tap or swipe up) and opens it again (tap or swipe down). The frame view takes pinch
  zoom, double tap for fit ↔ 100 %, and a tap to probe a pixel; full screen turns a wide image to
  landscape. Forcing Desktop on a phone renders the desktop page zoomed out
* `racs-website` panel heads grow instead of overflowing when their controls wrap, and the burst
  player's Loop is a toggle button
* `racs-website` camera region tool in the live view: the image is shown on the whole sensor
  and the region (`Width`/`Height`/`OffsetX`/`OffsetY`) is set by dragging its sides, corners or
  the whole region, or drawing a new one, with mouse or touch. Values snap to the camera's
  increments, can be typed, and Full/Center presets are offered; Apply writes them in an order the
  camera accepts, also while streaming
* `racs-website` soft ROIs on the live view and the burst player: rectangles and lines drawn on
  the image, kept per device and shared by both. A statistics table gives n, min, max, mean and
  std per ROI; a plot shows a line profile, a rect's column/row projection, a statistic over time
  (live) or across the burst (with the playhead), or a ROI histogram, as raw data, a moving
  average, or a linear, polynomial (degree 2–5) or Gaussian fit with its parameters. The table and
  the plot each have an Auto switch: off, they hold the measured frame until Update. The burst
  player gets the View toolbar (rotate, zoom, full screen) as well
* Client libraries `racs-python` and `Racs.Dotnet` 0.3.0 cover every route: GenICam feature states
  and commands, JPEG quality, the stream error, the live stream (WebSocket) and burst jobs. A
  `Camera` handle holds the device id and reads and writes features as typed values
  (`cam["Width"] = 640`, `await cam.GetAsync<int>("Width")`); `LiveStream` and `BurstJob` yield
  frames with their size and bit depth. The existing id-based methods are unchanged. Python now
  depends on `websocket-client` and needs Python 3.9
* New Rust client library `racs-client` (`client_libs/racs-rust`), async on tokio, with the same
  `Camera`/`LiveStream`/`BurstJob` handles and typed reads (`cam.get::<u32>("Width")`)
* `cargo run --example fake_server` serves the API with fake cameras connected, no hardware
  needed. The client libraries are tested against it in CI (`client_libs/run-tests.sh`)
* The stream packet size (`GevSCPSPacketSize`) is a real setting: grabs, live streams and bursts
  use the camera's value instead of forcing 1400, so jumbo frames (e.g. 7960 on an MTU 9000 link)
  work and more than double the throughput of a full-size frame. Writing it checks it against its
  bounds, its increment and the MTU of the interface the camera is reached over. While a live
  stream runs it is applied by reopening the stream channel, and the stream info carries
  `packet_size`
* `GET /api/v1/devices/{id}/stream/packet-size` reports the packet size, its bounds and the link
  (interface, MTU); `POST /api/v1/devices/{id}/stream/packet-size/auto` finds the largest packet
  size that arrives with GigE Vision test packets, as Aravis does, and sets it. On connect the
  camera's packet size is checked the same way and only replaced when it doesn't get through
* `racs-website` Quick settings have a Transport section: the packet size, the link MTU, and an
  Auto button. The live status bar shows the packet size of the running stream
* `racs-website` live status bar shows the frame rate and data rate actually received (e.g.
  `fps 24.7 ≤ 30 · 77.5 MB/s`), measured over the last 2 s, next to the frame and dropped counters
* `racs-website` live view draws only the newest frame per screen refresh instead of every frame
  in turn, so a page slower than the stream no longer builds up lag; JPEG frames decode about four
  times faster where WebCodecs is available, and 8-bit frames are analysed in half the time. A
  60 fps choice is added
* Client libraries: `get_packet_size`/`auto_packet_size` (`GetPacketSizeAsync`/`AutoPacketSizeAsync`
  in .NET), on the `Camera` handle too, and `packet_size` in the live stream info

## Breaking
* `node_type` in `/gc/categories` can now be `Boolean` or `Command`. Clients that reject unknown
  values must be updated; the bundled Python and .NET clients are
* The live stream may send its text message more than once; a raw consumer must apply each one to
  the frames that follow it
* Streams use the camera's own `GevSCPSPacketSize` instead of 1400. A camera that kept a small
  packet size streams slower than before until it is raised (or Auto is run); one whose size
  doesn't reach the server is corrected at connect. Writing a size that is off its increment or
  above the link MTU now fails instead of being passed to the camera
* The `racs-website` Docker image no longer runs nginx: `rust-cam-serve` serves the website,
  API and Swagger itself, like the webapp AppImage, on port 8742 (was 80) as an unprivileged user.
  The frontend-only nginx image (`docker/nginx`) and `docker-compose.web.yaml` are gone

## Fixes
* A live stream no longer ends with `frame is N bytes but WxH needs M` (seen with the server
  running on the AT C6 itself, at packet size 7960). When the camera could no longer resend a lost
  packet, `aravis-port` counted its "packet unavailable" answer as the packet and passed the frame
  on as complete but short. Such frames are now dropped as incomplete. Live streams and bursts also
  skip any frame that is still shorter than its geometry instead of ending on it
* The live stream's `fps` limit delivered as little as a third of it when the camera ran at a
  multiple of the limit (10 fps under a 15 fps limit from a 30 fps camera): it skipped every frame
  that arrived a hair before the interval was up. It now paces by credit and delivers the limit,
  or the camera's rate when that is lower
* Updated `aravis-port`: GenICam `Min`/`Max`/`Inc`, `Unit`, `Representation` and `pIsLocked` are
  evaluated; value tables (`pIndex` with `ValueIndexed`) are supported, so the AT C6's `Gain` reads
  its actual factor instead of 0; executing a command now invalidates cached registers that list it
  as `pInvalidator` (values refresh after `UserSetLoad`)
* Updated `aravis-port`: the fake camera has `OffsetX`/`OffsetY` and `WidthMax`/`HeightMax`, with
  `Width`/`Height` bounded by what the offset leaves
* Updated `aravis-port`: `Camera::test_packet_size`/`auto_packet_size` fire GigE Vision test
  packets; the fake camera has `GevSCPSPacketSize` (and its don't-fragment and test-packet flags)
  and a configurable path MTU
* Updated `aravis-port`: cameras with an older GenICam schema or a known register-access quirk
  (e.g. AT C6-2040-GigE) use legacy register access, the stream buffer pool is sized from
  `PayloadSize` after the packet size is programmed, and a failed connect no longer leaves the
  camera locked until its heartbeat timeout
* Selector-dependent features (e.g. `Gain` under `GainSelector`) no longer return the cached
  value of the previously selected entry after the selector changes
* `racs-website` Discovery showed the serial number in the MAC column
* Reopening a live stream right after closing it, or using the camera right after cancelling a
  burst, no longer fails with `Busy`: requests that arrive while the camera is being handed back
  wait for it (up to 3 s). A camera that is genuinely in use still answers `Busy` within 0.1 s
* `racs-website` GenICam view sends feature reads and writes one at a time, so changing a feature
  while values are still loading no longer fails with a busy camera, and a failed write shows its
  error on that feature instead of replacing the whole panel

# 0.2.0

## Targets
* `AppImage` build for `x86_64`
* `AppImage` build for `aarch64`
* `AppImage` build for `armhf`

## Features
* Connect via ip to `Camera`