#!/usr/bin/env node
// Local client shell: optional Python backend + UI/hub.
// Dev checkout uses Vite preview. Portable zip uses bundled Node/Python and
// the prebuilt hub server (no npm / Vite at runtime).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = resolve(ROOT, "frontend");
const DIST = resolve(FRONTEND, "dist", "index.html");
const HUB_SERVER = resolve(ROOT, "scripts", "hub-server.mjs");
const BACKEND_PORT = Number(process.env.NPZVIEW_BACKEND_PORT ?? 8756);
const UI_PORT = Number(process.env.NPZVIEW_DEV_PORT ?? 5273);
const SKIP_LOCAL = process.env.NPZVIEW_NO_LOCAL_BACKEND === "1";
const BUNDLED_NODE_WIN = resolve(ROOT, "runtime", "node", "node.exe");
const BUNDLED_NODE_POSIX = resolve(ROOT, "runtime", "node", "bin", "node");
const PORTABLE =
  process.env.NPZVIEW_PORTABLE === "1" ||
  existsSync(BUNDLED_NODE_WIN) ||
  existsSync(BUNDLED_NODE_POSIX);

const children = [];

function pythonBin() {
  const bundledWin = resolve(ROOT, "runtime", "python", "python.exe");
  const bundledPosix = resolve(ROOT, "runtime", "python", "bin", "python3");
  if (PORTABLE) {
    if (process.platform === "win32" && existsSync(bundledWin)) return bundledWin;
    if (existsSync(bundledPosix)) return bundledPosix;
    throw new Error("便携版缺少 runtime/python");
  }
  const posix = resolve(ROOT, ".venv", "bin", "python");
  const win = resolve(ROOT, ".venv", "Scripts", "python.exe");
  if (process.platform === "win32" && existsSync(win)) return win;
  if (existsSync(posix)) return posix;
  return process.platform === "win32" ? "python" : "python3";
}

function nodeBin() {
  if (process.platform === "win32" && existsSync(BUNDLED_NODE_WIN)) return BUNDLED_NODE_WIN;
  if (existsSync(BUNDLED_NODE_POSIX)) return BUNDLED_NODE_POSIX;
  return "node";
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function withRuntimePath(extraEnv = {}) {
  const dirs = [];
  const nodeDir = resolve(ROOT, "runtime", "node");
  const pyDir = resolve(ROOT, "runtime", "python");
  if (existsSync(resolve(nodeDir, process.platform === "win32" ? "node.exe" : "bin"))) {
    dirs.push(nodeDir, resolve(nodeDir, "bin"));
  }
  if (existsSync(pyDir)) {
    dirs.push(pyDir, resolve(pyDir, "Scripts"), resolve(pyDir, "bin"));
  }
  const sep = process.platform === "win32" ? ";" : ":";
  const path = [...dirs, extraEnv.PATH ?? process.env.PATH ?? ""].filter(Boolean).join(sep);
  const env = {
    ...process.env,
    ...extraEnv,
    PATH: path,
    NPZVIEW_ROOT: ROOT,
    NPZVIEW_DIST: resolve(FRONTEND, "dist"),
    NPZVIEW_DEV_PORT: String(UI_PORT),
    NPZVIEW_BACKEND_PORT: String(BACKEND_PORT),
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
  };
  return env;
}

function run(command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: withRuntimePath(extraEnv),
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) return;
    if (code !== 0 && code !== null) {
      console.error(`${command} ${args.join(" ")} exited ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function waitHttp(port, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path, timeout: 1500 }, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) resolveWait();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        rejectWait(new Error(`timeout waiting for 127.0.0.1:${port}${path}`));
      } else setTimeout(attempt, 300);
    };
    attempt();
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 400).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  if (!existsSync(DIST)) {
    if (PORTABLE) {
      throw new Error(`便携版缺少前端产物: ${DIST}`);
    }
    console.log("building frontend…");
    await new Promise((resolveBuild, rejectBuild) => {
      const build = spawn(npmCmd(), ["run", "build"], {
        cwd: FRONTEND,
        env: withRuntimePath(),
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      build.on("exit", (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error("build failed"))));
    });
  }

  if (!SKIP_LOCAL) {
    if (PORTABLE) {
      try {
        await waitHttp(BACKEND_PORT, "/api/health", 400);
        throw new Error(
          `127.0.0.1:${BACKEND_PORT} 已被占用。请关掉其他 npz-view / 后端，或设置 NPZVIEW_BACKEND_PORT。`,
        );
      } catch (err) {
        if (String(err.message ?? err).includes("已被占用")) throw err;
      }
      const py = pythonBin();
      console.log(`starting bundled backend (${py}) on 127.0.0.1:${BACKEND_PORT}`);
      run(py, ["-m", "app.main", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)], resolve(ROOT, "backend"));
      await waitHttp(BACKEND_PORT, "/api/health", 20000);
    } else {
      try {
        await waitHttp(BACKEND_PORT, "/api/health", 800);
        console.log(`reusing local backend on 127.0.0.1:${BACKEND_PORT}`);
      } catch {
        const py = pythonBin();
        console.log(`starting local backend (${py}) on 127.0.0.1:${BACKEND_PORT}`);
        run(py, ["-m", "app.main", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)], resolve(ROOT, "backend"));
        await waitHttp(BACKEND_PORT, "/api/health", 20000);
      }
    }
  }

  console.log(`starting UI + SSH hub on http://127.0.0.1:${UI_PORT}`);
  if (PORTABLE) {
    if (!existsSync(HUB_SERVER)) {
      throw new Error(`便携版缺少 ${HUB_SERVER}`);
    }
    run(nodeBin(), [HUB_SERVER], FRONTEND);
  } else {
    run(npmCmd(), ["run", "preview"], FRONTEND);
  }
  await waitHttp(UI_PORT, "/__hub/state", 20000);
  console.log(`npz-view ready  →  http://127.0.0.1:${UI_PORT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  shutdown(1);
});
