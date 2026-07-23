import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import fs from "fs";
import path from "path";

const BASE_URL = "http://localhost:11402";
const REPORT_DIR = "/home/sameer/Public/Shared/Work/Services/MCP/hybrid-vision-mcp";

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

async function createTestImageWithText() {
  const svg = `<svg width="500" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect width="500" height="200" fill="#f0f0f0"/>
    <text x="50" y="60" font-family="Arial" font-size="28" fill="black">Hello World</text>
    <text x="50" y="120" font-family="Arial" font-size="28" fill="red">OCR Test 456</text>
    <rect x="350" y="20" width="120" height="50" rx="10" fill="#4CAF50"/>
    <text x="365" y="52" font-family="Arial" font-size="20" fill="white">Submit</text>
  </svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  return `data:image/png;base64,${base64}`;
}

async function connectClient(name) {
  const transport = new SSEClientTransport(new URL(`${BASE_URL}/sse`));
  const client = new Client(
    { name: `actual-user-${name}`, version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

async function disconnectClient(client, transport) {
  try { await client.close(); } catch {}
  try { transport.close?.(); } catch {}
}

function timestamp() {
  return new Date().toISOString();
}

async function main() {
  console.log("=== Hybrid Vision MCP — Actual Tool Usage Report Generator ===\n");
  console.log(`Server URL: ${BASE_URL}`);
  console.log(`Time: ${timestamp()}\n`);

  console.log("Generating synthetic test images...\n");
  const textImage = await createTextImage();
  const uiImage = await createTestImageWithText();
  const multiObjectImage = await createMultiObjectImage();
  const secondImage = await createSecondImage();

  const report = {
    generatedAt: timestamp(),
    serverUrl: BASE_URL,
    images: {
      textImage: `[Generated 400x100 white background with black text: \"HYBRID VISION TEST 123\"]`,
      uiImage: `[Generated 500x200 UI mockup with \"Hello World\", \"OCR Test 456\", and \"Submit\" button]`,
      multiObjectImage: `[Generated 300x300 white with red rect and blue circle]`,
      secondImage: `[Generated 300x300 yellow with green circle]`,
    },
    toolResults: {},
  };

  let clientCount = 0;

  // ============================================================
  // TOOL 1: check_vision_health
  // ============================================================
  console.log("== Tool: check_vision_health ==");
  const { client: hcClient, transport: hcTransport } = await connectClient(`health-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await hcClient.callTool({
      name: "check_vision_health",
      arguments: {},
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output:\n${text}\n`);
    report.toolResults.check_vision_health = {
      durationMs: duration,
      isError: !!result.isError,
      output: text.trim(),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.check_vision_health = { error: err.message };
  } finally {
    await disconnectClient(hcClient, hcTransport);
  }

  // ============================================================
  // TOOL 2: fast_ocr_tesseract
  // ============================================================
  console.log("== Tool: fast_ocr_tesseract ==");
  const { client: ocrClient, transport: ocrTransport } = await connectClient(`ocr-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await ocrClient.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: textImage, language: "eng" },
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output:\n${text}\n`);
    report.toolResults.fast_ocr_tesseract = {
      durationMs: duration,
      isError: !!result.isError,
      parameters: { image_source: "[synthetic png base64]", language: "eng" },
      output: text.trim(),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.fast_ocr_tesseract = { error: err.message };
  } finally {
    await disconnectClient(ocrClient, ocrTransport);
  }

  // ============================================================
  // TOOL 3: preprocess_and_crop
  // ============================================================
  console.log("== Tool: preprocess_and_crop ==");
  const { client: cvClient, transport: cvTransport } = await connectClient(`cv-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await cvClient.callTool({
      name: "preprocess_and_crop",
      arguments: {
        image_source: textImage,
        crop: { left: 10, top: 10, width: 200, height: 60 },
        grayscale: true,
        sharpen: false,
      },
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output (first 300 chars):\n${text.slice(0, 300)}...\n`);
    report.toolResults.preprocess_and_crop = {
      durationMs: duration,
      isError: !!result.isError,
      parameters: {
        image_source: "[synthetic png base64]",
        crop: { left: 10, top: 10, width: 200, height: 60 },
        grayscale: true,
        sharpen: false,
      },
      output: text.trim().slice(0, 500),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.preprocess_and_crop = { error: err.message };
  } finally {
    await disconnectClient(cvClient, cvTransport);
  }

  // preprocess_and_crop edge: out-of-bounds
  try {
    const result = await cvClient.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: textImage, crop: { left: 10, top: 10, width: 9000, height: 9000 } },
    });
    const text = result.content[0]?.text || "";
    report.toolResults["preprocess_and_crop-edge-oob"] = {
      isError: !!result.isError,
      parameters: { image_source: "[synthetic png base64]", crop: { left: 10, top: 10, width: 9000, height: 9000 } },
      output: text.trim(),
    };
    console.log(`[EDGE] preprocess_and_crop OOB -> ${result.isError ? "ERROR (expected)" : "OK (unexpected)"}\n`);
  } catch (err) {
    console.error("[EDGE] preprocess_and_crop OOB FAILED:", err.message);
  }
  await disconnectClient(cvClient, cvTransport);

  // ============================================================
  // TOOL 4: analyze_image
  // ============================================================
  console.log("== Tool: analyze_image ==");
  const { client: aiClient, transport: aiTransport } = await connectClient(`ai-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await aiClient.callTool({
      name: "analyze_image",
      arguments: {
        image_source: uiImage,
        prompt: "What text and UI elements are visible in this image?",
      },
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output:\n${text.slice(0, 800)}...\n`);
    report.toolResults.analyze_image = {
      durationMs: duration,
      isError: !!result.isError,
      parameters: {
        image_source: "[synthetic ui base64]",
        prompt: "What text and UI elements are visible in this image?",
        model: "llava:13b (default)",
      },
      output: text.trim(),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.analyze_image = { error: err.message };
  } finally {
    await disconnectClient(aiClient, aiTransport);
  }

  // ============================================================
  // TOOL 5: find_text_element
  // ============================================================
  console.log("== Tool: find_text_element ==");
  const { client: ftClient, transport: ftTransport } = await connectClient(`find-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await ftClient.callTool({
      name: "find_text_element",
      arguments: {
        image_source: uiImage,
        query: "Submit",
        model: "llava:13b",
      },
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output:\n${text.slice(0, 800)}...\n`);
    report.toolResults.find_text_element = {
      durationMs: duration,
      isError: !!result.isError,
      parameters: {
        image_source: "[synthetic ui base64]",
        query: "Submit",
        model: "llava:13b",
      },
      output: text.trim(),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.find_text_element = { error: err.message };
  } finally {
    await disconnectClient(ftClient, ftTransport);
  }

  // ============================================================
  // TOOL 6: compare_images
  // ============================================================
  console.log("== Tool: compare_images ==");
  const { client: cmpClient, transport: cmpTransport } = await connectClient(`cmp-${++clientCount}`);
  try {
    const start = Date.now();
    const result = await cmpClient.callTool({
      name: "compare_images",
      arguments: {
        image_sources: [multiObjectImage, secondImage],
        prompt: "List all visual differences between these images.",
        model: "llava:13b",
      },
    });
    const duration = Date.now() - start;
    const text = result.content[0]?.text || "";
    console.log(`Duration: ${duration}ms`);
    console.log(`Output:\n${text.slice(0, 800)}...\n`);
    report.toolResults.compare_images = {
      durationMs: duration,
      isError: !!result.isError,
      parameters: {
        image_sources: ["[synthetic base64]", "[synthetic base64]"],
        prompt: "List all visual differences between these images.",
        model: "llava:13b",
      },
      output: text.trim(),
    };
  } catch (err) {
    console.error("FAILED:", err.message);
    report.toolResults.compare_images = { error: err.message };
  } finally {
    await disconnectClient(cmpClient, cmpTransport);
  }

  // compare_images edge: single image
  try {
    const result = await cmpClient.callTool({
      name: "compare_images",
      arguments: { image_sources: [textImage] },
    });
    const text = result.content[0]?.text || "";
    report.toolResults["compare_images-edge-single"] = {
      isError: !!result.isError,
      parameters: { image_sources: ["[synthetic base64]"] },
      output: text.trim(),
    };
    console.log(`[EDGE] compare_images single -> ${result.isError ? "ERROR (expected)" : "OK (unexpected)"}\n`);
  } catch (err) {
    console.error("[EDGE] compare_images single FAILED:", err.message);
  }
  await disconnectClient(cmpClient, cmpTransport);

  // Save report
  const reportPath = path.join(REPORT_DIR, "ACTUAL_TOOLS_USAGE_REPORT.md");
  const mdContent = generateMarkdownReport(report);
  fs.writeFileSync(reportPath, mdContent, "utf-8");
  console.log(`\nReport saved to: ${reportPath}`);
  console.log("Done.");
}

function generateMarkdownReport(report) {
  let md = `# Hybrid Vision MCP Server — Actual Tool Usage Report\n\n`;
  md += `**Generated:** ${report.generatedAt}\n`;
  md += `**Server URL:** ${report.serverUrl}\n\n`;
  md += `---\n\n`;

  md += `## Test Images Used\n\n`;
  for (const [key, desc] of Object.entries(report.images)) {
    md += `- **${key}**: ${desc}\n`;
  }
  md += `\n---\n\n`;

  md += `## Tool Invocation Results\n\n`;

  const toolOrder = [
    "check_vision_health",
    "fast_ocr_tesseract",
    "preprocess_and_crop",
    "analyze_image",
    "find_text_element",
    "compare_images",
  ];

  for (const tool of toolOrder) {
    const data = report.toolResults[tool];
    if (!data) continue;

    md += `### ${tool}\n\n`;

    if (data.error) {
      md += `**STATUS:** ERROR\n\n`;
      md += `\`\`\`\n${data.error}\n\`\`\`\n\n`;
      md += `---\n\n`;
      continue;
    }

    md += `**Duration:** ${data.durationMs}ms\n\n`;
    if (data.parameters) {
      md += `**Parameters:**\n\n`;
      md += `\`\`\`json\n${JSON.stringify(data.parameters, null, 2)}\n\`\`\`\n\n`;
    }
    md += `**Output:**\n\n`;
    md += `\`\`\`\n${data.output}\n\`\`\`\n\n`;
    md += `---\n\n`;
  }

  // Edge cases
  md += `## Edge Case Validation Tests\n\n`;
  const edgeTests = [
    ["preprocess_and_crop-edge-oob", "preprocess_and_crop (out-of-bounds crop)"],
    ["compare_images-edge-single", "compare_images (single image)"],
  ];
  for (const [key, label] of edgeTests) {
    const data = report.toolResults[key];
    if (!data) continue;
    md += `### ${label}\n\n`;
    md += `**Parameters:**\n\n`;
    md += `\`\`\`json\n${JSON.stringify(data.parameters, null, 2)}\n\`\`\`\n\n`;
    md += `**Expected:** Validation error\n\n`;
    md += `**Actual Output:**\n\n`;
    md += `\`\`\`\n${data.output}\n\`\`\`\n\n`;
    md += `---\n\n`;
  }

  md += `## Summary\n\n`;
  const totalTools = toolOrder.length;
  const successfulTools = toolOrder.filter((t) => {
    const d = report.toolResults[t];
    return d && !d.error && !d.isError;
  }).length;
  md += `- Tools tested: ${totalTools}\n`;
  md += `- Successful: ${successfulTools}\n`;
  md += `- Server: ${report.serverUrl}\n`;
  md += `- All images transmitted as Base64 Data URIs (remote host compliant)\n`;

  return md;
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
