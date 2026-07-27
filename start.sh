#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-11402}"
UPLOAD_DIR="${UPLOAD_DIR:-./tmp/hvm-uploads}"
FEEDBACK_DIR="${FEEDBACK_DIR:-./tmp/hvm-feedback}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-./tmp/hvm-downloads}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js executable not found. Set NODE_BIN or ensure node is on PATH." >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  existing_pid="$(lsof -ti tcp:"$PORT" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$existing_pid" ]]; then
    echo "Stopping existing process on port $PORT (PID $existing_pid)..."
    kill "$existing_pid" 2>/dev/null || true
    sleep 1
    kill -9 "$existing_pid" 2>/dev/null || true
  fi
fi

# Source .env if present (values here override the server's internal loader
# because they are set before node starts, so process.env[key] is already set
# and the server's `!process.env[key]` guard skips them).
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

mkdir -p "$UPLOAD_DIR" "$FEEDBACK_DIR" "$DOWNLOAD_DIR"

printf 'Starting the server with the following environment variables:\n'
printf 'PORT=%s\n' "${PORT}"
printf 'VISION_MODEL_FAST=%s\n' "${VISION_MODEL_FAST:-llava:13b}"
printf 'VISION_MODEL_HEAVY=%s\n' "${VISION_MODEL_HEAVY:-qwen3-vl:30b}"

printf 'Deleting all files in the upload and feedback directories...\n'
find "$UPLOAD_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find "$FEEDBACK_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

"$NODE_BIN" --version
"$NODE_BIN" index.js
