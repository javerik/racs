using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>What holds a device's camera for a long time.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<HolderKind>))]
public enum HolderKind
{
    [JsonStringEnumMemberName("live")]
    Live,

    [JsonStringEnumMemberName("burst")]
    Burst
}
