from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image


def test_health(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["ok"] is True


def test_roots_are_listed(client: TestClient, sample_dir: Path) -> None:
    body = client.get("/api/roots").json()
    assert body["roots"][0]["path"] == sample_dir.as_posix()
    assert body["roots"][0]["exists"] is True


def test_dirs_are_one_level_deep(client: TestClient, sample_dir: Path) -> None:
    body = client.get("/api/fs/dirs", params={"path": sample_dir.as_posix()}).json()
    assert [item["name"] for item in body["dirs"]] == ["scene_01"]
    assert body["dirs"][0]["has_children"] is True


def test_path_outside_root_is_forbidden(client: TestClient, tmp_path: Path) -> None:
    response = client.get("/api/fs/dirs", params={"path": tmp_path.as_posix()})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "PATH_OUTSIDE_ROOT"


def test_missing_directory_is_404(client: TestClient, sample_dir: Path) -> None:
    response = client.get("/api/fs/dirs", params={"path": (sample_dir / "nope").as_posix()})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FILE_NOT_FOUND"


def test_list_paginates_in_natural_order(client: TestClient, sample_dir: Path) -> None:
    folder = (sample_dir / "scene_01" / "baseline").as_posix()
    body = client.get("/api/npz/list", params={"dir": folder, "page_size": 2}).json()
    assert body["total"] == 3
    assert body["pages"] == 2
    assert [item["name"] for item in body["items"]] == ["frame_1.npz", "frame_2.npz"]

    second = client.get(
        "/api/npz/list", params={"dir": folder, "page_size": 2, "page": 2}
    ).json()
    assert [item["name"] for item in second["items"]] == ["frame_10.npz"]


def test_list_filter_and_sort(client: TestClient, sample_dir: Path) -> None:
    folder = (sample_dir / "scene_01" / "baseline").as_posix()
    body = client.get("/api/npz/list", params={"dir": folder, "q": "frame_1"}).json()
    assert {item["name"] for item in body["items"]} == {"frame_1.npz", "frame_10.npz"}

    body = client.get(
        "/api/npz/list", params={"dir": folder, "sort": "name", "order": "desc"}
    ).json()
    assert body["items"][0]["name"] == "frame_10.npz"


def test_list_rejects_bad_page_size(client: TestClient, sample_dir: Path) -> None:
    folder = (sample_dir / "scene_01" / "baseline").as_posix()
    response = client.get("/api/npz/list", params={"dir": folder, "page_size": 9999})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"


def test_meta_lists_every_key_with_classification(client: TestClient, frame: Path) -> None:
    body = client.get("/api/npz/meta", params={"path": frame.as_posix()}).json()
    kinds = {item["name"]: item["kind"] for item in body["keys"]}
    assert kinds["rgb_hwc"] == "rgb"
    assert kinds["rgb_chw"] == "rgb"
    assert kinds["rgba_hwc"] == "rgba"
    assert kinds["gainmap"] == "gainmap"
    assert kinds["object_mask"] == "gray"
    assert kinds["feature_stack"] == "stack"
    assert kinds["ccm_3x3"] == "table"
    assert kinds["iso"] == "scalar"
    assert body["compressed"] is False

    batch = next(item for item in body["keys"] if item["name"] == "batch_rgb")
    assert batch["batch"] == 3
    assert batch["layout"] == "chw"


def test_render_returns_a_png_of_the_right_size(client: TestClient, frame: Path) -> None:
    response = client.get(
        "/api/npz/render", params={"path": frame.as_posix(), "key": "rgb_hwc"}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    image = Image.open(io.BytesIO(response.content))
    assert image.size == (16, 12)
    assert image.mode == "RGB"


def test_render_rgba_keeps_transparency(client: TestClient, frame: Path) -> None:
    response = client.get(
        "/api/npz/render", params={"path": frame.as_posix(), "key": "rgba_hwc"}
    )
    assert Image.open(io.BytesIO(response.content)).mode == "RGBA"


def test_render_max_size_downscales(client: TestClient, frame: Path) -> None:
    response = client.get(
        "/api/npz/render",
        params={"path": frame.as_posix(), "key": "rgb_hwc", "max_size": 8},
    )
    assert max(Image.open(io.BytesIO(response.content)).size) == 8


def test_render_etag_enables_304(client: TestClient, frame: Path) -> None:
    params = {"path": frame.as_posix(), "key": "rgb_hwc", "v": "1"}
    first = client.get("/api/npz/render", params=params)
    etag = first.headers["etag"]
    assert "immutable" in first.headers["cache-control"]

    second = client.get("/api/npz/render", params=params, headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""


def test_render_without_version_must_revalidate(client: TestClient, frame: Path) -> None:
    response = client.get("/api/npz/render", params={"path": frame.as_posix(), "key": "rgb_hwc"})
    assert "immutable" not in response.headers["cache-control"]
    assert "must-revalidate" in response.headers["cache-control"]


def test_render_gamut_changes_the_bytes(client: TestClient, frame: Path) -> None:
    base = {"path": frame.as_posix(), "key": "rgb_hwc"}
    native = client.get("/api/npz/render", params={**base, "gamut": "bt2020"}).content
    converted = client.get("/api/npz/render", params={**base, "gamut": "p3"}).content
    assert native != converted


def test_render_rejects_non_renderable_keys(client: TestClient, frame: Path) -> None:
    response = client.get("/api/npz/render", params={"path": frame.as_posix(), "key": "iso"})
    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_KIND"


def test_render_missing_key_is_404(client: TestClient, frame: Path) -> None:
    response = client.get("/api/npz/render", params={"path": frame.as_posix(), "key": "nope"})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "KEY_NOT_FOUND"


def test_thumb_auto_selects_a_colour_key(client: TestClient, frame: Path) -> None:
    response = client.get(
        "/api/npz/thumb", params={"path": frame.as_posix(), "prefer": "rgb_hwc", "size": 32}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    # max_size only downscales, and the fixture image is already smaller than 32px.
    assert Image.open(io.BytesIO(response.content)).size == (16, 12)


def test_thumb_falls_back_when_the_preferred_key_is_absent(
    client: TestClient, frame: Path
) -> None:
    response = client.get(
        "/api/npz/thumb", params={"path": frame.as_posix(), "prefer": "does_not_exist"}
    )
    assert response.status_code == 200


def test_data_returns_small_matrices_inline(client: TestClient, frame: Path) -> None:
    body = client.get("/api/npz/data", params={"path": frame.as_posix(), "key": "ccm_3x3"}).json()
    assert body["values"] == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    assert body["truncated"] is False


def test_data_truncates_long_vectors(client: TestClient, frame: Path) -> None:
    body = client.get(
        "/api/npz/data", params={"path": frame.as_posix(), "key": "histogram"}
    ).json()
    assert body["truncated"] is True
    assert len(body["values"]["head"]) == 32
    assert len(body["values"]["tail"]) == 32
    assert body["stats"]["count"] == 300


def test_data_handles_scalars_and_strings(client: TestClient, frame: Path) -> None:
    scalar = client.get("/api/npz/data", params={"path": frame.as_posix(), "key": "iso"}).json()
    assert scalar["values"] == 100.0
    note = client.get("/api/npz/data", params={"path": frame.as_posix(), "key": "note"}).json()
    assert "hello" in str(note["values"])


def test_stats_endpoint(client: TestClient, frame: Path) -> None:
    body = client.get(
        "/api/npz/stats", params={"path": frame.as_posix(), "key": "depth_raw"}
    ).json()
    assert body["min"] >= 100.0
    assert body["max"] <= 150.0


def test_pixel_readout(client: TestClient, frame: Path) -> None:
    body = client.get(
        "/api/npz/pixel", params={"path": frame.as_posix(), "key": "rgb_hwc", "x": 3, "y": 4}
    ).json()
    assert len(body["values"]) == 3

    out_of_range = client.get(
        "/api/npz/pixel", params={"path": frame.as_posix(), "key": "rgb_hwc", "x": 999, "y": 0}
    )
    assert out_of_range.status_code == 400


def test_sibling_file_navigation(client: TestClient, frame: Path) -> None:
    body = client.get(
        "/api/nav/sibling", params={"path": frame.as_posix(), "scope": "file", "direction": "next"}
    ).json()
    assert body["name"] == "frame_2.npz"
    assert body["index"] == 1
    assert body["total"] == 3

    at_start = client.get(
        "/api/nav/sibling", params={"path": frame.as_posix(), "scope": "file", "direction": "prev"}
    )
    assert at_start.status_code == 404


def test_sibling_folder_keeps_the_ordinal(client: TestClient, sample_dir: Path) -> None:
    start = sample_dir / "scene_01" / "baseline" / "frame_2.npz"
    body = client.get(
        "/api/nav/sibling",
        params={"path": start.as_posix(), "scope": "folder", "direction": "next"},
    ).json()
    assert body["path"].endswith("method_a/frame_2.npz")
    assert body["index"] == 1


def test_locate_reports_position(client: TestClient, frame: Path) -> None:
    body = client.get("/api/nav/locate", params={"path": frame.as_posix()}).json()
    assert (body["index"], body["total"]) == (0, 3)


def test_nav_at_picks_by_ordinal(client: TestClient, frame: Path) -> None:
    body = client.get("/api/nav/at", params={"path": frame.as_posix(), "index": 2}).json()
    assert body["name"] == "frame_10.npz"
    assert body["index"] == 2
    assert body["total"] == 3
    assert body["mtime"] > 0
    assert body["size"] > 0


def test_nav_at_stats_file_even_when_dirindex_is_stale(
    client: TestClient, frame: Path
) -> None:
    # Warm the directory snapshot so a later in-place rewrite would otherwise
    # keep serving the old mtime from dirindex.
    client.get("/api/npz/list", params={"dir": frame.parent.as_posix()})
    before = client.get("/api/nav/at", params={"path": frame.as_posix(), "index": 0}).json()
    np.savez(frame, rgb_hwc=np.ones((12, 16, 3), dtype=np.float32))
    os.utime(frame, (frame.stat().st_atime, frame.stat().st_mtime + 5))
    after = client.get("/api/nav/at", params={"path": frame.as_posix(), "index": 0}).json()
    assert after["mtime"] != before["mtime"]
    assert after["size"] != before["size"]


def test_nav_at_rejects_out_of_range(client: TestClient, frame: Path) -> None:
    response = client.get("/api/nav/at", params={"path": frame.as_posix(), "index": 9})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"


def test_refresh_clears_the_index(client: TestClient, sample_dir: Path) -> None:
    folder = (sample_dir / "scene_01" / "baseline").as_posix()
    client.get("/api/npz/list", params={"dir": folder})
    response = client.post("/api/fs/refresh", json={"path": folder})
    assert response.status_code == 200
    assert response.json()["cleared"] is True


def test_root_can_be_added_and_removed(client: TestClient, tmp_path: Path) -> None:
    extra = tmp_path / "extra"
    extra.mkdir()
    created = client.post("/api/roots", json={"name": "extra", "path": extra.as_posix()}).json()
    assert created["path"] == extra.as_posix()

    listing = client.get("/api/roots").json()
    assert len(listing["roots"]) == 2

    # The freshly added root is now reachable.
    assert client.get("/api/fs/dirs", params={"path": extra.as_posix()}).status_code == 200

    remaining = client.delete(f"/api/roots/{created['id']}").json()
    assert len(remaining["roots"]) == 1


def test_adding_a_missing_root_is_rejected(client: TestClient, tmp_path: Path) -> None:
    response = client.post(
        "/api/roots", json={"name": "ghost", "path": (tmp_path / "ghost").as_posix()}
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"
