"""Generate npz fixtures that exercise every rendering path in docs/SPEC.md.

Typical use:

    python scripts/make_sample_npz.py                     # small browsable tree
    python scripts/make_sample_npz.py --stress 200000     # pagination stress folder
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]

# Three "method" folders so ↑/↓ sibling-folder navigation has somewhere to go.
VARIANTS = ("baseline", "method_a", "method_b")


def synthetic_scene(height: int, width: int, seed: int, tint: float) -> np.ndarray:
    """Linear RGB in ``(H, W, 3)`` with deliberately out-of-range highlights."""
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:height, 0:width]
    u = xs / max(1, width - 1)
    v = ys / max(1, height - 1)
    radius = np.hypot(u - 0.5, v - 0.5) * 2.0

    red = u * 0.9 + 0.05
    green = v * 0.9 + 0.05
    blue = np.clip(1.2 - radius, 0.0, 1.4)
    scene = np.stack([red, green, blue], axis=-1).astype(np.float32)

    # Saturated patches make the BT.2020 -> P3 difference visible.
    patch = max(8, min(height, width) // 8)
    for index, color in enumerate(
        ((1.0, 0.02, 0.02), (0.02, 1.0, 0.02), (0.02, 0.02, 1.0), (1.6, 1.5, 0.1))
    ):
        top = patch
        left = patch + index * patch * 2
        if left + patch > width:
            break
        scene[top : top + patch, left : left + patch] = color

    scene *= 1.0 + tint * 0.15
    scene += rng.normal(0.0, 0.004, scene.shape).astype(np.float32)
    return scene


def build_payload(height: int, width: int, seed: int, tint: float) -> dict[str, np.ndarray]:
    scene = synthetic_scene(height, width, seed, tint)
    rng = np.random.default_rng(seed + 977)

    ys, xs = np.mgrid[0:height, 0:width]
    disc = (np.hypot(xs - width * 0.6, ys - height * 0.45) < min(height, width) * 0.25)

    gainmap = (0.6 + 1.3 * (xs / max(1, width - 1))).astype(np.float32)
    depth = (rng.random((height, width), dtype=np.float32) * 40.0 + 120.0).astype(np.float32)

    half_h, half_w = max(2, height // 2), max(2, width // 2)
    quarter = np.stack(
        [
            synthetic_scene(half_h, half_w, seed + offset, tint).transpose(2, 0, 1)
            for offset in range(4)
        ]
    ).astype(np.float32)

    return {
        "rgb_hwc": scene,
        "rgb_chw": np.ascontiguousarray(scene.transpose(2, 0, 1)),
        "rgba_hwc": np.concatenate(
            [
                np.clip(scene, 0, 1),
                np.clip(disc.astype(np.float32) * 0.9 + 0.1, 0, 1)[..., None],
            ],
            axis=-1,
        ).astype(np.float32),
        "srgb_uint8": (np.clip(scene, 0, 1) * 255).astype(np.uint8),
        "raw_uint16": (np.clip(scene, 0, 1) * 65535).astype(np.uint16),
        "gainmap": gainmap[..., None].astype(np.float32),
        "gainmap_rgb": np.ascontiguousarray(
            np.stack([gainmap, gainmap * 0.8, gainmap * 1.1]).astype(np.float32)
        ),
        # Half resolution on purpose: real gainmaps often are, which exercises comparing
        # keys of different sizes in the same npz.
        "gainmap_half": gainmap[::2, ::2, None].astype(np.float32),
        "object_mask": disc.astype(np.float32)[None, ...],
        "soft_mask": np.clip(
            1.0 - np.hypot(xs - width * 0.3, ys - height * 0.6) / (min(height, width) * 0.4),
            0.0,
            1.0,
        ).astype(np.float32),
        "depth_raw": depth,
        "feature_stack": rng.random((16, max(2, height // 4), max(2, width // 4)), dtype=np.float32),
        "batch_rgb": quarter,
        "ambiguous_3x4x3": rng.random((3, 4, 3), dtype=np.float32),
        "histogram": rng.random(512, dtype=np.float32),
        "exposure_stops": np.array([-2.0, -1.0, 0.0, 1.0, 2.0], dtype=np.float32),
        "ccm_3x3": np.array(
            [[1.62, -0.51, -0.11], [-0.19, 1.35, -0.16], [0.02, -0.28, 1.26]], dtype=np.float64
        ),
        "iso": np.float32(320.0),
        "with_nans": np.where(disc, np.float32(np.nan), scene[..., 0]).astype(np.float32),
        "note": np.array("captured with synthetic generator"),
    }


def write_npz(path: Path, payload: dict[str, np.ndarray], compress: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    saver = np.savez_compressed if compress else np.savez
    saver(path, **payload)


# Inside-compare keeps the checked key names when you step to another npz.
# The last frame and method_b drop a few so KEY NOT FOUND is a real fixture,
# not something that only happens with mocked metadata.
OMIT_ON_LAST_FRAME = ("gainmap", "gainmap_half", "soft_mask")
OMIT_ON_METHOD_B = ("object_mask", "depth_raw")


def _omit_keys(payload: dict[str, np.ndarray], names: tuple[str, ...]) -> None:
    for name in names:
        payload.pop(name, None)


def build_tree(out_dir: Path, count: int, height: int, width: int) -> int:
    written = 0
    for scene_index in range(1, 3):
        for variant_index, variant in enumerate(VARIANTS):
            folder = out_dir / f"scene_{scene_index:02d}" / variant
            for frame in range(1, count + 1):
                seed = scene_index * 1000 + variant_index * 100 + frame
                payload = build_payload(height, width, seed, tint=variant_index)
                omitted: list[str] = []
                if frame == count:
                    _omit_keys(payload, OMIT_ON_LAST_FRAME)
                    omitted.extend(OMIT_ON_LAST_FRAME)
                if variant == "method_b":
                    _omit_keys(payload, OMIT_ON_METHOD_B)
                    omitted.extend(OMIT_ON_METHOD_B)
                write_npz(
                    folder / f"frame_{frame:03d}.npz",
                    payload,
                    compress=frame % 2 == 0,
                )
                written += 1
                suffix = f"  (no {', '.join(omitted)})" if omitted else ""
                print(f"  {folder.name}/frame_{frame:03d}.npz{suffix}", flush=True)
    return written


def build_stress(out_dir: Path, count: int) -> int:
    """Write ``count`` tiny npz files by reusing one in-memory archive.

    Re-running ``np.savez`` per file would take hours at 200k; blitting identical
    bytes keeps it to a single pass of filesystem writes.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    payload = {
        "rgb_hwc": (np.random.default_rng(7).random((32, 32, 3)) * 1.2).astype(np.float32),
        "object_mask": np.zeros((1, 32, 32), dtype=np.float32),
        "iso": np.float32(100.0),
    }
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name, array in payload.items():
            member = io.BytesIO()
            np.lib.format.write_array(member, array, allow_pickle=False)
            archive.writestr(f"{name}.npy", member.getvalue())
    blob = buffer.getvalue()

    started = time.perf_counter()
    for index in range(count):
        (out_dir / f"stress_{index:07d}.npz").write_bytes(blob)
        if index % 10000 == 0 and index:
            rate = index / (time.perf_counter() - started)
            print(f"  {index}/{count} ({rate:.0f}/s)", flush=True)
    return count


def update_roots(roots_file: Path, entries: list[tuple[str, Path]]) -> None:
    payload: dict[str, list[dict[str, str]]] = {"roots": []}
    if roots_file.exists():
        try:
            existing = json.loads(roots_file.read_text(encoding="utf-8"))
            if isinstance(existing.get("roots"), list):
                payload["roots"] = existing["roots"]
        except (json.JSONDecodeError, OSError):
            pass
    known = {str(item.get("path", "")).casefold() for item in payload["roots"]}
    for name, directory in entries:
        posix = directory.resolve().as_posix()
        if posix.casefold() in known:
            continue
        payload["roots"].append(
            {"id": f"{name}-{abs(hash(posix)) % 0xFFFFFF:06x}", "name": name, "path": posix}
        )
    roots_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"roots file updated: {roots_file}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "sample_data")
    parser.add_argument("--count", type=int, default=4, help="每个 variant 文件夹里的 npz 数量")
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument(
        "--stress",
        type=int,
        default=0,
        help="额外生成一个含 N 个极小 npz 的扁平目录用于分页压测",
    )
    parser.add_argument("--stress-out", type=Path, default=REPO_ROOT / "stress_data")
    parser.add_argument("--clean", action="store_true", help="先清空输出目录")
    parser.add_argument("--stress-only", action="store_true", help="只生成压测目录")
    parser.add_argument("--no-roots", action="store_true", help="不要写入 roots.json")
    args = parser.parse_args(argv)

    if args.clean and args.out.exists():
        shutil.rmtree(args.out)

    started = time.perf_counter()
    entries: list[tuple[str, Path]] = []

    if not args.stress_only:
        print(f"building sample tree in {args.out}")
        written = build_tree(args.out, args.count, args.height, args.width)
        print(f"wrote {written} npz files")
        entries.append(("样例数据", args.out))

    if args.stress > 0:
        print(f"building stress folder with {args.stress} files in {args.stress_out}")
        build_stress(args.stress_out, args.stress)
        entries.append(("分页压测", args.stress_out))

    if not args.no_roots:
        update_roots(REPO_ROOT / "roots.json", entries)

    print(f"done in {time.perf_counter() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
