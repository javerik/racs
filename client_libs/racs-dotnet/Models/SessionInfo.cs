using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A session as <c>GET /sessions</c> lists it, without its secret id.</summary>
public sealed class SessionInfo
{
    [JsonPropertyName("client_id")]
    public required string ClientId { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("since")]
    public DateTimeOffset Since { get; init; }

    /// <summary>The last heartbeat or request carrying the session.</summary>
    [JsonPropertyName("last_seen")]
    public DateTimeOffset LastSeen { get; init; }

    /// <summary>The devices the session is a member of.</summary>
    [JsonPropertyName("devices")]
    public IReadOnlyList<int> Devices { get; init; } = [];

    /// <summary>The devices whose lease the session holds.</summary>
    [JsonPropertyName("owns")]
    public IReadOnlyList<int> Owns { get; init; } = [];
}
