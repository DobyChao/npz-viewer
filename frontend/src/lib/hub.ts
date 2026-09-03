// Browser client for the dev-server control plane (see frontend/hub/plugin.ts).
// Lets the UI manage remote-backend servers and pick which one serves /api.

export type ServerConnState = "idle" | "connecting" | "active" | "error";

export interface HubServer {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  remoteDir: string;
  remotePort: number;
  state: ServerConnState;
  error: string | null;
  active: boolean;
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

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const hub = {
  state: () => call<HubState>("/state"),
  add: (server: NewServer) => post<HubState>("/servers", server),
  remove: (id: string) =>
    call<HubState>(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  connect: (id: string) => post<HubState>(`/servers/${encodeURIComponent(id)}/connect`),
  disconnect: (id: string) => post<HubState>(`/servers/${encodeURIComponent(id)}/disconnect`),
  setActive: (target: string) => post<HubState>("/active", { target }),
};
