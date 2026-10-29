using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class GenICamNodeCategory
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("display_name")]
    public required string DisplayName { get; init; }

    [JsonPropertyName("nodes")]
    public required List<GenICamNodeInfo> Nodes { get; init; }
}