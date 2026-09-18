// Remote bash/python snippets executed over ssh2 exec.
// Paths and ports are passed via NPZVIEW_DIR / NPZVIEW_PORT env (JSON-quoted).

export function envPrefix(remoteDir: string, remotePort: number): string {
  return `PYTHONUNBUFFERED=1 NPZVIEW_DIR=${JSON.stringify(remoteDir)} NPZVIEW_PORT=${Number(remotePort)}`;
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

export const HEALTH_PY = `import json, os, urllib.error, urllib.request
port = int(os.environ["NPZVIEW_PORT"])
url = "http://127.0.0.1:%d/api/health" % port
try:
    with urllib.request.urlopen(url, timeout=2.5) as resp:
        body = resp.read().decode("utf-8", "replace")
        print(json.dumps({"kind": "http", "status": int(resp.status), "body": body[:4000]}))
except urllib.error.HTTPError as err:
    body = err.read().decode("utf-8", "replace")
    print(json.dumps({"kind": "http", "status": int(err.code), "body": body[:4000]}))
except Exception as err:
    msg = str(err)
    refused = isinstance(err, ConnectionRefusedError) or "111" in msg or "10061" in msg or "refused" in msg.lower()
    print(json.dumps({"kind": "refused" if refused else "blocked", "detail": msg}))
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
venv_py() {
  if [ -x .venv/bin/python ]; then echo .venv/bin/python
  elif [ -x .venv/bin/python3 ]; then echo .venv/bin/python3
  else echo ""
  fi
}
print_venv_help() {
  echo "NPZVIEW_VENV_REQUIRED"
  echo "远端还没有可用的虚拟环境（需要 $NPZVIEW_DIR/.venv/bin/python）。"
  echo "系统 python3 -m venv 经常缺 ensurepip，不必 apt 装 python3-venv。"
  echo "请 SSH 到这台机器，用你手头任意带 pip 的 Python 自行创建，然后回到本界面再点「连接」："
  echo "  <任意python> -m venv $NPZVIEW_DIR/.venv"
  echo "例如："
  echo "  python3 -m venv $NPZVIEW_DIR/.venv"
  echo "  conda create -y -p $NPZVIEW_DIR/.venv python=3.13"
  echo "  uv venv --python 3.13 $NPZVIEW_DIR/.venv"
  echo "若已有残缺的 .venv，先删掉再建："
  echo "  rm -rf $NPZVIEW_DIR/.venv"
  echo "建好后确认："
  echo "  $NPZVIEW_DIR/.venv/bin/python --version"
}
VENV_PY="$(venv_py)"
if [ -z "$VENV_PY" ]; then
  echo "创建 venv…"
  if ! "$PY" -m venv .venv; then
    print_venv_help
    exit 4
  fi
  VENV_PY="$(venv_py)"
fi
[ -n "$VENV_PY" ] || { print_venv_help; exit 4; }
echo "使用 $VENV_PY ($("$VENV_PY" --version 2>&1))"
deps_ok() {
  "$VENV_PY" -c "import fastapi, uvicorn, numpy, PIL, pydantic, pydantic_settings, orjson, imageio_ffmpeg" >/dev/null 2>&1
}
if deps_ok; then
  echo "依赖已就绪，跳过 pip"
else
  if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
    echo "已有 .venv，但这个解释器没有 pip，且现有依赖不完整。"
    print_venv_help
    exit 4
  fi
  echo "安装 Python 依赖…"
  if ! "$VENV_PY" -m pip install -r requirements.txt; then
    if deps_ok; then
      echo "pip 未完成，但现有依赖可导入，继续启动"
    else
      echo "安装依赖失败（常见原因：远端访问 PyPI 不通）。请在这台机器上手动 pip 后再连接；若后端已经在跑，下次会直接复用，不会再走安装。"
      exit 5
    fi
  fi
fi
echo "启动后端…"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" "cd '$(pwd)/backend' && '$(pwd)/$VENV_PY' -m app.main --host 127.0.0.1 --port $PORT"
  echo "backend started via tmux on 127.0.0.1:$PORT session=$SESSION"
else
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  cd backend
  nohup "../$VENV_PY" -m app.main --host 127.0.0.1 --port "$PORT" > "../$LOGFILE" 2>&1 &
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
