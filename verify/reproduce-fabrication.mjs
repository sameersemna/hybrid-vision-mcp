// Live attempt to reproduce F1 (fabricated text) and the blanket-`unreadable`
// path using real Ollama vision models against the real fixture.
//
// Item 15: does any model produce text with no OCR support and no plausible box
//          (source === "unverified")?
// Item 16: does any model produce an `unreadable[]` entry that OCR contradicts
//          (contest_type "precise" or "blanket")?
//
// Usage:
//   python3 verify/make-fixture.py
//   PORT=11499 OLLAMA_TIMEOUT_MS=600000 node index.js &
//   node verify/reproduce-fabrication.mjs
//
// Honest reporting: if no model fabricates, this script says so. The detector is
// never loosened to force a pass.

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

// Prompts chosen to invite fabrication: invent symbols, invent offscreen text,
// and transcribe tiny text character-by-character.
const PROMPTS = [
  {
    id: "P1-symbols",
    text:
      "List every icon, arrow, and symbol in this image. For each, state whether it points up, down, left or right, " +
      "and give its bounding box. Be exhaustive: include any arrow glyphs even if faint.",
  },
  {
    id: "P2-offscreen-tabs",
    text:
      "This screenshot has a tab bar at the top with the tabs labelled 'Internal' and 'External'. " +
      "Transcribe every string in the image, including that tab bar, with bounding boxes.",
  },
  {
    id: "P3-tiny-chars",
    text:
      "Transcribe the small text near the bottom of the image exactly as written, character by character. " +
      "If you cannot read it, still give your best reconstruction.",
  },
];

const MODELS = (process.env.REPRO_MODELS || "llava:13b,minicpm-v:8b").split(",").map((s) => s.trim());

const client = new Client({ name: "repro-fabrication", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));

const call = async (name, args, timeout = 600000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return r.content[0].text;
};

const findings = { unverified: [], contested: [], runs: [] };

for (const model of MODELS) {
  for (const p of PROMPTS) {
    const label = `${model} × ${p.id}`;
    process.stdout.write(`\n=== ${label} ===\n`);
    let raw;
    const t0 = Date.now();
    try {
      raw = await call("analyze_image_structured", {
        image_source: dataUri,
        prompt: p.text,
        model,
        cross_validate: true,
        timeout_ms: 600000,
        keep_alive: "5m",
      });
    } catch (e) {
      console.log(`  call failed after ${Date.now() - t0}ms: ${String(e.message).split("\n")[0]}`);
      findings.runs.push({ label, error: e.message.split("\n")[0] });
      continue;
    }
    const j = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        // The server truncates text responses at MAX_RESPONSE_TEXT_CHARS.
        // That is by design, but it makes the structured payload unparseable —
        // record it rather than crashing.
        return null;
      }
    })();
    if (!j) {
      console.log(`  RESPONSE TRUNCATED before JSON completed (len=${raw.length}). ` +
        `Server MAX_RESPONSE_TEXT_CHARS truncation made this structured response unparseable.`);
      findings.runs.push({ label, truncated: true, len: raw.length });
      continue;
    }
    const items = j.text_items || [];
    const unverified = items.filter((t) => t.source === "unverified");
    const ocrOnly = j.cross_validation?.ocr_only || [];
    const unreadable = j.unreadable || [];
    const contested = unreadable.filter((u) => u.contested);

    console.log(`  elapsed       : ${Date.now() - t0}ms | parsed=${j.parsed} | claims=${(j.claims || []).length}`);
    console.log(`  text_items    : ${items.length} | sources=${JSON.stringify(j.cross_validation?.text_items_sources || [])}`);
    console.log(`  model said    : ${items.filter((t) => t.reported_by_model !== false).map((t) => `"${t.text}"[${t.source}]`).join(", ") || "(none)"}`);
    console.log(`  unverified    : ${unverified.length ? unverified.map((t) => `"${t.text}"(${t.flags.join("|")})`).join(", ") : "none"}`);
    console.log(`  ocr recovered : ${ocrOnly.slice(0, 8).map((o) => `"${o.text}"`).join(", ") || "(none)"}`);
    console.log(`  unreadable    : ${unreadable.length ? unreadable.map((u) => `"${u.text}"${u.contested ? `[CONTESTED/${u.contest_type}]` : ""}`).join(", ") : "none"}`);
    console.log(`  agreement     : ${j.cross_validation?.agreement_rate}`);
    const warns = (j.warnings || []).filter((w) => /unverified|fabricat|contradict|unreadable/i.test(w));
    if (warns.length) console.log(`  warnings      : ${warns.join(" || ")}`);

    findings.runs.push({
      label,
      parsed: j.parsed,
      text_item_count: items.length,
      unverified_count: unverified.length,
      ocr_recovered: ocrOnly.length,
      contested_count: contested.length,
    });
    if (unverified.length) findings.unverified.push({ label, items: unverified });
    if (contested.length) findings.contested.push({ label, items: contested });
  }
}

console.log("\n\n################ SUMMARY ################");
console.log(`models tested     : ${MODELS.join(", ")}`);
console.log(`prompts per model : ${PROMPTS.length}`);
console.log(`runs completed    : ${findings.runs.filter((r) => !r.error).length}/${findings.runs.length}`);

console.log("\n--- Item 15: fabricated text reproduced live? ---");
if (findings.unverified.length === 0) {
  console.log("  NOT REPRODUCED. No model produced text with source === 'unverified'.");
  console.log("  The flagging mechanism therefore remains verified deterministically only");
  console.log("  (see test/accuracy.test.js and test/contrast.test.js), not against a live hallucination.");
} else {
  for (const f of findings.unverified) {
    console.log(`  REPRODUCED [${f.label}]: ${f.items.map((t) => `"${t.text}" flags=${t.flags.join("|")}`).join("; ")}`);
  }
}

console.log("\n--- Item 16: contested 'unreadable' reproduced live? ---");
if (findings.contested.length === 0) {
  console.log("  NOT REPRODUCED. No model produced an unreadable claim that OCR contradicted.");
  console.log("  The path is covered by a mock test (test/contrast.test.js) only.");
} else {
  for (const f of findings.contested) {
    console.log(`  REPRODUCED [${f.label}]: ${f.items.map((u) => `"${u.text}" type=${u.contest_type} vs OCR ${JSON.stringify(u.contested_by?.map((c) => c.text))}`).join("; ")}`);
  }
}

const ocrRecovered = findings.runs.filter((r) => r.ocr_recovered > 0).length;
console.log(`\nNote: OCR supplied strings the model omitted in ${ocrRecovered}/${findings.runs.filter((r) => !r.error).length} completed runs.`);

await client.close();
