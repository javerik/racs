# Racs.Dotnet

`Racs.Dotnet` is a .NET 10 client library for the Rust Camera Server API: device discovery and
connection, typed GenICam feature access, single frames, the live stream (WebSocket) and burst
jobs.

## Install

```bash
dotnet add package Racs.Dotnet
```

## Usage

A `Camera` holds the device id, so nothing else needs to pass it around:

```csharp
using Racs.Dotnet;
using Racs.Dotnet.Models;

await using var client = new RacsClient("http://localhost:8742", name: "line-script"); // "/api/v1" is added to a bare server URL

var devices = await client.GetDevicesAsync();               // network discovery
var cam = await client.ConnectAsync(devices.Available[0].Id); // or ConnectAsync(23, "192.168.0.10")

var width = await cam.GetAsync<int>("Width");
await cam.SetAsync("ExposureTime", 5000.0);
await cam.SetAsync("ReverseX", true);
var states = await cam.GetStatesAsync("Width", "Height");    // one request, with bounds and units
await cam.ExecuteAsync("TriggerSoftware");

await File.WriteAllBytesAsync("frame.jpg", await cam.GrabJpegAsync(quality: 90));
var frame = await cam.GrabRawAsync();                         // Mono8, with Width/Height

await cam.DisconnectAsync();
```

Already connected devices: `client.GetCamerasAsync()`, or `client.GetCamera(id)` for a handle without
a request.

### Live stream

The stream holds the camera until it is disposed. Features can still be read and written while it
runs; a change of size arrives as a new `live.Info` and applies to the frames after it. Several
clients (or streams) can watch one camera at once: the first stream starts the capture, the others
join it with their own format and frame rate, and the pixel depth is the first one's.

```csharp
await using var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions
{
    Format = ImageFormat.Raw,
    PixelDepth = PixelDepth.Mono16,
    Fps = 10
});

await foreach (var frame in live.ReadFramesAsync())
{
    ushort[] pixels = frame.ToUInt16Array();                  // Width*Height, row by row
    Console.WriteLine($"#{frame.FrameNumber} {frame.Width}x{frame.Height} @ {frame.BitDepth} bit");
}
```

`ImageFormat.Zstd` sends the same pixels losslessly compressed, about half the bytes of `Raw`;
`frame.ToUInt16Array()` and `frame.ToRaw()` decode them. `ImageFormat.Jpeg` (the default) delivers
JPEG files in `frame.Data`. A stream that the server ends
because of an error throws `LiveStreamException`; `cam.GetStreamErrorAsync()` reports the last one.
One ended because the client's session ended throws `SessionEndedException` (close code 4001), one
taken away by another session's forced exclusive lease `AccessRevokedException` (4003).

### Packet size

Every grab, stream and burst uses the camera's stream packet size (`GevSCPSPacketSize`, bytes per
packet including IP and UDP headers) as it is. Jumbo frames such as 7960 need a link MTU of 9000.

```csharp
var info = await cam.GetPacketSizeAsync();                    // PacketSize, Min/Max/Inc, LinkMtu, Interface
await cam.SetAsync("GevSCPSPacketSize", 7960);                // a multiple of Inc, not above the link MTU
var auto = await cam.AutoPacketSizeAsync();                   // the largest size whose test packets arrive
```

Both work during a live stream, which pauses briefly and carries on with the new size
(`live.Info.PacketSize`).

### Burst jobs

A burst grabs up to 500 frames on the server in the background. Disposing the job deletes it and
its frames.

```csharp
await using var job = await cam.StartBurstAsync(new StartBurstJobRequest
{
    Count = 50,
    Format = ImageFormat.Raw,
    PixelDepth = PixelDepth.Mono16
});

await foreach (var frame in job.ReadFramesAsync())            // each frame as soon as it is captured
{
    // ...
}

var info = await job.WaitAsync();                             // final status
```

`ImageFormat.Zstd` works here too. `job.GetImageAsync(i)` returns the encoded bytes of one frame, `job.ListImagesAsync()` lists what has
been captured, and `cam.GetBurstJob(jobId)` re-attaches to a job by id.

### Sessions and access

A `RacsClient` is a session on the server: other clients see it by its `ClientId` and `name`. The
session starts with the first request and is sent with every request. A `PeriodicTimer` heartbeat
keeps it alive while the client is idle (`heartbeat: false` turns it off; the session then ends
after its timeout, 30 s by default), and a request the server answers with `401` because the
session has ended gets a new session and is sent once more. `DisposeAsync` ends the session: its
leases are released and its live streams closed. `client.Session` holds the current session,
`client.RenameAsync(name)` renames it.

A client the server can't see as a session, as before 0.4, is created with `anonymous: true`. It
works on shared devices only and can't take a lease or read events.

A session that connects to or uses a device is a *member* of it, and `cam.DisconnectAsync()` leaves
the device: it is closed once no other session uses it (`DisconnectResult.Closed`).
`cam.DisconnectAsync(force: true)` closes it for everyone. Devices are `Mode.Shared` unless a
session takes their *lease*:

| mode | owner | other sessions | anonymous |
|---|---|---|---|
| `Shared` (default) | – | read + write | read + write |
| `RoShared` | read + write | read | XML, categories, stream error and access only |
| `Exclusive` | read + write | XML, categories, stream error and access only | the same |

```csharp
var cam = await client.ConnectAsync(0, Mode.RoShared);      // connect and take the lease in one step
var access = await cam.GetAccessAsync();                     // Mode, Owner, Members, Holder, Viewers, You
await cam.TakeAsync(Mode.Exclusive, force: true);            // evicts the other clients
await cam.ReleaseAsync();                                    // shared again
```

Taking a lease another session owns throws `DeviceLockedException`, going exclusive while others
use the device `DeviceInUseException`; `force: true` does it anyway. The lease ends when it is
released, when its session ends, when someone forces it, or when the device closes.

### Events

`client.EventsAsync()` streams what happens on the server: devices connected and disconnected,
leases, members, streams and bursts (`DeviceState`), features written and commands executed by any
client (`FeatureChanged`, `CommandExecuted`, with `By`, who did it), revoked access and ended
sessions. It needs a session.

```csharp
await foreach (var ev in client.EventsAsync(ct))
{
    if (ev.Kind == RacsEventKind.FeatureChanged && ev.By?.ClientId != client.Session?.ClientId)
        Console.WriteLine($"{ev.By} changed {ev.Feature} on device {ev.Device}");   // read it again
}
```

The first event is `Hello`, with the state of every connected device (`ev.Devices`); `Resync`
means events were lost and the state should be read again. `client.OpenEventsAsync()` returns the
socket as an `EventStream` to read with `ReadAsync()` instead.

### Errors

HTTP errors are `RacsApiException` (an `HttpRequestException`) with `StatusCode` and `Body`; the
specific ones are `CameraBusyException` (the camera is held by a stream, burst or grab),
`RacsNotFoundException` and `ImageFailedException`. The refusals of access modes carry the parsed
JSON body in `Refusal` (`Error`, `Mode`, `Owner`, `Members`, `Holder`): `ReadOnlyException` (403, a
write on a `RoShared` device by a reader), `DeviceInUseException` (409), `DeviceLockedException`
(423) and `SessionExpiredException` (401, after the automatic retry failed too). A refused live
stream has the exception but no `Refusal`, since a WebSocket upgrade's body can't be read. Feature
reads throw `FeatureException`, a failed burst `BurstJobFailedException`, a stream ended by the
server `LiveStreamException` or its subclasses `SessionEndedException` and `AccessRevokedException`.

### Low-level client

`RacsClient` maps one method onto each REST route and takes the device id every time, e.g.
`client.GetDeviceGcNodeValueAsync(0, "Width")` or `client.StartGrabJobAsync(0, request)`. The session
routes take the session id: `CreateSessionAsync`, `HeartbeatAsync`, `RenameSessionAsync`,
`EndSessionAsync`, and `GetSessionsAsync` lists every session.

## Tests

`client_libs/run-tests.sh dotnet` builds the repository's fake-camera server
(`cargo run --example fake_server`), starts it with a 5 s session timeout and runs
`client_libs/racs-dotnet.Tests` against it.
`dotnet test` on its own skips the tests that need a server.

## NuGet publishing

Create packages:

```bash
dotnet pack -c Release
```

Push package:

```bash
dotnet nuget push bin/Release/Racs.Dotnet.*.nupkg --api-key <NUGET_API_KEY> --source https://api.nuget.org/v3/index.json
```
