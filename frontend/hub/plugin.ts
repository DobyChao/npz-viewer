// Local UI process control plane (dev server and `vite preview` / npz-view):
//   - GET/POST/DELETE under /__hub  → manage & connect servers (always local)
//   - everything under /api         → reverse-proxied to the SESSION's backend
//     (the local one, or an SSH tunnel to a remote one)
// The browser keeps calling /api exactly as before; only the upstream changes.
import http from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { DEFAULT_SESSION, manager, type Target } from "./manager.ts";
import type { ConnectAuth } from "./store.ts";

export type HubReq = http.IncomingMessage & { originalUrl?: string };

const SESSION_HEADER = "x-npzview-session";
const SESSION_QUERY = "npzview_session";

function readBody(req: HubReq): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  const bytes = Buffer.from(payload, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
  });
  res.end(bytes);
}

function parseAuth(body: Record<string, unknown>): ConnectAuth {
  const method = body.authMethod;
  return {
    authMethod: method === "password" || method === "key" ? method : "agent",
    password: typeof body.password === "string" ? body.password : undefined,
    keyPath: typeof body.keyPath === "string" ? body.keyPath : undefined,
    passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
  };
}

function headerSession(req: HubReq): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
  return undefined;
}

function querySession(rawUrl: string): string | undefined {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex < 0) return undefined;
  const value = new URLSearchParams(rawUrl.slice(qIndex + 1)).get(SESSION_QUERY)?.trim();
  return value || undefined;
}

export function sessionFromRequest(req: HubReq): string {
  const fromHeader = headerSession(req);
  if (fromHeader) return manager.ensureSession(fromHeader);
  const fromQuery = querySession(req.originalUrl ?? req.url ?? "");
  if (fromQuery) return manager.ensureSession(fromQuery);
  return DEFAULT_SESSION;
}

function stripSessionParam(raw: string): string {
  const qIndex = raw.indexOf("?");
  if (qIndex < 0) return raw;
  const path = raw.slice(0, qIndex);
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  if (!params.has(SESSION_QUERY)) return raw;
  params.delete(SESSION_QUERY);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function proxyApi(req: HubReq, res: http.ServerResponse, target: Target): void {
  const path = stripSessionParam(req.originalUrl ?? req.url ?? "/");
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`,
      } as http.OutgoingHttpHeaders,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers as http.OutgoingHttpHeaders);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(
      JSON.stringify({
        detail: {
          code: "BACKEND_UNREACHABLE",
          message: `后端不可达: ${err.message}`,
          hint: "确认所选后端已连接并在运行。",
        },
      }),
    );
  });
  req.pipe(upstream);
}

export async function handleHub(req: HubReq, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  const method = req.method ?? "GET";
  const sessionId = sessionFromRequest(req);

  try {
    if (method === "GET" && path === "/state") {
      return sendJson(res, 200, manager.state(sessionId));
    }
    if (method === "POST" && path === "/sessions") {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      const id = manager.createSession(typeof body.id === "string" ? body.id : undefined);
      return sendJson(res, 200, { id, state: manager.state(id) });
    }
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && sessionMatch) {
      await manager.deleteSession(decodeURIComponent(sessionMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
    const sessionActiveMatch = path.match(/^\/sessions\/([^/]+)\/active$/);
    if (method === "POST" && sessionActiveMatch) {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.setSessionActive(decodeURIComponent(sessionActiveMatch[1]), String(body.target ?? "local"));
      return sendJson(res, 200, manager.state(decodeURIComponent(sessionActiveMatch[1])));
    }
    if (method === "POST" && path === "/servers") {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.add(body);
      return sendJson(res, 200, manager.state(sessionId));
    }
    if (method === "POST" && path === "/active") {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.setActive(String(body.target ?? "local"), sessionId);
      return sendJson(res, 200, manager.state(sessionId));
    }
    const removeMatch = path.match(/^\/servers\/([^/]+)$/);
    if (method === "DELETE" && removeMatch) {
      manager.remove(decodeURIComponent(removeMatch[1]));
      return sendJson(res, 200, manager.state(sessionId));
    }
    if (method === "PATCH" && removeMatch) {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.update(decodeURIComponent(removeMatch[1]), body);
      return sendJson(res, 200, manager.state(sessionId));
    }
    const connectMatch = path.match(/^\/servers\/([^/]+)\/connect$/);
    if (method === "POST" && connectMatch) {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      await manager.connect(decodeURIComponent(connectMatch[1]), parseAuth(body), sessionId);
      return sendJson(res, 200, manager.state(sessionId));
    }
    const disconnectMatch = path.match(/^\/servers\/([^/]+)\/disconnect$/);
    if (method === "POST" && disconnectMatch) {
      await manager.disconnect(decodeURIComponent(disconnectMatch[1]), sessionId);
      return sendJson(res, 200, manager.state(sessionId));
    }
    const restartMatch = path.match(/^\/servers\/([^/]+)\/restart$/);
    if (method === "POST" && restartMatch) {
      await manager.restart(decodeURIComponent(restartMatch[1]));
      return sendJson(res, 200, manager.state(sessionId));
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
      state: manager.state(sessionId),
    });
  }
}

function attachHub(server: ViteDevServer | PreviewServer): void {
  // Registered on the server object (not in a returned function) so these run
  // BEFORE Vite's SPA-fallback middleware and never fall through to index.html.
  server.middlewares.use("/__hub", (req, res) => {
    void handleHub(req as HubReq, res);
  });
  server.middlewares.use("/api", (req, res) => {
    const sessionId = sessionFromRequest(req as HubReq);
    proxyApi(req as HubReq, res, manager.activeTarget(sessionId));
  });
  server.httpServer?.once("close", () => manager.shutdown());
}

export function hubPlugin(): Plugin {
  return {
    name: "npzview-hub",
    // Dev (`npm run dev`) and the packaged client (`vite preview` / npz-view)
    // both need SSH + /api proxy. configureServer is dev-only; preview uses
    // configurePreviewServer.
    configureServer: attachHub,
    configurePreviewServer: attachHub,
  };
}
