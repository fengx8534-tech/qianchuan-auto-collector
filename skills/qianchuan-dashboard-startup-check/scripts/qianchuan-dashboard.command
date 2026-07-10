#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CDP_CHROME_APP="/Applications/Google Chrome.app"
CDP_URL="http://127.0.0.1:9222"
BACKEND_URL="http://127.0.0.1:8788"

cd "$PROJECT_DIR" || exit 1

echo "正在检查 CDP Chrome..."
if ! curl -sS --max-time 2 "$CDP_URL/json/version" > /dev/null 2>&1; then
  if [[ ! -d "$CDP_CHROME_APP" ]]; then
    echo "未找到 Google Chrome：$CDP_CHROME_APP"
    exit 1
  fi
  open -na "Google Chrome" --args \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/qianchuan-cdp \
    --no-first-run \
    --no-default-browser-check \
    about:blank \
    >> /tmp/qianchuan-cdp-chrome.log 2>&1

  for _ in {1..20}; do
    if curl -sS --max-time 2 "$CDP_URL/json/version" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

echo "正在检查本地后端..."
if ! curl -sS --max-time 2 "$BACKEND_URL/api/dashboard.php" > /dev/null 2>&1; then
  (
    cd "$PROJECT_DIR/local-backend" || exit 1
    nohup env PORT=8788 node server.js > /tmp/qianchuan-backend.log 2>&1 &
  )
  for _ in {1..20}; do
    if curl -sS --max-time 2 "$BACKEND_URL/api/dashboard.php" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

echo "正在执行启动自检..."
node skills/qianchuan-dashboard-startup-check/scripts/check-and-open-dashboard.js --open
