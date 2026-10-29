using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Body of <c>POST /devices/{id}/grab/jobs</c>. Unset values use the server's defaults.</summary>
public sealed class StartBurstJobRequest
{
    /// <summary>How many frames to grab, 1 to 500.</summary>
    [JsonPropertyName("count")]
    public required int Count { get; init; }

    [JsonPropertyName("format")]
    public ImageFormat Format { get; init; } = ImageFormat.Raw;

    [JsonPropertyName("pixel_depth")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public PixelDepth? PixelDepth { get; init; }

    /// <summary>JPEG quality 1-100 (server default 80).</summary>
    [JsonPropertyName("quality")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Quality { get; init; }

    [JsonPropertyName("on_failure")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OnFailure? OnFailure { get; init; }

    /// <summary>With <see cref="Models.OnFailure.Skip"/>, how many failed frames to tolerate. Null for unlimited.</summary>
    [JsonPropertyName("max_failures")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxFailures { get; init; }
}
