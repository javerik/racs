# RACS AppImages

Build API-only or bundled webapp AppImages for `x86_64`, `aarch64`, and `armhf`:

```bash
./appimage/build.sh x86_64           # existing API-only variant (default)
./appimage/build.sh x86_64 webapp    # website and API on a shared Actix listener
./appimage/build.sh aarch64 webapp
./appimage/build.sh armhf webapp
```

Local builds require Cargo, curl, basic Linux build tools, and the appropriate Rust target and cross-linker for ARM. Webapp builds additionally require Node 22.12+ and npm. The script runs `npm ci` and the Angular production build. Packaging tools run on an x86_64 Linux host; they download the target architecture's AppImage runtime. The Angular build retrieves its existing Google Fonts stylesheet over the network.

CI sets `CI=true` and provides the matching Rust executable plus the production browser assets from the shared Node 22 build/test job. No Node or nginx runtime is included in the resulting bundle. CI uses extraction mode to avoid FUSE. The armhf packaging jobs install `file` and `desktop-file-utils` in the existing pinned builder; future builder images include these utilities directly.

Outputs are `rust-cam-serve-<version>-<arch>.AppImage` and `racs-webapp-<version>-<arch>.AppImage`. Staging directories are isolated by variant and architecture. The version defaults to the Cargo package version; tags use the release tag and GitLab manual jobs use the short commit hash.

Optional build environment variables:

- `APPIMAGE_VERSION`: override the output version.
- `APPIMAGE_OUTPUT_DIR`: destination directory, defaulting to `appimage/`.
- `RACS_WEB_DIST`: prebuilt browser asset directory (also skips the local npm build when explicitly supplied), defaulting to `racs-webapp/dist/racs-webapp/browser`.
- `APPIMAGE_EXTRACT_AND_RUN=1`: run packaging tools without FUSE (automatically set in CI).

The local Docker helper `./build_appimage_docker.sh x86_64 webapp` builds frontend assets in a Node 22 container, then packages them with the Rust builder. Cross-architecture builds require a Rust builder with the corresponding target and linker.

## Run

```bash
chmod +x racs-webapp-0.5.0-x86_64.AppImage
./racs-webapp-0.5.0-x86_64.AppImage --host 127.0.0.1 --port 9000
# Open http://127.0.0.1:9000/; Swagger is at /swagger-ui/.

RACS_HOST=127.0.0.1 RACS_PORT=9000 ./racs-webapp-0.5.0-x86_64.AppImage
```

`--host` and `--port` override `RACS_HOST` and `RACS_PORT`. Defaults remain `0.0.0.0:8742`. IPv6 is supported, for example `--host ::1`. Ports must be between 1 and 65535. Binding failures report the requested listener.

The webapp launcher locates its assets inside the mounted/extracted bundle regardless of the working directory. `--web-root` or `RACS_WEB_ROOT` can override that default. API-only bundles do not serve a website unless given an explicit web root. Stop with Ctrl+C; the launcher executes the server directly and forwards all CLI arguments.

On a system without FUSE:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./racs-webapp-0.5.0-x86_64.AppImage --host 127.0.0.1 --port 9000
```

Release pipelines publish both variants for all three architectures. Before claiming ARM runtime validation, smoke-test the respective bundle on a native device; CI cross-compiles but does not emulate ARM.
