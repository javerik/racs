import time
from typing import TYPE_CHECKING, Iterator, List, Optional, Union
from uuid import UUID

from .errors import BurstJobFailedError, NotFoundError, RacsError
from .frame import Frame
from .models import BurstJobInfo, ImageEntry, ImageEntryOk, JobStatus

if TYPE_CHECKING:
    from .camera import Camera


class BurstJob:
    """
    A burst job on the server. The frames stay there until the job is deleted, or expire 10 min
    after it finishes.

    Used as a context manager, the job is deleted on exit::

        with cam.burst(20, format="raw") as job:
            for frame in job.frames():
                ...
    """

    def __init__(self, camera: "Camera", job_id: Union[UUID, str]):
        self.camera = camera
        self.id = job_id if isinstance(job_id, UUID) else UUID(str(job_id))
        # The first status that carried the frame geometry; it is the same for every frame.
        self._geometry: Optional[BurstJobInfo] = None

    @property
    def _client(self):
        return self.camera.client

    def info(self) -> BurstJobInfo:
        """The job's status and progress."""
        info = self._client.get_grab_job(self.camera.id, self.id)
        if info.width is not None:
            self._geometry = info
        return info

    def images(self) -> List[ImageEntry]:
        """Every frame attempted so far, in capture order: ImageEntryOk or ImageEntryFailed."""
        return self._client.list_grab_job_images(self.camera.id, self.id)

    def image(self, index: int) -> bytes:
        """The encoded bytes of frame ``index``."""
        return self._client.get_grab_job_image(self.camera.id, self.id, index)

    def frame(self, index: int) -> Frame:
        """Frame ``index`` with its geometry, ready for :meth:`Frame.to_numpy` (raw jobs)."""
        data = self.image(index)
        geometry = self._geometry or self.info()
        if geometry.width is None or geometry.height is None:
            raise RacsError(f"burst job {self.id} reports no frame geometry")
        return Frame(
            data=data,
            width=geometry.width,
            height=geometry.height,
            format=geometry.format.value,
            pixel_format=geometry.pixel_format or "Mono8",
            bit_depth=geometry.bit_depth or 8,
        )

    def wait(self, timeout: Optional[float] = None, poll_interval: float = 0.1) -> BurstJobInfo:
        """
        Block until the job is completed or cancelled and return its final status. Raises
        BurstJobFailedError if it failed and TimeoutError after ``timeout`` seconds.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            info = self.info()
            if info.status.is_terminal:
                if info.status == JobStatus.FAILED:
                    raise BurstJobFailedError(info)
                return info
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"burst job {self.id} still {info.status.value} after {timeout} s")
            time.sleep(poll_interval)

    def frames(self, poll_interval: float = 0.1) -> Iterator[Frame]:
        """
        Yield every captured frame in order, as soon as it is on the server; failed frames (only
        with ``on_failure="skip"``) are left out. Ends when the job is done, and raises
        BurstJobFailedError after the last frame if the job failed.
        """
        next_index = 0
        while True:
            # Status first: once it is terminal, the listing that follows is complete.
            info = self.info()
            for entry in self.images():
                if entry.index < next_index:
                    continue
                next_index = entry.index + 1
                if isinstance(entry, ImageEntryOk):
                    yield self.frame(entry.index)
            if info.status.is_terminal:
                if info.status == JobStatus.FAILED:
                    raise BurstJobFailedError(info)
                return
            time.sleep(poll_interval)

    def delete(self) -> None:
        """Cancel the job if it still runs, and drop it and its frames from the server."""
        self._client.delete_grab_job(self.camera.id, self.id)

    cancel = delete

    def __enter__(self) -> "BurstJob":
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.delete()
        except NotFoundError:
            pass

    def __repr__(self) -> str:
        return f"BurstJob(device_id={self.camera.id}, id='{self.id}')"
