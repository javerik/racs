using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>How a frame is encoded: the <c>format</c> of live streams, burst jobs and frames.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ImageFormat>))]
public enum ImageFormat
{
    /// <summary>Width*Height pixels: one byte each at 8 bit, otherwise a little-endian ushort each.</summary>
    [JsonStringEnumMemberName("raw")]
    Raw,

    /// <summary>A JPEG file holding the top 8 significant bits.</summary>
    [JsonStringEnumMemberName("jpeg")]
    Jpeg,

    /// <summary>
    /// The raw pixels losslessly compressed. <see cref="Frame.ToUInt16Array"/> and <see cref="Frame.ToRaw"/>
    /// decode it.
    /// </summary>
    [JsonStringEnumMemberName("zstd")]
    Zstd
}
