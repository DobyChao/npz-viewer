from __future__ import annotations

import os
from dataclasses import astuple, dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image

from ..errors import BadParam, UnsupportedKind
from ..models import KeyMeta, PixelValue
from . import imgcache, npzio
from .render import (
    MIME_BY_FORMAT,
    RenderParams,
    _finite,
    encode_image,
    linear_hwc,
    render_color_plane,
    render_gray_plane,
)

DIVIDE_EPS = np.float32(1e-6)
# Bump when divide/align semantics change so disk render cache does not serve old PNGs.
RATIO_CACHE_VERSION = 2


@dataclass(frozen=True, slots=True)
class OperandParams:
    key: str
    batch: int = 0
    layout: str = "auto"
    channel: int = 0


@dataclass(frozen=True, slots=True)
class RatioParams:
    num: OperandParams
    den: OperandParams
    gamut: str = "bt2020"
    colormap: str = "none"
    gainmap_gamut: bool = False
    max_size: int = 0
    fmt: str = "png"
    quality: int = 88


def operand_plane(array: npt.NDArray, meta: KeyMeta, params: OperandParams) -> npt.NDArray[np.float32]:
    """RGB (H,W,3) or gray (H,W,1) in linear float, matching a render slice."""
    render_params = RenderParams(
        key=params.key, batch=params.batch, layout=params.layout, channel=params.channel
    )
    hwc = linear_hwc(array, meta, render_params)
    channels = hwc.shape[-1]
    is_stack = meta.kind == "stack" or (channels not in (1, 3, 4) and meta.kind != "gainmap")
    if is_stack:
        if not 0 <= params.channel < channels:
            raise BadParam(f"channel 索引越界: {params.channel}，有效范围 0~{channels - 1}")
        return np.ascontiguousarray(hwc[..., params.channel : params.channel + 1])
    if channels == 1:
        return np.ascontiguousarray(hwc[..., :1])
    if channels in (3, 4):
        return np.ascontiguousarray(hwc[..., :3])
    raise UnsupportedKind(f"不支持的通道数: {channels}")


def load_operand(path: Path, params: OperandParams) -> npt.NDArray[np.float32]:
    meta = npzio.find_key(path, params.key)
    if not meta.renderable:
        raise UnsupportedKind(f"key「{params.key}」的 kind 为 {meta.kind}，无法参与比值")
    array = npzio.load_array(path, params.key)
    return operand_plane(array, meta, params)


def resize_hwc(plane: npt.NDArray[np.float32], height: int, width: int) -> npt.NDArray[np.float32]:
    if plane.shape[0] == height and plane.shape[1] == width:
        return plane
    out = np.empty((height, width, plane.shape[-1]), dtype=np.float32)
    for channel in range(plane.shape[-1]):
        image = Image.fromarray(plane[..., channel], mode="F")
        resized = image.resize((width, height), Image.Resampling.BILINEAR)
        out[..., channel] = np.asarray(resized, dtype=np.float32)
    return out


def align_spatial(
    num: npt.NDArray[np.float32], den: npt.NDArray[np.float32]
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    """Bilinear-upsample the smaller plane (by pixel count) onto the larger."""
    n_h, n_w = num.shape[:2]
    d_h, d_w = den.shape[:2]
    if (n_h, n_w) == (d_h, d_w):
        return num, den
    if n_h * n_w >= d_h * d_w:
        return num, resize_hwc(den, n_h, n_w)
    return resize_hwc(num, d_h, d_w), den


def match_channels(
    num: npt.NDArray[np.float32], den: npt.NDArray[np.float32]
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    n_c, d_c = num.shape[-1], den.shape[-1]
    if n_c == d_c:
        return num, den
    if n_c == 1 and d_c == 3:
        return np.repeat(num, 3, axis=-1), den
    if n_c == 3 and d_c == 1:
        return num, np.repeat(den, 3, axis=-1)
    raise BadParam(f"无法对齐通道数: {n_c} 与 {d_c}")


def divide_gainmap(
    num: npt.NDArray[np.float32], den: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    aligned_num, aligned_den = match_channels(*align_spatial(num, den))
    # Keep signed den: max(den, eps) maps negatives to +eps and yellow-clips RGB.
    tiny_num = np.abs(aligned_num) < DIVIDE_EPS
    tiny_den = np.abs(aligned_den) < DIVIDE_EPS
    safe_den = np.where(tiny_den, np.copysign(DIVIDE_EPS, aligned_den), aligned_den)
    ratio = aligned_num / safe_den
    ratio = np.where(tiny_num & tiny_den, np.float32(1.0), ratio)
    return _finite(ratio)


def ratio_array(
    path_num: Path, num: OperandParams, path_den: Path, den: OperandParams
) -> npt.NDArray[np.float32]:
    return divide_gainmap(load_operand(path_num, num), load_operand(path_den, den))


def ratio_pixels(values: npt.NDArray[np.float32], params: RatioParams) -> npt.NDArray[np.uint8]:
    if values.shape[-1] == 1:
        return render_gray_plane(
            values[..., 0],
            is_gainmap=True,
            normalize=False,
            colormap=params.colormap,
        )
    return render_color_plane(
        values,
        is_gainmap=True,
        gamut=params.gamut,
        gainmap_gamut=params.gainmap_gamut,
        alpha_mode="rgb",
    )


def _cache_digest(
    path_num: Path,
    stamp_num: npzio.FileStamp,
    path_den: Path,
    stamp_den: npzio.FileStamp,
    params: RatioParams,
) -> str:
    return imgcache.digest_for(
        (
            os.path.normcase(str(path_num)),
            stamp_num.mtime,
            stamp_num.size,
            os.path.normcase(str(path_den)),
            stamp_den.mtime,
            stamp_den.size,
            astuple(params),
            RATIO_CACHE_VERSION,
        )
    )


def render_ratio(
    path_num: Path, path_den: Path, params: RatioParams
) -> tuple[bytes, str, str]:
    if params.fmt not in MIME_BY_FORMAT:
        raise BadParam(f"不支持的图片格式: {params.fmt}")
    if params.colormap not in ("none", "viridis", "magma", "turbo"):
        raise BadParam(f"不支持的 colormap: {params.colormap}")
    if params.gamut not in ("bt2020", "p3"):
        raise BadParam(f"不支持的色域: {params.gamut}")

    stamp_num = npzio.stamp(path_num)
    stamp_den = npzio.stamp(path_den)
    digest = _cache_digest(path_num, stamp_num, path_den, stamp_den, params)
    etag = f'"{digest}"'
    cached = imgcache.render_cache.get(digest, params.fmt)
    if cached is not None:
        return cached, MIME_BY_FORMAT[params.fmt], etag

    values = ratio_array(path_num, params.num, path_den, params.den)
    encode_params = RenderParams(
        key=params.num.key,
        gamut=params.gamut,
        colormap=params.colormap,
        gainmap_gamut=params.gainmap_gamut,
        max_size=params.max_size,
        fmt=params.fmt,
        quality=params.quality,
    )
    data = encode_image(ratio_pixels(values, params), encode_params)
    imgcache.render_cache.put(digest, params.fmt, data)
    return data, MIME_BY_FORMAT[params.fmt], etag


def ratio_pixel(
    path_num: Path,
    num: OperandParams,
    path_den: Path,
    den: OperandParams,
    x: int,
    y: int,
) -> PixelValue:
    values = ratio_array(path_num, num, path_den, den)
    height, width = values.shape[0], values.shape[1]
    if not (0 <= x < width and 0 <= y < height):
        raise BadParam(f"像素坐标越界: ({x}, {y})，图像尺寸 {width}x{height}")
    raw = values[y, x]
    return PixelValue(
        x=x,
        y=y,
        values=[None if not np.isfinite(float(v)) else float(v) for v in np.atleast_1d(raw)],
    )
