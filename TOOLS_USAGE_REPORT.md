# Hybrid Vision MCP Server — Tool Usage Report

**Server:** `hybrid-vision-mcp` v1.0.0  
**Protocol:** Model Context Protocol (MCP) over Streamable HTTP / SSE  
**Transport Endpoints:** `POST /mcp`, `GET /sse`, `POST /messages`  
**Runtime:** Node.js 18+ (ESM), Express 5, `@modelcontextprotocol/sdk` ^1.29.0

---

## 1. Image Input Constraint (CRITICAL)

All tools accept image input via the `image_source` (or `image_sources`) parameter.  
**Allowed formats:**

- **Base64 Data URI:** `data:image/png;base64,<BASE64_STRING>`
- **HTTP/HTTPS URL:** e.g. `https://example.com/image.png`
- **`file://` URI** → resolved to a local path on the **server host**
- **Local filesystem path** → works only if the MCP server and client share a filesystem

> **REMOTE HOST RULE:** The MCP Vision Server runs on a REMOTE host. Local filesystem paths (e.g. `/tmp/...`, `C:\...`, `~/...`) are **not** visible to the server unless they exist on the server host. Transmit images as **Base64 Data URIs** or **HTTP URLs**.

---

## 2. Input Resolution Pipeline (`resolveImageToBuffer`)

The server resolves a string input to a binary image buffer through a **6-stage fallback**:

1. **Data URI** (`data:image/...`) — sanitizes whitespace, URI-decodes, validates magic bytes.
2. **`file://` URI** — converts to a local path via `fileURLToPath`.
3. **`~/` expansion** — home-directory expansion.
4. **HTTP(S) URL** — fetches with custom `User-Agent`, validates `Content-Type`, checks magic bytes.
5. **Local filesystem path** — `fs.readFileSync` if file exists on server host.
6. **Pure Base64 fallback** — if string length > 50, attempts Base64 decode and magic-byte validation.

**Magic-byte validation** (`isSupportedImageBuffer`) supports: PNG, JPEG, GIF, WEBP, BMP.

**Format normalization** (`normalizeToPngBuffer`): All images are converted to PNG via `sharp(buffer).toFormat("png")` before OCR or AI analysis to ensure compatibility.

---

## 3. Tool Specifications

### 3.1 `fast_ocr_tesseract`

**Description:** Fast CPU-based WebAssembly OCR extraction for text in images.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI or HTTP URL. |
| `language` | string | No | `"eng"` | Language code (ISO 639-3), e.g. `"eng"`, `"spa"`, `"fra"`. |

**Backend:** Tesseract.js (WebAssembly), shipped with `eng.traineddata` (5 MB).

**Returns:** A text block:
```
[Tesseract OCR Engine - Language: {lang} - Confidence: {confidence}%]

{extracted_text || "(No text detected)"}
```

**Usage Notes:**
- The `language` parameter accepts any Tesseract-trained language code. Additional `.traineddata` files must be installed if using non-English languages.
- Confidence is reported as a percentage (0–100).

---

### 3.2 `preprocess_and_crop`

**Description:** Computer vision image preprocessing (crop, grayscale, sharpen) using Sharp.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI or HTTP URL. |
| `crop` | object | No | — | Crop region: `{ left, top, width, height }` (all numbers). |
| `grayscale` | boolean | No | — | Apply grayscale filter. |
| `sharpen` | boolean | No | — | Apply sharpen filter. |

**Crop Validation Rules** (enforced before processing):
- `left`, `top` must be ≥ 0.
- `width`, `height` must be > 0.
- Crop origin (`left`, `top`) must be within image dimensions.
- Crop region must not exceed image boundaries.

**Errors (invalid crop):**
- `"Crop dimensions must be positive numbers."`
- `"Crop region starts outside the image boundaries."`
- `"Crop region exceeds image boundaries."`

**Returns:** A text block:
```
Image preprocessed successfully. Output Base64 data (length: {base64_length} chars).
Data URI: data:image/png;base64,{first_100_chars_of_base64}...
```

**Usage Notes:**
- All three filters (crop, grayscale, sharpen) can be combined.
- Output is always PNG format.
- Only the first 100 characters of the Base64 payload are shown in the response. To retrieve the full image, the client must reconstruct or request the full buffer via other means.

---

### 3.3 `analyze_image`

**Description:** Analyze image contents or extract context using local Ollama Vision Models.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI or HTTP URL. |
| `prompt` | string | No | `"Describe this image in detail."` | Question or instruction for analyzing the image. |
| `model` | string | No | `VISION_MODEL_FAST` (`"llava:13b"`) | Optional Ollama vision model override. |

**Backend:** Ollama `/api/generate` (stream: false). Default model: `llava:13b`.

**Returns:** Raw text response from the Ollama vision model (e.g. `data.response`).

**Usage Notes:**
- The model can be overridden per-call or globally via the `VISION_MODEL_FAST` environment variable.
- Ollama must be running locally (`OLLAMA_HOST`, default `http://localhost:11434`) with the model pulled.
- Often used for fast, general-purpose image understanding (captions, descriptions, object identification).

---

### 3.4 `find_text_element`

**Description:** Locate specific text, UI elements, or objects visually within an image.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_source` | string | **Yes** | — | Base64 Data URI or HTTP URL. |
| `query` | string | **Yes** | — | Target text or element to locate. |
| `model` | string | No | `VISION_MODEL_HEAVY` (`"qwen3-vl:30b"`) | Optional Ollama vision model override. |

**Backend:** Ollama `/api/generate` (stream: false). Default model: `qwen3-vl:30b`.

**Returns:** Raw text response from the Ollama vision model describing bounding-box coordinates or visual position.

**Internal Prompt:**
```
Locate the element or text matching: "{query}". Provide the bounding box coordinates or visual position within the image.
```

**Errors:**
- `"Parameter 'query' is required."` (if query is empty/missing)

**Usage Notes:**
- Designed for precision tasks (finding buttons, text labels, UI components).
- Heavier model default ensures better spatial reasoning.
- The returned text is unstructured; parsing may be required to extract usable coordinates.

---

### 3.5 `compare_images`

**Description:** Compare two or more images side-by-side using local Ollama Vision Models.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_sources` | array[string] | **Yes** | — | Array of at least 2 Base64 Data URIs or HTTP URLs. |
| `prompt` | string | No | `"Compare these images in detail and highlight any differences or similarities."` | Comparison instructions. |
| `model` | string | No | `VISION_MODEL_HEAVY` (`"qwen3-vl:30b"`) | Optional Ollama vision model override. |

**Backend:** Ollama `/api/generate` (stream: false). Default model: `qwen3-vl:30b`.

**Returns:** Raw text response from the Ollama vision model comparing all provided images.

**Errors:**
- `"Parameter 'image_sources' must be an array of at least 2 image inputs."`

**Usage Notes:**
- Supports multi-image comparison (no hard upper limit enforced, practically bounded by Ollama context window).
- All images are normalized to PNG before sending.
- Heavy model is the default for better difference detection.

---

### 3.6 `check_vision_health`

**Description:** Check connectivity to local Ollama service and verify vision engines.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| — | — | — | — | **No parameters required.** |

**Backend:** HTTP `GET` to `${OLLAMA_HOST}/api/tags`.

**Returns:** A text block:
```
=== Vision MCP Health Status ===
- Ollama Service: {status}
- Installed Ollama Models: {comma-separated model names OR "None detected"}
- Tesseract OCR Engine: Ready (WebAssembly)
- Sharp CV Engine: Ready
```

**Usage Notes:**
- Use this tool first to verify environment readiness before running other tools.
- Ollama status will show `"Connected (http://localhost:11434)"` or `"Connection Error: ..."` if the service is unreachable.
- Tesseract and Sharp are always reported as `"Ready"` if the server is running.

---

## 4. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Express listener port. (README suggests `11402`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Base URL for local Ollama inference service. |
| `VISION_MODEL_FAST` | `llava:13b` | Default vision model for `analyze_image`. |
| `VISION_MODEL_HEAVY` | `qwen3-vl:30b` | Default vision model for `find_text_element` and `compare_images`. |

---

## 5. Error Handling

All tool errors are caught and returned as structured MCP responses:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error executing tool '{tool_name}': {error_message}"
    }
  ],
  "isError": true
}
```

Process-level guards (`uncaughtException`, `unhandledRejection`) are installed at server startup to prevent the Node.js process from crashing.

---

## 6. Quick-Reference Matrix

| Tool | Required Params | Optional Params | Backend | Default Model | Output Type |
|------|-----------------|-----------------|---------|---------------|-------------|
| `fast_ocr_tesseract` | `image_source` | `language` | Tesseract.js (WASM) | N/A | Text (OCR + confidence) |
| `preprocess_and_crop` | `image_source` | `crop`, `grayscale`, `sharpen` | Sharp (libvips) | N/A | Text (Base64 preview) |
| `analyze_image` | `image_source` | `prompt`, `model` | Ollama Vision API | `llava:13b` | Text (model response) |
| `find_text_element` | `image_source`, `query` | `model` | Ollama Vision API | `qwen3-vl:30b` | Text (bounding box / position) |
| `compare_images` | `image_sources` (≥2) | `prompt`, `model` | Ollama Vision API | `qwen3-vl:30b` | Text (comparison) |
| `check_vision_health` | — | — | HTTP GET (Ollama) | N/A | Text (health report) |

---

## 7. Example Invocation

### Fast OCR
```json
{
  "image_source": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "language": "eng"
}
```

### Find Text Element
```json
{
  "image_source": "https://example.com/screenshot.png",
  "query": "Submit button",
  "model": "llava:13b"
}
```

### Compare Images
```json
{
  "image_sources": [
    "data:image/png;base64,....",
    "https://example.com/v2.png"
  ],
  "prompt": "List all visual differences between these screenshots."
}
```

---
*Generated from source: `/home/sameer/Public/Shared/Work/Services/MCP/hybrid-vision-mcp/index.js` (557 lines).*
