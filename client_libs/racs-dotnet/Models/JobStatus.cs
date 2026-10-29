using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

[JsonConverter(typeof(JsonStringEnumConverter<JobStatus>))]
public enum JobStatus
{
    /// <summary>Created, but the capture has not taken the camera yet.</summary>
    [JsonStringEnumMemberName("pending")]
    Pending,

    [JsonStringEnumMemberName("running")]
    Running,

    [JsonStringEnumMemberName("completed")]
    Completed,

    [JsonStringEnumMemberName("failed")]
    Failed,

    [JsonStringEnumMemberName("cancelled")]
    Cancelled
}

public static class JobStatusExtensions
{
    /// <summary>Whether the job has stopped for good.</summary>
    public static bool IsTerminal(this JobStatus status) =>
        status is JobStatus.Completed or JobStatus.Failed or JobStatus.Cancelled;
}
