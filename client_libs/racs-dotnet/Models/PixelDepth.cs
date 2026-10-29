using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

/// <summary>Requested depth of live and burst frames. The camera's answer is reported as <c>BitDepth</c>.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PixelDepth>))]
public enum PixelDepth
{
    [JsonStringEnumMemberName("mono8")]
    Mono8,

    /// <summary>The deepest unpacked mono format the camera accepts: Mono16, 14, 12, then 10 (Coord3D_C16 on a 3D camera in Linescan3D).</summary>
    [JsonStringEnumMemberName("mono16")]
    Mono16
}
