from __future__ import annotations

import numpy as np
import numpy.typing as npt

Chromaticity = tuple[float, float]
Primaries = tuple[Chromaticity, Chromaticity, Chromaticity, Chromaticity]

# (red, green, blue, white) chromaticities.
BT2020: Primaries = ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046), (0.3127, 0.3290))
P3D65: Primaries = ((0.680, 0.320), (0.265, 0.690), (0.150, 0.060), (0.3127, 0.3290))

GAMMA = 2.2


def xy_to_xyz(x: float, y: float) -> npt.NDArray[np.float64]:
    return np.array([x / y, 1.0, (1.0 - x - y) / y], dtype=np.float64)


def rgb_to_xyz_matrix(primaries: Primaries) -> npt.NDArray[np.float64]:
    """Standard Lindbloom construction: primary columns scaled so RGB=(1,1,1) hits the white point."""
    red, green, blue, white = primaries
    columns = np.stack([xy_to_xyz(*red), xy_to_xyz(*green), xy_to_xyz(*blue)], axis=1)
    scale = np.linalg.solve(columns, xy_to_xyz(*white))
    return columns * scale


def conversion_matrix(source: Primaries, target: Primaries) -> npt.NDArray[np.float64]:
    return np.linalg.inv(rgb_to_xyz_matrix(target)) @ rgb_to_xyz_matrix(source)


M_BT2020_TO_P3 = conversion_matrix(BT2020, P3D65).astype(np.float32)


def bt2020_to_p3(rgb: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Convert linear BT.2020 RGB (``..., 3``) to linear Display P3 RGB."""
    if rgb.shape[-1] != 3:
        raise ValueError(f"expected a trailing RGB axis, got shape {rgb.shape}")
    return rgb @ M_BT2020_TO_P3.T


def encode_gamma(linear: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Pure power-function encoding, deliberately not the sRGB piecewise curve."""
    return np.power(linear, 1.0 / GAMMA, dtype=np.float32)


def to_uint8(values: npt.NDArray[np.float32]) -> npt.NDArray[np.uint8]:
    return np.clip(np.rint(values * 255.0), 0, 255).astype(np.uint8)
