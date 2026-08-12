from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Query

from ..models import SiblingResult
from ..services import nav
from .deps import resolve_file

router = APIRouter(prefix="/api/nav", tags=["nav"])


@router.get("/sibling", response_model=SiblingResult)
async def sibling(
    path: str = Query(...),
    scope: Literal["file", "folder"] = "file",
    direction: Literal["next", "prev"] = "next",
) -> SiblingResult:
    target = resolve_file(path)
    worker = nav.sibling_file if scope == "file" else nav.sibling_folder
    return await asyncio.to_thread(worker, target, direction)


@router.get("/locate", response_model=SiblingResult)
async def locate(path: str = Query(...)) -> SiblingResult:
    target = resolve_file(path)
    return await asyncio.to_thread(nav.locate, target)
