from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw

from ..config import get_roots_store, get_settings
from ..errors import AppError, BadParam, KeyNotFound, UnsupportedKind
from ..models import ExportKey, VideoExportRequest, VideoJobInfo
from ..paths import resolve_within, to_posix
from . import nav, npzio, ratio, render
from .render import RenderParams

logger = logging.getLogger("npz_view.video")

SOFT_FRAME_LIMIT = 2000
HARD_FRAME_LIMIT = 10000
MAX_KEYS = 4
MAX_CELLS = 4
LABEL_HEIGHT = 18
GAP = 2
MISSING_FILL = (28, 28, 32)

JobStatus = Literal["queued", "running", "done", "error", "cancelled"]


def resolve_grid(layout: str, count: int) -> tuple[int, int]:
    """Return ``(rows, cols)`` matching the compare panel."""
    if layout == "auto":
        if count <= 1:
            return 1, 1
        if count == 2:
            return 1, 2
        if count == 3:
            return 1, 3
        return 2, 2
    mapping: dict[str, tuple[int, int]] = {
        "1x1": (1, 1),
        "1x2": (1, 2),
        "2x1": (2, 1),
        "1x3": (1, 3),
        "3x1": (3, 1),
        "2x2": (2, 2),
    }
    if layout not in mapping:
        raise BadParam(f"不支持的宫格布局: {layout}")
    return mapping[layout]


def source_rect(
    scale: float,
    x: float,
    y: float,
    scale_factor: float,
    tile_width: float,
    tile_height: float,
) -> tuple[float, float, float, float]:
    """Visible region in source pixels — same math as the compare-tile readout."""
    effective = max(scale * scale_factor, 1e-6)
    return (
        -x / effective,
        -y / effective,
        tile_width / effective,
        tile_height / effective,
    )


def height_factor(sizes: list[tuple[int, int]], index: int, equal_height: bool) -> float:
    if not equal_height or not sizes or sizes[0][1] == 0:
        return 1.0
    height = sizes[index][1] if index < len(sizes) else 0
    if height == 0:
        return 1.0
    return sizes[0][1] / height


def to_rgb_image(pixels: npt.NDArray[np.uint8]) -> Image.Image:
    array = np.ascontiguousarray(pixels)
    if array.ndim == 2:
        return Image.fromarray(array, mode="L").convert("RGB")
    channels = array.shape[-1]
    if channels == 4:
        rgba = Image.fromarray(array, mode="RGBA")
        background = Image.new("RGBA", rgba.size, (80, 80, 84, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return Image.fromarray(array[..., :3], mode="RGB")


def even_size(width: int, height: int) -> tuple[int, int]:
    return width + (width % 2), height + (height % 2)


def scale_to_max(image: Image.Image, max_size: int) -> Image.Image:
    if max_size <= 0:
        return image
    longest = max(image.size)
    if longest <= max_size:
        return image
    scale = max_size / longest
    target = (
        max(1, round(image.width * scale)),
        max(1, round(image.height * scale)),
    )
    return image.resize(target, Image.Resampling.LANCZOS)


def crop_viewport(
    image: Image.Image,
    *,
    scale: float,
    x: float,
    y: float,
    scale_factor: float,
    tile_width: float,
    tile_height: float,
    out_width: int,
    out_height: int,
) -> Image.Image:
    src_x, src_y, src_w, src_h = source_rect(
        scale, x, y, scale_factor, tile_width, tile_height
    )
    canvas_w = max(1, round(src_w))
    canvas_h = max(1, round(src_h))
    canvas = Image.new("RGB", (canvas_w, canvas_h), (20, 20, 24))
    canvas.paste(image, (round(-src_x), round(-src_y)))
    if canvas.size != (out_width, out_height):
        canvas = canvas.resize((out_width, out_height), Image.Resampling.BILINEAR)
    return canvas


def _scale_to_height(image: Image.Image, height: int) -> Image.Image:
    if image.height == height:
        return image
    width = max(1, round(image.width * height / image.height))
    return image.resize((width, height), Image.Resampling.LANCZOS)


def _draw_label(image: Image.Image, text: str) -> Image.Image:
    out = image.copy()
    draw = ImageDraw.Draw(out)
    draw.rectangle([0, 0, out.width, LABEL_HEIGHT], fill=(0, 0, 0))
    draw.text((6, 2), text, fill=(220, 220, 220))
    return out


def missing_cell(size: tuple[int, int], key: str) -> Image.Image:
    image = Image.new("RGB", size, MISSING_FILL)
    draw = ImageDraw.Draw(image)
    draw.text((8, size[1] // 2 - 6), f"KEY NOT FOUND: {key}", fill=(160, 120, 40))
    return image


def compose_grid(
    cells: list[Image.Image | None],
    labels: list[str],
    rows: int,
    cols: int,
) -> Image.Image:
    if not cells:
        raise BadParam("没有可合成的格子")
    present = [cell for cell in cells if cell is not None]
    if present:
        cell_w = max(cell.width for cell in present)
        cell_h = max(cell.height for cell in present)
    else:
        cell_w, cell_h = 256, 256

    canvas = Image.new(
        "RGB",
        (cols * cell_w + GAP * max(0, cols - 1), rows * cell_h + GAP * max(0, rows - 1)),
        (24, 24, 28),
    )
    for index in range(rows * cols):
        row, col = divmod(index, cols)
        x = col * (cell_w + GAP)
        y = row * (cell_h + GAP)
        source = cells[index] if index < len(cells) else None
        label = labels[index] if index < len(labels) else ""
        if source is None:
            tile = missing_cell((cell_w, cell_h), label or "?")
        else:
            tile = Image.new("RGB", (cell_w, cell_h), (20, 20, 24))
            ox = (cell_w - source.width) // 2
            oy = (cell_h - source.height) // 2
            tile.paste(source, (ox, oy))
            tile = _draw_label(tile, label)
        canvas.paste(tile, (x, y))
    return canvas


def render_key_image(path: Path, spec: ExportKey, gamut: str) -> Image.Image | None:
    params = RenderParams(
        key=spec.key,
        gamut=gamut,
        batch=spec.batch,
        layout=spec.layout,
        channel=spec.channel,
        normalize=spec.normalize,
        colormap=spec.colormap,
        gainmap_gamut=spec.gainmap_gamut,
        alpha=spec.alpha,
    )
    try:
        meta = npzio.find_key(path, spec.key)
        if not meta.renderable:
            return None
        array = npzio.load_array(path, spec.key)
        return to_rgb_image(render.pixels_for(array, meta, params))
    except (KeyNotFound, UnsupportedKind, BadParam):
        return None


def render_ratio_image(path: Path, spec: ExportKey, gamut: str) -> Image.Image | None:
    params = ratio.RatioParams(
        num=ratio.OperandParams(
            key=spec.key_num or "",
            batch=spec.batch,
            layout=spec.layout,
            channel=spec.channel,
        ),
        den=ratio.OperandParams(
            key=spec.key_den or "",
            batch=spec.batch,
            layout=spec.layout,
            channel=spec.channel,
        ),
        gamut=gamut,
        colormap=spec.colormap,
        gainmap_gamut=spec.gainmap_gamut,
    )
    try:
        values = ratio.ratio_array(path, params.num, path, params.den)
        return to_rgb_image(ratio.ratio_pixels(values, params))
    except (KeyNotFound, UnsupportedKind, BadParam):
        return None


def render_cell_image(path: Path, spec: ExportKey, gamut: str) -> Image.Image | None:
    if spec.type == "ratio":
        return render_ratio_image(path, spec, gamut)
    return render_key_image(path, spec, gamut)


def cell_label(spec: ExportKey) -> str:
    if spec.type == "ratio":
        return f"{spec.key_num} ÷ {spec.key_den}"
    return spec.key


def cell_token(spec: ExportKey) -> str:
    if spec.type == "ratio":
        return f"{spec.key_num}div{spec.key_den}"
    return spec.key


def prepare_cells(
    images: list[Image.Image | None],
    request: VideoExportRequest,
) -> list[Image.Image | None]:
    if request.crop == "viewport":
        viewport = request.viewport
        if viewport is None:
            raise BadParam("当前视口导出需要 viewport 参数")
        tile_w = max(1, round(viewport.tile_width))
        tile_h = max(1, round(viewport.tile_height))
        out_w = max(2, tile_w * 2)
        out_h = max(2, tile_h * 2)
        sizes = [(item.width, item.height) for item in viewport.natural_sizes]
        prepared: list[Image.Image | None] = []
        for index, image in enumerate(images):
            factor = height_factor(sizes, index, request.equal_height)
            if image is None:
                prepared.append(None)
                continue
            prepared.append(
                crop_viewport(
                    image,
                    scale=viewport.scale,
                    x=viewport.x,
                    y=viewport.y,
                    scale_factor=factor,
                    tile_width=viewport.tile_width,
                    tile_height=viewport.tile_height,
                    out_width=out_w,
                    out_height=out_h,
                )
            )
        return prepared

    if not request.equal_height:
        return images
    present = [image for image in images if image is not None]
    if not present:
        return images
    target_h = present[0].height
    scaled: list[Image.Image | None] = []
    for image in images:
        scaled.append(None if image is None else _scale_to_height(image, target_h))
    return scaled


def compose_frame(
    path: Path,
    filename: str,
    request: VideoExportRequest,
) -> Image.Image:
    images = [render_cell_image(path, spec, request.gamut) for spec in request.keys]
    labels = [f"{cell_label(spec)}  {filename}" for spec in request.keys]
    cells = prepare_cells(images, request)
    rows, cols = resolve_grid(request.layout, len(request.keys))
    grid = compose_grid(cells, labels, rows, cols)
    grid = scale_to_max(grid, request.max_size)
    width, height = even_size(*grid.size)
    if (width, height) != grid.size:
        padded = Image.new("RGB", (width, height), (24, 24, 28))
        padded.paste(grid, (0, 0))
        return padded
    return grid


def start_ffmpeg(
    width: int,
    height: int,
    fps: float,
    output: Path,
) -> subprocess.Popen[bytes]:
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise BadParam("未安装 imageio-ffmpeg，无法导出视频") from exc

    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-movflags",
        "+faststart",
        str(output),
    ]
    return subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def _stop_ffmpeg(process: subprocess.Popen[bytes], *, kill: bool) -> bytes:
    if kill:
        process.kill()
    elif process.stdin and not process.stdin.closed:
        try:
            process.stdin.close()
        except OSError:
            pass
    try:
        _stdout, stderr = process.communicate(timeout=60)
        return stderr or b""
    except subprocess.TimeoutExpired:
        process.kill()
        _stdout, stderr = process.communicate(timeout=8)
        return stderr or b""


def encode_rgb_frames(
    frames: list[npt.NDArray[np.uint8]],
    output: Path,
    fps: float,
    cancel: threading.Event,
) -> None:
    """Used by tests; production export streams frames in ``_run_job``."""
    if not frames:
        raise BadParam("没有可编码的帧")
    height, width = frames[0].shape[:2]
    output.parent.mkdir(parents=True, exist_ok=True)
    process = start_ffmpeg(width, height, fps, output)
    assert process.stdin is not None
    try:
        for frame in frames:
            if cancel.is_set():
                _stop_ffmpeg(process, kill=True)
                return
            process.stdin.write(np.ascontiguousarray(frame).tobytes())
        stderr = _stop_ffmpeg(process, kill=False)
        if cancel.is_set():
            return
        if process.returncode:
            message = stderr.decode("utf-8", errors="replace")[-800:]
            raise BadParam(f"ffmpeg 编码失败: {message or process.returncode}")
    except Exception:
        _stop_ffmpeg(process, kill=True)
        raise


@dataclass
class VideoJob:
    id: str
    status: JobStatus
    current: int = 0
    total: int = 0
    error: str | None = None
    filename: str | None = None
    output_path: Path | None = None
    saved_path: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    created_at: float = field(default_factory=time.time)

    def info(self) -> VideoJobInfo:
        return VideoJobInfo(
            id=self.id,
            status=self.status,
            current=self.current,
            total=self.total,
            error=self.error,
            filename=self.filename,
            saved_path=self.saved_path,
        )


class VideoJobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, VideoJob] = {}

    def create(self, total: int, filename: str) -> VideoJob:
        job = VideoJob(
            id=uuid.uuid4().hex[:12],
            status="queued",
            total=total,
            filename=filename,
        )
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> VideoJob | None:
        with self._lock:
            return self._jobs.get(job_id)


jobs = VideoJobStore()


def unique_dest(directory: Path, filename: str) -> Path:
    dest = directory / filename
    if not dest.exists():
        return dest
    stem = dest.stem
    suffix = dest.suffix
    n = 1
    while True:
        candidate = directory / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def resolve_save_dir(anchor: Path, save_dir: str | None) -> Path:
    raw = (save_dir or "").strip() or to_posix(anchor.parent)
    directory = resolve_within(raw, get_roots_store().root_paths())
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.is_dir():
        raise BadParam(f"保存目录不可用: {raw}")
    return directory


def validate_request(request: VideoExportRequest, anchor: Path) -> int:
    if not request.keys:
        raise BadParam("至少选择一个 key")
    if len(request.keys) > MAX_CELLS:
        raise BadParam(f"最多导出 {MAX_CELLS} 格")
    source_keys = sum(1 for spec in request.keys if spec.type != "ratio")
    if source_keys > MAX_KEYS:
        raise BadParam(f"最多导出 {MAX_KEYS} 个 key")
    if request.start > request.end:
        raise BadParam("起始帧不能大于结束帧")
    if not 1 <= request.fps <= 60:
        raise BadParam("fps 必须在 1–60 之间")
    if request.max_size not in (1080, 1920, 2160):
        raise BadParam("max_size 只能是 1080、1920 或 2160")
    if request.crop == "viewport":
        if request.viewport is None:
            raise BadParam("当前视口导出需要 viewport 参数")
        if request.viewport.tile_width < 8 or request.viewport.tile_height < 8:
            raise BadParam("视口格子尺寸过小")
        if request.viewport.scale <= 0:
            raise BadParam("视口缩放必须大于 0")
    resolve_save_dir(anchor, request.save_dir)

    located = nav.locate(anchor)
    total_files = located.total
    if request.end >= total_files or request.start < 0:
        raise BadParam(f"起止帧越界，目录共 {total_files} 个 npz")
    frame_count = request.end - request.start + 1
    if frame_count > HARD_FRAME_LIMIT:
        raise BadParam(f"一次最多导出 {HARD_FRAME_LIMIT} 帧")
    if frame_count > SOFT_FRAME_LIMIT and not request.confirm_large:
        raise BadParam(
            f"将导出 {frame_count} 帧，超过 {SOFT_FRAME_LIMIT}，请在对话框勾选确认后重试"
        )
    return frame_count


def _run_job(job: VideoJob, anchor: Path, request: VideoExportRequest) -> None:
    job.status = "running"
    output = get_settings().video_cache_dir / f"{job.id}.mp4"
    process: subprocess.Popen[bytes] | None = None
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        for offset, index in enumerate(range(request.start, request.end + 1)):
            if job.cancel.is_set():
                if process is not None:
                    _stop_ffmpeg(process, kill=True)
                if output.exists():
                    output.unlink(missing_ok=True)
                job.status = "cancelled"
                return
            sibling = nav.sibling_at(anchor, index)
            image = compose_frame(Path(sibling.path), sibling.name, request)
            frame = np.ascontiguousarray(np.asarray(image, dtype=np.uint8))
            if process is None:
                height, width = frame.shape[:2]
                process = start_ffmpeg(width, height, request.fps, output)
            assert process.stdin is not None
            process.stdin.write(frame.tobytes())
            job.current = offset + 1
        assert process is not None
        stderr = _stop_ffmpeg(process, kill=False)
        if job.cancel.is_set():
            if output.exists():
                output.unlink(missing_ok=True)
            job.status = "cancelled"
            return
        if process.returncode:
            message = stderr.decode("utf-8", errors="replace")[-800:]
            raise BadParam(f"ffmpeg 编码失败: {message or process.returncode}")
        dest = unique_dest(resolve_save_dir(anchor, request.save_dir), job.filename or f"{job.id}.mp4")
        try:
            shutil.copy2(output, dest)
            job.saved_path = to_posix(dest)
        except OSError as exc:
            job.saved_path = to_posix(output)
            logger.warning("could not copy export to %s: %s", dest, exc)
        job.output_path = output
        job.status = "done"
    except AppError as exc:
        if process is not None:
            _stop_ffmpeg(process, kill=True)
        job.status = "error"
        job.error = exc.message
        logger.warning("video export %s failed: %s", job.id, exc.message)
    except Exception as exc:
        if process is not None:
            _stop_ffmpeg(process, kill=True)
        job.status = "error"
        job.error = str(exc)
        logger.exception("video export %s crashed", job.id)


def start_export(anchor: Path, request: VideoExportRequest) -> VideoJob:
    frame_count = validate_request(request, anchor)
    keys = "-".join(cell_token(item) for item in request.keys)
    filename = f"{anchor.parent.name}_{keys}_{request.start}-{request.end}.mp4"
    job = jobs.create(frame_count, filename)
    thread = threading.Thread(
        target=_run_job,
        args=(job, anchor, request),
        name=f"video-export-{job.id}",
        daemon=True,
    )
    thread.start()
    return job
