// Local persistence for remote-backend server profiles.
// Runs inside the Vite dev server (Node), never in the browser.
// Secrets (passwords, passphrases, private-key contents) are NEVER written here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export type AuthMethod = "agent" | "password" | "key";

export interface ConnectAuth {
  authMethod: AuthMethod;
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  user: string;
  /** SSH port. */
  port: number;
  /** Directory on the remote the backend is synced to. */
  remoteDir: string;
  /** Port the backend listens on (bound to 127.0.0.1) on the remote. */
  remotePort: number;
  /** Last auth method used. No secrets. */
  authMethod: AuthMethod;
  /** Optional private-key file path on this machine. */
  keyPath?: string;
}

export type ServerInput = Omit<ServerProfile, "id">;
export type ServerPatch = Partial<Omit<ServerProfile, "id">>;

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

function asAuthMethod(value: unknown): AuthMethod {
  return value === "password" || value === "key" ? value : "agent";
}

function normalize(input: ServerInput): ServerInput {
  const keyPath = input.keyPath?.trim();
  return {
    name: (input.name ?? "").trim() || input.host.trim(),
    host: input.host.trim(),
    user: input.user.trim(),
    port: Number(input.port) || 22,
    remoteDir: (input.remoteDir ?? "").trim() || "~/npz-viewer",
    remotePort: Number(input.remotePort) || 8756,
    authMethod: asAuthMethod(input.authMethod),
    keyPath: keyPath || undefined,
  };
}

function isProfile(item: unknown): item is ServerProfile {
  if (!item || typeof item !== "object") return false;
  const row = item as Partial<ServerProfile>;
  return typeof row.id === "string" && typeof row.host === "string";
}

function coerce(item: unknown): ServerProfile | null {
  if (!isProfile(item)) return null;
  const keyPath = typeof item.keyPath === "string" ? item.keyPath.trim() : "";
  return {
    id: item.id,
    name: typeof item.name === "string" && item.name.trim() ? item.name : item.host,
    host: item.host,
    user: typeof item.user === "string" ? item.user : "",
    port: Number(item.port) || 22,
    remoteDir: typeof item.remoteDir === "string" && item.remoteDir ? item.remoteDir : "~/npz-viewer",
    remotePort: Number(item.remotePort) || 8756,
    authMethod: asAuthMethod(item.authMethod),
    keyPath: keyPath || undefined,
  };
}

export function readServers(): ServerProfile[] {
  if (!existsSync(SERVERS_FILE)) return [];
  try {
    const payload = JSON.parse(readFileSync(SERVERS_FILE, "utf-8")) as {
      servers?: unknown;
    };
    if (!Array.isArray(payload.servers)) return [];
    return payload.servers.map(coerce).filter((row): row is ServerProfile => row !== null);
  } catch {
    return [];
  }
}

function writeServers(servers: ServerProfile[]): void {
  mkdirSync(dirname(SERVERS_FILE), { recursive: true });
  writeFileSync(SERVERS_FILE, JSON.stringify({ servers }, null, 2));
}

export function addServer(input: ServerInput): ServerProfile {
  const fields = normalize(input);
  const profile: ServerProfile = {
    id: `${slugify(fields.name || fields.host)}-${randomBytes(3).toString("hex")}`,
    ...fields,
  };
  writeServers([...readServers(), profile]);
  return profile;
}

export function updateServer(id: string, patch: ServerPatch): ServerProfile {
  const servers = readServers();
  const index = servers.findIndex((server) => server.id === id);
  if (index < 0) throw new Error("server not found");
  const current = servers[index];
  const merged = { ...current };
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.host !== undefined) merged.host = patch.host;
  if (patch.user !== undefined) merged.user = patch.user;
  if (patch.port !== undefined) merged.port = patch.port;
  if (patch.remoteDir !== undefined) merged.remoteDir = patch.remoteDir;
  if (patch.remotePort !== undefined) merged.remotePort = patch.remotePort;
  if (patch.authMethod !== undefined) merged.authMethod = patch.authMethod;
  if (patch.keyPath !== undefined) merged.keyPath = patch.keyPath;
  const next: ServerProfile = { ...normalize(merged), id };
  servers[index] = next;
  writeServers(servers);
  return next;
}

export function removeServer(id: string): void {
  writeServers(readServers().filter((server) => server.id !== id));
}

export function serversFilePath(): string {
  return SERVERS_FILE;
}
