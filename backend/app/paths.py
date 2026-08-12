from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path

from .errors import FileNotFound, PathOutsideRoot

_NUM_RE = re.compile(r"(\d+)")


def to_posix(path: Path | str) -> str:
    """Canonical wire format for every path the API emits: forward slashes, e.g. ``D:/data``."""
    return Path(path).as_posix()


def parse_path(raw: str) -> Path:
    return Path(str(raw).strip().replace("\\", "/"))


def _normcase(path: Path) -> str:
    return os.path.normcase(str(path))


def is_within(child: Path, parent: Path) -> bool:
    c = _normcase(child)
    p = _normcase(parent).rstrip("\\/")
    if not p:
        return False
    return c == p or c.startswith(p + os.sep) or c.startswith(p + "/")


def resolve_within(raw: str, roots: Iterable[Path]) -> Path:
    """Resolve a user-supplied path and refuse anything escaping the configured roots.

    Symlinks are resolved before the check so a link inside a root cannot point outside it.
    """
    candidate = parse_path(raw)
    if not candidate.is_absolute():
        raise PathOutsideRoot(raw)
    resolved = candidate.resolve(strict=False)
    for root in roots:
        if is_within(resolved, root.resolve(strict=False)):
            return resolved
    raise PathOutsideRoot(raw)


def require_dir(path: Path) -> Path:
    if not path.is_dir():
        raise FileNotFound(to_posix(path))
    return path


def require_file(path: Path) -> Path:
    if not path.is_file():
        raise FileNotFound(to_posix(path))
    return path


def natural_key(name: str) -> tuple[tuple[int, int, str], ...]:
    """Sort key so that ``img_2`` precedes ``img_10``.

    Case is folded so Windows and Linux produce the same ordering.
    """
    out: list[tuple[int, int, str]] = []
    for index, part in enumerate(_NUM_RE.split(name.casefold())):
        if index % 2:
            out.append((1, int(part), ""))
        elif part:
            out.append((0, 0, part))
    return tuple(out)
