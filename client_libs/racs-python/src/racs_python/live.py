import struct
from typing import TYPE_CHECKING, Dict, Iterator, Optional, Tuple
from urllib.parse import urlencode

import websocket

from .errors import LiveStreamError, close_error, http_error
from .frame import Frame
from .models import StreamInfo

if TYPE_CHECKING:
    from .client import RacsClient

# `[u32 LE frame_number][u32 LE frames_dropped]` in front of every binary message.
FRAME_HEADER = struct.Struct("<II")


def parse_frame_message(data: bytes) -> Tuple[int, int, bytes]:
    """Split a binary live-stream message into ``(frame_number, dropped, image)``."""
    if len(data) < FRAME_HEADER.size:
        raise LiveStreamError(f"frame message of {len(data)} bytes is shorter than its header")
    frame_number, dropped = FRAME_HEADER.unpack_from(data)
    return frame_number, dropped, bytes(data[FRAME_HEADER.size:])


def parse_close(data: bytes) -> Tuple[Optional[int], str]:
    """The status code and reason of a WebSocket close frame's payload."""
    if len(data) < 2:
        return None, ""
    return struct.unpack(">H", data[:2])[0], data[2:].decode("utf-8", "replace")


class LiveStream:
    """
    A running live stream: an iterator of :class:`Frame` that ends when the server closes the
    stream normally.

    The camera is held while the stream is open, so close it (or use it as a context manager)
    when done. GenICam reads and writes still work meanwhile; frame grabs and burst jobs on the
    device fail as busy. Other clients' streams of the device join the same capture.

    A stream ends with SessionEndedError when its session ends (close code ``4001``), and with
    AccessRevokedError when another session takes the device ``exclusive`` by force (``4003``).
    """

    def __init__(self, client: "RacsClient", device_id: int, url: str, params: Dict[str, str], timeout: float):
        self.device_id = device_id
        # Describes the frames being received. Replaced whenever the geometry changes mid-stream.
        self.info: Optional[StreamInfo] = None
        self.closed = False
        full_url = f"{url}?{urlencode(params)}"
        try:
            self._ws = websocket.create_connection(full_url, timeout=timeout)
        except websocket.WebSocketBadStatusException as e:
            body = (getattr(e, "resp_body", None) or b"").decode("utf-8", "replace")
            if not body and e.status_code != 401:
                # The server records why an upgrade was refused.
                body = client.get_stream_error(device_id).last_error or ""
            # Without the query: it carries the secret session id.
            raise http_error(e.status_code, body, url) from None

    def read(self) -> Optional[Frame]:
        """The next frame, or None once the stream has ended. Raises LiveStreamError on a failed stream."""
        while not self.closed:
            try:
                opcode, frame = self._ws.recv_data_frame()
            except websocket.WebSocketTimeoutException as e:
                raise TimeoutError(f"no frame from device {self.device_id} within {self._ws.gettimeout()} s") from e
            except websocket.WebSocketConnectionClosedException as e:
                self.closed = True
                raise LiveStreamError("connection closed without a close frame") from e

            if opcode == websocket.ABNF.OPCODE_TEXT:
                self.info = StreamInfo.model_validate_json(frame.data)
            elif opcode == websocket.ABNF.OPCODE_BINARY:
                if self.info is None:
                    raise LiveStreamError("frame received before the stream info")
                frame_number, dropped, image = parse_frame_message(frame.data)
                return Frame(
                    data=image,
                    width=self.info.width,
                    height=self.info.height,
                    format=self.info.format.value,
                    pixel_format=self.info.pixel_format,
                    bit_depth=self.info.bit_depth,
                    frame_number=frame_number,
                    dropped=dropped,
                )
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                self.closed = True
                error = close_error(*parse_close(frame.data))
                if error is not None:
                    raise error
        return None

    def close(self) -> None:
        """Stop the stream and release the camera."""
        if not self.closed:
            self.closed = True
            try:
                self._ws.close()
            except websocket.WebSocketException:
                pass

    def __iter__(self) -> Iterator[Frame]:
        return self

    def __next__(self) -> Frame:
        frame = self.read()
        if frame is None:
            raise StopIteration
        return frame

    def __enter__(self) -> "LiveStream":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"LiveStream(device_id={self.device_id}, info={self.info!r}, closed={self.closed})"
