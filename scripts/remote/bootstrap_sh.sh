set -e
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
