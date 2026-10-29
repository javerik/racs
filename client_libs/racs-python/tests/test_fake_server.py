"""Tests against `examples/fake_server.rs`; skipped unless RACS_TEST_URL points at one."""
import time
from itertools import islice

import numpy as np
import pytest

from conftest import HEIGHT, WIDTH
from racs_python import (
    AccessRevokedError,
    BurstFormat,
    BurstJobFailedError,
    CameraBusyError,
    DeviceInUseError,
    DeviceLockedError,
    EventType,
    FeatureError,
    GenICamNodeType,
    JobStatus,
    HolderKind,
    LiveFormat,
    Mode,
    NotFoundError,
    PixelDepth,
    RacsClient,
    RacsError,
    RacsHttpError,
    ReadOnlyError,
    Role,
    SessionEndedError,
)


def test_connected_devices_are_listed(client):
    assert 0 in {c.id for c in client.cameras()}
    info = client.camera(0).info()
    assert info.id == 0
    assert info.ip == "127.0.0.1"
    assert 0 in {d.id for d in client.get_devices().connected}


def test_a_bare_server_url_reaches_the_api(server_url):
    with RacsClient(server_url[: -len("/api/v1")]) as client:
        assert client.camera(0).is_connected()


def test_features_read_and_write_as_python_values(cam):
    assert cam["Width"] == WIDTH
    assert isinstance(cam["Width"], int)

    cam.set("ExposureTime", 2500)
    assert cam.get("ExposureTime") == 2500.0
    assert isinstance(cam.get("ExposureTime"), float)

    cam["ReverseX"] = True
    assert cam["ReverseX"] is True
    cam["ReverseX"] = False
    assert cam["ReverseX"] is False

    assert isinstance(cam["PixelFormat"], int)


def test_several_values_come_from_one_request(cam):
    assert cam.get_many("Width", "Height") == {"Width": WIDTH, "Height": HEIGHT}


def test_feature_states_report_problems_per_entry(cam):
    states = cam.states(["Width", "NoSuchFeature"])
    assert [s.name for s in states] == ["Width", "NoSuchFeature"]
    assert states[0].error is None
    assert states[1].error

    exposure = cam.state("ExposureTime")
    assert exposure.unit == "us"
    assert exposure.min == 1

    with pytest.raises(FeatureError):
        cam.get("NoSuchFeature")


def test_feature_info_comes_from_the_categories(cam):
    assert cam.feature_info("TriggerSoftware").node_type == GenICamNodeType.COMMAND
    assert cam.feature_info("PixelFormat").enums
    with pytest.raises(FeatureError):
        cam.feature_info("NoSuchFeature")


def test_commands_execute(cam):
    cam.execute("TriggerSoftware")
    with pytest.raises(RacsHttpError):
        cam.execute("Width")


def test_the_low_level_methods_still_take_the_device_id(client):
    assert client.get_device_gc_node_value(0, "Width") == str(WIDTH)
    assert "RegisterDescription" in client.get_device_xml(0)
    assert client.get_device_gc_categories(0)


def test_single_frames(cam):
    assert cam.grab_jpeg(quality=50)[:2] == b"\xff\xd8"

    frame = cam.grab_raw()
    assert (frame.width, frame.height, frame.bit_depth) == (WIDTH, HEIGHT, 8)
    assert frame.to_numpy().shape == (HEIGHT, WIDTH)


def test_stream_error_without_a_stream(cam):
    info = cam.stream_error()
    assert not info.active_stream


def test_live_raw_frames(cam):
    with cam.live(format="raw") as stream:
        frames = list(islice(stream, 3))
        assert cam.stream_error().active_stream
        assert stream.info.width == WIDTH
        assert stream.info.packet_size == 1500
    assert stream.closed
    assert [f.frame_number for f in frames] == [0, 1, 2]
    assert all(len(f.data) == WIDTH * HEIGHT for f in frames)


def test_live_mono16_frames(cam):
    with cam.live(format="raw", pixel_depth=PixelDepth.MONO16) as stream:
        frame = next(stream)
    assert frame.bit_depth > 8
    assert len(frame.data) == WIDTH * HEIGHT * 2
    pixels = frame.to_numpy()
    assert pixels.dtype == np.uint16
    assert pixels.max() > 255


def assert_mono8_gradient(pixels):
    """The fake's Mono8 pattern: each pixel one more (mod 255) than its left neighbour."""
    assert (pixels[:, 1:] == (pixels[:, :-1].astype(np.uint16) + 1) % 255).all()


def test_live_zstd_frames_decode_to_the_pixels(cam):
    with cam.live(format=LiveFormat.ZSTD) as stream:
        frames = list(islice(stream, 5))
    assert stream.info.format == "zstd"
    assert [f.frame_number for f in frames] == list(range(5))
    for frame in frames:
        assert frame.format == "zstd"
        assert len(frame.data) < WIDTH * HEIGHT
        pixels = frame.to_numpy()
        assert pixels.shape == (HEIGHT, WIDTH)
        assert_mono8_gradient(pixels)
    raw = frames[0].to_raw()
    assert (raw.format, len(raw.data)) == ("raw", WIDTH * HEIGHT)


def test_live_mono16_zstd_frames(cam):
    with cam.live(format="zstd", pixel_depth=PixelDepth.MONO16) as stream:
        frame = next(stream)
    assert frame.bit_depth > 8
    pixels = frame.to_numpy()
    assert pixels.dtype == np.uint16
    # The fake's 16-bit ramp steps by 8 along a row.
    assert (pixels[:, 1:] == pixels[:, :-1] + np.uint16(8)).all()
    assert pixels.max() > 255


def test_live_jpeg_frames(cam):
    with cam.live(fps=20) as stream:
        frame = next(stream)
    assert frame.format == "jpeg"
    assert frame.data[:2] == b"\xff\xd8"


def test_a_write_during_a_live_stream_resizes_the_frames(cam):
    with cam.live(format="raw") as stream:
        next(stream)
        cam["Width"] = 32
        resized = next(f for f in islice(stream, 50) if f.width == 32)
    assert len(resized.data) == 32 * HEIGHT


def test_the_packet_size_is_reported_and_kept(cam):
    info = cam.packet_size()
    assert (info.packet_size, info.min, info.max, info.inc) == (1500, 576, 9000, 4)
    assert info.local_ip == "127.0.0.1"

    cam["GevSCPSPacketSize"] = 4000
    cam.grab_raw()
    assert cam.packet_size().packet_size == 4000
    with pytest.raises(RacsHttpError):
        cam["GevSCPSPacketSize"] = 4002


def test_auto_packet_size_during_a_live_stream(cam):
    with cam.live(format="raw") as stream:
        next(stream)
        auto = cam.auto_packet_size()
        assert auto.test_packets
        assert (auto.previous, auto.packet_size) == (1500, 9000)
        # Frames of the old size may still be on their way; the stream announces the new one.
        resized = next(f for f in islice(stream, 50) if stream.info.packet_size == 9000)
    assert len(resized.data) == WIDTH * HEIGHT


def test_a_grab_during_a_live_stream_is_busy(cam):
    with cam.live() as stream:
        next(stream)
        with pytest.raises(CameraBusyError):
            cam.grab_jpeg()


def test_a_raw_burst(cam):
    with cam.burst(5) as job:
        frames = list(job.frames())
        info = job.wait(timeout=10)
    assert info.status == JobStatus.COMPLETED
    assert info.captured_count == 5
    assert len(frames) == 5
    assert all((f.width, f.height, f.format) == (WIDTH, HEIGHT, "raw") for f in frames)
    assert frames[0].to_numpy().shape == (HEIGHT, WIDTH)


def test_a_jpeg_burst(cam):
    with cam.burst(2, format=BurstFormat.JPEG, quality=60) as job:
        job.wait(timeout=10)
        assert job.image(0)[:2] == b"\xff\xd8"
        assert [e.status for e in job.images()] == ["ok", "ok"]
        with pytest.raises(NotFoundError):
            job.image(5)


def test_a_zstd_burst(cam):
    with cam.burst(3, format=BurstFormat.ZSTD) as job:
        frames = list(job.frames())
        info = job.wait(timeout=10)
    assert (info.status, info.format) == (JobStatus.COMPLETED, "zstd")
    assert [f.format for f in frames] == ["zstd"] * 3
    for frame in frames:
        assert_mono8_gradient(frame.to_numpy())


def test_a_deleted_job_is_gone(cam):
    job = cam.burst(1)
    job.wait(timeout=10)
    job.delete()
    with pytest.raises(NotFoundError):
        job.info()

    with cam.burst(1) as job:
        pass
    with pytest.raises(NotFoundError):
        job.info()


def test_a_burst_on_a_busy_camera_fails(cam):
    with cam.live() as stream:
        next(stream)
        with cam.burst(1) as job:
            with pytest.raises(BurstJobFailedError) as failed:
                job.wait(timeout=10)
    assert "Busy" in failed.value.info.error


def test_disconnect(client):
    # Device 1 only, so the other tests keep device 0.
    cam = client.camera(1)
    assert cam.is_connected()
    # The only session using it: leaving closes it.
    assert cam.disconnect().closed
    assert not cam.is_connected()
    with pytest.raises(RacsError):
        cam.info()
    # Connecting again by id reaches the address the server remembers.
    assert cam.connect().is_connected()


# --- several clients ---

def test_the_client_is_a_session(client):
    session = client.session
    assert len(session.client_id) == 8
    assert session.timeout_s == 5, "run-tests.sh starts the fake server with --session-timeout 5"
    client.rename("pytest")
    listed = {s.client_id: s for s in client.list_sessions()}
    assert listed[session.client_id].name == "pytest"


def test_an_anonymous_client_has_no_session(server_url):
    with RacsClient(server_url, anonymous=True) as client:
        assert client.session is None
        assert client.camera(0).access().you == Role.WRITER
        with pytest.raises(RacsError):
            client.events()


def test_two_clients_and_the_lock_semantics(cam, make_client, server_url):
    owner, other = make_client(name="owner"), make_client(name="other")
    mine, theirs = owner.connect(0, mode=Mode.RO_SHARED), other.camera(0)
    owner_id, other_id = owner.session.client_id, other.session.client_id

    access = mine.access()
    assert (access.mode, access.you, access.owner.client_id) == (Mode.RO_SHARED, Role.OWNER, owner_id)

    # ro-shared: the other session reads, but doesn't write.
    assert theirs["Width"] == WIDTH
    assert theirs.access().you == Role.READER
    with pytest.raises(ReadOnlyError) as refused:
        theirs["ReverseX"] = True
    assert refused.value.status_code == 403
    assert refused.value.refusal.error == "read_only"
    assert refused.value.refusal.owner.client_id == owner_id

    # Exclusive while the other session uses the device: refused, unless forced.
    with pytest.raises(DeviceInUseError) as in_use:
        mine.take("exclusive")
    assert other_id in {m.client_id for m in in_use.value.refusal.members}
    assert mine.take(Mode.EXCLUSIVE, force=True).mode == Mode.EXCLUSIVE

    with pytest.raises(DeviceLockedError) as locked:
        theirs.get("Width")
    assert locked.value.refusal.owner.client_id == owner_id
    with pytest.raises(DeviceLockedError):
        theirs.take("ro-shared")
    with RacsClient(server_url, anonymous=True) as anonymous:
        with pytest.raises(DeviceLockedError):
            anonymous.camera(0).get("Width")
    # The meta routes stay open.
    assert theirs.access().you == Role.META

    # Released: shared again, everyone writes.
    assert mine.release().mode == Mode.SHARED
    theirs["ReverseX"] = True
    assert mine["ReverseX"] is True


def test_a_forced_lease_revokes_another_clients_stream(cam, make_client):
    owner, viewer = make_client(), make_client()
    with viewer.camera(0).live() as stream:
        next(stream)
        owner.camera(0).take("exclusive", force=True)
        with pytest.raises(AccessRevokedError) as revoked:
            for _ in islice(stream, 1000):
                pass
    assert revoked.value.code == 4003
    owner.camera(0).release()


def test_an_event_tells_one_client_what_another_wrote(cam, make_client):
    listener, writer = make_client(), make_client(name="writer")
    with listener.events(timeout=10) as events:
        hello = next(events)
        assert hello.type == EventType.HELLO
        assert hello.session.client_id == listener.session.client_id
        assert 0 in {d.device for d in hello.devices}

        writer.camera(0)["ReverseX"] = True
        changed = next(e for e in events if e.type == EventType.FEATURE_CHANGED)
    assert (changed.device, changed.feature) == (0, "ReverseX")
    assert (changed.by.client_id, changed.by.name) == (writer.session.client_id, "writer")


def test_two_clients_watch_one_camera(cam, make_client):
    first, second = make_client(), make_client()
    with first.camera(0).live(format="raw") as a, second.camera(0).live(format="jpeg") as b:
        assert len(next(a).data) == WIDTH * HEIGHT
        assert next(b).data[:2] == b"\xff\xd8"
        access = first.camera(0).access()
        assert access.viewers == 2
        assert access.holder.kind == HolderKind.LIVE


def test_an_expired_session_is_renewed(make_client):
    quiet, observer = make_client(heartbeat=False), make_client()
    expired = quiet.session
    assert quiet.camera(0).access().device == 0
    # The sweep runs every second.
    time.sleep(expired.timeout_s + 2)
    assert expired.client_id not in {s.client_id for s in observer.list_sessions()}

    # The next request gets a 401, and the client retries it with a new session.
    assert quiet.camera(0).access().device == 0
    assert quiet.session.client_id != expired.client_id


def test_a_stream_ends_with_its_session(cam, make_client):
    viewer = make_client()
    with viewer.camera(0).live() as stream:
        next(stream)
        viewer.end_session(viewer.session.session_id)
        with pytest.raises(SessionEndedError) as ended:
            for _ in islice(stream, 1000):
                pass
    assert ended.value.code == 4001
