using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// HTTP client for a RACS server. The methods here map one to one onto the REST routes and take the device id
/// each time. For day-to-day use, get a <see cref="Camera"/> from <see cref="GetCamera"/>, <see cref="ConnectAsync"/>
/// or <see cref="GetCamerasAsync"/> instead: it holds the id and adds typed feature access, live streaming and
/// burst jobs.
/// <para>
/// The client is a session on the server unless it is created <c>anonymous</c>: the session is started with the
/// first request, sent with every request, kept alive by a heartbeat, renewed once when the server no longer knows
/// it (a <c>401</c>), and ended by <see cref="DisposeAsync"/>. Other clients see it by its
/// <see cref="SessionCreated.ClientId"/> and <c>name</c>.
/// </para>
/// </summary>
public sealed class RacsClient : IDisposable, IAsyncDisposable
{
    private const string ApiPath = "api/v1";
    private const string SessionHeader = "X-Racs-Session";
    private static readonly TimeSpan EndSessionTimeout = TimeSpan.FromSeconds(2);

    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        AllowOutOfOrderMetadataProperties = true
    };

    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly Uri _baseUri;
    private readonly string? _name;
    private readonly bool _anonymous;
    private readonly bool _heartbeat;
    private readonly SemaphoreSlim _sessionLock = new(1, 1);
    private readonly CancellationTokenSource _closing = new();
    private volatile SessionCreated? _session;
    private Task? _heartbeatTask;
    private int _disposed;

    /// <param name="baseUrl">
    /// The API root, e.g. <c>http://localhost:8742/api/v1</c>. A bare server URL such as
    /// <c>http://localhost:8742</c> gets <c>/api/v1</c> added.
    /// </param>
    /// <param name="httpClient">A client to use instead of a new one. It is not disposed with this instance.</param>
    /// <param name="timeout">Request timeout. Defaults to 10 s for a new client; a given client keeps its own unless this is set.</param>
    /// <param name="name">The session's name other clients see, e.g. <c>line-script</c>.</param>
    /// <param name="anonymous">
    /// Use no session, as clients before 0.4 did: such a client works on <see cref="Mode.Shared"/> devices only, and
    /// can't take a lease or read events.
    /// </param>
    /// <param name="heartbeat">
    /// Keep the session alive in the background while the client is idle. Without it, the session ends after its
    /// timeout without requests; the next request then starts a new one.
    /// </param>
    public RacsClient(
        string baseUrl,
        HttpClient? httpClient = null,
        TimeSpan? timeout = null,
        string? name = null,
        bool anonymous = false,
        bool heartbeat = true)
    {
        _baseUri = NormalizeBaseUri(baseUrl);
        _name = name;
        _anonymous = anonymous;
        _heartbeat = heartbeat;

        if (httpClient is null)
        {
            _httpClient = new HttpClient { Timeout = timeout ?? TimeSpan.FromSeconds(10) };
            _ownsHttpClient = true;
        }
        else
        {
            _httpClient = httpClient;
            _ownsHttpClient = false;
            if (timeout is not null)
            {
                _httpClient.Timeout = timeout.Value;
            }
        }

        _httpClient.BaseAddress ??= _baseUri;

        if (!_httpClient.DefaultRequestHeaders.Accept.Any(x => string.Equals(x.MediaType, "application/json", StringComparison.OrdinalIgnoreCase)))
        {
            _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }
    }

    /// <summary>The API root every route is relative to, ending in a slash.</summary>
    public Uri BaseUri => _baseUri;

    /// <summary>Whether the client works without a session.</summary>
    public bool IsAnonymous => _anonymous;

    /// <summary>The current session, or null before the first request (and always for an anonymous client).</summary>
    public SessionCreated? Session => _session;

    // --- SESSION ---

    /// <summary>The client's session, started now if it has none yet. Throws for an anonymous client.</summary>
    public async Task<SessionCreated> GetSessionAsync(CancellationToken cancellationToken = default)
    {
        if (_anonymous)
        {
            throw new InvalidOperationException("An anonymous client has no session.");
        }

        return await EnsureSessionAsync(cancellationToken)
               ?? throw new ObjectDisposedException(nameof(RacsClient));
    }

    /// <summary>Renames the client's session; other clients see the new name from then on.</summary>
    public async Task RenameAsync(string? name, CancellationToken cancellationToken = default)
    {
        var session = await GetSessionAsync(cancellationToken);
        try
        {
            await RenameSessionAsync(session.SessionId, name, cancellationToken);
        }
        catch (SessionExpiredException)
        {
            await RenewSessionAsync(session.SessionId, cancellationToken);
            session = await GetSessionAsync(cancellationToken);
            await RenameSessionAsync(session.SessionId, name, cancellationToken);
        }

        _session = CopyWithName(session, name);
    }

    /// <summary>
    /// Starts a session. <see cref="RacsClient"/> does this by itself; this is the bare route. The result is not
    /// used by this client.
    /// </summary>
    /// <param name="timeoutS">Seconds without a heartbeat before it ends; the server's default if null, clamped to 5-600.</param>
    public async Task<SessionCreated> CreateSessionAsync(string? name = null, int? timeoutS = null, CancellationToken cancellationToken = default)
    {
        var content = JsonContent.Create(new { name, timeout_s = timeoutS }, options: JsonOptions);
        using var response = await SendAsync(HttpMethod.Post, "/sessions", content, cancellationToken, withSession: false);
        return await DeserializeAsync<SessionCreated>(response, cancellationToken);
    }

    /// <summary>Keeps a session alive. Throws <see cref="SessionExpiredException"/> if it has ended.</summary>
    public async Task HeartbeatAsync(Guid sessionId, CancellationToken cancellationToken = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"/sessions/{sessionId}/heartbeat", cancellationToken: cancellationToken, withSession: false);
    }

    /// <summary>Renames a session. Throws <see cref="SessionExpiredException"/> if it has ended.</summary>
    public async Task RenameSessionAsync(Guid sessionId, string? name, CancellationToken cancellationToken = default)
    {
        var content = JsonContent.Create(new { name }, options: JsonOptions);
        using var _ = await SendAsync(HttpMethod.Patch, $"/sessions/{sessionId}", content, cancellationToken, withSession: false);
    }

    /// <summary>
    /// Ends a session now: its leases are released, its live streams closed with <c>4001</c>, it leaves its devices.
    /// Succeeds for an unknown session too. Ending this client's own session doesn't stop the client: its next
    /// request starts a new one.
    /// </summary>
    public async Task EndSessionAsync(Guid sessionId, CancellationToken cancellationToken = default)
    {
        using var _ = await SendAsync(HttpMethod.Delete, $"/sessions/{sessionId}", cancellationToken: cancellationToken, withSession: false);
    }

    /// <summary>Every session on the server, with the devices it uses and owns (never with a session id).</summary>
    public async Task<IReadOnlyList<SessionInfo>> GetSessionsAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, "/sessions", cancellationToken: cancellationToken);
        return await DeserializeAsync<List<SessionInfo>>(response, cancellationToken);
    }

    // --- EVENTS ---

    /// <summary>
    /// Opens the events socket: what happens on the server, starting with <see cref="RacsEventKind.Hello"/>. Needs a
    /// session; an anonymous client gets a <see cref="RacsApiException"/> (400).
    /// </summary>
    public async Task<EventStream> OpenEventsAsync(CancellationToken cancellationToken = default) =>
        new(await OpenWebSocketAsync("events", "", null, cancellationToken));

    /// <summary>
    /// The server's events until the socket closes or <paramref name="cancellationToken"/> is cancelled:
    /// <code>
    /// await foreach (var ev in client.EventsAsync(ct))
    ///     if (ev.Kind == RacsEventKind.FeatureChanged) ...
    /// </code>
    /// </summary>
    public async IAsyncEnumerable<RacsEvent> EventsAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await using var events = await OpenEventsAsync(cancellationToken);
        await foreach (var ev in events.ReadEventsAsync(cancellationToken))
        {
            yield return ev;
        }
    }

    // --- CAMERA HANDLES ---

    /// <summary>A handle for device <paramref name="deviceId"/>. Makes no request; the device need not be connected yet.</summary>
    public Camera GetCamera(int deviceId)
    {
        ValidateDeviceId(deviceId);
        return new Camera(this, deviceId);
    }

    /// <summary>
    /// Connects device <paramref name="deviceId"/> (by discovery, or at <paramref name="ipAddress"/>) and returns its
    /// handle. The client joins the device in its current mode.
    /// </summary>
    public async Task<Camera> ConnectAsync(int deviceId, string? ipAddress = null, CancellationToken cancellationToken = default)
    {
        await ConnectDeviceAsync(deviceId, null, ipAddress, cancellationToken);
        return GetCamera(deviceId);
    }

    /// <summary>
    /// Connects device <paramref name="deviceId"/> and takes its lease in <paramref name="mode"/> in one step. Throws
    /// <see cref="DeviceLockedException"/> when another session owns it and <see cref="DeviceInUseException"/> for
    /// <see cref="Mode.Exclusive"/> while others use it.
    /// </summary>
    public async Task<Camera> ConnectAsync(int deviceId, Mode mode, string? ipAddress = null, CancellationToken cancellationToken = default)
    {
        await ConnectDeviceAsync(deviceId, mode, ipAddress, cancellationToken);
        return GetCamera(deviceId);
    }

    /// <summary>Handles for every device the server is connected to.</summary>
    public async Task<IReadOnlyList<Camera>> GetCamerasAsync(CancellationToken cancellationToken = default)
    {
        var devices = await GetConnectedDevicesAsync(cancellationToken);
        return devices.Select(d => new Camera(this, d.Id)).ToList();
    }

    // --- DEVICES ---

    public async Task<DeviceConnections> GetDevicesAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, "/devices", cancellationToken: cancellationToken);
        return await DeserializeAsync<DeviceConnections>(response, cancellationToken);
    }

    public async Task<IReadOnlyList<DeviceDiscoverInfo>> GetConnectedDevicesAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, "/devices/connected", cancellationToken: cancellationToken);
        return await DeserializeAsync<List<DeviceDiscoverInfo>>(response, cancellationToken);
    }

    public Task<DeviceAccess> ConnectDeviceAsync(int deviceId, CancellationToken cancellationToken = default) =>
        ConnectDeviceAsync(deviceId, null, null, cancellationToken);

    public Task<DeviceAccess> ConnectDeviceByIpAsync(int deviceId, string ipAddress, CancellationToken cancellationToken = default)
    {
        ValidateIpAddress(ipAddress);
        return ConnectDeviceAsync(deviceId, null, ipAddress, cancellationToken);
    }

    /// <summary>
    /// Connects a device, by discovery or at <paramref name="ipAddress"/>. With <paramref name="mode"/> it takes the
    /// device's lease in the same step (needs a session); without, the client joins in the current mode.
    /// </summary>
    public async Task<DeviceAccess> ConnectDeviceAsync(int deviceId, Mode? mode, string? ipAddress = null, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        var query = new List<string>();
        if (ipAddress is not null)
        {
            ValidateIpAddress(ipAddress);
            query.Add($"ip={Uri.EscapeDataString(ipAddress)}");
        }

        if (mode is { } m)
        {
            query.Add($"mode={WireName(m)}");
        }

        var endpoint = $"/devices/{deviceId}/connect" + (query.Count > 0 ? "?" + string.Join('&', query) : "");
        using var response = await SendAsync(HttpMethod.Put, endpoint, cancellationToken: cancellationToken);
        return await DeserializeAsync<DeviceAccess>(response, cancellationToken);
    }

    /// <summary>
    /// Leaves the device; it is closed once no other session uses it (an anonymous client closes it unless a
    /// session uses it).
    /// </summary>
    public Task<DisconnectResult> DisconnectDeviceAsync(int deviceId, CancellationToken cancellationToken = default) =>
        DisconnectDeviceAsync(deviceId, false, cancellationToken);

    /// <summary>With <paramref name="force"/> the device is closed for everyone, which needs write permission.</summary>
    public async Task<DisconnectResult> DisconnectDeviceAsync(int deviceId, bool force, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        var endpoint = $"/devices/{deviceId}/disconnect" + (force ? "?force=true" : "");
        using var response = await SendAsync(HttpMethod.Put, endpoint, cancellationToken: cancellationToken);
        return await DeserializeAsync<DisconnectResult>(response, cancellationToken);
    }

    // --- ACCESS ---

    /// <summary>The device's mode, owner, members, holder and viewers, and this client's role. Doesn't open the camera.</summary>
    public async Task<DeviceAccess> GetDeviceAccessAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/access", cancellationToken: cancellationToken);
        return await DeserializeAsync<DeviceAccess>(response, cancellationToken);
    }

    /// <summary>
    /// Takes or changes the device's lease (<see cref="Mode.Shared"/> gives it up). Needs a session. Without
    /// <paramref name="force"/>, a lease another session owns is <see cref="DeviceLockedException"/>, and
    /// <see cref="Mode.Exclusive"/> while others use the device <see cref="DeviceInUseException"/>. With it, the lease is
    /// taken anyway and <see cref="Mode.Exclusive"/> evicts the other clients.
    /// </summary>
    public async Task<DeviceAccess> SetDeviceAccessAsync(int deviceId, Mode mode, bool force = false, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        var content = JsonContent.Create(new { mode, force }, options: JsonOptions);
        using var response = await SendAsync(HttpMethod.Put, $"/devices/{deviceId}/access", content, cancellationToken);
        return await DeserializeAsync<DeviceAccess>(response, cancellationToken);
    }

    /// <summary>Gives up the device's lease, or with <paramref name="force"/> breaks another session's. The mode returns to shared.</summary>
    public async Task<DeviceAccess> ReleaseDeviceAccessAsync(int deviceId, bool force = false, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        var endpoint = $"/devices/{deviceId}/access" + (force ? "?force=true" : "");
        using var response = await SendAsync(HttpMethod.Delete, endpoint, cancellationToken: cancellationToken);
        return await DeserializeAsync<DeviceAccess>(response, cancellationToken);
    }

    public async Task<string> GetDeviceXmlAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/xml", cancellationToken: cancellationToken);
        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    // --- GENICAM ---

    public async Task<IReadOnlyList<GenICamNodeCategory>> GetDeviceGcCategoriesAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/gc/categories", cancellationToken: cancellationToken);
        var categories = await DeserializeAsync<List<GenICamNodeCategory>>(response, cancellationToken);
        return categories;
    }

    public async Task<string> GetDeviceGcNodeValueAsync(int deviceId, string featureName, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        ValidateFeatureName(featureName);

        var encodedFeatureName = Uri.EscapeDataString(featureName);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/gc/feature/{encodedFeatureName}", cancellationToken: cancellationToken);
        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    public async Task SetDeviceGcNodeValueAsync(int deviceId, string featureName, string value, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        ValidateFeatureName(featureName);

        if (value is null)
        {
            throw new ArgumentNullException(nameof(value));
        }

        var encodedFeatureName = Uri.EscapeDataString(featureName);
        var encodedValue = Uri.EscapeDataString(value);
        using var _ = await SendAsync(HttpMethod.Put, $"/devices/{deviceId}/gc/feature/{encodedFeatureName}?value={encodedValue}", cancellationToken: cancellationToken);
    }

    /// <summary>
    /// The live state of 1 to 256 features in one request, in the order asked. A problem with one feature is
    /// reported in that entry's <see cref="FeatureState.Error"/>.
    /// </summary>
    public async Task<IReadOnlyList<FeatureState>> GetDeviceGcFeatureStatesAsync(int deviceId, IEnumerable<string> featureNames, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        ArgumentNullException.ThrowIfNull(featureNames);

        var content = JsonContent.Create(new { names = featureNames.ToList() }, options: JsonOptions);
        using var response = await SendAsync(HttpMethod.Post, $"/devices/{deviceId}/gc/features/state", content, cancellationToken);
        return await DeserializeAsync<List<FeatureState>>(response, cancellationToken);
    }

    /// <summary>Executes a GenICam command feature such as <c>TriggerSoftware</c>.</summary>
    public async Task ExecuteDeviceGcCommandAsync(int deviceId, string commandName, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        ValidateFeatureName(commandName);

        var encodedCommandName = Uri.EscapeDataString(commandName);
        using var _ = await SendAsync(HttpMethod.Post, $"/devices/{deviceId}/gc/command/{encodedCommandName}", cancellationToken: cancellationToken);
    }

    // --- FRAMES AND STREAMS ---

    public async Task<byte[]> GrabJpgFrameAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/stream/frame/jpeg", cancellationToken: cancellationToken);
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    /// <summary>Grabs one Mono8 frame as JPEG at <paramref name="quality"/> (1-100).</summary>
    public async Task<byte[]> GrabJpgFrameAsync(int deviceId, int quality, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/stream/frame/jpeg?quality={quality}", cancellationToken: cancellationToken);
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    public async Task<byte[]> GrabRawFrameAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/stream/frame/raw", cancellationToken: cancellationToken);
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    /// <summary>Why the last live stream on the device ended, and whether one runs now.</summary>
    public async Task<StreamErrorInfo> GetStreamErrorAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/stream/error", cancellationToken: cancellationToken);
        return await DeserializeAsync<StreamErrorInfo>(response, cancellationToken);
    }

    /// <summary>
    /// The stream packet size (GevSCPSPacketSize), its bounds and the link MTU. Set it with
    /// <c>SetDeviceGcNodeValueAsync(id, "GevSCPSPacketSize", ...)</c>.
    /// </summary>
    public async Task<PacketSizeInfo> GetPacketSizeAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/stream/packet-size", cancellationToken: cancellationToken);
        return await DeserializeAsync<PacketSizeInfo>(response, cancellationToken);
    }

    /// <summary>
    /// Finds the largest packet size that reaches the server, with test packets, and sets it. Works during a live
    /// stream too, which carries on with the new size.
    /// </summary>
    public async Task<AutoPacketSize> AutoPacketSizeAsync(int deviceId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Post, $"/devices/{deviceId}/stream/packet-size/auto", cancellationToken: cancellationToken);
        return await DeserializeAsync<AutoPacketSize>(response, cancellationToken);
    }

    /// <summary>
    /// Opens the live-stream WebSocket: starts the device's capture (needs write permission) or joins the running
    /// one (read permission). The camera is held until the device's last stream is disposed.
    /// </summary>
    public Task<LiveStream> OpenLiveStreamAsync(int deviceId, LiveStreamOptions? options = null, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        options ??= new LiveStreamOptions();

        var query = new List<string> { $"format={WireName(options.Format)}" };
        if (options.PixelDepth is { } depth)
        {
            query.Add($"pixel_depth={WireName(depth)}");
        }

        if (options.Quality is { } quality)
        {
            query.Add($"quality={quality.ToString(CultureInfo.InvariantCulture)}");
        }

        if (options.Fps is { } fps)
        {
            query.Add($"fps={fps.ToString(CultureInfo.InvariantCulture)}");
        }

        return LiveStream.ConnectAsync(this, deviceId, string.Join('&', query), options.ReceiveTimeout, cancellationToken);
    }

    // --- BURST JOBS ---

    /// <summary>
    /// Starts a background burst. Returns before the capture starts: a busy camera shows up as a job that fails.
    /// </summary>
    public async Task<BurstJobCreated> StartGrabJobAsync(int deviceId, StartBurstJobRequest request, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        ArgumentNullException.ThrowIfNull(request);

        var content = JsonContent.Create(request, options: JsonOptions);
        using var response = await SendAsync(HttpMethod.Post, $"/devices/{deviceId}/grab/jobs", content, cancellationToken);
        return await DeserializeAsync<BurstJobCreated>(response, cancellationToken);
    }

    public async Task<BurstJobInfo> GetGrabJobAsync(int deviceId, Guid jobId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/grab/jobs/{jobId}", cancellationToken: cancellationToken);
        return await DeserializeAsync<BurstJobInfo>(response, cancellationToken);
    }

    /// <summary>The frames a burst job has attempted so far, in capture order.</summary>
    public async Task<IReadOnlyList<ImageEntryInfo>> ListGrabJobImagesAsync(int deviceId, Guid jobId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/grab/jobs/{jobId}/images", cancellationToken: cancellationToken);
        return await DeserializeAsync<List<ImageEntryInfo>>(response, cancellationToken);
    }

    /// <summary>
    /// One captured frame in the job's format. Throws <see cref="RacsNotFoundException"/> for an index not captured
    /// (yet) and <see cref="ImageFailedException"/> for one that failed.
    /// </summary>
    public async Task<byte[]> GetGrabJobImageAsync(int deviceId, Guid jobId, int index, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var response = await SendAsync(HttpMethod.Get, $"/devices/{deviceId}/grab/jobs/{jobId}/images/{index}", cancellationToken: cancellationToken);
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    /// <summary>Cancels a running burst job or discards a finished one, with its images.</summary>
    public async Task DeleteGrabJobAsync(int deviceId, Guid jobId, CancellationToken cancellationToken = default)
    {
        ValidateDeviceId(deviceId);
        using var _ = await SendAsync(HttpMethod.Delete, $"/devices/{deviceId}/grab/jobs/{jobId}", cancellationToken: cancellationToken);
    }

    /// <summary>Stops the heartbeat and ends the session (best effort, waiting up to 2 s), then releases the HTTP client.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _closing.Cancel();
        if (_session is { } session)
        {
            try
            {
                // Off the caller's synchronization context, so a UI thread can't deadlock on it.
                Task.Run(() => EndSessionQuietlyAsync(session)).Wait(EndSessionTimeout);
            }
            catch (AggregateException)
            {
            }
        }

        Release();
    }

    /// <summary>Stops the heartbeat and ends the session, then releases the HTTP client.</summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _closing.Cancel();
        if (_heartbeatTask is { } heartbeat)
        {
            await heartbeat;
        }

        if (_session is { } session)
        {
            await EndSessionQuietlyAsync(session);
        }

        Release();
    }

    private void Release()
    {
        _session = null;
        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }

    private async Task EndSessionQuietlyAsync(SessionCreated session)
    {
        using var timeout = new CancellationTokenSource(EndSessionTimeout);
        try
        {
            await EndSessionAsync(session.SessionId, timeout.Token);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException)
        {
            // The server times the session out by itself.
        }
    }

    // --- SESSION HELPERS ---

    /// <summary>The session to send, started if there is none yet; null for an anonymous or disposed client.</summary>
    private async Task<SessionCreated?> EnsureSessionAsync(CancellationToken cancellationToken)
    {
        if (_anonymous || Volatile.Read(ref _disposed) != 0)
        {
            return null;
        }

        if (_session is { } session)
        {
            return session;
        }

        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            return _session ??= await StartSessionAsync(cancellationToken);
        }
        finally
        {
            _sessionLock.Release();
        }
    }

    /// <summary>Replaces <paramref name="stale"/> with a new session, unless another caller did already.</summary>
    private async Task RenewSessionAsync(Guid stale, CancellationToken cancellationToken)
    {
        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            if (_session is null || _session.SessionId == stale)
            {
                _session = await StartSessionAsync(cancellationToken);
            }
        }
        finally
        {
            _sessionLock.Release();
        }
    }

    // Called under _sessionLock.
    private async Task<SessionCreated> StartSessionAsync(CancellationToken cancellationToken)
    {
        var session = await CreateSessionAsync(_name, null, cancellationToken);
        if (_heartbeat && _heartbeatTask is null)
        {
            var period = HeartbeatPeriod(session);
            _heartbeatTask = Task.Run(() => HeartbeatLoopAsync(period, _closing.Token));
        }

        return session;
    }

    private async Task HeartbeatLoopAsync(TimeSpan period, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(period);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                if (_session is not { } session)
                {
                    continue;
                }

                try
                {
                    await HeartbeatAsync(session.SessionId, cancellationToken);
                }
                catch (SessionExpiredException)
                {
                    await RenewSessionAsync(session.SessionId, cancellationToken);
                    timer.Period = HeartbeatPeriod(_session);
                }
                catch (HttpRequestException)
                {
                    // The server is unreachable for now; the next tick tries again.
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // A request timeout.
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (ObjectDisposedException)
        {
            // Disposed without waiting for the loop.
        }
    }

    private static TimeSpan HeartbeatPeriod(SessionCreated? session) =>
        TimeSpan.FromSeconds(Math.Max(1, session?.HeartbeatIntervalS ?? 10));

    private static SessionCreated CopyWithName(SessionCreated session, string? name) => new()
    {
        SessionId = session.SessionId,
        ClientId = session.ClientId,
        Name = name,
        TimeoutS = session.TimeoutS,
        HeartbeatIntervalS = session.HeartbeatIntervalS
    };

    /// <summary>
    /// Opens a WebSocket at <paramref name="path"/> with the session as <c>?session=</c>, renewing the session once
    /// after a <c>401</c>. A refused live stream is reported with the reason the server recorded for
    /// <paramref name="deviceId"/>, since the upgrade's body can't be read.
    /// </summary>
    internal async Task<ClientWebSocket> OpenWebSocketAsync(string path, string query, int? deviceId, CancellationToken cancellationToken)
    {
        for (var retried = false; ; retried = true)
        {
            var session = await EnsureSessionAsync(cancellationToken);
            var parts = new List<string>();
            if (query.Length > 0)
            {
                parts.Add(query);
            }

            if (session is not null)
            {
                parts.Add($"session={session.SessionId}");
            }

            var uri = new UriBuilder(new Uri(_baseUri, path))
            {
                Scheme = _baseUri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
                Query = string.Join('&', parts)
            }.Uri;

            var socket = new ClientWebSocket();
            socket.Options.CollectHttpResponseDetails = true;
            try
            {
                await socket.ConnectAsync(uri, cancellationToken);
                return socket;
            }
            catch (WebSocketException e) when (socket.HttpStatusCode != 0)
            {
                var status = socket.HttpStatusCode;
                socket.Dispose();
                if (status == HttpStatusCode.Unauthorized && session is not null && !retried)
                {
                    await RenewSessionAsync(session.SessionId, cancellationToken);
                    continue;
                }

                var reason = e.Message;
                if (deviceId is { } id && status != HttpStatusCode.Unauthorized)
                {
                    reason = (await GetStreamErrorAsync(id, cancellationToken)).LastError ?? reason;
                }

                // The path only: the query carries the secret session id.
                throw RacsApiException.FromResponse(status, reason, uri.AbsolutePath);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
    }

    // --- HELPERS ---

    internal static Uri NormalizeBaseUri(string baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new ArgumentException("Base URL must not be empty.", nameof(baseUrl));
        }

        var normalizedBaseUrl = baseUrl.TrimEnd('/') + "/";
        var uri = new Uri(normalizedBaseUrl, UriKind.Absolute);
        return uri.AbsolutePath == "/" ? new Uri(uri, ApiPath + "/") : uri;
    }

    internal static string WireName<T>(T value) where T : struct, Enum =>
        JsonSerializer.Serialize(value, JsonOptions).Trim('"');

    /// <summary>
    /// Sends a request with the session header (unless <paramref name="withSession"/> is false, as for the session
    /// routes), renews the session once after a <c>401</c>, and turns an error status into its exception.
    /// </summary>
    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string endpoint,
        HttpContent? content = null,
        CancellationToken cancellationToken = default,
        bool withSession = true)
    {
        var requestUri = new Uri(_baseUri, endpoint.TrimStart('/'));
        try
        {
            var session = withSession ? await EnsureSessionAsync(cancellationToken) : null;
            var response = await SendOnceAsync(method, requestUri, content, session, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Unauthorized && session is not null)
            {
                response.Dispose();
                await RenewSessionAsync(session.SessionId, cancellationToken);
                session = await EnsureSessionAsync(cancellationToken);
                response = await SendOnceAsync(method, requestUri, content, session, cancellationToken);
            }

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                response.Dispose();
                throw RacsApiException.FromResponse(response.StatusCode, body, endpoint);
            }

            return response;
        }
        finally
        {
            content?.Dispose();
        }
    }

    private async Task<HttpResponseMessage> SendOnceAsync(
        HttpMethod method, Uri requestUri, HttpContent? content, SessionCreated? session, CancellationToken cancellationToken)
    {
        // Not disposed here: that would dispose the content, which a retry sends again.
        var request = new HttpRequestMessage(method, requestUri) { Content = content };
        if (session is not null)
        {
            // Per request rather than on DefaultRequestHeaders, which a caller's HttpClient shares.
            request.Headers.Add(SessionHeader, session.SessionId.ToString());
        }

        return await _httpClient.SendAsync(request, cancellationToken);
    }

    private static async Task<T> DeserializeAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var payload = await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, cancellationToken);

        return payload ?? throw new InvalidOperationException("API response was empty or could not be deserialized.");
    }

    private static void ValidateDeviceId(int deviceId)
    {
        if (deviceId < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(deviceId), "Device id must be >= 0.");
        }
    }

    private static void ValidateFeatureName(string featureName)
    {
        if (string.IsNullOrWhiteSpace(featureName))
        {
            throw new ArgumentException("Feature name must not be empty.", nameof(featureName));
        }
    }

    private static void ValidateIpAddress(string ipAddress)
    {
        if (string.IsNullOrWhiteSpace(ipAddress))
        {
            throw new ArgumentException("IP address must not be empty.", nameof(ipAddress));
        }
    }
}
