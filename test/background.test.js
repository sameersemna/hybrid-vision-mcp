// ==========================================
// Background-mode tests (item 18: ink threshold on photographic images).
// ==========================================
// Evidence-driven follow-up. The measured conclusion (ACCURACY.md §5c) is that
// neither background model is universally correct, so:
//
//   - the DEFAULT stays the global modal colour (correct for flat UI
//     screenshots, and bit-for-bit unchanged for the validated fixture);
//   - a per-tile adaptive "local" mode is available opt-in and handles
//     photographic / gradient / multi-tone images;
//   - the default path emits an honest `background_fit` warning when the global
//     model is inadequate, so a caller is never told a check was sound when its
//     premise did not hold.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

import {
  loadPixels,
  contrastInRegion,
  enumerateRegionContrast,
  extractInkComponents,
  tileBackgroundField,
  assessBackgroundFit,
  looksLikeIndependentText,
  isSuspectedNoiseCluster,
  partitionSuspectedNoise,
  mergeAntiAliasing,
  isAntiAliasingBlend,
} from "../lib/measure.js";
import {
  buildContrastFixture,
  buildPhotographicFixture,
  buildDenseFlatFixture,
  buildGradientTextFixture,
  buildFlatTextFixture,
  FIXTURE,
} from "../test-support/fixtures.mjs";
import { measureImage } from "../lib/analyze.js";
import { rgbDistance, parseColor } from "../lib/color.js";

// ------------------------------------------------------------ helpers ------

// Photographic fixture + text colours come from the shared helper module so
// this file does not duplicate (or re-register) another test file's fixtures.
const PHOTO_REGION = { left: 0, top: 0, width: 700, height: 360 };

/**
 * Counters used to compare background models.
 *
 * Asserting exact hexes is brittle: a 34px glyph over a gradient has a core that
 * differs slightly from the literal fill, and cluster tolerance merges near
 * shades. Measured behaviour (which these helpers encode) is:
 *
 *   global background -> resolves ONE bright tone; the pink mid-tone text
 *                        (~#f2b8b8, ratio ~8.3) is lost because the background
 *                        drifts across the gradient
 *   local background  -> resolves TWO bright tones (white ~14.2 and pink ~8.3)
 *                        plus the dark near-background text
 *
 * The `bright` count is therefore the stable discriminator between the models.
 */
const brightTones = (result) => result.colours.filter((c) => c.contrast_ratio > 6).length;
const failingTones = (result) => result.colours.filter((c) => c.contrast_ratio < 2.5).length;

// --------------------------- 1. flat images are not regressed --------------

test("local background mode is IDENTICAL to global on a flat fixture", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);
  const region = { left: 0, top: 0, width: FIXTURE.width, height: FIXTURE.height };

  const global = contrastInRegion(pixels, region);
  const local = contrastInRegion(pixels, region, { backgroundMode: "local" });

  // The validated numbers must not move.
  assert.equal(global.failing_count, 2);
  assert.equal(global.worst.contrast_ratio, 1.04);
  assert.equal(global.best.contrast_ratio, 13.42);

  const key = (r) => r.colours.map((c) => [c.foreground, c.contrast_ratio]);
  assert.deepEqual(key(local), key(global), "local mode must not change flat-image results");

  // And the reason it does not: flat tiles have zero noise, so the effective
  // threshold collapses to the floor.
  assert.equal(local.median_ink_threshold, 4, "effective threshold must equal the floor on flat input");
  assert.equal(local.background_mode, "local");
});

test("tile background field reports zero noise scale on a flat image", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);
  const field = tileBackgroundField(pixels, 48);
  const at = field.at(100, 100); // inside the flat background area
  assert.equal(at.s, 0, "a flat region must have zero local noise scale");
});

// ------------------- 2. the default path warns honestly --------------------

test("default (global) path warns when a single background cannot explain the image", async () => {
  const png = await buildPhotographicFixture({ noise: 8, text: false });
  const pixels = await loadPixels(png);
  const result = contrastInRegion(pixels, { left: 0, top: 0, width: 700, height: 360 });

  assert.equal(result.background_mode, "global", "the default must remain global");
  assert.ok(result.background_fit, "background_fit must be reported");
  assert.equal(result.background_fit.adequate, false, "a gradient image is not explained by one colour");
  assert.ok(
    result.notes.some((n) => /Background fit warning/i.test(n)),
    "an inadequate background model must be disclosed in notes",
  );
  assert.ok(
    result.notes.some((n) => /background_mode: "local"/.test(n)),
    "the warning must tell the caller how to fix it",
  );
});

test("a flat UI image is NOT warned about", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);
  const fit = assessBackgroundFit(pixels, { left: 0, top: 0, width: FIXTURE.width, height: FIXTURE.height });
  assert.equal(fit.adequate, true, "a flat screenshot is well explained by one background colour");
  assert.equal(fit.warnings.length, 0);
});

// ---------------- 3. opt-in local mode genuinely helps photos --------------

test("local background mode recovers text colours a global background misses", async () => {
  const png = await buildPhotographicFixture({ noise: 8, text: true });
  const pixels = await loadPixels(png);

  const global = contrastInRegion(pixels, PHOTO_REGION);
  const local = contrastInRegion(pixels, PHOTO_REGION, { backgroundMode: "local" });

  const g = brightTones(global);
  const l = brightTones(local);

  // The image has two bright text tones (white #ffffff ~14.2 and pink #f2b8b8
  // ~8.3). A global background resolves only the white one because the
  // background itself drifts across the gradient; the local model recovers both.
  assert.equal(l, 2, `local mode must resolve both bright text tones (got ${l})`);
  assert.equal(g, 1, `global mode is expected to lose one bright tone (got ${g})`);
  assert.ok(l > g, `local mode must beat global on a photographic image (global=${g}, local=${l})`);

  // The effective threshold must actually have adapted, and be disclosed.
  assert.ok(local.median_ink_threshold > 4, "the threshold must scale above the floor on noise");
  assert.equal(typeof local.effective_ink_threshold, "number");

  // Dark text must be reported as a failing colour, not omitted.
  const darkest = local.colours[0];
  assert.ok(darkest.contrast_ratio < 4.5, "the darkest text class must be reported as failing AA");
});

test("local background mode produces no spurious colours on a text-free photo", async () => {
  const png = await buildPhotographicFixture({ noise: 8, text: false });
  const pixels = await loadPixels(png);
  const region = { left: 0, top: 0, width: 700, height: 360 };

  const local = contrastInRegion(pixels, region, { backgroundMode: "local" });
  assert.equal(local.colours.length, 0, "noise alone must not become a reported text colour");
  assert.equal(local.measurable, false, "with nothing assessable the result must abstain");
  assert.ok(local.abstained.length > 0);
});

// ------------------- 4. opt-in is stable across noise levels ---------------

test("local mode recovers known text across a range of noise levels", async () => {
  for (const noise of [3, 8, 16]) {
    const png = await buildPhotographicFixture({ noise, text: true });
    const pixels = await loadPixels(png);
    const local = contrastInRegion(pixels, PHOTO_REGION, { backgroundMode: "local" });
    // Both bright tones plus at least one failing (dark) tone must survive.
    assert.equal(
      brightTones(local),
      2,
      `both bright text tones must survive noise=${noise} (got ${brightTones(local)})`,
    );
    assert.ok(
      failingTones(local) >= 1,
      `dark near-background text must be reported as failing at noise=${noise}`,
    );
  }
});

// ------------------- 5. the mode is configurable and reported --------------

test("background mode, tile size and noise factor are configurable and echoed", async () => {
  const png = await buildPhotographicFixture({ noise: 8, text: true });
  const pixels = await loadPixels(png);
  const region = { left: 0, top: 0, width: 700, height: 360 };

  const a = extractInkComponents(pixels, { backgroundMode: "local", tileSize: 32, noiseFactor: 4, region });
  const b = extractInkComponents(pixels, { backgroundMode: "local", tileSize: 64, noiseFactor: 4, region });
  assert.equal(a.background_mode, "local");
  assert.equal(a.tile_size, 32);
  assert.equal(b.tile_size, 64);
  assert.equal(a.noise_factor, 4);

  // Global mode reports no local threshold (nothing was derived).
  const g = extractInkComponents(pixels, { region });
  assert.equal(g.background_mode, "global");
  assert.equal(g.tile_size, null);
  assert.equal(g.median_ink_threshold, null);
});

// ------------------- 6. dense flat UI is why local is opt-in ---------------

test("dense flat UI demonstrates why local mode is opt-in rather than automatic", async () => {
  // A grid of flat panels: a 48px tile straddling two panels is bimodal, so the
  // local noise scale inflates and over-thresholds. This is the measured reason
  // the default remains global.
  const parts = [`<rect width="1400" height="900" fill="#0f1216"/>`];
  const greys = ["#161a20", "#1b2027", "#20262e"];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 20 + c * 345;
      const y = 20 + r * 146;
      parts.push(`<rect x="${x}" y="${y}" width="325" height="126" rx="6" fill="${greys[(r + c) % 3]}" stroke="#2a313a"/>`);
      parts.push(`<text x="${x + 14}" y="${y + 58}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#7ee787">${r}${c}</text>`);
    }
  }
  const png = await sharp(Buffer.from(`<svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
  const pixels = await loadPixels(png);
  const region = { left: 0, top: 0, width: 1400, height: 900 };

  const global = extractInkComponents(pixels, { region });
  const local = extractInkComponents(pixels, { region, backgroundMode: "local" });

  // Documented behaviour: the local model derives a much higher threshold here,
  // which is why it is not the default. The test pins that fact rather than
  // pretending local is universally better.
  const localMed = local.median_ink_threshold ?? 0;
  assert.ok(
    localMed > global.median_ink_threshold || local.median_ink_threshold > 4,
    `local mode must derive a higher threshold on bimodal tiles (median=${localMed})`,
  );

  // The DEFAULT path is what users get, and it must remain the global model.
  const viaDefault = contrastInRegion(pixels, region);
  assert.equal(viaDefault.background_mode, "global");
});

// ==========================================================================
// Third-audit acceptance tests (F1-F4). Each is written to be non-vacuous:
// reverting the corresponding guard makes a specific assertion here fail.
// ==========================================================================

const GRADIENT_REGION = { left: 0, top: 0, width: 900, height: 420 };

// ------------------------------- F1: mode consistency ----------------------

test("F1: region-less contrast agrees between mode 'contrast' and mode 'all'", async () => {
  const png = await buildContrastFixture();
  const a = await measureImage({ imageBuffer: png, mode: "contrast" });
  const b = await measureImage({ imageBuffer: png, mode: "all" });
  const ca = a.measurements.contrast;
  const cb = b.measurements.contrast;

  assert.ok(ca && cb, "both modes must measure contrast over the full frame");
  assert.equal(ca.worst.contrast_ratio, cb.worst.contrast_ratio, "the same question must get the same answer");
  assert.equal(ca.best.contrast_ratio, cb.best.contrast_ratio);
  assert.equal(ca.failing_count, cb.failing_count);
  assert.equal(ca.measurable, cb.measurable);

  // The full-frame scope is disclosed in BOTH modes rather than silently assumed.
  assert.ok(a.notes.some((n) => /WHOLE image/.test(n)), "contrast mode must disclose full-frame scope");
  assert.ok(b.notes.some((n) => /WHOLE image/.test(n)), "all mode must disclose full-frame scope");

  // And the validated acceptance numbers are untouched.
  assert.equal(ca.worst.contrast_ratio, 1.04);
  assert.equal(ca.best.contrast_ratio, 13.42);
  assert.equal(ca.failing_count, 2);
});

// ------------------- F2: no phantom background, no noise-as-text -----------

test("F2: local mode reports no single background colour", async () => {
  const png = await buildGradientTextFixture();
  const pixels = await loadPixels(png);

  const local = contrastInRegion(pixels, GRADIENT_REGION, { backgroundMode: "local" });
  assert.equal(local.background, null, "local mode must not present a single background colour");
  assert.equal(local.background_mode, "local");
  assert.ok(
    local.notes.some((n) => /NO single background/.test(n)),
    "the null background must be explained in notes",
  );

  // Global mode keeps its modal background (no silent change on the default path).
  const global = contrastInRegion(pixels, GRADIENT_REGION);
  assert.ok(global.background && global.background.hex, "global mode keeps its modal background");
});

test("F2: a 1-component low-contrast blob is noise, not failing text", () => {
  // Exactly the auditor's reported cluster: 291px, 1 component, 1.06:1.
  const blob = { foreground: "#565656", pixel_count: 291, component_count: 1, contrast_ratio_raw: 1.06, contrast_ratio: 1.06 };
  assert.equal(isSuspectedNoiseCluster(blob).suspected, true, "a weak single-component blob is noise");
  assert.equal(looksLikeIndependentText(blob), false);

  // Genuine low-contrast TEXT (acceptance fixture #1e1c18: 1.04:1, 2174px,
  // 20 components) must NOT be dismissed as noise.
  const realText = { foreground: "#1e1c18", pixel_count: 2174, component_count: 20, contrast_ratio_raw: 1.04, contrast_ratio: 1.04 };
  assert.equal(isSuspectedNoiseCluster(realText).suspected, false, "real low-contrast text is not noise");
  assert.equal(looksLikeIndependentText(realText), true);

  // A small-but-multi-component run (MID-TWO: 2254px / 7 comps) is not noise.
  assert.equal(isSuspectedNoiseCluster({ pixel_count: 2254, component_count: 7, contrast_ratio_raw: 3.73 }).suspected, false);

  // And the partition itself (the wiring the enumeration uses) separates them,
  // so this test fails if the filter stops excluding noise or over-excludes text.
  const { kept, suspected } = partitionSuspectedNoise([blob, realText], "local");
  assert.equal(suspected.length, 1, "exactly the noise blob is removed");
  assert.equal(suspected[0].foreground, "#565656");
  assert.equal(kept.length, 1, "the real text colour is kept");
  assert.equal(kept[0].foreground, "#1e1c18");

  // In global mode nothing is reclassified.
  assert.equal(partitionSuspectedNoise([blob, realText], "global").suspected.length, 0);
});

test("F2: suspected noise never sets the verdict, but is always disclosed", async () => {
  const png = await buildPhotographicFixture({ noise: 8, text: false });
  const pixels = await loadPixels(png);
  const local = contrastInRegion(pixels, PHOTO_REGION, { backgroundMode: "local" });

  // Text-free photo: either nothing assessable, or only disclosed noise.
  assert.equal(local.colours.length, 0);
  if (local.suspected_noise.length > 0) {
    assert.ok(
      local.notes.some((n) => /SUSPECTED BACKGROUND NOISE/.test(n)),
      "suspected noise must be named as such in notes, not asserted as failing text",
    );
  }
  assert.equal(local.failing_count, 0, "noise must not drive failing_count");
});

// ------------------- F4: a real text run is not folded as AA ---------------

test("F4: a genuine mid-tone text run is not folded as anti-aliasing", async () => {
  const png = await buildGradientTextFixture({
    lines: [
      { text: "BRIGHT-ONE", y: 60, fill: "#f0f0f0" },
      { text: "MID-TWO", y: 170, fill: "#969696" },
      { text: "DARK-THREE", y: 280, fill: "#3c3c3c" },
    ],
  });
  const pixels = await loadPixels(png);
  const local = contrastInRegion(pixels, GRADIENT_REGION, { backgroundMode: "local" });

  const mid = local.colours.find((c) => rgbDistance(c.rgb, parseColor("#969696")) < 24);
  assert.ok(
    mid,
    `MID-TWO must survive as its own colour, not be folded (got: ${local.colours.map((c) => c.foreground).join(", ") || "none"})`,
  );
  assert.ok(mid.component_count >= 3, "and it must keep its multi-component text structure");
  assert.ok(
    !(local.merged_anti_aliasing || []).some((m) => m.hex === mid.foreground),
    "a colour with its own multi-component run must not appear as a merge source",
  );
});

test("F4: the structural guard stops the fold that colour alone would allow", () => {
  const bg = parseColor("#1a1814");
  const bright = { hex: "#f0f0f0", rgb: parseColor("#f0f0f0"), pixel_count: 3113, component_count: 10, boxes: [], hollow: 0 };
  const mid = { hex: "#969696", rgb: parseColor("#969696"), pixel_count: 2254, component_count: 7, boxes: [], hollow: 0 };

  // The colour test alone WOULD fold MID-TWO into the bright tone...
  assert.equal(isAntiAliasingBlend(mid.rgb, bright.rgb, bg), true, "colour alone would fold it");
  // ...but the structural guard must prevent it.
  const { merged_anti_aliasing } = mergeAntiAliasing([bright, mid], bg);
  assert.equal(merged_anti_aliasing.length, 0, "the structural guard must prevent the fold");

  // A genuine AA fragment (few, tiny components) is still folded.
  const frag = { hex: "#787065", rgb: parseColor("#787065"), pixel_count: 68, component_count: 2, boxes: [], hollow: 0 };
  const parent = { hex: "#a09588", rgb: parseColor("#a09588"), pixel_count: 699, component_count: 14, boxes: [], hollow: 0 };
  const r2 = mergeAntiAliasing([parent, frag], bg);
  assert.equal(r2.merged_anti_aliasing.length, 1, "a real AA fragment must still fold");
  assert.equal(r2.merged_anti_aliasing[0].hex, "#787065");
});

test("F4: flat images yield the same colour set in both modes (control)", async () => {
  const png = await buildFlatTextFixture();
  const pixels = await loadPixels(png);
  const global = contrastInRegion(pixels, GRADIENT_REGION);
  const local = contrastInRegion(pixels, GRADIENT_REGION, { backgroundMode: "local" });
  const key = (r) => r.colours.map((c) => [c.foreground, c.contrast_ratio]).sort();
  assert.deepEqual(key(local), key(global), "flat background: the two models must agree");
  assert.equal(global.colours.length, 2, "both text tones must be recovered");
});

// ------------------------------- F3: live port discovery -------------------

test("F3: verify:background discovers the service port instead of hard-coding 11499", async () => {
  const src = await readFile(new URL("../verify/verify-background-live.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /process\.env\.PORT \|\| 11499/, "must not silently default to 11499");
  assert.match(src, /11402/, "must probe the deployed service port");
  assert.match(src, /PORT=/, "must name how to override the port");
});

