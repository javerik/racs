using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A client as the others see it: the members of a device, <c>by</c> in events.</summary>
public sealed class ClientRef
{
    /// <summary>Public: 8 hex characters.</summary>
    [JsonPropertyName("client_id")]
    public required string ClientId { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    public override string ToString() => Name is null ? ClientId : $"{Name} ({ClientId})";
}
