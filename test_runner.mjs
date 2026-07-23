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

  console.log("\n== Tool: browser_screenshot_analysis ==");
  results.push(await runTest("browser_screenshot_analysis happy", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_analysis",
      arguments: { image_source: textImage, focus: "layout", detail_level: "standard" },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Screenshot analysis returned error: ${text}`);
    if (!text.includes("Browser Screenshot Analysis")) throw new Error("Missing expected header in analysis response");
  }));

  results.push(await runTest("browser_screenshot_analysis detail variants", async (client) => {
    for (const level of ["brief", "detailed"]) {
      const r = await client.callTool({
        name: "browser_screenshot_analysis",
        arguments: { image_source: textImage, detail_level: level },
      });
      if (r.content[0]?.text.includes("Error")) throw new Error(`Analysis failed for detail_level=${level}`);
    }
  }));

  console.log("\n== Tool: browser_screenshot_annotation ==");
  results.push(await runTest("browser_screenshot_annotation happy (label + box)", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: {
        image_source: textImage,
        annotations: [
          { type: "box", x: 10, y: 10, width: 100, height: 50, color: "#FF0000" },
          { type: "label", text: "Header Text", x: 15, y: 40, color: "#00FF00", font_size: 14 },
        ],
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Annotation returned error: ${text}`);
    if (!text.includes("success")) throw new Error("Missing success marker in annotation response");
    const imageBlock = result.content.find((c) => c.type === "image");
    if (!imageBlock) throw new Error("Missing image content block in annotation response");
    if (!imageBlock.mimeType?.startsWith("image/")) throw new Error("Invalid image mimeType");
    if (imageBlock.data?.length < 100) throw new Error("Annotated image data appears too short");
  }));

  results.push(await runTest("browser_screenshot_annotation edge (no annotations)", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: { image_source: textImage, annotations: [] },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.includes("non-empty array");
    if (!structured) throw new Error("Expected error for empty annotations array");
  }));

  results.push(await runTest("browser_screenshot_annotation edge (invalid item)", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: { image_source: textImage, annotations: [{ x: 10, y: 10 }] },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.includes("INVALID_ANNOTATION");
    if (!structured) throw new Error("Expected structured error for invalid annotation item");
  }));

  results.push(await runTest("browser_screenshot_annotation arrow + return_base64_false", async (client) => {
    const result = await client.callTool({
      name: "browser_screenshot_annotation",
      arguments: {
        image_source: textImage,
        annotations: [
          { type: "arrow", x: 10, y: 10, target_x: 100, target_y: 60, color: "#0000FF" },
          { type: "circle", x: 200, y: 50, width: 30, color: "#FFFF00" },
        ],
        return_base64: false,
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Annotation with arrow returned error: ${text}`);
    const hasBase64 = text.includes("data_uri") && text.includes("base64");
    if (!hasBase64) throw new Error("Expected JSON response to contain data_uri when return_base64=false");
  }));

  console.log("\n== Tool: visual_diff ==");
  results.push(await runTest("visual_diff happy (two images)", async (client) => {
    const result = await client.callTool({
      name: "visual_diff",
      arguments: {
        image_sources: [multiObjectImage, secondImage],
        threshold: 20,
        highlight_color: "#FF00FF",
        analyze: false,
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Visual diff returned error: ${text}`);
    const imageBlock = result.content.find((c) => c.type === "image");
    if (!imageBlock) throw new Error("Missing image content block in visual_diff response");
    if (!imageBlock.mimeType?.startsWith("image/")) throw new Error("Invalid image mimeType");
    if (!text.includes("Visual diff computed successfully")) throw new Error("Missing success message in diff response");
  }));

  results.push(await runTest("visual_diff edge (single image)", async (client) => {
    const result = await client.callTool({
      name: "visual_diff",
      arguments: { image_sources: [textImage] },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("at least 2");
    if (!structured) throw new Error("Expected validation error for single image array in visual_diff");
  }));

  console.log("\n== Tool: detect_ui_elements ==");
  results.push(await runTest("detect_ui_elements happy (no overlay)", async (client) => {
    const result = await client.callTool({
      name: "detect_ui_elements",
      arguments: {
        image_source: multiObjectImage,
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Detect UI returned error: ${text}`);
    if (!text.includes("UI elements detected")) throw new Error("Missing expected header in detect response");
    const imageBlock = result.content.find((c) => c.type === "image");
    if (imageBlock) throw new Error("Did not expect image block when return_overlay is false");
  }));

  results.push(await runTest("detect_ui_elements edge (missing image_source)", async (client) => {
    const result = await client.callTool({
      name: "detect_ui_elements",
      arguments: {},
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("error") || text.toLowerCase().includes("required");
    if (!structured) throw new Error("Expected validation error for missing image_source in detect_ui_elements");
  }));

  console.log("\n== Tool: textual_visual_feedback ==");
  results.push(await runTest("textual_visual_feedback happy (with OCR)", async (client) => {
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: {
        image_source: textImage,
        include_ocr: true,
        ocr_language: "eng"
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Feedback returned error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error("Feedback missing success flag");
    if (!parsed.screenshot || !parsed.screenshot.file_path) throw new Error("Missing file_path in feedback");
    if (!parsed.screenshot.data_uri_length) throw new Error("Missing data_uri_length metadata");
    if (result.content.find((c) => c.type === "image")) throw new Error("Did not expect image content block");
    if (!parsed.ocr || !parsed.ocr.text) throw new Error("Missing ocr in feedback");
  }));

  results.push(await runTest("textual_visual_feedback happy (with DOM + CSS)", async (client) => {
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: {
        image_source: textImage,
        dom_fragment: '<div class="header"><h1>Title</h1></div>',
        css_snapshot: '.header { color: red; }',
        include_ocr: false
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Feedback returned error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.dom.provided) throw new Error("Missing dom in feedback");
    if (!parsed.css.provided) throw new Error("Missing css in feedback");
    if (!parsed.screenshot || !parsed.screenshot.file_path) throw new Error("Missing file_path in feedback");
    if (result.content.find((c) => c.type === "image")) throw new Error("Did not expect image content block");
  }));

  results.push(await runTest("textual_visual_feedback edge (missing image_source)", async (client) => {
    const result = await client.callTool({
      name: "textual_visual_feedback",
      arguments: {},
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("required");
    if (!structured) throw new Error("Expected error for missing image_source");
  }));

  console.log("\n== Tool: extract_semantic_page ==");
  const sampleHtml = `
    <html>
      <head><title>Test Page</title><meta name="description" content="A test page"></head>
      <body>
        <nav><a href="/home">Home</a><a href="/about">About</a></nav>
        <main>
          <h1>Welcome</h1>
          <p>This is a test paragraph.</p>
          <ul><li>Item 1</li><li>Item 2</li></ul>
          <form><input type="text" name="q"><button>Submit</button></form>
          <table><tr><th>A</th></tr><tr><td>1</td></tr></table>
        </main>
        <article><h2>Article Title</h2><p>Article content here.</p></article>
        <footer>Copyright 2024</footer>
        <img src="test.png" alt="Test Image">
      </body>
    </html>
  `;

  results.push(await runTest("extract_semantic_page happy (comprehensive HTML)", async (client) => {
    const result = await client.callTool({
      name: "extract_semantic_page",
      arguments: { html_content: sampleHtml, min_text_length: 3, include_raw: true },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Semantic page returned error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error("Missing success flag");
    const cm = parsed.control_map;
    if (cm.title !== "Test Page") throw new Error("Missing title");
    if (!cm.headings.find(h => h.level === 1 && h.text === "Welcome")) throw new Error("Missing h1");
    if (!cm.navigation.links.find(l => l.href === "/home")) throw new Error("Missing nav links");
    if (!cm.lists.length) throw new Error("Missing lists");
    if (!cm.forms.length) throw new Error("Missing forms");
    if (!cm.tables.length) throw new Error("Missing tables");
    if (!cm.media.length) throw new Error("Missing media");
    if (!cm.footer.text.includes("Copyright")) throw new Error("Missing footer");
  }));

  results.push(await runTest("extract_semantic_page edge (empty HTML)", async (client) => {
    const result = await client.callTool({
      name: "extract_semantic_page",
      arguments: { html_content: "" },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("error");
    if (!structured) throw new Error("Expected error for empty HTML");
  }));

  console.log("\n== Tool: generate_repo_graph ==");
  results.push(await runTest("generate_repo_graph happy (current repo)", async (client) => {
    const result = await client.callTool({
      name: "generate_repo_graph",
      arguments: {
        repo_path: "/home/sameer/Public/Shared/Work/Services/MCP/hybrid-vision-mcp",
        max_depth: 3,
        include_node_modules: false
      },
    });
    const text = result.content[0]?.text || "";
    if (text.includes("Error")) throw new Error(`Repo graph returned error: ${text}`);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error("Missing success flag");
    if (!parsed.graph.nodes.find(n => n.relative_path === "index.js")) throw new Error("Missing index.js node");
    if (!parsed.dot_preview.includes("digraph repo")) throw new Error("Missing DOT format");
  }));

  results.push(await runTest("generate_repo_graph edge (invalid path)", async (client) => {
    const result = await client.callTool({
      name: "generate_repo_graph",
      arguments: { repo_path: "/nonexistent/path/12345" },
    });
    const text = result.content[0]?.text || "";
    const structured = result.isError || text.toLowerCase().includes("error");
    if (!structured) throw new Error("Expected error for invalid repo path");
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
