using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A burst job's status and progress.</summary>
public sealed class BurstJobInfo
{
    [JsonPropertyName("job_id")]
    public Guid JobId { get; init; }

    [JsonPropertyName("device_id")]
    public int DeviceId { get; init; }

    [JsonPropertyName("status")]
    public JobStatus Status { get; init; }

    [JsonPropertyName("format")]
    public ImageFormat Format { get; init; }

    [JsonPropertyName("requested_count")]
    public int RequestedCount { get; init; }

    [JsonPropertyName("captured_count")]
    public int CapturedCount { get; init; }

    [JsonPropertyName("failed_count")]
    public int FailedCount { get; init; }

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; init; }

    [JsonPropertyName("started_at")]
    public DateTimeOffset? StartedAt { get; init; }

    [JsonPropertyName("completed_at")]
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>When the finished job is dropped from the server. Null until it finishes.</summary>
    [JsonPropertyName("expires_at")]
    public DateTimeOffset? ExpiresAt { get; init; }

    /// <summary>Why the job failed. Null unless <see cref="Status"/> is <see cref="JobStatus.Failed"/>.</summary>
    [JsonPropertyName("error")]
    public string? Error { get; init; }

    /// <summary>Frame width. Null until the first frame is captured.</summary>
    [JsonPropertyName("width")]
    public int? Width { get; init; }

    [JsonPropertyName("height")]
    public int? Height { get; init; }

    [JsonPropertyName("pixel_format")]
    public string? PixelFormat { get; init; }

    /// <summary>Significant bits per pixel. Above 8, raw images are little-endian ushorts.</summary>
    [JsonPropertyName("bit_depth")]
    public int? BitDepth { get; init; }
}
