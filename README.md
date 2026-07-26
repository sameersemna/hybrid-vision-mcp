# Hybrid Vision MCP Server

A Model Context Protocol (MCP) server that exposes vision capabilities over HTTP, SSE, and Streamable HTTP transports. It bridges local vision engines—Tesseract.js (WASM OCR) and Sharp (image preprocessing)—with local Ollama vision models for image analysis, comparison, text localization, and browser screenshot analysis/annotation.

## Features

- **MCP Standard Compliance**: Exposes tools via `@modelcontextprotocol/sdk` v1.29.0 using Streamable HTTP and SSE transports.
- **Multi-Transport Support**: Works with `/mcp` (streamable HTTP), `/sse` (legacy SSE), and `/messages` endpoints.
- **Local-First Vision Stack**:
  - **OCR**: Fast CPU-based Tesseract.js WebAssembly engine (shipped with `eng.traineddata`).
  - **Preprocessing**: Sharp-powered crop, grayscale, and sharpen filters with boundary validation; returns full Base64 PNG via proper MCP `image` content blocks.
  - **AI Analysis**: Local Ollama vision models for description, comparison, element localization, rich browser screenshot analysis, visual diff, UI element detection, textual visual feedback generation, and semantic page extraction.
  - **Annotation Engine**: SVG-based overlay system for rendering labels, bounding boxes, arrows, and circles on images, returned as annotated PNGs.
  - **Repository Analysis**: Structural repo mapping via Graphviz DOT and JSON outputs for deep codebase understanding.
- **Flexible Image Input**: Accepts Base64 Data URIs, HTTP(S) URLs, `file://` URIs, local filesystem paths, `upload://` references, and direct file uploads via `/upload`.
- **Structured Responses**: Tools return JSON metadata in text blocks and full image data in `image` content blocks per MCP spec. Large output images are saved to disk and referenced by path to reduce payload bloat.
- **Hardened Upload Endpoint**: Binary image upload via `/upload` with MIME validation, magic-number verification, rate limiting, CORS support, and automatic cleanup of stale files.
- **Client Automation**: `upload-helper.js` automates the upload-then-reference flow for programmatic MCP clients.

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

The server loads configuration from environment variables. You can set them in three ways (listed in precedence order, highest first):

1. **Shell environment** — exported before `node index.js`
2. **`.env` file** — a file named `.env` in the project root is loaded automatically at startup (values only apply if not already set in the shell)
3. **Code defaults** — hardcoded fallbacks in `index.js`

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `11402` | Express listener port. |
| `OLLAMA_HOST` | `http://localhost:11434` | Base URL for the local Ollama inference service. |
| `OLLAMA_TIMEOUT_MS` | `180000` | Timeout for Ollama vision requests in milliseconds. |
| `MCP_REQUEST_TIMEOUT_MS` | `300000` | Timeout for MCP client request/response in milliseconds. Heavy vision tools may exceed the default 60s SDK timeout; set this to match or exceed `OLLAMA_TIMEOUT_MS`. |
| `VISION_MODEL_FAST` | `llava:13b` | Default vision model for `analyze_image` and `detect_ui_elements`. |
| `VISION_MODEL_HEAVY` | `qwen3-vl:30b` | Default vision model for `find_text_element`, `compare_images`, `browser_screenshot_analysis`, `visual_diff`, and `detect_ui_elements`. |
| `UPLOAD_DIR` | `/tmp/hvm-uploads` | Directory for temporary binary image uploads. |
| `FEEDBACK_DIR` | `/tmp/hvm-feedback` | Directory for saved output images (annotations, diffs, overlays). |
| `DOWNLOAD_DIR` | `./tmp/hvm-downloads` | Directory for downloaded images from URLs (via `download_image` tool or transparent URL resolution). |
| `MAX_UPLOAD_SIZE_MB` | `20` | Maximum upload size in megabytes. |
| `MAX_DOWNLOAD_SIZE_MB` | `50` | Maximum download size in megabytes for URL-based image downloads. |
| `UPLOAD_RATE_LIMIT` | `10` | Maximum upload requests per minute per client IP. |
| `CORS_ORIGINS` | *(empty = allow all)* | Comma-separated list of allowed CORS origins for the `/upload` endpoint. |
| `ALLOWED_REPO_ROOTS` | *(server's own project directory)* | Comma-separated list of absolute directory paths that `generate_repo_graph` is permitted to walk. Prevents unauthenticated clients from enumerating the entire host filesystem. |

## Running the Server

```bash
# With .env file (recommended)
cp .env.example .env
# edit .env to suit your setup, then:
node index.js

# Or with inline environment variables:
PORT=11402 VISION_MODEL_FAST="llava:13b" VISION_MODEL_HEAVY="qwen3-vl:30b" node index.js
```

The server listens on `0.0.0.0` and exposes:

- **Health**: `GET http://localhost:<PORT>/health`
- **Streamable HTTP (MCP)**: `POST http://localhost:<PORT>/mcp`
- **Legacy SSE**: `GET http://localhost:<PORT>/sse` + `POST http://localhost:<PORT>/messages`
- **Image Upload**: `POST http://localhost:<PORT>/upload` (binary body, returns `upload://<filename>` reference)

If the default port `11402` is occupied by another service, set a custom port via the `PORT` environment variable:

```bash
PORT=3001 node index.js
```

Then point your MCP client configuration to the same port.

## Direct Image Upload Workflow

To avoid the ~33% size overhead and token cost of Base64 encoding, upload images directly to the `/upload` endpoint and pass the returned `upload://` reference to any tool.

### Step 1: Upload the image

```bash
curl -X POST http://localhost:11402/upload \
  --data-binary @screenshot.png \
  -H "Content-Type: image/png"
```

**Response**:
```json
{
  "uploadRef": "upload://<uuid>.png",
  "filename": "<uuid>.png",
  "mimeType": "image/png",
  "size": 5242880,
  "width": 1920,
  "height": 1080
}
```

### Step 2: Pass the reference to a tool

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_image",
    "arguments": {
      "image_source": "upload://<uuid>.png",
      "prompt": "Describe this screenshot."
    }
  }
}
```

### Step 3: Retrieve output images from disk

Tools that produce large output images (`preprocess_and_crop`, `browser_screenshot_annotation`, `detect_ui_elements`, `visual_diff`) save results to `FEEDBACK_DIR` and include an `output_file_path` (or `diff_file_path`, `overlay_file_path`) in the JSON response. Clients can read the binary directly instead of parsing Base64 from the MCP response.

### Upload Rules

- **Max size**: 20 MB (configurable via `MAX_UPLOAD_SIZE_MB`).
- **Allowed types**: PNG, JPEG, WEBP, GIF, BMP.
- **Validation**: Magic-number verification ensures the file content matches the declared MIME type.
- **Rate limit**: 10 uploads per minute per IP (configurable via `UPLOAD_RATE_LIMIT`).
- **Cleanup**: Uploads are automatically deleted after 15 minutes. Feedback files follow the same TTL.

## MCP SDK Request Timeout

Heavy vision tools (`analyze_image`, `browser_screenshot_analysis`, `detect_ui_elements`, `find_text_element`, `compare_images`) rely on local Ollama vision models that may take longer than the MCP SDK's default 60-second request timeout to process large images.

**Symptom**: MCP error `-32001: Request timed out` when calling heavy vision tools.

**Solution**: Pass a `timeout` option to `client.callTool()` that matches or exceeds `OLLAMA_TIMEOUT_MS`:

```javascript
const result = await client.callTool(
  { name: "analyze_image", arguments: { image_source: url, prompt: "..." } },
  undefined,
  { timeout: 300000 }  // 5 minutes
);
```

The `upload-helper.js` library accepts an optional `requestTimeout` parameter in its constructor. When set, it automatically passes the timeout to every `callTool` and `callToolConnected` invocation:

```javascript
const helper = new MCPUploadHelper("http://localhost:11402", 300000);
```

The `MCP_REQUEST_TIMEOUT_MS` environment variable can be used to configure this value. See the [Environment Variables](#environment-variables) table above.

## File Input Schema Annotations

All image-accepting tools now declare their input fields with `x-mcp-file` annotations in the tool schema. This signals to MCP clients that the field accepts file uploads, enabling native file-picker UI where supported.

Example schema excerpt for `analyze_image`:

```json
{
  "name": "analyze_image",
  "inputSchema": {
    "type": "object",
    "properties": {
      "image_source": {
        "type": "string",
        "description": "Image to analyze. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
        "x-mcp-file": true,
        "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"]
      }
    },
    "required": ["image_source"]
  }
}
```

Tools annotated with `x-mcp-file`:
- `fast_ocr_tesseract`
- `preprocess_and_crop`
- `analyze_image`
- `find_text_element`
- `compare_images`
- `browser_screenshot_analysis`
- `browser_screenshot_annotation`
- `detect_ui_elements`
- `visual_diff`
- `textual_visual_feedback`

> **Note**: `x-mcp-file` is a non-standard extension aligned with the MCP File Uploads Working Group's SEP-2356 direction. Existing clients ignore unknown schema properties, so this is fully backward-compatible.

## Client Helper Library

`upload-helper.js` automates the upload-then-reference flow for Node.js MCP clients. It detects `File`, `Blob`, `ArrayBuffer`, `Buffer`, or string inputs; uploads binary data to `/upload`; and replaces the argument with an `upload://` reference before calling the tool.

### Usage

```javascript
import { MCPUploadHelper } from "./upload-helper.js";

const helper = new MCPUploadHelper("http://localhost:11402");

// One-shot tool call with automatic upload
const result = await helper.callTool("analyze_image", {
  image_source: "/path/to/local/screenshot.png",
  prompt: "Describe this screenshot.",
});
console.log(result.content[0].text);

// Batch upload for multi-image tools
const comparison = await helper.callTool("compare_images", {
  image_sources: ["/tmp/before.png", "/tmp/after.png"],
  prompt: "List all visual differences.",
});

// Reusable connected session
const client = await helper.connect();
await helper.callToolConnected("fast_ocr_tesseract", {
  image_source: "data:image/png;base64,...",
  language: "eng",
});
await helper.close();
```

See `client-example.js` for runnable demonstrations.

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

**Returns**: JSON metadata with `output_file_path` pointing to the saved PNG, plus an `image` content block with Base64 data.

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
| `image_sources` | array[string] | **Yes** | — | Array of image inputs. Each accepts Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `prompt` | string | No | `"Compare these images in detail and highlight any differences or similarities."` | Comparison instructions. |
| `model` | string | No | `VISION_MODEL_HEAVY` | Optional Ollama vision model override. |

> **CRITICAL**: `image_sources` MUST be a raw JSON array of strings. Do NOT pass a single stringified array.

**Returns**: Raw text response from the Ollama vision model comparing all provided images.

---

### 7. `browser_screenshot_analysis`

Perform high-level visual and semantic analysis of a browser screenshot or UI image. Generates a rich description of layout, components, visual hierarchy, colors, typography, spacing, and overall design "vibe" to help agents understand the current UI state without manual inspection.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `focus` | string | No | `"all"` | Analysis focus: `all`, `layout`, `components`, `accessibility`, `design`, or `content`. |
| `detail_level` | string | No | `"standard"` | Level of detail: `brief`, `standard`, or `detailed`. |
| `model` | string | No | `VISION_MODEL_HEAVY` | Optional Ollama vision model override. |

**Returns**: Structured text summary prefixed with analysis metadata.

---

### 8. `browser_screenshot_annotation`

Annotate a screenshot or image with text labels, bounding boxes, arrows, or circles to highlight specific UI components, regions of interest, or action targets.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `annotations` | array[object] | **Yes** | — | Array of annotation objects (see schema below). |
| `return_base64` | boolean | No | `true` | If true, appends an `image` content block with the full annotated Base64 PNG. If false, returns only a JSON metadata text block. |

**Annotation Object Schema**:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | **Yes** | — | `label`, `box`, `arrow`, or `circle`. |
| `text` | string | Conditional | — | Text content for `label` annotations. |
| `x` | number | Conditional | — | X coordinate (pixels). |
| `y` | number | Conditional | — | Y coordinate (pixels). |
| `width` | number | Conditional | — | Width (box) or radius (circle) in pixels. |
| `height` | number | Conditional | — | Height (box) in pixels. |
| `target_x` | number | Conditional | — | Target X for arrow endpoint. |
| `target_y` | number | Conditional | — | Target Y for arrow endpoint. |
| `color` | string | No | `#FF0000` | Hex color code. |
| `font_size` | number | No | `16` | Font size in pixels for labels. |

**Returns** (default `return_base64=true`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"format\": \"image/png\", \"output_file_path\": \"/tmp/hvm-feedback/...\", \"data_uri_length\": 123456, \"data_uri\": \"data:image/png;base64,...\" }"
    },
    { "type": "image", "data": "<base64_png>", "mimeType": "image/png" }
  ]
}
```

---

### 9. `visual_diff`

Compare two screenshots and highlight visual changes between them. Generates a pixel-level diff image that colors changed regions, and optionally an AI-generated description of what differs between the `before` and `after` states.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_sources` | array[2 strings] | **Yes** | — | Array of exactly 2 images: [before, after]. |
| `threshold` | number | No | `15` | Minimum combined RGB delta to mark a pixel as changed (0-255). Lower values catch subtle changes. |
| `highlight_color` | string | No | `#FF00FF` | Hex color for changed pixels in the diff image. |
| `analyze` | boolean | No | `true` | If true, includes an Ollama Vision description of the differences. |

**Returns**: JSON metadata with `diff_file_path` pointing to the saved PNG, plus an `image` content block with Base64 data.

---

### 10. `detect_ui_elements`

Detect UI components and interactive elements in a screenshot using a vision model. Returns structured element descriptions with approximate bounding boxes and an optional overlay visualization.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `element_types` | array[string] | No | all common UI elements | Filter to specific types: `button`, `input`, `link`, `card`, `navigation`, `modal`, `dropdown`, `checkbox`, `radio`, `table`, `list`, `icon`, `heading`. |
| `return_overlay` | boolean | No | `false` | If true, attempts to overlay detected elements as green bounding boxes on the image. |
| `model` | string | No | `VISION_MODEL_HEAVY` | Optional Ollama vision model override. |

**Returns** (default `return_overlay=false`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"detection\": \"Buttons: [x=...], Inputs: [x=...]\" }"
    }
  ]
}
```

**Returns** (when `return_overlay=true`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"detection\": \"...\", \"overlay_data_uri\": \"data:image/png;base64,...\", \"overlay_file_path\": \"/tmp/hvm-feedback/...\" }"
    },
    { "type": "image", "data": "<base64_png>", "mimeType": "image/png" }
  ]
}
```

---

### 11. `textual_visual_feedback`

Generate a concise feedback object in JSON format integrating a screenshot, DOM tree, CSS styles, and OCR-derived text data. The screenshot is saved to a local file to avoid context window overflow, and only metadata plus the file path are returned.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI, HTTP URL, local path, or `upload://<filename>`. |
| `dom_fragment` | string | No | `""` | Optional HTML DOM fragment as string to include in feedback. |
| `css_snapshot` | string | No | `""` | Optional CSS styles as string to include in feedback. |
| `include_ocr` | boolean | No | `true` | If true, run OCR on the screenshot to extract text. |
| `ocr_language` | string | No | `eng` | OCR language code (e.g. `eng`, `spa`). |

**Returns**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"timestamp\": \"2024-...\", \"screenshot\": { \"mime_type\": \"image/png\", \"width\": 800, \"height\": 600, \"data_uri_length\": 954504, \"file_path\": \"/tmp/hvm-feedback/1700000000000-abc.png\" }, \"ocr\": { \"enabled\": true, \"confidence\": 85, \"text\": \"...\" }, \"dom\": { \"provided\": true, \"fragment_length\": 42 }, \"css\": { \"provided\": false } }"
    }
  ]
}
```

---

### 12. `extract_semantic_page`

Extract structured semantic layout from HTML using DomDistiller-inspired algorithms. Produces a structured Control Map with headings, navigation, content blocks, forms, tables, and other semantic elements.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `html_content` | string | **Yes** | — | HTML content as string to analyze. |
| `min_text_length` | number | No | `10` | Minimum character length for text blocks to include. |
| `include_raw` | boolean | No | `false` | If true, include raw text stats in output. |

**Returns**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"control_map\": { \"title\": \"...\", \"headings\": [...], \"navigation\": {...}, \"main_content\": [...], \"lists\": [...], \"forms\": [...], \"tables\": [...], \"media\": [...], \"footer\": {...} } }"
    }
  ]
}
```

---

### 13. `generate_repo_graph`

Generate repository structural map using Graphviz DOT and JSON formats. Analyzes file tree, classifies files by extension, builds dependency-like parent-child graph for deep codebase understanding.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo_path` | string | **Yes** | — | Absolute path to repository root directory. Must be within `ALLOWED_REPO_ROOTS` (see [Environment Variables](#environment-variables)) or the call is rejected. |
| `max_depth` | number | No | `5` | Maximum directory depth to traverse. |
| `include_node_modules` | boolean | No | `false` | If true, include `node_modules` in traversal. |

**Returns**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"graph\": { \"node_count\": 42, \"edge_count\": 38, \"nodes\": [...], \"edges\": [...] } }"
    },
    {
      "type": "text",
      "text": "--- Graphviz DOT ---\ndigraph repo {\n  rankdir=TB;\n  ...\n}"
    }
  ]
}
```

---

### 14. `download_image`

Download an image from a URL into the server's `DOWNLOAD_DIR` and return a `download://` reference that can be passed to any other tool. Validates the URL, checks content-type, verifies image magic bytes, and enforces size limits.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | **Yes** | — | HTTP or HTTPS URL of the image to download. Hostname must resolve to a public IP address — loopback, RFC1918/link-local/CGNAT ranges (including cloud metadata endpoints) are rejected as an SSRF guard. This same check applies transparently whenever any tool's `image_source` is an HTTP(S) URL. |
| `filename` | string | No | auto-generated | Optional custom filename (without path). |

**Returns**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"downloadRef\": \"download://<uuid>.png\", \"file_path\": \"/abs/path/to/tmp/hvm-downloads/<uuid>.png\", \"original_url\": \"https://...\", \"mime_type\": \"image/png\", \"size\": 123456, \"width\": 800, \"height\": 600 }"
    }
  ]
}
```

**Error scenarios**:
- Invalid URL format (not http/https)
- DNS/network failure
- HTTP error (4xx/5xx)
- Wrong content-type (e.g., text/html)
- Payload does not contain valid image magic bytes
- Empty response
- File exceeds `MAX_DOWNLOAD_SIZE_MB`
```

---

## Image Input Formats

All tools accept image input through a resolution pipeline:

1. **Base64 Data URI**: `data:image/png;base64,<BASE64_STRING>`
2. **`file://` URI**: Converted to a local path on the server host.
3. **Home Directory Expansion**: `~/path` is expanded to the server's home directory.
4. **HTTP(S) URL**: Fetched, validated, and saved to `DOWNLOAD_DIR` before processing.
5. **Local Filesystem Path**: Resolved only if the file exists on the **server host** (not the client).
6. **Pure Base64 Fallback**: If the string length exceeds 50 characters, it is decoded and validated as an image.
7. **Upload Reference**: `upload://<filename>` — resolved from the server's `UPLOAD_DIR`.
8. **Download Reference**: `download://<filename>` — resolved from the server's `DOWNLOAD_DIR` (returned by the `download_image` tool).

> **Remote Host Rule**: The MCP Vision Server runs on a remote host. Local filesystem paths (e.g. `/tmp/...`, `C:\...`, `~/...`) are not visible to the server unless they exist on the server host. Transmit images as **Base64 Data URIs**, **HTTP URLs**, or **upload:// references**.

Supported formats: PNG, JPEG, GIF, WEBP, BMP.

All images are normalized to PNG via Sharp before OCR or AI analysis.

## Binary Response Streaming

To reduce MCP response payloads, tools that generate images save their output to `FEEDBACK_DIR` and include a file path in the JSON response text. The Base64 image is still included in the `image` content block for backward compatibility, but clients can switch to reading the file directly for large outputs.

| Tool | Output File Field | Description |
|------|------------------|-------------|
| `preprocess_and_crop` | `output_file_path` | Preprocessed PNG |
| `browser_screenshot_annotation` | `output_file_path` | Annotated PNG |
| `detect_ui_elements` | `overlay_file_path` | Overlay PNG (when `return_overlay=true`) |
| `visual_diff` | `diff_file_path` | Diff PNG |
| `textual_visual_feedback` | `screenshot.file_path` | Screenshot PNG |

## Testing

The project includes test scripts to validate end-to-end tool execution and edge-case handling.

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
- `browser_screenshot_analysis`: Happy path with focus/detail variants; happy path with default parameters.
- `browser_screenshot_annotation`: Happy path with label + box; edge case with empty annotations array and invalid annotation item; arrow + circle with `return_base64=false`.
- `visual_diff`: Happy path with two images and custom threshold/color; edge case with single image (minimum length check).
- `detect_ui_elements`: Happy path with no overlay; edge case with missing image_source.
- `textual_visual_feedback`: Happy path with OCR; happy path with DOM + CSS; edge case with missing image_source.
- `extract_semantic_page`: Happy path with comprehensive HTML; edge case with empty HTML.
- `generate_repo_graph`: Happy path on current repo; edge case with invalid path.

### Upload Endpoint Test

```bash
# Upload a test image
curl -X POST http://localhost:11402/upload \
  --data-binary @test-image.png \
  -H "Content-Type: image/png"

# Expected response
# {"uploadRef":"upload://<uuid>.png","filename":"<uuid>.png","mimeType":"image/png","size":5242880,"width":1920,"height":1080}
```

## Error Handling

All tool errors are caught and returned as structured MCP error responses. The server returns structured JSON inside `content[0].text` for machine-readable errors:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"error\": true, \"code\": \"INVALID_ANNOTATION\", \"message\": \"Each annotation must be an object with a 'type' field.\", \"validTypes\": [\"label\",\"box\",\"arrow\",\"circle\"], \"suggestions\": [\"Ensure 'label' annotations include 'text'\", \"Ensure coordinate fields (x, y) are numbers\"] }"
    }
  ],
  "isError": true
}
```

Agent clients can parse the JSON to auto-recover or display actionable suggestions. Simple tool execution errors fall back to the original text response with `isError: true`.

Process-level guards (`uncaughtException`, `unhandledRejection`) are installed at server startup to prevent the Node.js process from crashing unexpectedly.

## Utility Scripts

| File | Description |
|------|-------------|
| `upload-helper.js` | Client-side library automating the upload-then-reference flow. |
| `client-example.js` | Runnable examples demonstrating `upload-helper.js` usage. |
| `cleanupUploads()` | Runs every 5 minutes to delete files in `UPLOAD_DIR` older than 15 minutes. |
| `cleanupFeedback()` | Runs every 5 minutes to delete files in `FEEDBACK_DIR` older than 15 minutes. |
| `/health` | Simple Express health check returning JSON status and timestamp. |

## License

ISC
