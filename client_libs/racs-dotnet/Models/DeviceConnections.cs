using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class DeviceConnections
{
    [JsonPropertyName("available")]
    public required List<DeviceDiscoverInfo> Available { get; init; }

    [JsonPropertyName("connected")]
    public required List<DeviceDiscoverInfo> Connected { get; init; }
}