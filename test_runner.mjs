import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const BASE_URL = "http://localhost:11402";

async function createTextImage() {
  const svg = `<svg width="400" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="100" fill="white"/>
    <text x="10" y="50" font-family="Arial" font-size="24" fill="black">HYBRID VISION TEST 123</text>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

async function createMultiObjectImage() {
  const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="300" fill="white"/>
    <rect x="10" y="10" width="100" height="80" fill="red"/>
    <circle cx="220" cy="150" r="70" fill="blue"/>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

async function createSecondImage() {
  const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="300" fill="yellow"/>
    <circle cx="150" cy="150" r="100" fill="green"/>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

async function createTransport() {
  return new SSEClientTransport(new URL(`${BASE_URL}/sse`));
}

async function runTest(name, fn) {
  const client = new Client({ name: "test-runner", version: "1.0.0" }, { capabilities: {} });
  const transport = await createTransport();
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

  console.log("== Tool: check_vision_health ==");
  results.push(await runTest("check_vision_health happy", async (client) => {
    const result = await client.callTool({ name: "check_vision_health", arguments: {} });
    const text = result.content[0]?.text || "";
    if (!text.includes("Vision MCP Health Status")) throw new Error("Missing health status header");
  }));

  console.log("\n== Tool: fast_ocr_tesseract ==");
  results.push(await runTest("fast_ocr_tesseract happy (text image)", async (client) => {
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: textImage, language: "eng" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`OCR returned error: ${text}`);
  }));

  results.push(await runTest("fast_ocr_tesseract edge (invalid base64)", async (client) => {
    const result = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: "data:image/png;base64,INVALID_truncated!!!!" },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("error");
    if (!structured) throw new Error("Expected an error response for invalid base64");
  }));

  console.log("\n== Tool: preprocess_and_crop ==");
  results.push(await runTest("preprocess_and_crop happy (valid crop)", async (client) => {
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: textImage, crop: { left: 10, top: 10, width: 100, height: 40 }, grayscale: true },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Preprocess returned error: ${text}`);
  }));

  results.push(await runTest("preprocess_and_crop edge (out-of-bounds crop)", async (client) => {
    const result = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: textImage, crop: { left: 10, top: 10, width: 9000, height: 9000 } },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("error");
    if (!structured) throw new Error("Expected an error response for out-of-bounds crop");
  }));

  console.log("\n== Tool: analyze_image ==");
  results.push(await runTest("analyze_image happy", async (client) => {
    const result = await client.callTool({
      name: "analyze_image",
      arguments: { image_source: textImage, prompt: "What text is visible in this image?" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Analyze returned error: ${text}`);
  }));

  results.push(await runTest("analyze_image edge (no prompt / empty)", async (client) => {
    const result = await client.callTool({
      name: "analyze_image",
      arguments: { image_source: textImage },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error") && !text.includes("Describe this image")) throw new Error(`Unexpected error: ${text}`);
  }));

  console.log("\n== Tool: find_text_element ==");
  results.push(await runTest("find_text_element happy", async (client) => {
    const result = await client.callTool({
      name: "find_text_element",
      arguments: { image_source: textImage, query: "HYBRID" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Find text returned error: ${text}`);
  }));

  results.push(await runTest("find_text_element edge (missing query)", async (client) => {
    const result = await client.callTool({
      name: "find_text_element",
      arguments: { image_source: textImage },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("required") || text.toLowerCase().includes("error");
    if (!structured) throw new Error("Expected a validation error for missing query");
  }));

  console.log("\n== Tool: compare_images ==");
  results.push(await runTest("compare_images happy (2 images)", async (client) => {
    const result = await client.callTool({
      name: "compare_images",
      arguments: { image_sources: [multiObjectImage, secondImage], prompt: "What is different between these images?" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Compare returned error: ${text}`);
  }));

  results.push(await runTest("compare_images edge (single image)", async (client) => {
    const result = await client.callTool({
      name: "compare_images",
      arguments: { image_sources: [textImage] },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("at least 2");
    if (!structured) throw new Error("Expected validation error for single image array");
  }));

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
