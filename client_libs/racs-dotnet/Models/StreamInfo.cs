using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Describes every live-stream frame after it, until the next one.</summary>
public sealed class StreamInfo
{
    [JsonPropertyName("width")]
    public int Width { get; init; }

    [JsonPropertyName("height")]
    public int Height { get; init; }

    [JsonPropertyName("format")]
    public ImageFormat Format { get; init; }

    [JsonPropertyName("pixel_format")]
    public required string PixelFormat { get; init; }

    /// <summary>Significant bits per pixel. Above 8, raw frames are little-endian ushorts.</summary>
    [JsonPropertyName("bit_depth")]
    public int BitDepth { get; init; }

    /// <summary>GevSCPSPacketSize the stream runs with; null from servers that don't report it.</summary>
    [JsonPropertyName("packet_size")]
    public int? PacketSize { get; init; }
}
