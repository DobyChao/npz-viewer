from __future__ import annotations

import os
from pathlib import Path

from ..errors import BadParam, FileNotFound
from ..models import SiblingResult
from ..paths import natural_key, to_posix
from .dirindex import FileEntry, dir_index

# A run of npz-less sibling folders should not turn navigation into a dead end.
MAX_FOLDER_PROBES = 64


def _step(index: int, direction: str) -> int:
    return index + (1 if direction == "next" else -1)


def _stamp(path: Path, fallback: FileEntry | None = None) -> tuple[float, int]:
    """Live file stamp. Dirindex mtimes go stale when a file is overwritten in place."""
    try:
        stat = path.stat()
        return stat.st_mtime, stat.st_size
    except OSError:
        if fallback is not None:
            return fallback.mtime, fallback.size
        raise


def _sibling(directory: Path, entry: FileEntry, index: int, total: int) -> SiblingResult:
    path = directory / entry.name
    mtime, size = _stamp(path, entry)
    return SiblingResult(
        path=to_posix(path),
        name=entry.name,
        index=index,
        total=total,
        mtime=mtime,
        size=size,
    )


def sibling_file(path: Path, direction: str) -> SiblingResult:
    """Next/previous npz inside the same folder, in natural-name order."""
    snapshot = dir_index.snapshot(path.parent)
    index = snapshot.index_of(path.name)
    if index < 0:
        raise FileNotFound(to_posix(path))
    target = _step(index, direction)
    if not 0 <= target < len(snapshot.entries):
        raise FileNotFound(f"{to_posix(path.parent)} 中没有更多 npz")
    return _sibling(path.parent, snapshot.entries[target], target, len(snapshot.entries))


def sibling_folder(path: Path, direction: str) -> SiblingResult:
    """Same ordinal npz in the adjacent sibling folder — the cross-version comparison flow."""
    current_dir = path.parent
    grandparent = current_dir.parent
    if grandparent == current_dir:
        raise FileNotFound(f"{to_posix(current_dir)} 没有上级目录")

    siblings = [entry.name for entry in dir_index.subdirs(grandparent)]
    normalized = os.path.normcase(current_dir.name)
    try:
        position = next(
            index
            for index, name in enumerate(siblings)
            if os.path.normcase(name) == normalized
        )
    except StopIteration:
        raise FileNotFound(f"无法在 {to_posix(grandparent)} 中定位 {current_dir.name}") from None

    ordinal = dir_index.snapshot(current_dir).index_of(path.name)
    if ordinal < 0:
        ordinal = 0

    cursor = position
    for _ in range(MAX_FOLDER_PROBES):
        cursor = _step(cursor, direction)
        if not 0 <= cursor < len(siblings):
            break
        candidate_dir = grandparent / siblings[cursor]
        try:
            snapshot = dir_index.snapshot(candidate_dir)
        except OSError:
            continue
        if not snapshot.entries:
            continue
        target = min(ordinal, len(snapshot.entries) - 1)
        return _sibling(candidate_dir, snapshot.entries[target], target, len(snapshot.entries))

    raise FileNotFound(f"{to_posix(grandparent)} 中没有更多含 npz 的兄弟文件夹")


def locate(path: Path) -> SiblingResult:
    snapshot = dir_index.snapshot(path.parent)
    index = snapshot.index_of(path.name)
    if index < 0:
        raise FileNotFound(to_posix(path))
    entry = snapshot.entries[index]
    mtime, size = _stamp(path, entry)
    return SiblingResult(
        path=to_posix(path),
        name=path.name,
        index=index,
        total=len(snapshot.entries),
        mtime=mtime,
        size=size,
    )


def sibling_at(path: Path, index: int) -> SiblingResult:
    """The ``index``-th npz in ``path``'s folder, in natural-name order."""
    snapshot = dir_index.snapshot(path.parent)
    total = len(snapshot.entries)
    if total == 0:
        raise FileNotFound(f"{to_posix(path.parent)} 中没有 npz")
    if not 0 <= index < total:
        raise BadParam(f"序号越界: {index}，有效范围 0~{total - 1}")
    return _sibling(path.parent, snapshot.entries[index], index, total)


def sorted_subdir_names(directory: Path) -> list[str]:
    return sorted((entry.name for entry in dir_index.subdirs(directory)), key=natural_key)
