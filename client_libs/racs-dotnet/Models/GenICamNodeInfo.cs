using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class GenICamNodeInfo
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("display_name")]
    public required string DisplayName { get; init; }

    [JsonPropertyName("access_mode")]
    public GenICamAccessMode AccessMode { get; init; }

    [JsonPropertyName("node_type")]
    public GenICamNodeType NodeType { get; init; }

    [JsonPropertyName("visibility")]
    public GenICamVisibility Visibility { get; init; }

    [JsonPropertyName("enums")]
    public List<GenICamEnumInfo>? Enums { get; init; }

    /// <summary>For a selector (e.g. GainSelector): the features whose value depends on it.</summary>
    [JsonPropertyName("selected")]
    public List<string> Selected { get; init; } = [];
}