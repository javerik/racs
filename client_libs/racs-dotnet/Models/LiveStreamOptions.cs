namespace Racs.Dotnet.Models;

/// <summary>Query options of <c>GET /devices/{id}/stream/live</c>. Unset values use the server's defaults.</summary>
public sealed class LiveStreamOptions
{
    public ImageFormat Format { get; init; } = ImageFormat.Jpeg;

    public PixelDepth? PixelDepth { get; init; }

    /// <summary>JPEG quality 1-100 (server default 80).</summary>
    public int? Quality { get; init; }

    /// <summary>Target frame rate. Null sends every frame the camera delivers.</summary>
    public double? Fps { get; init; }

    /// <summary>
    /// How long to wait for each message before <see cref="LiveStream.ReadAsync"/> throws a
    /// <see cref="TimeoutException"/>. A timeout ends the stream.
    /// </summary>
    public TimeSpan ReceiveTimeout { get; init; } = TimeSpan.FromSeconds(10);
}
