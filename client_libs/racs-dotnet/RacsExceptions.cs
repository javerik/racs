using System.Net;
using System.Text.Json;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// The server answered with an error status. Derives from <see cref="HttpRequestException"/>, which is what
/// earlier versions of this library threw, so existing handlers keep working.
/// </summary>
public class RacsApiException : HttpRequestException
{
    public RacsApiException(HttpStatusCode statusCode, string body, string endpoint)
        : base($"Request to '{endpoint}' failed with status {(int)statusCode} ({statusCode}). Response: {body}", null, statusCode)
    {
        Body = body;
        Endpoint = endpoint;
        Refusal = ParseRefusal(body);
    }

    /// <summary>The response body: the server's error message.</summary>
    public string Body { get; }

    public string Endpoint { get; }

    /// <summary>
    /// The parsed body of a JSON refusal (400, 401, 403, 409, 423): its <c>error</c>, and the device's mode, owner,
    /// members and holder where the server names them. Null for the plain-text errors. A refused live stream has
    /// none either: a WebSocket upgrade's body can't be read, so only the status tells the refusal.
    /// </summary>
    public AccessRefusal? Refusal { get; }

    /// <summary>The exception for an error response, picked by status and body.</summary>
    public static RacsApiException FromResponse(HttpStatusCode statusCode, string body, string endpoint) => statusCode switch
    {
        HttpStatusCode.Unauthorized => new SessionExpiredException(statusCode, body, endpoint),
        HttpStatusCode.Forbidden => new ReadOnlyException(statusCode, body, endpoint),
        HttpStatusCode.Conflict => new DeviceInUseException(statusCode, body, endpoint),
        HttpStatusCode.Locked => new DeviceLockedException(statusCode, body, endpoint),
        HttpStatusCode.NotFound => new RacsNotFoundException(statusCode, body, endpoint),
        HttpStatusCode.Gone => new ImageFailedException(statusCode, body, endpoint),
        // The server reports a held camera as a 500 whose body names the `Busy` store error.
        HttpStatusCode.InternalServerError when body.Contains("Busy", StringComparison.Ordinal)
            => new CameraBusyException(statusCode, body, endpoint),
        _ => new RacsApiException(statusCode, body, endpoint)
    };

    private static AccessRefusal? ParseRefusal(string body)
    {
        if (!body.StartsWith('{'))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<AccessRefusal>(body, RacsClient.JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// 401: the session is unknown or expired (<c>session_expired</c>). <see cref="RacsClient"/> starts a new session
/// and retries once by itself, so this only reaches callers of the session routes or when that retry fails too.
/// </summary>
public sealed class SessionExpiredException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>
/// 403: a write on a <see cref="Mode.RoShared"/> device by a session that doesn't own it (<c>read_only</c>).
/// <see cref="RacsApiException.Refusal"/> names the owner.
/// </summary>
public sealed class ReadOnlyException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>
/// 409: going <see cref="Mode.Exclusive"/> while other sessions use the device or another client's stream or burst
/// holds it (<c>device_in_use</c>). <see cref="RacsApiException.Refusal"/> names the members and the holder; take
/// it with <c>force</c> to evict them.
/// </summary>
public sealed class DeviceInUseException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>
/// 423: another session's lease locks the device (<c>device_locked</c>): it is <see cref="Mode.Exclusive"/>, or
/// <see cref="Mode.RoShared"/> for an anonymous client, or the lease to take is owned by someone else.
/// </summary>
public sealed class DeviceLockedException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>The camera is held by another request: a live stream, a burst job or a frame grab.</summary>
public sealed class CameraBusyException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>404: no such burst job, or a burst image that has not been captured (yet).</summary>
public sealed class RacsNotFoundException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>410: that burst image was attempted and failed. <see cref="RacsApiException.Body"/> holds the reason.</summary>
public sealed class ImageFailedException(HttpStatusCode statusCode, string body, string endpoint)
    : RacsApiException(statusCode, body, endpoint);

/// <summary>Base class of the errors that don't come from an HTTP status.</summary>
public class RacsException(string message) : Exception(message);

/// <summary>A GenICam feature could not be read, e.g. <c>Feature not found</c>.</summary>
public sealed class FeatureException(string featureName, string error) : RacsException($"{featureName}: {error}")
{
    public string FeatureName { get; } = featureName;

    public string Error { get; } = error;
}

/// <summary>A burst job ended in <see cref="JobStatus.Failed"/>. <c>Info.Error</c> holds the reason.</summary>
public sealed class BurstJobFailedException(BurstJobInfo info) : RacsException($"Burst job {info.JobId} failed: {info.Error}")
{
    public BurstJobInfo Info { get; } = info;
}

/// <summary>The server closed the live stream (or the events socket) because of an error.</summary>
public class LiveStreamException(string reason, int? closeCode = null) : RacsException(reason)
{
    /// <summary>The close code of a socket whose session ended.</summary>
    public const int SessionEndedCode = 4001;

    /// <summary>The close code of a live socket another session's forced lease took away.</summary>
    public const int AccessRevokedCode = 4003;

    public string Reason { get; } = reason;

    public int? CloseCode { get; } = closeCode;

    /// <summary>The exception for a socket closed with <paramref name="code"/>.</summary>
    public static LiveStreamException FromClose(int code, string? reason)
    {
        var message = string.IsNullOrEmpty(reason) ? $"Stream closed with code {code}." : reason;
        return code switch
        {
            SessionEndedCode => new SessionEndedException(message),
            AccessRevokedCode => new AccessRevokedException(message),
            _ => new LiveStreamException(message, code)
        };
    }
}

/// <summary>
/// 4001: the socket's session ended (it expired or was closed). The client's next request starts a new session.
/// </summary>
public sealed class SessionEndedException(string reason) : LiveStreamException(reason, SessionEndedCode);

/// <summary>4003: another session took the device <see cref="Mode.Exclusive"/> with <c>force</c>.</summary>
public sealed class AccessRevokedException(string reason) : LiveStreamException(reason, AccessRevokedCode);
