# RACS python client library

Client for the [racs-api server](https://codeberg.org/javerik/RACS-RustAravisCamServe): device
discovery and connection, typed GenICam feature access, single frames, the live stream
(WebSocket) and burst jobs.

## Install

```shell
pip install racs-python            # numpy is optional:
pip install "racs-python[numpy]"   # adds Frame.to_numpy()
pip install "racs-python[zstd]"    # also decodes zstd frames (built into Python 3.14+)
```

## Usage

> **Make sure an instance of racs-api server is running**

A `Camera` holds the device id, so nothing else needs to pass it around:

```python
from racs_python import RacsClient

client = RacsClient("http://localhost:8742")   # "/api/v1" is added to a bare server URL

devices = client.get_devices()                 # network discovery
print(f"Found {len(devices.available)} available devices.")

cam = client.connect(devices.available[0].id)  # or client.connect(5, ip="192.168.0.10")

# Features are read and written as Python values
print(cam["Width"])                            # 1280 (int)
cam["ExposureTime"] = 5000.0
cam["ReverseX"] = True
width, height = cam.get_many("Width", "Height").values()
cam.execute("TriggerSoftware")

# Single frames
with open("frame.jpg", "wb") as f:
    f.write(cam.grab_jpeg(quality=90))
frame = cam.grab_raw()                         # Mono8, with width/height
pixels = frame.to_numpy()                      # (height, width) uint8

cam.disconnect()
client.close()                                 # ends the session
```

Already connected devices: `client.cameras()`, or `client.camera(id)` for a handle without a request.

### Sessions and access

A client is a session on the server: created with its first request, kept alive by a background
heartbeat thread, and ended by `client.close()` (or the `with` block). Other clients see it by
`client.session.client_id` and its `name`. If the session expires anyway (a suspended laptop),
the client starts a new one and retries the request once. `RacsClient(url, anonymous=True)` uses
no session, as clients before 0.4 did; such a client may only use `shared` devices.

```python
with RacsClient("http://localhost:8742", name="line-script") as client:
    cam = client.connect(0, mode="exclusive")  # connect and take the lease in one step
    print(cam.access())                        # mode, owner, members, holder, viewers, you
    cam["ExposureTime"] = 5000.0
    cam.take("ro-shared")                      # others may read and watch again
    cam.release()                              # shared: everyone writes
```

A device is `shared` unless a session takes its lease with `connect(mode=...)` or `take(mode)`:

* `ro-shared`: the owner writes, other sessions read and watch the live stream, a write of theirs
  raises `ReadOnlyError`.
* `exclusive`: only the owner uses the device; others get `DeviceLockedError` beyond the meta
  routes (`xml()`, `categories()`, `stream_error()`, `access()`).

Taking a lease another session holds raises `DeviceLockedError`, and `exclusive` while others use
the device raises `DeviceInUseError`; `take(mode, force=True)` takes it anyway, closes the other
clients' live streams (`AccessRevokedError`) and cancels their bursts. `cam.disconnect()` leaves
the device, which the server closes once nobody uses it (`disconnect().closed`);
`disconnect(force=True)` closes it for everyone.

Several clients may stream one camera at once: a second `cam.live()` joins the running capture,
in the pixel depth of whoever started it.

### Events

`client.events()` is a stream of what happens on the server: devices connected and disconnected,
leases taken, streams and bursts started and stopped, features written and commands executed by
any client.

```python
from racs_python import EventType

with client.events() as events:
    for event in events:                       # the first is "hello", with every device's state
        if event.type == EventType.FEATURE_CHANGED and event.by.client_id != client.session.client_id:
            print(f"{event.by.name} changed {event.feature} on device {event.device}")
```

`event.by` is None for clients without a session and for the server itself. `device_state`
events carry the device's whole state (`event.state`); a `resync` means events were lost, so read
the state again.

### Live stream

The stream holds the camera until it is closed. Features can still be read and written while it
runs; a change of size arrives as a new `stream.info` and applies to the frames after it.

```python
from itertools import islice

with cam.live(format="raw", pixel_depth="mono16", fps=10) as stream:
    for frame in islice(stream, 100):
        pixels = frame.to_numpy()              # uint16 at bit_depth > 8
        print(frame.frame_number, frame.dropped, frame.bit_depth, pixels.mean())
```

`format="zstd"` sends the same pixels losslessly compressed, about half the bytes of `raw`;
`frame.to_numpy()` and `frame.to_raw()` decode them. `format="jpeg"` (the default) delivers JPEG
files in `frame.data`. A stream that the server ends
because of an error raises `LiveStreamError`; `cam.stream_error()` reports the last one. Two
subclasses tell why another way: `SessionEndedError` (close code `4001`, the session ended) and
`AccessRevokedError` (`4003`, another session took the device `exclusive` by force).

### Packet size

Every grab, stream and burst uses the camera's stream packet size (`GevSCPSPacketSize`, bytes per
packet including IP and UDP headers) as it is. Jumbo frames such as 7960 need a link MTU of 9000.

```python
info = cam.packet_size()                       # packet_size, min/max/inc, link_mtu, interface
cam["GevSCPSPacketSize"] = 7960                # a multiple of info.inc, not above the link MTU
auto = cam.auto_packet_size()                  # the largest size whose test packets arrive
```

Both work during a live stream, which pauses briefly and carries on with the new size
(`stream.info.packet_size`).

### Burst jobs

A burst grabs up to 500 frames on the server in the background. Leaving the `with` block deletes
the job and its frames.

```python
with cam.burst(50, format="raw", pixel_depth="mono16") as job:
    for frame in job.frames():                 # yields each frame as soon as it is captured
        ...
    info = job.wait()                          # final status
```

`format="zstd"` works here too. `job.image(i)` returns the encoded bytes of one frame, `job.images()` lists what has been
captured, and `cam.job(job_id)` re-attaches to a job by id.

### Errors

Every error is a `RacsError`. HTTP errors are `RacsHttpError` (a `requests.HTTPError`) with
`status_code` and `body`; the specific ones are `CameraBusyError` (the camera is held by a stream,
burst or grab), `NotFoundError` and `ImageFailedError`. Refusals by access mode carry the parsed
body in `refusal` (`mode`, `owner`, and for a 409 `members` and `holder`): `SessionExpiredError`
(401), `ReadOnlyError` (403), `DeviceInUseError` (409) and `DeviceLockedError` (423). Feature reads
raise `FeatureError`, a failed burst `BurstJobFailedError`, a live stream or event socket closed
with an error `LiveStreamError` (`SessionEndedError`, `AccessRevokedError`).

### Low-level client

`RacsClient` maps one method onto each REST route and takes the device id every time, e.g.
`client.get_device_gc_node_value(0, "Width")` or `client.start_grab_job(0, 20, "raw")`. Values
are strings there, exactly as the server sends them. The session routes are there too
(`create_session`, `heartbeat`, `rename_session`, `end_session`, `list_sessions`), as are the
access routes (`get_device_access`, `set_device_access`, `release_device_access`).

## Tests

`client_libs/run-tests.sh python` builds the repository's fake-camera server
(`cargo run --example fake_server`), starts it with a 5 s session timeout and runs the tests
against it. `pytest` on its own
runs only the tests that need no server.
