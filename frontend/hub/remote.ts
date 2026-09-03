// Remote bash/python snippets executed over ssh2 exec.
// Paths and ports are passed via NPZVIEW_DIR / NPZVIEW_PORT env (JSON-quoted).

export function envPrefix(remoteDir: string, remotePort: number): string {
  return `NPZVIEW_DIR=${JSON.stringify(remoteDir)} NPZVIEW_PORT=${Number(remotePort)}`;
}

export function sessionName(port: number): string {
  return `npzview-backend-${Number(port)}`;
}

export const OWNERSHIP_PY = `import json, os
port = int(os.environ["NPZVIEW_PORT"])
uids = []
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(table) as fh:
            next(fh)
            for line in fh:
                parts = line.split()
                if len(parts) < 10 or parts[3] != "0A":
                    continue
                _ip, p = parts[1].rsplit(":", 1)
                if int(p, 16) != port:
                    continue
                uids.append(int(parts[7]))
    except FileNotFoundError:
        continue
print(json.dumps({"uids": uids, "me": os.getuid()}))
`;

export const KILL_OURS_PY = `import json, os, signal
port = int(os.environ["NPZVIEW_PORT"])
inodes = []
uids = []
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(table) as fh:
            next(fh)
            for line in fh:
                parts = line.split()
                if len(parts) < 10 or parts[3] != "0A":
                    continue
                _ip, p = parts[1].rsplit(":", 1)
                if int(p, 16) != port:
                    continue
                uids.append(int(parts[7]))
                inodes.append(parts[9])
    except FileNotFoundError:
        continue
me = os.getuid()
if any(uid != me for uid in uids):
    print(json.dumps({"killed": [], "skipped_other_user": True}))
    raise SystemExit(0)
want = set(inodes)
found = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        if os.stat("/proc/" + name).st_uid != me:
            continue
        for fd in os.listdir("/proc/" + name + "/fd"):
            try:
                target = os.readlink("/proc/" + name + "/fd/" + fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target.endswith("]") and target[8:-1] in want:
                found.append(pid)
                break
    except OSError:
        continue
for pid in found:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
print(json.dumps({"killed": found}))
`;

export const OURS_FALLBACK_SH = `set +e
cd "$NPZVIEW_DIR" 2>/dev/null || true
SESSION="npzview-backend-$NPZVIEW_PORT"
PIDFILE=".npzview-backend-$NPZVIEW_PORT.pid"
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  echo ours
  exit 0
fi
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo ours
    exit 0
  fi
fi
echo unknown
`;

export const BOOTSTRAP_SH = `set -e
cd "$NPZVIEW_DIR"
PORT="$NPZVIEW_PORT"
SESSION="npzview-backend-$PORT"
PIDFILE=".npzview-backend-$PORT.pid"
LOGFILE=".npzview-backend-$PORT.log"
PY=""
for c in python3.14 python3.13 python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "远端没有 python3"; exit 3; }
echo "using $PY ($($PY --version 2>&1))"
case "$($PY -c 'import sys;print(sys.version_info[1])')" in
  1[3-9]) : ;;
  *) echo "警告: 远端 Python < 3.13，视频导出会失败" ;;
esac
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv || { echo "创建 venv 失败，远端可能缺少 python venv 包"; exit 4; }
fi
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" "cd '$(pwd)/backend' && '$(pwd)/.venv/bin/python' -m app.main --host 127.0.0.1 --port $PORT"
  echo "backend started via tmux on 127.0.0.1:$PORT session=$SESSION"
else
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  cd backend
  nohup ../.venv/bin/python -m app.main --host 127.0.0.1 --port "$PORT" > "../$LOGFILE" 2>&1 &
  echo $! > "../$PIDFILE"
  echo "backend started via nohup (pid $(cat "../$PIDFILE")) on 127.0.0.1:$PORT"
fi
`;

export const STOP_SH = `set +e
cd "$NPZVIEW_DIR" 2>/dev/null || exit 0
SESSION="npzview-backend-$NPZVIEW_PORT"
PIDFILE=".npzview-backend-$NPZVIEW_PORT.pid"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
fi
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
echo "backend stop requested for port $NPZVIEW_PORT"
`;
