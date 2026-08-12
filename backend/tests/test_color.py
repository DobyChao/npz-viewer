from __future__ import annotations

import numpy as np

from app.color import M_BT2020_TO_P3, encode_gamma, rgb_to_xyz_matrix, to_uint8
from app.color import BT2020, P3D65

EXPECTED = np.array(
    [
        [1.3435, -0.2822, -0.0613],
        [-0.0653, 1.0758, -0.0105],
        [0.0028, -0.0196, 1.0169],
    ]
)


def test_matrix_matches_published_values() -> None:
    assert np.allclose(M_BT2020_TO_P3, EXPECTED, atol=1e-3)


def test_white_point_is_preserved() -> None:
    white = M_BT2020_TO_P3 @ np.ones(3, dtype=np.float32)
    assert np.allclose(white, np.ones(3), atol=1e-5)


def test_primary_matrices_hit_their_white_point() -> None:
    for primaries in (BT2020, P3D65):
        matrix = rgb_to_xyz_matrix(primaries)
        xyz = matrix @ np.ones(3)
        x = xyz[0] / xyz.sum()
        y = xyz[1] / xyz.sum()
        assert np.allclose((x, y), primaries[3], atol=1e-6)


def test_gamma_encoding_is_pure_power_curve() -> None:
    values = np.array([0.0, 0.25, 0.5, 1.0], dtype=np.float32)
    assert np.allclose(encode_gamma(values), values ** (1 / 2.2), atol=1e-6)
    assert to_uint8(encode_gamma(values)).tolist() == [0, 136, 186, 255]


def test_p3_conversion_desaturates_wide_gamut_colors() -> None:
    # BT.2020 primaries fall outside P3, so a saturated red needs more P3 red to match.
    color = np.array([[[0.5, 0.25, 0.125]]], dtype=np.float32)
    converted = color @ M_BT2020_TO_P3.T
    assert converted[0, 0, 0] > color[0, 0, 0]
    assert converted[0, 0, 1] < color[0, 0, 1]
