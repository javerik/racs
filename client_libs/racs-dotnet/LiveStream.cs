using System.Buffers;
using System.Buffers.Binary;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// A running live stream. Read frames with <see cref="ReadFramesAsync"/> or <see cref="ReadAsync"/>; the
/// sequence ends when the server closes the stream normally. The camera is held until the stream is
/// disposed: GenICam reads and writes still work meanwhile, frame grabs and burst jobs fail as busy. Several
/// streams of one device share its capture. A stream ended by the server throws <see cref="SessionEndedException"/>
/// when the client's session ended and <see cref="AccessRevokedException"/> when another session took the device.
/// </summary>
public sealed class LiveStream : IAsyncDisposable
{
    /// <summary>Bytes of <c>[u32 LE frame_number][u32 LE frames_dropped]</c> in front of every frame message.</summary>
    internal const int FrameHeaderLength = 8;

    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(5);

    private readonly ClientWebSocket _socket;
    private readonly TimeSpan _receiveTimeout;
    private readonly ArrayBufferWriter<byte> _message = new();

    private LiveStream(ClientWebSocket socket, int deviceId, TimeSpan receiveTimeout)
    {
        _socket = socket;
        DeviceId = deviceId;
        _receiveTimeout = receiveTimeout;
    }

    public int DeviceId { get; }

    /// <summary>Describes the frames being received. Replaced whenever the geometry changes mid-stream.</summary>
    public StreamInfo? Info { get; private set; }

    public bool IsClosed { get; private set; }

    internal static async Task<LiveStream> ConnectAsync(
        RacsClient client, int deviceId, string query, TimeSpan receiveTimeout, CancellationToken cancellationToken)
    {
        var socket = await client.OpenWebSocketAsync($"devices/{deviceId}/stream/live", query, deviceId, cancellationToken);
        return new LiveStream(socket, deviceId, receiveTimeout);
    }

    /// <summary>
    /// The next frame, or null once the stream has ended. Throws <see cref="LiveStreamException"/> for a stream
    /// that failed and <see cref="TimeoutException"/> when nothing arrives within the receive timeout.
    /// </summary>
    public async Task<Frame?> ReadAsync(CancellationToken cancellationToken = default)
    {
        while (!IsClosed)
        {
            var type = await ReceiveMessageAsync(cancellationToken);
            switch (type)
            {
                case WebSocketMessageType.Text:
                    Info = JsonSerializer.Deserialize<StreamInfo>(_message.WrittenSpan, RacsClient.JsonOptions);
                    break;

                case WebSocketMessageType.Binary:
                    var info = Info ?? throw new LiveStreamException("Frame received before the stream info.");
                    var (frameNumber, dropped, image) = ParseFrameMessage(_message.WrittenSpan);
                    return new Frame
                    {
                        Data = image,
                        Width = info.Width,
                        Height = info.Height,
                        Format = info.Format,
                        PixelFormat = info.PixelFormat,
                        BitDepth = info.BitDepth,
                        FrameNumber = frameNumber,
                        Dropped = dropped
                    };

                case WebSocketMessageType.Close:
                    IsClosed = true;
                    var status = _socket.CloseStatus;
                    try
                    {
                        await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, cancellationToken);
                    }
                    catch (WebSocketException)
                    {
                    }

                    // 1000: the client left; 1001: the camera stopped delivering. Anything else is a failure:
                    // 4001 the session ended, 4003 another session's force took the device.
                    if (status is not (null or WebSocketCloseStatus.NormalClosure or WebSocketCloseStatus.EndpointUnavailable))
                    {
                        throw LiveStreamException.FromClose((int)status, _socket.CloseStatusDescription);
                    }

                    break;
            }
        }

        return null;
    }

    /// <summary>Every frame until the stream ends.</summary>
    public async IAsyncEnumerable<Frame> ReadFramesAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        while (await ReadAsync(cancellationToken) is { } frame)
        {
            yield return frame;
        }
    }

    /// <summary>Stops the stream and releases the camera.</summary>
    public async Task CloseAsync(CancellationToken cancellationToken = default)
    {
        if (IsClosed)
        {
            return;
        }

        IsClosed = true;
        if (_socket.State != WebSocketState.Open)
        {
            return;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(CloseTimeout);
        try
        {
            // Waits for the server's close, which follows once its capture loop has stopped.
            await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
            _socket.Abort();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await CloseAsync();
        _socket.Dispose();
    }

    /// <summary>Splits a binary live-stream message into its counters and the image.</summary>
    internal static (uint FrameNumber, uint Dropped, byte[] Image) ParseFrameMessage(ReadOnlySpan<byte> message)
    {
        if (message.Length < FrameHeaderLength)
        {
            throw new LiveStreamException($"Frame message of {message.Length} bytes is shorter than its header.");
        }

        return (
            BinaryPrimitives.ReadUInt32LittleEndian(message[..4]),
            BinaryPrimitives.ReadUInt32LittleEndian(message[4..8]),
            message[FrameHeaderLength..].ToArray());
    }

    private async Task<WebSocketMessageType> ReceiveMessageAsync(CancellationToken cancellationToken)
    {
        _message.ResetWrittenCount();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_receiveTimeout);
        try
        {
            while (true)
            {
                var result = await _socket.ReceiveAsync(_message.GetMemory(64 * 1024), timeout.Token);
                _message.Advance(result.Count);
                if (result.EndOfMessage || result.MessageType == WebSocketMessageType.Close)
                {
                    return result.MessageType;
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A cancelled receive aborts the socket, so the stream is over either way.
            IsClosed = true;
            throw new TimeoutException($"No message from device {DeviceId} within {_receiveTimeout}.");
        }
        catch (WebSocketException e)
        {
            IsClosed = true;
            throw new LiveStreamException($"Connection lost: {e.Message}");
        }
    }
}
