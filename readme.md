# RACS - RustAravisCamServe

<img alt="RACS" src="./racs-logo.svg" width="340"/>

**Production (Master):** [![CI/CD Pipeline](https://codeberg.org/javerik/RACS-RustAravisCamServe/badges/workflows/ci-cd.yml/badge.svg?branch=master)](https://codeberg.org/javerik/RACS-RustAravisCamServe/actions)

**Development (Dev):** [![CI/CD Pipeline](https://codeberg.org/javerik/RACS-RustAravisCamServe/badges/workflows/ci-cd.yml/badge.svg?branch=dev)](https://codeberg.org/javerik/RACS-RustAravisCamServe/actions)

This projects aims to make [GigE Vision®](https://www.automate.org/vision/vision-standards/vision-standards-gige-vision)/[GenICam®](https://www.emva.org/standards-technology/genicam/) cameras available by `HTTP` protocol.
It's based on a `HTTP-RESTApi` server written in `rust` using [aravis-port](https://github.com/javerik/aravis-port) as backbone — a pure-Rust implementation of the GigE Vision protocol stack, so there is no native library to install or link against.

## Project goals

The goal is to create a stable, easy to use `HTTP` access to `GigE Vision®` cameras which targets accessibility instead of performance. 

* Simple `RESTApi` interface for multi-user camera access
* Client libraries for major high-level languages
  * `python`
  * `C#`
  * `rust`
  * `kotlin`
* Angular libraries (`ng-racs-core`, `ng-racs-ui`) for web UIs of your own
* Cross-platform for `x86`, `armv7`, `aarch64` and `windows-mingw`


## Usage

There are multiple ways to run `racs-api` server

1. Native build
2. Docker / Podman
3. AppImage
4. Embedded Device

> Every distribution is self-contained: `aravis-port` is pure Rust, so no camera library has to be
> installed alongside the binary.

The `racs-api` opens on default a port on `8742` and a [swagger-ui](https://swagger.io/tools/swagger-ui/) page can be access via [http://localhost:8742/swagger-ui/](http://localhost:8742/swagger-ui/).

### Docker

Usage by version

* `sharerox/racs:latest` - Based on the `master` branch
* `sharerox/racs:dev` - Based on the `dev` branch
* `sharerox/racs:<git-tag>` - based on a specific git `tag` - These versions have a stable `API` and might only get security updates

#### racs-api server

This docker image only includes the `racs-api` server.

```shell
docker pull  sharerox/racs:latest
docker run --rm -it --net=host sharerox/racs:latest
```

#### racs-website

This docker image includes the `racs-api` server and the [racs-website](racs-webapp). Like the webapp AppImage, the server serves the website itself, together with the REST API, WebSockets and Swagger, from one process (`RACS_WEB_ROOT=/app/web`).

```shell
docker pull  sharerox/racs-website:latest
docker run --rm -it --net=host sharerox/racs-website:latest
```

Access the website via [http://localhost:8742/](http://localhost:8742/). `RACS_PORT` / `RACS_HOST` (or `--port` / `--host`) change the listener; the container runs as an unprivileged user, so pick a port above 1023.

### AppImage

API-only AppImages and bundled webapp AppImages are available for x86_64, aarch64, and armhf. The webapp bundle includes the production Angular assets and serves the website, REST API, WebSockets, and Swagger from one Rust process:

```bash
chmod +x racs-webapp-0.5.0-x86_64.AppImage
./racs-webapp-0.5.0-x86_64.AppImage --host 127.0.0.1 --port 9000
# Open http://127.0.0.1:9000/ in your browser.
```

Both variants accept `--host` / `--port`, or `RACS_HOST` / `RACS_PORT`. CLI values take precedence; defaults are `0.0.0.0` and `8742`. IPv6 hosts use the unbracketed form, for example `--host ::1`. An ordinary Rust binary can also serve a built website with `--web-root racs-webapp/dist/racs-webapp/browser` (or `RACS_WEB_ROOT`), or automatically from a `web/` folder placed next to the executable (as in `racs-webapp-windows-x86_64.zip`). A missing web root or `index.html` fails startup rather than silently running without the website. Use `--help` for details.

Two more settings concern clients and idle cameras (see [Multi-user](#multi-user)): `--session-timeout` (`RACS_SESSION_TIMEOUT_S`, default 30 s, clamped to 5..600) is how long a client session lives without a heartbeat, and `--device-idle-timeout` (`RACS_DEVICE_IDLE_TIMEOUT_S`, default 300 s) is how long a connected camera may go unused before the server disconnects it; `0` keeps cameras connected until someone disconnects them, as before 0.4.

```shell
chmod +x racs-api-x86_64.AppImage
RUST_LOG=info ./racs-api-x86_64.AppImage
```

### Embedded Device
If you to **not** have `fuse` installed on the device, `export APPIMAGE_EXTRACT_AND_RUN=1` before running the `AppImage`.

For most devices you need to use the `aarch64` or `armhf` version.


## Live streaming

Besides the single-frame endpoints (`/stream/frame/jpeg`, `/stream/frame/raw`) a device can be
streamed continuously over a WebSocket:

```
ws://localhost:8742/api/v1/devices/{id}/stream/live?format=jpeg&quality=80&fps=15
```

| Query parameter | Default     | Meaning                                                    |
|-----------------|-------------|------------------------------------------------------------|
| `format`        | `jpeg`      | `jpeg`, `raw` for `width * height` pixels, or `zstd` for the same pixels losslessly compressed (see [below](#lossless-compression-zstd)) |
| `quality`       | `80`        | JPEG quality 1–100, ignored for `raw` and `zstd`            |
| `fps`           | *unlimited* | Target frame rate; frames arriving sooner are dropped       |
| `pixel_depth`   | `mono8`     | `mono8`, or `mono16` for more than 8 bits (see below)       |

The first message is text and describes the stream — raw frames carry no dimensions, so a raw
consumer needs it:

```json
{"width":1280,"height":1024,"format":"jpeg","pixel_format":"Mono8","bit_depth":8,"packet_size":1500}
```

Every message after that is binary:

```
[4 bytes frame_number (u32 LE)][4 bytes frames_dropped (u32 LE)][image data]
```

A raw image is `width * height` bytes when `bit_depth` is 8, and `width * height` little-endian
`u16`s otherwise.

`frame_number` starts at 0 and counts the frames actually sent to this socket. `frames_dropped` is
cumulative for the socket and never resets — it covers incomplete frames, frames skipped by its
`fps` limit, and frames dropped because this client could not keep up.

The text message is sent again whenever the geometry or the packet size changes mid-stream (see
below). Each one
describes every binary message after it, until the next; the counters carry on across it.

> Several clients can watch a device at once: the first socket starts the capture, later ones join
> it with their own `format`, `quality` and `fps`, and a slow client only costs itself frames.
> The pixel depth is the one the capture was started with; a socket asking for another one is told
> the running `bit_depth` in its text message. Starting a capture needs write permission on the
> device, joining one read permission. `GET /devices/{id}/stream/error` reports the number of
> open sockets as `viewers`.
>
> The capture holds the camera for as long as it has viewers, so single-frame grabs and burst jobs
> for that device are rejected as busy until the last socket closes. The camera takes a moment to
> come back after the close, but requests arriving meanwhile (reopening the stream with other
> settings, say) wait for it rather than being rejected. The same applies after cancelling a
> running burst job.
>
> Disconnecting the device (`PUT /devices/{id}/disconnect`) stops a running stream: every socket is
> closed with `1001` (going away) and the reason `device disconnected`. The disconnect answers once
> the camera is closed, and the device can be connected and streamed again right away.

### Changing settings while streaming

GenICam reads, writes and commands for a streaming device are not rejected: the server carries
them out inside the running stream, between frames, so an exposure change shows up in the next
frames without reopening the socket. Features the camera locks during acquisition (their
`pIsLocked` depends on `TLParamsLocked`: `ExposureTime`, `AcquisitionFrameRate`, `Width`, … on
most cameras) are written with acquisition paused for a moment, because a camera may store them
mid-acquisition but keep using the old value until the next start. The request answers once
acquisition runs again (about 0.2 s on an AT C6); changes queued up meanwhile go into the same
pause. A (re)started acquisition that delivers nothing for 3 s is started again, up to twice,
before the stream gives up. A change that alters the payload (`Width`,
`Height`, a binning or scan mode, a loaded user set) re-announces the geometry, and a write the
camera refuses while acquiring is retried with acquisition paused too.
`GevSCPSPacketSize` is written with acquisition paused as well, and the stream reopens its channel
with the new size (see [Packet size](#packet-size-and-jumbo-frames)). `PixelFormat` (set from
`pixel_depth`), the stream destination (`GevSCDA`, `GevSCPHostPort`) and
`AcquisitionStart`/`AcquisitionStop` are refused while a stream runs. During a burst job everything stays busy: nothing may change the camera under a measurement.

The socket is closed on any acquisition error. Since a closed socket takes its reason with it, ask
afterwards:

```shell
curl http://localhost:8742/api/v1/devices/0/stream/error
# {"last_error":"...","timestamp":"2026-07-30T21:12:44.918+00:00","active_stream":false}
```

### Lossless compression (zstd)

`format=zstd` sends the raw pixels losslessly compressed: about half the bytes of `raw` on a real
camera image (2.35× at 8 bit, 2.1× at 12 bit), for about 3 ms of server CPU per 1.2-megapixel
frame. Frames are encoded on several threads at once, so the frame rate is not limited to what
one core manages. JPEG, for comparison, is about 24× smaller but lossy and twice as expensive to
encode. The measurements behind this are in [specs/live-compression.md](specs/live-compression.md).

Each image is one [zstd](https://facebook.github.io/zstd/) frame with its content size in the
header. Decompressed, it holds one residual per pixel, row by row: the pixel minus the pixel above
it (minus 0 in the first row), wrapping at the pixel width.

* At 8 bit the residuals are `width * height` bytes.
* Above 8 bit each residual `d`, taken as `i16`, is zigzagged to `z = (d << 1) ^ (d >> 15)`, and
  the data is every low byte of `z` followed by every high byte (`2 * width * height` bytes).

Decoding un-zigzags (`d = (z >> 1) ^ -(z & 1)`) and adds the decoded pixel above, wrapping: a
cumulative sum down each column. With numpy:

```python
import numpy as np
from compression import zstd   # Python 3.14+, else: import zstandard

res = np.frombuffer(zstd.decompress(payload), np.uint8)
if bit_depth == 8:
    pixels = np.cumsum(res.reshape(height, width), axis=0, dtype=np.uint8)
else:
    n = width * height
    z = res[:n].astype(np.uint16) | (res[n:].astype(np.uint16) << 8)
    d = (z >> 1) ^ (-(z & 1)).astype(np.uint16)
    pixels = np.cumsum(d.reshape(height, width), axis=0, dtype=np.uint16)
```

The client libraries and the website decode it for you.

### Pixel depth

`pixel_depth=mono16` asks the camera for the deepest unpacked mono format it accepts: `Mono16`,
then `Mono14`, `Mono12` and `Mono10`. Whatever the camera grants is reported as `pixel_format`
and `bit_depth`. A 3D profiler in `DeviceScanType = Linescan3D` (the AT C6, say) offers no mono
format at all, only a range format: `Coord3D_C16` (or `Coord3D_C8`), one height per pixel, laid out
like Mono16 (Mono8). Both depths fall back to it, so such a camera streams 16 bit whichever is
asked for, raw single frames included. Values keep their native range: a Mono12 pixel is `0..4095`, not shifted up to 16
bits. JPEG cannot hold more than 8 bits, so JPEG frames carry the top 8 significant bits. Use `raw`
or `zstd` when the full range matters. The single-frame endpoints always deliver Mono8.

Behind a reverse proxy the `/api` location has to forward the `Upgrade`/`Connection` headers and
allow a long read timeout, since a live stream lasts as long as the client wants it to. For nginx:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /api {
    proxy_pass http://127.0.0.1:8742;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

### Packet size and jumbo frames

Every grab, live stream and burst uses the camera's stream packet size, `GevSCPSPacketSize`, as it
is. It counts whole IP datagrams (IP and UDP headers included), so it can't exceed the MTU of the
link: 1500 on a standard network. With jumbo frames enabled on the interface (MTU 9000) and any
switch in between, larger packets cut the per-packet overhead. A full 3072×1020 frame from an AT
C6 arrives about 2.4 times faster at 7960 than at 1500.

```shell
curl http://localhost:8742/api/v1/devices/0/stream/packet-size
# {"packet_size":1500,"min":88,"max":7960,"inc":4,"link_mtu":9000,"interface":"enp9s0f0","local_ip":"169.254.1.1"}
curl -X PUT 'http://localhost:8742/api/v1/devices/0/gc/feature/GevSCPSPacketSize?value=7960'
curl -X POST http://localhost:8742/api/v1/devices/0/stream/packet-size/auto
# {"packet_size":7960,"previous":1500,"test_packets":true,"link_mtu":9000,"interface":"enp9s0f0"}
```

A written size has to be a multiple of `inc` between `min` and `max`, and not above `link_mtu`
(known on Linux). `auto` lets the camera fire GigE Vision test packets with "don't fragment" set
and keeps the largest size that arrives, which also catches a switch with a smaller MTU than the
interface. On connect the server checks the camera's size the same way and replaces it only when
it doesn't get through. Both the write and `auto` work during a live stream: acquisition pauses for
a moment and the stream carries on with the new size, announced in its text message. The web UI
has them under Quick settings → Transport.

## GenICam features

`GET /devices/{id}/gc/categories` lists every feature with its type, visibility, declared access
mode, enum entries and selector relations. Values are plain text:

```shell
curl http://localhost:8742/api/v1/devices/0/gc/feature/ExposureTime              # 10000
curl -X PUT 'http://localhost:8742/api/v1/devices/0/gc/feature/ExposureTime?value=1500'
curl -X PUT 'http://localhost:8742/api/v1/devices/0/gc/feature/ReverseX?value=true'
```

Integers and enums are integers (an enum also accepts its symbolic entry name), floats are
numbers, and `Boolean` features are `true`/`false`. A `Command` has no value; execute it:

```shell
curl -X POST http://localhost:8742/api/v1/devices/0/gc/command/TriggerSoftware
```

To present features in a UI, ask for their live state, several at once (up to 256 names):

```shell
curl -X POST http://localhost:8742/api/v1/devices/0/gc/features/state \
  -H 'Content-Type: application/json' -d '{"names":["ExposureTime","AcquisitionFrameRate"]}'
# [{"name":"ExposureTime","node_type":"Float","value":"10000","available":true,"locked":false,
#   "min":0.01,"max":1000000.0,"inc":0.01,"unit":"us","representation":"Linear",
#   "available_entries":null,"error":null},
#  {"name":"AcquisitionFrameRate","node_type":"Float","value":"2","available":true,"locked":true, ...}]
```

`available` and `locked` follow the camera's `pIsAvailable`/`pIsLocked` conditions right now (a
frame rate is locked while its enable is off, a line rate unavailable in area-scan mode).
`available_entries` lists the enum values the camera currently offers. A problem with one name
is reported in its `error` rather than failing the request.

## Burst capture

To grab a batch of frames without holding an HTTP request open for the whole capture, start a
background job. The `POST` answers immediately with a job id; the capture runs behind it.

```shell
curl -X POST http://localhost:8742/api/v1/devices/0/grab/jobs \
  -H 'Content-Type: application/json' \
  -d '{"count":20,"format":"jpeg","quality":80}'
# 202 {"job_id":"b1f2b6b0-...","device_id":0,"status":"pending"}
```

| Field          | Default   | Meaning                                                          |
|----------------|-----------|------------------------------------------------------------------|
| `count`        | *required*| Frames to grab, 1–500                                             |
| `format`       | *required*| `jpeg`, `raw` for `width * height` pixels, or `zstd` ([lossless](#lossless-compression-zstd)) |
| `pixel_depth`  | `mono8`   | `mono8`, or `mono16`, as for [live streaming](#pixel-depth)       |
| `quality`      | `80`      | JPEG quality 1–100, ignored for `raw` and `zstd`                  |
| `on_failure`   | `abort`   | `abort` fails the job on the first bad frame; `skip` carries on   |
| `max_failures` | *unlimited* | With `skip`, how many bad frames to tolerate before failing     |

Then poll the job and collect its frames — the image list grows as the burst progresses, so frames
can be fetched before it ends:

```shell
curl http://localhost:8742/api/v1/devices/0/grab/jobs/$JOB
# {"status":"running","requested_count":20,"captured_count":7,"failed_count":0,
#  "width":1280,"height":1024,"pixel_format":"Mono8","bit_depth":8, ...}

curl http://localhost:8742/api/v1/devices/0/grab/jobs/$JOB/images
# [{"index":0,"status":"ok","size_bytes":4213}, ...]

curl http://localhost:8742/api/v1/devices/0/grab/jobs/$JOB/images/0 -o frame0.jpg

curl -X DELETE http://localhost:8742/api/v1/devices/0/grab/jobs/$JOB   # cancel, or discard
```

`status` is `pending`, `running`, `completed`, `failed` or `cancelled`, and `error` says why a
failed job failed. `width`, `height`, `pixel_format` and `bit_depth` are `null` until the first
frame is captured; every frame of a job shares them, so raw images can be decoded without asking
the camera, which the job keeps busy. Fetching an index the job has not reached yet is a `404`; an index that was
attempted and failed is a `410` with the reason as the body.

> A burst job holds the camera for as long as it runs, exactly like a live stream — so it competes
> with single-frame grabs, live streams and other jobs on the same device. Because the camera is
> taken by the background task rather than by the request, starting a job on a device that is
> already busy still returns `202`; the job then fails immediately, so check its status. "Busy" means
> held by a live stream or another job: a feature read, write or single-frame grab that is running
> when the job starts is waited for.
>
> Disconnecting the device cancels a running job. Unlike a `DELETE` its record stays: `status`
> becomes `cancelled`, `error` is `device disconnected`, and the images taken so far can still be
> fetched until the job expires.

Jobs and their images live in memory only, and a finished job is dropped 10 minutes after it ends
unless it is deleted sooner.

## Multi-user

Several clients can use one server at once. A client may identify itself with a **session**; one
that doesn't keeps working as before, anonymously.

```shell
curl -X POST localhost:8742/api/v1/sessions -H 'Content-Type: application/json' -d '{"name":"line-script"}'
# 201 {"session_id":"6b1d…","client_id":"3f2a9c1e","name":"line-script","timeout_s":30,"heartbeat_interval_s":10}
curl -X PUT localhost:8742/api/v1/devices/0/connect -H 'X-Racs-Session: 6b1d…'
```

* `session_id` is a secret: send it with every request as the header `X-Racs-Session`, or as
  `?session=` (WebSockets can only use the query parameter). `client_id` is how other clients
  see you. An unknown or expired session gets `401 {"error":"session_expired"}`: create a new one.
* Every request carrying the session is a heartbeat, and so is
  `POST /sessions/{session_id}/heartbeat` and every pong on a WebSocket carrying it. Without one
  for `timeout_s` the session ends; `DELETE /sessions/{session_id}` ends it at once. `GET /sessions`
  lists who is connected (never with a `session_id`). `PATCH /sessions/{session_id} {"name":…}`
  renames a session; other clients see the new name from then on.
* A session that connects to or uses a device becomes a **member** of it. `PUT
  /devices/{id}/disconnect` then *leaves* the device, and the camera closes once no member and no
  live stream or burst is left. The answer is `{"closed":bool,"members":n}`. A disconnect without
  a session closes the device unless a session uses it; `?force=true` closes it for everyone.
* A camera without members, streams, bursts or anonymous requests for `--device-idle-timeout` is
  disconnected. Using it again connects it again.
* When a session ends, its live streams are closed with `4001` (`session expired`); its burst jobs
  run on.

### Access modes

A device is `shared` unless a session takes its **lease**:

| mode | owner | other sessions | anonymous |
|---|---|---|---|
| `shared` (default) | – | read + write | read + write |
| `ro-shared` | read + write | read | meta |
| `exclusive` | read + write | meta | meta |

| class | routes |
|---|---|
| meta | `GET …/xml`, `…/gc/categories`, `…/stream/error`, `…/access` |
| read | `GET …/gc/feature/{name}`, `POST …/gc/features/state`, `GET …/stream/packet-size`, joining a running live stream, reading burst jobs and their images |
| write | `PUT …/gc/feature/{name}`, `POST …/gc/command/{name}`, `POST …/stream/packet-size/auto`, `GET …/stream/frame/raw` and `…/jpeg`, starting a live stream, `POST …/grab/jobs`, `DELETE …/grab/jobs/{job_id}`, `PUT …/disconnect?force=true` |

```shell
curl -X PUT 'localhost:8742/api/v1/devices/0/connect?mode=exclusive' -H 'X-Racs-Session: 6b1d…'
# 200 {"device":0,"mode":"exclusive","owner":{"client_id":"3f2a9c1e","name":"line-script"},
#      "members":[…],"holder":null,"viewers":0,"you":"owner"}
```

* `PUT /devices/{id}/connect?mode=` connects and takes the lease in one step;
  `PUT /devices/{id}/access {"mode":…,"force"?:bool}` takes, changes or (with `shared`) gives it
  up; `DELETE /devices/{id}/access[?force=true]` releases or breaks it; `GET /devices/{id}/access`
  shows it, with `you`, your role (`owner`, `writer`, `reader`, `meta`). `GET /devices/connected`
  carries the same `access` object per device. The lease routes need a session.
* The lease ends when its owner releases it, the owner's session ends, someone forces it, or the
  device closes. The mode is then `shared` again.
* Refusals are JSON: `400 session_required` (a lease route without a session), `403 read_only` (a
  write on a `ro-shared` device by a reader), `409 device_in_use` (going `exclusive` while other
  sessions are members or another client's live stream or burst holds the device), `423
  device_locked` (above meta on an `exclusive` device or anonymously on a `ro-shared` one, or
  taking a lease another session owns). A refused live WebSocket answers with the status before
  the upgrade, and the reason is kept for `GET …/stream/error`.
* `force` takes the lease anyway. Going `exclusive` with it evicts the other clients: they leave
  the device, their live streams are closed with `4003` (`access revoked`), their running bursts
  are cancelled (error `access revoked`), and each evicted session gets `access_revoked`.

### Events

`GET /api/v1/events?session=<session_id>` is a WebSocket of what happens on the server, as JSON
messages with a global `seq`. It also keeps its session alive: the server pings it every
`heartbeat_interval_s`.

```json
{"seq":118,"time":"2026-10-08T19:30:00.123Z","type":"feature_changed","device":0,
 "by":{"client_id":"77d0aa12","name":"line-script"},"feature":"ExposureTime"}
```

| `type` | sent when |
|---|---|
| `hello` | first, with your `session` and the state of every connected device |
| `device_state` | a device connected or disconnected, its members or its lease changed, or a live stream or burst started or stopped; the complete state, with `cause`, `reason` and `by` |
| `feature_changed` | a client wrote a feature (also during a live stream, and the packet size found by the auto search); read again what you show |
| `command_executed` | a client executed a command |
| `access_revoked` | a session lost a device's lease, its membership or its stream or burst to another session's `force` (`client_id`, `by`) |
| `session_ended` | a session expired or was closed |
| `resync` | this socket fell behind and lost events: read the state again |

`by` is `null` for anonymous clients and the server itself.

### Timeouts and close codes

| flag | env | default | |
|---|---|---|---|
| `--session-timeout <s>` | `RACS_SESSION_TIMEOUT_S` | `30` | how long a session lives without a heartbeat, unless it asks for its own `timeout_s` in `POST /sessions`; clamped to 5..600. Heartbeats are due every third of it |
| `--device-idle-timeout <s>` | `RACS_DEVICE_IDLE_TIMEOUT_S` | `300` | how long a connected device may go without a member session, a live stream, a burst or an anonymous request before it is disconnected (reason `idle`); `0` never disconnects, as in 0.3 |

A session's end (an expiry or `DELETE`) releases its leases and drops its memberships at once. The
camera itself stays connected until the idle timeout, so a client that comes back quickly finds it
open.

The live stream (`…/stream/live`) and the events socket (`/events`) close with:

| code | reason | socket | meaning |
|---|---|---|---|
| `1000` | | both | the client closed the socket |
| `1001` | `device disconnected` | live | the device was disconnected: by a client, a force or the idle timeout |
| `1001` | | live | the camera stopped delivering |
| `1001` | | events | the server is shutting down |
| `1011` | the error | live | the capture failed; `GET …/stream/error` keeps the reason |
| `4001` | `session expired` | both | the socket's session ended (expired or `DELETE`d) |
| `4003` | `access revoked` | live | another session took the device `exclusive` with `force` |

### In the website

Each browser tab is a client of its own, named `webapp · <browser>` (renamed in the sidebar). A
reload keeps its session; a duplicated tab starts a new one. Discovery and the sidebar connect as
`shared`, `ro-shared` or `exclusive`. The device page shows the mode, who holds the device, and
how many clients use and watch it, with *Take control*, *Release* and *Force release* (a second
click confirms a force). A tab that may only read shows the settings read-only with the reason,
and can still join a running live stream. A feature another client changes is read again and
named for a few seconds in the settings' head. A device closed by someone else or for being idle
shows why, with *Reconnect*.

## Website: region and ROIs

The live view's toolbar has three tools besides the view controls:

* **Region** shows the image on the whole sensor and lets you set the camera's region
  (`Width`, `Height`, `OffsetX`, `OffsetY`) by dragging it: its sides and corners resize it, the
  inside moves it, a drag beside it draws a new one. Values snap to the camera's increments and
  can be typed. **Apply** (or Enter) writes them, also during a live stream; Esc cancels.
* **Rect** and **Line** draw soft ROIs, measured in the browser. They are kept per device and
  shared with the burst player. A selected ROI is moved and resized by its handles, nudged with
  the arrow keys, and removed with Delete.

Under the image, *ROI analysis* lists n, min, max, mean and standard deviation per ROI, and
plots a line profile, a rectangle's column or row means, a statistic over time (live) or across
a burst, or a histogram. Each plot can be shown raw, smoothed with a moving average, or with a
linear, polynomial or Gaussian fit and its parameters. The statistics and the plot each have an
**Auto** switch; switched off, they hold the frame they measured until **Update**.

## Website: 3D point cloud

The **3D** tab, next to Live and Burst, draws frames as a point cloud with WebGL2: each image row
is a profile (y), each column a position along it (x), each value a height (z). That is what a
laser profiler streams in `DeviceScanType = Linescan3D`; the tab shows the camera's scan type and
offers to switch to Linescan3D, but draws any camera's frames.

* **Continuous** streams raw frames without an fps limit into a rolling buffer of the last 1024 to
  32768 profiles. Frames lost on the way leave a gap, so distances along y stay true.
* **Snapshot** captures 1 to 500 frames as a raw burst and stacks them in capture order. A
  snapshot larger than the device keeps (256 MiB on a desktop, 96 MiB on a phone) keeps every n-th
  profile, which the status line says.

The view orbits (drag), pans (right or shift drag, two fingers), zooms (ctrl+wheel, pinch) and
fits (double click or tap); Top, Front, Side and Iso look from fixed directions, Top like the 2D
image. *Points* draws a point per value, *Surface* a surface through them, broken where neighbouring
values differ by more than a share of the display window (*Break*), so a laser shadow stays a gap
rather than a wall. Value 0 means no measurement and is not drawn. Values are coloured by height
through the display window under the view, in grey or a viridis, cividis or magma palette; a colour
scale in the corner gives the window's ends in units. The density thins automatically to what the
device draws smoothly.

**Measure** (the ruler in the view's toolbar, or `m`) reads the cloud: a click or tap on it shows
the point's x, y and z in the scaling's units (with *Laserline* scaling, z is the height above the
line's base), and *Distance* measures between two points A and B, with Δx, Δy and Δz. y counts from
the first profile of the box, as the extents do. The readout says what z is: *z above base* with
*Laserline* scaling, *raw z* otherwise. *Step* gives the height between the faces A and B lie on: the
difference of the medians of the 5 × 5 values around each, so noise and a few values from the other
face don't count; click a little inside each face. *Section* plots z along the line from A to B, a
value per cell, with gaps where the cloud has none (a laser shadow). The plot sits under the cloud,
or beside it where the view is wide enough (full screen on a desktop), with s and z in the scaling's
unit. A third click starts a new pair, Esc or *Clear*
clears, and a double click or tap still fits. The pick lands where the drawn cloud is under the
pointer, exactly at full resolution whatever density is drawn; in points mode a point a few pixels
beside the pointer counts when nothing is under it, and a step the surface breaks at is no
surface. Points stay with their profiles while a rolling buffer scrolls and disappear once those
are dropped. Zoom in for precision: a pixel covers many profiles in a long buffer.

*Scene* opens two rows under the view's toolbar:

* **Stretch** multiplies x, y and z in the view only (the export keeps the units). *Z auto* first
  stretches the heights to a third of the footprint, *Z 1:1* keeps true proportions; the z factor
  applies on top.
* **Light** shades the cloud with one white light: drag the dial to set where it comes from (the
  centre is overhead, the rim the horizon, the tick marks where you look from), or let it *Follow
  view*. *Diffuse*, *Ambient*, *Gloss* and *Sharp* set the shading and highlights, and *Shadows*
  casts the surface's shadows (in both modes). Keys: `s` points/surface, `l` light on/off.

*Scaling* turns pixels into units: x = column × pitch, y = profile × spacing, z = value × scale +
offset, kept per camera (by its MAC). *X order Mirrored* runs x from the last column. The source is
one of three; typing a value switches it to *Manual*:

* **Manual**: the values as typed.
* **From camera** reads them from the SFNC `Scan3dCoordinateScale` and `Scan3dCoordinateOffset` of
  coordinates A, B and C.
* **Laserline** makes the cloud metric when the camera films the emulated laserline (the
  `laserline` tool): u along the line and z above the base in the STL's mm, as laserline slices it.

The *Laserline* source needs a **range calibration**. With the camera in `Linescan3D`, streaming at
16 bit in Continuous mode (`Coord3D_C16`, or `Mono16` as the AT C6 also sends its range), and a scan loaded and enabled in laserline, *Calibrate*
opens laserline (if it isn't open) and has it show lines: blank, the user's line, parallel lines
until the camera loses them (the band it sees), and ±45° crossing lines. The cloud pauses meanwhile;
keep the camera and the laserline window still and visible. It takes a few seconds and needs no write
access. The review shows the rms and largest error in laserline view px, the lines seen, the band and
(after a run) the error per column. It is kept per camera (`racs.laserline.range.<mac>`).

From the calibration and what laserline publishes (view px per mm along the line and in height, the
travel speed), the tab derives x pitch, z scale and offset and whether x must be mirrored, and shows
what the per-axis fit leaves out as x and z residuals in mm. y is laserline's travel speed ÷ the
camera's profiles per second: measured live after 10 s of streaming, else the last estimate while
the line rate, exposure, trigger and region are unchanged, else `AcquisitionLineRate` (when
`AcquisitionLineRateEnable` is on), else a snapshot's timing (rough). The scaling follows laserline
live (a resize, a new scale or speed) and applies changes above 0.2 % (5 % for y in per-frame
playback, whose speed follows laserline's frame rate; use per-second playback for a steady y), and
keeps the view where you zoomed it. The last one is kept, so a reload without laserline keeps working. The states:

* **live**: following laserline;
* **laserline offline** (the last mapping is kept), **no mapping** (no scan, or an old laserline),
  **not calibrated**, **no fit**;
* **calibration stale**: laserline's view changed size, a recorded camera feature (region, offsets,
  `Scan3d*`, …) changed, or *Verify* failed;
* **y approximate**: laserline plays a scan row per frame, there is no profile rate yet, or it comes
  from a snapshot;
* **out of band**: the scan reaches heights outside the band the camera sees;
* **disturbances**: laserline's motion, bounce, once, pause, noise or zero height gain, named.

*Verify* films 3 parallel and 2 crossing lines against the kept calibration; more than twice its rms
(at least 0.1 px) marks it stale, which catches a camera or a laserline window that moved without a
resize. *Forget* drops it.

**Check against STL** (in the *Laserline* block) measures the scanned object in the cloud and
compares it with the extent laserline reports for the STL. It proposes a snapshot of one full pass
of the scan plus the object's length, +20 % (at most 500 frames: if it needs more, take more profiles
per frame or speed up laserline's travel), stops the stream, captures it and checks it. The object
is the largest connected patch above half its lowest top face, so a stepped L counts whole. Its
length along the line (Δu), along the travel (Δv) and its top height (z, with the noise taken out
like *Step*) each pass within 2 % of the STL's. It refuses a snapshot that cut the object, an object
leaving the camera's columns, and bounce playback (use loop). It can't see a mirror image; the 3D
view shows that.

*PLY* exports the valid points in those units (binary, for CloudCompare, MeshLab or Open3D); its
header names the scaling's source and, for *Laserline*, the calibration's rms, laserline's mapping
revision, the travel speed and where the profile rate came from.

## Website: tools

The sidebar's *Tools* section opens bundled web apps in a window of their own. *Laserline*
emulates the laser line of a laser-triangulation sensor and slices STL models into the profiles
such a sensor measures. It comes from the `laserthing` submodule and is served at
`/tools/laserline/` by the website's web root (Docker images, `--web-root`, the webapp AppImage).

### Calibrating a camera to Laserline

A camera filming the display that shows Laserline usually sees only part of it. The **Region**
tool's *Laserline* row calibrates the two to each other, so the laser line lies in what the camera
sees and the camera region holds the complete line:

1. Start the live stream (Areascan), open **Region**, and press **Calibrate**. RACS opens
   Laserline if needed (keep its view visible) and sets the region to the full sensor. Laserline
   then shows black, white, and the stripes of a Gray code of its columns and rows (about 23
   patterns; your line settings are kept aside meanwhile). Every camera pixel decodes the view
   position it sees, so it works however small a part of the display the camera covers; it takes
   10–20 s. RACS maps the Laserline view onto the sensor (refusing a mapping off by more than
   8 px) and puts the region back. If your line doesn't fit in what the camera sees, Laserline
   moves and shrinks it into that part.
2. The row shows the mapping's error (`rms`), the share of the Laserline view the camera sees,
   and the region that holds the line over its whole movement, deformation and scan playback,
   plus a margin. That region becomes the editor's draft (**Use** puts it there again); the
   line's envelope is drawn on the sensor. **Apply** writes it.
3. If the line leaves the sensor, the row says by how much at which edge. **Fit line** has
   Laserline move the line into the middle of the camera's field and shrink its length and
   movement to fit. Laserline outlines that field in its view and offers the same as *Fit line
   to camera*.
4. **Check** watches the stream for a few seconds and counts the frames showing the whole line.

The calibration is kept per camera (by its MAC) in the browser, so it survives a server restart,
and follows changes to the line. It is no
longer valid when the Laserline view changes size (the row says so); calibrate again then. Both
windows must be served from the same origin, as the bundled build is.

## Client libraries

The client libraries cover the whole `HTTP` API: discovery and connection, GenICam features,
single frames, the live stream and burst jobs. A `Camera` handle holds the device id and reads and
writes features as typed values:

```python
from racs_python import RacsClient

cam = RacsClient("http://localhost:8742").connect(0)
cam["ExposureTime"] = 5000.0
with cam.live(format="raw", pixel_depth="mono16") as stream:
    pixels = next(stream).to_numpy()
```

Each client is a [session](#multi-user) of its own. It is created with the first request, kept
alive with heartbeats, created anew if the server lost it, and ended when the client is closed
(`anonymous` turns this off and works as 0.3 did). The clients take and release leases, follow
the events, and raise a refusal as its own error, with the parsed body:

```python
with RacsClient("http://localhost:8742", name="line-script") as client:
    cam = client.connect(0, mode="exclusive")          # DeviceInUseError if others use it
    try:
        cam["ExposureTime"] = 5000.0
    finally:
        cam.release()
    for event in client.events():                      # hello, then what the others do
        if event.type == "feature_changed":
            print(event.by.client_id if event.by else "anonymous", "wrote", event.feature)
```

| | Python | .NET | Rust |
|---|---|---|---|
| session | `RacsClient(url, name=, anonymous=)`, heartbeat thread | `new RacsClient(url, name:, anonymous:)`, `PeriodicTimer` heartbeat | `RacsClient::builder(url).name(..).build()`, spawn `client.keep_alive()` |
| end it | `close()` / `with` | `DisposeAsync()` / `await using` | `close().await` |
| leases | `connect(mode=)`, `access()`, `take()`, `release()`, `disconnect(force=)` | `ConnectAsync(Mode)`, `GetAccessAsync`, `TakeAsync`, `ReleaseAsync`, `DisconnectAsync(force)` | `connect_as(mode, ip)`, `access()`, `take()`, `release()`, `force_disconnect()` |
| events | `client.events()` (iterator) | `client.EventsAsync()` (`IAsyncEnumerable`) | `client.events()` (`Stream`) |
| refusals | `SessionExpiredError`, `ReadOnlyError`, `DeviceInUseError`, `DeviceLockedError` | `…Exception` | `Error::SessionExpired`, `ReadOnly`, `DeviceInUse`, `DeviceLocked` |
| socket closed | `SessionEndedError` (`4001`), `AccessRevokedError` (`4003`) | `…Exception` | `Error::SessionEnded`, `Error::AccessRevoked` |

* [Racs.Dotnet](https://www.nuget.org/packages/Racs.Dotnet/) ([readme](client_libs/racs-dotnet/README.md))
  * [Example](examples/CSharpExample)
* [racs-python](https://pypi.org/project/racs-python/) ([readme](client_libs/racs-python/README.md))
  * [Example](examples/python)
* `racs-client` for Rust, async ([readme](client_libs/racs-rust/README.md))
  * [Example](client_libs/racs-rust/examples/tour.rs)

All three are tested against `examples/fake_server.rs`, which serves the API with fake cameras
connected: `client_libs/run-tests.sh` builds it and runs every suite.

### Angular libraries

The website is built from two Angular libraries (Angular 21.2+), for websites of your own on a
RACS server:

* [ng-racs-core](https://www.npmjs.com/package/ng-racs-core) ([readme](racs-webapp/projects/ng-racs-core/README.md)):
  the models, the API, session and events services, device and GenICam state, and the imaging and
  3D algorithms (frame decoding incl. `zstd`, ROI statistics, fits, laserline calibration, the
  WebGL point cloud renderer). No components.
* [ng-racs-ui](https://www.npmjs.com/package/ng-racs-ui) ([readme](racs-webapp/projects/ng-racs-ui/README.md)):
  every component of the website, from the frame canvas and the histogram range control to the
  live view, the burst player, the 3D view and the settings panels, the pages and the whole shell,
  with the design system (a Tailwind preset, or a prebuilt stylesheet for apps without Tailwind).
  * [Example](racs-webapp/examples/consumer): a page of its own with a live camera image

The whole website in an app of your own:

```ts
bootstrapApplication(AppComponent, {          // AppComponent's template: <racs-shell />
  providers: [
    provideRouter(racsRoutes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([racsSessionInterceptor])),
    provideRacs(),                            // or provideRacs({ apiBase: 'http://cam-server:8742/api/v1' })
  ],
});
```

## Build from source

You can either build the project using `docker` or build it native.

### Docker

Execute the bash script:

```shell
./build_via_docker.sh
```

The binary is copied to `bin/docker/racs-api`

### Native

No system libraries are required — `aravis-port` is pure Rust. Make sure the submodule is present,
then build:

```shell
git submodule update --init --recursive
cargo build --release
```

The website is built in `racs-webapp` (`npm ci && npm run build`), an Angular workspace with the
libraries `ng-racs-core` and `ng-racs-ui` (`npm run build:libs && npm run pack:libs` builds their
npm packages into `dist/packages`). Laserline is bundled into that
build with `scripts/build-laserline.sh`, which needs `rustup` with the `wasm32-unknown-unknown`
target (it fetches the matching `wasm-bindgen-cli` itself) and runs after `npm run build`, since
that empties `dist/`.




