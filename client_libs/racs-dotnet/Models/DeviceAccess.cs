using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Who may use a device and who does, and what the asking client may do.</summary>
public sealed class DeviceAccess
{
    [JsonPropertyName("device")]
    public int Device { get; init; }

    [JsonPropertyName("mode")]
    public Mode Mode { get; init; }

    /// <summary>The session holding the lease; null on a <see cref="Mode.Shared"/> device.</summary>
    [JsonPropertyName("owner")]
    public ClientRef? Owner { get; init; }

    /// <summary>The sessions that connected to or used the device, in the order they joined.</summary>
    [JsonPropertyName("members")]
    public IReadOnlyList<ClientRef> Members { get; init; } = [];

    /// <summary>The running live capture or burst, or null.</summary>
    [JsonPropertyName("holder")]
    public HolderRef? Holder { get; init; }

    /// <summary>Open live-stream sockets.</summary>
    [JsonPropertyName("viewers")]
    public int Viewers { get; init; }

    /// <summary>The asking client's role.</summary>
    [JsonPropertyName("you")]
    public Role You { get; init; }
}
