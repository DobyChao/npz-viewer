// Vite plugin that turns the dev server into a small control plane:
//   - GET/POST/DELETE under /__hub  → manage & connect servers (always local)
//   - everything under /api         → reverse-proxied to the ACTIVE backend
//     (the local backend, or an SSH tunnel to a remote one)
// The browser keeps calling /api exactly as before; only the upstream changes.
import http from "node:http";
import type { Connect, Plugin } from "vite";
import { manager, type Target } from "./manager.ts";
import type { ConnectAuth } from "./store.ts";

type Req = Connect.IncomingMessage;

function readBody(req: Req): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
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

function proxyApi(req: Req, res: http.ServerResponse, target: Target): void {
  const path = req.originalUrl ?? req.url ?? "/";
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

async function handleHub(req: Req, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && path === "/state") {
      return sendJson(res, 200, manager.state());
    }
    if (method === "POST" && path === "/servers") {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.add(body);
      return sendJson(res, 200, manager.state());
    }
    if (method === "POST" && path === "/active") {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.setActive(String(body.target ?? "local"));
      return sendJson(res, 200, manager.state());
    }
    const removeMatch = path.match(/^\/servers\/([^/]+)$/);
    if (method === "DELETE" && removeMatch) {
      manager.remove(decodeURIComponent(removeMatch[1]));
      return sendJson(res, 200, manager.state());
    }
    if (method === "PATCH" && removeMatch) {
      const body = JSON.parse((await readBody(req)) || "{}");
      manager.update(decodeURIComponent(removeMatch[1]), body);
      return sendJson(res, 200, manager.state());
    }
    const connectMatch = path.match(/^\/servers\/([^/]+)\/connect$/);
    if (method === "POST" && connectMatch) {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      await manager.connect(decodeURIComponent(connectMatch[1]), parseAuth(body));
      return sendJson(res, 200, manager.state());
    }
    const disconnectMatch = path.match(/^\/servers\/([^/]+)\/disconnect$/);
    if (method === "POST" && disconnectMatch) {
      await manager.disconnect(decodeURIComponent(disconnectMatch[1]));
      return sendJson(res, 200, manager.state());
    }
    const restartMatch = path.match(/^\/servers\/([^/]+)\/restart$/);
    if (method === "POST" && restartMatch) {
      await manager.restart(decodeURIComponent(restartMatch[1]));
      return sendJson(res, 200, manager.state());
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
      state: manager.state(),
    });
  }
}

export function hubPlugin(): Plugin {
  return {
    name: "npzview-hub",
    configureServer(server) {
      // Registered here (not in a returned function) so these run BEFORE Vite's
      // internal SPA-fallback middleware and never fall through to index.html.
      server.middlewares.use("/__hub", (req, res) => {
        void handleHub(req as Req, res);
      });
      server.middlewares.use("/api", (req, res) => {
        proxyApi(req as Req, res, manager.activeTarget());
      });
      server.httpServer?.once("close", () => manager.shutdown());
    },
  };
}
