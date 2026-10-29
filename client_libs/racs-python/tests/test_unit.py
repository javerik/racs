"""Tests that need no server."""
import json
import struct
import sys

import numpy as np
import pytest
import requests

from racs_python import (
    AccessRevokedError,
    BurstJobInfo,
    CameraBusyError,
    DeviceDiscoverInfo,
    DeviceInUseError,
    DeviceLockedError,
    Event,
    EventType,
    FeatureError,
    FeatureState,
    Frame,
    ImageEntryFailed,
    ImageEntryOk,
    ImageFailedError,
    JobStatus,
    LiveStreamError,
    Mode,
    NotFoundError,
    RacsClient,
    RacsHttpError,
    ReadOnlyError,
    Role,
    SessionEndedError,
    SessionExpiredError,
)
from racs_python.camera import _names, feature_value, format_value
from racs_python.client import normalize_base_url, websocket_url
from racs_python.errors import close_error, http_error
from racs_python.live import parse_close, parse_frame_message
from racs_python.models import image_entries


@pytest.mark.parametrize("given, expected", [
    ("http://host:8742", "http://host:8742/api/v1"),
    ("http://host:8742/", "http://host:8742/api/v1"),
    ("http://host:8742/api/v1/", "http://host:8742/api/v1"),
    ("https://proxy/racs/api/v1", "https://proxy/racs/api/v1"),
])
def test_base_url_is_normalized(given, expected):
    assert normalize_base_url(given) == expected


def test_websocket_url_follows_the_http_scheme():
    assert websocket_url("http://host:8742/api/v1") == "ws://host:8742/api/v1"
    assert websocket_url("https://proxy/racs/api/v1") == "wss://proxy/racs/api/v1"


def test_a_frame_message_is_two_le_counters_then_the_image():
    msg = struct.pack("<II", 1, 258) + b"\xaa\xbb"
    assert parse_frame_message(msg) == (1, 258, b"\xaa\xbb")
    with pytest.raises(LiveStreamError):
        parse_frame_message(b"\x00\x01")


def test_a_close_payload_is_a_code_then_the_reason():
    assert parse_close(struct.pack(">H", 1011) + b"camera gone") == (1011, "camera gone")
    assert parse_close(b"") == (None, "")


def test_image_entries_are_told_apart_by_status():
    entries = image_entries.validate_python([
        {"status": "ok", "index": 0, "size_bytes": 12},
        {"status": "failed", "index": 1, "error": "timeout"},
    ])
    assert isinstance(entries[0], ImageEntryOk) and entries[0].size_bytes == 12
    assert isinstance(entries[1], ImageEntryFailed) and entries[1].error == "timeout"


def test_burst_job_info_parses_server_timestamps():
    info = BurstJobInfo.model_validate({
        "job_id": "27bb2837-6279-4cdc-8936-233185be172d", "device_id": 0, "status": "running",
        "format": "raw", "requested_count": 5, "captured_count": 1, "failed_count": 0,
        "created_at": "2026-10-04T09:19:08.123456789Z", "started_at": "2026-10-04T09:19:08.2Z",
        "completed_at": None, "expires_at": None, "error": None,
        "width": 64, "height": 32, "pixel_format": "Mono8", "bit_depth": 8,
    })
    assert info.status == JobStatus.RUNNING and not info.status.is_terminal
    assert info.created_at.year == 2026


def test_to_numpy_follows_the_bit_depth():
    eight = Frame(data=bytes(range(6)), width=3, height=2)
    assert eight.to_numpy().dtype == np.uint8
    assert eight.to_numpy().shape == (2, 3)

    sixteen = Frame(data=struct.pack("<3H", 1, 4095, 256), width=3, height=1, bit_depth=12)
    assert sixteen.to_numpy().dtype == np.uint16
    assert sixteen.to_numpy().tolist() == [[1, 4095, 256]]


def _zstd(content: bytes) -> bytes:
    try:
        from compression import zstd
        return zstd.compress(content)
    except ImportError:
        import zstandard
        return zstandard.ZstdCompressor().compress(content)


def test_zstd_frames_decode_to_the_pixels():
    # Each residual is the pixel minus the one above, wrapping; 16-bit ones are zigzagged and
    # stored as low bytes, then high bytes. Row 0: zigzag(300) = 600, zigzag(5) = 10;
    # row 1: -1 -> 1, +1 -> 2.
    eight = Frame(data=_zstd(bytes([10, 20, 3, 254])), width=2, height=2, format="zstd")
    assert eight.to_numpy().tolist() == [[10, 20], [13, 18]]
    assert eight.to_numpy().dtype == np.uint8

    twelve = Frame(data=_zstd(bytes([88, 10, 1, 2, 2, 0, 0, 0])), width=2, height=2, format="zstd", bit_depth=12)
    assert twelve.to_numpy().tolist() == [[300, 5], [299, 6]]
    assert twelve.to_numpy().dtype == np.uint16

    # 65535 is -1 from 0, and 0 is +1 from 65535.
    wrap = Frame(data=_zstd(bytes([0, 1, 1, 2, 0, 0, 0, 0])), width=2, height=2, format="zstd", bit_depth=16)
    assert wrap.to_numpy().tolist() == [[0, 65535], [65535, 0]]


def test_zstd_frames_decode_with_the_zstandard_package_too(monkeypatch):
    # What Python before 3.14 uses; hide the built-in module to take that path here.
    pytest.importorskip("zstandard")
    payload = _zstd(bytes([10, 20, 3, 254]))
    monkeypatch.setitem(sys.modules, "compression.zstd", None)
    assert Frame(data=payload, width=2, height=2, format="zstd").to_numpy().tolist() == [[10, 20], [13, 18]]
    with pytest.raises(ValueError):
        Frame(data=b"not zstd", width=2, height=2, format="zstd").to_numpy()


def test_to_raw_decodes_a_zstd_frame():
    zstd_frame = Frame(data=_zstd(bytes([88, 10, 1, 2, 2, 0, 0, 0])), width=2, height=2, format="zstd",
                       bit_depth=12, frame_number=7)
    raw = zstd_frame.to_raw()
    assert (raw.format, raw.frame_number) == ("raw", 7)
    assert raw.data == struct.pack("<4H", 300, 5, 299, 6)
    assert raw.to_raw() is raw
    with pytest.raises(ValueError):
        Frame(data=b"\xff\xd8", width=1, height=1, format="jpeg").to_raw()


def test_a_bad_zstd_frame_is_a_value_error():
    payload = _zstd(bytes(6))
    with pytest.raises(ValueError, match="needs"):
        Frame(data=payload, width=2, height=2, format="zstd").to_numpy()
    with pytest.raises(ValueError):
        Frame(data=b"not zstd", width=2, height=2, format="zstd").to_numpy()
    with pytest.raises(ValueError):
        Frame(data=payload[:-3], width=2, height=3, format="zstd").to_numpy()


def test_to_numpy_refuses_what_it_cannot_decode():
    with pytest.raises(ValueError):
        Frame(data=b"\xff\xd8", width=1, height=1, format="jpeg").to_numpy()
    with pytest.raises(ValueError):
        Frame(data=b"\x00", width=2, height=2).to_numpy()


def test_error_responses_map_to_specific_exceptions():
    assert type(http_error(500, "Error: StoreError(Busy(0))", "u")) is CameraBusyError
    assert type(http_error(404, "no job", "u")) is NotFoundError
    assert type(http_error(410, "timeout", "u")) is ImageFailedError
    assert type(http_error(500, "Error: DevCtrlError(NotDiscovered(9))", "u")) is RacsHttpError

    import requests
    # Callers of earlier versions caught requests' exception; they still can.
    assert isinstance(http_error(500, "x", "u"), requests.HTTPError)


OWNER = {"client_id": "3f2a9c1e", "name": "line-script"}


def test_refusals_map_to_their_exceptions_with_the_parsed_body():
    expired = http_error(401, '{"error":"session_expired"}', "u")
    assert type(expired) is SessionExpiredError
    assert expired.refusal.error == "session_expired"

    read_only = http_error(403, json.dumps({"error": "read_only", "mode": "ro-shared", "owner": OWNER}), "u")
    assert type(read_only) is ReadOnlyError
    assert (read_only.refusal.mode, read_only.refusal.owner.client_id) == (Mode.RO_SHARED, "3f2a9c1e")

    in_use = http_error(409, json.dumps({
        "error": "device_in_use", "mode": "shared", "owner": None,
        "members": [{"client_id": "77d0aa12", "name": None}],
        "holder": {"kind": "live", "client_id": None},
    }), "u")
    assert type(in_use) is DeviceInUseError
    assert [m.client_id for m in in_use.refusal.members] == ["77d0aa12"]
    assert in_use.refusal.holder.client_id is None

    locked = http_error(423, json.dumps({"error": "device_locked", "mode": "exclusive", "owner": OWNER}), "u")
    assert type(locked) is DeviceLockedError
    assert locked.refusal.owner.name == "line-script"

    required = http_error(400, '{"error":"session_required"}', "u")
    assert type(required) is RacsHttpError
    assert required.refusal.error == "session_required"


def test_a_body_that_is_no_refusal_parses_to_none():
    assert http_error(500, "Error: StoreError(Busy(0))", "u").refusal is None
    assert http_error(403, "Forbidden", "u").refusal is None
    assert type(http_error(403, "Forbidden", "u")) is ReadOnlyError
    assert http_error(400, "{not json", "u").refusal is None


def test_close_codes_map_to_their_exceptions():
    assert close_error(1000, "") is None
    assert close_error(1001, "device disconnected") is None
    assert close_error(None, "") is None
    ended = close_error(4001, "session expired")
    assert type(ended) is SessionEndedError and ended.code == 4001
    revoked = close_error(4003, "access revoked")
    assert type(revoked) is AccessRevokedError and str(revoked) == "access revoked"
    assert isinstance(revoked, LiveStreamError)
    failed = close_error(1011, "")
    assert type(failed) is LiveStreamError and failed.reason == "stream closed with code 1011"


def test_events_parse_by_type():
    hello = Event.model_validate_json(json.dumps({
        "seq": 3, "time": "2026-10-08T19:30:00.123Z", "type": "hello",
        "session": {"client_id": "3f2a9c1e", "timeout_s": 30},
        "devices": [{"device": 0, "connected": True,
                     "access": {"mode": "exclusive", "owner": OWNER, "members": [OWNER]},
                     "stream": {"viewers": 2, "pixel_format": "Mono8", "bit_depth": 8}, "burst": None}],
    }))
    assert hello.type == EventType.HELLO and hello.type == "hello"
    assert hello.session.client_id == "3f2a9c1e"
    assert hello.devices[0].access.mode == Mode.EXCLUSIVE
    assert hello.devices[0].stream.viewers == 2

    state = Event.model_validate_json(json.dumps({
        "seq": 4, "time": "2026-10-08T19:30:01.000Z", "type": "device_state",
        "device": 0, "connected": False, "access": {"mode": "shared", "owner": None, "members": []},
        "stream": None, "burst": None, "cause": "disconnected", "reason": "idle", "by": None,
    }))
    assert (state.cause, state.reason) == ("disconnected", "idle")
    assert state.state.connected is False and state.state.device == 0

    changed = Event.model_validate_json(json.dumps({
        "seq": 5, "time": "2026-10-08T19:30:02.000Z", "type": "feature_changed",
        "device": 0, "feature": "ExposureTime", "by": OWNER,
    }))
    assert (changed.feature, changed.by.client_id, changed.state) == ("ExposureTime", "3f2a9c1e", None)

    # A type this version doesn't know still arrives, with its fields.
    future = Event.model_validate_json('{"seq":6,"time":"2026-10-08T19:30:03Z","type":"later","extra":1}')
    assert future.type == "later" and future.model_extra == {"extra": 1}


def test_connected_devices_carry_their_access():
    entry = DeviceDiscoverInfo.model_validate({
        "id": 0, "dev_id": "d", "serial_number": "s", "vendor": "v", "model": "m",
        "manufacturer_info": "i", "ip": "127.0.0.1", "mac": "00:00:00:00:00:00",
        "access": {"device": 0, "mode": "ro-shared", "owner": OWNER, "members": [OWNER],
                   "holder": None, "viewers": 0, "you": "reader"},
    })
    assert entry.access.you == Role.READER


class FakeHttp:
    """Stands in for the client's ``requests.Session``: answers from a script, records what it was sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.sent = []

    def request(self, method, url, timeout=None, headers=None, **kwargs):
        self.sent.append((method, url.split("/api/v1", 1)[1], dict(headers or {})))
        status, body = self.answers.pop(0)
        response = requests.Response()
        response.status_code = status
        response._content = json.dumps(body).encode() if body is not None else b""
        response.url = url
        return response

    def close(self):
        pass


def _created(n):
    return 201, {"session_id": f"00000000-0000-0000-0000-00000000000{n}", "client_id": f"c{n}",
                 "name": "t", "timeout_s": 30, "heartbeat_interval_s": 10}


ACCESS = {"device": 0, "mode": "shared", "owner": None, "members": [], "holder": None, "viewers": 0, "you": "writer"}


def test_a_client_creates_its_session_with_the_first_request_and_ends_it_on_close():
    client = RacsClient("http://host:8742", name="t", heartbeat=False)
    client._session = http = FakeHttp(_created(1), (200, ACCESS), (204, None))
    assert http.sent == [], "the constructor makes no request"
    client.camera(0).access()
    client.close()
    assert [(m, path) for m, path, _ in http.sent] == [
        ("POST", "/sessions"),
        ("GET", "/devices/0/access"),
        ("DELETE", "/sessions/00000000-0000-0000-0000-000000000001"),
    ]
    assert "X-Racs-Session" not in http.sent[0][2]
    assert http.sent[1][2]["X-Racs-Session"] == "00000000-0000-0000-0000-000000000001"


def test_a_401_renews_the_session_and_retries_once():
    client = RacsClient("http://host:8742", heartbeat=False)
    client._session = http = FakeHttp(
        _created(1), (401, {"error": "session_expired"}), _created(2), (200, ACCESS),
        (401, {"error": "session_expired"}), _created(3), (401, {"error": "session_expired"}),
    )
    assert client.camera(0).access().you == Role.WRITER
    assert client.session.client_id == "c2"
    assert http.sent[3][2]["X-Racs-Session"].endswith("2")
    # Retried once only.
    with pytest.raises(SessionExpiredError):
        client.camera(0).access()


def test_an_anonymous_client_sends_no_session():
    client = RacsClient("http://host:8742", anonymous=True)
    client._session = http = FakeHttp((200, ACCESS))
    client.camera(0).access()
    client.close()
    assert [(m, path, h) for m, path, h in http.sent] == [("GET", "/devices/0/access", {})]


def _state(node_type, value, error=None):
    return FeatureState(name="F", node_type=node_type, value=value, available=True, locked=False, error=error)


def test_feature_values_are_typed_by_node_type():
    assert feature_value(_state("Integer", "64")) == 64
    assert feature_value(_state("Enum", "3")) == 3
    assert feature_value(_state("Float", "1234")) == 1234.0
    assert isinstance(feature_value(_state("Float", "1234")), float)
    assert feature_value(_state("Boolean", "true")) is True
    assert feature_value(_state("Boolean", "false")) is False
    assert feature_value(_state("String", "abc")) == "abc"
    assert feature_value(_state("Command", None)) is None
    with pytest.raises(FeatureError):
        feature_value(_state(None, None, "Feature not found"))


def test_values_are_written_as_the_server_parses_them():
    assert format_value(True) == "true"
    assert format_value(False) == "false"
    assert format_value(640) == "640"
    assert format_value(2.5) == "2.5"
    assert format_value("Mono8") == "Mono8"


def test_names_accept_varargs_or_one_list():
    assert _names(("A", "B")) == ["A", "B"]
    assert _names((["A", "B"],)) == ["A", "B"]
    assert _names(("A",)) == ["A"]
