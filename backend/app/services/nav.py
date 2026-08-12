from __future__ import annotations

import os
from pathlib import Path

from ..errors import FileNotFound
from ..models import SiblingResult
from ..paths import natural_key, to_posix
from .dirindex import dir_index

# A run of npz-less sibling folders should not turn navigation into a dead end.
MAX_FOLDER_PROBES = 64


def _step(index: int, direction: str) -> int:
    return index + (1 if direction == "next" else -1)


def sibling_file(path: Path, direction: str) -> SiblingResult:
    """Next/previous npz inside the same folder, in natural-name order."""
    snapshot = dir_index.snapshot(path.parent)
    index = snapshot.index_of(path.name)
    if index < 0:
        raise FileNotFound(to_posix(path))
    target = _step(index, direction)
    if not 0 <= target < len(snapshot.entries):
        raise FileNotFound(f"{to_posix(path.parent)} 中没有更多 npz")
    entry = snapshot.entries[target]
    return SiblingResult(
        path=to_posix(path.parent / entry.name),
        name=entry.name,
        index=target,
        total=len(snapshot.entries),
    )


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
        entry = snapshot.entries[target]
        return SiblingResult(
            path=to_posix(candidate_dir / entry.name),
            name=entry.name,
            index=target,
            total=len(snapshot.entries),
        )

    raise FileNotFound(f"{to_posix(grandparent)} 中没有更多含 npz 的兄弟文件夹")


def locate(path: Path) -> SiblingResult:
    snapshot = dir_index.snapshot(path.parent)
    index = snapshot.index_of(path.name)
    if index < 0:
        raise FileNotFound(to_posix(path))
    return SiblingResult(
        path=to_posix(path), name=path.name, index=index, total=len(snapshot.entries)
    )


def sorted_subdir_names(directory: Path) -> list[str]:
    return sorted((entry.name for entry in dir_index.subdirs(directory)), key=natural_key)
