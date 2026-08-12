from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings, set_settings
from app.services import npzio
from app.services.dirindex import dir_index


@pytest.fixture
def sample_dir(tmp_path: Path) -> Path:
    """A two-level tree so both file-scope and folder-scope navigation are testable."""
    rng = np.random.default_rng(11)
    for variant in ("baseline", "method_a"):
        folder = tmp_path / "data" / "scene_01" / variant
        folder.mkdir(parents=True, exist_ok=True)
        for index in (1, 2, 10):
            np.savez(
                folder / f"frame_{index}.npz",
                rgb_hwc=rng.random((12, 16, 3), dtype=np.float32),
                rgb_chw=rng.random((3, 12, 16), dtype=np.float32),
                rgba_hwc=rng.random((12, 16, 4), dtype=np.float32),
                gainmap=(rng.random((12, 16, 1), dtype=np.float32) * 2.0),
                object_mask=rng.random((1, 12, 16), dtype=np.float32),
                depth_raw=(rng.random((12, 16), dtype=np.float32) * 50 + 100),
                feature_stack=rng.random((8, 12, 16), dtype=np.float32),
                batch_rgb=rng.random((3, 3, 12, 16), dtype=np.float32),
                ambiguous_3x4x3=rng.random((3, 4, 3), dtype=np.float32),
                histogram=rng.random(300, dtype=np.float32),
                ccm_3x3=np.eye(3),
                iso=np.float32(100.0),
                note=np.array("hello"),
            )
    return tmp_path / "data"


@pytest.fixture
def configured(tmp_path: Path, sample_dir: Path) -> Settings:
    roots_file = tmp_path / "roots.json"
    roots_file.write_text(
        json.dumps({"roots": [{"id": "t", "name": "test", "path": sample_dir.as_posix()}]}),
        encoding="utf-8",
    )
    settings = Settings(
        roots_file=roots_file,
        cache_dir=tmp_path / "cache",
        max_cache_gb=1.0,
        array_cache_mb=64,
    )
    previous = get_settings()
    set_settings(settings)
    settings.ensure_dirs()
    dir_index.clear()
    npzio.clear_caches()
    yield settings
    set_settings(previous)
    dir_index.clear()
    npzio.clear_caches()


@pytest.fixture
def client(configured: Settings) -> TestClient:
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def frame(sample_dir: Path) -> Path:
    return sample_dir / "scene_01" / "baseline" / "frame_1.npz"
