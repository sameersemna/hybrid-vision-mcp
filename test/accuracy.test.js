// ==========================================
// Accuracy acceptance tests.
// ==========================================
// These are the ten required tests from the hardening brief. They run with
// `node --test` (the existing `npm test` command). They do not require an
// external server on a fixed port: every model interaction is served by a
// local mock on an ephemeral port, and the deterministic tests call library
// code directly.
//
// Test #1 uses real Tesseract; everything else is fast.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { assertFixtureTruth, buildFixturePng, getGroundTruth, CROP_REGION, BOX_BORDER_COLOR, ONLY_BOX_WITH_PLUS, BOX_SPECS } from "../lib/fixtures.js";
import { measureImage, analyzeStructured } from "../lib/analyze.js";
import { crossValidateText } from "../lib/crossvalidate.js";
import { runOcrWithBoxes } from "../lib/ocr.js";
import { CLAIM_SCHEMA, detectQuantitativeQuestion, GROUNDING_PREAMBLE } from "../lib/prompts.js";
import { queryOllamaStructured, extractJson } from "../lib/vision.js";
import { contrastInRegion, loadPixels, findColorBoxes, isBoxInsideCrop } from "../lib/measure.js";
import { contrastRatio, parseColor, roundRatio } from "../lib/color.js";

// ---------------------------------------------------------------- helpers ---

/** Start a mock Ollama server. `handler` receives (req, res, body). */
async function startMockOllama(handler) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [
          { name: "llava:13b", capabilities: ["vision"], size: 8e9, details: {} },
        ] }));
      }
      if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "llava:13b", size_vram: 8e9 }] }));
      }
      if (req.url === "/api/generate") {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        captured.push(parsed);
        return handler(req, res, parsed);
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, captured, close: () => new Promise((r) => server.close(r)) };
}

/** A handler that streams a well-formed schema response. */
function streamJson(payload) {
  return (req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const s = JSON.stringify(payload);
    const half = Math.ceil(s.length / 2);
    res.write(JSON.stringify({ response: s.slice(0, half), done: false }) + "\n");
    res.write(JSON.stringify({ response: s.slice(half), done: true, eval_count: 10, load_duration: 1e6, eval_duration: 2e6 }) + "\n");
    res.end();
  };
}

/** Stub OCR that returns a fixed word set (keeps cross-validation fast/deterministic). */
const stubOcr = (words, text) => async () => ({
  data: {
    text: text ?? words.map((w) => w.text).join(" "),
    confidence: 90,
    blocks: [{ paragraphs: [{ lines: [{ text: text ?? words.map((w) => w.text).join(" "), words: words.map((w) => ({
      text: w.text, confidence: w.confidence ?? 90, bbox: { x0: w.left, y0: w.top, x1: w.left + w.width, y1: w.top + w.height },
    })) }] }] }],
  },
});

/** Find an unused port, then release it, so we can guarantee a refused connection. */
async function getClosedPort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ------------------------------------------------- test 0: fixture truth ----

test("fixture ground truth is asserted before any test relies on it", async () => {
  const report = await assertFixtureTruth();
  assert.equal(report.ok, true, "fixture must agree with its declared ground truth");
  const gt = getGroundTruth();
  assert.equal(gt.only_box_with_plus, "ECHO");
  assert.equal(gt.box_count, 4);
});

// -------------------------------------------- test 1: fixture transcription ---

test("1. fixture transcription: legible text read, low-contrast text flagged, invisible text absent", async () => {
  const png = await buildFixturePng();
  const gt = getGroundTruth();

  // (a) Real OCR transcribes the legible high-contrast lines.
  const ocr = await runOcrWithBoxes(png, "eng");
  const norm = (s) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const flat = norm(ocr.text);
  assert.ok(flat.includes(norm("ALPHA-ONE")), `OCR should read ALPHA-ONE (got: ${JSON.stringify(ocr.text)})`);
  assert.ok(flat.includes(norm("CHARLIE-THREE-8g7x2")), `OCR should read CHARLIE-THREE-8g7x2 (got: ${JSON.stringify(ocr.text)})`);

  // (b) The invisible string must NOT be reported as text (real OCR omits it).
  assert.ok(!flat.includes(norm("HOTELFIVEINVISIBLE")), "invisible text must not be transcribed");

  // (c) The low-contrast string must be flagged low contrast by MEASUREMENT
  //     (OCR gives no contrast signal, so this is the only sound source).
  const pixels = await loadPixels(png);
  const bravo = gt.text.find((t) => t.id === "bravo");
  const m = contrastInRegion(pixels, bravo.region, { tolerance: bravo.contrast_tolerance });
  assert.ok(m.measurable, "low-contrast region must be measurable");
  assert.ok(Math.abs(m.contrast_ratio - 2.14) < 0.2, `expected ~2.14, got ${m.contrast_ratio}`);
  assert.equal(m.wcag_aa, false, "2.14:1 must fail WCAG AA");
});

// ------------------------------------------------------ test 2: box count ---

test("2. box count: exactly 4 boxes, and ECHO is the only box containing '+'", async () => {
  const png = await buildFixturePng();
  const m = await measureImage({ imageBuffer: png, mode: "boxes", boxColor: BOX_BORDER_COLOR });
  assert.equal(m.measurements.boxes.count, 4, "exactly four boxes");

  const pixels = await loadPixels(png);
  const gt = getGroundTruth();
  const plus = findColorBoxes(pixels, {
    color: gt.plus_marker_color, tolerance: 30, minArea: 20, minWidth: 5, minHeight: 5,
  });
  assert.equal(plus.count, 1, "exactly one '+' marker");
  const c = plus.boxes[0];
  const owner = BOX_SPECS.find((b) => c.cx >= b.x && c.cx <= b.x + b.width && c.cy >= b.y && c.cy <= b.y + b.height);
  assert.ok(owner, "the '+' must lie inside a box");
  assert.equal(owner.label, ONLY_BOX_WITH_PLUS);
});

// ------------------------------------- test 3: crop marker (F3 signature) ----

test("3. crop awareness: text outside the crop is flagged unverified (F3)", async () => {
  const png = await buildFixturePng();

  const mock = await startMockOllama(streamJson({
    summary: "cropped",
    claims: [],
    text_items: [
      { text: "DELTA", box: { left: 28, top: 35, width: 90, height: 30 }, confidence: 0.9 },
      { text: "Internal", box: { left: 900, top: 700, width: 80, height: 20 }, confidence: 0.8 },
    ],
    abstained: [],
  }));

  const result = await analyzeStructured({
    imageBuffer: png,
    prompt: "Transcribe the text",
    model: "llava:13b",
    ollamaHost: `http://127.0.0.1:${mock.port}`,
    crop: CROP_REGION,
    recognizeFn: stubOcr([{ text: "DELTA", left: 28, top: 35, width: 90, height: 30 }]),
  });
  await mock.close();

  // The crop was physically applied...
  assert.ok(result.crop_applied, "crop must be applied");
  assert.equal(result.crop_applied.width, CROP_REGION.width);

  // ...so the model received the cropped image, and "Internal" (which does not
  // exist inside the crop) is flagged as unverified rather than reported.
  const internal = result.text_items.find((t) => t.text === "Internal");
  assert.ok(internal, "the bogus item is retained for inspection");
  assert.equal(internal.source, "unverified", "'Internal' has no OCR support and no plausible box");
  assert.ok(internal.flags.includes("outside_crop"), "must be flagged as outside the crop");
  assert.ok(result.cross_validation.unverified_count >= 1);

  const delta = result.text_items.find((t) => t.text === "DELTA");
  assert.equal(delta.source, "vl+ocr", "DELTA is corroborated by OCR");

  // Direct containment check for the pure helper.
  const outside = isBoxInsideCrop(CROP_REGION, { left: 900, top: 700, width: 80, height: 20 });
  assert.equal(outside.inside, false);
});

// ------------------------------------- test 4: contrast ratio (F4) ----------

test("4. contrast ratio is measured as ~2.14 with wcag_aa false (F4)", async () => {
  const png = await buildFixturePng();
  const gt = getGroundTruth();
  const bravo = gt.text.find((t) => t.id === "bravo");

  const m = await measureImage({
    imageBuffer: png,
    mode: "contrast",
    region: bravo.region,
    backgroundColor: gt.background,
  });
  assert.ok(Math.abs(m.measurements.contrast.contrast_ratio - 2.14) < 0.2);
  assert.equal(m.measurements.contrast.wcag_aa, false);
  assert.equal(m.measurements.contrast.required_aa, 4.5);
  assert.equal(m.measurements.contrast.measurable, true);

  // And the same conclusion is reached with no model in the loop at all.
  assert.match(m.disclaimer, /deterministic/i, "measurement must be labelled as model-independent");
});

// ------------- test 5: quantitative succeeds with the model unavailable -----

test("5. quantitative answers still succeed with the model entirely unavailable", async () => {
  const png = await buildFixturePng();
  const deadPort = await getClosedPort();
  const deadHost = `http://127.0.0.1:${deadPort}`;

  // Confirm the host really is unreachable.
  await assert.rejects(() => fetch(`${deadHost}/api/tags`), "the test host must be closed");

  const gt = getGroundTruth();
  const bravo = gt.text.find((t) => t.id === "bravo");

  const result = await analyzeStructured({
    imageBuffer: png,
    prompt: "What is the contrast ratio of the text?",
    model: "llava:13b",
    ollamaHost: deadHost, // model is DOWN
    timeoutMs: 5000,
  });

  assert.equal(result.success, true, "must succeed without the model");
  assert.equal(result.model_consulted, false, "the model must not be consulted for a quantitative question");
  assert.equal(result.answered_by, "deterministic-measurement");
  assert.ok(result.measurements, "measurements must be present");
  assert.ok(result.measurements.contrast.contrast_ratio > 1, "a real ratio must be returned");

  // Also true for the legacy tool path via measureImage.
  const direct = await measureImage({ imageBuffer: png, mode: "contrast", region: bravo.region, backgroundColor: gt.background });
  assert.ok(Math.abs(direct.measurements.contrast.contrast_ratio - 2.14) < 0.2);
});

// ------------------------------------- test 6: schema validity --------------

test("6. schema validity: request is constrained and response matches the claim schema", async () => {
  const png = await buildFixturePng();
  const mock = await startMockOllama(streamJson({
    summary: "A fixture",
    claims: [{ claim: "There are four boxes", kind: "count", confidence: 0.8, evidence: "borders visible" }],
    text_items: [{ text: "ALPHA-ONE", box: { left: 40, top: 40, width: 200, height: 40 }, confidence: 0.9 }],
    abstained: [{ question: "exact font size", reason: "not determinable from pixels alone" }],
  }));

  const result = await analyzeStructured({
    imageBuffer: png,
    prompt: "Describe the image",
    model: "llava:13b",
    ollamaHost: `http://127.0.0.1:${mock.port}`,
    recognizeFn: stubOcr([{ text: "ALPHA-ONE", left: 40, top: 40, width: 200, height: 40 }]),
  });
  await mock.close();

  // The outgoing request must carry the JSON schema, pinned sampling, streaming.
  const req = mock.captured[0];
  assert.ok(req, "a request must have been sent");
  assert.equal(req.format.type, "object", "format must be a JSON schema object");
  assert.ok(req.format.properties.claims, "schema must declare claims[]");
  assert.ok(req.format.properties.abstained, "schema must declare abstained[]");
  assert.equal(req.options.temperature, 0, "temperature must be pinned to 0");
  assert.equal(typeof req.options.seed, "number", "a seed must be set");
  assert.equal(req.stream, true, "streaming enables load-vs-infer detection");

  // The response must be parsed and shaped per the schema.
  assert.equal(result.parsed, true);
  assert.ok(Array.isArray(result.claims));
  assert.ok(Array.isArray(result.abstained));
  assert.equal(typeof result.summary, "string");
  // Every claim carries its own justification.
  for (const c of result.claims) {
    assert.ok(typeof c.claim === "string");
    assert.ok(typeof c.confidence === "number");
    assert.ok(c.source, "claims must carry a source");
  }
  // The schema we send is the same one the prompt references.
  assert.ok(GROUNDING_PREAMBLE.includes("abstain"));
  assert.equal(CLAIM_SCHEMA.required.includes("abstained"), true);
});

// ------------------------------------- test 7: abstention ------------------

test("7. abstention is first-class and fabrication is refused", async () => {
  const png = await buildFixturePng();

  // (a) A model that abstains must have that surfaced.
  const mock = await startMockOllama(streamJson({
    summary: "Not enough information",
    claims: [],
    text_items: [],
    abstained: [{ question: "How many buttons?", reason: "no buttons visible" }],
  }));
  const r1 = await analyzeStructured({
    imageBuffer: png, prompt: "How many buttons?", model: "llava:13b",
    ollamaHost: `http://127.0.0.1:${mock.port}`,
    // "How many buttons?" is quantitative, so this path short-circuits without
    // calling the model — assert that explicitly instead.
    crossValidate: false,
  });
  await mock.close();
  assert.equal(r1.model_consulted, false);
  assert.ok(r1.abstained.length >= 1, "abstention must be reported");

  // (b) A model that returns unparseable prose must yield NO claims.
  const mock2 = await startMockOllama((req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ response: "I think there are some arrows pointing up and down.", done: true }) + "\n");
    res.end();
  });
  const r2 = await analyzeStructured({
    imageBuffer: png, prompt: "Describe the visual style", model: "llava:13b",
    ollamaHost: `http://127.0.0.1:${mock2.port}`,
    recognizeFn: stubOcr([]),
  });
  await mock2.close();

  assert.equal(r2.parsed, false, "unparseable output must be marked as such");
  assert.equal(r2.claims.length, 0, "no claims may be fabricated from prose");
  assert.ok(r2.warnings.some((w) => /could not be parsed/i.test(w)), "a warning must explain the refusal");
  assert.ok(r2.raw_model_output, "the raw output is retained for inspection");
});

// ------------------------------------- test 8: provenance ------------------

test("8. provenance: model, options, real dimensions sent, and warnings are reported", async () => {
  const png = await buildFixturePng();
  const mock = await startMockOllama(streamJson({ summary: "ok", claims: [], text_items: [], abstained: [] }));
  const result = await analyzeStructured({
    imageBuffer: png, prompt: "Describe the image", model: "llava:13b",
    ollamaHost: `http://127.0.0.1:${mock.port}`,
    recognizeFn: stubOcr([]),
  });
  await mock.close();

  const p = result.provenance;
  assert.ok(p, "provenance must be present");
  assert.equal(p.model, "llava:13b");
  assert.equal(p.options.temperature, 0);
  assert.equal(typeof p.options.seed, "number");
  assert.ok(p.image, "image provenance must be present");
  assert.equal(p.image.input_dimensions.width, 1200);
  assert.equal(p.image.input_dimensions.height, 760);
  assert.equal(p.image.sent_dimensions.width, 1200, "no silent downscale: sent == input by default");
  assert.equal(p.image.downscaled, false);
  assert.equal(p.image.coordinate_space, "sent_dimensions");
  assert.ok(Array.isArray(p.warnings));
  assert.ok(p.metrics, "timing metrics must be reported");
  assert.equal(typeof p.metrics.time_to_first_token_ms, "number");

  // The downscale path, when explicitly requested, is reported rather than silent.
  const { prepareForVision } = await import("../lib/legibility.js");
  const shrunk = await prepareForVision(png, { maxDimension: 300 });
  assert.equal(shrunk.report.downscaled, true);
  assert.ok(shrunk.report.sent_dimensions.width <= 300);
  assert.ok(shrunk.report.warnings.some((w) => /downscaled/i.test(w)));
});

// ------------------------------------- test 9: determinism -----------------

test("9. determinism: identical inputs give byte-identical measurements, and sampling is pinned", async () => {
  const png = await buildFixturePng();
  const gt = getGroundTruth();
  const bravo = gt.text.find((t) => t.id === "bravo");

  const a = await measureImage({ imageBuffer: png, mode: "all", region: bravo.region, backgroundColor: gt.background });
  const b = await measureImage({ imageBuffer: png, mode: "all", region: bravo.region, backgroundColor: gt.background });
  assert.deepEqual(a.measurements.contrast, b.measurements.contrast, "measurement must be reproducible");
  assert.deepEqual(a.measurements.colors, b.measurements.colors);

  // The model contract is deterministic by construction: temperature 0 + seed.
  const mock = await startMockOllama(streamJson({ summary: "x", claims: [], text_items: [], abstained: [] }));
  await queryOllamaStructured({
    model: "llava:13b", prompt: "p", images: [png], schema: CLAIM_SCHEMA,
    ollamaHost: `http://127.0.0.1:${mock.port}`, seed: 42, temperature: 0,
  });
  await mock.close();
  const req = mock.captured[0];
  assert.equal(req.options.temperature, 0);
  assert.equal(req.options.seed, 42);
  assert.equal(req.stream, true);
});

// ------------------------------------- test 10: fast actionable timeout ----

test("10. timeout is fast, explains residency, and names models that actually exist", async () => {
  const png = await buildFixturePng();

  // A mock that accepts the connection then never responds.
  const mock = await startMockOllama(() => { /* hold the request open */ });

  const started = Date.now();
  let error = null;
  try {
    await queryOllamaStructured({
      model: "llava:13b",
      prompt: "test",
      images: [png],
      schema: CLAIM_SCHEMA,
      ollamaHost: `http://127.0.0.1:${mock.port}`,
      timeoutMs: 1200,
    });
  } catch (e) {
    error = e;
  }
  const elapsed = Date.now() - started;
  await mock.close();

  assert.ok(error, "a timeout must be raised");
  assert.equal(error.code, "OLLAMA_TIMEOUT");
  assert.ok(elapsed < 5000, `must fail fast (took ${elapsed}ms)`);
  assert.ok(error.message.includes("llava:13b"), "must name the model");
  assert.match(error.message, /resident|NOT resident/i, "must report residency");
  assert.match(error.message, /installed on this host/i, "hint must reflect installed models");
  // The old hardcoded "try llava:7b" hint (a model that is not installed) must be gone.
  assert.ok(!/llava:7b/.test(error.message), "must not suggest a model that is not installed");
  // Rich details are attached for programmatic handling.
  assert.ok(error.details.residencyBefore, "residency snapshot must be attached");
  assert.equal(typeof error.details.timeoutMs, "number");
});

// ------------------------------------- extras: helpers ---------------------

test("extractJson survives thinking models and fenced output", () => {
  assert.deepEqual(extractJson('<think>hmm</think>{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJson('prose {"a":[1,2]} trailing').value, { a: [1, 2] });
  assert.equal(extractJson("no json here"), null);
});

test("detectQuantitativeQuestion distinguishes measurable from descriptive prompts", () => {
  assert.equal(detectQuantitativeQuestion("Does all text have sufficient contrast?").quantitative, true);
  assert.equal(detectQuantitativeQuestion("How many cards are shown?").quantitative, true);
  assert.equal(detectQuantitativeQuestion("What colour is the header?").quantitative, true);
  assert.equal(detectQuantitativeQuestion("Describe the overall visual style").quantitative, false);
});

test("WCAG maths matches the fixture's declared ground truth", () => {
  const bg = parseColor("#1a1814");
  assert.equal(roundRatio(contrastRatio(parseColor("#E8DFD0"), bg)), 13.42);
  assert.equal(roundRatio(contrastRatio(parseColor("#484f58"), bg)), 2.14);
  assert.equal(roundRatio(contrastRatio(parseColor("#A09588"), bg)), 6.03);
  assert.equal(roundRatio(contrastRatio(parseColor("#1e1c18"), bg)), 1.04);
});

test("cross-validation flags the fabrication signature (no OCR support, no plausible box)", () => {
  const cv = crossValidateText({
    vlText: [{ text: "Internal", box: null, confidence: 0.9 }],
    ocrWords: [],
    ocrText: "",
  });
  assert.equal(cv.items[0].source, "unverified");
  assert.ok(cv.items[0].flags.includes("no_ocr_support"));
  assert.ok(cv.unverified_count === 1);
});
