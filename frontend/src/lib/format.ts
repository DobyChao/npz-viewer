export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

export function formatTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Six significant digits, but without scientific notation for everyday magnitudes. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(3);
  return Number(value.toPrecision(6)).toString();
}

export function formatShape(shape: number[]): string {
  return `[${shape.join(", ")}]`;
}

export function formatPercent(scale: number): string {
  const percent = scale * 100;
  if (percent >= 100) return `${Math.round(percent)}%`;
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path : path.slice(0, index);
}

export interface Crumb {
  label: string;
  path: string;
}

/** Breadcrumbs from a root down to the current directory, root shown by its display name. */
export function breadcrumbs(rootPath: string, rootName: string, current: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootName, path: rootPath }];
  if (!current.toLowerCase().startsWith(rootPath.toLowerCase())) return crumbs;
  const rest = current.slice(rootPath.length).split("/").filter(Boolean);
  let cursor = rootPath;
  for (const part of rest) {
    cursor = `${cursor}/${part}`;
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}
