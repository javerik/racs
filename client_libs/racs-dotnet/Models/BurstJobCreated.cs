using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class BurstJobCreated
{
    [JsonPropertyName("job_id")]
    public Guid JobId { get; init; }

    [JsonPropertyName("device_id")]
    public int DeviceId { get; init; }

    [JsonPropertyName("status")]
    public JobStatus Status { get; init; }
}
