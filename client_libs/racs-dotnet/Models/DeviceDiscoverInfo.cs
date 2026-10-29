using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

public sealed class DeviceDiscoverInfo
{
    [JsonPropertyName("id")]
    public int Id { get; init; }

    [JsonPropertyName("dev_id")]
    public required string DevId { get; init; }

    [JsonPropertyName("serial_number")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("vendor")]
    public required string Vendor { get; init; }

    [JsonPropertyName("model")]
    public required string Model { get; init; }

    [JsonPropertyName("manufacturer_info")]
    public required string ManufacturerInfo { get; init; }

    [JsonPropertyName("ip")]
    public required string Ip { get; init; }

    [JsonPropertyName("mac")]
    public required string Mac { get; init; }

    /// <summary>Who may use the device and who does; only in the connected list.</summary>
    [JsonPropertyName("access")]
    public DeviceAccess? Access { get; init; }
}