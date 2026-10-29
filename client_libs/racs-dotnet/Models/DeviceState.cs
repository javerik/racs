using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A device's complete state as the events report it.</summary>
public sealed class DeviceState
{
    [JsonPropertyName("device")]
    public int Device { get; init; }

    [JsonPropertyName("connected")]
    public bool Connected { get; init; }

    [JsonPropertyName("access")]
    public required AccessState Access { get; init; }

    /// <summary>The running live capture, or null.</summary>
    [JsonPropertyName("stream")]
    public StreamState? Stream { get; init; }

    /// <summary>The running burst job, or null.</summary>
    [JsonPropertyName("burst")]
    public BurstState? Burst { get; init; }
}

/// <summary>Who may use a device and who does.</summary>
public sealed class AccessState
{
    [JsonPropertyName("mode")]
    public Mode Mode { get; init; }

    /// <summary>The session holding the lease; null on a <see cref="Mode.Shared"/> device.</summary>
    [JsonPropertyName("owner")]
    public ClientRef? Owner { get; init; }

    /// <summary>The sessions that connected to or used the device, in the order they joined.</summary>
    [JsonPropertyName("members")]
    public IReadOnlyList<ClientRef> Members { get; init; } = [];
}

/// <summary>A running live capture.</summary>
public sealed class StreamState
{
    /// <summary>Open live-stream sockets.</summary>
    [JsonPropertyName("viewers")]
    public int Viewers { get; init; }

    [JsonPropertyName("pixel_format")]
    public required string PixelFormat { get; init; }

    [JsonPropertyName("bit_depth")]
    public int BitDepth { get; init; }
}

/// <summary>A running burst job.</summary>
public sealed class BurstState
{
    [JsonPropertyName("job_id")]
    public Guid JobId { get; init; }

    /// <summary>The session that started it; null for an anonymous one.</summary>
    [JsonPropertyName("client_id")]
    public string? ClientId { get; init; }
}
