using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class GenICamEnumInfo
{
    [JsonPropertyName("display_name")]
    public required string DisplayName { get; init; }

    [JsonPropertyName("value")]
    public long Value { get; init; }

    [JsonPropertyName("string_value")]
    public string? StringValue { get; init; }
}