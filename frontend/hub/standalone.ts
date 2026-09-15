// Portable client HTTP server: static frontend/dist + the same /__hub and /api
// hub as Vite preview, without requiring Vite or npm at runtime.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { manager } from "./manager.ts";
import { handleHub, proxyApi, type HubReq } from "./plugin.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NPZVIEW_DEV_PORT ?? 5273);
const DIST = resolve(process.env.NPZVIEW_DIST ?? resolve(process.cwd(), "dist"));

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function safeFile(urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const resolved = resolve(DIST, rel);
  const relToDist = relative(DIST, resolved);
  if (!relToDist || relToDist.startsWith("..") || relToDist.startsWith(`..${sep}`)) {
    return null;
  }
  if (relToDist.split(sep).includes("..")) return null;
  return resolved;
}

function sendFile(res: http.ServerResponse, file: string): void {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(file).pipe(res);
}

function sendIndex(res: http.ServerResponse): void {
  sendFile(res, join(DIST, "index.html"));
}

function looksLikeAsset(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? "";
  return last.includes(".");
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = (req.url ?? "/").split("?")[0] || "/";
  const file = safeFile(pathname);
  if (file && existsSync(file) && statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }
  if (!looksLikeAsset(pathname) && existsSync(join(DIST, "index.html"))) {
    sendIndex(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function onRequest(req: HubReq, res: http.ServerResponse): void {
  const raw = req.url ?? "/";
  const path = raw.split("?")[0] ?? "/";
  if (path === "/__hub" || path.startsWith("/__hub/")) {
    const rest = path.slice("/__hub".length) || "/";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    req.url = rest + query;
    void handleHub(req, res);
    return;
  }
  if (path === "/api" || path.startsWith("/api/")) {
    proxyApi(req, res, manager.activeTarget());
    return;
  }
  serveStatic(req, res);
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`缺少前端产物: ${join(DIST, "index.html")}`);
  process.exit(1);
}

const server = http.createServer((req, res) => onRequest(req as HubReq, res));
server.listen(PORT, HOST, () => {
  console.log(`UI + SSH hub on http://${HOST}:${PORT}`);
});
server.on("close", () => manager.shutdown());

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 400).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
