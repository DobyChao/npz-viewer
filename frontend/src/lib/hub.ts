// Browser client for the dev-server control plane (see frontend/hub/plugin.ts).
// Lets the UI manage remote-backend servers and pick which one serves /api.

export type ServerConnState = "idle" | "connecting" | "active" | "error";
export type AuthMethod = "agent" | "password" | "key";

export interface HubServer {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  remoteDir: string;
  remotePort: number;
  authMethod: AuthMethod;
  keyPath?: string;
  state: ServerConnState;
  error: string | null;
  active: boolean;
  reused: boolean;
  startedByUs: boolean;
  log: string[];
}

export interface HubState {
  active: string;
  localActive: boolean;
  servers: HubServer[];
}

export interface NewServer {
  name: string;
  host: string;
  user: string;
  port: number;
  remoteDir: string;
  remotePort: number;
  authMethod: AuthMethod;
  keyPath?: string;
}

export interface ConnectAuth {
  authMethod: AuthMethod;
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

export interface ServerPatch {
  name?: string;
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  remotePort?: number;
  authMethod?: AuthMethod;
  keyPath?: string;
}

const HUB = "/__hub";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HUB}${path}`, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return body as T;
}

function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return call<T>(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const hub = {
  state: () => call<HubState>("/state"),
  add: (server: NewServer) => send<HubState>("/servers", "POST", server),
  update: (id: string, patch: ServerPatch) =>
    send<HubState>(`/servers/${encodeURIComponent(id)}`, "PATCH", patch),
  remove: (id: string) =>
    call<HubState>(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  connect: (id: string, auth: ConnectAuth) =>
    send<HubState>(`/servers/${encodeURIComponent(id)}/connect`, "POST", auth),
  disconnect: (id: string) =>
    send<HubState>(`/servers/${encodeURIComponent(id)}/disconnect`, "POST"),
  restart: (id: string) =>
    send<HubState>(`/servers/${encodeURIComponent(id)}/restart`, "POST"),
  setActive: (target: string) => send<HubState>("/active", "POST", { target }),
};
