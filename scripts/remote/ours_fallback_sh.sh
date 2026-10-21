set +e
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
