from __future__ import annotations

from pathlib import Path

import pytest

from app.errors import PathOutsideRoot
from app.paths import is_within, natural_key, resolve_within, to_posix


def test_natural_sort_orders_numbers_numerically() -> None:
    names = ["img_10.npz", "img_2.npz", "img_1.npz", "IMG_3.npz"]
    assert sorted(names, key=natural_key) == [
        "img_1.npz",
        "img_2.npz",
        "IMG_3.npz",
        "img_10.npz",
    ]


def test_natural_sort_is_case_insensitive() -> None:
    assert natural_key("Frame_5") == natural_key("frame_5")


def test_is_within_rejects_sibling_prefix(tmp_path: Path) -> None:
    root = tmp_path / "data"
    root.mkdir()
    sibling = tmp_path / "data_backup"
    sibling.mkdir()
    assert is_within(root / "a" / "b", root)
    assert is_within(root, root)
    assert not is_within(sibling, root)


def test_resolve_within_blocks_traversal(tmp_path: Path) -> None:
    root = tmp_path / "data"
    (root / "inner").mkdir(parents=True)
    roots = [root]
    assert resolve_within((root / "inner").as_posix(), roots) == (root / "inner").resolve()
    with pytest.raises(PathOutsideRoot):
        resolve_within((root / ".." / "elsewhere").as_posix(), roots)
    with pytest.raises(PathOutsideRoot):
        resolve_within("relative/path", roots)


def test_to_posix_normalises_separators(tmp_path: Path) -> None:
    assert "\\" not in to_posix(tmp_path / "a" / "b")
