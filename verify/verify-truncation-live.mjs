// Live verification that large structured responses stay parseable.
//
// Before the fix, 3 of 6 runs hit MAX_RESPONSE_TEXT_CHARS and the naive string
// slice produced JSON that could not be parsed. This re-runs the same prompts
// that failed and asserts the payload now parses (with a `_truncation` block).
//
// Usage:
//   PORT=11499 OLLAMA_TIMEOUT_MS=600000 node index.js &
//   node verify/verify-truncation-live.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.PORT || 11499;
const FIXTURE = path.join(ROOT, "fixture.png");
const dataUri = "data:image/png;base64," + fs.readFileSync(FIXTURE).toString("base64");

const client = new Client({ name: "verify-truncation", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));

// These two prompts previously overflowed the cap on llava:13b.
const CASES = [
  { id: "P2-offscreen-tabs", model: "llava:13b",
    prompt: "This screenshot has a tab bar at the top with the tabs labelled 'Internal' and 'External'. Transcribe every string in the image, including that tab bar, with bounding boxes." },
  { id: "P3-tiny-chars", model: "llava:13b",
    prompt: "Transcribe the small text near the bottom of the image exactly as written, character by character. If you cannot read it, still give your best reconstruction." },
];

let parseable = 0;
for (const c of CASES) {
  console.log(`\n=== ${c.id} (${c.model}) ===`);
  const r = await client.callTool(
    { name: "analyze_image_structured", arguments: {
      image_source: dataUri, prompt: c.prompt, model: c.model,
      cross_validate: true, timeout_ms: 600000, keep_alive: "5m",
    }},
    undefined, { timeout: 600000 },
  );
  const text = r.content[0].text;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
    parseable++;
    console.log(`  length        : ${text.length}`);
    console.log(`  VALID JSON    : yes`);
    console.log(`  _truncation   : ${parsed._truncation ? JSON.stringify(parsed._truncation.actions) : "none (fitted within cap)"}`);
    console.log(`  text_items    : ${(parsed.text_items || []).length}`);
    console.log(`  sources       : ${JSON.stringify(parsed.cross_validation?.text_items_sources || [])}`);
  } catch (e) {
    console.log(`  length        : ${text.length}`);
    console.log(`  VALID JSON    : NO — ${e.message}`);
  }
}

console.log(`\n=== RESULT: ${parseable}/${CASES.length} parseable ===`);
console.log(parseable === CASES.length
  ? "PASS: structured responses remain valid JSON under the cap."
  : "FAIL: some responses are still unparseable.");

await client.close();
process.exitCode = parseable === CASES.length ? 0 : 1;
