PORT=11402 VISION_MODEL_FAST="llava:13b" VISION_MODEL_HEAVY="qwen3-vl:30b" node index.js

node test-mcp.js

sudo lsof -ti:11402 | xargs kill -9