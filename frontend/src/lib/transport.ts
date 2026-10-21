// The browser uses relative URLs. Native tabs use embedded assets and a small
// authenticated Rust data bridge; images and fetches share the same routing.
declare global {
  interface Window {
    __NPZVIEW_DESKTOP__?: { origin: string; token: string };
  }
}

export function transportUrl(path: string): string {
  const desktop = window.__NPZVIEW_DESKTOP__;
  if (!desktop) return path;
  const url = new URL(path, desktop.origin);
  url.searchParams.set("npzview_token", desktop.token);
  return url.href;
}

export function transportHeaders(): Record<string, string> {
  const desktop = window.__NPZVIEW_DESKTOP__;
  return desktop ? { "X-Npzview-Token": desktop.token } : {};
}
