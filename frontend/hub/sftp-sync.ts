// Incremental SFTP mirror of the repo onto a remote directory.
// Compares size + mtime (seconds) like rsync; skips excluded paths and never
// touches remote-only state (.venv, roots.json, pidfiles, …).
import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { Callback, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

const EXCLUDE_NAMES = new Set([
  ".git",
  ".venv",
  "frontend",
  "sample_data",
  "stress_data",
  "roots.json",
  "servers.json",
  "__pycache__",
  "_verify",
  "node_modules",
]);

export interface SyncStats {
  uploaded: number;
  skipped: number;
  deleted: number;
}

function excludedName(name: string): boolean {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (name.startsWith(".npzview-backend")) return true;
  if (name.endsWith(".pyc")) return true;
  return false;
}

export function shouldExclude(relativePath: string): boolean {
  return relativePath.split(/[/\\]/).filter(Boolean).some(excludedName);
}

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function call(fn: (cb: Callback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()));
  });
}

function callValue<T>(fn: (cb: (err: Error | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, value) => (err ? reject(err) : resolve(value)));
  });
}

async function existsDir(sftp: SFTPWrapper, dir: string): Promise<boolean> {
  try {
    const attrs = await callValue<Stats>((cb) => sftp.stat(dir, cb));
    return attrs.isDirectory();
  } catch {
    return false;
  }
}

export async function mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
  const abs = dir.startsWith("/") ? dir : `/${dir}`;
  const parts = abs.split("/").filter(Boolean);
  let acc = abs.startsWith("/") ? "" : "";
  for (const part of parts) {
    acc += `/${part}`;
    if (await existsDir(sftp, acc)) continue;
    try {
      await call((cb) => sftp.mkdir(acc, cb));
    } catch (err) {
      // Racing mkdir or already-exists from another client.
      if (!(await existsDir(sftp, acc))) throw err;
    }
  }
}

function listLocalFiles(root: string): { relative: string; local: string; size: number; mtimeSec: number }[] {
  const out: { relative: string; local: string; size: number; mtimeSec: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludedName(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = toPosix(relative(root, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = statSync(full);
        out.push({
          relative: rel,
          local: full,
          size: st.size,
          mtimeSec: Math.floor(st.mtimeMs / 1000),
        });
      }
    }
  };
  walk(root);
  return out;
}

async function listRemoteFiles(
  sftp: SFTPWrapper,
  remoteRoot: string,
): Promise<{ relative: string; remote: string; isDir: boolean }[]> {
  const out: { relative: string; remote: string; isDir: boolean }[] = [];
  const walk = async (dir: string, rel: string) => {
    let entries: FileEntryWithStats[];
    try {
      entries = await callValue<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      if (excludedName(entry.filename)) continue;
      const childRel = rel ? posix.join(rel, entry.filename) : entry.filename;
      const childPath = posix.join(dir, entry.filename);
      const isDir = entry.attrs.isDirectory();
      out.push({ relative: childRel, remote: childPath, isDir });
      if (isDir) await walk(childPath, childRel);
    }
  };
  await walk(remoteRoot, "");
  return out;
}

export async function mirror(
  sftp: SFTPWrapper,
  localRoot: string,
  remoteRoot: string,
  log?: (line: string) => void,
): Promise<SyncStats> {
  await mkdirp(sftp, remoteRoot);
  const local = listLocalFiles(localRoot);
  const localSet = new Set(local.map((file) => file.relative));
  const stats: SyncStats = { uploaded: 0, skipped: 0, deleted: 0 };

  for (const file of local) {
    const remote = posix.join(remoteRoot, file.relative);
    await mkdirp(sftp, posix.dirname(remote));
    let skip = false;
    try {
      const attrs = await callValue<Stats>((cb) => sftp.stat(remote, cb));
      if (Number(attrs.size) === file.size && Number(attrs.mtime) === file.mtimeSec) {
        skip = true;
      }
    } catch {
      skip = false;
    }
    if (skip) {
      stats.skipped += 1;
      continue;
    }
    await call((cb) => sftp.fastPut(file.local, remote, cb));
    await call((cb) => sftp.utimes(remote, file.mtimeSec, file.mtimeSec, cb));
    stats.uploaded += 1;
    log?.(`上传 ${file.relative}`);
  }

  const remote = await listRemoteFiles(sftp, remoteRoot);
  // Files first, then directories deepest-first so rmdir can succeed.
  const extra = remote.filter((entry) => !localSet.has(entry.relative) && !shouldExclude(entry.relative));
  extra.sort((a, b) => b.relative.length - a.relative.length);
  for (const entry of extra) {
    try {
      if (entry.isDir) {
        await call((cb) => sftp.rmdir(entry.remote, cb));
      } else {
        await call((cb) => sftp.unlink(entry.remote, cb));
      }
      stats.deleted += 1;
    } catch {
      // Non-empty dir or already gone — ignore.
    }
  }
  return stats;
}
