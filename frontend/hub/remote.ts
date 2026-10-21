// Shared remote probes/bootstrap used by the browser hub and native desktop.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function envPrefix(remoteDir: string, remotePort: number): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return `PYTHONUNBUFFERED=1 NPZVIEW_DIR=${quote(remoteDir)} NPZVIEW_PORT=${Number(remotePort)}`;
}

export function sessionName(port: number): string {
  return `npzview-backend-${Number(port)}`;
}

const directory = resolve(process.env.NPZVIEW_ROOT ?? resolve(process.cwd(), ".."), "scripts", "remote");
export const OWNERSHIP_PY = readFileSync(resolve(directory, "ownership_py.py"), "utf8");
export const HEALTH_PY = readFileSync(resolve(directory, "health_py.py"), "utf8");
export const KILL_OURS_PY = readFileSync(resolve(directory, "kill_ours_py.py"), "utf8");
export const OURS_FALLBACK_SH = readFileSync(resolve(directory, "ours_fallback_sh.sh"), "utf8");
export const BOOTSTRAP_SH = readFileSync(resolve(directory, "bootstrap_sh.sh"), "utf8");
export const STOP_SH = readFileSync(resolve(directory, "stop_sh.sh"), "utf8");
