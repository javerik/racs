using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A client's role on a device, following from the mode and the lease.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Role>))]
public enum Role
{
    /// <summary>Holds the device's lease.</summary>
    [JsonStringEnumMemberName("owner")]
    Owner,

    /// <summary>May read and write (everyone on a <see cref="Mode.Shared"/> device).</summary>
    [JsonStringEnumMemberName("writer")]
    Writer,

    /// <summary>May read.</summary>
    [JsonStringEnumMemberName("reader")]
    Reader,

    /// <summary>May only read the XML, the categories, the stream error and the access state.</summary>
    [JsonStringEnumMemberName("meta")]
    Meta
}
