import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = "http://localhost:11402";
const UPLOAD_URL = `${BASE_URL}/upload`;

const IMAGE_URLS = [
  {
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e0/WordPress_7.0_Dashboard.png",
    label: "WordPress 7.0 Dashboard",
  },
  {
    url: "https://upload.wikimedia.org/wikipedia/commons/9/9f/Dashboard_Sample.png",
    label: "Dashboard Sample (Business Monitor)",
  },
];

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "HybridVisionMCP-Test/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/png";
  return { buf, mime };
}

async function uploadImage(buf, mime) {
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": mime },
    body: buf,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.uploadRef;
}

async function safeCallTool(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0]?.text || "";
    return { ok: true, text: text.substring(0, 250) };
  } catch (e) {
    return { ok: false, error: e.message.substring(0, 120) };
  }
}

async function run() {
  console.log("=".repeat(70));
  console.log("  WORKFLOW: Web Search -> Image Fetch -> Upload -> MCP Analysis");
  console.log("=".repeat(70));

  // Step 1: Fetch images from Wikimedia Commons
  console.log("\n--- Step 1: Fetching images from web ---");
  const images = [];
  for (const img of IMAGE_URLS) {
    console.log(`  Fetching: ${img.label}`);
    console.log(`    URL: ${img.url}`);
    const { buf, mime } = await fetchImage(img.url);
    console.log(`    Size: ${buf.length} bytes, Type: ${mime}`);
    images.push({ ...img, buf, mime });
  }

  // Step 2: Upload images to MCP server
  console.log("\n--- Step 2: Uploading to MCP server ---");
  for (const img of images) {
    const ref = await uploadImage(img.buf, img.mime);
    img.uploadRef = ref;
    console.log(`  ${img.label}: ${ref}`);
  }

  // Step 3: Connect MCP client and analyze
  console.log("\n--- Step 3: MCP Visual Analysis ---");
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  const client = new Client({ name: "web-to-vision-workflow", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    for (const img of images) {
      console.log(`\n  >>> Analyzing: ${img.label} <<<`);

      const tools = [
        ["browser_screenshot_analysis", { image_source: img.uploadRef, focus: "all", detail_level: "brief" }],
        ["fast_ocr_tesseract", { image_source: img.uploadRef, language: "eng" }],
        ["detect_ui_elements", { image_source: img.uploadRef }],
        ["textual_visual_feedback", { image_source: img.uploadRef, include_ocr: true }],
      ];

      for (const [tool, args] of tools) {
        console.log(`  [${tool}]`);
        const r = await safeCallTool(client, tool, args);
        if (r.ok) {
          console.log(`    ${r.text}...`);
        } else {
          console.log(`    SKIPPED: ${r.error}`);
        }
      }
    }

    // Compare the two dashboard images
    console.log(`\n  >>> Comparing both images <<<`);
    const compareTools = [
      ["visual_diff", { image_sources: [images[0].uploadRef, images[1].uploadRef], threshold: 15, highlight_color: "#FF00FF", analyze: true }],
      ["compare_images", { image_sources: [images[0].uploadRef, images[1].uploadRef], prompt: "Compare these two dashboard screenshots. Describe the layout, visual hierarchy, color scheme, and key UI components in each." }],
    ];

    for (const [tool, args] of compareTools) {
      console.log(`  [${tool}]`);
      const r = await safeCallTool(client, tool, args);
      if (r.ok) {
        console.log(`    ${r.text}...`);
      } else {
        console.log(`    SKIPPED: ${r.error}`);
      }
    }

  } finally {
    await client.close();
  }

  // Step 4: Verify files on disk (read actual UPLOAD_DIR from .env)
  console.log("\n--- Step 4: Verify files on disk ---");
  let uploadDir = "/tmp/hvm-uploads";
  let feedbackDir = "/tmp/hvm-feedback";
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === "UPLOAD_DIR") uploadDir = value;
      if (key === "FEEDBACK_DIR") feedbackDir = value;
    }
  }
  console.log(`  UPLOAD_DIR: ${uploadDir}`);
  console.log(`  FEEDBACK_DIR: ${feedbackDir}`);
  console.log(`  Uploaded files:`);
  for (const img of images) {
    const filename = img.uploadRef.replace("upload://", "");
    const filepath = path.join(uploadDir, filename);
    const exists = fs.existsSync(filepath);
    console.log(`    ${img.label}: ${exists ? "ON DISK ✓" : "MISSING ✗"} (${filepath})`);
  }
  console.log(`  Feedback files: ${fs.readdirSync(feedbackDir).length} files`);

  console.log("\n" + "=".repeat(70));
  console.log("  WORKFLOW COMPLETE");
  console.log("=".repeat(70));
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
