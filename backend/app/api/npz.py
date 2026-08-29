from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, Query, Request, Response

from ..errors import UnsupportedKind
from ..models import (
    AlphaMode,
    ArrayStats,
    Colormap,
    Gamut,
    ImageFormat,
    KeyData,
    Layout,
    NpzFileInfo,
    NpzListPage,
    NpzMeta,
    PixelValue,
    SortField,
    SortOrder,
)
from ..paths import to_posix
from ..services import npzio, ratio, render
from ..services.dirindex import dir_index, filter_entries, paginate
from .deps import image_response, resolve_dir, resolve_file

router = APIRouter(prefix="/api/npz", tags=["npz"])


def _list_page(
    directory: Path, page: int, page_size: int, sort: str, order: str, query: str
) -> NpzListPage:
    snapshot = dir_index.snapshot(directory)
    entries = filter_entries(snapshot.ordered(sort, order), query)
    items, current_page, pages = paginate(entries, page, page_size)
    return NpzListPage(
        dir=to_posix(directory),
        total=len(entries),
        page=current_page,
        page_size=page_size,
        pages=pages,
        items=[
            NpzFileInfo(
                name=entry.name,
                path=to_posix(directory / entry.name),
                size=entry.size,
                mtime=entry.mtime,
            )
            for entry in items
        ],
    )


@router.get("/list", response_model=NpzListPage)
async def list_npz(
    directory: str = Query(..., alias="dir", description="绝对目录路径"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    sort: SortField = "name",
    order: SortOrder = "asc",
    q: str = Query("", description="文件名子串过滤，大小写不敏感"),
) -> NpzListPage:
    target = resolve_dir(directory)
    return await asyncio.to_thread(_list_page, target, page, page_size, sort, order, q)


def _meta(path: Path) -> NpzMeta:
    keys, compressed = npzio.get_meta(path)
    stat = path.stat()
    return NpzMeta(
        path=to_posix(path),
        name=path.name,
        size=stat.st_size,
        mtime=stat.st_mtime,
        compressed=compressed,
        keys=keys,
    )


@router.get("/meta", response_model=NpzMeta)
async def npz_meta(path: str = Query(...)) -> NpzMeta:
    target = resolve_file(path)
    return await asyncio.to_thread(_meta, target)


@router.get("/data", response_model=KeyData)
async def npz_data(
    path: str = Query(...),
    key: str = Query(...),
    batch: int | None = Query(None, ge=0),
) -> KeyData:
    target = resolve_file(path)
    return await asyncio.to_thread(render.key_data, target, key, batch)


@router.get("/stats", response_model=ArrayStats)
async def npz_stats(
    path: str = Query(...),
    key: str = Query(...),
    batch: int | None = Query(None, ge=0),
) -> ArrayStats:
    target = resolve_file(path)
    return await asyncio.to_thread(render.stats_for, target, key, batch)


@router.get("/render")
async def npz_render(
    request: Request,
    path: str = Query(...),
    key: str = Query(...),
    gamut: Gamut = "bt2020",
    batch: int = Query(0, ge=0),
    layout: Layout | None = Query(None, description="留空或 auto 表示沿用自动判定"),
    channel: int = Query(0, ge=0),
    normalize: bool = False,
    colormap: Colormap = "none",
    gainmap_gamut: bool = False,
    alpha: AlphaMode = "composite",
    max_size: int = Query(0, ge=0, le=16384),
    fmt: ImageFormat = Query("png", alias="format"),
    v: str = Query("", description="缓存击穿用的版本串，服务端忽略"),
) -> Response:
    target = resolve_file(path)
    params = render.RenderParams(
        key=key,
        gamut=gamut,
        batch=batch,
        layout=layout or "auto",
        channel=channel,
        normalize=normalize,
        colormap=colormap,
        gainmap_gamut=gainmap_gamut,
        alpha=alpha,
        max_size=max_size,
        fmt=fmt,
    )
    data, mime, etag = await asyncio.to_thread(render.render, target, params)
    return image_response(request, data, mime, etag)


def _thumbnail(path: Path, key: str | None, prefer: str, size: int, gamut: str):
    chosen = key or render.thumbnail_key_for(path, render.settings_prefer_keys(prefer))
    if not chosen:
        raise UnsupportedKind(f"{path.name} 中没有可渲染成缩略图的 key")
    return render.render_thumbnail(path, chosen, size, gamut)


@router.get("/thumb")
async def npz_thumb(
    request: Request,
    path: str = Query(...),
    key: str | None = Query(None, description="留空则按 prefer 自动挑选"),
    prefer: str = Query("", description="优先 key 名，逗号分隔"),
    size: int = Query(192, ge=16, le=1024),
    gamut: Gamut = "bt2020",
    v: str = Query(""),
) -> Response:
    target = resolve_file(path)
    data, mime, etag = await asyncio.to_thread(_thumbnail, target, key, prefer, size, gamut)
    return image_response(request, data, mime, etag)


@router.get("/pixel", response_model=PixelValue)
async def npz_pixel(
    path: str = Query(...),
    key: str = Query(...),
    x: int = Query(..., ge=0),
    y: int = Query(..., ge=0),
    batch: int = Query(0, ge=0),
) -> PixelValue:
    target = resolve_file(path)
    return await asyncio.to_thread(render.pixel_value, target, key, x, y, batch)


def _operand(
    key: str, batch: int, layout: Layout | None, channel: int
) -> ratio.OperandParams:
    return ratio.OperandParams(key=key, batch=batch, layout=layout or "auto", channel=channel)


@router.get("/ratio/render")
async def ratio_render(
    request: Request,
    path_a: str = Query(..., description="分子（numerator）所在 npz"),
    key_a: str = Query(...),
    path_b: str | None = Query(None, description="分母所在 npz；缺省与 path_a 相同"),
    key_b: str = Query(...),
    gamut: Gamut = "bt2020",
    batch_a: int = Query(0, ge=0),
    batch_b: int = Query(0, ge=0),
    layout_a: Layout | None = Query(None),
    layout_b: Layout | None = Query(None),
    channel_a: int = Query(0, ge=0),
    channel_b: int = Query(0, ge=0),
    colormap: Colormap = "none",
    gainmap_gamut: bool = False,
    max_size: int = Query(0, ge=0, le=16384),
    fmt: ImageFormat = Query("png", alias="format"),
    v: str = Query("", description="缓存击穿用的版本串，服务端忽略"),
) -> Response:
    path_num = resolve_file(path_a)
    path_den = resolve_file(path_b) if path_b else path_num
    params = ratio.RatioParams(
        num=_operand(key_a, batch_a, layout_a, channel_a),
        den=_operand(key_b, batch_b, layout_b, channel_b),
        gamut=gamut,
        colormap=colormap,
        gainmap_gamut=gainmap_gamut,
        max_size=max_size,
        fmt=fmt,
    )
    data, mime, etag = await asyncio.to_thread(ratio.render_ratio, path_num, path_den, params)
    return image_response(request, data, mime, etag)


@router.get("/ratio/pixel", response_model=PixelValue)
async def ratio_pixel_endpoint(
    path_a: str = Query(...),
    key_a: str = Query(...),
    path_b: str | None = Query(None),
    key_b: str = Query(...),
    x: int = Query(..., ge=0),
    y: int = Query(..., ge=0),
    batch_a: int = Query(0, ge=0),
    batch_b: int = Query(0, ge=0),
    layout_a: Layout | None = Query(None),
    layout_b: Layout | None = Query(None),
    channel_a: int = Query(0, ge=0),
    channel_b: int = Query(0, ge=0),
) -> PixelValue:
    path_num = resolve_file(path_a)
    path_den = resolve_file(path_b) if path_b else path_num
    return await asyncio.to_thread(
        ratio.ratio_pixel,
        path_num,
        _operand(key_a, batch_a, layout_a, channel_a),
        path_den,
        _operand(key_b, batch_b, layout_b, channel_b),
        x,
        y,
    )
