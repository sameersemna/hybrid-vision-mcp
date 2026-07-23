# Hybrid Vision MCP Server

A Model Context Protocol (MCP) server that exposes vision capabilities over HTTP, SSE, and Streamable HTTP transports. It bridges local vision engines—Tesseract.js (WASM OCR) and Sharp (image preprocessing)—with local Ollama vision models for image analysis, comparison, and text localization.

## Features

- **MCP Standard Compliance**: Exposes tools via `@modelcontextprotocol/sdk` v1.29.0 using Streamable HTTP and SSE transports.
- **Multi-Transport Support**: Works with `/mcp` (streamable HTTP), `/sse` (legacy SSE), and `/messages` endpoints.
- **Local-First Vision Stack**:
  - **OCR**: Fast CPU-based Tesseract.js WebAssembly engine (shipped with `eng.traineddata`).
  - **Preprocessing**: Sharp-powered crop, grayscale, and sharpen filters with boundary validation.
  - **AI Analysis**: Local Ollama vision models for description, comparison, and element localization.
- **Flexible Image Input**: Accepts Base64 Data URIs, HTTP(S) URLs, `file://` URIs, local filesystem paths, and `upload://` references.
- **Self-Healing Upload Endpoint**: Binary image upload via `/upload` with automatic cleanup of stale files.

## Prerequisites

- **Node.js** >= 18.x (ESM required)
- **Ollama** running locally (or reachable via `OLLAMA_HOST`)
- At least one vision model pulled in Ollama, e.g.:
  ```bash
  ollama pull llava:13b
  ollama pull qwen3-vl:30b
  ```

## Installation

```bash
git clone <repository-url>
cd hybrid-vision-mcp
npm install
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Express listener port. |
| `OLLAMA_HOST` | `http://localhost:11434` | Base URL for the local Ollama inference service. |
| `VISION_MODEL_FAST` | `llava:13b` | Default vision model for `analyze_image`. |
| `VISION_MODEL_HEAVY` | `qwen3-vl:30b` | Default vision model for `find_text_element` and `compare_images`. |
| `UPLOAD_DIR` | `/tmp/hvm-uploads` | Directory for temporary binary image uploads. |

## Running the Server

```bash
PORT=11402 VISION_MODEL_FAST="llava:13b" VISION_MODEL_HEAVY="qwen3-vl:30b" node index.js
```

The server listens on `0.0.0.0` and exposes:

- **Health**: `GET http://localhost:<PORT>/health`
- **Streamable HTTP (MCP)**: `POST http://localhost:<PORT>/mcp`
- **Legacy SSE**: `GET http://localhost:<PORT>/sse` + `POST http://localhost:<PORT>/messages`
- **Image Upload**: `POST http://localhost:<PORT>/upload` (binary body, returns `upload://<filename>` reference)

## Client Configuration

For MCP clients that use a `config.json` format (e.g., VS Code or Kilo MCP extensions), add:

```json
{
  "mcpServers": {
    "hybrid-vision": {
      "url": "http://localhost:11402/sse"
    }
  }
}
```

## Available Tools

### 1. `check_vision_health`

Check connectivity to the local Ollama service and verify installed vision engines.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | No parameters required. |

**Returns**: Text report with Ollama connection status, installed models, and engine readiness.

---

### 2. `fast_ocr_tesseract`

Fast CPU-based WebAssembly OCR extraction for text in images.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `language` | string | No | `"eng"` | ISO 639-3 language code (e.g. `"spa"`, `"fra"`). |

**Returns**: Extracted text with confidence score.

---

### 3. `preprocess_and_crop`

Computer vision image preprocessing using Sharp.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `crop` | object | No | — | Region to extract: `{ left, top, width, height }`. |
| `grayscale` | boolean | No | — | Apply grayscale filter. |
| `sharpen` | boolean | No | — | Apply sharpen filter. |

**Returns**: A Base64-encoded PNG preview (first 100 chars shown; re-assemble client-side for full image).

**Crop Validation**:
- `left` and `top` must be `>= 0`.
- `width` and `height` must be `> 0`.
- Crop region must be fully contained within the image boundaries.

---

### 4. `analyze_image`

Analyze image contents or extract context using local Ollama vision models.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `prompt` | string | No | `"Describe this image in detail."` | Question or instruction for analyzing the image. |
| `model` | string | No | `VISION_MODEL_FAST` | Optional Ollama vision model override. |

**Returns**: Raw text response from the Ollama vision model.

---

### 5. `find_text_element`

Locate specific text, UI elements, or objects visually within an image.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `query` | string | **Yes** | — | Target text or element to locate. |
| `model` | string | No | `VISION_MODEL_HEAVY` | Optional Ollama vision model override. |

**Returns**: Text description of the bounding-box coordinates or visual position of the target element.

---

### 6. `compare_images`

Compare two or more images side-by-side using local Ollama vision models.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_sources` | array[string] | **Yes** | — | Array of at least 2 image inputs. |
| `prompt` | string | No | `"Compare these images in detail and highlight any differences or similarities."` | Comparison instructions. |
| `model` | string | No | `VISION_MODEL_HEAVY` | Optional Ollama vision model override. |

> **CRITICAL**: `image_sources` MUST be a raw JSON array of strings. Do NOT pass a single stringified array.

**Returns**: Raw text response from the Ollama vision model comparing all provided images.

---

## Image Input Formats

All tools accept image input through a 6-stage resolution pipeline:

1. **Base64 Data URI**: `data:image/png;base64,<BASE64_STRING>`
2. **`file://` URI**: Converted to a local path on the server host.
3. **Home Directory Expansion**: `~/path` is expanded to the server's home directory.
4. **HTTP(S) URL**: Fetched with custom User-Agent; validated for image content-type and magic bytes.
5. **Local Filesystem Path**: Resolved only if the file exists on the **server host** (not the client).
6. **Pure Base64 Fallback**: If the string length exceeds 50 characters, it is decoded and validated as an image.

> **Remote Host Rule**: The MCP Vision Server runs on a remote host. Local filesystem paths (e.g. `/tmp/...`, `C:\...`, `~/...`) are not visible to the server unless they exist on the server host. Transmit images as **Base64 Data URIs** or **HTTP URLs**.

Supported formats: PNG, JPEG, GIF, WEBP, BMP.

All images are normalized to PNG via Sharp before OCR or AI analysis.

## Testing

The project includes two test scripts to validate end-to-end tool execution and edge-case handling.

### Quick Transport Test (`test-mcp.js`)

```bash
node test-mcp.js
```

Tests both Streamable HTTP (`/mcp`) and legacy SSE (`/sse`) transports with basic happy-path tool calls.

### Comprehensive Edge-Case Test Runner (`test_runner.mjs`)

```bash
node test_runner.mjs
```

Generates synthetic images in memory using Sharp and runs a full matrix of happy-path and edge-case tests:

- `check_vision_health`: Ensures Ollama, Tesseract, and Sharp report status cleanly.
- `fast_ocr_tesseract`: Happy path with valid Base64; edge case with invalid/truncated Base64.
- `preprocess_and_crop`: Happy path with valid crop + grayscale; edge case with out-of-bounds crop.
- `analyze_image`: Happy path with prompt; edge case with empty prompt (default fallback).
- `find_text_element`: Happy path with valid query; edge case with missing query.
- `compare_images`: Happy path with 2+ images; edge case with single image (minimum length check).

## Error Handling

All tool errors are caught and returned as structured MCP error responses:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error executing tool '<tool_name>': <error_message>"
    }
  ],
  "isError": true
}
```

Process-level guards (`uncaughtException`, `unhandledRejection`) are installed at server startup to prevent the Node.js process from crashing unexpectedly.

## Utility Scripts

| File | Description |
|------|-------------|
| `cleanupUploads()` | Runs every 5 minutes to delete files in `UPLOAD_DIR` older than 15 minutes. |
| `/health` | Simple Express health check returning JSON status and timestamp. |

## License

ISC
