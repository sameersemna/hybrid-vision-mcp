// ==========================================
// Contrast enumeration acceptance tests.
// ==========================================
// Regression suite for the defect where contrast reported only the *most
// legible* colour, so an image containing large text at 2.14:1 and 1.04:1 was
// summarised as `wcag_aa: true` — i.e. "no problems".
//
// Ground truth is the fixture from the hardening brief. It is rendered here
// with sharp/SVG rather than PIL so the suite is dependency-free, and the
// generator below mirrors the brief's geometry and fill colours exactly. The
// enumeration is renderer-independent (an explicit anti-aliasing merge pass
// makes it so), which is why a sharp fixture reproduces the PIL fixture's
// numbers. `verify/verify-real-contrast.mjs` additionally checks the PIL
// fixture end-to-end against a live server.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import sharp from "sharp";

import { loadPixels, contrastInRegion, enumerateRegionContrast, findColorBoxes, isAntiAliasingBlend } from "../lib/measure.js";
import { contrastRatio, parseColor, roundRatio } from "../lib/color.js";
import { measureImage, analyzeStructured } from "../lib/analyze.js";

// ------------------------------------------------------------- fixture ------

export const FIXTURE = {
  width: 900,
  height: 420,
  background: "#1a1814",
  colours: {
    heading: "#e8dfd0", // 13.42  pass
    bravo: "#484f58",   //  2.14  FAIL  (large text)
    charlie: "#a09588", //  6.03  pass  (13px, small)
    mark: "#7daa7a",    //  6.67  pass
    hotel: "#1e1c18",   //  1.04  FAIL  (near-background)
    border: "#4a433c",  //  1.82  decorative
  },
  expected: {
    "#e8dfd0": 13.42,
    "#a09588": 6.03,
    "#7daa7a": 6.67,
    "#484f58": 2.14,
    "#1e1c18": 1.04,
  },
  // Regions that isolate a single colour, for the tight-region tests.
  regions: {
    bravo: { left: 30, top: 96, width: 230, height: 52 },
    alpha: { left: 30, top: 26, width: 260, height: 52 },
    hotel: { left: 30, top: 372, width: 420, height: 40 },
  },
};

/** Render the brief's fixture via SVG. Mirrors its geometry and colours. */
export async function buildContrastFixture() {
  const { width: W, height: H, background: BG, colours: C } = FIXTURE;
  const box = (i, label) => {
    const x = 30 + i * 215;
    return (
      `<rect x="${x}" y="220" width="190" height="110" fill="none" stroke="${C.border}" stroke-width="2"/>` +
      `<text x="${x + 18}" y="${262}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="${C.heading}">${label}</text>` +
      `<text x="${x + 18}" y="302" font-family="DejaVu Sans, sans-serif" font-size="17" fill="${C.mark}">mark ${i === 1 ? "+" : "-"}</text>`
    );
  };
  const svg =
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="30" y="66" font-family="DejaVu Sans, sans-serif" font-size="40" fill="${C.heading}">ALPHA-ONE</text>` +
    `<text x="30" y="136" font-family="DejaVu Sans, sans-serif" font-size="40" fill="${C.bravo}">BRAVO-TWO</text>` +
    `<text x="30" y="181" font-family="DejaVu Sans, sans-serif" font-size="13" fill="${C.charlie}">CHARLIE-THREE-8g7x2</text>` +
    ["DELTA", "ECHO", "FOXTROT", "GOLF"].map((l, i) => box(i, l)).join("") +
    `<text x="30" y="402" font-family="DejaVu Sans, sans-serif" font-size="30" fill="${C.hotel}">HOTEL-FIVE-INVISIBLE</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** An image whose ONLY text colour comfortably passes AA. */
export async function buildAllPassingFixture() {
  const svg =
    `<svg width="400" height="120" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="400" height="120" fill="#1a1814"/>` +
    `<text x="20" y="70" font-family="DejaVu Sans, sans-serif" font-size="36" fill="#e8dfd0">ONLY PASSES</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const byHex = (colours, hex) => colours.find((c) => c.foreground.toLowerCase() === hex.toLowerCase());

// ------------------------------------------- 1. whole-image enumeration -----

test("1. whole-image contrast enumerates every text colour and reports the worst case", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);

  const r = contrastInRegion(pixels, { left: 0, top: 0, width: FIXTURE.width, height: FIXTURE.height });

  // Headline scalars are the WORST case, not the best.
  assert.equal(r.failing_count, 2, "exactly two text colours fail AA");
  assert.equal(r.all_meet_aa, false, "the image does not meet AA");
  assert.equal(r.wcag_aa, false, "wcag_aa must alias the worst case (not the best)");
  assert.equal(r.worst.contrast_ratio, 1.04, "worst case is the near-invisible text");
  assert.equal(r.best.contrast_ratio, 13.42, "best case is the heading");
  assert.equal(r.contrast_ratio, 1.04, "the legacy scalar must also be the worst case");

  // The failing colours are enumerated, at the reference ratios.
  const bravo = byHex(r.colours, "#484f58");
  const hotel = byHex(r.colours, "#1e1c18");
  assert.ok(bravo, "#484f58 must be enumerated");
  assert.ok(hotel, "#1e1c18 must be enumerated (it is only ~7 units from the background)");
  assert.equal(bravo.contrast_ratio, 2.14);
  assert.equal(bravo.wcag_aa, false);
  assert.equal(bravo.meets_aa, false);
  assert.equal(hotel.contrast_ratio, 1.04);
  assert.equal(hotel.wcag_aa, false);

  // ...and so are the PASSING text colours, so a fix that only hunts for
  // failures (or collapses everything to one boolean) cannot pass this test.
  for (const [hex, expected] of [["#e8dfd0", 13.42], ["#a09588", 6.03], ["#7daa7a", 6.67]]) {
    const c = byHex(r.colours, hex);
    assert.ok(c, `${hex} must be enumerated as a text colour`);
    assert.equal(c.contrast_ratio, expected, `${hex} ratio must match the reference table`);
    assert.equal(c.wcag_aa, true, `${hex} passes AA`);
  }

  // Five text colours total: 3 passing, 2 failing.
  assert.equal(r.evaluated_count, 5);
  assert.equal(r.passing_count, 3);

  // The decorative border must be reported, not silently dropped, and must not
  // be counted as text.
  const borderExcluded = r.excluded.find((e) => e.foreground.toLowerCase() === "#4a433c");
  assert.ok(borderExcluded, "the decorative border must appear in excluded");
  assert.ok(r.notes.some((n) => /decorative/i.test(n)), "exclusion must be disclosed in notes");
});

// ----------------------------------------- 2. tight region, failing colour --

test("2. a tight region containing only #484f58 reports worst == best == 2.14 and fails AA", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);

  const r = contrastInRegion(pixels, FIXTURE.regions.bravo);

  assert.equal(r.worst.contrast_ratio, 2.14);
  assert.equal(r.best.contrast_ratio, 2.14);
  assert.equal(r.worst.foreground.toLowerCase(), "#484f58");
  assert.equal(r.wcag_aa, false);
  assert.equal(r.all_meet_aa, false);
  assert.equal(r.failing_count, 1);
});

// ------------------------------------------- 3. tight region, passing ------

test("3. a tight region containing only #e8dfd0 meets AA", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);

  const r = contrastInRegion(pixels, FIXTURE.regions.alpha);

  assert.equal(r.worst.contrast_ratio, 13.42);
  assert.equal(r.all_meet_aa, true);
  assert.equal(r.wcag_aa, true);
  assert.equal(r.failing_count, 0);
});

// ------------------------------- 4. all-passing image is not hardcoded false

test("4. an image whose only text colour passes AA returns all_meet_aa true", async () => {
  const png = await buildAllPassingFixture();
  const r = await measureImage({
    imageBuffer: png,
    mode: "contrast",
    region: { left: 0, top: 0, width: 400, height: 120 },
  });

  assert.equal(r.measurements.contrast.all_meet_aa, true, "must not be hard-coded false");
  assert.equal(r.measurements.contrast.failing_count, 0);
  assert.equal(r.measurements.contrast.wcag_aa, true);
  assert.ok(r.measurements.contrast.worst.contrast_ratio >= 4.5);
});

// --------------------------- 5. structured tool surfaces the failures ------

test("5. analyze_image_structured exposes failing colours for a contrast question", async () => {
  const png = await buildContrastFixture();

  // Quantitative prompt -> deterministic path, model not consulted (must work
  // with Ollama unavailable).
  const out = await analyzeStructured({
    imageBuffer: png,
    prompt: "Are there any accessibility or contrast problems in this image?",
    model: "unused",
    ollamaHost: "http://127.0.0.1:1", // deliberately unreachable
  });

  assert.equal(out.model_consulted, false, "a contrast question must not consult the model");
  assert.equal(out.answered_by, "deterministic-measurement");

  const contrast = out.measurements.contrast;
  assert.ok(contrast, "measurements.contrast must be present");

  // The single passing ratio must NOT be the whole story.
  assert.equal(contrast.all_meet_aa, false);
  assert.equal(contrast.failing_count, 2);
  assert.equal(contrast.worst.contrast_ratio, 1.04);
  assert.ok(byHex(contrast.colours, "#484f58"));
  assert.ok(byHex(contrast.colours, "#1e1c18"));

  // And the failing colours are stated in the abstained/notes text, so a
  // consumer reading only prose still cannot conclude "no problems".
  const prose = JSON.stringify([...(out.abstained || []), ...(out.observations || [])]);
  assert.match(prose, /2\.14/, "prose must mention the 2.14 failure");
  assert.match(prose, /1\.04/, "prose must mention the 1.04 failure");
});

// ---------------------------------- 6. do not regress the original checks ---

test("6. box counting and single-region contrast still behave exactly as before", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);

  // Box counting is unchanged: four boxes in the border colour.
  const boxes = findColorBoxes(pixels, { color: FIXTURE.colours.border, minArea: 200, minWidth: 40, minHeight: 30 });
  assert.equal(boxes.count, 4, "exactly four boxes");
  // The invariant is even 215px spacing (the stroke is centred on the rect edge,
  // so absolute x depends on the rasteriser; the spacing does not).
  const xs = boxes.boxes.map((b) => b.x).sort((a, b) => a - b);
  assert.equal(xs.length, 4);
  assert.deepEqual(
    xs.slice(1).map((x, i) => x - xs[i]),
    [215, 215, 215],
    "box x coordinates are evenly spaced",
  );

  // The contrast maths is untouched: recompute the reference ratios directly.
  const bg = parseColor(FIXTURE.background);
  for (const [hex, expected] of Object.entries(FIXTURE.expected)) {
    assert.equal(roundRatio(contrastRatio(parseColor(hex), bg)), expected, `${hex} vs background`);
  }

  // A tight region still yields the exact ratio for its own colour.
  const hotel = contrastInRegion(pixels, FIXTURE.regions.hotel);
  assert.equal(hotel.worst.contrast_ratio, 1.04);
});

// --------------------------- anti-aliasing merge (renderer independence) ----

test("anti-aliasing shades merge into their parent colour but never swallow real text", () => {
  const bg = parseColor("#1a1814");
  // A genuine AA fragment of #a09588 (seen from librsvg) must merge.
  assert.equal(isAntiAliasingBlend(parseColor("#787065"), parseColor("#a09588"), bg), true);
  // Real text must NOT merge: #1e1c18 is far too close to the background to be
  // a mid-point blend of anything.
  assert.equal(isAntiAliasingBlend(parseColor("#1e1c18"), parseColor("#484f58"), bg), false);
  // The decorative border is not a blend of a text colour either.
  assert.equal(isAntiAliasingBlend(parseColor("#4a433c"), parseColor("#484f58"), bg), false);
});

test("renderer independence: an equivalent SVG fixture yields the same five colours", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);
  const r = enumerateRegionContrast(pixels, { left: 0, top: 0, width: FIXTURE.width, height: FIXTURE.height });

  assert.equal(r.evaluated_count, 5, "no renderer-specific stray colours");
  assert.equal(r.failing_count, 2);
  for (const hex of Object.keys(FIXTURE.expected)) {
    assert.ok(byHex(r.colours, hex), `${hex} must be present`);
  }
});

// ------------------- §3.5 unreadable provenance + text_items consistency ----

test("§3.5 unreadable[] is labelled by source and contested when OCR contradicts it", async () => {
  // Mock Ollama: the model returns a *blanket* unreadability excuse while OCR
  // successfully reads several strings (the behaviour reported in the brief).
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "mock-vl", size_vram: 1e9 }] }));
      }
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "mock-vl", capabilities: ["vision"], size: 1e9, details: {} }] }));
      }
      if (req.url === "/api/generate") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const payload = JSON.stringify({
          summary: "Some text is present.",
          claims: [],
          text_items: [],
          unreadable: ["The text is too small to read."],
          abstained: [],
        });
        res.write(JSON.stringify({ response: payload, done: true, eval_count: 5 }) + "\n");
        return res.end();
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const png = await buildContrastFixture();

  // Stub OCR that reads four of the box labels at high confidence.
  const recognizeFn = async () => ({
    data: {
      text: "DELTA ECHO FOXTROT GOLF",
      confidence: 93,
      blocks: [{
        paragraphs: [{
          lines: [{
            text: "DELTA ECHO FOXTROT GOLF",
            words: ["DELTA", "ECHO", "FOXTROT", "GOLF"].map((w, i) => ({
              text: w, confidence: 93, bbox: { x0: 30 + i * 215, y0: 240, x1: 90 + i * 215, y1: 262 },
            })),
          }],
        }],
      }],
    },
  });

  try {
    const out = await analyzeStructured({
      imageBuffer: png,
      prompt: "Transcribe every string in this image.",
      model: "mock-vl",
      ollamaHost: `http://127.0.0.1:${port}`,
      recognizeFn,
    });

    // text_items must not be empty while ocr_only is populated.
    assert.ok(out.text_items.length > 0, "text_items must be populated from OCR");
    assert.ok(out.text_items.every((t) => typeof t.source === "string"), "each item must carry a source");
    assert.ok(
      out.text_items.some((t) => t.source === "ocr"),
      "OCR-sourced items must appear in text_items",
    );
    assert.ok(
      out.cross_validation.text_items_count === out.text_items.length,
      "cross_validation must agree with text_items on the count",
    );

    // unreadable[] must be labelled by source and flagged as contested.
    assert.equal(out.unreadable.length, 1);
    const u = out.unreadable[0];
    assert.equal(u.source, "model", "the claim must be attributed to the model");
    assert.equal(u.verified, false, "an unreadability claim is not verified");
    assert.equal(u.contested, true, "OCR read text while the model claimed unreadable");
    assert.ok(Array.isArray(u.contested_by) && u.contested_by.length > 0, "the contradicting OCR evidence must be attached");
    assert.ok(
      out.warnings.some((w) => /unreadable/i.test(w) && /OCR/i.test(w)),
      "a warning must surface the contradiction",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
