from __future__ import annotations

import hashlib
import logging
import os
import shutil
import threading
import time
from pathlib import Path

from ..config import get_settings

logger = logging.getLogger(__name__)

SWEEP_MIN_INTERVAL_S = 60.0
SWEEP_TRIGGER_BYTES = 256 * 1024 * 1024


def digest_for(parts: object) -> str:
    return hashlib.sha1(repr(parts).encode("utf-8")).hexdigest()


class ImageCache:
    """Sharded on-disk blob cache with lazy LRU eviction driven by access time."""

    def __init__(self, name: str) -> None:
        self._name = name
        self._lock = threading.Lock()
        self._pending_bytes = 0
        self._last_sweep = 0.0

    def _base(self) -> Path:
        settings = get_settings()
        return settings.thumb_cache_dir if self._name == "thumb" else settings.render_cache_dir

    def path_for(self, digest: str, ext: str) -> Path:
        return self._base() / digest[:2] / f"{digest}.{ext}"

    def get(self, digest: str, ext: str) -> bytes | None:
        target = self.path_for(digest, ext)
        try:
            data = target.read_bytes()
        except OSError:
            return None
        # Refresh atime so the sweeper treats this entry as recently used.
        try:
            now = time.time()
            os.utime(target, (now, target.stat().st_mtime))
        except OSError:
            pass
        return data

    def put(self, digest: str, ext: str, data: bytes) -> None:
        target = self.path_for(digest, ext)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix(f".{ext}.tmp{os.getpid()}")
            temp.write_bytes(data)
            temp.replace(target)
        except OSError as exc:
            logger.warning("imgcache: failed to write %s: %s", target, exc)
            return
        with self._lock:
            self._pending_bytes += len(data)
            should_sweep = (
                self._pending_bytes >= SWEEP_TRIGGER_BYTES
                and time.time() - self._last_sweep >= SWEEP_MIN_INTERVAL_S
            )
            if should_sweep:
                self._pending_bytes = 0
                self._last_sweep = time.time()
        if should_sweep:
            sweep()


render_cache = ImageCache("render")
thumb_cache = ImageCache("thumb")


def _iter_blobs(base: Path) -> list[tuple[float, int, Path]]:
    blobs: list[tuple[float, int, Path]] = []
    for shard in base.iterdir() if base.is_dir() else []:
        if not shard.is_dir():
            continue
        with os.scandir(shard) as iterator:
            for item in iterator:
                try:
                    stat = item.stat()
                except OSError:
                    continue
                blobs.append((stat.st_atime, stat.st_size, Path(item.path)))
    return blobs


def sweep() -> int:
    """Delete least-recently-read blobs until the cache fits the configured budget."""
    settings = get_settings()
    budget = int(settings.max_cache_gb * 1024**3)
    blobs: list[tuple[float, int, Path]] = []
    for base in (settings.render_cache_dir, settings.thumb_cache_dir):
        blobs.extend(_iter_blobs(base))
    total = sum(size for _, size, _ in blobs)
    if total <= budget:
        return 0
    blobs.sort(key=lambda item: item[0])
    freed = 0
    for _atime, size, path in blobs:
        if total - freed <= budget:
            break
        try:
            path.unlink()
            freed += size
        except OSError:
            continue
    logger.info("imgcache: swept %.1f MB (budget %.1f GB)", freed / 1024**2, settings.max_cache_gb)
    return freed


def clear() -> None:
    settings = get_settings()
    for base in (settings.render_cache_dir, settings.thumb_cache_dir):
        shutil.rmtree(base, ignore_errors=True)
    settings.ensure_dirs()
