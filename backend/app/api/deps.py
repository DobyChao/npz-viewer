from __future__ import annotations

from pathlib import Path

from fastapi import Request, Response

from ..config import get_roots_store
from ..errors import BadParam
from ..paths import require_dir, require_file, resolve_within

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
REVALIDATE_CACHE = "private, max-age=0, must-revalidate"


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
    """Serve an image, honouring conditional requests.

    Versioned URLs (``v=`` present) are immutable: the frontend changes ``v``
    whenever the npz mtime/size change. Unversioned URLs must revalidate,
    otherwise sequence playback would keep a rewritten file from HTTP cache.
    """
    versioned = bool(request.query_params.get("v"))
    headers = {
        "ETag": etag,
        "Cache-Control": IMMUTABLE_CACHE if versioned else REVALIDATE_CACHE,
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type=mime, headers=headers)
