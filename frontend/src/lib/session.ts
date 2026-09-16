const SESSION_QUERY = "session";
const HUB_SESSION_QUERY = "npzview_session";

let sessionId = readSessionFromUrl() ?? "";

function readSessionFromUrl(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get(SESSION_QUERY)?.trim();
    return id || null;
  } catch {
    return null;
  }
}

function writeSessionToUrl(id: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(SESSION_QUERY) === id) return;
  url.searchParams.set(SESSION_QUERY, id);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function getSessionId(): string {
  return sessionId;
}

export function sessionHeaders(): Record<string, string> {
  return sessionId ? { "X-Npzview-Session": sessionId } : {};
}

export function withSessionQuery(url: string): string {
  if (!sessionId) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set(HUB_SESSION_QUERY, sessionId);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export async function ensureSession(): Promise<string> {
  const existing = sessionId || readSessionFromUrl();
  try {
    const response = await fetch("/__hub/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(existing ? { "X-Npzview-Session": existing } : {}) },
      body: JSON.stringify(existing ? { id: existing } : {}),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (response.ok) {
      const id = typeof body.id === "string" && body.id ? body.id : existing;
      if (!id) throw new Error("hub did not return a session id");
      sessionId = id;
      writeSessionToUrl(id);
      return id;
    }
  } catch {
    // No hub (pure FastAPI --static-dir) or hub still starting: stay on a local id.
  }
  sessionId = existing || "default";
  writeSessionToUrl(sessionId);
  return sessionId;
}
