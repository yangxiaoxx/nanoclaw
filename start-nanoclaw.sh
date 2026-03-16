#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /root/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/root/nanoclaw"

# Stop existing instance if running
if [ -f "/root/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/root/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/root/nanoclaw/dist/index.js" \
  >> "/root/nanoclaw/logs/nanoclaw.log" \
  2>> "/root/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/root/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /root/nanoclaw/logs/nanoclaw.log"
