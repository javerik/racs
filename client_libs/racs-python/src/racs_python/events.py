from typing import Iterator, Optional
from urllib.parse import urlencode

import websocket

from .errors import LiveStreamError, close_error, http_error
from .live import parse_close
from .models import Event


class EventStream:
    """
    The server's events (``GET /events``): an iterator of :class:`Event` that ends when the
    server closes the socket normally. The first event is ``hello``, with the state of every
    connected device.

    The socket keeps the session alive while it is read, since the server pings it. Raises
    SessionEndedError when the session ends, and TimeoutError when ``timeout`` passes without an
    event.
    """

    def __init__(self, url: str, session_id: str, timeout: Optional[float]):
        self.closed = False
        full_url = f"{url}?{urlencode({'session': session_id})}"
        try:
            self._ws = websocket.create_connection(full_url, timeout=timeout)
        except websocket.WebSocketBadStatusException as e:
            body = (getattr(e, "resp_body", None) or b"").decode("utf-8", "replace")
            raise http_error(e.status_code, body, url) from None

    def read(self) -> Optional[Event]:
        """The next event, or None once the socket has closed."""
        while not self.closed:
            try:
                opcode, frame = self._ws.recv_data_frame()
            except websocket.WebSocketTimeoutException as e:
                raise TimeoutError(f"no event within {self._ws.gettimeout()} s") from e
            except websocket.WebSocketConnectionClosedException as e:
                self.closed = True
                raise LiveStreamError("connection closed without a close frame") from e

            if opcode == websocket.ABNF.OPCODE_TEXT:
                return Event.model_validate_json(frame.data)
            if opcode == websocket.ABNF.OPCODE_CLOSE:
                self.closed = True
                error = close_error(*parse_close(frame.data))
                if error is not None:
                    raise error
        return None

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            try:
                self._ws.close()
            except websocket.WebSocketException:
                pass

    def __iter__(self) -> Iterator[Event]:
        return self

    def __next__(self) -> Event:
        event = self.read()
        if event is None:
            raise StopIteration
        return event

    def __enter__(self) -> "EventStream":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"EventStream(closed={self.closed})"
