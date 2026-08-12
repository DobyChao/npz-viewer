from __future__ import annotations

from pathlib import Path

from fastapi import Request, Response

from ..config import get_roots_store
from ..errors import BadParam
from ..paths import require_dir, require_file, resolve_within

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"


def resolve_dir(raw: str) -> Path:
    return require_dir(resolve_within(raw, get_roots_store().root_paths()))


def resolve_file(raw: str) -> Path:
    return require_file(resolve_within(raw, get_roots_store().root_paths()))


def resolve_any(raw: str) -> Path:
    return resolve_within(raw, get_roots_store().root_paths())


def clamp(value: int, low: int, high: int, *, label: str) -> int:
    if not low <= value <= high:
        raise BadParam(f"{label} 必须在 {low}~{high} 之间，收到 {value}")
    return value


def image_response(request: Request, data: bytes, mime: str, etag: str) -> Response:
    """Serve an immutable image, honouring conditional requests.

    Cache keys already fold in the file's mtime and size, so the frontend appends a
    ``v=`` cache buster whenever the underlying npz changes.
    """
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type=mime, headers=headers)
