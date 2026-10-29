using System.Globalization;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// One device on a RACS server. Every call goes to the server; the handle only holds the id. Get one from
/// <see cref="RacsClient.GetCamera"/>, <see cref="RacsClient.ConnectAsync"/> or <see cref="RacsClient.GetCamerasAsync"/>:
/// <code>
/// var cam = await client.ConnectAsync(0);
/// await cam.SetAsync("ExposureTime", 5000);
/// var width = await cam.GetAsync&lt;int&gt;("Width");
/// </code>
/// </summary>
public sealed class Camera
{
    private IReadOnlyList<GenICamNodeCategory>? _categories;

    internal Camera(RacsClient client, int id)
    {
        Client = client;
        Id = id;
    }

    public RacsClient Client { get; }

    public int Id { get; }

    public override string ToString() => $"Camera({Id} at {Client.BaseUri})";

    // --- CONNECTION ---

    /// <summary>The device's identity as the server reports it. Throws <see cref="RacsException"/> if it is not connected.</summary>
    public async Task<DeviceDiscoverInfo> GetInfoAsync(CancellationToken cancellationToken = default)
    {
        var devices = await Client.GetConnectedDevicesAsync(cancellationToken);
        return devices.FirstOrDefault(d => d.Id == Id) ?? throw new RacsException($"Device {Id} is not connected.");
    }

    public async Task<bool> IsConnectedAsync(CancellationToken cancellationToken = default)
    {
        var devices = await Client.GetConnectedDevicesAsync(cancellationToken);
        return devices.Any(d => d.Id == Id);
    }

    /// <summary>
    /// Connects the device, by discovery or at <paramref name="ipAddress"/>, and joins it in its current mode. Does
    /// nothing else if it is connected already. Answers the device's access state.
    /// </summary>
    public async Task<DeviceAccess> ConnectAsync(string? ipAddress = null, CancellationToken cancellationToken = default)
    {
        var access = await Client.ConnectDeviceAsync(Id, null, ipAddress, cancellationToken);
        _categories = null;
        return access;
    }

    /// <summary>
    /// Connects the device and takes its lease in <paramref name="mode"/> in one step, with the rules of
    /// <see cref="TakeAsync"/> without force.
    /// </summary>
    public async Task<DeviceAccess> ConnectAsync(Mode mode, string? ipAddress = null, CancellationToken cancellationToken = default)
    {
        var access = await Client.ConnectDeviceAsync(Id, mode, ipAddress, cancellationToken);
        _categories = null;
        return access;
    }

    /// <summary>
    /// Leaves the device. It is closed once no other session uses it and no stream or burst holds it;
    /// <see cref="DisconnectResult.Closed"/> says whether it is.
    /// </summary>
    public Task<DisconnectResult> DisconnectAsync(CancellationToken cancellationToken = default) =>
        DisconnectAsync(false, cancellationToken);

    /// <summary>With <paramref name="force"/> the device is closed for everyone (needs write permission).</summary>
    public async Task<DisconnectResult> DisconnectAsync(bool force, CancellationToken cancellationToken = default)
    {
        var result = await Client.DisconnectDeviceAsync(Id, force, cancellationToken);
        _categories = null;
        return result;
    }

    // --- ACCESS ---

    /// <summary>The device's mode, owner, members, holder and viewers, and this client's role (<see cref="DeviceAccess.You"/>).</summary>
    public Task<DeviceAccess> GetAccessAsync(CancellationToken cancellationToken = default) =>
        Client.GetDeviceAccessAsync(Id, cancellationToken);

    /// <summary>
    /// Takes the device's lease in <paramref name="mode"/>: <see cref="Mode.RoShared"/> (the others may only read) or
    /// <see cref="Mode.Exclusive"/> (only this client may use it); <see cref="Mode.Shared"/> gives it up. Throws
    /// <see cref="DeviceLockedException"/> when another session owns it and <see cref="DeviceInUseException"/> for
    /// exclusive while others use the device. <paramref name="force"/> takes it anyway: exclusive then evicts the
    /// other clients, whose streams end with <see cref="AccessRevokedException"/>.
    /// </summary>
    public Task<DeviceAccess> TakeAsync(Mode mode, bool force = false, CancellationToken cancellationToken = default) =>
        Client.SetDeviceAccessAsync(Id, mode, force, cancellationToken);

    /// <summary>Gives up the lease, or with <paramref name="force"/> breaks another session's. The device is shared again.</summary>
    public Task<DeviceAccess> ReleaseAsync(bool force = false, CancellationToken cancellationToken = default) =>
        Client.ReleaseDeviceAccessAsync(Id, force, cancellationToken);

    /// <summary>The device's GenICam XML.</summary>
    public Task<string> GetXmlAsync(CancellationToken cancellationToken = default) =>
        Client.GetDeviceXmlAsync(Id, cancellationToken);

    /// <summary>The GenICam categories and their features. Cached: they don't change while connected.</summary>
    public async Task<IReadOnlyList<GenICamNodeCategory>> GetCategoriesAsync(bool refresh = false, CancellationToken cancellationToken = default)
    {
        if (_categories is null || refresh)
        {
            _categories = await Client.GetDeviceGcCategoriesAsync(Id, cancellationToken);
        }

        return _categories;
    }

    /// <summary>A feature's description from the categories: type, access, enum entries, ...</summary>
    public async Task<GenICamNodeInfo> GetFeatureInfoAsync(string name, CancellationToken cancellationToken = default)
    {
        var categories = await GetCategoriesAsync(cancellationToken: cancellationToken);
        return categories.SelectMany(c => c.Nodes).FirstOrDefault(n => n.Name == name)
               ?? throw new FeatureException(name, "Feature not found");
    }

    // --- FEATURES ---

    /// <summary>A feature's live state: value, availability, lock, bounds.</summary>
    public async Task<FeatureState> GetStateAsync(string name, CancellationToken cancellationToken = default) =>
        (await GetStatesAsync([name], cancellationToken))[0];

    /// <summary>The live state of several features in one request, in the order asked.</summary>
    public Task<IReadOnlyList<FeatureState>> GetStatesAsync(IEnumerable<string> names, CancellationToken cancellationToken = default) =>
        Client.GetDeviceGcFeatureStatesAsync(Id, names, cancellationToken);

    /// <inheritdoc cref="GetStatesAsync(IEnumerable{string}, CancellationToken)"/>
    public Task<IReadOnlyList<FeatureState>> GetStatesAsync(params string[] names) =>
        Client.GetDeviceGcFeatureStatesAsync(Id, names);

    /// <summary>
    /// A feature's value as the server formats it (enums as their integer value). Null for a command or a
    /// feature that is unavailable right now. Throws <see cref="FeatureException"/> for an unknown feature or a
    /// failed read.
    /// </summary>
    public async Task<string?> GetAsync(string name, CancellationToken cancellationToken = default) =>
        ValueOf(await GetStateAsync(name, cancellationToken));

    /// <summary>
    /// A feature's value converted to <typeparamref name="T"/>: a numeric type for Integer, Enum and Float
    /// features, <see cref="bool"/> for Boolean, <see cref="string"/> for anything. A feature without a value
    /// gives null for a nullable <typeparamref name="T"/> and throws <see cref="FeatureException"/> otherwise.
    /// </summary>
    public async Task<T> GetAsync<T>(string name, CancellationToken cancellationToken = default)
    {
        var value = await GetAsync(name, cancellationToken);
        var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
        if (value is null)
        {
            return default(T) is null ? default! : throw new FeatureException(name, "No value: a command, or not available now");
        }

        return (T)Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
    }

    public Task SetAsync(string name, string value, CancellationToken cancellationToken = default) =>
        Client.SetDeviceGcNodeValueAsync(Id, name, value, cancellationToken);

    /// <summary>Writes an Integer or Enum feature (an enum also takes its entry name as a string).</summary>
    public Task SetAsync(string name, long value, CancellationToken cancellationToken = default) =>
        SetAsync(name, value.ToString(CultureInfo.InvariantCulture), cancellationToken);

    public Task SetAsync(string name, double value, CancellationToken cancellationToken = default) =>
        SetAsync(name, value.ToString("R", CultureInfo.InvariantCulture), cancellationToken);

    public Task SetAsync(string name, bool value, CancellationToken cancellationToken = default) =>
        SetAsync(name, value ? "true" : "false", cancellationToken);

    /// <summary>Executes a command feature such as <c>TriggerSoftware</c> or <c>UserSetLoad</c>.</summary>
    public Task ExecuteAsync(string command, CancellationToken cancellationToken = default) =>
        Client.ExecuteDeviceGcCommandAsync(Id, command, cancellationToken);

    // --- FRAMES ---

    /// <summary>One frame as a JPEG file (Mono8), at <paramref name="quality"/> 1-100 or the server's default.</summary>
    public Task<byte[]> GrabJpegAsync(int? quality = null, CancellationToken cancellationToken = default) =>
        quality is { } q
            ? Client.GrabJpgFrameAsync(Id, q, cancellationToken)
            : Client.GrabJpgFrameAsync(Id, cancellationToken);

    /// <summary>One raw Mono8 frame with its size.</summary>
    public async Task<Frame> GrabRawAsync(CancellationToken cancellationToken = default)
    {
        var data = await Client.GrabRawFrameAsync(Id, cancellationToken);
        var size = await GetStatesAsync(["Width", "Height"], cancellationToken);
        var width = int.Parse(ValueOf(size[0]) ?? "0", CultureInfo.InvariantCulture);
        var height = int.Parse(ValueOf(size[1]) ?? "0", CultureInfo.InvariantCulture);
        if (data.Length != width * height)
        {
            throw new RacsException($"Raw frame of {data.Length} bytes does not match {width}x{height}; was the size changed?");
        }

        return new Frame { Data = data, Width = width, Height = height };
    }

    /// <summary>Why the last live stream ended, and whether one runs now.</summary>
    public Task<StreamErrorInfo> GetStreamErrorAsync(CancellationToken cancellationToken = default) =>
        Client.GetStreamErrorAsync(Id, cancellationToken);

    /// <summary>
    /// The stream packet size, the sizes it may take and the link MTU. Every grab, stream and burst uses it as it is;
    /// change it with <c>SetAsync("GevSCPSPacketSize", 7960)</c> or <see cref="AutoPacketSizeAsync"/>.
    /// </summary>
    public Task<PacketSizeInfo> GetPacketSizeAsync(CancellationToken cancellationToken = default) =>
        Client.GetPacketSizeAsync(Id, cancellationToken);

    /// <summary>Finds the largest packet size that reaches the server, with test packets, and sets it.</summary>
    public Task<AutoPacketSize> AutoPacketSizeAsync(CancellationToken cancellationToken = default) =>
        Client.AutoPacketSizeAsync(Id, cancellationToken);

    /// <summary>
    /// Starts a live stream; read it and dispose it when done:
    /// <code>
    /// await using var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw });
    /// await foreach (var frame in live.ReadFramesAsync()) { ... }
    /// </code>
    /// </summary>
    public Task<LiveStream> OpenLiveStreamAsync(LiveStreamOptions? options = null, CancellationToken cancellationToken = default) =>
        Client.OpenLiveStreamAsync(Id, options, cancellationToken);

    // --- BURST JOBS ---

    /// <summary>Starts a background burst on the server.</summary>
    public async Task<BurstJob> StartBurstAsync(StartBurstJobRequest request, CancellationToken cancellationToken = default)
    {
        var created = await Client.StartGrabJobAsync(Id, request, cancellationToken);
        return new BurstJob(this, created.JobId);
    }

    /// <summary>Starts a background burst of <paramref name="count"/> (1-500) frames, with the server's defaults otherwise.</summary>
    public Task<BurstJob> StartBurstAsync(int count, ImageFormat format = ImageFormat.Raw, CancellationToken cancellationToken = default) =>
        StartBurstAsync(new StartBurstJobRequest { Count = count, Format = format }, cancellationToken);

    /// <summary>A handle for an existing burst job of this device.</summary>
    public BurstJob GetBurstJob(Guid jobId) => new(this, jobId);

    private static string? ValueOf(FeatureState state) =>
        state.Error is { } error ? throw new FeatureException(state.Name, error) : state.Value;
}
