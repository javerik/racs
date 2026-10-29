# racs-client

Async Rust client for the [racs-api server](https://codeberg.org/javerik/RACS-RustAravisCamServe):
device discovery and connection, typed GenICam feature access, single frames, the live stream
(WebSocket) and burst jobs. Built on `reqwest`, `tokio-tungstenite` and `tokio`.

## Install

```toml
[dependencies]
racs-client = "0.3"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

RACS speaks plain HTTP. For a server behind an `https://` reverse proxy, enable the `tls` feature.

## Usage

A `Camera` holds the device id, so nothing else needs to pass it around:

```rust
use racs_client::{RacsClient, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let client = RacsClient::new("http://localhost:8742")?;   // "/api/v1" is added to a bare URL

    let devices = client.get_devices().await?;                 // network discovery
    let cam = client.connect(devices.available[0].id, None).await?; // or connect(5, Some("192.168.0.10"))

    let width: u32 = cam.get("Width").await?;                  // typed by what you ask for
    cam.set("ExposureTime", 5000.0).await?;
    cam.set("ReverseX", true).await?;
    let states = cam.states(["Width", "Height"]).await?;       // one request, with bounds and units
    cam.execute("TriggerSoftware").await?;

    std::fs::write("frame.jpg", cam.grab_jpeg(Some(90)).await?).unwrap();
    let frame = cam.grab_raw().await?;                         // Mono8, with width/height

    cam.disconnect().await?;                                   // leaves; closes it if nobody else uses it
    client.close().await                                       // ends the session
}
```

`cam.get::<T>()` reads integers, floats, `bool`, `String`, or `FeatureValue` for whatever the
feature is; `Option<T>` gives `None` for a command or an unavailable feature. Already connected
devices: `client.cameras()`, or `client.camera(id)` for a handle without a request.

### Live stream

The stream holds the camera until it is closed (or dropped). Features can still be read and written
while it runs; a change of size arrives as a new `live.info()` and applies to the frames after it.

```rust
use racs_client::{LiveOptions, PixelDepth};

let mut live = cam.live(&LiveOptions::raw().pixel_depth(PixelDepth::Mono16).fps(10.0)).await?;
while let Some(frame) = live.next_frame().await? {
    let pixels: Vec<u16> = frame.to_u16()?;                    // width*height, row by row
    println!("#{:?} {}x{} at {} bit", frame.frame_number, frame.width, frame.height, frame.bit_depth);
}
live.close().await?;
```

`LiveOptions::zstd()` sends the same pixels losslessly compressed, about half the bytes of raw;
`frame.to_u16()` and `frame.to_raw()` decode them. `LiveOptions::jpeg()` (the server's default)
delivers JPEG files in `frame.data`.
`live.into_frames()` turns the stream into a `futures::Stream`. A stream the server ends because of
an error returns `Error::LiveStream`; `cam.stream_error()` reports the last one.

### Packet size

Every grab, stream and burst uses the camera's stream packet size (`GevSCPSPacketSize`, bytes per
packet including IP and UDP headers) as it is. Jumbo frames such as 7960 need a link MTU of 9000.

```rust
let info = cam.packet_size().await?;                           // packet_size, min/max/inc, link_mtu, interface
cam.set("GevSCPSPacketSize", 7960).await?;                     // a multiple of inc, not above the link MTU
let auto = cam.auto_packet_size().await?;                      // the largest size whose test packets arrive
```

Both work during a live stream, which pauses briefly and carries on with the new size
(`live.info().packet_size`).

### Burst jobs

A burst grabs up to 500 frames on the server in the background. There is no async drop, so delete
a job when done with it (finished jobs expire after 10 minutes anyway).

```rust
use futures_util::TryStreamExt;
use racs_client::BurstRequest;

let job = cam.burst(&BurstRequest::new(50).pixel_depth(PixelDepth::Mono16)).await?;
let frames: Vec<_> = job.frames().try_collect().await?;     // each frame as soon as it is captured
let info = job.wait().await?;                                // final status
job.delete().await?;
```

`.format(ImageFormat::Zstd)` works here too. `job.image(i)` returns the encoded bytes of one frame,
`job.images()` lists what has been captured,
and `cam.job(job_id)` re-attaches to a job by id.

### Sessions and access

Several clients can use one server. The client identifies itself with a **session**, created with
its first request and sent with every request after it (`X-Racs-Session`, `?session=` on
WebSockets). Other clients see it by its `client_id` and name. A session that sends nothing for
its timeout (the server's `--session-timeout`, 30 s by default) ends, so spawn `keep_alive()` in a
client that may go quiet while it holds a device. A request whose session has expired starts a new
one and is sent again. `close()` ends the session.

```rust
use racs_client::{Error, Mode, RacsClient};

let client = RacsClient::builder("http://localhost:8742").name("line-script").build()?;
tokio::spawn(client.clone().keep_alive());              // heartbeats until close()
println!("{:?}", client.start_session().await?);        // client_id, timeout_s, ...

let cam = client.camera(0);
cam.connect_as(Mode::RoShared, None).await?;            // connect and take the lease: only we write
let access = cam.access().await?;                       // mode, owner, members, holder, viewers, you
match cam.take(Mode::Exclusive, false).await {          // only we use the device
    Err(Error::DeviceInUse(e)) => println!("in use by {:?}", e.refusal().map(|r| r.members)),
    other => { other?; }
}
cam.take(Mode::Exclusive, true).await?;                 // force: evicts the others
cam.release(false).await?;                              // shared again
cam.disconnect().await?;                                // {closed, members}
client.close().await?;
```

| mode | the owner | other sessions | anonymous clients |
|---|---|---|---|
| `Shared` (default) | – | read + write | read + write |
| `RoShared` | read + write | read | meta |
| `Exclusive` | read + write | meta | meta |

The lease ends when its owner releases it or closes its session, when someone forces it, or when
the device closes. `force` on `take` takes another session's lease; for `Exclusive` it also ends
the other clients' live streams (`Error::AccessRevoked`) and cancels their bursts.
`cam.force_disconnect()` closes the device for everyone. A client built with
`RacsClient::builder(url).anonymous()` sends no session, as before 0.4: it can use `shared`
devices only and can't take a lease.

### Events

`client.events()` is a WebSocket of what happens on the server, as a `Stream` of typed `Event`s:
`Hello` first (this client and every connected device), then `DeviceState` (a device connected,
disconnected, its lease or members changed, a stream or burst started or stopped),
`FeatureChanged` and `CommandExecuted` (with `by`, the client that did it; read again what you
show), `AccessRevoked`, `SessionEnded` and `Resync` (events were lost: read the state again).

```rust
use futures_util::StreamExt;
use racs_client::models::EventKind;

let mut events = client.events().await?;
while let Some(event) = events.next().await {
    if let EventKind::FeatureChanged { device, feature, by } = event?.kind {
        println!("{feature} on device {device} changed by {by:?}");
    }
}
```

### Errors

`racs_client::Error` has a variant per case: `CameraBusy` (the camera is held by a stream, burst or
grab), `NotFound`, `ImageFailed` and `Api` for error responses (with status and body), `Feature`
for a failed read or a type mismatch, `BurstJobFailed`, `LiveStream` and `Timeout`.

The refusals of a device's access mode have their own: `ReadOnly` (403, a write on a `ro-shared`
device you don't own), `DeviceInUse` (409, going exclusive while others use the device),
`DeviceLocked` (423, the device is another session's) and `SessionExpired` (401, after the retry
with a new session failed too). `error.refusal()` parses their body: the device's `mode`, its
`owner`, and for `DeviceInUse` the other `members` and the `holder`. A live stream or the events
socket ends with `SessionEnded` when the session ended (close code `4001`) and with
`AccessRevoked` when another session forced the device `exclusive` (`4003`).

### Low-level client

`RacsClient` maps one method onto each REST route and takes the device id every time, e.g.
`client.get_device_gc_node_value(0, "Width")`, `client.start_grab_job(0, &request)` or
`client.set_device_access(0, Mode::RoShared, false)`. The session routes are there too
(`create_session`, `heartbeat`, `rename_session`, `end_session`, `list_sessions`).

`cargo run --example tour -- http://localhost:8742 0` walks through all of it.

## Tests

`client_libs/run-tests.sh rust` builds the repository's fake-camera server
(`cargo run --example fake_server`), starts it and runs the tests against it. `cargo test` on its
own runs the unit tests; the server tests return early without `RACS_TEST_URL`.
