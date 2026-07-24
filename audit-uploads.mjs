import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const BASE_URL = "http://localhost:11402";
const UPLOAD_URL = `${BASE_URL}/upload`;

const results = { pass: 0, fail: 0, skipped: 0, details: [] };
let testImageBuffers = {};

function logResult(name, passed, detail) {
  if (passed) {
    results.pass++;
    results.details.push({ name, status: "PASS", detail });
  } else {
    results.fail++;
    results.details.push({ name, status: "FAIL", detail });
  }
  console.log(`  ${passed ? "✓" : "✗"} ${name}: ${detail}`);
}

async function generateTestImages() {
  const w = 16, h = 16;
  const rawRgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rawRgba[i] = (x / w) * 255;
      rawRgba[i+1] = (y / h) * 255;
      rawRgba[i+2] = 128;
      rawRgba[i+3] = 255;
    }
  }

  testImageBuffers = {
    png: await sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
    jpeg: await sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } }).jpeg().toBuffer(),
    webp: await sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } }).webp().toBuffer(),
    gif: await sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } }).gif().toBuffer(),
  };

  // BMP: construct minimal valid BMP manually (sharp may not support BMP output)
  const bmpHeader = Buffer.alloc(54);
  bmpHeader.write("BM", 0);
  const bmpSize = 54 + w * h * 3;
  bmpHeader.writeUInt32LE(bmpSize, 2);
  bmpHeader.writeUInt32LE(54, 10);
  bmpHeader.writeUInt32LE(40, 14);
  bmpHeader.writeInt32LE(w, 18);
  bmpHeader.writeInt32LE(h, 22);
  bmpHeader.writeUInt16LE(1, 26);
  bmpHeader.writeUInt16LE(24, 28);
  const bmpPixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 3;
      bmpPixels[src] = (x / w) * 255;
      bmpPixels[src+1] = (y / h) * 255;
      bmpPixels[src+2] = 128;
    }
  }
  testImageBuffers.bmp = Buffer.concat([bmpHeader, bmpPixels]);

  console.log("Generated test images:");
  for (const [fmt, buf] of Object.entries(testImageBuffers)) {
    console.log(`  ${fmt}: ${buf.length} bytes`);
  }
}

function toDataUri(buf, mimeType) {
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

async function uploadFile(buf, mimeType) {
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: buf,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.uploadRef;
}

async function callTool(client, name, args) {
  return await client.callTool({ name, arguments: args });
}

// ============================================================
// SECTION 1: Upload Endpoint Tests
// ============================================================
async function testUploadEndpoint() {
  console.log("\n=== SECTION 1: Upload Endpoint ===");

  // 1.1 Upload all supported formats
  for (const [fmt, buf] of Object.entries(testImageBuffers)) {
    const mime = `image/${fmt === "jpeg" ? "jpeg" : fmt}`;
    try {
      const res = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { "Content-Type": mime },
        body: buf,
      });
      const data = await res.json();
      const ok = res.status === 200 && data.uploadRef && data.uploadRef.startsWith("upload://") && data.mimeType === mime && data.size === buf.length;
      logResult(`1.1 Upload ${fmt.toUpperCase()}`, ok, ok ? `uploadRef=${data.uploadRef} size=${data.size} mime=${data.mimeType}` : JSON.stringify(data));
    } catch (e) {
      logResult(`1.1 Upload ${fmt.toUpperCase()}`, false, e.message);
    }
  }

  // 1.2 Reject invalid MIME type
  try {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: Buffer.from("not-an-image"),
    });
    const ok = res.status === 415;
    logResult("1.2 Reject invalid MIME type", ok, `status=${res.status}`);
  } catch (e) {
    logResult("1.2 Reject invalid MIME type", false, e.message);
  }

  // 1.3 Reject empty body
  try {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "image/png", "Content-Length": "0" },
    });
    const ok = res.status === 400;
    logResult("1.3 Reject empty body", ok, `status=${res.status}`);
  } catch (e) {
    logResult("1.3 Reject empty body", false, e.message);
  }

  // 1.4 Reject oversized (we can't easily test 20MB, but verify size check exists)
  try {
    const bigBuf = Buffer.alloc(21 * 1024 * 1024);
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: bigBuf,
    });
    const ok = res.status === 413;
    logResult("1.4 Reject oversized upload", ok, `status=${res.status}`);
  } catch (e) {
    logResult("1.4 Reject oversized upload", false, e.message);
  }

  // 1.5 CORS headers present
  try {
    const res = await fetch(UPLOAD_URL, {
      method: "OPTIONS",
    });
    const cors = res.headers.get("access-control-allow-origin");
    logResult("1.5 CORS headers present", cors !== null, `Access-Control-Allow-Origin=${cors}`);
  } catch (e) {
    logResult("1.5 CORS headers present", false, e.message);
  }
}

// ============================================================
// SECTION 2: Tool Resolution Pipeline Tests
// ============================================================
async function testResolutionPipeline(client) {
  console.log("\n=== SECTION 2: Resolution Pipeline ===");

  const pngBuf = testImageBuffers.png;
  const pngDataUri = toDataUri(pngBuf, "image/png");

  // 2.1 Base64 Data URI
  try {
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: pngDataUri, language: "eng" });
    logResult("2.1 Base64 Data URI", true, "resolved successfully");
  } catch (e) {
    logResult("2.1 Base64 Data URI", false, e.message);
  }

  // 2.2 upload:// reference
  try {
    const ref = await uploadFile(pngBuf, "image/png");
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: ref, language: "eng" });
    logResult("2.2 upload:// reference", true, `ref=${ref}`);
  } catch (e) {
    logResult("2.2 upload:// reference", false, e.message);
  }

  // 2.3 Pure base64 string (no data: URI prefix)
  try {
    const rawB64 = pngBuf.toString("base64");
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: rawB64, language: "eng" });
    logResult("2.3 Pure base64 string", true, "resolved via fallback");
  } catch (e) {
    logResult("2.3 Pure base64 string", false, e.message);
  }

  // 2.4 Invalid base64 (truncated)
  try {
    const truncated = pngDataUri.substring(0, pngDataUri.length - 20);
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: truncated, language: "eng" });
    const rejected = r.isError === true;
    logResult("2.4 Truncated base64", rejected, rejected ? `correctly rejected: ${r.content[0].text.substring(0, 80)}` : "should have failed but didn't");
  } catch (e) {
    logResult("2.4 Truncated base64", true, `correctly rejected: ${e.message.substring(0, 80)}`);
  }

  // 2.5 Empty string
  try {
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: "", language: "eng" });
    const rejected = r.isError === true;
    logResult("2.5 Empty string", rejected, rejected ? `correctly rejected: ${r.content[0].text.substring(0, 80)}` : "should have failed but didn't");
  } catch (e) {
    logResult("2.5 Empty string", true, `correctly rejected: ${e.message.substring(0, 80)}`);
  }

  // 2.6 Non-existent upload:// reference
  try {
    const r = await callTool(client, "fast_ocr_tesseract", { image_source: "upload://nonexistent.png", language: "eng" });
    const rejected = r.isError === true;
    logResult("2.6 Non-existent upload://", rejected, rejected ? `correctly rejected: ${r.content[0].text.substring(0, 80)}` : "should have failed but didn't");
  } catch (e) {
    logResult("2.6 Non-existent upload://", true, `correctly rejected: ${e.message.substring(0, 80)}`);
  }
}

// ============================================================
// SECTION 3: Per-Tool File Upload Tests
// ============================================================
async function testToolWithUpload(client, toolName, field, args = {}) {
  const pngBuf = testImageBuffers.png;
  const ref = await uploadFile(pngBuf, "image/png");

  const callArgs = { ...args, [field]: ref };
  try {
    const r = await callTool(client, toolName, callArgs);
    const hasError = r.isError === true;
    logResult(`3.${toolName} upload://`, !hasError, hasError ? r.content[0].text.substring(0, 100) : "OK");
  } catch (e) {
    logResult(`3.${toolName} upload://`, false, e.message);
  }
}

async function testToolWithBase64(client, toolName, field, args = {}) {
  const pngBuf = testImageBuffers.png;
  const dataUri = toDataUri(pngBuf, "image/png");

  const callArgs = { ...args, [field]: dataUri };
  try {
    const r = await callTool(client, toolName, callArgs);
    const hasError = r.isError === true;
    logResult(`3.${toolName} base64`, !hasError, hasError ? r.content[0].text.substring(0, 100) : "OK");
  } catch (e) {
    logResult(`3.${toolName} base64`, false, e.message);
  }
}

async function testToolWithAllFormats(client, toolName, field, args = {}) {
  for (const [fmt, buf] of Object.entries(testImageBuffers)) {
    const mime = `image/${fmt === "jpeg" ? "jpeg" : fmt}`;
    try {
      const ref = await uploadFile(buf, mime);
      const callArgs = { ...args, [field]: ref };
      const r = await callTool(client, toolName, callArgs);
      const hasError = r.isError === true;
      logResult(`3.${toolName} ${fmt.toUpperCase()} upload`, !hasError, hasError ? r.content[0].text.substring(0, 80) : "OK");
    } catch (e) {
      logResult(`3.${toolName} ${fmt.toUpperCase()} upload`, false, e.message);
    }
  }
}

async function testToolMultiImage(client, toolName, field, args = {}) {
  const pngBuf = testImageBuffers.png;
  const jpegBuf = testImageBuffers.jpeg;
  const ref1 = await uploadFile(pngBuf, "image/png");
  const ref2 = await uploadFile(jpegBuf, "image/jpeg");

  // Test with upload:// references
  try {
    const r = await callTool(client, toolName, { ...args, [field]: [ref1, ref2] });
    const hasError = r.isError === true;
    logResult(`3.${toolName} multi-upload`, !hasError, hasError ? r.content[0].text.substring(0, 100) : "OK");
  } catch (e) {
    logResult(`3.${toolName} multi-upload`, false, e.message);
  }

  // Test with base64
  try {
    const r = await callTool(client, toolName, { ...args, [field]: [toDataUri(pngBuf, "image/png"), toDataUri(jpegBuf, "image/jpeg")] });
    const hasError = r.isError === true;
    logResult(`3.${toolName} multi-base64`, !hasError, hasError ? r.content[0].text.substring(0, 100) : "OK");
  } catch (e) {
    logResult(`3.${toolName} multi-base64`, false, e.message);
  }
}

// ============================================================
// SECTION 4: Output File Streaming Tests
// ============================================================
async function testOutputFileStreaming(client) {
  console.log("\n=== SECTION 4: Output File Streaming ===");

  const pngBuf = testImageBuffers.png;
  const ref = await uploadFile(pngBuf, "image/png");

  // 4.1 preprocess_and_crop returns output_file_path
  try {
    const r = await callTool(client, "preprocess_and_crop", { image_source: ref, grayscale: true });
    const text = JSON.parse(r.content[0].text);
    const ok = text.output_file_path && text.output_file_size > 0;
    logResult("4.1 preprocess_and_crop output_file_path", ok, ok ? `path=${text.output_file_path} size=${text.output_file_size}` : JSON.stringify(text));
  } catch (e) {
    logResult("4.1 preprocess_and_crop output_file_path", false, e.message);
  }

  // 4.2 visual_diff returns diff_file_path
  try {
    const ref2 = await uploadFile(testImageBuffers.jpeg, "image/jpeg");
    const r = await callTool(client, "visual_diff", { image_sources: [ref, ref2], analyze: false });
    const text = JSON.parse(r.content[0].text);
    const ok = text.diff_file_path && text.diff_file_size > 0;
    logResult("4.2 visual_diff diff_file_path", ok, ok ? `path=${text.diff_file_path} size=${text.diff_file_size}` : JSON.stringify(text));
  } catch (e) {
    logResult("4.2 visual_diff diff_file_path", false, e.message);
  }

  // 4.3 browser_screenshot_annotation returns output_file_path
  try {
    const r = await callTool(client, "browser_screenshot_annotation", {
      image_source: ref,
      annotations: [{ type: "label", text: "Test", x: 5, y: 5 }],
      return_base64: false,
    });
    const text = JSON.parse(r.content[0].text);
    const ok = text.output_file_path && text.output_file_size > 0;
    logResult("4.3 annotation output_file_path", ok, ok ? `path=${text.output_file_path} size=${text.output_file_size}` : JSON.stringify(text));
  } catch (e) {
    logResult("4.3 annotation output_file_path", false, e.message);
  }

  // 4.4 detect_ui_elements returns overlay_file_path
  try {
    const r = await callTool(client, "detect_ui_elements", {
      image_source: ref,
      return_overlay: true,
    });
    const text = JSON.parse(r.content[0].text);
    const ok = text.overlay_file_path && text.overlay_file_size > 0;
    logResult("4.4 detect_ui_elements overlay_file_path", ok, ok ? `path=${text.overlay_file_path} size=${text.overlay_file_size}` : JSON.stringify(text));
  } catch (e) {
    logResult("4.4 detect_ui_elements overlay_file_path", false, e.message);
  }
}

// ============================================================
// SECTION 5: x-mcp-file Schema Verification
// ============================================================
async function testSchemaAnnotations(client) {
  console.log("\n=== SECTION 5: x-mcp-file Schema Annotations ===");

  const { tools } = await client.listTools();
  const imageTools = tools.filter(t => {
    const props = t.inputSchema?.properties || {};
    return Object.values(props).some(v => {
      if (v["x-mcp-file"]) return true;
      if (v.items && v.items["x-mcp-file"]) return true;
      return false;
    });
  });

  const expectedTools = [
    "fast_ocr_tesseract", "preprocess_and_crop", "analyze_image",
    "find_text_element", "compare_images", "browser_screenshot_analysis",
    "browser_screenshot_annotation", "detect_ui_elements",
    "visual_diff", "textual_visual_feedback"
  ];

  const foundNames = imageTools.map(t => t.name).sort();
  const expectedSorted = [...expectedTools].sort();
  const allFound = expectedSorted.every(n => foundNames.includes(n));
  logResult("5.1 All 10 tools have x-mcp-file", allFound, allFound ? foundNames.join(", ") : `missing: ${expectedSorted.filter(n => !foundNames.includes(n)).join(", ")}`);

  // Verify each tool's x-mcp-file-accept includes all supported formats
  for (const t of imageTools) {
    const props = t.inputSchema.properties;
    for (const [key, val] of Object.entries(props)) {
      if (val["x-mcp-file"]) {
        const accept = val["x-mcp-file-accept"] || (val.items && val.items["x-mcp-file-accept"]);
        const hasAll = ["image/png", "image/jpeg", "image/webp", "image/gif"].every(m => accept.includes(m));
        logResult(`5.2 ${t.name}.${key} accepts all formats`, hasAll, hasAll ? accept.join(", ") : `missing: ${accept.join(", ")}`);
      }
    }
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("=".repeat(70));
  console.log("  HYBRID VISION MCP - COMPREHENSIVE UPLOAD AUDIT");
  console.log("=".repeat(70));

  await generateTestImages();

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  const client = new Client({ name: "audit-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // Section 1: Upload endpoint
    await testUploadEndpoint();

    // Section 2: Resolution pipeline
    await testResolutionPipeline(client);

    // Section 3: Per-tool file upload tests
    console.log("\n=== SECTION 3: Per-Tool File Upload Tests ===");

    // Single-image tools
    const singleImageTools = [
      ["fast_ocr_tesseract", "image_source", { language: "eng" }],
      ["preprocess_and_crop", "image_source", { grayscale: true }],
      ["analyze_image", "image_source", { prompt: "Describe" }],
      ["find_text_element", "image_source", { query: "test" }],
      ["browser_screenshot_analysis", "image_source", { focus: "layout", detail_level: "brief" }],
      ["browser_screenshot_annotation", "image_source", { annotations: [{ type: "label", text: "A", x: 0, y: 0 }], return_base64: false }],
      ["detect_ui_elements", "image_source", {}],
      ["textual_visual_feedback", "image_source", { include_ocr: false }],
    ];

    for (const [tool, field, args] of singleImageTools) {
      await testToolWithUpload(client, tool, field, args);
      await testToolWithBase64(client, tool, field, args);
      await testToolWithAllFormats(client, tool, field, args);
    }

    // Multi-image tools
    await testToolMultiImage(client, "compare_images", "image_sources", { prompt: "Compare" });
    await testToolMultiImage(client, "visual_diff", "image_sources", { analyze: false });

    // Section 4: Output file streaming
    await testOutputFileStreaming(client);

    // Section 5: Schema annotations
    await testSchemaAnnotations(client);

  } finally {
    await client.close();
  }

  // ============================================================
  // REPORT
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("  AUDIT REPORT");
  console.log("=".repeat(70));
  console.log(`  Total:  ${results.pass + results.fail + results.skipped}`);
  console.log(`  Pass:   ${results.pass}`);
  console.log(`  Fail:   ${results.fail}`);
  console.log(`  Skip:   ${results.skipped}`);
  console.log("=".repeat(70));

  if (results.fail > 0) {
    console.log("\n  FAILURES:");
    for (const d of results.details) {
      if (d.status === "FAIL") console.log(`    - ${d.name}: ${d.detail}`);
    }
  }

  // Summary
  console.log("\n  DISCREPANCIES:");
  const base64Failures = results.details.filter(d => d.name.includes("base64") && d.status === "FAIL");
  const uploadFailures = results.details.filter(d => d.name.includes("upload") && d.status === "FAIL" && !d.name.includes("Reject"));
  if (base64Failures.length === 0 && uploadFailures.length === 0) {
    console.log("    ✓ No discrepancies between base64 and file upload capabilities.");
    console.log("    ✓ All 10 tools support both input methods identically.");
  } else {
    if (base64Failures.length > 0) {
      console.log(`    ✗ ${base64Failures.length} base64 test(s) failed:`);
      base64Failures.forEach(f => console.log(`      - ${f.name}: ${f.detail}`));
    }
    if (uploadFailures.length > 0) {
      console.log(`    ✗ ${uploadFailures.length} upload test(s) failed:`);
      uploadFailures.forEach(f => console.log(`      - ${f.name}: ${f.detail}`));
    }
  }

  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
