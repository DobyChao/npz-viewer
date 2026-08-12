from __future__ import annotations

import pytest

from app.services.npzio import classify

SMALL = 9


def meta(name: str, shape: tuple[int, ...], dtype: str = "float32"):
    return classify(name, shape, dtype, SMALL)


@pytest.mark.parametrize(
    ("shape", "kind", "layout", "channels"),
    [
        ((3, 64, 64), "rgb", "chw", 3),
        ((64, 64, 3), "rgb", "hwc", 3),
        ((4, 64, 64), "rgba", "chw", 4),
        ((64, 64, 4), "rgba", "hwc", 4),
        ((1, 64, 64), "gray", "chw", 1),
        ((64, 64, 1), "gray", "hwc", 1),
        ((64, 64), "gray", None, 1),
    ],
)
def test_image_shapes(shape, kind, layout, channels) -> None:
    result = meta("image", shape)
    assert (result.kind, result.layout, result.channels) == (kind, layout, channels)
    assert result.renderable


def test_ambiguous_channel_axis_defaults_to_hwc() -> None:
    result = meta("weird", (3, 4, 3))
    assert result.ambiguous
    assert result.layout == "hwc"
    assert (result.height, result.width, result.channels) == (3, 4, 3)


def test_multichannel_stack() -> None:
    result = meta("feature_stack", (16, 32, 32))
    assert result.kind == "stack"
    assert result.channels == 16
    assert result.ambiguous
    assert result.renderable


def test_batch_dimension_is_reported() -> None:
    result = meta("batch_rgb", (8, 3, 32, 32))
    assert result.batch == 8
    assert result.kind == "rgb"
    assert result.layout == "chw"


def test_gainmap_name_overrides_kind() -> None:
    for shape in ((32, 32, 1), (3, 32, 32), (32, 32)):
        result = meta("hdr_gainmap", shape)
        assert result.kind == "gainmap", shape
        assert result.renderable


def test_gainmap_stack_stays_a_stack() -> None:
    assert meta("gainmap_pyramid", (12, 32, 32)).kind == "stack"


@pytest.mark.parametrize(
    ("shape", "kind"),
    [
        ((), "scalar"),
        ((5,), "table"),
        ((512,), "table"),
        ((3, 3), "table"),
        ((9, 9), "table"),
    ],
)
def test_small_and_flat_arrays_render_as_data(shape, kind) -> None:
    result = meta("values", shape)
    assert result.kind == kind
    assert not result.renderable


def test_just_over_small_matrix_threshold_becomes_an_image() -> None:
    assert meta("values", (10, 10)).kind == "gray"


def test_non_numeric_is_not_renderable() -> None:
    result = meta("note", (), "<U16")
    assert result.kind == "scalar"
    assert not result.renderable
    result = meta("notes", (4,), "<U16")
    assert result.kind == "raw"


def test_five_dimensions_is_unsupported() -> None:
    result = meta("odd", (2, 2, 3, 32, 32))
    assert result.kind == "raw"
    assert not result.renderable


def test_uint8_and_uint16_are_still_images() -> None:
    assert meta("srgb", (32, 32, 3), "uint8").kind == "rgb"
    assert meta("raw", (32, 32, 3), "uint16").kind == "rgb"
