using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>One entry of a burst job's image list: <see cref="ImageEntryOk"/> or <see cref="ImageEntryFailed"/>.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "status")]
[JsonDerivedType(typeof(ImageEntryOk), "ok")]
[JsonDerivedType(typeof(ImageEntryFailed), "failed")]
public abstract class ImageEntryInfo
{
    [JsonPropertyName("index")]
    public int Index { get; init; }
}

public sealed class ImageEntryOk : ImageEntryInfo
{
    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }
}

/// <summary>A frame that was attempted and failed; only with <see cref="OnFailure.Skip"/>.</summary>
public sealed class ImageEntryFailed : ImageEntryInfo
{
    [JsonPropertyName("error")]
    public required string Error { get; init; }
}
