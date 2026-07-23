# Role: Autonomous MCP Server Quality Engineer & Self-Healing Developer

## Objective
Your goal is to test, debug, and perfect the `index.js` Hybrid Vision MCP server running in this workspace. You will operate in an iterative self-healing loop: running the server, executing programmatic tests against every tool, detecting edge cases/failures, patching `index.js`, and repeating until 100% of happy path and error handling tests pass flawlessly.

---

## Workspace Context & Architecture
- **Server File:** `index.js` (Express-based MCP Server exposing vision tools via HTTP/SSE and Streamable HTTP).
- **Vision Engines:**
  - `check_vision_health`
  - `fast_ocr_tesseract`
  - `preprocess_and_crop`
  - `analyze_image`
  - `find_text_element`
  - `compare_images`
- **Network Rule:** Assume remote/distributed execution. Image sources sent to tools MUST be tested primarily via **Base64 Data URIs** (`data:image/png;base64,...`) and **HTTP URLs**.

---

## Action Plan

### Step 1: Environment & Server Management
1. Check if the MCP server is already running on port `11402`. If not, start it using `node index.js` in a background terminal.
2. Verify basic connectivity by querying `http://localhost:11402/health` or running the `check_vision_health` tool via SSE/HTTP.

### Step 2: Create a Valid Synthetic Test Suite (`test_runner.mjs`)
Create a dedicated Node.js test script using `sharp` or standard HTTP clients that generates **real binary images in memory** (never fake text files). Generate:
1. **Standard Text Image:** A 400x100 white PNG with clear black text ("HYBRID VISION TEST 123") converted to a Base64 Data URI.
2. **Multi-Object Image:** A 300x300 image containing a red rectangle and blue circle converted to a Base64 Data URI.
3. **Dual Image Pair:** Two distinct Base64 images for testing `compare_images`.

### Step 3: Comprehensive Tool Matrix Testing
Execute calls against the `/mcp` or `/sse` endpoints for each tool:

| Tool | Happy Path Test | Edge/Boundary Case Test |
| :--- | :--- | :--- |
| `check_vision_health` | Call tool | Ensure Ollama, Tesseract, and Sharp report status cleanly |
| `fast_ocr_tesseract` | Pass Base64 text image | Pass invalid/truncated Base64 string (verify graceful error) |
| `preprocess_and_crop` | Crop valid region (e.g., `left: 10, top: 10, width: 50, height: 50`) | Crop region exceeding image bounds (e.g., `width: 9000`) |
| `analyze_image` | Pass valid Base64 image + prompt | Pass empty prompt (verify default fallback) |
| `find_text_element` | Search for target text | Omit `query` parameter (verify required parameter validation) |
| `compare_images` | Pass array of 2 valid Base64 images | Pass array with only 1 image (verify minimum array length check) |

### Step 4: Self-Healing & Repair Cycle
When any tool call fails, crashes, or produces unhandled exceptions:
1. Inspect the stack trace and error payload.
2. Edit `index.js` to handle the root cause (e.g., string sanitization, input validation, Sharp bounds clamping, network timeout handling).
3. Restart `index.js`.
4. Re-run `test_runner.mjs`.

---

## Definition of Done
You may only stop when:
- All 6 MCP tools execute without crashing.
- Every edge case receives a clean, structured JSON response with `isError: true` and an informative human-readable message rather than an unhandled process crash.
- `test_runner.mjs` completes with a **100% PASS** rate summary across all happy path and edge tests.

Begin by starting `index.js` and creating `test_runner.mjs`.