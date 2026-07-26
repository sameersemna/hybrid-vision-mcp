import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = "http://localhost:11402";
const UPLOAD_URL = `${BASE_URL}/upload`;

async function createTextImage() {
  const svg = `<svg width="400" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="100" fill="white"/>
    <text x="10" y="50" font-family="Arial" font-size="24" fill="black">HYBRID VISION TEST 123</text>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return { dataUri: `data:image/png;base64,${base64}`, buffer: pngBuffer };
}

async function createMultiObjectImage() {
  const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="300" fill="white"/>
    <rect x="10" y="10" width="100" height="80" fill="red"/>
    <circle cx="220" cy="150" r="70" fill="blue"/>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return { dataUri: `data:image/png;base64,${base64}`, buffer: pngBuffer };
}

async function createSecondImage() {
  const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="300" fill="yellow"/>
    <circle cx="150" cy="150" r="100" fill="green"/>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return { dataUri: `data:image/png;base64,${base64}`, buffer: pngBuffer };
}

async function uploadBuffer(buf, mimeType) {
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: buf,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.uploadRef;
}

function createTransport(useStreamableHttp = false) {
  if (useStreamableHttp) {
    return new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  }
  return new SSEClientTransport(new URL(`${BASE_URL}/sse`));
}

// The MCP SDK's default per-request timeout (60s) is shorter than heavy vision tools can
// take — documented in README under "MCP SDK Request Timeout" — and became a hard requirement
// once Ollama calls were serialized (MAX_PARALLEL_OLLAMA_REQUESTS) to prevent host crashes,
// since a queued request's wait time now counts against the client-side timeout. Every test
// call gets this generous timeout by default so the suite measures real tool correctness
// instead of racing the SDK's default clock.
const TEST_CALL_TIMEOUT_MS = 300000;

async function runTest(name, fn, useStreamableHttp = false) {
  const client = new Client({ name: "test-runner", version: "1.0.0" }, { capabilities: {} });
  const transport = createTransport(useStreamableHttp);
  const originalCallTool = client.callTool.bind(client);
  client.callTool = (params, resultSchema, options) =>
    originalCallTool(params, resultSchema, { timeout: TEST_CALL_TIMEOUT_MS, ...options });
  try {
    await client.connect(transport);
    await fn(client);
    console.log(`  PASS: ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL: ${name}`, err.message);
    return false;
  } finally {
    try { await client.close(); } catch {}
    try { transport.close?.(); } catch {}
  }
}

async function main() {
  console.log("Generating synthetic test images...\n");
  const textImage = await createTextImage();
  const multiObjectImage = await createMultiObjectImage();
  const secondImage = await createSecondImage();

  const results = [];

  // ============================================================
  // SECTION 1: Upload Endpoint Tests
  // ============================================================
  console.log("== Upload Endpoint ==");
  results.push(await runTest("upload happy (PNG)", async () => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    if (!ref || !ref.startsWith("upload://")) throw new Error(`Invalid uploadRef: ${ref}`);
  }));

  results.push(await runTest("upload happy (JPEG)", async () => {
    const jpegBuf = await sharp(textImage.buffer).jpeg().toBuffer();
    const ref = await uploadBuffer(jpegBuf, "image/jpeg");
    if (!ref || !ref.startsWith("upload://")) throw new Error(`Invalid uploadRef: ${ref}`);
  }));

  results.push(await runTest("upload happy (WEBP)", async () => {
    const webpBuf = await sharp(textImage.buffer).webp().toBuffer();
    const ref = await uploadBuffer(webpBuf, "image/webp");
    if (!ref || !ref.startsWith("upload://")) throw new Error(`Invalid uploadRef: ${ref}`);
  }));

  results.push(await runTest("upload happy (GIF)", async () => {
    const gifBuf = await sharp(textImage.buffer).gif().toBuffer();
    const ref = await uploadBuffer(gifBuf, "image/gif");
    if (!ref || !ref.startsWith("upload://")) throw new Error(`Invalid uploadRef: ${ref}`);
  }));

  results.push(await runTest("upload reject invalid MIME", async () => {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: Buffer.from("not-an-image"),
    });
    if (res.status !== 415) throw new Error(`Expected 415, got ${res.status}`);
  }));

  results.push(await runTest("upload reject empty body", async () => {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
    });
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  }));

  // ============================================================
  // SECTION 2: Resolution Pipeline Tests
  // ============================================================
  console.log("\n== Resolution Pipeline ==");
  results.push(await runTest("resolve base64 Data URI", async (client) => {
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: textImage.dataUri, language: "eng" },
    });
    if (r.isError) throw new Error(`Base64 resolution failed: ${r.content[0].text}`);
  }));

  results.push(await runTest("resolve upload:// reference", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: ref, language: "eng" },
    });
    if (r.isError) throw new Error(`upload:// resolution failed: ${r.content[0].text}`);
  }));

  results.push(await runTest("resolve pure base64 (no prefix)", async (client) => {
    const rawB64 = textImage.buffer.toString("base64");
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: rawB64, language: "eng" },
    });
    if (r.isError) throw new Error(`Pure base64 resolution failed: ${r.content[0].text}`);
  }));

  results.push(await runTest("resolve truncated base64 (rejected)", async (client) => {
    const truncated = textImage.dataUri.substring(0, textImage.dataUri.length - 20);
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: truncated, language: "eng" },
    });
    if (!r.isError) throw new Error("Expected error for truncated base64");
  }));

  results.push(await runTest("resolve empty string (rejected)", async (client) => {
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: "", language: "eng" },
    });
    if (!r.isError) throw new Error("Expected error for empty string");
  }));

  results.push(await runTest("resolve non-existent upload:// (rejected)", async (client) => {
    const r = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: "upload://nonexistent.png", language: "eng" },
    });
    if (!r.isError) throw new Error("Expected error for non-existent upload://");
  }));

  // ============================================================
  // SECTION 3: Per-Tool Upload Tests
  // ============================================================
  console.log("\n== Tool: check_vision_health ==");
  results.push(await runTest("check_vision_health happy", async (client) => {
    const result = await client.callTool({ name: "check_vision_health", arguments: {} });
    const text = result.content[0]?.text || "";
    if (!text.includes("Vision MCP Health Status")) throw new Error("Missing health status header");
  }));

  console.log("\n== Tool: fast_ocr_tesseract ==");
  results.push(await runTest("fast_ocr_tesseract base64", async (client) => {
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: textImage.dataUri, language: "eng" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`OCR error: ${result.content[0].text}`);
  }));

  results.push(await runTest("fast_ocr_tesseract upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: ref, language: "eng" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`OCR upload error: ${result.content[0].text}`);
  }));

  results.push(await runTest("fast_ocr_tesseract edge (invalid base64)", async (client) => {
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: "data:image/png;base64,INVALID_truncated!!!!" },
    });
    const text = result.content[0]?.text || "";
    if (!result.isError && !text.toLowerCase().includes("error")) throw new Error("Expected error for invalid base64");
  }));

  console.log("\n== Tool: preprocess_and_crop ==");
  results.push(await runTest("preprocess_and_crop base64", async (client) => {
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: textImage.dataUri, crop: { left: 10, top: 10, width: 100, height: 40 }, grayscale: true },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Preprocess error: ${result.content[0].text}`);
  }));

  results.push(await runTest("preprocess_and_crop upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: ref, crop: { left: 10, top: 10, width: 100, height: 40 }, grayscale: true },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Preprocess upload error: ${result.content[0].text}`);
  }));

  results.push(await runTest("preprocess_and_crop output_file_path", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: ref, grayscale: true },
    });
    const text = JSON.parse(result.content[0].text);
    if (!text.output_file_path) throw new Error("Missing output_file_path");
    if (!text.output_file_size || text.output_file_size <= 0) throw new Error("Invalid output_file_size");
  }));

  results.push(await runTest("preprocess_and_crop edge (out-of-bounds crop)", async (client) => {
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: textImage.dataUri, crop: { left: 10, top: 10, width: 9000, height: 9000 } },
    });
    if (!result.isError) throw new Error("Expected error for out-of-bounds crop");
  }));

  console.log("\n== Tool: analyze_image ==");
  results.push(await runTest("analyze_image base64", async (client) => {
    const result = await client.callTool({
      name: "analyze_image",
      arguments: { image_source: textImage.dataUri, prompt: "What text is visible in this image?" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Analyze error: ${result.content[0].text}`);
  }));

  results.push(await runTest("analyze_image upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "analyze_image",
      arguments: { image_source: ref, prompt: "What text is visible in this image?" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Analyze upload error: ${result.content[0].text}`);
  }));

  console.log("\n== Tool: find_text_element ==");
  results.push(await runTest("find_text_element base64", async (client) => {
    const result = await client.callTool({
      name: "find_text_element",
      arguments: { image_source: textImage.dataUri, query: "HYBRID" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Find text error: ${result.content[0].text}`);
  }));

  results.push(await runTest("find_text_element upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "find_text_element",
      arguments: { image_source: ref, query: "HYBRID" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Find text upload error: ${result.content[0].text}`);
  }));

  console.log("\n== Tool: compare_images ==");
  results.push(await runTest("compare_images base64", async (client) => {
    const result = await client.callTool({
      name: "compare_images",
      arguments: { image_sources: [multiObjectImage.dataUri, secondImage.dataUri], prompt: "What is different?" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Compare error: ${result.content[0].text}`);
  }));

  results.push(await runTest("compare_images upload://", async (client) => {
    const ref1 = await uploadBuffer(multiObjectImage.buffer, "image/png");
    const ref2 = await uploadBuffer(secondImage.buffer, "image/png");
    const result = await client.callTool({
      name: "compare_images",
      arguments: { image_sources: [ref1, ref2], prompt: "What is different?" },
    });
    if (result.content[0]?.text.includes("Error")) throw new Error(`Compare upload error: ${result.content[0].text}`);
  }));

  console.log("\n== Tool: browser_screenshot_analysis ==");
  results.push(await runTest("browser_screenshot_analysis base64", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_analysis",
      arguments: { image_source: textImage.dataUri, focus: "layout", detail_level: "standard" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Analysis error: ${text}`);
    if (!text.includes("Browser Screenshot Analysis")) throw new Error("Missing expected header");
  }));

  results.push(await runTest("browser_screenshot_analysis upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "browser_screenshot_analysis",
      arguments: { image_source: ref, focus: "layout", detail_level: "standard" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Analysis upload error: ${text}`);
    if (!text.includes("Browser Screenshot Analysis")) throw new Error("Missing expected header");
  }));

  console.log("\n== Tool: browser_screenshot_annotation ==");
  results.push(await runTest("browser_screenshot_annotation base64", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: {
        image_source: textImage.dataUri,
        annotations: [
          { type: "box", x: 10, y: 10, width: 100, height: 50, color: "#FF0000" },
          { type: "label", text: "Header Text", x: 15, y: 40, color: "#00FF00", font_size: 14 },
        ],
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Annotation error: ${text}`);
    if (!text.includes("success")) throw new Error("Missing success marker");
    const imageBlock = result.content.find((c) => c.type === "image");
    if (!imageBlock) throw new Error("Missing image content block");
  }));

  results.push(await runTest("browser_screenshot_annotation upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: {
        image_source: ref,
        annotations: [
          { type: "box", x: 10, y: 10, width: 100, height: 50, color: "#FF0000" },
          { type: "label", text: "Header Text", x: 15, y: 40, color: "#00FF00", font_size: 14 },
        ],
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Annotation upload error: ${text}`);
    if (!text.includes("success")) throw new Error("Missing success marker");
  }));

  results.push(await runTest("browser_screenshot_annotation output_file_path", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: {
        image_source: ref,
        annotations: [{ type: "label", text: "Test", x: 5, y: 5 }],
        return_base64: false,
      },
    });
    const text = JSON.parse(result.content[0].text);
    if (!text.output_file_path) throw new Error("Missing output_file_path");
    if (!text.output_file_size || text.output_file_size <= 0) throw new Error("Invalid output_file_size");
  }));

  console.log("\n== Tool: visual_diff ==");
  results.push(await runTest("visual_diff base64", async (client) => {
    const result = await client.callTool({
      name: "visual_diff",
      arguments: {
        image_sources: [multiObjectImage.dataUri, secondImage.dataUri],
        threshold: 20,
        highlight_color: "#FF00FF",
        analyze: false,
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Visual diff error: ${text}`);
    if (!text.includes("Visual diff computed successfully")) throw new Error("Missing success message");
  }));

  results.push(await runTest("visual_diff upload://", async (client) => {
    const ref1 = await uploadBuffer(multiObjectImage.buffer, "image/png");
    const ref2 = await uploadBuffer(secondImage.buffer, "image/png");
    const result = await client.callTool({
      name: "visual_diff",
      arguments: {
        image_sources: [ref1, ref2],
        threshold: 20,
        highlight_color: "#FF00FF",
        analyze: false,
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Visual diff upload error: ${text}`);
    if (!text.includes("Visual diff computed successfully")) throw new Error("Missing success message");
  }));

  results.push(await runTest("visual_diff diff_file_path", async (client) => {
    const ref1 = await uploadBuffer(multiObjectImage.buffer, "image/png");
    const ref2 = await uploadBuffer(secondImage.buffer, "image/png");
    const result = await client.callTool({
      name: "visual_diff",
      arguments: { image_sources: [ref1, ref2], analyze: false },
    });
    const text = JSON.parse(result.content[0].text);
    if (!text.diff_file_path) throw new Error("Missing diff_file_path");
    if (!text.diff_file_size || text.diff_file_size <= 0) throw new Error("Invalid diff_file_size");
  }));

  console.log("\n== Tool: detect_ui_elements ==");
  results.push(await runTest("detect_ui_elements base64", async (client) => {
    const result = await client.callTool({
      name: "detect_ui_elements",
      arguments: { image_source: multiObjectImage.dataUri },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Detect UI error: ${text}`);
    if (!text.includes("UI elements detected")) throw new Error("Missing expected header");
  }));

  results.push(await runTest("detect_ui_elements upload://", async (client) => {
    const ref = await uploadBuffer(multiObjectImage.buffer, "image/png");
    const result = await client.callTool({
      name: "detect_ui_elements",
      arguments: { image_source: ref },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Detect UI upload error: ${text}`);
    if (!text.includes("UI elements detected")) throw new Error("Missing expected header");
  }));

  console.log("\n== Tool: textual_visual_feedback ==");
  results.push(await runTest("textual_visual_feedback base64", async (client) => {
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: { image_source: textImage.dataUri, include_ocr: true, ocr_language: "eng" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Feedback error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error("Missing success flag");
    if (!parsed.screenshot || !parsed.screenshot.file_path) throw new Error("Missing file_path");
  }));

  results.push(await runTest("textual_visual_feedback upload://", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: { image_source: ref, include_ocr: false },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Feedback upload error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error("Missing success flag");
    if (!parsed.screenshot || !parsed.screenshot.file_path) throw new Error("Missing file_path");
  }));

  // ============================================================
  // SECTION 4: Multi-Format Upload Tests
  // ============================================================
  console.log("\n== Multi-Format Upload Tests ==");
  for (const toolName of ["fast_ocr_tesseract", "preprocess_and_crop", "analyze_image", "find_text_element"]) {
    for (const fmt of ["jpeg", "webp", "gif"]) {
      results.push(await runTest(`${toolName} ${fmt} upload`, async (client) => {
        const fmtBuf = await sharp(textImage.buffer).toFormat(fmt).toBuffer();
        const mime = `image/${fmt === "jpeg" ? "jpeg" : fmt}`;
        const ref = await uploadBuffer(fmtBuf, mime);
        const result = await client.callTool({
          name: toolName,
          arguments: { image_source: ref, ...(toolName === "find_text_element" ? { query: "test" } : {}) },
        });
        if (result.isError) throw new Error(`${toolName} ${fmt} failed: ${result.content[0].text}`);
      }));
    }
  }

  // ============================================================
  // SECTION 5: Schema Annotation Tests
  // ============================================================
  console.log("\n== Schema Annotations ==");
  results.push(await runTest("x-mcp-file all 10 tools present", async (client) => {
    const { tools } = await client.listTools();
    const imageTools = tools.filter(t => {
      const props = t.inputSchema?.properties || {};
      return Object.values(props).some(v => v["x-mcp-file"] || (v.items && v.items["x-mcp-file"]));
    });
    const expected = ["fast_ocr_tesseract", "preprocess_and_crop", "analyze_image", "find_text_element",
      "compare_images", "browser_screenshot_analysis", "browser_screenshot_annotation",
      "detect_ui_elements", "visual_diff", "textual_visual_feedback"];
    const found = imageTools.map(t => t.name).sort();
    const missing = expected.filter(n => !found.includes(n));
    if (missing.length > 0) throw new Error(`Missing x-mcp-file on: ${missing.join(", ")}`);
  }));

  // ============================================================
  // SECTION 6: Streamable HTTP Transport Tests
  // ============================================================
  console.log("\n== Streamable HTTP Transport ==");
  results.push(await runTest("Streamable HTTP: list tools", async (client) => {
    const { tools } = await client.listTools();
    if (tools.length < 10) throw new Error(`Expected >=10 tools, got ${tools.length}`);
  }, true));

  results.push(await runTest("Streamable HTTP: upload:// tool call", async (client) => {
    const ref = await uploadBuffer(textImage.buffer, "image/png");
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: ref, language: "eng" },
    });
    if (result.isError) throw new Error(`Streamable HTTP upload call failed: ${result.content[0].text}`);
  }, true));

  // ============================================================
  // SECTION 7: Existing Edge-Case Tests (preserved)
  // ============================================================
  console.log("\n== Edge Cases (preserved from original) ==");
  results.push(await runTest("compare_images edge (single image)", async (client) => {
    const result = await client.callTool({
      name: "compare_images",
      arguments: { image_sources: [textImage.dataUri] },
    });
    if (!result.isError) throw new Error("Expected error for single image array");
  }));

  results.push(await runTest("visual_diff edge (single image)", async (client) => {
    const result = await client.callTool({
      name: "visual_diff",
      arguments: { image_sources: [textImage.dataUri] },
    });
    if (!result.isError) throw new Error("Expected error for single image array");
  }));

  results.push(await runTest("browser_screenshot_annotation edge (no annotations)", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: { image_source: textImage.dataUri, annotations: [] },
    });
    if (!result.isError) throw new Error("Expected error for empty annotations array");
  }));

  results.push(await runTest("browser_screenshot_annotation edge (invalid item)", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: { image_source: textImage.dataUri, annotations: [{ x: 10, y: 10 }] },
    });
    if (!result.isError) throw new Error("Expected error for invalid annotation item");
  }));

  results.push(await runTest("detect_ui_elements edge (missing image_source)", async (client) => {
    const result = await client.callTool({
      name: "detect_ui_elements",
      arguments: {},
    });
    if (!result.isError) throw new Error("Expected error for missing image_source");
  }));

  results.push(await runTest("textual_visual_feedback edge (missing image_source)", async (client) => {
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: {},
    });
    if (!result.isError) throw new Error("Expected error for missing image_source");
  }));

  // ============================================================
  // SECTION 8: Security Regression Tests (SSRF guard, repo_path allowlist, Ollama queue)
  // ============================================================
  console.log("\n== Security Regressions ==");
  results.push(await runTest("generate_repo_graph happy path (project root)", async (client) => {
    const result = await client.callTool({
      name: "generate_repo_graph",
      arguments: { repo_path: process.cwd(), max_depth: 1 },
    });
    if (result.isError) throw new Error(`generate_repo_graph on project root failed: ${result.content[0].text}`);
  }));

  results.push(await runTest("generate_repo_graph edge (path outside ALLOWED_REPO_ROOTS)", async (client) => {
    const result = await client.callTool({
      name: "generate_repo_graph",
      arguments: { repo_path: "/etc", max_depth: 1 },
    });
    if (!result.isError) throw new Error("Expected error for repo_path outside ALLOWED_REPO_ROOTS");
    if (!result.content[0].text.toLowerCase().includes("allowed repo root")) {
      throw new Error(`Expected allowlist error message, got: ${result.content[0].text}`);
    }
  }));

  results.push(await runTest("download_image edge (SSRF: loopback URL blocked)", async (client) => {
    const result = await client.callTool({
      name: "download_image",
      arguments: { url: `${BASE_URL}/health` },
    });
    if (!result.isError) throw new Error("Expected error for loopback URL (SSRF guard)");
    if (!result.content[0].text.toLowerCase().includes("internal")) {
      throw new Error(`Expected SSRF-guard error message, got: ${result.content[0].text}`);
    }
  }));

  results.push(await runTest("download_image edge (SSRF: RFC1918 literal IP blocked)", async (client) => {
    const result = await client.callTool({
      name: "download_image",
      arguments: { url: "http://10.0.0.1/image.png" },
    });
    if (!result.isError) throw new Error("Expected error for RFC1918 IP literal (SSRF guard)");
    if (!result.content[0].text.toLowerCase().includes("internal")) {
      throw new Error(`Expected SSRF-guard error message, got: ${result.content[0].text}`);
    }
  }));

  results.push(await runTest("check_vision_health reports Ollama concurrency status", async (client) => {
    const result = await client.callTool({ name: "check_vision_health", arguments: {} });
    if (result.isError) throw new Error(`check_vision_health failed: ${result.content[0].text}`);
    const text = result.content[0].text;
    if (!text.includes("Ollama Concurrency:")) {
      throw new Error(`Expected "Ollama Concurrency:" field in health output, got: ${text}`);
    }
  }));

  // ============================================================
  // REPORT
  // ============================================================
  const passed = results.filter((r) => r).length;
  const total = results.length;
  console.log("\n========================================");
  console.log(` TEST SUMMARY: ${passed}/${total} PASSED`);
  console.log("========================================");

  if (passed === total) {
    console.log("\nALL TESTS PASSED (100%)");
    process.exit(0);
  } else {
    console.log(`\n${total - passed} test(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
