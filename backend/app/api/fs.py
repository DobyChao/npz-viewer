from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, Query

from ..models import DirEntryInfo, DirListing, RefreshRequest, RefreshResult
from ..paths import to_posix
from ..services import npzio
from ..services.dirindex import dir_index
from .deps import resolve_any, resolve_dir

router = APIRouter(prefix="/api/fs", tags=["fs"])


def _listing(directory: Path, force: bool) -> DirListing:
    subdirs = dir_index.subdirs(directory, force=force)
    parent = directory.parent
    return DirListing(
        path=to_posix(directory),
        parent=to_posix(parent) if parent != directory else None,
        dirs=[
            DirEntryInfo(
                name=entry.name,
                path=to_posix(directory / entry.name),
                has_children=entry.has_children,
            )
            for entry in subdirs
        ],
    )


@router.get("/dirs", response_model=DirListing)
async def list_dirs(
    path: str = Query(..., description="绝对目录路径"),
    force: bool = Query(False, description="跳过缓存重新扫描"),
) -> DirListing:
    directory = resolve_dir(path)
    return await asyncio.to_thread(_listing, directory, force)


def _refresh(target: Path) -> RefreshResult:
    cleared = False
    if target.is_dir():
        cleared = dir_index.invalidate(target)
    else:
        npzio.invalidate(target)
        cleared = dir_index.invalidate(target.parent)
    return RefreshResult(path=to_posix(target), cleared=cleared)


@router.post("/refresh", response_model=RefreshResult)
async def refresh(payload: RefreshRequest) -> RefreshResult:
    target = resolve_any(payload.path)
    return await asyncio.to_thread(_refresh, target)
