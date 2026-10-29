using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>
/// The JSON body of a refusal (400, 401, 403, 409, 423): <c>error</c> names it, the rest is context where the
/// server has it.
/// </summary>
public sealed class AccessRefusal
{
    /// <summary><c>session_expired</c>, <c>session_required</c>, <c>read_only</c>, <c>device_in_use</c>, <c>device_locked</c>, ...</summary>
    [JsonPropertyName("error")]
    public required string Error { get; init; }

    [JsonPropertyName("mode")]
    public Mode? Mode { get; init; }

    /// <summary>The session holding the device's lease.</summary>
    [JsonPropertyName("owner")]
    public ClientRef? Owner { get; init; }

    /// <summary>With <c>device_in_use</c>: the other member sessions.</summary>
    [JsonPropertyName("members")]
    public IReadOnlyList<ClientRef>? Members { get; init; }

    /// <summary>With <c>device_in_use</c>: another client's live capture or burst.</summary>
    [JsonPropertyName("holder")]
    public HolderRef? Holder { get; init; }
}
