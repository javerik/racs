from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional, Union
from uuid import UUID

from .burst import BurstJob
from .errors import FeatureError, RacsError
from .frame import Frame
from .models import (
    AutoPacketSize,
    BurstFormat,
    DeviceAccess,
    DeviceDiscoverInfo,
    DisconnectResult,
    FeatureState,
    GenICamNodeCategory,
    GenICamNodeInfo,
    GenICamNodeType,
    LiveFormat,
    Mode,
    OnFailure,
    PacketSizeInfo,
    PixelDepth,
    StreamErrorInfo,
)

if TYPE_CHECKING:
    from .client import RacsClient
    from .live import LiveStream

FeatureValue = Union[int, float, bool, str, None]


def _names(names: tuple) -> List[str]:
    """Accept both ``states("A", "B")`` and ``states(["A", "B"])``."""
    if len(names) == 1 and not isinstance(names[0], str):
        return list(names[0])
    return list(names)


def feature_value(state: FeatureState) -> FeatureValue:
    """
    A feature state's value as a Python value: int for Integer and Enum (enums are read as their
    integer value), float, bool or str. None for a command or an unavailable feature.
    """
    if state.error:
        raise FeatureError(state.name, state.error)
    if state.value is None:
        return None
    if state.node_type in (GenICamNodeType.INTEGER, GenICamNodeType.ENUM):
        return int(state.value)
    if state.node_type == GenICamNodeType.FLOAT:
        return float(state.value)
    if state.node_type == GenICamNodeType.BOOLEAN:
        return state.value.lower() == "true"
    return state.value


def format_value(value: Any) -> str:
    """A Python value in the form the server parses: ``true``/``false`` for bools, else ``str()``."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class Camera:
    """
    One device on a RACS server. Every call goes to the server; the handle only holds the id.

    Get one from :meth:`RacsClient.camera`, :meth:`RacsClient.connect` or :meth:`RacsClient.cameras`::

        cam = client.connect(0)
        cam["ExposureTime"] = 5000
        width = cam["Width"]
    """

    def __init__(self, client: "RacsClient", device_id: int):
        self.client = client
        self.id = device_id
        self._categories: Optional[List[GenICamNodeCategory]] = None

    def __repr__(self) -> str:
        return f"Camera(id={self.id}, server={self.client.base_url!r})"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Camera) and other.client is self.client and other.id == self.id

    def __hash__(self) -> int:
        return hash((id(self.client), self.id))

    # --- CONNECTION ---

    def info(self) -> DeviceDiscoverInfo:
        """The device's identity as the server reports it. Raises RacsError if it is not connected."""
        for device in self.client.get_connected_devices():
            if device.id == self.id:
                return device
        raise RacsError(f"device {self.id} is not connected")

    def is_connected(self) -> bool:
        return any(d.id == self.id for d in self.client.get_connected_devices())

    def connect(self, ip: Optional[str] = None, mode: Union[Mode, str, None] = None) -> "Camera":
        """
        Connect the device, by discovery or at ``ip``. Does nothing if it is connected already.
        With ``mode`` (``ro-shared`` or ``exclusive``) the session also takes its lease, as
        :meth:`take` does; without, it joins the device in its current mode.
        """
        self.client.connect_device(self.id, ip, mode)
        self._categories = None
        return self

    def disconnect(self, force: bool = False) -> DisconnectResult:
        """
        Leave the device; the server closes it once no other client uses it. ``force`` closes it
        for everyone.
        """
        result = self.client.disconnect_device(self.id, force)
        self._categories = None
        return result

    # --- ACCESS ---

    def access(self) -> DeviceAccess:
        """The device's mode, its owner, members, holder and viewers, and this client's role (``you``)."""
        return self.client.get_device_access(self.id)

    def take(self, mode: Union[Mode, str], force: bool = False) -> DeviceAccess:
        """
        Take the device's lease: ``ro-shared`` (other sessions only read) or ``exclusive`` (only
        this session uses it). Raises DeviceLockedError if another session owns it and
        DeviceInUseError if others use it for ``exclusive``; ``force`` takes it anyway, and for
        ``exclusive`` closes the other clients' streams and cancels their bursts.
        """
        return self.client.set_device_access(self.id, mode, force)

    def release(self, force: bool = False) -> DeviceAccess:
        """Give up the lease (``force``: break another session's). The device is ``shared`` again."""
        return self.client.release_device_access(self.id, force)

    def xml(self) -> str:
        """The device's GenICam XML."""
        return self.client.get_device_xml(self.id)

    def categories(self, refresh: bool = False) -> List[GenICamNodeCategory]:
        """The GenICam categories and their features. Cached: they don't change while connected."""
        if self._categories is None or refresh:
            self._categories = self.client.get_device_gc_categories(self.id)
        return self._categories

    def feature_info(self, name: str) -> GenICamNodeInfo:
        """A feature's description from :meth:`categories`: type, access, enum entries, ..."""
        for category in self.categories():
            for node in category.nodes:
                if node.name == name:
                    return node
        raise FeatureError(name, "Feature not found")

    # --- FEATURES ---

    def state(self, name: str) -> FeatureState:
        """A feature's live state: value, availability, lock, bounds."""
        return self.states(name)[0]

    def states(self, *names: Union[str, Iterable[str]]) -> List[FeatureState]:
        """The live state of several features in one request, in the order asked."""
        return self.client.get_device_gc_feature_states(self.id, _names(names))

    def get(self, name: str) -> FeatureValue:
        """
        A feature's value, typed by the feature: int (Integer, Enum), float, bool or str. None
        for a command or a feature that is unavailable right now. Raises FeatureError for an
        unknown feature or a failed read.
        """
        return feature_value(self.state(name))

    def get_many(self, *names: Union[str, Iterable[str]]) -> Dict[str, FeatureValue]:
        """Several typed values in one request, as ``{name: value}``."""
        return {s.name: feature_value(s) for s in self.states(*names)}

    def set(self, name: str, value: Any) -> None:
        """
        Write a feature: an int or float for numbers, a bool for Boolean, an int or the entry
        name for an Enum, a str for String.
        """
        self.client.set_device_gc_node_value(self.id, name, format_value(value))

    def execute(self, command: str) -> None:
        """Execute a command feature such as ``TriggerSoftware`` or ``UserSetLoad``."""
        self.client.execute_device_gc_command(self.id, command)

    def __getitem__(self, name: str) -> FeatureValue:
        return self.get(name)

    def __setitem__(self, name: str, value: Any) -> None:
        self.set(name, value)

    # --- FRAMES ---

    def grab_jpeg(self, quality: Optional[int] = None) -> bytes:
        """One frame as a JPEG file (Mono8)."""
        return self.client.grab_jpg_frame(self.id, quality)

    def grab_raw(self) -> Frame:
        """One raw Mono8 frame with its size."""
        data = self.client.grab_raw_frame(self.id)
        size = self.get_many("Width", "Height")
        width, height = int(size["Width"]), int(size["Height"])
        if len(data) != width * height:
            raise RacsError(f"raw frame of {len(data)} bytes does not match {width}x{height}; was the size changed?")
        return Frame(data=data, width=width, height=height)

    def stream_error(self) -> StreamErrorInfo:
        """Why the last live stream ended, and whether one runs now."""
        return self.client.get_stream_error(self.id)

    def packet_size(self) -> PacketSizeInfo:
        """
        The stream packet size, the sizes it may take and the link MTU. Every grab, stream and
        burst uses it as it is; change it with ``cam["GevSCPSPacketSize"] = 7960`` or
        :meth:`auto_packet_size`.
        """
        return self.client.get_packet_size(self.id)

    def auto_packet_size(self) -> AutoPacketSize:
        """Find the largest packet size that reaches the server, with test packets, and set it."""
        return self.client.auto_packet_size(self.id)

    def live(
        self,
        format: Union[LiveFormat, str] = LiveFormat.JPEG,
        pixel_depth: Union[PixelDepth, str, None] = None,
        quality: Optional[int] = None,
        fps: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> "LiveStream":
        """
        Start a live stream; iterate it for frames and close it when done::

            with cam.live(format="raw", pixel_depth="mono16", fps=10) as stream:
                for frame in stream:
                    pixels = frame.to_numpy()
        """
        return self.client.stream_live(self.id, format, pixel_depth, quality, fps, timeout)

    def burst(
        self,
        count: int,
        format: Union[BurstFormat, str] = BurstFormat.RAW,
        pixel_depth: Union[PixelDepth, str, None] = None,
        quality: Optional[int] = None,
        on_failure: Union[OnFailure, str, None] = None,
        max_failures: Optional[int] = None,
    ) -> BurstJob:
        """Start a background burst of ``count`` (1-500) frames on the server."""
        created = self.client.start_grab_job(
            self.id, count, format, pixel_depth, quality, on_failure, max_failures)
        return BurstJob(self, created.job_id)

    def job(self, job_id: Union[UUID, str]) -> BurstJob:
        """A handle for an existing burst job of this device."""
        return BurstJob(self, job_id)
