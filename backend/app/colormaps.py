from __future__ import annotations

import numpy as np
import numpy.typing as npt

# 17 evenly spaced anchors per map, linearly interpolated to a 256-entry LUT.
# Close enough to matplotlib for data inspection without pulling in matplotlib.
_ANCHORS: dict[str, tuple[tuple[int, int, int], ...]] = {
    "viridis": (
        (68, 1, 84),
        (72, 26, 108),
        (71, 45, 123),
        (66, 64, 134),
        (59, 82, 139),
        (53, 95, 141),
        (47, 108, 142),
        (42, 120, 142),
        (37, 133, 142),
        (33, 145, 140),
        (30, 156, 137),
        (34, 168, 132),
        (53, 183, 121),
        (84, 197, 104),
        (122, 209, 81),
        (181, 222, 43),
        (253, 231, 37),
    ),
    "magma": (
        (0, 0, 4),
        (10, 7, 35),
        (28, 16, 68),
        (52, 16, 104),
        (78, 18, 123),
        (103, 28, 130),
        (128, 37, 130),
        (152, 47, 126),
        (176, 56, 117),
        (200, 68, 105),
        (221, 84, 90),
        (238, 105, 76),
        (249, 131, 74),
        (253, 159, 86),
        (254, 187, 108),
        (254, 214, 138),
        (252, 253, 191),
    ),
    "turbo": (
        (48, 18, 59),
        (65, 69, 171),
        (70, 117, 237),
        (57, 162, 252),
        (36, 200, 224),
        (27, 229, 181),
        (47, 248, 134),
        (86, 255, 94),
        (129, 255, 67),
        (170, 246, 52),
        (206, 227, 49),
        (234, 198, 53),
        (250, 163, 50),
        (254, 123, 36),
        (243, 84, 21),
        (218, 50, 10),
        (122, 4, 3),
    ),
}

AVAILABLE = ("none", *sorted(_ANCHORS))

_LUT_CACHE: dict[str, npt.NDArray[np.uint8]] = {}


def _build_lut(name: str) -> npt.NDArray[np.uint8]:
    anchors = np.asarray(_ANCHORS[name], dtype=np.float32)
    positions = np.linspace(0.0, 1.0, len(anchors), dtype=np.float32)
    targets = np.linspace(0.0, 1.0, 256, dtype=np.float32)
    channels = [np.interp(targets, positions, anchors[:, index]) for index in range(3)]
    return np.clip(np.rint(np.stack(channels, axis=1)), 0, 255).astype(np.uint8)


def get_lut(name: str) -> npt.NDArray[np.uint8]:
    if name not in _ANCHORS:
        raise KeyError(name)
    lut = _LUT_CACHE.get(name)
    if lut is None:
        lut = _build_lut(name)
        _LUT_CACHE[name] = lut
    return lut


def apply(values01: npt.NDArray[np.float32], name: str) -> npt.NDArray[np.uint8]:
    """Map a 0..1 single-channel plane through a colormap, returning HWC uint8 RGB."""
    indices = np.clip(np.rint(values01 * 255.0), 0, 255).astype(np.uint8)
    return get_lut(name)[indices]
