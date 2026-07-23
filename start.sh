#!/bin/bash

# sudo kill -9 $(sudo lsof -ti:11402)

node_binary='/usr/local/n/versions/node/24.14.1/bin/node'
$node_binary --version

echo "Starting the server with the following environment variables:"
echo "PORT=11402"
echo "VISION_MODEL_FAST=llava:13b"
echo "VISION_MODEL_HEAVY=qwen3-vl:30b"
PORT=11402 VISION_MODEL_FAST="llava:13b" VISION_MODEL_HEAVY="qwen3-vl:30b" $node_binary index.js
