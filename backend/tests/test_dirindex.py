from __future__ import annotations

import time
from pathlib import Path

from app.config import Settings
from app.services.dirindex import dir_index, filter_entries, paginate


def make_files(directory: Path, names: list[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        (directory / name).write_bytes(b"x")


def test_only_npz_files_are_indexed(tmp_path: Path, configured: Settings) -> None:
    make_files(tmp_path / "d", ["a.npz", "b.NPZ", "c.txt", "d.npy"])
    (tmp_path / "d" / "sub").mkdir()
    names = [entry.name for entry in dir_index.snapshot(tmp_path / "d").entries]
    assert names == ["a.npz", "b.NPZ"]


def test_entries_use_natural_order(tmp_path: Path, configured: Settings) -> None:
    make_files(tmp_path / "d", [f"img_{i}.npz" for i in (1, 2, 10, 11, 100)])
    names = [entry.name for entry in dir_index.snapshot(tmp_path / "d").entries]
    assert names == ["img_1.npz", "img_2.npz", "img_10.npz", "img_11.npz", "img_100.npz"]


def test_orderings_are_memoised_and_reversible(tmp_path: Path, configured: Settings) -> None:
    make_files(tmp_path / "d", [f"img_{i}.npz" for i in (1, 2, 3)])
    snapshot = dir_index.snapshot(tmp_path / "d")
    ascending = snapshot.ordered("name", "asc")
    descending = snapshot.ordered("name", "desc")
    assert [entry.name for entry in descending] == [entry.name for entry in reversed(ascending)]
    assert snapshot.ordered("name", "asc") is ascending


def test_size_sort(tmp_path: Path, configured: Settings) -> None:
    directory = tmp_path / "d"
    directory.mkdir()
    (directory / "small.npz").write_bytes(b"x")
    (directory / "big.npz").write_bytes(b"x" * 100)
    snapshot = dir_index.snapshot(directory)
    assert [e.name for e in snapshot.ordered("size", "asc")] == ["small.npz", "big.npz"]
    assert [e.name for e in snapshot.ordered("size", "desc")] == ["big.npz", "small.npz"]


def test_snapshot_is_reused_until_the_directory_changes(
    tmp_path: Path, configured: Settings
) -> None:
    directory = tmp_path / "d"
    make_files(directory, ["a.npz"])
    first = dir_index.snapshot(directory)
    assert dir_index.snapshot(directory) is first

    # Directory mtime granularity can be coarse, so nudge it explicitly.
    make_files(directory, ["b.npz"])
    stat = directory.stat()
    import os

    os.utime(directory, (stat.st_atime, stat.st_mtime + 5))
    second = dir_index.snapshot(directory)
    assert second is not first
    assert len(second.entries) == 2


def test_invalidate_forces_a_rescan(tmp_path: Path, configured: Settings) -> None:
    directory = tmp_path / "d"
    make_files(directory, ["a.npz"])
    first = dir_index.snapshot(directory)
    dir_index.invalidate(directory)
    assert dir_index.snapshot(directory) is not first


def test_filter_is_case_insensitive(tmp_path: Path, configured: Settings) -> None:
    make_files(tmp_path / "d", ["Frame_A.npz", "frame_b.npz", "other.npz"])
    entries = dir_index.snapshot(tmp_path / "d").entries
    assert len(filter_entries(entries, "FRAME")) == 2
    assert len(filter_entries(entries, "")) == 3


def test_pagination_clamps_and_reports_page_count() -> None:
    entries = list(range(0, 25))  # type: ignore[arg-type]
    page, current, pages = paginate(entries, 2, 10)  # type: ignore[arg-type]
    assert page == list(range(10, 20))
    assert (current, pages) == (2, 3)

    page, current, pages = paginate(entries, 99, 10)  # type: ignore[arg-type]
    assert current == 3
    assert page == list(range(20, 25))

    page, current, pages = paginate([], 1, 10)
    assert (page, current, pages) == ([], 1, 1)


def test_subdirs_are_sorted_and_flag_children(tmp_path: Path, configured: Settings) -> None:
    (tmp_path / "d" / "b10" / "leaf").mkdir(parents=True)
    (tmp_path / "d" / "b2").mkdir(parents=True)
    subdirs = dir_index.subdirs(tmp_path / "d")
    assert [entry.name for entry in subdirs] == ["b2", "b10"]
    assert subdirs[1].has_children is True
    assert subdirs[0].has_children is False


def test_large_directory_indexes_quickly(tmp_path: Path, configured: Settings) -> None:
    directory = tmp_path / "many"
    directory.mkdir()
    for index in range(5000):
        (directory / f"f_{index:06d}.npz").write_bytes(b"")
    started = time.perf_counter()
    snapshot = dir_index.snapshot(directory, force=True)
    scan_seconds = time.perf_counter() - started
    assert len(snapshot.entries) == 5000
    # 5k in well under a second keeps the 200k target (~5s) plausible.
    assert scan_seconds < 2.0

    started = time.perf_counter()
    for page in range(1, 21):
        paginate(snapshot.ordered("name", "asc"), page, 50)
    assert (time.perf_counter() - started) < 0.5
