import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildFixturePng, getGroundTruth, CROP_REGION, BOX_BORDER_COLOR } from "../lib/fixtures.js";

const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");
const gt = getGroundTruth();
const client = new Client({ name: "real", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:11499/mcp")));

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  return { ms: Date.now() - t0, text: r.content[0].text };
};

console.log("########## F4: quantitative contrast question (must be measured, not guessed) ##########");
{
  const { ms, text } = await call("analyze_image", {
    image_source: dataUri,
    prompt: "Does all text have sufficient contrast against its dark background?",
  });
  const j = JSON.parse(text);
  console.log(`took ${ms}ms | answered_by=${j.answered_by} | model_consulted=${j.model_consulted}`);
  console.log("whole-image contrast measurement:", JSON.stringify(j.measurements?.contrast ? {
    ratio: j.measurements.contrast.contrast_ratio, wcag_aa: j.measurements.contrast.wcag_aa } : null));
  console.log("-> VERDICT:", j.model_consulted === false ? "PASS: no model guessed a number" : "FAIL");
}

console.log("\n########## F3: crop awareness (tab text outside crop must not appear) ##########");
{
  const full = await call("analyze_image_structured", {
    image_source: dataUri,
    prompt: "Transcribe every string you can read in this image.",
    model: "llava:13b",
    timeout_ms: 240000,
  });
  const jf = JSON.parse(full.text);
  console.log(`full-image: took ${full.ms}ms parsed=${jf.parsed}`);
  const fullTexts = (jf.text_items||[]).map(t=>`${t.text}[${t.source}]`);
  console.log("full-image text_items:", fullTexts.join(", ") || "(none)");
  console.log("full-image unverified:", (jf.cross_validation?.unverified_text||[]).map(t=>t.text).join(", ") || "(none)");
  console.log("provenance model:", jf.provenance?.model, "| sent:", JSON.stringify(jf.provenance?.image?.sent_dimensions));

  const cropped = await call("analyze_image_structured", {
    image_source: dataUri,
    prompt: "Transcribe every string you can read.",
    model: "llava:13b",
    crop: CROP_REGION,
    timeout_ms: 240000,
  });
  const jc = JSON.parse(cropped.text);
  const cropTexts = (jc.text_items||[]).map(t=>`${t.text}[${t.source}]`);
  console.log(`crop ${CROP_REGION.width}x${CROP_REGION.height}: took ${cropped.ms}ms`);
  console.log("cropped text_items:", cropTexts.join(", ") || "(none)");
  const leaked = (jc.text_items||[]).filter(t => /echo|foxtrot|golf|alpha|bravo|charlie|hotel|internal|external/i.test(t.text));
  console.log("LEAKED outside-crop text:", leaked.length ? leaked.map(t=>`${t.text}[${t.source}]`).join(", ") : "none");
  console.log("-> VERDICT:", leaked.length === 0 ? "PASS: nothing from outside the crop surfaced" : "INVESTIGATE");
}

console.log("\n########## F1/F2: fabrication flagging (unverified_text must exist if the model invents) ##########");
{
  const { text } = await call("analyze_image_structured", {
    image_source: dataUri,
    prompt: "Describe the icons and glyphs in this image in detail.",
    model: "llava:13b",
    timeout_ms: 240000,
  });
  const j = JSON.parse(text);
  console.log("parsed:", j.parsed);
  console.log("claims:", (j.claims||[]).length, "| unsupported:", (j.unsupported_claims||[]).length);
  console.log("abstained:", (j.abstained||[]).map(a=>a.question).join(" | ") || "(none)");
  console.log("unverified_text:", (j.cross_validation?.unverified_text||[]).map(t=>t.text).join(", ") || "(none)");
  console.log("agreement_rate:", j.cross_validation?.agreement_rate);
  console.log("warnings:", (j.warnings||[]).slice(0,3).join(" || "));
}

await client.close();
