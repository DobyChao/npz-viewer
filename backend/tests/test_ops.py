from __future__ import annotations

import numpy as np

from app.services.ops import (
    DIVIDE_EPS,
    OPERATORS,
    OperandParams,
    OpParams,
    align_spatial,
    apply_operator,
    match_channels,
    op_pixels,
    resize_hwc,
)
from app.services.render import pixels_for
from app.services.npzio import classify


SMALL = 9


def filled(shape: tuple[int, ...], values: list[float]) -> np.ndarray:
    array = np.zeros(shape, dtype=np.float32)
    array[...] = np.asarray(values, dtype=np.float32)
    return array


def test_registry_exposes_div_and_mul() -> None:
    assert set(OPERATORS) == {"div", "mul"}
    assert OPERATORS["div"].display == "gainmap"
    assert OPERATORS["mul"].display == "linear"


def test_same_size_rgb_division_is_per_channel() -> None:
    num = filled((2, 2, 3), [1.0, 0.5, 0.25])
    den = filled((2, 2, 3), [1.0, 0.5, 0.25])
    ratio = apply_operator("div", num, den)
    assert ratio.shape == (2, 2, 3)
    np.testing.assert_allclose(ratio[0, 0], [1.0, 1.0, 1.0])


def test_zero_denominator_uses_eps() -> None:
    num = filled((1, 1, 1), [1.0])
    den = filled((1, 1, 1), [0.0])
    ratio = apply_operator("div", num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 1.0 / float(DIVIDE_EPS), rtol=1e-5)


def test_identical_rgb_with_negative_channel_is_one() -> None:
    rgb = filled((2, 2, 3), [0.05, 0.05, -0.004])
    ratio = apply_operator("div", rgb, rgb)
    np.testing.assert_allclose(ratio, 1.0, atol=1e-5)


def test_negative_denominator_keeps_sign() -> None:
    num = filled((1, 1, 1), [0.4])
    den = filled((1, 1, 1), [-0.2])
    ratio = apply_operator("div", num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], -2.0)


def test_both_near_zero_is_one() -> None:
    num = filled((1, 1, 1), [0.0])
    den = filled((1, 1, 1), [0.0])
    ratio = apply_operator("div", num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 1.0)


def test_multiply_is_per_channel() -> None:
    left = filled((2, 2, 3), [1.0, 0.5, 0.25])
    right = filled((2, 2, 3), [0.5, 0.5, 2.0])
    product = apply_operator("mul", left, right)
    np.testing.assert_allclose(product[0, 0], [0.5, 0.25, 0.5])


def test_upsample_smaller_to_larger() -> None:
    large = filled((4, 4, 3), [1.0, 1.0, 1.0])
    small = filled((2, 2, 3), [0.5, 0.5, 0.5])
    left, right = align_spatial(small, large)
    assert left.shape[:2] == (4, 4)
    assert right.shape[:2] == (4, 4)
    assert small.shape[:2] == (2, 2)


def test_resize_preserves_constant_field() -> None:
    plane = filled((2, 2, 1), [0.4])
    out = resize_hwc(plane, 4, 6)
    assert out.shape == (4, 6, 1)
    np.testing.assert_allclose(out, 0.4, atol=1e-6)


def test_gray_broadcasts_onto_rgb() -> None:
    rgb = filled((2, 2, 3), [1.0, 0.5, 0.25])
    gray = filled((2, 2, 1), [0.5])
    left, right = match_channels(rgb, gray)
    assert left.shape[-1] == 3
    assert right.shape[-1] == 3
    np.testing.assert_allclose(right[..., 0], 0.5)


def test_div_renders_as_gainmap() -> None:
    values = filled((2, 2, 1), [1.0])
    pixels = op_pixels(
        values, OpParams(op="div", left=OperandParams("a"), right=OperandParams("b"))
    )
    assert pixels.shape == (2, 2)
    assert int(pixels[0, 0]) == 128

    gainmap_meta = classify("hdr_gainmap", (2, 2, 1), "float32", SMALL)
    from app.services.render import RenderParams

    expected = pixels_for(values, gainmap_meta, RenderParams(key="hdr_gainmap"))
    np.testing.assert_array_equal(pixels, expected)


def test_div_above_two_clips_like_gainmap() -> None:
    values = filled((2, 2, 3), [4.0, 4.0, 4.0])
    pixels = op_pixels(
        values, OpParams(op="div", left=OperandParams("a"), right=OperandParams("b"))
    )
    assert pixels[0, 0].tolist() == [255, 255, 255]


def test_mul_renders_as_linear() -> None:
    # 1.0 linear → gamma 1 → 255; 0.5 would be darker, not gainmap mid-gray.
    values = filled((2, 2, 3), [1.0, 1.0, 1.0])
    pixels = op_pixels(
        values, OpParams(op="mul", left=OperandParams("a"), right=OperandParams("b"))
    )
    assert pixels[0, 0].tolist() == [255, 255, 255]


def test_pixel_readout_is_unclipped() -> None:
    num = filled((2, 2, 1), [3.0])
    den = filled((2, 2, 1), [1.0])
    ratio = apply_operator("div", num, den)
    np.testing.assert_allclose(ratio[0, 0, 0], 3.0)


def test_ops_listing(client) -> None:
    listing = client.get("/api/npz/ops")
    assert listing.status_code == 200
    ids = {item["id"] for item in listing.json()["ops"]}
    assert ids == {"div", "mul"}


def test_missing_key_is_key_not_found(client, frame) -> None:
    response = client.get(
        "/api/npz/op/render",
        params={
            "op": "div",
            "path_a": frame.as_posix(),
            "key_a": "does_not_exist",
            "key_b": "rgb_hwc",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "KEY_NOT_FOUND"


def test_unknown_op_on_real_file(client, frame) -> None:
    response = client.get(
        "/api/npz/op/render",
        params={
            "op": "fft",
            "path_a": frame.as_posix(),
            "key_a": "rgb_hwc",
            "key_b": "rgb_chw",
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"


def test_op_render_and_pixel(client, frame) -> None:
    render = client.get(
        "/api/npz/op/render",
        params={
            "op": "mul",
            "path_a": frame.as_posix(),
            "key_a": "rgb_hwc",
            "key_b": "rgb_chw",
        },
    )
    assert render.status_code == 200
    assert render.headers["content-type"] == "image/png"
    pixel = client.get(
        "/api/npz/op/pixel",
        params={
            "op": "mul",
            "path_a": frame.as_posix(),
            "key_a": "rgb_hwc",
            "key_b": "rgb_chw",
            "x": 0,
            "y": 0,
        },
    )
    assert pixel.status_code == 200
    body = pixel.json()
    assert len(body["values"]) == 3


def test_ratio_alias_still_divides(client, frame) -> None:
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


def test_op_pixel_out_of_range(client, frame) -> None:
    response = client.get(
        "/api/npz/op/pixel",
        params={
            "op": "div",
            "path_a": frame.as_posix(),
            "key_a": "gainmap",
            "key_b": "rgb_hwc",
            "x": 999,
            "y": 0,
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_PARAM"
