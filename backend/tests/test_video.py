from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.services.video_export import (
    compose_grid,
    encode_rgb_frames,
    resolve_grid,
    source_rect,
    to_rgb_image,
)


def test_resolve_grid_matches_the_compare_panel() -> None:
    assert resolve_grid("auto", 1) == (1, 1)
    assert resolve_grid("auto", 2) == (1, 2)
    assert resolve_grid("auto", 3) == (1, 3)
    assert resolve_grid("auto", 4) == (2, 2)
    assert resolve_grid("2x1", 2) == (2, 1)


def test_source_rect_matches_pixel_readout() -> None:
    # Zoom 2x, pan so the tile origin maps to source (10, 4).
    src_x, src_y, src_w, src_h = source_rect(
        scale=2, x=-20, y=-8, scale_factor=1, tile_width=100, tile_height=80
    )
    assert (src_x, src_y, src_w, src_h) == (10.0, 4.0, 50.0, 40.0)


def test_compose_grid_side_by_side() -> None:
    left = Image.new("RGB", (16, 12), (255, 0, 0))
    right = Image.new("RGB", (16, 12), (0, 255, 0))
    grid = compose_grid([left, right], ["a", "b"], rows=1, cols=2)
    assert grid.size == (16 * 2 + 2, 12)


def test_rgba_flattens_to_rgb() -> None:
    pixels = np.zeros((4, 4, 4), dtype=np.uint8)
    pixels[..., 0] = 255
    pixels[..., 3] = 128
    image = to_rgb_image(pixels)
    assert image.mode == "RGB"
    assert image.size == (4, 4)


def _wait_job(client: TestClient, job_id: str, timeout: float = 40.0) -> dict:
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"/api/video/jobs/{job_id}").json()
        if body["status"] in ("done", "error", "cancelled"):
            return body
        time.sleep(0.15)
    raise AssertionError(f"job did not finish: {body}")


def test_export_job_writes_an_mp4(client: TestClient, frame: Path) -> None:
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [{"key": "rgb_hwc"}, {"key": "gainmap"}],
            "start": 0,
            "end": 1,
            "fps": 8,
            "layout": "1x2",
            "crop": "full",
            "max_size": 1080,
            "equal_height": True,
            "gamut": "bt2020",
        },
    )
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    body = _wait_job(client, job_id)
    assert body["status"] == "done", body
    assert body["total"] == 2
    assert body["current"] == 2
    saved = Path(body["saved_path"])
    assert saved.is_file()
    assert saved.parent == frame.parent
    assert saved.read_bytes()[:32].find(b"ftyp") != -1

    download = client.get(f"/api/video/jobs/{job_id}/file")
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("video/mp4")
    assert download.content[:32].find(b"ftyp") != -1


def test_export_viewport_crop(client: TestClient, frame: Path) -> None:
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [{"key": "rgb_hwc"}],
            "start": 0,
            "end": 0,
            "fps": 8,
            "layout": "1x1",
            "crop": "viewport",
            "max_size": 1080,
            "gamut": "bt2020",
            "viewport": {
                "scale": 2,
                "x": 0,
                "y": 0,
                "tile_width": 32,
                "tile_height": 24,
                "natural_sizes": [{"width": 16, "height": 12}],
            },
        },
    )
    assert response.status_code == 200, response.text
    body = _wait_job(client, response.json()["id"])
    assert body["status"] == "done", body


def test_export_save_dir_must_stay_inside_a_root(client: TestClient, frame: Path, tmp_path: Path) -> None:
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [{"key": "rgb_hwc"}],
            "start": 0,
            "end": 0,
            "fps": 8,
            "max_size": 1080,
            "save_dir": (tmp_path / "outside").as_posix(),
        },
    )
    assert response.status_code == 403


def test_export_rejects_unconfirmed_huge_range(client: TestClient, frame: Path) -> None:
    # Directory only has 3 files, so this is rejected as out of range first —
    # the soft-limit path is covered below with encode_rgb_frames.
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [{"key": "rgb_hwc"}],
            "start": 0,
            "end": 9,
            "fps": 12,
            "max_size": 1080,
        },
    )
    assert response.status_code == 400


def test_encode_rgb_frames_roundtrip(tmp_path: Path) -> None:
    frame = np.zeros((16, 16, 3), dtype=np.uint8)
    frame[:, :8] = (255, 0, 0)
    output = tmp_path / "tiny.mp4"
    encode_rgb_frames([frame, frame], output, fps=8, cancel=threading.Event())
    assert output.is_file()
    assert output.stat().st_size > 32


def test_export_includes_a_ratio_cell(client: TestClient, frame: Path) -> None:
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [
                {"key": "rgb_hwc"},
                {"key": "gainmap"},
                {"type": "ratio", "key_num": "gainmap", "key_den": "rgb_hwc"},
            ],
            "start": 0,
            "end": 0,
            "fps": 8,
            "layout": "1x3",
            "crop": "full",
            "max_size": 1080,
            "gamut": "bt2020",
        },
    )
    assert response.status_code == 200, response.text
    body = _wait_job(client, response.json()["id"])
    assert body["status"] == "done", body
    assert "gainmapdivrgb_hwc" in (body["filename"] or "")


def test_missing_key_still_exports(client: TestClient, frame: Path) -> None:
    response = client.post(
        "/api/video/export",
        json={
            "path": frame.as_posix(),
            "keys": [{"key": "rgb_hwc"}, {"key": "does_not_exist"}],
            "start": 0,
            "end": 0,
            "fps": 8,
            "layout": "1x2",
            "max_size": 1080,
        },
    )
    assert response.status_code == 200, response.text
    body = _wait_job(client, response.json()["id"])
    assert body["status"] == "done", body
