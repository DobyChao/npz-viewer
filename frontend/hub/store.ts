// Local persistence for remote-backend server profiles.
// Runs inside the Vite dev server (Node), never in the browser.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  user: string;
  /** SSH port. */
  port: number;
  /** Directory on the remote the backend is rsynced to. */
  remoteDir: string;
  /** Port the backend listens on (bound to 127.0.0.1) on the remote. */
  remotePort: number;
}

// Sits next to roots.json at the repo root. The Vite dev server's cwd is
// frontend/, so the repo root is one level up.
const SERVERS_FILE =
  process.env.NPZVIEW_SERVERS_FILE ?? resolve(process.cwd(), "..", "servers.json");

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "server";
}

export function readServers(): ServerProfile[] {
  if (!existsSync(SERVERS_FILE)) return [];
  try {
    const payload = JSON.parse(readFileSync(SERVERS_FILE, "utf-8")) as {
      servers?: unknown;
    };
    if (!Array.isArray(payload.servers)) return [];
    return payload.servers.filter((item): item is ServerProfile => {
      return (
        !!item &&
        typeof item === "object" &&
        typeof (item as ServerProfile).id === "string" &&
        typeof (item as ServerProfile).host === "string"
      );
    });
  } catch {
    return [];
  }
}

function writeServers(servers: ServerProfile[]): void {
  mkdirSync(dirname(SERVERS_FILE), { recursive: true });
  writeFileSync(SERVERS_FILE, JSON.stringify({ servers }, null, 2));
}

export function addServer(input: Omit<ServerProfile, "id">): ServerProfile {
  const profile: ServerProfile = {
    id: `${slugify(input.name || input.host)}-${randomBytes(3).toString("hex")}`,
    name: input.name.trim() || input.host,
    host: input.host.trim(),
    user: input.user.trim(),
    port: Number(input.port) || 22,
    remoteDir: input.remoteDir.trim() || "~/npz-viewer",
    remotePort: Number(input.remotePort) || 8756,
  };
  writeServers([...readServers(), profile]);
  return profile;
}

export function removeServer(id: string): void {
  writeServers(readServers().filter((server) => server.id !== id));
}

export function serversFilePath(): string {
  return SERVERS_FILE;
}
