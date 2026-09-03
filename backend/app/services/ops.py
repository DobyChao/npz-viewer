from __future__ import annotations

import os
from collections.abc import Callable
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
# Bump when apply/align/encode semantics change so disk render cache drops old PNGs.
OP_CACHE_VERSION = 1

ApplyFn = Callable[
    [npt.NDArray[np.float32], npt.NDArray[np.float32]], npt.NDArray[np.float32]
]


@dataclass(frozen=True, slots=True)
class Operator:
    id: str
    symbol: str
    label: str
    display: str  # "gainmap" | "linear"
    apply: ApplyFn

    def public(self) -> dict[str, str]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "label": self.label,
            "display": self.display,
        }


def _divide(
    left: npt.NDArray[np.float32], right: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    # Keep signed den: max(den, eps) maps negatives to +eps and yellow-clips RGB.
    tiny_left = np.abs(left) < DIVIDE_EPS
    tiny_right = np.abs(right) < DIVIDE_EPS
    safe_right = np.where(tiny_right, np.copysign(DIVIDE_EPS, right), right)
    ratio = left / safe_right
    ratio = np.where(tiny_left & tiny_right, np.float32(1.0), ratio)
    return _finite(ratio)


def _multiply(
    left: npt.NDArray[np.float32], right: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    return _finite(left * right)


# Adding an operator: apply(left, right) on aligned HWC float32, then register here.
# Frontend lib/ops.ts BINARY_OPS ids must match.
OPERATORS: dict[str, Operator] = {
    "div": Operator("div", "÷", "除法", "gainmap", _divide),
    "mul": Operator("mul", "×", "乘法", "linear", _multiply),
}


def get_operator(op_id: str) -> Operator:
    operator = OPERATORS.get(op_id)
    if operator is None:
        known = "、".join(OPERATORS)
        raise BadParam(f"不支持的算子: {op_id}，可选 {known}")
    return operator


@dataclass(frozen=True, slots=True)
class OperandParams:
    key: str
    batch: int = 0
    layout: str = "auto"
    channel: int = 0


@dataclass(frozen=True, slots=True)
class OpParams:
    op: str
    left: OperandParams
    right: OperandParams
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
        raise UnsupportedKind(f"key「{params.key}」的 kind 为 {meta.kind}，无法参与算子")
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
    left: npt.NDArray[np.float32], right: npt.NDArray[np.float32]
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    """Bilinear-upsample the smaller plane (by pixel count) onto the larger."""
    l_h, l_w = left.shape[:2]
    r_h, r_w = right.shape[:2]
    if (l_h, l_w) == (r_h, r_w):
        return left, right
    if l_h * l_w >= r_h * r_w:
        return left, resize_hwc(right, l_h, l_w)
    return resize_hwc(left, r_h, r_w), right


def match_channels(
    left: npt.NDArray[np.float32], right: npt.NDArray[np.float32]
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    l_c, r_c = left.shape[-1], right.shape[-1]
    if l_c == r_c:
        return left, right
    if l_c == 1 and r_c == 3:
        return np.repeat(left, 3, axis=-1), right
    if l_c == 3 and r_c == 1:
        return left, np.repeat(right, 3, axis=-1)
    raise BadParam(f"无法对齐通道数: {l_c} 与 {r_c}")


def apply_operator(
    op_id: str, left: npt.NDArray[np.float32], right: npt.NDArray[np.float32]
) -> npt.NDArray[np.float32]:
    operator = get_operator(op_id)
    aligned_left, aligned_right = match_channels(*align_spatial(left, right))
    return operator.apply(aligned_left, aligned_right)


def op_array(
    path_left: Path, left: OperandParams, path_right: Path, right: OperandParams, op_id: str
) -> npt.NDArray[np.float32]:
    return apply_operator(op_id, load_operand(path_left, left), load_operand(path_right, right))


def op_pixels(values: npt.NDArray[np.float32], params: OpParams) -> npt.NDArray[np.uint8]:
    is_gainmap = get_operator(params.op).display == "gainmap"
    if values.shape[-1] == 1:
        return render_gray_plane(
            values[..., 0],
            is_gainmap=is_gainmap,
            normalize=False,
            colormap=params.colormap,
        )
    return render_color_plane(
        values,
        is_gainmap=is_gainmap,
        gamut=params.gamut,
        gainmap_gamut=params.gainmap_gamut,
        alpha_mode="rgb",
    )


def _cache_digest(
    path_left: Path,
    stamp_left: npzio.FileStamp,
    path_right: Path,
    stamp_right: npzio.FileStamp,
    params: OpParams,
) -> str:
    return imgcache.digest_for(
        (
            os.path.normcase(str(path_left)),
            stamp_left.mtime,
            stamp_left.size,
            os.path.normcase(str(path_right)),
            stamp_right.mtime,
            stamp_right.size,
            astuple(params),
            OP_CACHE_VERSION,
        )
    )


def render_op(
    path_left: Path, path_right: Path, params: OpParams
) -> tuple[bytes, str, str]:
    if params.fmt not in MIME_BY_FORMAT:
        raise BadParam(f"不支持的图片格式: {params.fmt}")
    if params.colormap not in ("none", "viridis", "magma", "turbo"):
        raise BadParam(f"不支持的 colormap: {params.colormap}")
    if params.gamut not in ("bt2020", "p3"):
        raise BadParam(f"不支持的色域: {params.gamut}")
    get_operator(params.op)

    stamp_left = npzio.stamp(path_left)
    stamp_right = npzio.stamp(path_right)
    digest = _cache_digest(path_left, stamp_left, path_right, stamp_right, params)
    etag = f'"{digest}"'
    cached = imgcache.render_cache.get(digest, params.fmt)
    if cached is not None:
        return cached, MIME_BY_FORMAT[params.fmt], etag

    values = op_array(path_left, params.left, path_right, params.right, params.op)
    encode_params = RenderParams(
        key=params.left.key,
        gamut=params.gamut,
        colormap=params.colormap,
        gainmap_gamut=params.gainmap_gamut,
        max_size=params.max_size,
        fmt=params.fmt,
        quality=params.quality,
    )
    data = encode_image(op_pixels(values, params), encode_params)
    imgcache.render_cache.put(digest, params.fmt, data)
    return data, MIME_BY_FORMAT[params.fmt], etag


def op_pixel(
    path_left: Path,
    left: OperandParams,
    path_right: Path,
    right: OperandParams,
    op_id: str,
    x: int,
    y: int,
) -> PixelValue:
    values = op_array(path_left, left, path_right, right, op_id)
    height, width = values.shape[0], values.shape[1]
    if not (0 <= x < width and 0 <= y < height):
        raise BadParam(f"像素坐标越界: ({x}, {y})，图像尺寸 {width}x{height}")
    raw = values[y, x]
    return PixelValue(
        x=x,
        y=y,
        values=[None if not np.isfinite(float(v)) else float(v) for v in np.atleast_1d(raw)],
    )
