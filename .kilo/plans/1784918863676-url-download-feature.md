# URL Image Download Feature — Implementation Plan

## Goal
Enable the MCP server to download images from URLs into a configurable directory before analysis, with robust error handling and a new `download_image` MCP tool.

## Design Decisions

1. **New `download://` URI scheme** — resolves from `DOWNLOAD_DIR`, analogous to `upload://` resolving from `UPLOAD_DIR`. This lets `download_image` return a reference that all existing tools accept.
2. **Transparent persistence** — the HTTP URL branch in `resolveImageToBuffer` now saves to disk before returning the buffer. All existing tools automatically benefit.
3. **Separate directory** — `DOWNLOAD_DIR` (default `./tmp/hvm-downloads`) is distinct from `UPLOAD_DIR` to avoid mixing server-initiated downloads with client-initiated uploads.
4. **Additive only** — no existing behavior changes for base64, file paths, `upload://`, or `file://` inputs.

## Files to Modify

### 1. `index.js`
- **Config** (near line 61): Add `DOWNLOAD_DIR` (default `./tmp/hvm-downloads`, resolved to absolute path), `MAX_DOWNLOAD_SIZE_MB` (default 50)
- **New function `downloadImageToFile(url)`**:
  - Validate URL format (must be http/https)
  - Fetch with timeout + User-Agent + Accept header
  - Validate Content-Type (reject text/html, application/json)
  - Validate Content-Length against MAX_DOWNLOAD_SIZE
  - Read body, validate magic bytes via `isSupportedImageBuffer`
  - Generate unique filename (UUID + ext from content-type)
  - Save to DOWNLOAD_DIR
  - Extract width/height via sharp
  - Return `{ filePath, originalUrl, mimeType, size, width, height, downloadRef }`
- **Modify `resolveImageToBuffer` HTTP URL branch** (lines 185-215): Replace inline fetch with call to `downloadImageToFile`, then read saved file and return buffer
- **Add `download://` resolution in `resolveImageToBuffer`** (after `upload://` block, around line 228): Parse `download://<filename>`, read from DOWNLOAD_DIR, validate, return buffer
- **Add `download_image` MCP tool** in tool list and handler:
  - Input: `url` (string, required), `filename` (optional override)
  - Returns: JSON with `downloadRef`, `filePath`, `mimeType`, `size`, `width`, `height`
- **Add cleanup** for DOWNLOAD_DIR (same 15-min TTL pattern as UPLOAD_DIR)
- **Create DOWNLOAD_DIR** on startup via `fs.mkdirSync`

### 2. `.env`
- Add `DOWNLOAD_DIR=./tmp/hvm-downloads`
- Add `MAX_DOWNLOAD_SIZE_MB=50`

### 3. `.env.example`
- Add `DOWNLOAD_DIR=./tmp/hvm-downloads`
- Add `MAX_DOWNLOAD_SIZE_MB=50`

### 4. `README.md`
- Add `DOWNLOAD_DIR` and `MAX_DOWNLOAD_SIZE_MB` to env vars table
- Add `download_image` tool documentation (tool #14)
- Add `download://<filename>` to image input formats list
- Update image input formats section (add item 8)

### 5. `upload-helper.js`
- Add `download://` to `isAlreadyResolved()` check (line 31) so the helper skips upload for download references

### 6. `client-example.js`
- Add example showing `download_image` tool usage

## Error Handling Categories
| Scenario | Error Message |
|---|---|
| Invalid URL format | `Invalid URL: must start with http:// or https://` |
| DNS/Network failure | `Failed to fetch image URL: fetch failed` |
| HTTP error (4xx/5xx) | `HTTP 404: Not Found` |
| Wrong content-type | `URL returned content-type 'text/html' instead of a valid image` |
| Not an image (magic bytes) | `Fetched URL payload does not contain valid binary image headers` |
| Empty response | `Fetched image payload is empty` |
| File too large | `Downloaded image exceeds maximum size of 50MB` |
| Disk full / write error | `Failed to save downloaded image: <err>` |

## Backward Compatibility
- All existing tools, input formats, and client code continue to work unchanged
- `download://` and `download_image` are purely additive
- HTTP URL behavior now persists to disk transparently (no client-visible change)

## Validation
1. Start server, verify DOWNLOAD_DIR is created
2. Call `download_image` with a valid image URL → verify file saved to DOWNLOAD_DIR, `download://` ref returned
3. Call `analyze_image` with `download://<filename>` → verify analysis works
4. Call `analyze_image` with HTTP URL directly → verify transparent download + analysis
5. Call `download_image` with invalid URL → verify structured error response
6. Call `download_image` with HTML URL → verify content-type rejection
7. Verify cleanup removes files after 15 min
