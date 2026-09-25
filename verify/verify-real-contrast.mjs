import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildFixturePng, getGroundTruth } from "../lib/fixtures.js";
const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");
const gt = getGroundTruth();
const client = new Client({ name: "f4", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:11499/mcp")));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })).content[0].text);

console.log("=== Region-specific contrast, all four fixture lines (F4 ground truth) ===");
for (const t of gt.text) {
  const j = await call("measure_image", {
    image_source: dataUri, mode: "contrast", region: t.region, background_color: gt.background,
  });
  const c = j.measurements.contrast;
  const verdict = c.wcag_aa ? "PASS-AA" : "FLAGGED-LOW";
  console.log(`  ${t.text.padEnd(24)} declared ${t.declared_contrast}  measured ${c.contrast_ratio}  wcag_aa=${c.wcag_aa}  fg=${c.foreground?.hex}  -> ${verdict}`);
}

console.log("\n=== Box count via measurement (F2 'exactly 4') ===");
const bx = await call("measure_image", { image_source: dataUri, mode: "boxes", box_color: gt.box_border_color });
console.log("  boxes:", bx.measurements.boxes.count, "| boxes:", bx.measurements.boxes.boxes.map(b=>`${b.id}@${b.x},${b.y}`).join(" "));

console.log("\n=== The original bug's exact claim, re-asked as a measurement question ===");
const j = await call("analyze_image", { image_source: dataUri, prompt: "What is the contrast ratio of the text at the top?" });
console.log("  answered_by:", j.answered_by, "| model_consulted:", j.model_consulted, "| ratio:", j.measurements?.contrast?.contrast_ratio);
await client.close();
