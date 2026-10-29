from dataclasses import dataclass, field, replace
from typing import Optional


@dataclass
class Frame:
    """
    One image, with what it takes to decode it.

    For ``format == "raw"``, ``data`` is ``width * height`` pixels, row by row: one byte each at a
    ``bit_depth`` of 8, otherwise a little-endian u16 each in the range ``0..2**bit_depth``. For
    ``"zstd"`` it is those pixels losslessly compressed (``to_numpy()`` and ``to_raw()`` decode
    them). For ``"jpeg"`` it is a JPEG file holding the top 8 significant bits.
    """

    data: bytes = field(repr=False)
    width: int
    height: int
    format: str = "raw"
    pixel_format: str = "Mono8"
    bit_depth: int = 8
    # Live stream only: the message number in the session, and the cumulative dropped count.
    frame_number: Optional[int] = None
    dropped: Optional[int] = None

    @property
    def bytes_per_pixel(self) -> int:
        return 2 if self.bit_depth > 8 else 1

    def to_numpy(self):
        """
        The pixels as a ``(height, width)`` array: ``uint8`` at 8 bit, ``uint16`` above.

        Needs numpy (``pip install racs-python[numpy]``), and for zstd frames a zstd module too
        (``pip install racs-python[zstd]``). JPEG frames are not decoded here; pass
        ``frame.data`` to an image library such as OpenCV or Pillow.
        """
        if self.format == "zstd":
            return decode_zstd(self.data, self.width, self.height, self.bit_depth)
        if self.format != "raw":
            raise ValueError(f"to_numpy() needs a raw or zstd frame, this one is {self.format}; decode frame.data instead")
        import numpy as np

        dtype = np.dtype("<u2") if self.bytes_per_pixel == 2 else np.dtype(np.uint8)
        expected = self.width * self.height * dtype.itemsize
        if len(self.data) != expected:
            raise ValueError(
                f"frame holds {len(self.data)} bytes, {self.width}x{self.height} at {self.bit_depth} bit needs {expected}")
        return np.frombuffer(self.data, dtype=dtype).reshape((self.height, self.width))

    def to_raw(self) -> "Frame":
        """This frame with raw pixels: a zstd frame decoded, a raw one as it is."""
        if self.format == "raw":
            return self
        if self.format != "zstd":
            raise ValueError(f"to_raw() needs a raw or zstd frame, this one is {self.format}")
        pixels = decode_zstd(self.data, self.width, self.height, self.bit_depth)
        return replace(self, data=pixels.astype(pixels.dtype.newbyteorder("<"), copy=False).tobytes(), format="raw")


def decode_zstd(data: bytes, width: int, height: int, bit_depth: int):
    """
    Decode a ``zstd`` frame into a ``(height, width)`` numpy array.

    The frame decompresses to a residual per pixel: the pixel minus the one above it (minus 0 in
    the first row), wrapping at the pixel width. Above 8 bit the residuals are zigzagged and stored
    as every low byte followed by every high byte. Undoing that is a cumulative sum down the
    columns.
    """
    import numpy as np

    count = width * height
    bpp = 2 if bit_depth > 8 else 1
    if count <= 0:
        raise ValueError(f"invalid frame size {width}x{height}")
    residuals = np.frombuffer(_zstd_decompress(data, count * bpp), dtype=np.uint8)
    if residuals.size != count * bpp:
        raise ValueError(
            f"zstd frame holds {residuals.size} bytes, {width}x{height} at {bit_depth} bit needs {count * bpp}")
    if bpp == 1:
        return np.cumsum(residuals.reshape(height, width), axis=0, dtype=np.uint8)
    z = residuals[:count].astype(np.uint16) | (residuals[count:].astype(np.uint16) << 8)
    d = (z >> 1) ^ (np.uint16(0) - (z & 1))
    return np.cumsum(d.reshape(height, width), axis=0, dtype=np.uint16)


def _zstd_decompress(data: bytes, size: int) -> bytes:
    try:
        from compression import zstd  # Python 3.14+
    except ImportError:
        try:
            import zstandard
        except ImportError:
            raise ImportError(
                "decoding zstd frames needs Python 3.14 or the zstandard package: pip install racs-python[zstd]"
            ) from None
        try:
            return zstandard.ZstdDecompressor().decompress(data, max_output_size=size)
        except zstandard.ZstdError as e:
            raise ValueError(f"not a valid zstd frame: {e}") from e
    try:
        return zstd.decompress(data)
    except zstd.ZstdError as e:
        raise ValueError(f"not a valid zstd frame: {e}") from e
