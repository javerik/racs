using System.Buffers;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// The server's events socket: what happens on the server, as <see cref="RacsEvent"/>s, starting with
/// <see cref="RacsEventKind.Hello"/>. Open it with <see cref="RacsClient.OpenEventsAsync"/>, or iterate
/// <see cref="RacsClient.EventsAsync"/>. It needs a session, and keeps it alive while it is read. When the session
/// ends the socket closes and reading throws <see cref="SessionEndedException"/>.
/// </summary>
public sealed class EventStream : IAsyncDisposable
{
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(5);

    private readonly ClientWebSocket _socket;
    private readonly ArrayBufferWriter<byte> _message = new();

    internal EventStream(ClientWebSocket socket)
    {
        _socket = socket;
    }

    public bool IsClosed { get; private set; }

    /// <summary>
    /// The next event, or null once the server closed the socket normally. Throws <see cref="SessionEndedException"/>
    /// when the session ended and <see cref="LiveStreamException"/> for any other close or a lost connection.
    /// </summary>
    public async Task<RacsEvent?> ReadAsync(CancellationToken cancellationToken = default)
    {
        while (!IsClosed)
        {
            var type = await ReceiveMessageAsync(cancellationToken);
            switch (type)
            {
                case WebSocketMessageType.Text:
                    return ParseEvent(_message.WrittenSpan);

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

                    if (status is not (null or WebSocketCloseStatus.NormalClosure or WebSocketCloseStatus.EndpointUnavailable))
                    {
                        throw LiveStreamException.FromClose((int)status, _socket.CloseStatusDescription);
                    }

                    break;
            }
        }

        return null;
    }

    /// <summary>Every event until the socket closes.</summary>
    public async IAsyncEnumerable<RacsEvent> ReadEventsAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        while (await ReadAsync(cancellationToken) is { } ev)
        {
            yield return ev;
        }
    }

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

    internal static RacsEvent ParseEvent(ReadOnlySpan<byte> message) =>
        JsonSerializer.Deserialize<RacsEvent>(message, RacsClient.JsonOptions)
        ?? throw new RacsException("Empty event message.");

    private async Task<WebSocketMessageType> ReceiveMessageAsync(CancellationToken cancellationToken)
    {
        _message.ResetWrittenCount();
        try
        {
            // No receive timeout: events may be rare. The server pings the socket, which the runtime answers.
            while (true)
            {
                var result = await _socket.ReceiveAsync(_message.GetMemory(16 * 1024), cancellationToken);
                _message.Advance(result.Count);
                if (result.EndOfMessage || result.MessageType == WebSocketMessageType.Close)
                {
                    return result.MessageType;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // A cancelled receive aborts the socket.
            IsClosed = true;
            throw;
        }
        catch (WebSocketException e)
        {
            IsClosed = true;
            throw new LiveStreamException($"Connection lost: {e.Message}");
        }
    }
}
