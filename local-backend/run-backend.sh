#!/bin/zsh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 78
exec /usr/bin/env PORT="${PORT:-8788}" node server.js
