using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Why the last live stream on a device ended, and whether one runs now.</summary>
public sealed class StreamErrorInfo
{
    [JsonPropertyName("last_error")]
    public string? LastError { get; init; }

    [JsonPropertyName("timestamp")]
    public DateTimeOffset? Timestamp { get; init; }

    [JsonPropertyName("active_stream")]
    public bool ActiveStream { get; init; }

    /// <summary>Open live-stream sockets on the device.</summary>
    [JsonPropertyName("viewers")]
    public int Viewers { get; init; }
}
