from __future__ import annotations

import hashlib
import logging
import math
import os
import threading
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt
import orjson

from ..config import get_settings
from ..errors import KeyNotFound, NeedsPickle, UnsupportedKind
from ..models import KeyKind, KeyMeta, Layout
from ..paths import to_posix

logger = logging.getLogger(__name__)

IMAGE_CHANNEL_COUNTS = frozenset({1, 3, 4})
NUMERIC_KINDS = "biufc"
RENDERABLE_KINDS: frozenset[str] = frozenset({"rgb", "rgba", "gray", "gainmap", "stack"})


@dataclass(slots=True)
class RawHeader:
    name: str
    shape: tuple[int, ...]
    dtype: str


@dataclass(slots=True)
class FileStamp:
    mtime: float
    size: int


def stamp(path: Path) -> FileStamp:
    stat = path.stat()
    return FileStamp(mtime=stat.st_mtime, size=stat.st_size)


# ---------------------------------------------------------------------------
# npz header reading
# ---------------------------------------------------------------------------


def _read_array_header(handle, version: tuple[int, int]) -> tuple[tuple[int, ...], bool, np.dtype]:
    if version == (1, 0):
        return np.lib.format.read_array_header_1_0(handle)
    if version in ((2, 0), (3, 0)):
        # 2.0 and 3.0 share the 4-byte header-length layout; 3.0 only widens field encoding.
        return np.lib.format.read_array_header_2_0(handle)
    raise UnsupportedKind(f"不支持的 npy 版本: {version}")


def read_headers(path: Path) -> tuple[list[RawHeader], bool]:
    """List every key's shape/dtype without inflating any array payload.

    Each member's ``.npy`` header is only ~128 bytes, so this stays fast even for
    multi-hundred-megabyte files.
    """
    headers: list[RawHeader] = []
    compressed = False
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if info.compress_type != zipfile.ZIP_STORED:
                compressed = True
            name = info.filename
            if name.casefold().endswith(".npy"):
                name = name[:-4]
            try:
                with archive.open(info) as handle:
                    version = np.lib.format.read_magic(handle)
                    shape, _fortran, dtype = _read_array_header(handle, version)
            except (ValueError, OSError, UnsupportedKind) as exc:
                logger.warning("npzio: cannot read header for %s in %s: %s", name, path, exc)
                continue
            headers.append(RawHeader(name=name, shape=tuple(int(s) for s in shape), dtype=str(dtype)))
    return headers, compressed


# ---------------------------------------------------------------------------
# key classification (see docs/SPEC.md section 4.1)
# ---------------------------------------------------------------------------


def _kind_for_channels(channels: int) -> KeyKind:
    if channels == 3:
        return "rgb"
    if channels == 4:
        return "rgba"
    return "gray"


@dataclass(slots=True)
class Geometry:
    kind: KeyKind
    layout: Layout | None = None
    channels: int | None = None
    height: int | None = None
    width: int | None = None
    channel_axis: int | None = None
    ambiguous: bool = False
    note: str | None = None


def _describe(inner: tuple[int, ...], *, is_gainmap: bool, small_matrix_max: int) -> Geometry:
    ndim = len(inner)

    if ndim == 0:
        return Geometry(kind="scalar")
    if ndim == 1:
        return Geometry(kind="table")
    if ndim == 2:
        height, width = inner
        if height <= small_matrix_max and width <= small_matrix_max:
            return Geometry(kind="table")
        if height == 0 or width == 0:
            return Geometry(kind="raw", note="空数组")
        kind: KeyKind = "gainmap" if is_gainmap else "gray"
        return Geometry(kind=kind, channels=1, height=height, width=width, channel_axis=None)

    first, middle, last = inner
    if 0 in inner:
        return Geometry(kind="raw", note="空数组")

    first_ok = first in IMAGE_CHANNEL_COUNTS
    last_ok = last in IMAGE_CHANNEL_COUNTS

    if first_ok and not last_ok:
        geometry = Geometry(
            kind=_kind_for_channels(first),
            layout="chw",
            channels=first,
            height=middle,
            width=last,
            channel_axis=0,
        )
    elif last_ok and not first_ok:
        geometry = Geometry(
            kind=_kind_for_channels(last),
            layout="hwc",
            channels=last,
            height=first,
            width=middle,
            channel_axis=2,
        )
    elif first_ok and last_ok:
        # Both ends look like a channel axis (e.g. (3, 3, 3)); default to HWC and let the UI flip it.
        geometry = Geometry(
            kind=_kind_for_channels(last),
            layout="hwc",
            channels=last,
            height=first,
            width=middle,
            channel_axis=2,
            ambiguous=True,
            note="通道轴有歧义，默认按 HWC 解释",
        )
    elif first <= last:
        geometry = Geometry(
            kind="stack",
            layout="chw",
            channels=first,
            height=middle,
            width=last,
            channel_axis=0,
            ambiguous=True,
            note="多通道堆栈，逐通道显示",
        )
    else:
        geometry = Geometry(
            kind="stack",
            layout="hwc",
            channels=last,
            height=first,
            width=middle,
            channel_axis=2,
            ambiguous=True,
            note="多通道堆栈，逐通道显示",
        )

    if is_gainmap and geometry.kind != "stack":
        geometry.kind = "gainmap"
    return geometry


def classify(name: str, shape: tuple[int, ...], dtype: str, small_matrix_max: int) -> KeyMeta:
    numpy_dtype = np.dtype(dtype)
    element_count = math.prod(shape) if shape else 1
    nbytes = int(numpy_dtype.itemsize * element_count)
    base = {
        "name": name,
        "shape": list(shape),
        "dtype": str(numpy_dtype),
        "nbytes": nbytes,
    }

    if numpy_dtype.kind not in NUMERIC_KINDS:
        kind: KeyKind = "scalar" if not shape else "raw"
        return KeyMeta(**base, kind=kind, renderable=False, note="非数值数据，按文本显示")

    if len(shape) > 4:
        return KeyMeta(**base, kind="raw", renderable=False, note=f"{len(shape)} 维数组暂不支持可视化")

    batch: int | None = None
    inner = shape
    if len(shape) == 4:
        batch = shape[0]
        inner = shape[1:]

    geometry = _describe(
        inner, is_gainmap="gainmap" in name.casefold(), small_matrix_max=small_matrix_max
    )
    if batch is not None and geometry.kind == "raw":
        # Nothing renderable inside the batch, so the batch selector would be pointless.
        batch = None

    return KeyMeta(
        **base,
        kind=geometry.kind,
        layout=geometry.layout,
        ambiguous=geometry.ambiguous,
        batch=batch,
        channels=geometry.channels,
        height=geometry.height,
        width=geometry.width,
        channel_axis=geometry.channel_axis,
        renderable=geometry.kind in RENDERABLE_KINDS,
        note=geometry.note,
    )


# ---------------------------------------------------------------------------
# caches
# ---------------------------------------------------------------------------


class _HeaderCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._memory: OrderedDict[str, tuple[FileStamp, list[KeyMeta], bool]] = OrderedDict()

    @staticmethod
    def _key(path: Path) -> str:
        return os.path.normcase(str(path))

    def _disk_path(self, path: Path) -> Path:
        digest = hashlib.sha1(self._key(path).encode("utf-8")).hexdigest()
        return get_settings().header_cache_dir / f"{digest}.json"

    def get(self, path: Path, current: FileStamp) -> tuple[list[KeyMeta], bool] | None:
        key = self._key(path)
        with self._lock:
            cached = self._memory.get(key)
            if cached is not None and cached[0] == current:
                self._memory.move_to_end(key)
                return cached[1], cached[2]
        try:
            payload = orjson.loads(self._disk_path(path).read_bytes())
        except (OSError, orjson.JSONDecodeError):
            return None
        if payload.get("mtime") != current.mtime or payload.get("size") != current.size:
            return None
        try:
            keys = [KeyMeta.model_validate(item) for item in payload["keys"]]
        except (KeyError, ValueError):
            return None
        compressed = bool(payload.get("compressed", False))
        self.put(path, current, keys, compressed, persist=False)
        return keys, compressed

    def put(
        self,
        path: Path,
        current: FileStamp,
        keys: list[KeyMeta],
        compressed: bool,
        *,
        persist: bool = True,
    ) -> None:
        key = self._key(path)
        with self._lock:
            self._memory[key] = (current, keys, compressed)
            self._memory.move_to_end(key)
            while len(self._memory) > 512:
                self._memory.popitem(last=False)
        if not persist:
            return
        payload = {
            "path": to_posix(path),
            "mtime": current.mtime,
            "size": current.size,
            "compressed": compressed,
            "keys": [item.model_dump() for item in keys],
        }
        try:
            disk_path = self._disk_path(path)
            disk_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = disk_path.with_suffix(".tmp")
            temp_path.write_bytes(orjson.dumps(payload))
            temp_path.replace(disk_path)
        except OSError as exc:
            logger.warning("npzio: failed to persist header cache for %s: %s", path, exc)

    def invalidate(self, path: Path) -> None:
        with self._lock:
            self._memory.pop(self._key(path), None)
        try:
            self._disk_path(path).unlink(missing_ok=True)
        except OSError:
            pass

    def clear(self) -> None:
        with self._lock:
            self._memory.clear()


class _ArrayCache:
    """Byte-budgeted LRU over decoded arrays, so re-rendering the same key is free."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: OrderedDict[tuple[str, float, int, str], npt.NDArray] = OrderedDict()
        self._bytes = 0

    def get(self, key: tuple[str, float, int, str]) -> npt.NDArray | None:
        with self._lock:
            array = self._entries.get(key)
            if array is not None:
                self._entries.move_to_end(key)
            return array

    def put(self, key: tuple[str, float, int, str], array: npt.NDArray) -> None:
        budget = get_settings().array_cache_mb * 1024 * 1024
        if array.nbytes > budget:
            return
        with self._lock:
            existing = self._entries.pop(key, None)
            if existing is not None:
                self._bytes -= existing.nbytes
            self._entries[key] = array
            self._bytes += array.nbytes
            while self._bytes > budget and self._entries:
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= evicted.nbytes

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0


header_cache = _HeaderCache()
array_cache = _ArrayCache()


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def get_meta(path: Path) -> tuple[list[KeyMeta], bool]:
    current = stamp(path)
    cached = header_cache.get(path, current)
    if cached is not None:
        return cached
    headers, compressed = read_headers(path)
    small_matrix_max = get_settings().small_matrix_max
    keys = [classify(item.name, item.shape, item.dtype, small_matrix_max) for item in headers]
    header_cache.put(path, current, keys, compressed)
    return keys, compressed


def find_key(path: Path, key: str) -> KeyMeta:
    keys, _ = get_meta(path)
    for item in keys:
        if item.name == key:
            return item
    raise KeyNotFound(key, to_posix(path))


def load_array(path: Path, key: str) -> npt.NDArray:
    current = stamp(path)
    cache_key = (os.path.normcase(str(path)), current.mtime, current.size, key)
    cached = array_cache.get(cache_key)
    if cached is not None:
        return cached

    allow_pickle = get_settings().allow_pickle
    try:
        with np.load(path, allow_pickle=allow_pickle) as archive:
            if key not in archive.files:
                raise KeyNotFound(key, to_posix(path))
            array = archive[key]
    except ValueError as exc:
        if "allow_pickle" in str(exc):
            raise NeedsPickle(to_posix(path)) from exc
        raise
    array = np.asarray(array)
    array_cache.put(cache_key, array)
    return array


def invalidate(path: Path) -> None:
    header_cache.invalidate(path)


def clear_caches() -> None:
    header_cache.clear()
    array_cache.clear()
