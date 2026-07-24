import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.MCP_SERVER_URL || "http://localhost:11402";
const UPLOAD_URL = `${BASE_URL}/upload`;

const SAMPLE_BASE64_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function uploadTestImage() {
  const buf = Buffer.from(SAMPLE_BASE64_IMAGE.split(",")[1], "base64");
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: buf,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return data.uploadRef;
}

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

    // 3. Fast Tesseract OCR (base64)
    const ocrResult = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: SAMPLE_BASE64_IMAGE },
    });
    console.log(`\n[${name}] Tesseract OCR Result:\n${ocrResult.content[0].text}`);

    // 4. Sharp CV Preprocessor (base64)
    const cvResult = await client.callTool({
      name: "preprocess_and_crop",
      arguments: { image_source: SAMPLE_BASE64_IMAGE, grayscale: true },
    });
    console.log(`\n[${name}] Sharp CV Result:\n${cvResult.content[0].text}`);

    // 5. Upload endpoint test
    const uploadRef = await uploadTestImage();
    console.log(`\n[${name}] Upload endpoint: uploadRef=${uploadRef}`);

    // 6. Tool call with upload:// reference
    const uploadOcrResult = await client.callTool({
      name: "fast_ocr_tesseract",
      arguments: { image_source: uploadRef, language: "eng" },
    });
    console.log(`[${name}] Upload OCR Result:\n${uploadOcrResult.content[0].text}`);

    // 7. x-mcp-file schema annotation verification
    const imageTools = tools.filter(t => {
      const props = t.inputSchema?.properties || {};
      return Object.values(props).some(v => v["x-mcp-file"] || (v.items && v.items["x-mcp-file"]));
    });
    console.log(`[${name}] Tools with x-mcp-file: ${imageTools.length}`);
    imageTools.forEach(t => console.log(`  - [${t.name}]`));

    // 8. Output file streaming verification
    const cvText = JSON.parse(cvResult.content[0].text);
    if (cvText.output_file_path) {
      console.log(`[${name}] Output file streaming: path=${cvText.output_file_path} size=${cvText.output_file_size}`);
    }

    console.log(`\nSUCCESS: ${name} transport passed all tool calls!`);
  } catch (err) {
    console.error(`\nFAILED: ${name} transport error:`, err.message);
    throw err;
  }
}

async function runAllTests() {
  try {
    await testTransport("Streamable HTTP (/mcp)", () =>
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
    );

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
