// Orchestrates remote backends over ssh2: SFTP deploy, remote start
// (tmux if available, else nohup), a local tunnel via conn.forwardOut(),
// and health checks. Runs in the Vite dev server (Node).
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client, type ClientChannel, type ConnectConfig, type Prompt } from "ssh2";
import {
  addServer,
  readServers,
  removeServer,
  updateServer,
  type AuthMethod,
  type ConnectAuth,
  type ServerInput,
  type ServerPatch,
  type ServerProfile,
} from "./store.ts";
import {
  BOOTSTRAP_SH,
  envPrefix,
  HEALTH_PY,
  KILL_OURS_PY,
  OURS_FALLBACK_SH,
  OWNERSHIP_PY,
  STOP_SH,
} from "./remote.ts";
import { mirror } from "./sftp-sync.ts";

type ConnState = "idle" | "connecting" | "active" | "error";

interface Conn {
  state: ConnState;
  localPort?: number;
  tunnel?: net.Server;
  client?: Client;
  error?: string;
  log: string[];
  startedByUs: boolean;
  reused: boolean;
}

export interface HubServerView extends ServerProfile {
  state: ConnState;
  error: string | null;
  active: boolean;
  reused: boolean;
  startedByUs: boolean;
  log: string[];
}

export interface HubState {
  active: string; // "local" or a server id for the requesting session
  localActive: boolean;
  servers: HubServerView[];
  sessionId: string;
  sessions: Record<string, string>;
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

const conns = new Map<string, Conn>();
export const DEFAULT_SESSION = "default";
const sessions = new Map<string, string>([[DEFAULT_SESSION, "local"]]);

function newSessionId(): string {
  return `s_${crypto.randomUUID().replaceAll("-", "")}`;
}

function ensureSession(id: string): string {
  const sid = id.trim() || DEFAULT_SESSION;
  if (!sessions.has(sid)) sessions.set(sid, "local");
  return sid;
}

function sessionTarget(sessionId?: string): string {
  const sid = sessionId && sessions.has(sessionId) ? sessionId : DEFAULT_SESSION;
  return sessions.get(sid) ?? "local";
}

function reassignSessions(from: string, to: string): void {
  for (const [id, target] of sessions) {
    if (target === from) sessions.set(id, to);
  }
}

function sessionsUsing(targetId: string): string[] {
  return [...sessions.entries()].filter(([, target]) => target === targetId).map(([id]) => id);
}

function createSession(id?: string): string {
  if (id?.trim()) return ensureSession(id.trim());
  const sid = newSessionId();
  sessions.set(sid, "local");
  return sid;
}

function setSessionActive(sessionId: string, target: string): void {
  const sid = ensureSession(sessionId);
  if (target === "local") {
    sessions.set(sid, "local");
    return;
  }
  const conn = conns.get(target);
  if (!conn || conn.state !== "active") {
    throw new Error("该服务器未连接");
  }
  sessions.set(sid, target);
}

function connOf(id: string): Conn {
  let conn = conns.get(id);
  if (!conn) {
    conn = { state: "idle", log: [], startedByUs: false, reused: false };
    conns.set(id, conn);
  }
  return conn;
}

function log(conn: Conn, line: string): void {
  for (const part of line.split(/\r?\n/)) {
    if (part.trim()) conn.log.push(part);
  }
  if (conn.log.length > 200) conn.log.splice(0, conn.log.length - 200);
}

function expandUserPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function authError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/All configured authentication methods failed/i.test(message)) {
    return new Error("认证失败（密码或密钥不对，或服务器拒绝）");
  }
  if (/Timed out|TimedOut|ECONNREFUSED/i.test(message)) {
    return new Error(`SSH 连不上: ${message}`);
  }
  if (/Cannot parse privateKey|Encrypted private key/i.test(message)) {
    return new Error("无法读取私钥（需要口令？口令不对？）");
  }
  if (/no such file|ENOENT/i.test(message)) {
    return new Error(message);
  }
  return err instanceof Error ? err : new Error(message);
}

function sshConnect(profile: ServerProfile, auth: ConnectAuth): Promise<Client> {
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.user,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  const method: AuthMethod = auth.authMethod || "agent";

  if (method === "password") {
    const password = auth.password ?? "";
    if (!password) return Promise.reject(new Error("请输入密码"));
    config.password = password;
    config.tryKeyboard = true;
  } else if (method === "key") {
    const keyPath = expandUserPath((auth.keyPath || profile.keyPath || "").trim());
    if (!keyPath) return Promise.reject(new Error("请填写私钥文件路径"));
    if (!existsSync(keyPath)) return Promise.reject(new Error(`私钥不存在: ${keyPath}`));
    config.privateKey = readFileSync(keyPath);
    if (auth.passphrase) config.passphrase = auth.passphrase;
    if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK;
  } else {
    if (!process.env.SSH_AUTH_SOCK) {
      return Promise.reject(new Error("没有 ssh-agent（SSH_AUTH_SOCK 未设置）。请改用密码或私钥文件。"));
    }
    config.agent = process.env.SSH_AUTH_SOCK;
  }

  return new Promise((resolveConn, rejectConn) => {
    const client = new Client();
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolveConn(client);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* ignore */
      }
      rejectConn(authError(err));
    };
    if (method === "password") {
      client.on("keyboard-interactive", (_n, _i, _l, prompts: Prompt[], finish) => {
        const password = auth.password ?? "";
        finish(prompts.map(() => password));
      });
    }
    client.on("ready", succeed);
    client.on("error", fail);
    client.connect(config);
  });
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  client: Client,
  command: string,
  stdin?: string,
  onOutput?: (line: string) => void,
): Promise<ExecResult> {
  return new Promise((resolveExec, rejectExec) => {
    client.exec(command, (err, stream: ClientChannel) => {
      if (err) {
        rejectExec(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      let hold = "";
      const take = (chunk: Buffer | string) => {
        const text = String(chunk);
        hold += text;
        const parts = hold.split(/\r?\n/);
        hold = parts.pop() ?? "";
        if (onOutput) {
          for (const part of parts) {
            if (part.trim()) onOutput(part);
          }
        }
      };
      stream.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
        take(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
        take(chunk);
      });
      stream.on("close", (code: number | null) => {
        if (onOutput && hold.trim()) onOutput(hold);
        resolveExec({ code: code ?? 0, stdout, stderr });
      });
      stream.on("error", rejectExec);
      if (stdin !== undefined) {
        stream.write(stdin);
      }
      stream.end();
    });
  });
}

function parseLastJson<T>(stdout: string): T | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

async function expandRemoteDir(client: Client, remoteDir: string): Promise<string> {
  const trimmed = remoteDir.trim() || "~/.npz-viewer-backend";
  if (!trimmed.startsWith("~")) return trimmed;
  const home = await exec(client, 'printf %s "$HOME"');
  const root = home.stdout || "/tmp";
  if (trimmed === "~") return root;
  return `${root}${trimmed.slice(1)}`;
}

type HttpProbe =
  | { kind: "refused" }
  | { kind: "http"; status: number; body: string }
  | { kind: "blocked"; detail: string };

function remoteHttpGet(client: Client, port: number, path: string, timeoutMs = 4000): Promise<HttpProbe> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value: HttpProbe) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish({ kind: "blocked", detail: "timeout" }), timeoutMs);
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        const msg = err.message || String(err);
        if (/administratively prohibited|forwarding disabled/i.test(msg)) {
          finish({ kind: "blocked", detail: msg });
          return;
        }
        if (/connect failed|ECONNREFUSED|connection refused|No route/i.test(msg)) {
          finish({ kind: "refused" });
          return;
        }
        // sshd often reports a closed port as a generic channel-open failure.
        finish({ kind: "refused" });
        return;
      }
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
      });
      const done = () => {
        clearTimeout(timer);
        const statusMatch = buf.match(/^HTTP\/\d\.\d\s+(\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const sep = buf.indexOf("\r\n\r\n");
        const body = sep >= 0 ? buf.slice(sep + 4) : "";
        finish({ kind: "http", status, body });
      };
      stream.on("close", done);
      stream.on("end", done);
      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer);
        finish({ kind: "blocked", detail: streamErr.message });
      });
      stream.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
  });
}

function isNpzHealth(status: number, body: string): boolean {
  if (status !== 200) return false;
  try {
    const payload = JSON.parse(body) as { ok?: unknown; version?: unknown };
    return payload.ok === true && typeof payload.version === "string";
  } catch {
    return false;
  }
}

export type PortKind = "idle" | "ours" | "other_app" | "other_user";

async function listenerInfo(
  client: Client,
  port: number,
  remoteDir: string,
): Promise<{ uids: number[]; me: number } | null> {
  const prefix = envPrefix(remoteDir, port);
  const py = await exec(client, `${prefix} python3 -`, OWNERSHIP_PY);
  if (py.code !== 0) return null;
  const info = parseLastJson<{ uids?: unknown; me?: unknown }>(py.stdout);
  if (!info || !Array.isArray(info.uids) || typeof info.me !== "number") return null;
  const uids = info.uids.filter((uid): uid is number => typeof uid === "number");
  return { uids, me: info.me };
}

async function remoteHealthExec(client: Client, port: number, remoteDir: string): Promise<HttpProbe> {
  const prefix = envPrefix(remoteDir, port);
  const py = await exec(client, `${prefix} python3 -`, HEALTH_PY);
  const probe = parseLastJson<HttpProbe>(py.stdout);
  if (probe) return probe;
  return { kind: "blocked", detail: py.stderr.trim() || py.stdout.trim() || `python3 exit ${py.code}` };
}

async function weOwnListener(client: Client, port: number, remoteDir: string): Promise<boolean> {
  const info = await listenerInfo(client, port, remoteDir);
  if (info && info.uids.length > 0) {
    return info.uids.every((uid) => uid === info.me);
  }
  const prefix = envPrefix(remoteDir, port);
  const sh = await exec(client, `${prefix} bash -s`, OURS_FALLBACK_SH);
  return /(^|\n)ours\s*$/.test(sh.stdout.trim());
}

async function probePort(
  client: Client,
  port: number,
  remoteDir: string,
  logLine: (line: string) => void,
): Promise<PortKind> {
  logLine(`探测远端 127.0.0.1:${port}（在 SSH 会话内用 python 访问，不依赖本机端口转发）`);
  const info = await listenerInfo(client, port, remoteDir);
  if (info) {
    logLine(
      info.uids.length > 0
        ? `远端 /proc 监听 uid=${info.uids.join(",")}（当前用户 ${info.me}）`
        : "远端 /proc 上该端口无监听",
    );
  } else {
    logLine("无法读取远端 /proc 监听表，改用 HTTP 探测");
  }

  const httpProbe = await remoteHealthExec(client, port, remoteDir);
  if (httpProbe.kind === "http") {
    logLine(`远端 HTTP ${httpProbe.status}`);
  } else if (httpProbe.kind === "refused") {
    logLine("远端 HTTP 连接被拒绝（端口空闲）");
  } else {
    logLine(`远端 HTTP 探测未完成：${httpProbe.detail}`);
  }

  const listening = Boolean(info && info.uids.length > 0);
  const oursHttp = httpProbe.kind === "http" && isNpzHealth(httpProbe.status, httpProbe.body);

  if (!listening) {
    if (oursHttp) {
      // WSL mirrored localhost can reach a Windows process that /proc cannot see.
      logLine("localhost 上已有本应用的健康响应（可能来自 Windows 侧），视为占用");
      return "other_app";
    }
    if (httpProbe.kind === "http") {
      logLine("localhost 上有其他 HTTP 服务");
      return "other_app";
    }
    // Timeout / blocked / refused with no listener: the port is free in this OS.
    // SSH forwardOut timeouts used to be mis-labelled as "occupied" (common on
    // WSL + Windows firewall blocking Node's direct-tcpip channel).
    return "idle";
  }

  if (oursHttp) {
    return (await weOwnListener(client, port, remoteDir)) ? "ours" : "other_user";
  }
  return "other_app";
}

function openTunnel(client: Client, remotePort: number): Promise<{ server: net.Server; localPort: number }> {
  const server = net.createServer((sock) => {
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, stream) => {
      if (err) {
        sock.destroy();
        return;
      }
      sock.pipe(stream);
      stream.pipe(sock);
      const fail = () => {
        sock.destroy();
        stream.destroy();
      };
      sock.on("error", fail);
      stream.on("error", fail);
    });
  });
  return new Promise((resolveTunnel, rejectTunnel) => {
    server.on("error", rejectTunnel);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const localPort = typeof address === "object" && address ? address.port : 0;
      resolveTunnel({ server, localPort });
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

function closeTunnel(conn: Conn): void {
  if (conn.tunnel) {
    try {
      conn.tunnel.close();
    } catch {
      /* ignore */
    }
  }
  conn.tunnel = undefined;
  conn.localPort = undefined;
}

function closeClient(conn: Conn): void {
  if (conn.client) {
    try {
      conn.client.end();
    } catch {
      /* ignore */
    }
  }
  conn.client = undefined;
}

async function stopRemote(conn: Conn, profile: ServerProfile, alsoKillOurs: boolean): Promise<void> {
  if (!conn.client) return;
  const prefix = envPrefix(await expandRemoteDir(conn.client, profile.remoteDir), profile.remotePort);
  await exec(conn.client, `${prefix} bash -s`, STOP_SH);
  if (alsoKillOurs) {
    await exec(conn.client, `${prefix} python3 -`, KILL_OURS_PY);
  }
}

async function attachTunnel(conn: Conn, profile: ServerProfile): Promise<void> {
  if (!conn.client) throw new Error("SSH 未连接");
  const { server, localPort } = await openTunnel(conn.client, profile.remotePort);
  conn.tunnel = server;
  conn.localPort = localPort;
  log(conn, `建立隧道 127.0.0.1:${localPort} → 远端 127.0.0.1:${profile.remotePort}`);
  const timeout = conn.reused ? 8000 : 25000;
  if (!(await healthCheck(localPort, timeout))) {
    closeTunnel(conn);
    const remoteDir = await expandRemoteDir(conn.client, profile.remoteDir);
    const remote = await remoteHealthExec(conn.client, profile.remotePort, remoteDir);
    if (remote.kind === "http" && isNpzHealth(remote.status, remote.body)) {
      throw new Error(
        "远端后端已起来，但本机 SSH 隧道连不上。若连的是 WSL / 127.0.0.1，请在 Windows 防火墙里允许 Node（Defender 拦过「Node Runtime」就会这样），并确认 sshd 开启 AllowTcpForwarding。",
      );
    }
    throw new Error("健康检查失败（后端未在远端就绪）");
  }
}

async function syncCode(conn: Conn, profile: ServerProfile): Promise<string> {
  if (!conn.client) throw new Error("SSH 未连接");
  const remoteDir = await expandRemoteDir(conn.client, profile.remoteDir);
  log(conn, `SFTP 同步 → ${profile.user}@${profile.host}:${remoteDir}`);
  const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolveSftp, rejectSftp) => {
    conn.client!.sftp((err, wrapped) => (err ? rejectSftp(err) : resolveSftp(wrapped)));
  });
  try {
    const stats = await mirror(sftp, REPO_ROOT, remoteDir, (line) => log(conn, line));
    log(conn, `同步完成：上传 ${stats.uploaded}，跳过 ${stats.skipped}，删除 ${stats.deleted}`);
  } finally {
    sftp.end();
  }
  return remoteDir;
}

function venvRequiredError(remoteDir: string): Error {
  return new Error(
    [
      "远端还没有可用的虚拟环境。请 SSH 到该机器，用任意带 pip 的 Python 创建后再连接（不必装系统 python3-venv）：",
      "",
      `  <任意python> -m venv ${remoteDir}/.venv`,
      "",
      "例如：",
      `  python3 -m venv ${remoteDir}/.venv`,
      `  conda create -y -p ${remoteDir}/.venv python=3.13`,
      `  uv venv --python 3.13 ${remoteDir}/.venv`,
      "",
      `残缺目录先删：rm -rf ${remoteDir}/.venv`,
      `确认：${remoteDir}/.venv/bin/python --version`,
    ].join("\n"),
  );
}

async function startRemote(conn: Conn, remoteDir: string, port: number): Promise<void> {
  if (!conn.client) throw new Error("SSH 未连接");
  log(conn, "远端安装依赖并启动后端…");
  const result = await exec(conn.client, `${envPrefix(remoteDir, port)} bash -s`, BOOTSTRAP_SH, (line) =>
    log(conn, line),
  );
  if (result.code !== 0) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code === 4 || /NPZVIEW_VENV_REQUIRED/.test(text)) {
      throw venvRequiredError(remoteDir);
    }
    throw new Error("远端启动后端失败");
  }
}

function persistAuth(id: string, auth: ConnectAuth): void {
  const keyPath = auth.authMethod === "key" ? (auth.keyPath || "").trim() || undefined : undefined;
  updateServer(id, {
    authMethod: auth.authMethod,
    ...(auth.authMethod === "key" ? { keyPath } : {}),
  });
}

function portConflict(kind: "other_app" | "other_user", port: number): Error {
  if (kind === "other_app") {
    return new Error(`远端端口 ${port} 被其他程序占用，请改「后端端口」后再连接。`);
  }
  return new Error(`远端端口 ${port} 已被其他用户的 npz-viewer 占用，请改「后端端口」后再连接。`);
}

async function connect(id: string, auth: ConnectAuth, sessionId?: string): Promise<void> {
  const profile = readServers().find((server) => server.id === id);
  if (!profile) throw new Error("server not found");
  const conn = connOf(id);
  if (conn.state === "connecting") throw new Error("正在连接");
  if (conn.state === "active" && conn.client) {
    if (sessionId) setSessionActive(sessionId, id);
    return;
  }
  closeTunnel(conn);
  closeClient(conn);
  conn.state = "connecting";
  conn.error = undefined;
  conn.log = [];
  conn.startedByUs = false;
  conn.reused = false;

  try {
    log(conn, `SSH ${profile.user}@${profile.host}:${profile.port}（${auth.authMethod}）`);
    const client = await sshConnect(profile, auth);
    conn.client = client;
    client.on("close", () => {
      if (conn.state === "active") {
        conn.state = "error";
        conn.error = "SSH 连接已断开";
        closeTunnel(conn);
        reassignSessions(id, "local");
      }
    });
    persistAuth(id, auth);

    const fwd = await remoteHttpGet(client, 9, "/", 2500);
    if (fwd.kind === "blocked" && /administratively prohibited|forwarding disabled/i.test(fwd.detail)) {
      throw new Error("SSH 服务器禁止端口转发（AllowTcpForwarding）");
    }
    if (fwd.kind === "blocked") {
      log(
        conn,
        `SSH 端口转发无响应（${fwd.detail}）。连 WSL 时 Windows 防火墙若拦截了 Node，隧道会失败；占用探测改走远端 python。`,
      );
    }

    const remoteDir = await syncCode(conn, profile);
    const kind = await probePort(client, profile.remotePort, remoteDir, (line) => log(conn, line));
    if (kind === "other_app" || kind === "other_user") {
      throw portConflict(kind, profile.remotePort);
    }
    if (kind === "ours") {
      log(conn, `复用已有后端 127.0.0.1:${profile.remotePort}`);
      conn.reused = true;
      conn.startedByUs = false;
    } else {
      await startRemote(conn, remoteDir, profile.remotePort);
      conn.startedByUs = true;
      conn.reused = false;
    }
    await attachTunnel(conn, profile);
    log(conn, conn.reused ? "连接就绪（复用）" : "连接就绪");
    conn.state = "active";
    if (sessionId) setSessionActive(sessionId, id);
  } catch (err) {
    closeTunnel(conn);
    closeClient(conn);
    conn.state = "error";
    conn.startedByUs = false;
    conn.reused = false;
    conn.error = err instanceof Error ? err.message : String(err);
    throw err instanceof Error ? err : new Error(conn.error);
  }
}

async function disconnect(id: string, sessionId?: string): Promise<void> {
  if (sessionId) {
    const sid = ensureSession(sessionId);
    if (sessions.get(sid) === id) sessions.set(sid, "local");
  }
  if (sessionsUsing(id).length > 0) return;

  const conn = connOf(id);
  const profile = readServers().find((server) => server.id === id);
  const shouldStop = conn.startedByUs;
  try {
    if (shouldStop && profile && conn.client) {
      log(conn, "停止远端后端…");
      await stopRemote(conn, profile, true);
    } else if (conn.client) {
      log(conn, "断开隧道（远端后端为复用，未停止）");
    }
  } finally {
    // Mark idle before tearing down the client so the 'close' handler is a no-op.
    conn.state = "idle";
    conn.error = undefined;
    conn.startedByUs = false;
    conn.reused = false;
    reassignSessions(id, "local");
    closeTunnel(conn);
    closeClient(conn);
  }
}

async function deleteSession(id: string): Promise<void> {
  if (id === DEFAULT_SESSION) return;
  const target = sessions.get(id);
  sessions.delete(id);
  if (target && target !== "local") await disconnect(target);
}

async function restart(id: string): Promise<void> {
  const profile = readServers().find((server) => server.id === id);
  if (!profile) throw new Error("server not found");
  const conn = connOf(id);
  if (conn.state !== "active" || !conn.client) {
    throw new Error("该服务器未连接");
  }
  log(conn, "重启远端后端（使用刚同步的代码）…");
  try {
    const remoteDir = await syncCode(conn, profile);
    await stopRemote(conn, profile, true);
    // Brief wait so the port is released.
    await new Promise((r) => setTimeout(r, 400));
    closeTunnel(conn);
    await startRemote(conn, remoteDir, profile.remotePort);
    conn.startedByUs = true;
    conn.reused = false;
    await attachTunnel(conn, profile);
    log(conn, "重启完成");
    conn.state = "active";
  } catch (err) {
    closeTunnel(conn);
    conn.state = "error";
    conn.error = err instanceof Error ? err.message : String(err);
    throw err instanceof Error ? err : new Error(conn.error);
  }
}

function setActive(target: string, sessionId?: string): void {
  setSessionActive(sessionId ?? DEFAULT_SESSION, target);
}

function update(id: string, patch: ServerPatch): ServerProfile {
  const conn = conns.get(id);
  if (conn && (conn.state === "active" || conn.state === "connecting")) {
    throw new Error("请先断开再改配置");
  }
  return updateServer(id, patch);
}

function state(sessionId?: string): HubState {
  const sid = ensureSession(sessionId ?? DEFAULT_SESSION);
  const active = sessionTarget(sid);
  const servers = readServers().map<HubServerView>((profile) => {
    const conn = conns.get(profile.id);
    return {
      ...profile,
      state: conn?.state ?? "idle",
      error: conn?.error ?? null,
      active: active === profile.id,
      reused: conn?.reused ?? false,
      startedByUs: conn?.startedByUs ?? false,
      log: conn?.log ?? [],
    };
  });
  return {
    active,
    localActive: active === "local",
    servers,
    sessionId: sid,
    sessions: Object.fromEntries(sessions),
  };
}

function activeTarget(sessionId?: string): Target {
  const active = sessionTarget(sessionId);
  if (active === "local") return LOCAL_BACKEND;
  const conn = conns.get(active);
  if (conn?.state === "active" && conn.localPort) {
    return { host: "127.0.0.1", port: conn.localPort };
  }
  return LOCAL_BACKEND;
}

function shutdown(): void {
  for (const conn of conns.values()) {
    closeTunnel(conn);
    closeClient(conn);
  }
}

export const manager = {
  state,
  activeTarget,
  ensureSession,
  createSession,
  deleteSession,
  setSessionActive,
  add: (input: ServerInput) => addServer(input),
  update,
  remove: (id: string) => {
    const conn = conns.get(id);
    if (conn) {
      closeTunnel(conn);
      closeClient(conn);
    }
    conns.delete(id);
    reassignSessions(id, "local");
    removeServer(id);
  },
  connect,
  disconnect,
  restart,
  setActive,
  shutdown,
};
