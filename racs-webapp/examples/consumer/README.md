# Consumer example

A small page of its own on a RACS server, built from the published packages: pick a connected
camera and watch it live. `ng-racs-core` provides the session, the device list, the live stream
and the zstd decoding; `ng-racs-ui` the frame canvas (zoom, pan, rotate, pixel readout), the theme
switch and the look, here through the prebuilt `racs-ui.css`, without Tailwind.

CI builds it against the packed libraries (`test:web-libs-consumer`), which checks that the
packages work outside this workspace.

```sh
# from racs-webapp/: build and pack the libraries
npm ci && npm run build:libs && npm run pack:libs
cd examples/consumer
npm install --no-save ../../dist/packages/ng-racs-core-*.tgz ../../dist/packages/ng-racs-ui-*.tgz
npx ng serve --proxy-config proxy.conf.json   # proxies /api (incl. WebSockets) to :8742
```

Once the packages are on npm, a plain `npm install` does. Use npm 11.6 or newer: npm 10 (Node 22's)
fails with `Cannot read properties of null (reading 'edgesOut')` while resolving `@angular/build`
21.2's peers, so CI runs `npx -y npm@11.21.1 install …`. Without hardware, run
`cargo run --release --example fake_server -- --port 8742` from the repository root (it connects two
fake cameras). A real server lists a camera here once it is connected (in the RACS UI or with
`PUT /api/v1/devices/{id}/connect`).
