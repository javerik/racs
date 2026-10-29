using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>The outcome of a test-packet search for the largest packet size that arrives.</summary>
public sealed class AutoPacketSize
{
    /// <summary>The packet size now set.</summary>
    [JsonPropertyName("packet_size")]
    public int PacketSize { get; init; }

    [JsonPropertyName("previous")]
    public int Previous { get; init; }

    /// <summary>False when the camera answered no test packet; the size is then left as it was.</summary>
    [JsonPropertyName("test_packets")]
    public bool TestPackets { get; init; }

    [JsonPropertyName("link_mtu")]
    public int? LinkMtu { get; init; }

    [JsonPropertyName("interface")]
    public string? Interface { get; init; }
}
