from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter

from ..config import get_roots_store
from ..errors import AppError
from ..models import RootCreate, RootInfo, RootList

router = APIRouter(prefix="/api/roots", tags=["roots"])


def _to_info(entry_id: str, name: str, path: str) -> RootInfo:
    return RootInfo(id=entry_id, name=name, path=path, exists=Path(path).is_dir())


@router.get("", response_model=RootList)
async def list_roots() -> RootList:
    entries = await asyncio.to_thread(get_roots_store().load)
    return RootList(roots=[_to_info(item.id, item.name, item.path) for item in entries])


@router.post("", response_model=RootInfo)
async def create_root(payload: RootCreate) -> RootInfo:
    entry = await asyncio.to_thread(get_roots_store().add, payload.name, payload.path)
    return _to_info(entry.id, entry.name, entry.path)


@router.delete("/{root_id}", response_model=RootList)
async def delete_root(root_id: str) -> RootList:
    store = get_roots_store()
    removed = await asyncio.to_thread(store.remove, root_id)
    if not removed:
        raise AppError("FILE_NOT_FOUND", f"没有 id 为 {root_id} 的 root", status=404)
    entries = await asyncio.to_thread(store.load)
    return RootList(roots=[_to_info(item.id, item.name, item.path) for item in entries])
