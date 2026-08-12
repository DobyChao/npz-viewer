from __future__ import annotations

import io
import math
import os
from dataclasses import astuple, dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image

from .. import colormaps
from ..color import bt2020_to_p3, encode_gamma, to_uint8
from ..errors import BadParam, UnsupportedKind
from ..models import ArrayStats, KeyData, KeyMeta, PixelValue
from ..paths import to_posix
from . import imgcache, npzio

PERCENTILE_SAMPLE_LIMIT = 500_000
LONG_VECTOR_HEAD = 32
LONG_VECTOR_FULL_LIMIT = 256
RAW_REPR_LIMIT = 2048

MIME_BY_FORMAT = {"png": "image/png", "webp": "image/webp"}


@dataclass(frozen=True, slots=True)
class RenderParams:
    key: str
    gamut: str = "bt2020"
    batch: int = 0
    layout: str = "auto"
    channel: int = 0
    normalize: bool = False
    colormap: str = "none"
    gainmap_gamut: bool = False
    alpha: str = "composite"
    max_size: int = 0
    fmt: str = "png"
    quality: int = 88


# ---------------------------------------------------------------------------
# numeric preparation
# ---------------------------------------------------------------------------

_UNSIGNED_SCALES: dict[str, float] = {
    "uint8": 255.0,
    "uint16": 65535.0,
    "uint32": 4294967295.0,
}


def to_linear_float(array: npt.NDArray) -> npt.NDArray[np.float32]:
    """Bring any supported dtype onto the 0..1 linear scale the pipeline assumes."""
    scale = _UNSIGNED_SCALES.get(array.dtype.name)
    result = array.astype(np.float32)
    if scale is not None:
        result /= np.float32(scale)
    return result


def _slice_batch(array: npt.NDArray, meta: KeyMeta, batch: int) -> npt.NDArray:
    if meta.batch is None:
        return array
    if not 0 <= batch < meta.batch:
        raise BadParam(f"batch 索引越界: {batch}，有效范围 0~{meta.batch - 1}")
    return array[batch]


def _resolve_layout(meta: KeyMeta, override: str) -> str | None:
    if override in ("chw", "hwc"):
        return override
    return meta.layout


def _as_hwc(array: npt.NDArray, layout: str | None) -> npt.NDArray:
    if array.ndim == 2:
        return array[:, :, None]
    if array.ndim != 3:
        raise UnsupportedKind(f"无法作为图像渲染，维度为 {array.ndim}")
    if layout == "chw":
        return np.moveaxis(array, 0, -1)
    return array


def _finite(array: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    return np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=0.0)


# ---------------------------------------------------------------------------
# pixel pipelines (docs/SPEC.md sections 4.3 - 4.5)
# ---------------------------------------------------------------------------


def render_color_plane(
    hwc: npt.NDArray[np.float32],
    *,
    is_gainmap: bool,
    gamut: str,
    gainmap_gamut: bool,
    alpha_mode: str,
) -> npt.NDArray[np.uint8]:
    rgb = _finite(hwc[..., :3])
    alpha = hwc[..., 3] if hwc.shape[-1] >= 4 else None

    if alpha_mode == "alpha":
        if alpha is None:
            raise BadParam("该数组没有 alpha 通道")
        return to_uint8(np.clip(_finite(alpha), 0.0, 1.0))

    rgb = np.clip(rgb, 0.0, 2.0) / 2.0 if is_gainmap else np.clip(rgb, 0.0, 1.0)

    if gamut == "p3" and (not is_gainmap or gainmap_gamut):
        rgb = np.clip(bt2020_to_p3(rgb), 0.0, 1.0)

    pixels = to_uint8(encode_gamma(rgb))

    if alpha is not None and alpha_mode == "composite":
        alpha8 = to_uint8(np.clip(_finite(alpha), 0.0, 1.0))
        pixels = np.concatenate([pixels, alpha8[..., None]], axis=-1)
    return pixels


def render_gray_plane(
    plane: npt.NDArray[np.float32],
    *,
    is_gainmap: bool,
    normalize: bool,
    colormap: str,
) -> npt.NDArray[np.uint8]:
    """Masks and single-channel data stay linear on purpose: no gamma is applied."""
    values = _finite(plane)
    if is_gainmap:
        values = np.clip(values, 0.0, 2.0) / 2.0
    elif normalize:
        low = float(values.min())
        high = float(values.max())
        values = (values - low) / (high - low) if high > low else np.zeros_like(values)
    else:
        values = np.clip(values, 0.0, 1.0)

    if colormap != "none":
        return colormaps.apply(values, colormap)
    return to_uint8(values)


def pixels_for(array: npt.NDArray, meta: KeyMeta, params: RenderParams) -> npt.NDArray[np.uint8]:
    sliced = _slice_batch(array, meta, params.batch)
    layout = _resolve_layout(meta, params.layout)
    hwc = _as_hwc(to_linear_float(sliced), layout)
    channels = hwc.shape[-1]
    is_gainmap = meta.kind == "gainmap"

    if meta.kind == "stack" or (channels not in (1, 3, 4) and meta.kind != "gainmap"):
        if not 0 <= params.channel < channels:
            raise BadParam(f"channel 索引越界: {params.channel}，有效范围 0~{channels - 1}")
        return render_gray_plane(
            hwc[..., params.channel],
            is_gainmap=False,
            normalize=params.normalize,
            colormap=params.colormap,
        )

    if channels == 1:
        return render_gray_plane(
            hwc[..., 0],
            is_gainmap=is_gainmap,
            normalize=params.normalize,
            colormap=params.colormap,
        )

    if channels in (3, 4):
        return render_color_plane(
            hwc,
            is_gainmap=is_gainmap,
            gamut=params.gamut,
            gainmap_gamut=params.gainmap_gamut,
            alpha_mode=params.alpha,
        )

    raise UnsupportedKind(f"不支持的通道数: {channels}")


def encode_image(pixels: npt.NDArray[np.uint8], params: RenderParams) -> bytes:
    image = Image.fromarray(np.ascontiguousarray(pixels))
    if params.max_size > 0 and max(image.size) > params.max_size:
        scale = params.max_size / max(image.size)
        target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(target, Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    if params.fmt == "webp":
        image.save(buffer, format="WEBP", quality=params.quality, method=4)
    else:
        image.save(buffer, format="PNG", compress_level=4)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# public entry points
# ---------------------------------------------------------------------------


def _cache_digest(path: Path, current: npzio.FileStamp, params: RenderParams) -> str:
    return imgcache.digest_for(
        (os.path.normcase(str(path)), current.mtime, current.size, astuple(params))
    )


def render(path: Path, params: RenderParams) -> tuple[bytes, str, str]:
    """Return ``(image_bytes, mime, etag)``, served from the disk cache when possible."""
    if params.fmt not in MIME_BY_FORMAT:
        raise BadParam(f"不支持的图片格式: {params.fmt}")
    if params.colormap not in colormaps.AVAILABLE:
        raise BadParam(f"不支持的 colormap: {params.colormap}")
    if params.gamut not in ("bt2020", "p3"):
        raise BadParam(f"不支持的色域: {params.gamut}")
    if params.alpha not in ("composite", "rgb", "alpha"):
        raise BadParam(f"不支持的 alpha 模式: {params.alpha}")

    meta = npzio.find_key(path, params.key)
    if not meta.renderable:
        raise UnsupportedKind(
            f"key「{params.key}」的 kind 为 {meta.kind}，无法渲染为图片"
        )

    current = npzio.stamp(path)
    digest = _cache_digest(path, current, params)
    etag = f'"{digest}"'
    cached = imgcache.render_cache.get(digest, params.fmt)
    if cached is not None:
        return cached, MIME_BY_FORMAT[params.fmt], etag

    array = npzio.load_array(path, params.key)
    data = encode_image(pixels_for(array, meta, params), params)
    imgcache.render_cache.put(digest, params.fmt, data)
    return data, MIME_BY_FORMAT[params.fmt], etag


def pick_thumbnail_key(keys: list[KeyMeta], prefer: list[str]) -> str | None:
    color_keys = [item for item in keys if item.renderable and item.channels in (3, 4)]
    for token in prefer:
        needle = token.strip().casefold()
        if not needle:
            continue
        for item in color_keys:
            if needle in item.name.casefold():
                return item.name
    if color_keys:
        return color_keys[0].name
    renderable = [item for item in keys if item.renderable]
    return renderable[0].name if renderable else None


def render_thumbnail(
    path: Path, key: str, size: int, gamut: str
) -> tuple[bytes, str, str]:
    params = RenderParams(key=key, gamut=gamut, max_size=size, fmt="webp", quality=80)
    current = npzio.stamp(path)
    digest = _cache_digest(path, current, params)
    etag = f'"{digest}"'
    cached = imgcache.thumb_cache.get(digest, "webp")
    if cached is not None:
        return cached, "image/webp", etag

    meta = npzio.find_key(path, key)
    if not meta.renderable:
        raise UnsupportedKind(f"key「{key}」无法渲染为缩略图")
    array = npzio.load_array(path, key)
    data = encode_image(pixels_for(array, meta, params), params)
    imgcache.thumb_cache.put(digest, "webp", data)
    return data, "image/webp", etag


# ---------------------------------------------------------------------------
# statistics and raw values
# ---------------------------------------------------------------------------


def _as_real(array: npt.NDArray) -> npt.NDArray[np.float64]:
    flat = np.asarray(array).reshape(-1)
    if flat.dtype.kind == "c":
        flat = np.abs(flat)
    return flat.astype(np.float64, copy=False)


def compute_stats(array: npt.NDArray) -> ArrayStats:
    if np.asarray(array).dtype.kind not in npzio.NUMERIC_KINDS:
        return ArrayStats(
            min=None, max=None, mean=None, std=None, p1=None, p99=None,
            nan_count=0, inf_count=0, count=int(np.asarray(array).size),
        )
    values = _as_real(array)
    nan_count = int(np.isnan(values).sum())
    inf_count = int(np.isinf(values).sum())
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return ArrayStats(
            min=None, max=None, mean=None, std=None, p1=None, p99=None,
            nan_count=nan_count, inf_count=inf_count, count=int(values.size),
        )
    # Exact percentiles over tens of millions of samples cost a full sort; stride-sample instead.
    sample = finite
    if finite.size > PERCENTILE_SAMPLE_LIMIT:
        step = math.ceil(finite.size / PERCENTILE_SAMPLE_LIMIT)
        sample = finite[::step]
    p1, p99 = np.percentile(sample, [1.0, 99.0])
    return ArrayStats(
        min=float(finite.min()),
        max=float(finite.max()),
        mean=float(finite.mean()),
        std=float(finite.std()),
        p1=float(p1),
        p99=float(p99),
        nan_count=nan_count,
        inf_count=inf_count,
        count=int(values.size),
    )


def _finite_or_none(value: float) -> float | None:
    return value if math.isfinite(value) else None


def _sanitize(value: object) -> object:
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, float):
        return _finite_or_none(value)
    return value


def key_data(path: Path, key: str, batch: int | None = None) -> KeyData:
    meta = npzio.find_key(path, key)
    array = npzio.load_array(path, key)
    if meta.batch is not None and batch is not None:
        array = _slice_batch(array, meta, batch)

    truncated = False
    if array.dtype.kind not in npzio.NUMERIC_KINDS:
        values: object = repr(array.tolist() if array.ndim else array.item())[:RAW_REPR_LIMIT]
        truncated = len(repr(array)) > RAW_REPR_LIMIT
        stats = None
    elif array.ndim == 0:
        values = _sanitize(array.item())
        stats = None
    elif array.ndim == 1 and array.size > LONG_VECTOR_FULL_LIMIT:
        head = _sanitize(array[:LONG_VECTOR_HEAD].tolist())
        tail = _sanitize(array[-LONG_VECTOR_HEAD:].tolist())
        values = {"head": head, "tail": tail}
        truncated = True
        stats = compute_stats(array)
    elif array.ndim <= 2:
        values = _sanitize(array.tolist())
        stats = compute_stats(array)
    else:
        values = None
        truncated = True
        stats = compute_stats(array)

    return KeyData(
        path=to_posix(path),
        key=key,
        shape=list(array.shape),
        dtype=str(array.dtype),
        kind=meta.kind,
        values=values,
        truncated=truncated,
        stats=stats,
    )


def pixel_value(path: Path, key: str, x: int, y: int, batch: int) -> PixelValue:
    meta = npzio.find_key(path, key)
    array = npzio.load_array(path, key)
    sliced = _slice_batch(array, meta, batch)
    layout = _resolve_layout(meta, "auto")
    hwc = _as_hwc(sliced, layout)
    height, width = hwc.shape[0], hwc.shape[1]
    if not (0 <= x < width and 0 <= y < height):
        raise BadParam(f"像素坐标越界: ({x}, {y})，图像尺寸 {width}x{height}")
    raw = hwc[y, x]
    if raw.dtype.kind == "c":
        raw = np.abs(raw)
    return PixelValue(x=x, y=y, values=[_finite_or_none(float(v)) for v in np.atleast_1d(raw)])


def stats_for(path: Path, key: str, batch: int | None = None) -> ArrayStats:
    meta = npzio.find_key(path, key)
    array = npzio.load_array(path, key)
    if meta.batch is not None and batch is not None:
        array = _slice_batch(array, meta, batch)
    return compute_stats(array)


def settings_prefer_keys(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [token for token in raw.replace(";", ",").split(",") if token.strip()]


def thumbnail_key_for(path: Path, prefer: list[str]) -> str | None:
    keys, _ = npzio.get_meta(path)
    return pick_thumbnail_key(keys, prefer)
