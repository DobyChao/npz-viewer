#!/usr/bin/env node
// Assemble a Windows x64 portable zip: Tauri exe + bundled Node + embeddable
// Python + frontend dist + hub server. Extract and double-click; no git checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const CACHE = join(ROOT, "packaging", "cache");
const DIST_PORTABLE = join(ROOT, "dist-portable");
const VERSION = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8")).version;
const STAGE_NAME = `npz-view-${VERSION}-windows-x64`;
const STAGE = join(DIST_PORTABLE, STAGE_NAME);
const ZIP = join(DIST_PORTABLE, `${STAGE_NAME}.zip`);
const NODE_VERSION = process.env.NPZVIEW_NODE_VERSION ?? "24.18.0";
const PYTHON_VERSION = process.env.NPZVIEW_PYTHON_VERSION ?? "3.14.6";

function die(message) {
  console.error(message);
  process.exit(1);
}

function usesWinShell(command) {
  if (process.platform !== "win32") return false;
  return command === "npm" || command === "npx";
}

function run(command, args, cwd = ROOT, extra = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: usesWinShell(command),
    env: { ...process.env, ...extra.env },
  });
  if (result.status !== 0) {
    die(`${command} ${args.join(" ")} failed (${result.status})`);
  }
}

function pythonEnv(pythonDir) {
  return {
    PYTHONNOUSERSITE: "1",
    PYTHONHOME: pythonDir,
    PYTHONUTF8: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`cached ${dest}`);
    return;
  }
  console.log(`download ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) die(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  run("tar", ["-xf", zip, "-C", dest]);
}

function copyTree(src, dest, skip = (name) => false) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name, entry)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, skip);
    else copyFileSync(from, to);
  }
}

function skipBackend(name) {
  return (
    name === "__pycache__" ||
    name === "tests" ||
    name === ".pytest_cache" ||
    name.endsWith(".pyc")
  );
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

function enableEmbeddableSite(pythonDir) {
  const pth = readdirSync(pythonDir).find((name) => name.endsWith("._pth"));
  if (!pth) die(`no python*._pth in ${pythonDir}`);
  const zipName = readdirSync(pythonDir).find((name) => /^python\d+\.zip$/i.test(name));
  writeFileSync(
    join(pythonDir, pth),
    `${zipName ?? "python314.zip"}\n.\nLib\\site-packages\n..\\..\\backend\nimport site\n`,
  );
}

function windowsBuildEnv() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const tools = join(home, ".rustup", "toolchains");
  const complete = [];
  const cargoOnly = [];
  if (existsSync(tools)) {
    for (const name of readdirSync(tools)) {
      const bin = join(tools, name, "bin");
      const cargo = existsSync(join(bin, "cargo.exe"));
      const rustc = existsSync(join(bin, "rustc.exe"));
      if (cargo && rustc) complete.push(bin);
      else if (cargo) cargoOnly.push(bin);
    }
  }
  // Windows App Control (error 4551) can block some toolchain cargo.exe (here:
  // stable) while allowing an older cargo-only dir. Pair a runnable cargo with
  // a toolchain that still has rustc+std.
  const rustcDir = complete[0];
  const cargoDir = cargoOnly[0] ?? complete[0];
  const env = {
    PATH: [cargoDir, rustcDir, process.env.PATH ?? ""].filter(Boolean).join(";"),
    CARGO_TARGET_DIR: join(FRONTEND, "src-tauri", "target"),
  };
  if (cargoDir) env.CARGO = join(cargoDir, "cargo.exe");
  if (rustcDir) env.RUSTC = join(rustcDir, "rustc.exe");
  return env;
}
function findExe(targetDir) {
  const candidates = [
    join(targetDir, "release", "npz-view.exe"),
    join(FRONTEND, "src-tauri", "target", "release", "npz-view.exe"),
    join(FRONTEND, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "npz-view.exe"),
    join(DIST_PORTABLE, STAGE_NAME, "npz-view.exe"),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

async function main() {
  if (process.platform !== "win32") {
    die("Windows 便携 zip 需要在 64 位 Windows 上打包（本机 Tauri + embeddable Python）。");
  }

  mkdirSync(CACHE, { recursive: true });
  mkdirSync(DIST_PORTABLE, { recursive: true });

  if (!existsSync(join(FRONTEND, "node_modules", "vite"))) {
    run("npm", ["install"], FRONTEND);
  } else {
    console.log("reusing frontend/node_modules");
  }
  run("npm", ["run", "build"], FRONTEND);

  const hubOut = join(CACHE, "hub-server.mjs");
  run(
    "npx",
    [
      "esbuild",
      "hub/standalone.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${hubOut}`,
      "--packages=bundle",
      "--external:ssh2",
      "--external:cpu-features",
      "--external:sshcrypto",
    ],
    FRONTEND,
  );

  const nodeZip = join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
  await download(
    `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
    nodeZip,
  );
  const nodeExtract = join(CACHE, `node-v${NODE_VERSION}-win-x64`);
  const nodeExeSrc = join(nodeExtract, `node-v${NODE_VERSION}-win-x64`, "node.exe");
  if (!existsSync(nodeExeSrc)) {
    rmSync(nodeExtract, { recursive: true, force: true });
    extractZip(nodeZip, nodeExtract);
  }
  if (!existsSync(nodeExeSrc)) die(`node.exe missing at ${nodeExeSrc}`);

  const pyZip = join(CACHE, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  await download(
    `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
    pyZip,
  );
  const reqHash = sha256(join(ROOT, "requirements.txt"));
  const pyStamp = join(CACHE, "python.stamp");
  const pyDir = join(CACHE, "python");
  const wantedStamp = `${PYTHON_VERSION}:${reqHash}:isolated-target`;
  if (!existsSync(join(pyDir, "python.exe")) || !existsSync(pyStamp) || readFileSync(pyStamp, "utf8").trim() !== wantedStamp) {
    rmSync(pyDir, { recursive: true, force: true });
    mkdirSync(pyDir, { recursive: true });
    extractZip(pyZip, pyDir);
    enableEmbeddableSite(pyDir);
    const site = join(pyDir, "Lib", "site-packages");
    mkdirSync(site, { recursive: true });
    const getPip = join(CACHE, "get-pip.py");
    await download("https://bootstrap.pypa.io/get-pip.py", getPip);
    const py = join(pyDir, "python.exe");
    const env = { env: pythonEnv(pyDir) };
    run(py, [getPip, "--no-warn-script-location", "--no-user"], pyDir, env);
    run(
      py,
      [
        "-m",
        "pip",
        "install",
        "--no-warn-script-location",
        "--no-user",
        "--target",
        site,
        "-r",
        join(ROOT, "requirements.txt"),
      ],
      pyDir,
      env,
    );
    const prefetch = join(CACHE, "prefetch_ffmpeg.py");
    writeFileSync(
      prefetch,
      "import imageio_ffmpeg\nprint(imageio_ffmpeg.get_ffmpeg_exe())\n",
    );
    run(py, [prefetch], pyDir, env);
    run(
      py,
      ["-c", "import fastapi, numpy, orjson, PIL, imageio_ffmpeg; print('python-ok', fastapi.__file__)"],
      pyDir,
      env,
    );
    writeFileSync(pyStamp, wantedStamp);
  } else {
    console.log("reusing cached embeddable Python");
    enableEmbeddableSite(pyDir);
  }

  const buildEnv = windowsBuildEnv();
  let exe = findExe(buildEnv.CARGO_TARGET_DIR);
  if (exe && !process.env.NPZVIEW_FORCE_TAURI) {
    console.log(`reusing ${exe}（窗口壳未改；设 NPZVIEW_FORCE_TAURI=1 可强制重编）`);
  } else {
    run("npx", ["tauri", "build", "--no-bundle"], FRONTEND, { env: buildEnv });
    exe = findExe(buildEnv.CARGO_TARGET_DIR);
    if (!exe) die("npz-view.exe not found after tauri build");
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, "scripts"), { recursive: true });
  mkdirSync(join(STAGE, "runtime", "node"), { recursive: true });
  mkdirSync(join(STAGE, "frontend", "dist"), { recursive: true });

  copyFileSync(exe, join(STAGE, "npz-view.exe"));
  copyFileSync(join(ROOT, "scripts", "npz-view.mjs"), join(STAGE, "scripts", "npz-view.mjs"));
  copyFileSync(hubOut, join(STAGE, "scripts", "hub-server.mjs"));
  copyFileSync(nodeExeSrc, join(STAGE, "runtime", "node", "node.exe"));
  cpSync(pyDir, join(STAGE, "runtime", "python"), { recursive: true });
  copyTree(join(ROOT, "backend"), join(STAGE, "backend"), skipBackend);
  copyFileSync(join(ROOT, "requirements.txt"), join(STAGE, "requirements.txt"));
  cpSync(join(FRONTEND, "dist"), join(STAGE, "frontend", "dist"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "windows-client.txt"), join(STAGE, "README.txt"));
  writeFileSync(
    join(STAGE, "open.bat"),
    '@echo off\r\ncd /d "%~dp0"\r\nstart "" "npz-view.exe"\r\n',
  );

  const vendor = join(CACHE, "ssh2-vendor");
  const vendorSsh2 = join(vendor, "node_modules", "ssh2");
  if (!existsSync(vendorSsh2)) {
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, "package.json"), '{"private":true}\n');
    run("npm", ["install", "ssh2@1.17.0", "--omit=dev", "--ignore-scripts"], vendor);
  }
  cpSync(join(vendor, "node_modules"), join(STAGE, "node_modules"), { recursive: true });

  if (existsSync(ZIP)) rmSync(ZIP);
  const stagingParent = DIST_PORTABLE;
  run("tar", ["-a", "-cf", ZIP, "-C", stagingParent, STAGE_NAME]);
  const mb = (statSync(ZIP).size / (1024 * 1024)).toFixed(1);
  console.log(`\n便携 zip: ${ZIP} (${mb} MB)`);
  console.log("解压到普通文件夹后双击 npz-view.exe。不要放到 Program Files。");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
