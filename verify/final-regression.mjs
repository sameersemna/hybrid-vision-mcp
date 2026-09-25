import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildFixturePng } from "../lib/fixtures.js";
const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");
const client = new Client({ name: "reg", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:11499/mcp")));
const call = async (n,a,to=300000) => (await client.callTool({name:n,arguments:a},undefined,{timeout:to})).content.map(c=>c.text||`[image ${c.data?.length}b]`);

console.log("=== A. visual_diff on identical images (must still report 0 changed) ===");
const vd = JSON.parse((await call("visual_diff", { image_sources: [dataUri, dataUri], analyze: false }))[0]);
console.log("changed_pixels:", vd.changed_pixels, "| total:", vd.total_pixels, "| ratio:", vd.change_ratio, "->", vd.changed_pixels===0?"PASS (untouched)":"FAIL");

console.log("\n=== B. fast_ocr_tesseract still works ===");
const ocr = (await call("fast_ocr_tesseract", { image_source: dataUri, language: "eng" }))[0];
console.log(ocr.split("\n").slice(0,4).join(" | "));

console.log("\n=== C. legacy analyze_image descriptive path: real model + provenance footer ===");
const ai = (await call("analyze_image", { image_source: dataUri, prompt: "Describe the layout of this image.", model: "moondream:1.8b-v2-q8_0" }))[0];
console.log(ai.slice(0, 300));
console.log("...");
console.log("has [provenance]:", /\[provenance\]/.test(ai) ? "YES" : "NO");

console.log("\n=== D. browser_screenshot_analysis legacy path + footer ===");
const bs = (await call("browser_screenshot_analysis", { image_source: dataUri, focus: "layout", detail_level: "brief", model: "moondream:1.8b-v2-q8_0" }))[0];
console.log("header present:", /\[Browser Screenshot Analysis/.test(bs) ? "YES":"NO", "| footer:", /\[provenance\]/.test(bs)?"YES":"NO");

console.log("\n=== E. detect_ui_elements reports provenance object ===");
const du = JSON.parse((await call("detect_ui_elements", { image_source: dataUri, model: "moondream:1.8b-v2-q8_0" }))[0]);
console.log("has provenance:", !!du.provenance, "| model:", du.provenance?.model, "| sent:", JSON.stringify(du.provenance?.image?.sent_dimensions), "| old keys intact (width/height/detection):", du.width!=null && du.height!=null && typeof du.detection==="string");

await client.close();
