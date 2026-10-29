using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>The live capture or burst holding a device's camera, and who started it.</summary>
public sealed class HolderRef
{
    [JsonPropertyName("kind")]
    public HolderKind Kind { get; init; }

    /// <summary>The client that started it; null for an anonymous one.</summary>
    [JsonPropertyName("client_id")]
    public string? ClientId { get; init; }
}
