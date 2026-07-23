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
- **Flexible Image Input**: Accepts Base64 Data URIs, HTTP(S) URLs, `file://` URIs, local filesystem paths, and `upload://` references.
- **Structured Responses**: Tools return JSON metadata in text blocks and full image data in `image` content blocks per MCP spec.
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
| `PORT` | `11402` | Express listener port. |
| `OLLAMA_HOST` | `http://localhost:11434` | Base URL for the local Ollama inference service. |
| `VISION_MODEL_FAST` | `llava:13b` | Default vision model for `analyze_image` and `detect_ui_elements`. |
| `VISION_MODEL_HEAVY` | `qwen3-vl:30b` | Default vision model for `find_text_element`, `compare_images`, `browser_screenshot_analysis`, `visual_diff`, and `detect_ui_elements`. |
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

If the default port `11402` is occupied by another service, set a custom port via the `PORT` environment variable:

```bash
PORT=3001 node index.js
```

Then point your MCP client configuration to the same port.

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
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"format\": \"image/png\", \"data_uri_length\": 123456, \"data_uri\": \"data:image/png;base64,...\" }"
    },
    { "type": "image", "data": "<base64_png>", "mimeType": "image/png" }
  ]
}
```

**Returns** (when `return_base64=false`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"format\": \"image/png\", \"data_uri_length\": 123456, \"data_uri\": \"data:image/png;base64,...\" }"
    }
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

**Returns**: A Base64-encoded diff PNG, JSON metadata (changed pixel ratio, dimensions, threshold), and an AI description when `analyze=true`.

**Returns** (when `analyze=true`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"changed_pixels\": 12450, \"total_pixels\": 240000, \"change_ratio\": \"5.19%\", \"threshold\": 15, \"ai_description\": \"...\" }"
    },
    { "type": "image", "data": "<base64_png>", "mimeType": "image/png" }
  ]
}
```

**Returns** (when `analyze=false`):
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"success\": true, \"changed_pixels\": 12450, \"total_pixels\": 240000, \"change_ratio\": \"5.19%\", \"threshold\": 15 }"
    },
    { "type": "image", "data": "<base64_png>", "mimeType": "image/png" }
  ]
}
```

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
      "text": "{ \"success\": true, \"width\": 800, \"height\": 600, \"detection\": \"...\", \"overlay_data_uri\": \"data:image/png;base64,...\" }"
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
| `repo_path` | string | **Yes** | — | Absolute path to repository root directory. |
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
- `browser_screenshot_analysis`: Happy path with focus/detail variants; happy path with default parameters.
- `browser_screenshot_annotation`: Happy path with label + box; edge case with empty annotations array and invalid annotation item; arrow + circle with `return_base64=false`.
- `visual_diff`: Happy path with two images and custom threshold/color; edge case with single image (minimum length check).
- `detect_ui_elements`: Happy path with no overlay; edge case with missing image_source.
- `textual_visual_feedback`: Happy path with OCR; happy path with DOM + CSS; edge case with missing image_source.
- `extract_semantic_page`: Happy path with comprehensive HTML; edge case with empty HTML.
- `generate_repo_graph`: Happy path on current repo; edge case with invalid path.

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
| `cleanupUploads()` | Runs every 5 minutes to delete files in `UPLOAD_DIR` older than 15 minutes. |
| `/health` | Simple Express health check returning JSON status and timestamp. |

## License

ISC

```bash
sudo lsof -ti:11402
PORT=11402 VISION_MODEL_FAST="llava:13b" VISION_MODEL_HEAVY="qwen3-vl:30b" node index.js
```