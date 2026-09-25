// Live verification against the real (PIL-generated) fixture.
//
// The acceptance tests render their fixture with sharp/SVG so they stay
// dependency-free. This script exercises the *brief's actual* PIL fixture
// through a running server, so the reference numbers are confirmed against the
// exact bytes the brief generated.
//
// Usage:
//   python3 verify/make-fixture.py           # writes fixture.png
//   PORT=11499 node index.js &
//   node verify/verify-contrast-live.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.PORT || 11499;
const FIXTURE = path.join(ROOT, "fixture.png");

if (!fs.existsSync(FIXTURE)) {
  console.error(`Missing ${FIXTURE}. Run: python3 verify/make-fixture.py`);
  process.exit(1);
}

const dataUri = "data:image/png;base64," + fs.readFileSync(FIXTURE).toString("base64");

const client = new Client({ name: "contrast-live", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));

const call = async (name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content[0].text);

const callText = async (name, args) =>
  (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content[0].text;

console.log("################ 1. measure_image mode=contrast, whole image ################");
const r = await call("measure_image", {
  image_source: dataUri,
  mode: "contrast",
  region: { left: 0, top: 0, width: 900, height: 420 },
});
const c = r.measurements.contrast;
console.log("failing_count      :", c.failing_count);
console.log("all_meet_aa        :", c.all_meet_aa);
console.log("wcag_aa (alias)    :", c.wcag_aa);
console.log("worst              :", c.worst.foreground, c.worst.contrast_ratio);
console.log("best               :", c.best.foreground, c.best.contrast_ratio);
console.log("evaluated_count    :", c.evaluated_count);
console.log("colours            :");
for (const e of c.colours) {
  console.log(`   ${e.foreground}  ratio=${String(e.contrast_ratio).padStart(6)}  wcag_aa=${String(e.wcag_aa).padEnd(5)} px=${e.pixel_count} comps=${e.component_count}`);
}
console.log("excluded           :", c.excluded.map((e) => `${e.foreground}(${e.contrast_ratio})`).join(", ") || "none");
console.log("notes              :");
for (const n of r.notes) console.log("   -", n);

console.log("\n################ 2. analyze_image_structured, contrast question ################");
const s = await call("analyze_image_structured", {
  image_source: dataUri,
  prompt: "Are there any accessibility or contrast problems in this image?",
});
console.log("answered_by        :", s.answered_by);
console.log("model_consulted    :", s.model_consulted);
const sc = s.measurements?.contrast;
console.log("failing_count      :", sc?.failing_count, "| all_meet_aa:", sc?.all_meet_aa, "| worst:", sc?.worst?.contrast_ratio);
console.log("failing colours    :", sc?.colours?.filter((x) => !x.wcag_aa).map((x) => `${x.foreground}@${x.contrast_ratio}`).join(", "));
console.log("abstained          :", (s.abstained || []).map((a) => a.question).join(" | "));

console.log("\n################ 3. §3.5 text_items vs ocr_only consistency ################");
const t = await call("analyze_image_structured", {
  image_source: dataUri,
  prompt: "Transcribe every string you can read in this image.",
  cross_validate: true,
});
console.log("text_items count   :", (t.text_items || []).length);
console.log("text_items sources :", JSON.stringify(t.cross_validation?.text_items_sources));
console.log("ocr_only count     :", t.cross_validation?.ocr_only_count);
console.log("text_items         :", (t.text_items || []).map((x) => `${x.text}[${x.source}]`).join(", ") || "(none)");
console.log("unreadable         :", JSON.stringify(t.unreadable));

console.log("\n################ 4. §1 regression spot-checks ################");
const bx = await call("measure_image", { image_source: dataUri, mode: "boxes", box_color: "#4a433c" });
console.log("box count          :", bx.measurements.boxes.count);
const bravo = await call("measure_image", {
  image_source: dataUri, mode: "contrast", region: { left: 30, top: 96, width: 230, height: 52 },
});
console.log("tight BRAVO worst  :", bravo.measurements.contrast.worst.contrast_ratio, "| best:", bravo.measurements.contrast.best.contrast_ratio, "| aa:", bravo.measurements.contrast.wcag_aa);
const h = await callText("check_vision_health", {});
console.log("health has residency:", /Resident Now/.test(h));

await client.close();
