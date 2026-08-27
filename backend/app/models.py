from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

KeyKind = Literal["rgb", "rgba", "gray", "gainmap", "stack", "table", "scalar", "raw"]
Layout = Literal["chw", "hwc"]
Gamut = Literal["bt2020", "p3"]
SortField = Literal["name", "mtime", "size"]
SortOrder = Literal["asc", "desc"]
AlphaMode = Literal["composite", "rgb", "alpha"]
Colormap = Literal["none", "viridis", "magma", "turbo"]
ImageFormat = Literal["png", "webp"]


class Health(BaseModel):
    ok: bool = True
    version: str


class RootInfo(BaseModel):
    id: str
    name: str
    path: str
    exists: bool


class RootList(BaseModel):
    roots: list[RootInfo]


class RootCreate(BaseModel):
    name: str = ""
    path: str


class DirEntryInfo(BaseModel):
    name: str
    path: str
    has_children: bool


class DirListing(BaseModel):
    path: str
    parent: str | None
    dirs: list[DirEntryInfo]


class RefreshRequest(BaseModel):
    path: str


class RefreshResult(BaseModel):
    path: str
    cleared: bool


class NpzFileInfo(BaseModel):
    name: str
    path: str
    size: int
    mtime: float


class NpzListPage(BaseModel):
    dir: str
    total: int
    page: int
    page_size: int
    pages: int
    items: list[NpzFileInfo]


class KeyMeta(BaseModel):
    name: str
    shape: list[int]
    dtype: str
    kind: KeyKind
    layout: Layout | None = None
    ambiguous: bool = False
    batch: int | None = None
    channels: int | None = None
    height: int | None = None
    width: int | None = None
    channel_axis: int | None = None
    nbytes: int
    renderable: bool = False
    note: str | None = None


class NpzMeta(BaseModel):
    path: str
    name: str
    size: int
    mtime: float
    compressed: bool
    keys: list[KeyMeta]


class ArrayStats(BaseModel):
    min: float | None
    max: float | None
    mean: float | None
    std: float | None
    p1: float | None
    p99: float | None
    nan_count: int
    inf_count: int
    count: int


class KeyData(BaseModel):
    path: str
    key: str
    shape: list[int]
    dtype: str
    kind: KeyKind
    values: object
    truncated: bool = False
    stats: ArrayStats | None = None


class PixelValue(BaseModel):
    x: int
    y: int
    values: list[float | None]


class SiblingResult(BaseModel):
    path: str
    name: str
    index: int
    total: int


VideoJobStatus = Literal["queued", "running", "done", "error", "cancelled"]
VideoCrop = Literal["full", "viewport"]
CompareGridLayout = Literal["auto", "1x1", "1x2", "2x1", "1x3", "3x1", "2x2"]


class ExportKey(BaseModel):
    key: str
    batch: int = 0
    layout: str = "auto"
    channel: int = 0
    normalize: bool = False
    colormap: Colormap = "none"
    alpha: AlphaMode = "composite"
    gainmap_gamut: bool = False


class NaturalSize(BaseModel):
    width: int
    height: int


class ViewportSpec(BaseModel):
    scale: float
    x: float
    y: float
    tile_width: float
    tile_height: float
    natural_sizes: list[NaturalSize] = []


class VideoExportRequest(BaseModel):
    path: str
    keys: list[ExportKey]
    start: int
    end: int
    fps: float = 12
    layout: CompareGridLayout = "auto"
    crop: VideoCrop = "full"
    max_size: int = 1920
    equal_height: bool = False
    confirm_large: bool = False
    gamut: Gamut = "bt2020"
    viewport: ViewportSpec | None = None


class VideoJobInfo(BaseModel):
    id: str
    status: VideoJobStatus
    current: int = 0
    total: int = 0
    error: str | None = None
    filename: str | None = None
