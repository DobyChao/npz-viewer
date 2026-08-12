from __future__ import annotations

import numpy as np
import pytest

from app.errors import BadParam
from app.models import KeyMeta
from app.services.npzio import classify
from app.services.render import RenderParams, compute_stats, pixels_for, render_gray_plane

SMALL = 9


def describe(name: str, array: np.ndarray) -> KeyMeta:
    return classify(name, array.shape, str(array.dtype), SMALL)


def render(name: str, array: np.ndarray, **kwargs) -> np.ndarray:
    return pixels_for(array, describe(name, array), RenderParams(key=name, **kwargs))


def filled(shape: tuple[int, ...], values: list[float]) -> np.ndarray:
    array = np.zeros(shape, dtype=np.float32)
    array[...] = np.asarray(values, dtype=np.float32)
    return array


# --- RGB pipeline ----------------------------------------------------------


def test_rgb_applies_gamma_2_2() -> None:
    pixels = render("rgb_hwc", filled((2, 2, 3), [0.25, 0.5, 1.0]))
    assert pixels.shape == (2, 2, 3)
    assert pixels[0, 0].tolist() == [136, 186, 255]


def test_rgb_clips_out_of_range_values() -> None:
    pixels = render("rgb_hwc", filled((2, 2, 3), [-0.5, 1.5, 1.0]))
    assert pixels[0, 0].tolist() == [0, 255, 255]


def test_chw_layout_is_transposed() -> None:
    array = np.zeros((3, 2, 2), dtype=np.float32)
    array[0] = 1.0
    pixels = render("rgb_chw", array)
    assert pixels.shape == (2, 2, 3)
    assert pixels[0, 0].tolist() == [255, 0, 0]


def test_layout_override_beats_auto_detection() -> None:
    array = np.zeros((3, 4, 3), dtype=np.float32)
    array[0] = 1.0
    as_hwc = render("ambiguous", array)
    as_chw = render("ambiguous", array, layout="chw")
    assert as_hwc.shape == (3, 4, 3)
    assert as_chw.shape == (4, 3, 3)


def test_batch_index_selects_a_slice() -> None:
    array = np.zeros((3, 3, 2, 2), dtype=np.float32)
    array[1, 1] = 1.0
    pixels = render("batch_rgb", array, batch=1)
    assert pixels[0, 0].tolist() == [0, 255, 0]


def test_batch_index_out_of_range_is_rejected() -> None:
    array = np.zeros((2, 3, 2, 2), dtype=np.float32)
    with pytest.raises(BadParam):
        render("batch_rgb", array, batch=5)


# --- colour gamut ----------------------------------------------------------


def test_p3_conversion_changes_saturated_colours() -> None:
    array = filled((2, 2, 3), [0.5, 0.25, 0.125])
    native = render("rgb_hwc", array, gamut="bt2020")
    converted = render("rgb_hwc", array, gamut="p3")
    assert converted[0, 0, 0] > native[0, 0, 0]
    assert converted[0, 0, 1] < native[0, 0, 1]


def test_bt2020_mode_leaves_values_untouched() -> None:
    array = filled((2, 2, 3), [0.25, 0.5, 1.0])
    assert render("rgb_hwc", array, gamut="bt2020")[0, 0].tolist() == [136, 186, 255]


# --- gainmap ---------------------------------------------------------------


def test_gainmap_halves_after_clipping_to_two() -> None:
    pixels = render("hdr_gainmap", filled((2, 2, 3), [0.5, 1.0, 2.0]))
    assert pixels[0, 0].tolist() == [136, 186, 255]


def test_gainmap_clips_above_two() -> None:
    pixels = render("hdr_gainmap", filled((2, 2, 3), [3.0, 9.0, 2.0]))
    assert pixels[0, 0].tolist() == [255, 255, 255]


def test_gainmap_skips_gamut_conversion_by_default() -> None:
    array = filled((2, 2, 3), [1.0, 0.5, 0.25])
    assert np.array_equal(
        render("hdr_gainmap", array, gamut="p3"),
        render("hdr_gainmap", array, gamut="bt2020"),
    )


def test_gainmap_gamut_flag_opts_into_conversion() -> None:
    array = filled((2, 2, 3), [1.0, 0.5, 0.25])
    forced = render("hdr_gainmap", array, gamut="p3", gainmap_gamut=True)
    plain = render("hdr_gainmap", array, gamut="bt2020")
    assert not np.array_equal(forced, plain)


def test_single_channel_gainmap_stays_linear() -> None:
    # clip(1.0, 0, 2) / 2 == 0.5, and no gamma means 0.5 -> 128 rather than 186.
    pixels = render("gainmap", filled((2, 2, 1), [1.0]))
    assert pixels.shape == (2, 2)
    assert pixels[0, 0] == 128


# --- masks and grayscale ---------------------------------------------------


def test_mask_is_linear_not_gamma_encoded() -> None:
    pixels = render("object_mask", filled((1, 12, 16), [0.25]))
    assert pixels.shape == (12, 16)
    assert pixels[0, 0] == 64
    assert pixels[0, 0] != 136


def test_mask_clips_without_normalising_by_default() -> None:
    array = np.full((12, 12), 120.0, dtype=np.float32)
    assert render("depth_raw", array)[0, 0] == 255


def test_normalize_maps_min_and_max_to_the_full_range() -> None:
    array = np.linspace(100.0, 200.0, 144, dtype=np.float32).reshape(12, 12)
    pixels = render("depth_raw", array, normalize=True)
    assert pixels.min() == 0
    assert pixels.max() == 255


def test_normalize_handles_constant_arrays() -> None:
    array = np.full((12, 12), 7.0, dtype=np.float32)
    assert render("depth_raw", array, normalize=True).max() == 0


def test_colormap_produces_rgb() -> None:
    array = np.linspace(0.0, 1.0, 144, dtype=np.float32).reshape(12, 12)
    pixels = render("depth_raw", array, colormap="viridis")
    assert pixels.shape == (12, 12, 3)
    assert pixels[0, 0].tolist() != pixels[-1, -1].tolist()


def test_gray_plane_ignores_gamma_for_every_value() -> None:
    values = np.array([[0.0, 0.5, 1.0]], dtype=np.float32)
    pixels = render_gray_plane(values, is_gainmap=False, normalize=False, colormap="none")
    assert pixels.tolist() == [[0, 128, 255]]


# --- alpha -----------------------------------------------------------------


def test_composite_mode_keeps_alpha_channel() -> None:
    array = filled((2, 2, 4), [1.0, 1.0, 1.0, 0.25])
    pixels = render("rgba_hwc", array)
    assert pixels.shape == (2, 2, 4)
    # Alpha is linear, so 0.25 stays 64 while the gamma-encoded RGB saturates.
    assert pixels[0, 0].tolist() == [255, 255, 255, 64]


def test_rgb_mode_drops_alpha() -> None:
    array = filled((2, 2, 4), [1.0, 1.0, 1.0, 0.25])
    assert render("rgba_hwc", array, alpha="rgb").shape == (2, 2, 3)


def test_alpha_mode_returns_the_alpha_plane() -> None:
    array = filled((2, 2, 4), [1.0, 1.0, 1.0, 0.5])
    pixels = render("rgba_hwc", array, alpha="alpha")
    assert pixels.shape == (2, 2)
    assert pixels[0, 0] == 128


def test_alpha_mode_on_rgb_is_rejected() -> None:
    with pytest.raises(BadParam):
        render("rgb_hwc", filled((2, 2, 3), [1.0]), alpha="alpha")


# --- stacks ----------------------------------------------------------------


def test_stack_channel_selection() -> None:
    array = np.zeros((8, 12, 16), dtype=np.float32)
    array[5] = 1.0
    assert render("feature_stack", array, channel=0)[0, 0] == 0
    assert render("feature_stack", array, channel=5)[0, 0] == 255


def test_stack_channel_out_of_range_is_rejected() -> None:
    array = np.zeros((8, 12, 16), dtype=np.float32)
    with pytest.raises(BadParam):
        render("feature_stack", array, channel=99)


def test_shape_with_two_plausible_channel_axes_is_read_as_hwc() -> None:
    # (1, 4, 4) could be CHW or HWC; the spec's tie-break picks HWC, i.e. a 1x4 RGBA strip.
    meta = describe("mask", np.zeros((1, 4, 4), dtype=np.float32))
    assert meta.ambiguous and meta.layout == "hwc" and meta.channels == 4


# --- dtype handling --------------------------------------------------------


def test_uint8_is_divided_by_255() -> None:
    array = np.full((2, 2, 3), 128, dtype=np.uint8)
    expected = round((128 / 255) ** (1 / 2.2) * 255)
    assert render("srgb", array)[0, 0, 0] == expected


def test_uint16_is_divided_by_65535() -> None:
    array = np.full((2, 2, 3), 65535, dtype=np.uint16)
    assert render("raw16", array)[0, 0].tolist() == [255, 255, 255]


def test_nan_becomes_black() -> None:
    array = filled((2, 2, 3), [np.nan, 1.0, 0.0])
    assert render("rgb_hwc", array)[0, 0].tolist() == [0, 255, 0]


# --- statistics ------------------------------------------------------------


def test_stats_ignore_non_finite_values() -> None:
    array = np.array([0.0, 1.0, np.nan, np.inf, -np.inf, 0.5], dtype=np.float32)
    stats = compute_stats(array)
    assert stats.nan_count == 1
    assert stats.inf_count == 2
    assert stats.min == 0.0
    assert stats.max == 1.0
    assert stats.count == 6


def test_stats_on_all_nan_array_returns_none() -> None:
    stats = compute_stats(np.full(4, np.nan, dtype=np.float32))
    assert stats.min is None and stats.max is None
    assert stats.nan_count == 4
