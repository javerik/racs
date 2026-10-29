using Racs.Dotnet;
using Racs.Dotnet.Models;

namespace Racs.Dotnet.Tests;

/// <summary>Tests against <c>examples/fake_server.rs</c>; skipped unless RACS_TEST_URL points at one.</summary>
public sealed class FakeServerTests : IAsyncLifetime
{
    // The fake server starts every camera at this size.
    private const int Width = 64;
    private const int Height = 32;

    private static readonly string? ServerUrl = Environment.GetEnvironmentVariable("RACS_TEST_URL");

    private readonly RacsClient _client = new(ServerUrl ?? "http://localhost");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Device 0. Skips the test when there is no server.</summary>
    private Camera Cam
    {
        get
        {
            Assert.SkipWhen(ServerUrl is null, "RACS_TEST_URL is not set; run client_libs/run-tests.sh");
            return _client.GetCamera(0);
        }
    }

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        if (ServerUrl is not null)
        {
            // Put device 0 back to its starting state.
            var cam = _client.GetCamera(0);
            await cam.SetAsync("Width", Width);
            await cam.SetAsync("Height", Height);
            await cam.SetAsync("ReverseX", false);
            await cam.SetAsync("GevSCPSPacketSize", 1500);
        }

        await _client.DisposeAsync();
    }

    /// <summary>Another client of the same server, with a session unless <paramref name="anonymous"/>.</summary>
    private static RacsClient NewClient(string? name = null, bool anonymous = false, bool heartbeat = true)
    {
        Assert.SkipWhen(ServerUrl is null, "RACS_TEST_URL is not set; run client_libs/run-tests.sh");
        return new RacsClient(ServerUrl!, name: name, anonymous: anonymous, heartbeat: heartbeat);
    }

    /// <summary>Reads the stream until the server ends it, and returns how.</summary>
    private static async Task<LiveStreamException> ReadUntilClosedAsync(LiveStream live)
    {
        return await Assert.ThrowsAnyAsync<LiveStreamException>(async () =>
        {
            for (var i = 0; i < 1000; i++)
            {
                if (await live.ReadAsync(Ct) is null)
                {
                    return;
                }
            }
        });
    }

    [Fact]
    public async Task ConnectedDevicesAreListed()
    {
        var cam = Cam;
        Assert.Contains(0, (await _client.GetCamerasAsync(Ct)).Select(c => c.Id));

        var info = await cam.GetInfoAsync(Ct);
        Assert.Equal(0, info.Id);
        Assert.Equal("127.0.0.1", info.Ip);
        Assert.Contains((await _client.GetDevicesAsync(Ct)).Connected, d => d.Id == 0);
    }

    [Fact]
    public async Task ABareServerUrlReachesTheApi()
    {
        _ = Cam;
        using var client = new RacsClient(ServerUrl![..^"/api/v1".Length]);
        Assert.True(await client.GetCamera(0).IsConnectedAsync(Ct));
    }

    [Fact]
    public async Task FeaturesReadAndWriteAsTypedValues()
    {
        var cam = Cam;
        Assert.Equal(Width, await cam.GetAsync<int>("Width", Ct));

        await cam.SetAsync("ExposureTime", 2500.0, Ct);
        Assert.Equal(2500.0, await cam.GetAsync<double>("ExposureTime", Ct));

        await cam.SetAsync("ReverseX", true, Ct);
        Assert.True(await cam.GetAsync<bool>("ReverseX", Ct));
        await cam.SetAsync("ReverseX", false, Ct);
        Assert.False(await cam.GetAsync<bool>("ReverseX", Ct));

        Assert.Equal("1", await cam.GetAsync("PixelFormat", Ct));
        Assert.Null(await cam.GetAsync<int?>("TriggerSoftware", Ct));
    }

    [Fact]
    public async Task FeatureStatesReportProblemsPerEntry()
    {
        var cam = Cam;
        var states = await cam.GetStatesAsync("Width", "NoSuchFeature");
        Assert.Equal(["Width", "NoSuchFeature"], states.Select(s => s.Name));
        Assert.Null(states[0].Error);
        Assert.NotNull(states[1].Error);

        var exposure = await cam.GetStateAsync("ExposureTime", Ct);
        Assert.Equal("us", exposure.Unit);
        Assert.Equal(1.0, exposure.Min);

        await Assert.ThrowsAsync<FeatureException>(() => cam.GetAsync("NoSuchFeature", Ct));
    }

    [Fact]
    public async Task FeatureInfoComesFromTheCategories()
    {
        var cam = Cam;
        Assert.Equal(GenICamNodeType.Command, (await cam.GetFeatureInfoAsync("TriggerSoftware", Ct)).NodeType);
        Assert.NotEmpty((await cam.GetFeatureInfoAsync("PixelFormat", Ct)).Enums!);
        await Assert.ThrowsAsync<FeatureException>(() => cam.GetFeatureInfoAsync("NoSuchFeature", Ct));
    }

    [Fact]
    public async Task CommandsExecute()
    {
        var cam = Cam;
        await cam.ExecuteAsync("TriggerSoftware", Ct);
        await Assert.ThrowsAnyAsync<RacsApiException>(() => cam.ExecuteAsync("Width", Ct));
    }

    [Fact]
    public async Task TheLowLevelMethodsStillTakeTheDeviceId()
    {
        _ = Cam;
        Assert.Equal(Width.ToString(), await _client.GetDeviceGcNodeValueAsync(0, "Width", Ct));
        Assert.Contains("RegisterDescription", await _client.GetDeviceXmlAsync(0, Ct));
        Assert.NotEmpty(await _client.GetDeviceGcCategoriesAsync(0, Ct));
    }

    [Fact]
    public async Task SingleFrames()
    {
        var cam = Cam;
        var jpeg = await cam.GrabJpegAsync(50, Ct);
        Assert.Equal([0xFF, 0xD8], jpeg[..2]);

        var frame = await cam.GrabRawAsync(Ct);
        Assert.Equal((Width, Height, 8), (frame.Width, frame.Height, frame.BitDepth));
        Assert.Equal(Width * Height, frame.ToUInt16Array().Length);
    }

    [Fact]
    public async Task StreamErrorWithoutAStream()
    {
        Assert.False((await Cam.GetStreamErrorAsync(Ct)).ActiveStream);
    }

    [Fact]
    public async Task LiveRawFrames()
    {
        var cam = Cam;
        var frames = new List<Frame>();
        await using (var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw }, Ct))
        {
            await foreach (var frame in live.ReadFramesAsync(Ct))
            {
                frames.Add(frame);
                if (frames.Count == 3)
                {
                    break;
                }
            }

            Assert.True((await cam.GetStreamErrorAsync(Ct)).ActiveStream);
            Assert.Equal(Width, live.Info!.Width);
            Assert.Equal(1500, live.Info.PacketSize);
        }

        Assert.Equal([0u, 1u, 2u], frames.Select(f => f.FrameNumber!.Value));
        Assert.All(frames, f => Assert.Equal(Width * Height, f.Data.Length));
    }

    [Fact]
    public async Task LiveMono16Frames()
    {
        await using var live = await Cam.OpenLiveStreamAsync(
            new LiveStreamOptions { Format = ImageFormat.Raw, PixelDepth = PixelDepth.Mono16 }, Ct);
        var frame = (await live.ReadAsync(Ct))!;
        Assert.True(frame.BitDepth > 8);
        Assert.Equal(Width * Height * 2, frame.Data.Length);
        Assert.True(frame.ToUInt16Array().Max() > 255);
    }

    /// <summary>The fake's Mono8 pattern: each pixel one more (mod 255) than its left neighbour.</summary>
    private static void AssertMono8Gradient(ushort[] pixels)
    {
        for (var row = 0; row < pixels.Length; row += Width)
        {
            for (var x = row + 1; x < row + Width; x++)
            {
                Assert.Equal((pixels[x - 1] + 1) % 255, pixels[x]);
            }
        }
    }

    [Fact]
    public async Task LiveZstdFramesDecodeToThePixels()
    {
        var frames = new List<Frame>();
        await using (var live = await Cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Zstd }, Ct))
        {
            await foreach (var frame in live.ReadFramesAsync(Ct))
            {
                frames.Add(frame);
                if (frames.Count == 5)
                {
                    break;
                }
            }

            Assert.Equal(ImageFormat.Zstd, live.Info!.Format);
        }

        Assert.Equal([0u, 1u, 2u, 3u, 4u], frames.Select(f => f.FrameNumber!.Value));
        Assert.All(frames, f =>
        {
            Assert.Equal(ImageFormat.Zstd, f.Format);
            Assert.True(f.Data.Length < Width * Height);
            AssertMono8Gradient(f.ToUInt16Array());
        });
        Assert.Equal(Width * Height, frames[0].ToRaw().Data.Length);
    }

    [Fact]
    public async Task LiveMono16ZstdFrames()
    {
        await using var live = await Cam.OpenLiveStreamAsync(
            new LiveStreamOptions { Format = ImageFormat.Zstd, PixelDepth = PixelDepth.Mono16 }, Ct);
        var frame = (await live.ReadAsync(Ct))!;
        Assert.True(frame.BitDepth > 8);
        var pixels = frame.ToUInt16Array();
        Assert.True(pixels.Max() > 255);
        // The fake's 16-bit ramp steps by 8 along a row.
        for (var x = 1; x < Width; x++)
        {
            Assert.Equal((ushort)(pixels[x - 1] + 8), pixels[x]);
        }
    }

    [Fact]
    public async Task LiveJpegFrames()
    {
        await using var live = await Cam.OpenLiveStreamAsync(new LiveStreamOptions { Fps = 20 }, Ct);
        var frame = (await live.ReadAsync(Ct))!;
        Assert.Equal(ImageFormat.Jpeg, frame.Format);
        Assert.Equal([0xFF, 0xD8], frame.Data[..2]);
    }

    [Fact]
    public async Task AWriteDuringALiveStreamResizesTheFrames()
    {
        var cam = Cam;
        await using var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw }, Ct);
        await live.ReadAsync(Ct);
        await cam.SetAsync("Width", 32, Ct);

        Frame? resized = null;
        for (var i = 0; i < 50 && resized is null; i++)
        {
            var frame = (await live.ReadAsync(Ct))!;
            if (frame.Width == 32)
            {
                resized = frame;
            }
        }

        Assert.NotNull(resized);
        Assert.Equal(32 * Height, resized.Data.Length);
    }

    [Fact]
    public async Task ThePacketSizeIsReportedAndKept()
    {
        var cam = Cam;
        var info = await cam.GetPacketSizeAsync(Ct);
        Assert.Equal((1500, 576, 9000, 4), (info.PacketSize, info.Min, info.Max, info.Inc));
        Assert.Equal("127.0.0.1", info.LocalIp);

        await cam.SetAsync("GevSCPSPacketSize", 4000, Ct);
        await cam.GrabRawAsync(Ct);
        Assert.Equal(4000, (await cam.GetPacketSizeAsync(Ct)).PacketSize);
        await Assert.ThrowsAnyAsync<RacsApiException>(() => cam.SetAsync("GevSCPSPacketSize", 4002, Ct));
    }

    [Fact]
    public async Task AutoPacketSizeDuringALiveStream()
    {
        var cam = Cam;
        await using var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw }, Ct);
        await live.ReadAsync(Ct);
        var auto = await cam.AutoPacketSizeAsync(Ct);
        Assert.True(auto.TestPackets);
        Assert.Equal((1500, 9000), (auto.Previous, auto.PacketSize));

        // Frames of the old size may still be on their way; the stream announces the new one.
        Frame? after = null;
        for (var i = 0; i < 50 && after is null; i++)
        {
            var frame = (await live.ReadAsync(Ct))!;
            if (live.Info!.PacketSize == 9000)
            {
                after = frame;
            }
        }

        Assert.NotNull(after);
        Assert.Equal(Width * Height, after.Data.Length);
    }

    [Fact]
    public async Task AGrabDuringALiveStreamIsBusy()
    {
        var cam = Cam;
        await using var live = await cam.OpenLiveStreamAsync(cancellationToken: Ct);
        await live.ReadAsync(Ct);
        await Assert.ThrowsAsync<CameraBusyException>(() => cam.GrabJpegAsync(cancellationToken: Ct));
    }

    [Fact]
    public async Task ARawBurst()
    {
        var frames = new List<Frame>();
        BurstJobInfo info;
        await using (var job = await Cam.StartBurstAsync(5, cancellationToken: Ct))
        {
            await foreach (var frame in job.ReadFramesAsync(cancellationToken: Ct))
            {
                frames.Add(frame);
            }

            info = await job.WaitAsync(cancellationToken: Ct);
        }

        Assert.Equal(JobStatus.Completed, info.Status);
        Assert.Equal(5, info.CapturedCount);
        Assert.Equal(5, frames.Count);
        Assert.All(frames, f => Assert.Equal((Width, Height, ImageFormat.Raw), (f.Width, f.Height, f.Format)));
    }

    [Fact]
    public async Task AZstdBurst()
    {
        var frames = new List<Frame>();
        await using (var job = await Cam.StartBurstAsync(new StartBurstJobRequest { Count = 3, Format = ImageFormat.Zstd }, Ct))
        {
            await foreach (var frame in job.ReadFramesAsync(cancellationToken: Ct))
            {
                frames.Add(frame);
            }

            Assert.Equal(JobStatus.Completed, (await job.WaitAsync(cancellationToken: Ct)).Status);
        }

        Assert.Equal(3, frames.Count);
        Assert.All(frames, f =>
        {
            Assert.Equal(ImageFormat.Zstd, f.Format);
            AssertMono8Gradient(f.ToUInt16Array());
        });
    }

    [Fact]
    public async Task AJpegBurst()
    {
        await using var job = await Cam.StartBurstAsync(
            new StartBurstJobRequest { Count = 2, Format = ImageFormat.Jpeg, Quality = 60 }, Ct);
        await job.WaitAsync(cancellationToken: Ct);
        Assert.Equal([0xFF, 0xD8], (await job.GetImageAsync(0, Ct))[..2]);
        Assert.All(await job.ListImagesAsync(Ct), e => Assert.IsType<ImageEntryOk>(e));
        await Assert.ThrowsAsync<RacsNotFoundException>(() => job.GetImageAsync(5, Ct));
    }

    [Fact]
    public async Task ADeletedJobIsGone()
    {
        var cam = Cam;
        var job = await cam.StartBurstAsync(1, cancellationToken: Ct);
        await job.WaitAsync(cancellationToken: Ct);
        await job.DeleteAsync(Ct);
        await Assert.ThrowsAsync<RacsNotFoundException>(() => job.GetInfoAsync(Ct));

        await using (job = await cam.StartBurstAsync(1, cancellationToken: Ct))
        {
        }

        await Assert.ThrowsAsync<RacsNotFoundException>(() => job.GetInfoAsync(Ct));
    }

    [Fact]
    public async Task ABurstOnABusyCameraFails()
    {
        var cam = Cam;
        await using var live = await cam.OpenLiveStreamAsync(cancellationToken: Ct);
        await live.ReadAsync(Ct);
        await using var job = await cam.StartBurstAsync(1, cancellationToken: Ct);
        var failed = await Assert.ThrowsAsync<BurstJobFailedException>(() => job.WaitAsync(cancellationToken: Ct));
        Assert.Contains("Busy", failed.Info.Error);
    }

    [Fact]
    public async Task Disconnect()
    {
        _ = Cam;
        // Device 1 only: a fake camera cannot be connected again once it is gone.
        var cam = _client.GetCamera(1);
        Assert.True(await cam.IsConnectedAsync(Ct));
        var result = await cam.DisconnectAsync(Ct);
        Assert.True(result.Closed);
        Assert.Equal(0, result.Members);
        Assert.False(await cam.IsConnectedAsync(Ct));
        await Assert.ThrowsAsync<RacsException>(() => cam.GetInfoAsync(Ct));
    }

    // --- MULTI-USER ---

    [Fact]
    public async Task TheClientIsASessionThatOthersSee()
    {
        _ = Cam;
        await using var client = NewClient("dotnet-test");
        Assert.Null(client.Session);
        var access = await client.GetCamera(0).ConnectAsync(cancellationToken: Ct);
        var session = Assert.IsType<SessionCreated>(client.Session);
        Assert.Equal("dotnet-test", session.Name);
        Assert.Equal(5, session.TimeoutS);
        Assert.Contains(access.Members, m => m.ClientId == session.ClientId);
        Assert.Equal(Role.Writer, access.You);

        var listed = Assert.Single(await _client.GetSessionsAsync(Ct), s => s.ClientId == session.ClientId);
        Assert.Contains(0, listed.Devices);
        await client.RenameAsync("renamed", Ct);
        Assert.Equal("renamed", (await _client.GetSessionsAsync(Ct)).Single(s => s.ClientId == session.ClientId).Name);
        Assert.Equal("renamed", client.Session!.Name);

        // The heartbeat keeps it alive past its 5 s timeout.
        await Task.Delay(TimeSpan.FromSeconds(7), Ct);
        Assert.Equal(session.ClientId, client.Session!.ClientId);
        Assert.Contains(await _client.GetSessionsAsync(Ct), s => s.ClientId == session.ClientId);

        await client.DisposeAsync();
        Assert.DoesNotContain(await _client.GetSessionsAsync(Ct), s => s.ClientId == session.ClientId);
    }

    [Fact]
    public async Task TwoClientsAndTheLockSemantics()
    {
        _ = Cam;
        await using var a = NewClient("a");
        await using var b = NewClient("b");
        using var anonymous = NewClient(anonymous: true);

        var camA = a.GetCamera(0);
        var owned = await camA.ConnectAsync(Mode.RoShared, cancellationToken: Ct);
        Assert.Equal((Mode.RoShared, Role.Owner), (owned.Mode, owned.You));
        var clientA = a.Session!.ClientId;

        // ro-shared: the other session reads but may not write.
        var camB = b.GetCamera(0);
        Assert.Equal(Width, await camB.GetAsync<int>("Width", Ct));
        Assert.Equal(Role.Reader, (await camB.GetAccessAsync(Ct)).You);
        var readOnly = await Assert.ThrowsAsync<ReadOnlyException>(() => camB.SetAsync("Width", Width, Ct));
        Assert.Equal("read_only", readOnly.Refusal!.Error);
        Assert.Equal(Mode.RoShared, readOnly.Refusal.Mode);
        Assert.Equal(clientA, readOnly.Refusal.Owner!.ClientId);
        // An anonymous client gets meta routes only.
        await Assert.ThrowsAsync<DeviceLockedException>(() => anonymous.GetCamera(0).GetAsync("Width", Ct));
        // Someone else's lease isn't taken without force.
        var locked = await Assert.ThrowsAsync<DeviceLockedException>(() => camB.TakeAsync(Mode.Exclusive, cancellationToken: Ct));
        Assert.Equal(clientA, locked.Refusal!.Owner!.ClientId);

        // Exclusive while B is a member: in use, unless forced.
        var inUse = await Assert.ThrowsAsync<DeviceInUseException>(() => camA.TakeAsync(Mode.Exclusive, cancellationToken: Ct));
        Assert.Contains(inUse.Refusal!.Members!, m => m.ClientId == b.Session!.ClientId);
        var exclusive = await camA.TakeAsync(Mode.Exclusive, force: true, Ct);
        Assert.Equal(Mode.Exclusive, exclusive.Mode);
        Assert.DoesNotContain(exclusive.Members, m => m.ClientId == b.Session!.ClientId);
        await Assert.ThrowsAsync<DeviceLockedException>(() => camB.GetAsync("Width", Ct));
        Assert.Equal(Role.Meta, (await camB.GetAccessAsync(Ct)).You);
        Assert.Equal(Width, await camA.GetAsync<int>("Width", Ct));

        // Released, the device is shared again.
        var released = await camA.ReleaseAsync(cancellationToken: Ct);
        Assert.Equal((Mode.Shared, (ClientRef?)null), (released.Mode, released.Owner));
        await camB.SetAsync("Width", Width, Ct);
        await anonymous.GetCamera(0).SetAsync("Width", Width, Ct);
    }

    [Fact]
    public async Task AForcedExclusiveLeaseRevokesAnotherClientsStream()
    {
        _ = Cam;
        await using var a = NewClient("a");
        await using var b = NewClient("b");
        await using var live = await b.GetCamera(0).OpenLiveStreamAsync(cancellationToken: Ct);
        Assert.NotNull(await live.ReadAsync(Ct));

        var camA = await a.ConnectAsync(0, cancellationToken: Ct);
        await Assert.ThrowsAsync<DeviceInUseException>(() => camA.TakeAsync(Mode.Exclusive, cancellationToken: Ct));
        await camA.TakeAsync(Mode.Exclusive, force: true, Ct);

        var ended = await ReadUntilClosedAsync(live);
        Assert.IsType<AccessRevokedException>(ended);
        Assert.Equal(4003, ended.CloseCode);
        await camA.ReleaseAsync(cancellationToken: Ct);
    }

    [Fact]
    public async Task AClientSeesTheOthersWriteAsAnEvent()
    {
        _ = Cam;
        await using var a = NewClient("watcher");
        await using var b = NewClient("writer");
        var writer = (await b.GetSessionAsync(Ct)).ClientId;

        await using var events = await a.OpenEventsAsync(Ct);
        var hello = (await events.ReadAsync(Ct))!;
        Assert.Equal(RacsEventKind.Hello, hello.Kind);
        Assert.Equal(a.Session!.ClientId, hello.Session!.ClientId);
        Assert.Contains(hello.Devices!, d => d.Device == 0 && d.Connected);

        await b.GetCamera(0).SetAsync("ReverseX", true, Ct);
        RacsEvent? changed = null;
        while (changed is null)
        {
            var ev = (await events.ReadAsync(Ct))!;
            Assert.True(ev.Seq > hello.Seq);
            if (ev.Kind == RacsEventKind.DeviceState)
            {
                Assert.Equal(0, ev.State!.Device);
            }
            else if (ev.Kind == RacsEventKind.FeatureChanged)
            {
                changed = ev;
            }
        }

        Assert.Equal((0, "ReverseX", writer), (changed.Device, changed.Feature, changed.By!.ClientId));
        Assert.Equal("writer", changed.By.Name);
    }

    [Fact]
    public async Task TwoClientsWatchOneCamera()
    {
        _ = Cam;
        await using var a = NewClient("a");
        await using var b = NewClient("b");
        await using var liveA = await a.GetCamera(0).OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw }, Ct);
        await using var liveB = await b.GetCamera(0).OpenLiveStreamAsync(cancellationToken: Ct);
        var frameA = (await liveA.ReadAsync(Ct))!;
        var frameB = (await liveB.ReadAsync(Ct))!;
        Assert.Equal((ImageFormat.Raw, Width * Height), (frameA.Format, frameA.Data.Length));
        Assert.Equal(ImageFormat.Jpeg, frameB.Format);

        var access = await a.GetCamera(0).GetAccessAsync(Ct);
        Assert.Equal(2, access.Viewers);
        Assert.Equal(HolderKind.Live, access.Holder!.Kind);
        Assert.Equal(2, (await a.GetCamera(0).GetStreamErrorAsync(Ct)).Viewers);
    }

    [Fact]
    public async Task AnExpiredSessionIsRenewedByTheNextRequest()
    {
        _ = Cam;
        await using var client = NewClient("sleepy", heartbeat: false);
        await using var watcher = NewClient("sleepy watcher", heartbeat: false);
        var cam = client.GetCamera(0);
        Assert.Equal(Width, await cam.GetAsync<int>("Width", Ct));
        var first = client.Session!.ClientId;
        var watcherFirst = (await watcher.GetSessionAsync(Ct)).ClientId;

        // No heartbeat: the sessions end after their 5 s timeout (the sweep runs every second).
        await Task.Delay(TimeSpan.FromSeconds(7), Ct);
        var sessions = await _client.GetSessionsAsync(Ct);
        Assert.DoesNotContain(sessions, s => s.ClientId == first || s.ClientId == watcherFirst);
        await Assert.ThrowsAsync<SessionExpiredException>(() => client.HeartbeatAsync(Guid.Empty, Ct));

        // The next request gets a 401, starts a new session and is sent again.
        Assert.Equal(Width, await cam.GetAsync<int>("Width", Ct));
        Assert.NotEqual(first, client.Session!.ClientId);
        Assert.Contains((await cam.GetAccessAsync(Ct)).Members, m => m.ClientId == client.Session!.ClientId);

        // So does a refused WebSocket upgrade.
        await using var events = await watcher.OpenEventsAsync(Ct);
        var hello = (await events.ReadAsync(Ct))!;
        Assert.NotEqual(watcherFirst, hello.Session!.ClientId);
        Assert.Equal(watcher.Session!.ClientId, hello.Session.ClientId);
    }

    [Fact]
    public async Task AStreamWhoseSessionEndsIsClosedWith4001()
    {
        _ = Cam;
        await using var client = NewClient("ending");
        await using var live = await client.GetCamera(0).OpenLiveStreamAsync(cancellationToken: Ct);
        Assert.NotNull(await live.ReadAsync(Ct));
        var session = client.Session!;

        await client.EndSessionAsync(session.SessionId, Ct);
        var ended = await ReadUntilClosedAsync(live);
        Assert.IsType<SessionEndedException>(ended);
        Assert.Equal(4001, ended.CloseCode);

        // The client carries on with a new session.
        Assert.Equal(Width, await client.GetCamera(0).GetAsync<int>("Width", Ct));
        Assert.NotEqual(session.ClientId, client.Session!.ClientId);
    }

    [Fact]
    public async Task AnAnonymousClientHasNoSession()
    {
        _ = Cam;
        using var anonymous = NewClient(anonymous: true);
        Assert.True(anonymous.IsAnonymous);
        Assert.Equal(Width, await anonymous.GetCamera(0).GetAsync<int>("Width", Ct));
        Assert.Null(anonymous.Session);
        Assert.Equal(Role.Writer, (await anonymous.GetCamera(0).GetAccessAsync(Ct)).You);
        await Assert.ThrowsAsync<InvalidOperationException>(() => anonymous.GetSessionAsync(Ct));
        var refused = await Assert.ThrowsAsync<RacsApiException>(() => anonymous.GetCamera(0).TakeAsync(Mode.Exclusive, cancellationToken: Ct));
        Assert.Equal((System.Net.HttpStatusCode.BadRequest, "session_required"), (refused.StatusCode, refused.Refusal!.Error));
    }
}
