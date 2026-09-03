// Orchestrates remote backends over SSH: rsync deploy, remote start (tmux if
// available, else nohup), an SSH tunnel, and health checks. Runs in the Vite
// dev server (Node); the browser drives it through the /__hub control API.
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import {
  addServer,
  readServers,
  removeServer,
  type ServerProfile,
} from "./store.ts";

type ConnState = "idle" | "connecting" | "active" | "error";

interface Conn {
  state: ConnState;
  localPort?: number;
  tunnel?: ChildProcess;
  error?: string;
  log: string[];
}

export interface HubServerView extends ServerProfile {
  state: ConnState;
  error: string | null;
  active: boolean;
  log: string[];
}

export interface HubState {
  active: string; // "local" or a server id
  localActive: boolean;
  servers: HubServerView[];
}

export interface Target {
  host: string;
  port: number;
}

const REPO_ROOT = resolve(process.cwd(), "..");
const LOCAL_BACKEND: Target = {
  host: "127.0.0.1",
  port: Number(process.env.NPZVIEW_BACKEND_PORT ?? 8756),
};
// rsync junk / local-only state we never want to push to a server.
const RSYNC_EXCLUDES = [
  ".git",
  ".venv",
  "frontend",
  "sample_data",
  "stress_data",
  "roots.json",
  "servers.json",
  "__pycache__",
  "*.pyc",
  "_verify",
];

const conns = new Map<string, Conn>();
let active = "local";

function connOf(id: string): Conn {
  let conn = conns.get(id);
  if (!conn) {
    conn = { state: "idle", log: [] };
    conns.set(id, conn);
  }
  return conn;
}

function log(conn: Conn, line: string): void {
  for (const part of line.split(/\r?\n/)) {
    if (part.trim()) conn.log.push(part);
  }
  if (conn.log.length > 60) conn.log.splice(0, conn.log.length - 60);
}

function sshOpts(profile: ServerProfile): string[] {
  return [
    "-p",
    String(profile.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
}

function run(
  conn: Conn,
  cmd: string,
  args: string[],
  input?: string,
): Promise<number> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT });
    child.stdout.on("data", (chunk) => log(conn, String(chunk)));
    child.stderr.on("data", (chunk) => log(conn, String(chunk)));
    child.on("error", (err) => {
      log(conn, `${cmd} 启动失败: ${err.message}`);
      resolveRun(-1);
    });
    child.on("close", (code) => resolveRun(code ?? -1));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function healthCheck(port: number, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveHealth) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolveHealth(true);
          else retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) resolveHealth(false);
      else setTimeout(attempt, 500);
    };
    attempt();
  });
}

function remoteBootstrapScript(profile: ServerProfile): string {
  const dir = profile.remoteDir;
  const port = profile.remotePort;
  // Prefer 3.14/3.13 (video export needs the subprocess.communicate fix from
  // CPython 3.13+); fall back to python3 with a warning. Start under tmux when
  // present, otherwise nohup with a pidfile so we can stop it later.
  return `set -e
cd ${dir}
PY=""
for c in python3.14 python3.13 python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "远端没有 python3"; exit 3; }
echo "using $PY ($($PY --version 2>&1))"
case "$($PY -c 'import sys;print(sys.version_info[1])')" in
  1[3-9]) : ;;
  *) echo "警告: 远端 Python < 3.13，视频导出会失败" ;;
esac
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv || { echo "创建 venv 失败，远端可能缺少 python venv 包"; exit 4; }
fi
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t npzview-backend 2>/dev/null || true
  tmux new-session -d -s npzview-backend "cd '$(pwd)/backend' && '$(pwd)/.venv/bin/python' -m app.main --host 127.0.0.1 --port ${port}"
  echo "backend started via tmux on 127.0.0.1:${port}"
else
  [ -f .npzview-backend.pid ] && kill "$(cat .npzview-backend.pid)" 2>/dev/null || true
  cd backend
  nohup ../.venv/bin/python -m app.main --host 127.0.0.1 --port ${port} > ../.npzview-backend.log 2>&1 &
  echo $! > ../.npzview-backend.pid
  echo "backend started via nohup (pid $(cat ../.npzview-backend.pid)) on 127.0.0.1:${port}"
fi`;
}

function remoteStopScript(profile: ServerProfile): string {
  return `cd ${profile.remoteDir} 2>/dev/null || exit 0
if command -v tmux >/dev/null 2>&1; then tmux kill-session -t npzview-backend 2>/dev/null || true; fi
[ -f .npzview-backend.pid ] && kill "$(cat .npzview-backend.pid)" 2>/dev/null || true
rm -f .npzview-backend.pid
echo "backend stopped"`;
}

function killTunnel(conn: Conn): void {
  if (conn.tunnel && !conn.tunnel.killed) {
    conn.tunnel.kill("SIGTERM");
  }
  conn.tunnel = undefined;
}

async function connect(id: string): Promise<void> {
  const profile = readServers().find((server) => server.id === id);
  if (!profile) throw new Error("server not found");
  const conn = connOf(id);
  killTunnel(conn);
  conn.state = "connecting";
  conn.error = undefined;
  conn.log = [];

  const sshTarget = `${profile.user}@${profile.host}`;

  // 1. rsync the backend to the remote.
  log(conn, `rsync → ${sshTarget}:${profile.remoteDir}`);
  const sshCmd = `ssh ${sshOpts(profile).join(" ")}`;
  const rsyncArgs = [
    "-az",
    "--delete",
    "-e",
    sshCmd,
    ...RSYNC_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
    `${REPO_ROOT}/`,
    `${sshTarget}:${profile.remoteDir}/`,
  ];
  if ((await run(conn, "rsync", rsyncArgs)) !== 0) {
    conn.state = "error";
    conn.error = "rsync 失败（检查 SSH 连接和路径）";
    throw new Error(conn.error);
  }

  // 2. Bootstrap + start the backend on the remote.
  log(conn, "远端安装依赖并启动后端…");
  const bootstrap = await run(
    conn,
    "ssh",
    [...sshOpts(profile), sshTarget, "bash -s"],
    remoteBootstrapScript(profile),
  );
  if (bootstrap !== 0) {
    conn.state = "error";
    conn.error = "远端启动后端失败";
    throw new Error(conn.error);
  }

  // 3. Open the SSH tunnel: local <freePort> -> remote 127.0.0.1:<remotePort>.
  const localPort = await freePort();
  log(conn, `建立隧道 127.0.0.1:${localPort} → 远端 127.0.0.1:${profile.remotePort}`);
  const tunnel = spawn(
    "ssh",
    [
      ...sshOpts(profile),
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`,
      sshTarget,
    ],
    { cwd: REPO_ROOT },
  );
  tunnel.stderr.on("data", (chunk) => log(conn, `tunnel: ${String(chunk)}`));
  tunnel.on("close", () => {
    if (conn.state === "active") {
      conn.state = "error";
      conn.error = "隧道已断开";
      if (active === id) active = "local";
    }
  });
  conn.tunnel = tunnel;
  conn.localPort = localPort;

  // 4. Health-check through the tunnel.
  if (!(await healthCheck(localPort))) {
    killTunnel(conn);
    conn.state = "error";
    conn.error = "健康检查失败（后端未在远端就绪）";
    throw new Error(conn.error);
  }

  log(conn, "连接就绪");
  conn.state = "active";
  active = id;
}

async function disconnect(id: string): Promise<void> {
  const conn = connOf(id);
  killTunnel(conn);
  const profile = readServers().find((server) => server.id === id);
  if (profile) {
    await run(
      conn,
      "ssh",
      [...sshOpts(profile), `${profile.user}@${profile.host}`, "bash -s"],
      remoteStopScript(profile),
    );
  }
  conn.state = "idle";
  conn.localPort = undefined;
  conn.error = undefined;
  if (active === id) active = "local";
}

function setActive(target: string): void {
  if (target === "local") {
    active = "local";
    return;
  }
  const conn = conns.get(target);
  if (!conn || conn.state !== "active") {
    throw new Error("该服务器未连接");
  }
  active = target;
}

function state(): HubState {
  const servers = readServers().map<HubServerView>((profile) => {
    const conn = conns.get(profile.id);
    return {
      ...profile,
      state: conn?.state ?? "idle",
      error: conn?.error ?? null,
      active: active === profile.id,
      log: conn?.log ?? [],
    };
  });
  return { active, localActive: active === "local", servers };
}

function activeTarget(): Target {
  if (active === "local") return LOCAL_BACKEND;
  const conn = conns.get(active);
  if (conn?.state === "active" && conn.localPort) {
    return { host: "127.0.0.1", port: conn.localPort };
  }
  return LOCAL_BACKEND;
}

function shutdown(): void {
  for (const conn of conns.values()) killTunnel(conn);
}

export const manager = {
  state,
  activeTarget,
  add: (input: Omit<ServerProfile, "id">) => addServer(input),
  remove: (id: string) => {
    const conn = conns.get(id);
    if (conn) killTunnel(conn);
    conns.delete(id);
    if (active === id) active = "local";
    removeServer(id);
  },
  connect,
  disconnect,
  setActive,
  shutdown,
};
