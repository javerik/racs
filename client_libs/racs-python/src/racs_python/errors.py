import json
from typing import TYPE_CHECKING, Optional

import requests
from pydantic import ValidationError

from .models import AccessRefusal

if TYPE_CHECKING:
    from .models import BurstJobInfo


class RacsError(Exception):
    """Base class of every error raised by this library."""


class RacsHttpError(RacsError, requests.HTTPError):
    """
    The server answered with an error status.

    Subclasses ``requests.HTTPError``, so code written against earlier versions of this library
    (which raised that directly) keeps working.
    """

    def __init__(self, status_code: int, body: str, url: str, response: Optional[requests.Response] = None):
        super().__init__(f"{status_code} for {url}: {body}", response=response)
        self.status_code = status_code
        self.body = body
        self.url = url
        # The parsed body of a JSON refusal (400, 401, 403, 409, 423), else None.
        self.refusal: Optional[AccessRefusal] = parse_refusal(body)


def parse_refusal(body: str) -> Optional[AccessRefusal]:
    """A JSON refusal body such as ``{"error":"read_only","mode":"ro-shared",...}``, or None."""
    if not body.startswith("{"):
        return None
    try:
        return AccessRefusal.model_validate(json.loads(body))
    except (ValueError, ValidationError):
        return None


class CameraBusyError(RacsHttpError):
    """The camera is held by another request: a live stream, a burst job or a frame grab."""


class NotFoundError(RacsHttpError):
    """404: no such burst job, or a burst image that has not been captured (yet)."""


class ImageFailedError(RacsHttpError):
    """410: that burst image was attempted and failed. ``body`` holds the reason."""


class SessionExpiredError(RacsHttpError):
    """
    401: the session is unknown or has ended. The client creates a new session and retries the
    request once by itself, so this only reaches you if that fails too.
    """


class ReadOnlyError(RacsHttpError):
    """403: a write on a ``ro-shared`` device another session owns. ``refusal.owner`` names it."""


class DeviceInUseError(RacsHttpError):
    """
    409: taking a device ``exclusive`` while other sessions use it or another client's live
    stream or burst holds it. ``refusal.members`` and ``refusal.holder`` name them; ``force``
    evicts them.
    """


class DeviceLockedError(RacsHttpError):
    """
    423: the device is ``exclusive`` to another session (or ``ro-shared`` and this client has no
    session), or its lease is another session's. ``refusal.owner`` names the owner.
    """


class FeatureError(RacsError):
    """A GenICam feature could not be read, e.g. ``Feature not found``."""

    def __init__(self, name: str, error: str):
        super().__init__(f"{name}: {error}")
        self.name = name
        self.error = error


class BurstJobFailedError(RacsError):
    """A burst job ended in ``failed``. ``info.error`` holds the reason."""

    def __init__(self, info: "BurstJobInfo"):
        super().__init__(f"burst job {info.job_id} failed: {info.error}")
        self.info = info


class LiveStreamError(RacsError):
    """The server closed the live stream because of an error."""

    def __init__(self, reason: str, code: Optional[int] = None):
        super().__init__(reason)
        self.reason = reason
        self.code = code


class SessionEndedError(LiveStreamError):
    """The socket was closed with ``4001``: the session it carried ended (expired or closed)."""


class AccessRevokedError(LiveStreamError):
    """
    The live stream was closed with ``4003``: another session took the device ``exclusive``
    with ``force``.
    """


# Close codes that end a socket without an error: the client left (1000), or the server stopped
# it (1001: the camera stopped delivering, the device was disconnected, the server shuts down).
NORMAL_CLOSE = (1000, 1001)
SESSION_ENDED_CODE = 4001
ACCESS_REVOKED_CODE = 4003


def close_error(code: Optional[int], reason: str) -> Optional[LiveStreamError]:
    """The exception for a WebSocket close frame, or None for a normal close."""
    if code is None or code in NORMAL_CLOSE:
        return None
    message = reason or f"stream closed with code {code}"
    if code == SESSION_ENDED_CODE:
        return SessionEndedError(message, code)
    if code == ACCESS_REVOKED_CODE:
        return AccessRevokedError(message, code)
    return LiveStreamError(message, code)


def http_error(status_code: int, body: str, url: str,
               response: Optional[requests.Response] = None) -> RacsHttpError:
    """The exception for an error response, picked by status and body."""
    if status_code == 401:
        cls = SessionExpiredError
    elif status_code == 403:
        cls = ReadOnlyError
    elif status_code == 404:
        cls = NotFoundError
    elif status_code == 409:
        cls = DeviceInUseError
    elif status_code == 410:
        cls = ImageFailedError
    elif status_code == 423:
        cls = DeviceLockedError
    # The server reports a held camera as a 500 whose body names the `Busy` store error.
    elif status_code == 500 and "Busy" in body:
        cls = CameraBusyError
    else:
        cls = RacsHttpError
    return cls(status_code, body, url, response)
