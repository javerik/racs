using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>What a burst job does when a frame cannot be captured.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<OnFailure>))]
public enum OnFailure
{
    /// <summary>Fail the job. The server's default.</summary>
    [JsonStringEnumMemberName("abort")]
    Abort,

    /// <summary>Record the failure at that index and carry on, up to <c>MaxFailures</c>.</summary>
    [JsonStringEnumMemberName("skip")]
    Skip
}
