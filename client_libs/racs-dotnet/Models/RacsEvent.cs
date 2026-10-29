using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>The event types. <see cref="Unknown"/> is one this version of the library doesn't know.</summary>
public enum RacsEventKind
{
    Unknown,

    /// <summary>The first message: <see cref="RacsEvent.Session"/> and <see cref="RacsEvent.Devices"/>.</summary>
    Hello,

    /// <summary>A device's complete state after it changed: <see cref="RacsEvent.State"/>, <see cref="RacsEvent.Cause"/>, <see cref="RacsEvent.Reason"/>, <see cref="RacsEvent.By"/>.</summary>
    DeviceState,

    /// <summary>A client wrote <see cref="RacsEvent.Feature"/>. It carries no value: read again what you show.</summary>
    FeatureChanged,

    /// <summary>A client executed <see cref="RacsEvent.Command"/>.</summary>
    CommandExecuted,

    /// <summary><see cref="RacsEvent.ClientId"/> lost a device's lease, its membership or its stream or burst to <see cref="RacsEvent.By"/>'s force.</summary>
    AccessRevoked,

    /// <summary>Session <see cref="RacsEvent.ClientId"/> ended; <see cref="RacsEvent.Reason"/> is <c>expired</c> or <c>closed</c>.</summary>
    SessionEnded,

    /// <summary>This subscriber fell behind and lost events: read the state again.</summary>
    Resync
}

/// <summary>
/// One message of the events socket. Every event has <see cref="Seq"/>, <see cref="Time"/> and <see cref="Type"/>;
/// which of the other properties are set depends on <see cref="Kind"/>.
/// </summary>
public sealed class RacsEvent
{
    /// <summary>Global and increasing; only good for noticing gaps.</summary>
    [JsonPropertyName("seq")]
    public long Seq { get; init; }

    [JsonPropertyName("time")]
    public DateTimeOffset Time { get; init; }

    /// <summary>The wire name, e.g. <c>feature_changed</c>.</summary>
    [JsonPropertyName("type")]
    public required string Type { get; init; }

    public RacsEventKind Kind => Type switch
    {
        "hello" => RacsEventKind.Hello,
        "device_state" => RacsEventKind.DeviceState,
        "feature_changed" => RacsEventKind.FeatureChanged,
        "command_executed" => RacsEventKind.CommandExecuted,
        "access_revoked" => RacsEventKind.AccessRevoked,
        "session_ended" => RacsEventKind.SessionEnded,
        "resync" => RacsEventKind.Resync,
        _ => RacsEventKind.Unknown
    };

    [JsonPropertyName("device")]
    public int? Device { get; init; }

    /// <summary>Who made the change; null for anonymous clients and the server itself.</summary>
    [JsonPropertyName("by")]
    public ClientRef? By { get; init; }

    [JsonPropertyName("feature")]
    public string? Feature { get; init; }

    [JsonPropertyName("command")]
    public string? Command { get; init; }

    /// <summary><see cref="RacsEventKind.AccessRevoked"/>: who lost access; <see cref="RacsEventKind.SessionEnded"/>: whose session ended.</summary>
    [JsonPropertyName("client_id")]
    public string? ClientId { get; init; }

    /// <summary>
    /// <see cref="RacsEventKind.DeviceState"/> of a closed device: <c>request</c>, <c>idle</c>, <c>forced</c> or
    /// <c>error</c>. <see cref="RacsEventKind.SessionEnded"/>: <c>expired</c> or <c>closed</c>.
    /// </summary>
    [JsonPropertyName("reason")]
    public string? Reason { get; init; }

    /// <summary><see cref="RacsEventKind.DeviceState"/>: <c>connected</c>, <c>disconnected</c>, <c>access</c>, <c>stream</c> or <c>burst</c>.</summary>
    [JsonPropertyName("cause")]
    public string? Cause { get; init; }

    /// <summary><see cref="RacsEventKind.Hello"/>: this client.</summary>
    [JsonPropertyName("session")]
    public HelloSession? Session { get; init; }

    /// <summary><see cref="RacsEventKind.Hello"/>: every connected device.</summary>
    [JsonPropertyName("devices")]
    public IReadOnlyList<DeviceState>? Devices { get; init; }

    [JsonPropertyName("connected")]
    public bool? Connected { get; init; }

    [JsonPropertyName("access")]
    public AccessState? Access { get; init; }

    [JsonPropertyName("stream")]
    public StreamState? Stream { get; init; }

    [JsonPropertyName("burst")]
    public BurstState? Burst { get; init; }

    /// <summary><see cref="RacsEventKind.DeviceState"/>: the device's state; null for other events.</summary>
    [JsonIgnore]
    public DeviceState? State => Kind == RacsEventKind.DeviceState && Device is { } device && Access is { } access
        ? new DeviceState { Device = device, Connected = Connected ?? false, Access = access, Stream = Stream, Burst = Burst }
        : null;
}

/// <summary><c>hello.session</c>: the client the events socket belongs to.</summary>
public sealed class HelloSession
{
    [JsonPropertyName("client_id")]
    public required string ClientId { get; init; }

    [JsonPropertyName("timeout_s")]
    public int TimeoutS { get; init; }
}
