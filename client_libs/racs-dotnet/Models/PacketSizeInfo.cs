using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>A camera's stream packet size, what it may be set to, and the link it travels over.</summary>
public sealed class PacketSizeInfo
{
    /// <summary>GevSCPSPacketSize: bytes per stream packet, IP and UDP headers included.</summary>
    [JsonPropertyName("packet_size")]
    public int PacketSize { get; init; }

    /// <summary>Allowed sizes are the multiples of <see cref="Inc"/> from <see cref="Min"/> to <see cref="Max"/>.</summary>
    [JsonPropertyName("min")]
    public int Min { get; init; }

    [JsonPropertyName("max")]
    public int Max { get; init; }

    [JsonPropertyName("inc")]
    public int Inc { get; init; }

    /// <summary>MTU of the local interface the camera is reached over; null when unknown. A larger packet size never arrives.</summary>
    [JsonPropertyName("link_mtu")]
    public int? LinkMtu { get; init; }

    [JsonPropertyName("interface")]
    public string? Interface { get; init; }

    [JsonPropertyName("local_ip")]
    public string? LocalIp { get; init; }
}
