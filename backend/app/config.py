from __future__ import annotations

import hashlib
import os
import re
import sys
import threading
from pathlib import Path

import orjson
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .errors import BadParam

REPO_ROOT = Path(__file__).resolve().parents[2]


def default_cache_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "npz_view" / "cache"
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        return Path(xdg) / "npz_view"
    return Path.home() / ".cache" / "npz_view"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NPZVIEW_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8756
    roots_file: Path = REPO_ROOT / "roots.json"
    cache_dir: Path = Field(default_factory=default_cache_dir)
    max_cache_gb: float = 8.0
    array_cache_mb: int = 2048
    dir_cache_slots: int = 32
    allow_pickle: bool = False
    small_matrix_max: int = 9
    # Output is untagged 8-bit; flipping this on would require bundling ICC profiles.
    embed_icc: bool = False
    static_dir: Path | None = None
    # Only needed when the dev frontend is served without Vite's /api proxy.
    cors_origins: list[str] = [
        "http://localhost:5273",
        "http://127.0.0.1:5273",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    @property
    def render_cache_dir(self) -> Path:
        return self.cache_dir / "render"

    @property
    def thumb_cache_dir(self) -> Path:
        return self.cache_dir / "thumb"

    @property
    def dirindex_cache_dir(self) -> Path:
        return self.cache_dir / "dirindex"

    @property
    def header_cache_dir(self) -> Path:
        return self.cache_dir / "header"

    @property
    def video_cache_dir(self) -> Path:
        return self.cache_dir / "video"

    def ensure_dirs(self) -> None:
        for directory in (
            self.render_cache_dir,
            self.thumb_cache_dir,
            self.dirindex_cache_dir,
            self.header_cache_dir,
            self.video_cache_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)


_settings = Settings()


def get_settings() -> Settings:
    return _settings


def set_settings(settings: Settings) -> None:
    global _settings
    _settings = settings


class RootEntry(BaseModel):
    id: str
    name: str
    path: str


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return slug or "root"


def make_root_id(name: str, path: str) -> str:
    digest = hashlib.sha1(path.casefold().encode("utf-8")).hexdigest()[:6]
    return f"{_slugify(name)}-{digest}"


class RootsStore:
    """Reads ``roots.json`` on demand, hot-reloading whenever its mtime changes.

    The file is meant to be hand-editable while the server runs, so every read
    re-stats it instead of trusting a process-lifetime cache.
    """

    def __init__(self, file: Path) -> None:
        self._file = file
        self._lock = threading.Lock()
        self._mtime: float | None = None
        self._roots: list[RootEntry] = []

    @property
    def file(self) -> Path:
        return self._file

    def load(self) -> list[RootEntry]:
        with self._lock:
            try:
                mtime = self._file.stat().st_mtime
            except OSError:
                self._mtime = None
                self._roots = []
                return []
            if mtime != self._mtime:
                self._roots = self._read()
                self._mtime = mtime
            return list(self._roots)

    def _read(self) -> list[RootEntry]:
        try:
            payload = orjson.loads(self._file.read_bytes())
        except (orjson.JSONDecodeError, OSError):
            return []
        raw_roots = payload.get("roots") if isinstance(payload, dict) else None
        if not isinstance(raw_roots, list):
            return []
        entries: list[RootEntry] = []
        seen: set[str] = set()
        for item in raw_roots:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path", "")).strip().replace("\\", "/")
            name = str(item.get("name") or path or "root")
            if not path:
                continue
            entry_id = str(item.get("id") or make_root_id(name, path))
            if entry_id in seen:
                continue
            seen.add(entry_id)
            entries.append(RootEntry(id=entry_id, name=name, path=path))
        return entries

    def _write(self, roots: list[RootEntry]) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        blob = orjson.dumps(
            {"roots": [entry.model_dump() for entry in roots]},
            option=orjson.OPT_INDENT_2,
        )
        self._file.write_bytes(blob)
        self._mtime = self._file.stat().st_mtime
        self._roots = roots

    def add(self, name: str, path: str) -> RootEntry:
        normalized = str(path).strip().replace("\\", "/")
        if not normalized:
            raise BadParam("root 路径不能为空")
        candidate = Path(normalized)
        if not candidate.is_absolute():
            raise BadParam(f"root 必须是绝对路径: {path}")
        if not candidate.is_dir():
            raise BadParam(f"root 目录不存在: {path}")
        resolved = candidate.resolve(strict=False).as_posix()
        display = name.strip() or candidate.name or resolved
        roots = self.load()
        for entry in roots:
            if os.path.normcase(entry.path) == os.path.normcase(resolved):
                return entry
        entry = RootEntry(id=make_root_id(display, resolved), name=display, path=resolved)
        with self._lock:
            self._write([*roots, entry])
        return entry

    def remove(self, root_id: str) -> bool:
        roots = self.load()
        remaining = [entry for entry in roots if entry.id != root_id]
        if len(remaining) == len(roots):
            return False
        with self._lock:
            self._write(remaining)
        return True

    def root_paths(self) -> list[Path]:
        return [Path(entry.path) for entry in self.load()]


_roots_store: RootsStore | None = None


def get_roots_store() -> RootsStore:
    global _roots_store
    settings = get_settings()
    if _roots_store is None or _roots_store.file != settings.roots_file:
        _roots_store = RootsStore(settings.roots_file)
    return _roots_store
