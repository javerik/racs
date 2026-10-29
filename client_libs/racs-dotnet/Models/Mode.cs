using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A device's access mode.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Mode>))]
public enum Mode
{
    /// <summary>Every client may read and write. No owner. The default.</summary>
    [JsonStringEnumMemberName("shared")]
    Shared,

    /// <summary>The owner reads and writes, other sessions read, anonymous clients get meta routes only.</summary>
    [JsonStringEnumMemberName("ro-shared")]
    RoShared,

    /// <summary>The owner reads and writes, everyone else gets meta routes only.</summary>
    [JsonStringEnumMemberName("exclusive")]
    Exclusive
}
