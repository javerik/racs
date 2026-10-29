import threading
from enum import Enum
from typing import Callable, Iterable, List, Optional, TypeVar, Union
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import UUID

import requests

from .camera import Camera
from .errors import RacsError, SessionExpiredError, http_error
from .events import EventStream
from .live import LiveStream
from .models import (
    AutoPacketSize,
    BurstFormat,
    BurstJobCreated,
    BurstJobInfo,
    DeviceAccess,
    DeviceConnections,
    DeviceDiscoverInfo,
    DisconnectResult,
    FeatureState,
    GenICamNodeCategory,
    ImageEntry,
    LiveFormat,
    Mode,
    OnFailure,
    PacketSizeInfo,
    PixelDepth,
    SessionCreated,
    SessionInfo,
    StreamErrorInfo,
    image_entries,
)

API_PATH = "/api/v1"
SESSION_HEADER = "X-Racs-Session"

T = TypeVar("T")


def normalize_base_url(base_url: str) -> str:
    """Strip a trailing slash, and add ``/api/v1`` to a bare server URL such as ``http://host:8742``."""
    url = base_url.rstrip("/")
    if not urlsplit(url).path:
        url += API_PATH
    return url


def websocket_url(base_url: str) -> str:
    """The ``ws``/``wss`` counterpart of an ``http``/``https`` base URL."""
    parts = urlsplit(base_url)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, parts.path, "", ""))


def _segment(name: str) -> str:
    """A feature or command name as one URL path segment."""
    return quote(name, safe="")


def _wire(value: Union[str, Enum]) -> str:
    return value.value if isinstance(value, Enum) else str(value)


class RacsClient:
    """
    HTTP client for a RACS server.

    The methods here map one to one onto the REST routes and take the device id each time. For
    day-to-day use, get a :class:`Camera` from :meth:`camera`, :meth:`connect` or :meth:`cameras`
    instead: it holds the id and adds typed feature access, live streaming and burst jobs.

    The client is one session on the server, created with its first request and kept alive by a
    heartbeat thread. Other clients see it by its ``client_id`` and ``name``. If the session
    expires anyway, the client starts a new one and retries the request once. Close the client
    (or use it as a context manager) to end the session; the server ends a forgotten one after
    its timeout.
    """

    def __init__(self, base_url: str, timeout: float = 10, name: Optional[str] = None,
                 anonymous: bool = False, heartbeat: bool = True):
        """
        Initialize the client. Makes no request.

        :param base_url: The API root (e.g. "http://localhost:8742/api/v1"). A bare server URL
            such as "http://localhost:8742" gets "/api/v1" added.
        :param timeout: Request timeout in seconds.
        :param name: The session's name, shown to other clients.
        :param anonymous: Use no session, as clients before 0.4 did. Such a client may only use
            ``shared`` devices, and gets meta routes only on the others.
        :param heartbeat: Keep the session alive from a background thread between requests.
            Without it, the session ends after ``timeout_s`` without a request.
        """
        self.base_url = normalize_base_url(base_url)
        self.timeout = timeout
        self.name = name
        self.anonymous = anonymous
        self._heartbeat_enabled = heartbeat and not anonymous
        self._session = requests.Session()
        # The current session; replaced when it is renewed. Created and renewed under the lock.
        self._session_info: Optional[SessionCreated] = None
        self._session_lock = threading.Lock()
        self._closed = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None

    def close(self) -> None:
        """End the session and close the underlying HTTP connections."""
        self._closed.set()
        with self._session_lock:
            current, self._session_info = self._session_info, None
        if self._heartbeat_thread is not None and self._heartbeat_thread is not threading.current_thread():
            self._heartbeat_thread.join(timeout=self.timeout)
        if current is not None:
            try:
                self.end_session(current.session_id)
            except (RacsError, requests.RequestException):
                pass
        self._session.close()

    def __enter__(self) -> "RacsClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"RacsClient({self.base_url!r})"

    # --- SESSION ---

    @property
    def session(self) -> Optional[SessionCreated]:
        """This client's session, created if there is none yet. None for an anonymous client."""
        if self.anonymous:
            return None
        return self._current_session()

    def rename(self, name: Optional[str]) -> None:
        """Rename the session; other clients see the new name from now on."""
        self.name = name
        session = self.session
        if session is not None:
            self.rename_session(session.session_id, name)
            with self._session_lock:
                if self._session_info is not None and self._session_info.session_id == session.session_id:
                    self._session_info = self._session_info.model_copy(update={"name": name})

    def _current_session(self) -> SessionCreated:
        with self._session_lock:
            if self._session_info is None:
                self._open_session()
            return self._session_info

    def _session_id(self) -> Optional[str]:
        """The id to send with a request, or None for an anonymous client."""
        return None if self.anonymous else str(self._current_session().session_id)

    def _renew(self, stale: str) -> str:
        """
        A new session in place of ``stale``, which the server no longer knows. Concurrent callers
        holding the same stale id share one new session.
        """
        with self._session_lock:
            if self._session_info is None or str(self._session_info.session_id) == stale:
                self._open_session()
            return str(self._session_info.session_id)

    def _open_session(self) -> None:
        """Create a session (under ``_session_lock``) and start the heartbeat once."""
        if self._closed.is_set():
            raise RacsError("the client is closed")
        self._session_info = self.create_session(self.name)
        if self._heartbeat_enabled and self._heartbeat_thread is None:
            self._heartbeat_thread = threading.Thread(
                target=self._heartbeat_loop, name="racs-heartbeat", daemon=True)
            self._heartbeat_thread.start()

    def _heartbeat_loop(self) -> None:
        while True:
            with self._session_lock:
                current = self._session_info
            interval = max(1, current.heartbeat_interval_s) if current is not None else 1
            if self._closed.wait(interval):
                return
            if current is None:
                continue
            try:
                self.heartbeat(current.session_id)
            except SessionExpiredError:
                try:
                    self._renew(str(current.session_id))
                except (RacsError, requests.RequestException):
                    pass
            except (RacsError, requests.RequestException):
                # The server is unreachable for now; requests will say so.
                pass

    def _with_session(self, call: Callable[[Optional[str]], T]) -> T:
        """
        Run ``call`` with the session id; if the server no longer knows the session, run it once
        more with a new one.
        """
        session_id = self._session_id()
        try:
            return call(session_id)
        except SessionExpiredError:
            if session_id is None:
                raise
            return call(self._renew(session_id))

    # --- HELPER METHODS ---

    def _request(self, method: str, endpoint: str, *, anonymous: bool = False, **kwargs) -> requests.Response:
        """
        Send a request with the session; an error status raises the matching
        :class:`RacsHttpError`. ``anonymous`` sends it without one (the session routes).
        """
        url = f"{self.base_url}{endpoint}"
        extra_headers = kwargs.pop("headers", None) or {}

        def send(session_id: Optional[str]) -> requests.Response:
            headers = dict(extra_headers)
            if session_id is not None:
                headers[SESSION_HEADER] = session_id
            response = self._session.request(method, url, timeout=self.timeout, headers=headers, **kwargs)
            if not response.ok:
                raise http_error(response.status_code, response.text, url, response)
            return response

        if anonymous:
            return send(None)
        return self._with_session(send)

    def _get(self, endpoint: str, **kwargs):
        """Internal helper for GET requests."""
        return self._request("GET", endpoint, **kwargs)

    def _put(self, endpoint: str, **kwargs):
        """Internal helper for PUT requests."""
        return self._request("PUT", endpoint, **kwargs)

    def _post(self, endpoint: str, **kwargs):
        """Internal helper for POST requests."""
        return self._request("POST", endpoint, **kwargs)

    def _delete(self, endpoint: str, **kwargs):
        """Internal helper for DELETE requests."""
        return self._request("DELETE", endpoint, **kwargs)

    # --- CAMERA HANDLES ---

    def camera(self, device_id: int) -> Camera:
        """A handle for device ``device_id``. Makes no request; the device need not be connected yet."""
        return Camera(self, device_id)

    def connect(self, device_id: int, ip: Optional[str] = None,
                mode: Union[Mode, str, None] = None) -> Camera:
        """
        Connect device ``device_id`` (by discovery, or at ``ip``) and return its handle. With
        ``mode`` (``ro-shared`` or ``exclusive``) the session also takes the device's lease.
        """
        self.connect_device(device_id, ip, mode)
        return self.camera(device_id)

    def cameras(self) -> List[Camera]:
        """Handles for every device the server is connected to."""
        return [self.camera(d.id) for d in self.get_connected_devices()]

    # --- SESSIONS AND EVENTS ---

    def create_session(self, name: Optional[str] = None, timeout_s: Optional[int] = None) -> SessionCreated:
        """
        Create a session. The client creates its own; this is for a second one.
        POST /sessions
        """
        body = {}
        if name is not None:
            body["name"] = name
        if timeout_s is not None:
            body["timeout_s"] = timeout_s
        response = self._post("/sessions", json=body, anonymous=True)
        return SessionCreated.model_validate(response.json())

    def heartbeat(self, session_id: Union[UUID, str]) -> None:
        """
        Keep a session alive. Raises SessionExpiredError once it has ended.
        POST /sessions/{session_id}/heartbeat
        """
        self._post(f"/sessions/{session_id}/heartbeat", anonymous=True)

    def rename_session(self, session_id: Union[UUID, str], name: Optional[str]) -> None:
        """
        Rename a session.
        PATCH /sessions/{session_id}
        """
        self._request("PATCH", f"/sessions/{session_id}", json={"name": name}, anonymous=True)

    def end_session(self, session_id: Union[UUID, str]) -> None:
        """
        End a session now: its leases are released and its live streams closed.
        DELETE /sessions/{session_id}
        """
        self._delete(f"/sessions/{session_id}", anonymous=True)

    def list_sessions(self) -> List[SessionInfo]:
        """
        The server's sessions, without their secret ids.
        GET /sessions
        """
        response = self._get("/sessions")
        return [SessionInfo.model_validate(s) for s in response.json()]

    def events(self, timeout: Optional[float] = None) -> EventStream:
        """
        Subscribe to the server's events: device state changes, feature writes and commands by
        any client, revoked access and ended sessions. Needs a session.

        :param timeout: Seconds to wait for each event; None waits for ever.
        GET /events (WebSocket)
        """
        url = f"{websocket_url(self.base_url)}/events"
        session_id = self._session_id()
        if session_id is None:
            raise RacsError("events need a session; this client is anonymous")
        try:
            return EventStream(url, session_id, timeout)
        except SessionExpiredError:
            return EventStream(url, self._renew(session_id), timeout)

    # --- DEVICE OPERATIONS ---

    def get_devices(self) -> DeviceConnections:
        """
        Discovers devices in the network and shows connected devices.
        GET /devices
        """
        response = self._get("/devices")
        return DeviceConnections.model_validate(response.json())

    def get_connected_devices(self) -> List[DeviceDiscoverInfo]:
        """
        Lists the devices the server is connected to, without running a network discovery.
        GET /devices/connected
        """
        response = self._get("/devices/connected")
        return [DeviceDiscoverInfo.model_validate(d) for d in response.json()]

    def connect_device(self, device_id: int, ip: Optional[str] = None,
                       mode: Union[Mode, str, None] = None) -> DeviceAccess:
        """
        Connect to a specific device, and with ``mode`` take its lease in the same step.

        Can connect to a device by specifying the IP address. The device_id has to be set as well, which will is needed for later operations.
        Without ``mode`` the client joins the device in its current mode.

        PUT /devices/{id}/connect
        """
        params = {}
        if ip is not None:
            params["ip"] = ip
        if mode is not None:
            params["mode"] = _wire(mode)
        response = self._put(f"/devices/{device_id}/connect", params=params or None)
        return DeviceAccess.model_validate(response.json())

    def disconnect_device(self, device_id: int, force: bool = False) -> DisconnectResult:
        """
        Leave a device; the server closes it once nobody else uses it. ``force`` closes it for
        everyone (needs write access).
        PUT /devices/{id}/disconnect
        """
        params = {"force": "true"} if force else None
        response = self._put(f"/devices/{device_id}/disconnect", params=params)
        return DisconnectResult.model_validate(response.json())

    def get_device_access(self, device_id: int) -> DeviceAccess:
        """
        Who may use a device and who does, and this client's role.
        GET /devices/{id}/access
        """
        response = self._get(f"/devices/{device_id}/access")
        return DeviceAccess.model_validate(response.json())

    def set_device_access(self, device_id: int, mode: Union[Mode, str], force: bool = False) -> DeviceAccess:
        """
        Take or change a device's lease (``shared`` gives it up). ``force`` takes it from another
        session, and for ``exclusive`` evicts the other clients.
        PUT /devices/{id}/access
        """
        response = self._put(f"/devices/{device_id}/access", json={"mode": _wire(mode), "force": force})
        return DeviceAccess.model_validate(response.json())

    def release_device_access(self, device_id: int, force: bool = False) -> DeviceAccess:
        """
        Release this session's lease, or with ``force`` break another session's. The device is
        ``shared`` again.
        DELETE /devices/{id}/access
        """
        params = {"force": "true"} if force else None
        response = self._delete(f"/devices/{device_id}/access", params=params)
        return DeviceAccess.model_validate(response.json())

    def get_device_xml(self, device_id: int) -> str:
        """
        Get the device XML description file.
        GET /devices/{id}/xml
        """
        response = self._get(f"/devices/{device_id}/xml")
        # The spec says content-type is application/xml, returning string directly
        return response.text

    # --- GENICAM OPERATIONS ---

    def get_device_gc_categories(self, device_id: int) -> List[GenICamNodeCategory]:
        """
        Get GenICam categories with feature node info.
        GET /devices/{id}/gc/categories
        """
        response = self._get(f"/devices/{device_id}/gc/categories")
        data = response.json()
        # Parse list of objects
        return [GenICamNodeCategory.model_validate(item) for item in data]

    def get_device_gc_node_value(self, device_id: int, feature_name: str) -> str:
        """
        Get a specific GenICam feature value.
        GET /devices/{id}/gc/feature/{feature_name}
        """
        response = self._get(f"/devices/{device_id}/gc/feature/{_segment(feature_name)}")
        return response.text

    def set_device_gc_node_value(self, device_id: int, feature_name: str, value: str) -> None:
        """
        Set a specific GenICam feature value.
        PUT /devices/{id}/gc/feature/{feature_name}
        """
        # 'value' is passed as a query parameter per the spec
        self._put(
            f"/devices/{device_id}/gc/feature/{_segment(feature_name)}",
            params={"value": value}
        )

    def get_device_gc_feature_states(self, device_id: int, names: Iterable[str]) -> List[FeatureState]:
        """
        Get the live state of 1 to 256 features in one request, in the order asked. A problem
        with one feature is reported in that entry's ``error``.
        POST /devices/{id}/gc/features/state
        """
        response = self._post(f"/devices/{device_id}/gc/features/state", json={"names": list(names)})
        return [FeatureState.model_validate(item) for item in response.json()]

    def execute_device_gc_command(self, device_id: int, command_name: str) -> None:
        """
        Execute a GenICam command feature such as TriggerSoftware.
        POST /devices/{id}/gc/command/{command_name}
        """
        self._post(f"/devices/{device_id}/gc/command/{_segment(command_name)}")

    # --- STREAMING OPERATIONS ---

    def grab_jpg_frame(self, device_id: int, quality: Optional[int] = None) -> bytes:
        """
        Grab a single frame as JPEG, at ``quality`` 1-100 (the server's default is 80).

        PixelFormat is automatically set to MONO_8
        GET /devices/{id}/stream/frame/jpeg
        """
        params = {"quality": quality} if quality is not None else None
        response = self._get(f"/devices/{device_id}/stream/frame/jpeg", params=params)
        # Spec defines content as octet-stream/array of bytes
        return response.content

    def grab_raw_frame(self, device_id: int) -> bytes:
        """
        Grab a single frame as RAW data: Width*Height bytes (Mono8).
        GET /devices/{id}/stream/frame/raw
        """
        response = self._get(f"/devices/{device_id}/stream/frame/raw")
        return response.content

    def get_stream_error(self, device_id: int) -> StreamErrorInfo:
        """
        Why the last live stream on the device ended, and whether one runs now.
        GET /devices/{id}/stream/error
        """
        response = self._get(f"/devices/{device_id}/stream/error")
        return StreamErrorInfo.model_validate(response.json())

    def get_packet_size(self, device_id: int) -> PacketSizeInfo:
        """
        The stream packet size (GevSCPSPacketSize), its bounds and the link MTU. Set it with
        ``set_device_gc_node_value(id, "GevSCPSPacketSize", ...)``.
        GET /devices/{id}/stream/packet-size
        """
        response = self._get(f"/devices/{device_id}/stream/packet-size")
        return PacketSizeInfo.model_validate(response.json())

    def auto_packet_size(self, device_id: int) -> AutoPacketSize:
        """
        Find the largest packet size that reaches the server, with test packets, and set it.
        Works during a live stream too, which carries on with the new size.
        POST /devices/{id}/stream/packet-size/auto
        """
        response = self._post(f"/devices/{device_id}/stream/packet-size/auto")
        return AutoPacketSize.model_validate(response.json())

    def stream_live(
        self,
        device_id: int,
        format: Union[LiveFormat, str] = LiveFormat.JPEG,
        pixel_depth: Union[PixelDepth, str, None] = None,
        quality: Optional[int] = None,
        fps: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> LiveStream:
        """
        Open the live-stream WebSocket. The camera is held until the stream is closed; a stream
        of a device that already streams joins that capture, in its pixel depth.

        :param timeout: Seconds to wait for each frame; defaults to the client timeout.
        GET /devices/{id}/stream/live (WebSocket)
        """
        params = {"format": _wire(format)}
        if pixel_depth is not None:
            params["pixel_depth"] = _wire(pixel_depth)
        if quality is not None:
            params["quality"] = str(quality)
        if fps is not None:
            params["fps"] = str(fps)

        def open_stream(session_id: Optional[str]) -> LiveStream:
            query = dict(params, session=session_id) if session_id is not None else params
            return LiveStream(
                self,
                device_id,
                f"{websocket_url(self.base_url)}/devices/{device_id}/stream/live",
                query,
                self.timeout if timeout is None else timeout,
            )

        return self._with_session(open_stream)

    # --- BURST JOBS ---

    def start_grab_job(
        self,
        device_id: int,
        count: int,
        format: Union[BurstFormat, str] = BurstFormat.RAW,
        pixel_depth: Union[PixelDepth, str, None] = None,
        quality: Optional[int] = None,
        on_failure: Union[OnFailure, str, None] = None,
        max_failures: Optional[int] = None,
    ) -> BurstJobCreated:
        """
        Start a background burst of ``count`` (1-500) frames. Returns before the capture starts:
        a busy camera shows up as a job that fails.
        POST /devices/{id}/grab/jobs
        """
        body = {"count": count, "format": _wire(format)}
        if pixel_depth is not None:
            body["pixel_depth"] = _wire(pixel_depth)
        if quality is not None:
            body["quality"] = quality
        if on_failure is not None:
            body["on_failure"] = _wire(on_failure)
        if max_failures is not None:
            body["max_failures"] = max_failures
        response = self._post(f"/devices/{device_id}/grab/jobs", json=body)
        return BurstJobCreated.model_validate(response.json())

    def get_grab_job(self, device_id: int, job_id: Union[UUID, str]) -> BurstJobInfo:
        """
        A burst job's progress.
        GET /devices/{id}/grab/jobs/{job_id}
        """
        response = self._get(f"/devices/{device_id}/grab/jobs/{job_id}")
        return BurstJobInfo.model_validate(response.json())

    def list_grab_job_images(self, device_id: int, job_id: Union[UUID, str]) -> List[ImageEntry]:
        """
        The frames a burst job has attempted so far, in capture order.
        GET /devices/{id}/grab/jobs/{job_id}/images
        """
        response = self._get(f"/devices/{device_id}/grab/jobs/{job_id}/images")
        return image_entries.validate_python(response.json())

    def get_grab_job_image(self, device_id: int, job_id: Union[UUID, str], index: int) -> bytes:
        """
        One captured frame, in the job's format. Raises NotFoundError for an index not captured
        (yet) and ImageFailedError for one that failed.
        GET /devices/{id}/grab/jobs/{job_id}/images/{index}
        """
        response = self._get(f"/devices/{device_id}/grab/jobs/{job_id}/images/{index}")
        return response.content

    def delete_grab_job(self, device_id: int, job_id: Union[UUID, str]) -> None:
        """
        Cancel a running burst job or discard a finished one, with its images.
        DELETE /devices/{id}/grab/jobs/{job_id}
        """
        self._delete(f"/devices/{device_id}/grab/jobs/{job_id}")
