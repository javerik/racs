using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Live state of a feature, from <c>POST /devices/{id}/gc/features/state</c>.</summary>
public sealed class FeatureState
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    /// <summary>Null when the feature isn't known (see <see cref="Error"/>).</summary>
    [JsonPropertyName("node_type")]
    public GenICamNodeType? NodeType { get; init; }

    /// <summary>
    /// Formatted as by the single-feature GET. Null for a command, a write-only or unavailable feature, or a
    /// failed read.
    /// </summary>
    [JsonPropertyName("value")]
    public string? Value { get; init; }

    [JsonPropertyName("available")]
    public bool Available { get; init; }

    /// <summary>The feature can be read but not written right now.</summary>
    [JsonPropertyName("locked")]
    public bool Locked { get; init; }

    [JsonPropertyName("min")]
    public double? Min { get; init; }

    [JsonPropertyName("max")]
    public double? Max { get; init; }

    [JsonPropertyName("inc")]
    public double? Inc { get; init; }

    [JsonPropertyName("unit")]
    public string? Unit { get; init; }

    [JsonPropertyName("representation")]
    public string? Representation { get; init; }

    /// <summary>For an enum: the integer values of the entries the device currently offers.</summary>
    [JsonPropertyName("available_entries")]
    public List<long>? AvailableEntries { get; init; }

    /// <summary>Why this state is incomplete, e.g. <c>Feature not found</c>.</summary>
    [JsonPropertyName("error")]
    public string? Error { get; init; }
}
