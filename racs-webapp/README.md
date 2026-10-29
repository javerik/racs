# racs-webapp

The RACS website, and the workspace of the Angular libraries it is built from (spec
[`specs/web-libraries.md`](../specs/web-libraries.md)):

| Project | Path | |
|---|---|---|
| `racs-webapp` | `src/` | The website: `racsRoutes`, `racsSessionInterceptor`, `provideRacs()` and `<racs-shell />` |
| `ng-racs-core` | `projects/ng-racs-core` | npm library: models, services, algorithms ([readme](projects/ng-racs-core/README.md)) |
| `ng-racs-ui` | `projects/ng-racs-ui` | npm library: components, pages, shell, design system ([readme](projects/ng-racs-ui/README.md)) |
| consumer example | `examples/consumer` | A small app on the packed libraries ([readme](examples/consumer/README.md)) |

`tsconfig.json` maps the package names to the library sources, so the website builds, serves and
tests without building the libraries first.

```bash
npm ci
npx ng serve                 # http://localhost:4200, /api proxied to :8742 (below)
npx ng test --watch=false    # Vitest: the website and both libraries (npx ng test ng-racs-ui for one)
npm run build                # dist/racs-webapp/browser
npm run build:libs           # dist/ng-racs-core, dist/ng-racs-ui (ng-packagr, LICENSE, prebuilt CSS)
npm run pack:libs            # dist/packages/*.tgz, after checking the versions against Cargo.toml
```

### RACS-API (Proxy, Entwicklung)

`ng serve` nutzt [`proxy.conf.json`](./proxy.conf.json): Anfragen an dieselben Pfade wie beim Backend werden an **http://localhost:8742** weitergeleitet (kein CORS im Browser nötig).

| Dein Aufruf (Angular, z. B. Port 4200) | Ziel (racs-api) |
|----------------------------------------|-----------------|
| `/api/v1/...`                          | `http://localhost:8742/api/v1/...` |
| `/api/v1/devices/{id}/stream/live`     | Live-Stream (WebSocket, deshalb `"ws": true` im Proxy) |
| `/swagger-ui/`                         | Swagger UI des Backends |
| `/api-docs/openapi.json`               | OpenAPI-Spezifikation |

1. **racs-api** starten (Port **8742**).
2. **`ng serve`** aus diesem Ordner starten.
3. Im Angular-Code **relative URLs** verwenden, z. B. `fetch('/api/v1/...')` oder `HttpClient` mit `'/api/v1/...'`.

**Hinweis:** Der Proxy gilt nur für `ng serve`, nicht für `ng build`. In Production kann RACS die Website und die API auf demselben Listener bereitstellen:

```bash
npm ci
npm run build
cd ..
cargo run --release -- --web-root racs-webapp/dist/racs-webapp/browser --host 127.0.0.1 --port 8742
```

Alternativ enthält `racs-webapp-<version>-<arch>.AppImage` bereits das Backend und die gebaute Website. `--host` / `--port` überschreiben `RACS_HOST` / `RACS_PORT`; Standard ist `0.0.0.0:8742`. Ein Reverse-Proxy ist bei den vorhandenen Docker-Images weiterhin enthalten.
