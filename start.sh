#!/bin/bash

# sudo kill -9 $(sudo lsof -ti:11402)

node_binary='/usr/local/n/versions/node/24.14.1/bin/node'
$node_binary --version

# Source .env if present (values here override the server's internal loader
# because they are set before node starts, so process.env[key] is already set
# and the server's `!process.env[key]` guard skips them).
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "Starting the server with the following environment variables:"
echo "PORT=${PORT:-11402}"
echo "VISION_MODEL_FAST=${VISION_MODEL_FAST:-llava:13b}"
echo "VISION_MODEL_HEAVY=${VISION_MODEL_HEAVY:-qwen3-vl:30b}"


echo "Deleting all files in the upload and feedback directories..."
rm -rf $UPLOAD_DIR/*
rm -rf $FEEDBACK_DIR/*

$node_binary index.js
