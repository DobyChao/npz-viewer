set +e
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
