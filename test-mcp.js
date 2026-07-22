import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.MCP_SERVER_URL || "http://localhost:11402";

// 1x1 transparent PNG Base64 sample image
const SAMPLE_BASE64_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function testTransport(name, createTransport) {
  console.log(`\n========================================`);
  console.log(` Testing Transport: ${name}`);
  console.log(`========================================`);

  const transport = createTransport();
  const client = new Client(
    { name: `test-client-${name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log(`[${name}] Connected successfully.`);

    // 1. List Tools
    const { tools } = await client.listTools();
    console.log(`[${name}] Found ${tools.length} registered tools:`);
    tools.forEach((t) => console.log(`  - [${t.name}]`));

    // 2. Health Check
    const healthResult = await client.callTool({
      name: "check_vision_health",
      arguments: {},
    });
    console.log(`\n[${name}] Health Check Result:\n${healthResult.content[0].text}`);

    // 3. Fast Tesseract OCR
    const ocrResult = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: SAMPLE_BASE64_IMAGE },
    });
    console.log(`\n[${name}] Tesseract OCR Result:\n${ocrResult.content[0].text}`);

    // 4. Sharp CV Preprocessor
    const cvResult = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: SAMPLE_BASE64_IMAGE, grayscale: true },
    });
    console.log(`\n[${name}] Sharp CV Result:\n${cvResult.content[0].text}`);

    console.log(`\nSUCCESS: ${name} transport passed all tool calls!`);
  } catch (err) {
    console.error(`\nFAILED: ${name} transport error:`, err.message);
    throw err;
  }
}

async function runAllTests() {
  try {
    // 1. Test Streamable HTTP (/mcp)
    await testTransport("Streamable HTTP (/mcp)", () =>
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
    );

    // 2. Test Legacy SSE (/sse)
    await testTransport("SSE (/sse)", () =>
      new SSEClientTransport(new URL(`${BASE_URL}/sse`))
    );

    console.log("\n========================================");
    console.log(" ALL TRANSPORTS & TOOLS PASSED SUCCESSFULLY!");
    console.log("========================================\n");
    process.exit(0);
  } catch (_) {
    process.exit(1);
  }
}

runAllTests();