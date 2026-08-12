from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import orjson

from ..config import get_settings
from ..paths import natural_key, to_posix

logger = logging.getLogger(__name__)

NPZ_SUFFIX = ".npz"

# Probing every child directory for grandchildren is unbounded work when a folder holds
# 200k files, so the probe gives up after this many entries and reports "expandable".
HAS_CHILDREN_PROBE_LIMIT = 4096

# Small directories are cheaper to rescan than to serialise, so they never hit the disk cache.
DISK_CACHE_MIN_ENTRIES = 2000


@dataclass(slots=True)
class FileEntry:
    name: str
    size: int
    mtime: float


@dataclass(slots=True)
class SubdirEntry:
    name: str
    has_children: bool


class DirSnapshot:
    """One directory's ``.npz`` inventory, held in natural-name ascending order.

    Alternative orderings are derived lazily and memoised, because re-sorting 200k
    entries on every page flip is the difference between 50ms and half a second.
    """

    __slots__ = ("path", "dir_mtime", "entries", "scanned_at", "_orderings", "_lock")

    def __init__(self, path: Path, dir_mtime: float, entries: list[FileEntry]) -> None:
        self.path = path
        self.dir_mtime = dir_mtime
        self.entries = entries
        self.scanned_at = time.time()
        self._orderings: dict[tuple[str, str], list[FileEntry]] = {}
        self._lock = threading.Lock()

    def ordered(self, sort: str, order: str) -> list[FileEntry]:
        cache_key = (sort, order)
        with self._lock:
            cached = self._orderings.get(cache_key)
            if cached is not None:
                return cached
            if sort == "name":
                ordered = self.entries if order == "asc" else list(reversed(self.entries))
            else:
                attr = "mtime" if sort == "mtime" else "size"
                ordered = sorted(
                    self.entries,
                    key=lambda entry: (getattr(entry, attr), natural_key(entry.name)),
                    reverse=order == "desc",
                )
            self._orderings[cache_key] = ordered
            return ordered

    def index_of(self, name: str) -> int:
        target = os.path.normcase(name)
        for index, entry in enumerate(self.entries):
            if os.path.normcase(entry.name) == target:
                return index
        return -1


def _scan_files(directory: Path) -> list[FileEntry]:
    entries: list[FileEntry] = []
    with os.scandir(directory) as iterator:
        for item in iterator:
            if not item.name.casefold().endswith(NPZ_SUFFIX):
                continue
            try:
                if not item.is_file(follow_symlinks=True):
                    continue
                stat = item.stat(follow_symlinks=True)
            except OSError:
                continue
            entries.append(FileEntry(name=item.name, size=stat.st_size, mtime=stat.st_mtime))
    entries.sort(key=lambda entry: natural_key(entry.name))
    return entries


def _probe_has_children(directory: Path) -> bool:
    try:
        with os.scandir(directory) as iterator:
            for count, item in enumerate(iterator):
                if count >= HAS_CHILDREN_PROBE_LIMIT:
                    return True
                try:
                    if item.is_dir(follow_symlinks=False):
                        return True
                except OSError:
                    continue
    except OSError:
        return False
    return False


def scan_subdirs(directory: Path) -> list[SubdirEntry]:
    subdirs: list[SubdirEntry] = []
    with os.scandir(directory) as iterator:
        for item in iterator:
            try:
                if not item.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            subdirs.append(
                SubdirEntry(name=item.name, has_children=_probe_has_children(Path(item.path)))
            )
    subdirs.sort(key=lambda entry: natural_key(entry.name))
    return subdirs


class DirIndexCache:
    """Three tiers: in-process LRU, on-disk columnar snapshot, then a fresh scandir."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._memory: OrderedDict[str, DirSnapshot] = OrderedDict()
        self._subdirs: OrderedDict[str, tuple[float, list[SubdirEntry]]] = OrderedDict()

    # ---- keys -------------------------------------------------------------
    @staticmethod
    def _memory_key(directory: Path) -> str:
        return os.path.normcase(str(directory))

    def _disk_path(self, directory: Path) -> Path:
        digest = hashlib.sha1(self._memory_key(directory).encode("utf-8")).hexdigest()
        return get_settings().dirindex_cache_dir / f"{digest}.json"

    # ---- disk tier --------------------------------------------------------
    def _read_disk(self, directory: Path, dir_mtime: float) -> DirSnapshot | None:
        disk_path = self._disk_path(directory)
        try:
            payload = orjson.loads(disk_path.read_bytes())
        except (OSError, orjson.JSONDecodeError):
            return None
        if payload.get("dir_mtime") != dir_mtime:
            return None
        names = payload.get("names")
        sizes = payload.get("sizes")
        mtimes = payload.get("mtimes")
        if not (isinstance(names, list) and isinstance(sizes, list) and isinstance(mtimes, list)):
            return None
        if not len(names) == len(sizes) == len(mtimes):
            return None
        entries = [
            FileEntry(name=name, size=size, mtime=mtime)
            for name, size, mtime in zip(names, sizes, mtimes, strict=True)
        ]
        return DirSnapshot(directory, dir_mtime, entries)

    def _write_disk(self, snapshot: DirSnapshot) -> None:
        if len(snapshot.entries) < DISK_CACHE_MIN_ENTRIES:
            return
        disk_path = self._disk_path(snapshot.path)
        payload = {
            "path": to_posix(snapshot.path),
            "dir_mtime": snapshot.dir_mtime,
            "names": [entry.name for entry in snapshot.entries],
            "sizes": [entry.size for entry in snapshot.entries],
            "mtimes": [entry.mtime for entry in snapshot.entries],
        }
        try:
            disk_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = disk_path.with_suffix(".tmp")
            temp_path.write_bytes(orjson.dumps(payload))
            temp_path.replace(disk_path)
        except OSError as exc:
            logger.warning("dirindex: failed to persist %s: %s", disk_path, exc)

    # ---- memory tier ------------------------------------------------------
    def _remember(self, snapshot: DirSnapshot) -> None:
        capacity = max(1, get_settings().dir_cache_slots)
        key = self._memory_key(snapshot.path)
        with self._lock:
            self._memory[key] = snapshot
            self._memory.move_to_end(key)
            while len(self._memory) > capacity:
                self._memory.popitem(last=False)

    # ---- public API -------------------------------------------------------
    def snapshot(self, directory: Path, *, force: bool = False) -> DirSnapshot:
        dir_mtime = directory.stat().st_mtime
        key = self._memory_key(directory)

        if not force:
            with self._lock:
                cached = self._memory.get(key)
                if cached is not None and cached.dir_mtime == dir_mtime:
                    self._memory.move_to_end(key)
                    return cached
            from_disk = self._read_disk(directory, dir_mtime)
            if from_disk is not None:
                self._remember(from_disk)
                return from_disk

        started = time.perf_counter()
        entries = _scan_files(directory)
        snapshot = DirSnapshot(directory, dir_mtime, entries)
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info("dirindex: scanned %d npz in %s (%.0fms)", len(entries), directory, elapsed_ms)
        self._remember(snapshot)
        self._write_disk(snapshot)
        return snapshot

    def subdirs(self, directory: Path, *, force: bool = False) -> list[SubdirEntry]:
        dir_mtime = directory.stat().st_mtime
        key = self._memory_key(directory)
        if not force:
            with self._lock:
                cached = self._subdirs.get(key)
                if cached is not None and cached[0] == dir_mtime:
                    self._subdirs.move_to_end(key)
                    return cached[1]
        listing = scan_subdirs(directory)
        with self._lock:
            self._subdirs[key] = (dir_mtime, listing)
            self._subdirs.move_to_end(key)
            while len(self._subdirs) > 256:
                self._subdirs.popitem(last=False)
        return listing

    def invalidate(self, directory: Path) -> bool:
        key = self._memory_key(directory)
        with self._lock:
            removed = self._memory.pop(key, None) is not None
            removed = self._subdirs.pop(key, None) is not None or removed
        try:
            self._disk_path(directory).unlink(missing_ok=True)
        except OSError:
            pass
        return removed

    def clear(self) -> None:
        with self._lock:
            self._memory.clear()
            self._subdirs.clear()


dir_index = DirIndexCache()


def filter_entries(entries: list[FileEntry], query: str) -> list[FileEntry]:
    if not query:
        return entries
    needle = query.casefold()
    return [entry for entry in entries if needle in entry.name.casefold()]


def paginate(
    entries: list[FileEntry], page: int, page_size: int
) -> tuple[list[FileEntry], int, int]:
    total = len(entries)
    pages = max(1, -(-total // page_size))
    clamped = min(max(1, page), pages)
    start = (clamped - 1) * page_size
    return entries[start : start + page_size], clamped, pages
