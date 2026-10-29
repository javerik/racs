using System.Net;
using System.Text.Json;
using Racs.Dotnet;
using Racs.Dotnet.Models;

namespace Racs.Dotnet.Tests;

/// <summary>Tests that need no server.</summary>
public sealed class UnitTests
{
    [Theory]
    [InlineData("http://host:8742", "http://host:8742/api/v1/")]
    [InlineData("http://host:8742/", "http://host:8742/api/v1/")]
    [InlineData("http://host:8742/api/v1", "http://host:8742/api/v1/")]
    [InlineData("https://proxy/racs/api/v1/", "https://proxy/racs/api/v1/")]
    public void TheBaseUrlIsNormalized(string given, string expected)
    {
        Assert.Equal(expected, RacsClient.NormalizeBaseUri(given).ToString());
    }

    [Fact]
    public void AFrameMessageIsTwoLittleEndianCountersThenTheImage()
    {
        byte[] message = [1, 0, 0, 0, 2, 1, 0, 0, 0xAA, 0xBB];
        var (frameNumber, dropped, image) = LiveStream.ParseFrameMessage(message);
        Assert.Equal(1u, frameNumber);
        Assert.Equal(258u, dropped);
        Assert.Equal([0xAA, 0xBB], image);

        Assert.Throws<LiveStreamException>(() => LiveStream.ParseFrameMessage(new byte[3]));
    }

    [Fact]
    public void ImageEntriesAreToldApartByStatus()
    {
        const string json = """[{"status":"ok","index":0,"size_bytes":12},{"status":"failed","index":1,"error":"timeout"}]""";
        var entries = JsonSerializer.Deserialize<List<ImageEntryInfo>>(json, RacsClient.JsonOptions)!;
        Assert.Equal(12, Assert.IsType<ImageEntryOk>(entries[0]).SizeBytes);
        var failed = Assert.IsType<ImageEntryFailed>(entries[1]);
        Assert.Equal(1, failed.Index);
        Assert.Equal("timeout", failed.Error);
    }

    [Fact]
    public void BurstJobInfoParsesServerTimestamps()
    {
        const string json = """
            {"job_id":"27bb2837-6279-4cdc-8936-233185be172d","device_id":0,"status":"running","format":"raw",
             "requested_count":5,"captured_count":1,"failed_count":0,"created_at":"2026-10-04T09:19:08.123456789Z",
             "started_at":"2026-10-04T09:19:08.2Z","completed_at":null,"expires_at":null,"error":null,
             "width":64,"height":32,"pixel_format":"Mono8","bit_depth":8}
            """;
        var info = JsonSerializer.Deserialize<BurstJobInfo>(json, RacsClient.JsonOptions)!;
        Assert.Equal(JobStatus.Running, info.Status);
        Assert.False(info.Status.IsTerminal());
        Assert.Equal(ImageFormat.Raw, info.Format);
        Assert.Equal(2026, info.CreatedAt.Year);
        Assert.Equal(64, info.Width);
    }

    [Fact]
    public void ABurstRequestLeavesOutUnsetOptions()
    {
        var json = JsonSerializer.Serialize(new StartBurstJobRequest { Count = 3, PixelDepth = PixelDepth.Mono16 }, RacsClient.JsonOptions);
        Assert.Equal("""{"count":3,"format":"raw","pixel_depth":"mono16"}""", json);
    }

    [Fact]
    public void EnumsUseTheServersWireNames()
    {
        Assert.Equal("jpeg", RacsClient.WireName(ImageFormat.Jpeg));
        Assert.Equal("mono16", RacsClient.WireName(PixelDepth.Mono16));
        Assert.Equal("skip", RacsClient.WireName(OnFailure.Skip));
    }

    [Fact]
    public void ErrorResponsesMapToSpecificExceptions()
    {
        Assert.IsType<CameraBusyException>(RacsApiException.FromResponse(HttpStatusCode.InternalServerError, "Error: StoreError(Busy(0))", "/x"));
        Assert.IsType<RacsNotFoundException>(RacsApiException.FromResponse(HttpStatusCode.NotFound, "no job", "/x"));
        Assert.IsType<ImageFailedException>(RacsApiException.FromResponse(HttpStatusCode.Gone, "timeout", "/x"));
        var other = RacsApiException.FromResponse(HttpStatusCode.InternalServerError, "Error: NotDiscovered(9)", "/x");
        Assert.IsType<RacsApiException>(other);
        // Callers of earlier versions caught HttpRequestException; they still can.
        Assert.IsAssignableFrom<HttpRequestException>(other);
        Assert.Equal(HttpStatusCode.InternalServerError, other.StatusCode);
    }

    [Fact]
    public void RefusalsMapToTheirExceptionsWithTheParsedBody()
    {
        var readOnly = Assert.IsType<ReadOnlyException>(RacsApiException.FromResponse(HttpStatusCode.Forbidden,
            """{"error":"read_only","mode":"ro-shared","owner":{"client_id":"3f2a9c1e","name":"line-script"}}""", "/x"));
        Assert.Equal(("read_only", Mode.RoShared, "3f2a9c1e", "line-script"),
            (readOnly.Refusal!.Error, readOnly.Refusal.Mode, readOnly.Refusal.Owner!.ClientId, readOnly.Refusal.Owner.Name));

        var inUse = Assert.IsType<DeviceInUseException>(RacsApiException.FromResponse(HttpStatusCode.Conflict,
            """{"error":"device_in_use","mode":"shared","owner":null,"members":[{"client_id":"77d0aa12","name":null}],"holder":{"kind":"live","client_id":null}}""",
            "/x"));
        Assert.Equal("77d0aa12", Assert.Single(inUse.Refusal!.Members!).ClientId);
        Assert.Equal((HolderKind.Live, (string?)null), (inUse.Refusal.Holder!.Kind, inUse.Refusal.Holder.ClientId));

        var locked = Assert.IsType<DeviceLockedException>(RacsApiException.FromResponse(HttpStatusCode.Locked,
            """{"error":"device_locked","mode":"exclusive","owner":{"client_id":"3f2a9c1e","name":null}}""", "/x"));
        Assert.Equal(Mode.Exclusive, locked.Refusal!.Mode);

        var expired = Assert.IsType<SessionExpiredException>(RacsApiException.FromResponse(HttpStatusCode.Unauthorized,
            """{"error":"session_expired"}""", "/x"));
        Assert.Equal("session_expired", expired.Refusal!.Error);
        Assert.Null(expired.Refusal.Mode);

        var required = RacsApiException.FromResponse(HttpStatusCode.BadRequest, """{"error":"session_required"}""", "/x");
        Assert.IsType<RacsApiException>(required);
        Assert.Equal("session_required", required.Refusal!.Error);

        // A refused live stream has no readable body: the status alone decides, and there is no refusal.
        var noBody = Assert.IsType<DeviceLockedException>(RacsApiException.FromResponse(HttpStatusCode.Locked, "DeviceLocked { .. }", "/x"));
        Assert.Null(noBody.Refusal);
        Assert.IsAssignableFrom<HttpRequestException>(noBody);

        // The plain-text errors are unchanged.
        var busy = RacsApiException.FromResponse(HttpStatusCode.InternalServerError, "Error: StoreError(Busy(0))", "/x");
        Assert.IsType<CameraBusyException>(busy);
        Assert.Null(busy.Refusal);
        Assert.Null(RacsApiException.FromResponse(HttpStatusCode.InternalServerError, "{not json", "/x").Refusal);
    }

    [Fact]
    public void CloseCodesMapToTheirExceptions()
    {
        var ended = Assert.IsType<SessionEndedException>(LiveStreamException.FromClose(4001, "session expired"));
        Assert.Equal(("session expired", 4001), (ended.Reason, ended.CloseCode));
        var revoked = Assert.IsType<AccessRevokedException>(LiveStreamException.FromClose(4003, "access revoked"));
        Assert.Equal(4003, revoked.CloseCode);
        var failed = Assert.IsType<LiveStreamException>(LiveStreamException.FromClose(1011, ""));
        Assert.Equal(("Stream closed with code 1011.", 1011), (failed.Reason, failed.CloseCode));
    }

    [Fact]
    public void EventsAreParsedByType()
    {
        var hello = EventStream.ParseEvent("""
            {"seq":7,"time":"2026-10-08T19:30:00.123Z","type":"hello","session":{"client_id":"3f2a9c1e","timeout_s":30},
             "devices":[{"device":0,"connected":true,"access":{"mode":"ro-shared","owner":{"client_id":"3f2a9c1e","name":"a"},"members":[]},
                         "stream":{"viewers":2,"pixel_format":"Mono8","bit_depth":8},"burst":null}]}
            """u8);
        Assert.Equal((RacsEventKind.Hello, 7L, "3f2a9c1e"), (hello.Kind, hello.Seq, hello.Session!.ClientId));
        var device = Assert.Single(hello.Devices!);
        Assert.Equal((Mode.RoShared, 2, "Mono8"), (device.Access.Mode, device.Stream!.Viewers, device.Stream.PixelFormat));
        Assert.Null(hello.State);

        var state = EventStream.ParseEvent("""
            {"seq":8,"time":"2026-10-08T19:30:01.000Z","type":"device_state","device":0,"connected":false,
             "access":{"mode":"shared","owner":null,"members":[]},"stream":null,"burst":null,
             "cause":"disconnected","reason":"idle","by":null}
            """u8);
        Assert.Equal((RacsEventKind.DeviceState, "disconnected", "idle"), (state.Kind, state.Cause, state.Reason));
        Assert.Equal((0, false, Mode.Shared), (state.State!.Device, state.State.Connected, state.State.Access.Mode));

        var changed = EventStream.ParseEvent("""
            {"seq":9,"time":"2026-10-08T19:30:02.000Z","type":"feature_changed","device":0,"feature":"ExposureTime",
             "by":{"client_id":"77d0aa12","name":"line-script"}}
            """u8);
        Assert.Equal((RacsEventKind.FeatureChanged, "ExposureTime", "77d0aa12"), (changed.Kind, changed.Feature, changed.By!.ClientId));
        Assert.Equal(new DateTimeOffset(2026, 10, 8, 19, 30, 2, TimeSpan.Zero), changed.Time);

        var revoked = EventStream.ParseEvent("""{"seq":10,"time":"2026-10-08T19:30:03.000Z","type":"access_revoked","device":0,"client_id":"77d0aa12","by":null}"""u8);
        Assert.Equal((RacsEventKind.AccessRevoked, "77d0aa12"), (revoked.Kind, revoked.ClientId));
        var ended = EventStream.ParseEvent("""{"seq":11,"time":"2026-10-08T19:30:04.000Z","type":"session_ended","client_id":"77d0aa12","reason":"expired"}"""u8);
        Assert.Equal((RacsEventKind.SessionEnded, "expired"), (ended.Kind, ended.Reason));
        Assert.Equal(RacsEventKind.Resync, EventStream.ParseEvent("""{"seq":12,"time":"2026-10-08T19:30:05.000Z","type":"resync"}"""u8).Kind);

        // A type this version doesn't know passes through.
        var unknown = EventStream.ParseEvent("""{"seq":13,"time":"2026-10-08T19:30:06.000Z","type":"something_new","extra":1}"""u8);
        Assert.Equal((RacsEventKind.Unknown, "something_new"), (unknown.Kind, unknown.Type));
    }

    [Fact]
    public void AccessModelsUseTheServersWireNames()
    {
        Assert.Equal("ro-shared", RacsClient.WireName(Mode.RoShared));
        Assert.Equal("exclusive", RacsClient.WireName(Mode.Exclusive));
        const string json = """
            {"device":0,"mode":"ro-shared","owner":{"client_id":"3f2a9c1e","name":"webapp · Firefox"},
             "members":[{"client_id":"3f2a9c1e","name":"webapp · Firefox"},{"client_id":"77d0aa12","name":"line-script"}],
             "holder":{"kind":"live","client_id":"3f2a9c1e"},"viewers":2,"you":"owner"}
            """;
        var access = JsonSerializer.Deserialize<DeviceAccess>(json, RacsClient.JsonOptions)!;
        Assert.Equal((Mode.RoShared, Role.Owner, 2, 2), (access.Mode, access.You, access.Members.Count, access.Viewers));
        Assert.Equal(HolderKind.Live, access.Holder!.Kind);

        var connected = JsonSerializer.Deserialize<DeviceDiscoverInfo>(
            """{"id":0,"dev_id":"d","serial_number":"s","vendor":"v","model":"m","manufacturer_info":"i","ip":"127.0.0.1","mac":"00","access":""" + json + "}",
            RacsClient.JsonOptions)!;
        Assert.Equal(Role.Owner, connected.Access!.You);

        var result = JsonSerializer.Deserialize<DisconnectResult>("""{"closed":false,"members":1}""", RacsClient.JsonOptions)!;
        Assert.Equal((false, 1), (result.Closed, result.Members));
    }

    [Fact]
    public void ToUInt16ArrayFollowsTheBitDepth()
    {
        var eight = new Frame { Data = [1, 2, 3, 4, 5, 6], Width = 3, Height = 2 };
        Assert.Equal(new ushort[] { 1, 2, 3, 4, 5, 6 }, eight.ToUInt16Array());

        var twelve = new Frame { Data = [1, 0, 0xFF, 0x0F, 0, 1], Width = 3, Height = 1, BitDepth = 12 };
        Assert.Equal(new ushort[] { 1, 4095, 256 }, twelve.ToUInt16Array());

        Assert.Throws<InvalidOperationException>(() => new Frame { Data = [0], Width = 2, Height = 2 }.ToUInt16Array());
        Assert.Throws<InvalidOperationException>(
            () => new Frame { Data = [0xFF, 0xD8], Width = 1, Height = 1, Format = ImageFormat.Jpeg }.ToUInt16Array());
    }

    private static byte[] Zstd(params byte[] content)
    {
        using var compressor = new ZstdSharp.Compressor();
        return compressor.Wrap(content).ToArray();
    }

    private static Frame ZstdFrame(int bitDepth, params byte[] residuals) =>
        new() { Data = Zstd(residuals), Width = 2, Height = 2, BitDepth = bitDepth, Format = ImageFormat.Zstd };

    [Fact]
    public void ZstdFramesDecodeToThePixels()
    {
        // Each residual is the pixel minus the one above, wrapping; 16-bit ones are zigzagged and stored as low
        // bytes, then high bytes. Row 0: zigzag(300) = 600, zigzag(5) = 10. Row 1: -1 -> 1, +1 -> 2.
        Assert.Equal(new ushort[] { 10, 20, 13, 18 }, ZstdFrame(8, 10, 20, 3, 254).ToUInt16Array());
        Assert.Equal(new ushort[] { 300, 5, 299, 6 }, ZstdFrame(12, 88, 10, 1, 2, 2, 0, 0, 0).ToUInt16Array());
        // 65535 is -1 from 0, and 0 is +1 from 65535.
        Assert.Equal(new ushort[] { 0, 65535, 65535, 0 }, ZstdFrame(16, 0, 1, 1, 2, 0, 0, 0, 0).ToUInt16Array());
    }

    [Fact]
    public void ToRawDecodesAZstdFrame()
    {
        var frame = new Frame
        {
            Data = Zstd(88, 10, 1, 2, 2, 0, 0, 0), Width = 2, Height = 2, BitDepth = 12, Format = ImageFormat.Zstd,
            FrameNumber = 7,
        };
        var raw = frame.ToRaw();
        Assert.Equal((ImageFormat.Raw, 7u), (raw.Format, raw.FrameNumber!.Value));
        Assert.Equal(new byte[] { 0x2C, 0x01, 5, 0, 0x2B, 0x01, 6, 0 }, raw.Data);
        Assert.Same(raw, raw.ToRaw());
        Assert.Throws<InvalidOperationException>(
            () => new Frame { Data = [0xFF, 0xD8], Width = 1, Height = 1, Format = ImageFormat.Jpeg }.ToRaw());
    }

    [Fact]
    public void ABadZstdFrameIsAnInvalidOperation()
    {
        // Too many bytes for the size, too few, and not zstd at all.
        Assert.Throws<InvalidOperationException>(() => ZstdFrame(8, 1, 2, 3, 4, 5, 6).ToUInt16Array());
        Assert.Throws<InvalidOperationException>(() => ZstdFrame(8, 1, 2, 3).ToUInt16Array());
        Assert.Throws<InvalidOperationException>(
            () => new Frame { Data = [1, 2, 3, 4], Width = 2, Height = 2, Format = ImageFormat.Zstd }.ToUInt16Array());
    }
}
