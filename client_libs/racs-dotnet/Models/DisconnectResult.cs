using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>The answer to a disconnect.</summary>
public sealed class DisconnectResult
{
    /// <summary>Whether the device is closed now (also true if it wasn't connected).</summary>
    [JsonPropertyName("closed")]
    public bool Closed { get; init; }

    /// <summary>The sessions still members of the device.</summary>
    [JsonPropertyName("members")]
    public int Members { get; init; }
}
