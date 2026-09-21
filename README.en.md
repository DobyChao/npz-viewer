# NPZ Viewer

[中文](README.md) | **English**

A local browser for `.npz` files from image experiments: linear RGB, gainmaps, masks, feature maps, and small matrices in one archive. Flip through a huge result tree, inspect keys, and compare versions with a FastStone-style synced view.

- Backend: Python + FastAPI — scan folders, unpack npz, render arrays to PNG/WebP
- Frontend: React + Vite + Tailwind — layout, thumbnails, synced compare
- Built for folders with up to ~200k npz files: three-level directory cache, server-side pagination, throttled lazy thumbnails
- UI in **Chinese / English** (top-bar switch; first visit follows the browser language)

Canonical product spec: [`docs/SPEC.md`](docs/SPEC.md) (Chinese). Compare-panel sash vs button visibility: [`docs/resizable-panel-visibility.md`](docs/resizable-panel-visibility.md).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop client](#desktop-client-tauri)
- [Remote backend](#remote-backend)
- [Render rules](#render-rules)
- [Hotkeys and compare](#hotkeys-and-compare)
- [Tests](#tests)
- [Large folders](#large-folders)
- [Layout](#layout)

## Requirements

- Python 3.11+ (developed on 3.14)
- Node.js `^20.19.0 || >=22.12.0` (Vite 8; listed in `frontend/package.json` `engines`; developed on 24)
- Desktop window (`npm run tauri:dev` / `tauri:build`): Rust 1.85+ and the system WebView (Linux: `libwebkit2gtk-4.1-dev` `libgtk-3-dev`)

`typecheck` calls `node node_modules/typescript/lib/tsc.js` instead of `tsc`. TypeScript 7's `bin/tsc` is an extensionless ESM file; older Node raises `ERR_UNKNOWN_FILE_EXTENSION`. The `.js` entry works across the engine range.

## Quick start

Browser dev (Vite proxies `/api`, no CORS):

```bash
# 1. Backend deps
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt      # Linux/macOS: .venv/bin/pip

# 2. Sample data (also writes roots.json)
.venv\Scripts\python scripts/make_sample_npz.py

# 3. Backend (default 127.0.0.1:8756)
cd backend && ..\.venv\Scripts\python -m app.main

# 4. Frontend in another terminal (default 127.0.0.1:5273)
cd frontend && npm install && npm run dev
```

Open http://127.0.0.1:5273 .

### Allowed directories (roots)

The backend only serves paths under `roots.json`. Traversal (`..`, symlinks that escape) returns `PATH_OUTSIDE_ROOT`.

```json
{
  "roots": [
    { "id": "results", "name": "experiment results", "path": "D:/data/results" },
    { "id": "nas", "name": "NAS", "path": "/mnt/nas/exp" }
  ]
}
```

Add or remove roots from the top bar, or edit the file — the backend hot-reloads on mtime. Use forward slashes on both Windows and Linux.

### Single-process server (no local SSH switching)

When the data already lives on this machine and people open a browser:

```bash
cd frontend && npm run build
cd ../backend && ..\.venv\Scripts\python -m app.main --static-dir ../frontend/dist
```

One URL: http://127.0.0.1:8756 . No Node, so the UI cannot SSH to another machine.

### Startup flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host` / `--port` | `127.0.0.1` / `8756` | Bind address |
| `--roots-file` | `./roots.json` | Root whitelist |
| `--cache-dir` | `npz_view` under the system cache dir | Disk cache for renders and directory indexes |
| `--max-cache-gb` | `8` | Disk cache cap; LRU by last access |
| `--array-cache-mb` | `2048` | In-memory LRU of decoded arrays |
| `--small-matrix-max` | `9` | 2-D arrays ≤ N×N shown as number tables |
| `--allow-pickle` | off | Load object arrays (**runs pickle in the file**; trusted data only) |
| `--static-dir` | none | Serve a built frontend |

Environment variables with an `NPZVIEW_` prefix work too, e.g. `NPZVIEW_PORT=9000`.

## Desktop client (Tauri)

The browser cannot SSH. The desktop window is Tauri (system WebView); SSH is still a local Node `ssh2` hub.

```bash
cd frontend && npm install
npm run tauri:dev
```

This starts Vite on `:5273` and a native window (native tab bar, one WebView per tab). “Backend servers” switches the backend for **the current tab** only.

### Windows portable zip

On 64-bit Windows (Node, Rust, WebView2):

```bash
cd frontend && npm install
npm run pack:windows
```

Output: `dist-portable/npz-view-0.1.1-windows-x64.zip`. Extract to a normal folder and run `npz-view.exe`. The zip already includes Node, embeddable Python, and the frontend dist — **do not** install extra Node/Python, and **do not** put it in Program Files. If it fails to start, check `npz-view-hub.log` next to the exe.

Build an exe from source (still needs local Node / Python / this repo):

```bash
cd frontend && npm run build
npm run tauri:build
```

Cross-compile Windows x64 on Linux with `npm run tauri:build:windows`. That NSIS `setup.exe` installs to Program Files and does not match the portable layout — use the zip.

A release build starts `scripts/npz-view.mjs` and gives the hub an **ephemeral local port** (`NPZVIEW_UI_PORT`, not fixed 5273). Closing the last tab or the window stops that shell.

UI only, no native window:

```bash
node scripts/npz-view.mjs
```

Picks a free port if none is specified.

## Remote backend

When the data sits on a server, run the backend next to it and keep the UI local. Top bar → Backend servers → Add server. Fill in SSH user / host / SSH port, remote directory (default `~/.npz-viewer-backend`), and backend port, then Connect.

Auth:

- **Password**: typed at connect time, memory only, never written to `servers.json`
- **Private key file**: local path, optional passphrase; the path may be remembered, not the key bytes or passphrase
- **ssh-agent**: reuse keys already loaded locally

Connect: SSH → probe remote `127.0.0.1:<backend port>` occupancy and `/api/health` → **reuse a healthy backend owned by the same user (tunnel only, skip deploy)** → if the port is idle, SFTP-sync `backend/app` and `requirements.txt` and start (skip pip if the venv already imports deps). The dialog can abort an in-progress connect.

**Raw npz files never leave the server** — only rendered images and JSON come back. Use switches the current tab. The tunnel closes only when no tab still points at that server.

Port conflicts:

1. Idle → deploy and start
2. Healthy instance of this app owned by this SSH user → **reuse**, tunnel only
3. Another program or another user's npz-viewer → error; change the backend port; nothing unknown is killed

The remote dir needs a `.venv` (first connect tries `python3 -m venv`). Video export needs Python 3.13+ on the remote. The server list lives in local `servers.json` (gitignored).

Pure Python `--static-dir` has no Node layer, so the UI cannot start SSH.

## Render rules

Classification and pixel math happen on the backend. The UI only shows the 8-bit images.

| Array | Kind | Display |
| --- | --- | --- |
| `[C,H,W]` / `[H,W,C]`, C=3 | `rgb` | Linear RGB, clip 0–1, gamma 2.2 |
| C=4 | `rgba` | Same; **no gamma on alpha**; checkerboard behind |
| C=1 or 2-D | `gray` | Linear; optional min/max normalize and colormap |
| key name contains `gainmap` | `gainmap` | Clip 0–2, divide by 2, then gamma 2.2 |
| other C | `stack` | One gray channel at a time |
| 4-D `[B,...]` | batched | Batch index on the card |
| 1-D, or 2-D ≤ 9×9 | `table` | Numeric table |

The top bar switches BT.2020 vs P3. P3 applies a BT.2020 → Display P3 matrix **before** clip and gamma. Output has **no ICC profile**; the browser treats pixels as sRGB, so a wide-gamut display is approximate. Full rules: SPEC §4.

Ambiguous shapes such as `[3,4,3]` default to HWC, with a CHW/HWC toggle on the card.

## Hotkeys and compare

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next npz in the folder (natural order) |
| `↑` / `↓` | Same-index npz in the adjacent sibling folder |
| `Space` | A/B blink (never play/pause) |
| `P` | Inside-file compare: enter sequence and play/pause when a range is set |
| `1`–`4` | Jump to compare tile N |
| Hold `X` | Temporarily lift the overlay |
| `F` | Compare panel fills the right pane / restore split |
| `Ctrl+0` / `Ctrl+1` | Fit / 100% |
| `R` | Refresh the current folder (drop that directory's index cache) |
| `Esc` | Close compare; if the lightbox is open, close that first |
| `G` | Toggle the temporary operator tile |

Wheel-zoom (cursor-anchored) and drag-pan; **all tiles share one viewport**. Above 150% the sampler switches to nearest-neighbor.

Two mutually exclusive ways to spot small diffs:

- **A/B blink**: one image at a time, Space cycles
- **Overlay**: FastStone Overlay (Right on Left). Hold X to overlay by default; click Overlay to lock. The source can be any non-base tile (including the operator tile); the destination is always tile 1

**Equal height**: when sizes differ (gainmaps are often half-res), scale each image to tile 1's display height. Works together with overlay.

**Sequence play/export** exists only for inside-file compare. The film button engages sequence so tiles follow the playhead; clicking another list file exits. `P` plays without skipping frames (effective fps drops if needed) and does not loop. Export composites the current grid to a silent H.264 MP4 on a server path (`save_dir`), with no browser save picker. Cross-file compare has no sequence bar.

## Tests

```bash
.venv\Scripts\python -m pytest
cd frontend && npm run typecheck
cd frontend && npm run e2e
```

E2E needs the backend on 8756; Playwright starts (or reuses) the frontend dev server. Synced pan/zoom needs a non-passive native wheel listener and pointer capture, so it lives in Playwright, not unit tests.

## Large folders

A folder of 200k npz files is a design target:

- One `os.scandir` pass for names and stats
- Three-level snapshot cache: in-process LRU → columnar JSON on disk → rescan; invalidated by directory mtime
- Server-side pagination plus virtualized list
- IntersectionObserver thumbnails, max 4 in flight
- Render cache keyed by (mtime + size + all render params), with ETags

Stress data: `python scripts/make_sample_npz.py --stress 200000 --stress-only`.

## Layout

```
backend/app/
  api/          FastAPI routes: roots / fs / npz / nav / video
  services/     dirindex, npzio, render, imgcache, video_export
  color.py      Gamut matrices and gamma
  paths.py      Path normalization and root checks
frontend/src/
  components/   TopBar, FolderTree, NpzList, NpzInfo, gallery/, compare/
  i18n/         zh/en dictionaries and t()
  hooks/        usePanZoom, useImageResource, useHotkeys, useNpzNavigation, useSequencePlayback
  store/        zustand app + compare state
  lib/          API client, types, formatting
scripts/        sample and stress data
docs/SPEC.md    product spec
```
