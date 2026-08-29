from __future__ import annotations

import numpy as np

from app.services.ratio import (
    DIVIDE_EPS,
    OperandParams,
    RatioParams,
    align_spatial,
    divide_gainmap,
    match_channels,
    ratio_pixel,
    ratio_pixels,
    resize_hwc,
)
from app.services.render import pixels_for
from app.services.npzio import classify


SMALL = 9


def filled(shape: tuple[int, ...], values: list[float]) -> np.ndarray:
    array = np.zeros(shape, dtype=np.float32)
    array[...] = np.asarray(values, dtype=np.float32)
    return array


def test_same_size_rgb_division_is_per_channel() -> None:
    num = filled((2, 2, 3), [1.0, 0.5, 0.25])
    den = filled((2, 2, 3), [1.0, 0.5, 0.25])
    ratio = divide_gainmap(num, den)
    assert ratio.shape == (2, 2, 3)
    np.testing.assert_allclose(ratio[0, 0], [1.0, 1.0, 1.0])


def test_zero_denominator_uses_eps() -> None:
    num = filled((1, 1, 1), [1.0])
    den = filled((1, 1, 1), [0.0])
    ratio = divide_gainmap(num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 1.0 / float(DIVIDE_EPS), rtol=1e-5)


def test_identical_rgb_with_negative_channel_is_one() -> None:
    rgb = filled((2, 2, 3), [0.05, 0.05, -0.004])
    ratio = divide_gainmap(rgb, rgb)
    np.testing.assert_allclose(ratio, 1.0, atol=1e-5)


def test_negative_denominator_keeps_sign() -> None:
    num = filled((1, 1, 1), [0.4])
    den = filled((1, 1, 1), [-0.2])
    ratio = divide_gainmap(num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], -2.0)


def test_both_near_zero_is_one() -> None:
    num = filled((1, 1, 1), [0.0])
    den = filled((1, 1, 1), [0.0])
    ratio = divide_gainmap(num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 1.0)


def test_upsample_smaller_to_larger() -> None:
    large = filled((4, 4, 3), [1.0, 1.0, 1.0])
    small = filled((2, 2, 3), [0.5, 0.5, 0.5])
    num, den = align_spatial(small, large)
    assert num.shape[:2] == (4, 4)
    assert den.shape[:2] == (4, 4)
    # The smaller plane is the one that grows.
    assert small.shape[:2] == (2, 2)


def test_resize_preserves_constant_field() -> None:
    plane = filled((2, 2, 1), [0.4])
    out = resize_hwc(plane, 4, 6)
    assert out.shape == (4, 6, 1)
    np.testing.assert_allclose(out, 0.4, atol=1e-6)


def test_gray_broadcasts_onto_rgb() -> None:
    rgb = filled((2, 2, 3), [1.0, 0.5, 0.25])
    gray = filled((2, 2, 1), [0.5])
    num, den = match_channels(rgb, gray)
    assert num.shape[-1] == 3
    assert den.shape[-1] == 3
    np.testing.assert_allclose(den[..., 0], 0.5)


def test_ratio_renders_as_gainmap() -> None:
    # ratio = 1 → gainmap clip(1,0,2)/2 = 0.5 → gray linear 128
    values = filled((2, 2, 1), [1.0])
    pixels = ratio_pixels(values, RatioParams(num=OperandParams("a"), den=OperandParams("b")))
    assert pixels.shape == (2, 2)
    assert int(pixels[0, 0]) == 128

    gainmap_meta = classify("hdr_gainmap", (2, 2, 1), "float32", SMALL)
    from app.services.render import RenderParams

    expected = pixels_for(values, gainmap_meta, RenderParams(key="hdr_gainmap"))
    np.testing.assert_array_equal(pixels, expected)


def test_ratio_above_two_clips_like_gainmap() -> None:
    values = filled((2, 2, 3), [4.0, 4.0, 4.0])
    pixels = ratio_pixels(values, RatioParams(num=OperandParams("a"), den=OperandParams("b")))
    assert pixels[0, 0].tolist() == [255, 255, 255]


def test_pixel_readout_is_unclipped_ratio() -> None:
    # Use in-memory arrays through load_operand would need npz files.
    # Direct divide is enough for the numeric contract; API test covers the endpoint.
    num = filled((2, 2, 1), [3.0])
    den = filled((2, 2, 1), [1.0])
    ratio = divide_gainmap(num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 3.0)


def test_missing_key_is_key_not_found(client, frame) -> None:
    response = client.get(
        "/api/npz/ratio/render",
        params={
            "path_a": frame.as_posix(),
            "key_a": "does_not_exist",
            "key_b": "rgb_hwc",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "KEY_NOT_FOUND"


def test_ratio_render_endpoint(client, frame) -> None:
    response = client.get(
        "/api/npz/ratio/render",
        params={
            "path_a": frame.as_posix(),
            "key_a": "gainmap",
            "key_b": "rgb_hwc",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert "etag" in response.headers


def test_ratio_pixel_endpoint(client, frame) -> None:
    response = client.get(
        "/api/npz/ratio/pixel",
        params={
            "path_a": frame.as_posix(),
            "key_a": "gainmap",
            "key_b": "rgb_hwc",
            "x": 0,
            "y": 0,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["x"] == 0
    assert body["y"] == 0
    assert len(body["values"]) == 3
    assert all(isinstance(v, (int, float)) for v in body["values"])


def test_ratio_pixel_out_of_range(client, frame) -> None:
    response = client.get(
        "/api/npz/ratio/pixel",
        params={
            "path_a": frame.as_posix(),
            "key_a": "gainmap",
            "key_b": "rgb_hwc",
            "x": 999,
            "y": 0,
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"
