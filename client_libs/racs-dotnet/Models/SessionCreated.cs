using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A new session, as <c>POST /sessions</c> answers it.</summary>
public sealed class SessionCreated
{
    /// <summary>Secret: sent with every request of this client.</summary>
    [JsonPropertyName("session_id")]
    public Guid SessionId { get; init; }

    /// <summary>Public: how other clients see this one (8 hex characters).</summary>
    [JsonPropertyName("client_id")]
    public required string ClientId { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    /// <summary>Seconds without a heartbeat before the session ends.</summary>
    [JsonPropertyName("timeout_s")]
    public int TimeoutS { get; init; }

    /// <summary>How often to send a heartbeat: a third of the timeout.</summary>
    [JsonPropertyName("heartbeat_interval_s")]
    public int HeartbeatIntervalS { get; init; }
}
