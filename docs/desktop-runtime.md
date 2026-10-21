# Desktop runtime consolidation

This architecture ships as **0.2.0**. Frontend, Tauri/Cargo and Python health/API
versions are aligned. The Windows artifact is `npz-view-0.2.0-windows-x64.zip`;
the desktop smoke script derives its default folder and expected health version
from package.json.

## Scope

Move the desktop control plane (sessions, SSH authentication, remote deployment,
tunnels and API routing) into Rust. Load the UI from Tauri's embedded assets.
Remove Node from the Windows portable distribution. Keep the Python processing
backend, the browser launcher, and pure FastAPI static hosting supported.

Local Python starts on the first local API request, rather than blocking window
creation. The Rust data bridge binds only to loopback and requires a per-launch
token. Image requests retain session identity and file-version cache stamps.

## Compatibility requirements

- Password, encrypted key and agent authentication; cancellable connection.
- Probe remote listener ownership and health before deploying; reuse a healthy
  same-user backend without SFTP or pip. Reject occupied incompatible ports.
- Keep remote dependencies import-check and existing tmux/nohup startup behavior.
- Independent native tab sessions; shared connections remain alive for other tabs.
- Preserve compare visibility/fullscreen, gallery scrolling and sequence behavior.
- Portable zip remains extract-and-run. No GitHub release replacement is included.

## Baseline

The existing local 0.1.1 zip is 120,407,316 bytes (~114.83 MiB). Its compressed
payload includes 32.95 MiB Node, 75.82 MiB Python/dependencies (including
29.77 MiB FFmpeg), and 3.49 MiB Tauri. Uncompressed payload is ~310 MiB.

## Validation

The 0.2.0 portable zip is **74,273,400 bytes (70.83 MiB)**, with **192.24 MiB**
uncompressed payload: 38.3% smaller compressed and about 38% smaller extracted
than the baseline. It contains no Node runtime, node_modules, external frontend,
pip package or .pyc files. FFmpeg remains bundled for offline video export.

SHA-256: `82EB4C604020E12D2CEC95415BA37CB00E553E8061E2E7A3003E8B4872AE38AB`.

The 0.2.0 version check confirms package/lock files, Cargo/Tauri metadata,
Python, health, settings and OpenAPI agree. The rebuilt Windows executable's
ProductVersion is 0.2.0; the actual portable desktop smoke check passed with
an explicit health-version assertion.

- `npm run build`: frontend typecheck and production build passed.
- `cargo test --manifest-path frontend/src-tauri/Cargo.toml --lib --offline`:
  7 tests passed, including real loopback SSH password/encrypted-key auth,
  SFTP upload/mtime skipping, tunnel requests with stamped image URLs, shared
  sessions, reuse without SFTP, foreign-user rejection and cancelled authentication.
- `cargo clippy ... --all-targets --features bridge-harness -- -D warnings`: passed.
- Python suite: 146 passed (`--basetemp _verify/pytest-native -p no:cacheprovider`).
- Chromium through the native bridge: 28 passed. Browser/Node hub: 28 passed.
- Browser launcher `node scripts/npz-view.mjs`: static page, hub state and backend
  health returned 200 on its ephemeral port.
- Pure Python `--static-dir ../frontend/dist`: page and health returned 200.
- Actual Windows Tauri/WebView2 smoke check passed: embedded tauri.localhost
  assets, native tabs, compare hide/show/full, gallery scroll and both Python
  and bridge shutdown after closing the last tab. Also passed after extracting
  the final zip into a path containing spaces and launching from an unrelated
  working directory. Bundled Python imports and bundled FFmpeg execution passed.

The existing scrubber regression test assigned `input.value` through React's
tracked setter, so its synthetic events never reached `onChange` in either
runtime. The test now uses the native prototype setter before dispatching the
same rapid input events; product sequence behavior was unchanged.

## Implementation map

- `frontend/src-tauri/src/hub.rs`: sessions, cancellable connections, streaming
  bridge, lazy local Python ownership and shutdown.
- `frontend/src-tauri/src/ssh.rs`: russh authentication, host keys, SFTP and TCP
  forwarding. Shared shell/Python probes live under `scripts/remote/` with LF
  enforced by `.gitattributes`. Native sync uploads only backend/app and
  requirements and preserves remote state rather than deleting unrelated files.
- `frontend/src/lib/transport.ts`: injected desktop origin/token; browser and
  pure Python pages continue to use relative URLs.
- `scripts/pack-windows-portable.mjs`: fresh Tauri build, embedded UI, Python
  without pip or precompiled caches. Node, node_modules and external UI are omitted.

Builds require Rust 1.89+ for russh. Runtime requirements remain Windows WebView2;
Python and FFmpeg stay bundled for full offline processing/export. Agent auth
uses the Windows OpenSSH named pipe (or SSH_AUTH_SOCK), and SSH_AUTH_SOCK on Unix.

## Reproducing desktop checks

`bridge-harness` is an opt-in developer binary, excluded from the portable zip.
It prints a JSON origin/token for testing without a native window:

```text
cargo run --manifest-path frontend/src-tauri/Cargo.toml --features bridge-harness --bin npz-view-bridge -- <repo-root>
```

Set `NPZVIEW_E2E_BRIDGE` to that JSON before `npm run e2e` in frontend/ to run the
same suite against Rust. Set `NPZVIEW_CACHE_DIR` to a writable test directory in
restricted environments. Without the bridge variable, the suite uses Node/Vite.

After `npm run pack:windows`, run `node scripts/test-desktop.mjs` from the repository
root. This launches the actual portable exe with an isolated WebView2 profile,
checks embedded assets, gallery scroll, compare hide/show/full, native tab
creation/close, and verifies backend/data bridge termination after the last tab.
Its screenshot is `_verify/native-desktop/compare.png`. No remote server
credentials are required. Production Linux server deployment and a user's live
ssh-agent have not been exercised by these loopback fixtures.
