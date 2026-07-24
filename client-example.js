import { MCPUploadHelper } from "./upload-helper.js";

const BASE_URL = process.env.MCP_SERVER_URL || "http://localhost:11402";
const helper = new MCPUploadHelper(BASE_URL);

async function exampleDirectUpload() {
  console.log("=== Example 1: Direct upload from File object ===");

  // In a real browser/Node environment, you would have a File or Blob:
  // const fileInput = document.querySelector("#screenshot-input");
  // const file = fileInput.files[0];

  // For demo, assume we have a file path on the server:
  const filePath = "/tmp/hvm-uploads/demo-screenshot.png";

  try {
    const result = await helper.callTool("analyze_image", {
      image_source: filePath,
      prompt: "Describe this screenshot in detail.",
    });
    console.log("Result:", result.content[0].text);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function exampleBatchUpload() {
  console.log("\n=== Example 2: Batch upload for compare_images ===");

  try {
    const result = await helper.callTool("compare_images", {
      image_sources: [
        "/tmp/screenshots/before.png",
        "/tmp/screenshots/after.png",
      ],
      prompt: "List all visual differences between these two screenshots.",
    });
    console.log("Comparison result:", result.content[0].text.substring(0, 500));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function exampleConnectedSession() {
  console.log("\n=== Example 3: Connected session with multiple calls ===");

  try {
    const client = await helper.connect();
    console.log("Connected to MCP server");

    const tools = await client.listTools();
    console.log(`Available tools: ${tools.tools.map((t) => t.name).join(", ")}`);

    const result = await helper.callToolConnected("fast_ocr_tesseract", {
      image_source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      language: "eng",
    });
    console.log("OCR result:", result.content[0].text);

    await helper.close();
    console.log("Session closed");
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function runExamples() {
  await exampleDirectUpload();
  await exampleBatchUpload();
  await exampleConnectedSession();
}

runExamples().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
