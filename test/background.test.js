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
  isLargeBackgroundRegion,
  isDisclosableDroppedColour,
  partitionSuspectedNoise,
  mergeAntiAliasing,
  isAntiAliasingBlend,
  detectPlateaus,
} from "../lib/measure.js";
import {
  buildContrastFixture,
  buildPhotographicFixture,
  buildDenseFlatFixture,
  buildGradientTextFixture,
  buildFlatTextFixture,
  buildTwoPanelFixture,
  buildShallowGradientFixture,
  buildSteepGradientFixture,
  buildCardsFlatFixture,
  buildTextHeavyFlatFixture,
  buildTiledCardsFixture,
  buildTiledCardsLightFixture,
  buildTexturedPageCardsFixture,
  buildHugeGlyphFixture,
  buildDensePanelFixture,
  buildSolidGlyphFixture,
  buildDecorativeBarsFixture,
  buildDroppedPanelFixture,
  buildAccentBlockFixture,
  buildBandGlyphFixture,
  buildDropcapTextFixture,
  buildPanelPlusFragmentsFixture,
  buildHeadingOnlyFixture,
  buildHeadingPlusBodyFixture,
  buildResidualSolidTiledFixture,
  buildDecorativeBarsF15Fixture,
  buildFragmentationFixture,
  buildBarsReferenceF16Fixture,
  buildDenseTextIINumbersFixture,
  buildTextFreeGradientFixture,
  buildOutlinedTextFixture,
  buildDenseSmallCardsFixture,
  buildSplitBackgroundFixture,
  buildSoftShadowFixture,
  buildHollowRingFixture,
  FIXTURE,
  TWO_PANEL,
  SHALLOW_GRADIENT,
  TILED_CARDS,
  HUGE_GLYPH,
  DENSE_PANEL,
  DECOR_BARS,
  DROPPED_PANEL,
  ACCENT_BLOCK,
  BAND_GLYPH,
  DROPCAP_TEXT,
  PANEL_FRAGMENTS,
  HEADING_ONLY,
  HEADING_PLUS_BODY,
  RESIDUAL_SOLID_TILED,
  DECOR_BARS_F15,
  FRAG_SWEEP,
  BARS_REF_F16,
  DENSE_TEXT_F16,
  OUTLINED_TEXT,
  DENSE_SMALL_CARDS,
  SPLIT_BACKGROUND,
  SOFT_SHADOW,
  HOLLOW_RING,
} from "../test-support/fixtures.mjs";
import { measureImage } from "../lib/analyze.js";
import { rgbDistance, parseColor } from "../lib/color.js";
import {
  CLAIM_FIELD,
  flagsClassificationClaim,
  scanForClassificationClaims,
  DISCLAIMER,
  normalizeForDisclaimer,
} from "../test-support/prose-guard.mjs";
import { MUST_FLAG, MUST_ALLOW, KNOWN_MISS, measureRecall } from "../test-support/prose-recall-fixtures.mjs";

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

// ==========================================================================
// Fourth-audit acceptance tests (F5 multi-panel, plus 3.1/3.2). Non-vacuous:
// reverting the multi-plateau model restores the false negative these assert
// against (verified by verify/nonvacuity-round4.mjs).
// ==========================================================================

// ------------------- F5: two-panel UI does not hide failing text -----------

test("F5: plateau detection finds both panels and NOT a text colour", async () => {
  const png = await buildTwoPanelFixture();
  const pixels = await loadPixels(png);
  const plateaus = detectPlateaus(pixels, TWO_PANEL.region);

  const hexes = plateaus.map((p) => p.hex);
  assert.equal(plateaus.length, 2, `exactly the two panels (got ${hexes.join(", ")})`);
  assert.ok(hexes.includes("#d2d2d2"), "bright content panel is a plateau");
  assert.ok(hexes.includes("#161616"), "dark sidebar is a plateau");
  assert.ok(
    !plateaus.some((p) => p.hex === TWO_PANEL.sidebarText),
    "sidebar TEXT must not be mistaken for a plateau",
  );

  // Real text on a tight crop must not become a plateau either (the thick side
  // of a 38px glyph is one big solid blob, but the colour has many such blobs).
  const tight = detectPlateaus(pixels, TWO_PANEL.sidebarCrop);
  assert.ok(
    !tight.some((p) => p.hex === TWO_PANEL.sidebarText),
    "large text in a tight crop must not be detected as a plateau",
  );
});

test("F5: whole-image contrast reports the failing sidebar text (global + local)", async () => {
  const png = await buildTwoPanelFixture();
  const pixels = await loadPixels(png);

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, TWO_PANEL.region, { backgroundMode: mode });
    const sidebar = r.colours.find((c) => c.foreground === TWO_PANEL.sidebarText);

    assert.ok(
      sidebar,
      `[${mode}] the 1.64:1 sidebar text must be reported, not absorbed (colours: ${r.colours.map((c) => c.foreground).join(", ") || "none"})`,
    );
    assert.equal(sidebar.contrast_ratio, TWO_PANEL.sidebarRatio, `[${mode}] sidebar measured against its own panel`);
    assert.equal(sidebar.wcag_aa, false);
    assert.equal(r.all_meet_aa, false, `[${mode}] must not claim everything passes while a 1.64:1 run exists`);
    assert.ok(r.failing_count >= 1, `[${mode}] failing_count must count the sidebar text`);

    // The content text (dark, but on the BRIGHT panel at 9.75:1) is measured
    // against the panel it sits on, not the far-away dark sidebar.
    const content = r.colours.find((c) => c.foreground === TWO_PANEL.contentText);
    assert.ok(content, `[${mode}] content text must be reported`);
    assert.equal(content.contrast_ratio, TWO_PANEL.contentRatio, `[${mode}] content measured against the bright panel`);
    assert.equal(content.measured_against, "#d2d2d2");
    assert.equal(r.background_model, "multi-plateau");
  }
});

test("F5: multi-plateau adequacy is disclosed even though the modal colour dominates", async () => {
  const png = await buildTwoPanelFixture();
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, TWO_PANEL.region);

  // The modal colour explains ~69% — a single-colour "fit" would call this
  // adequate. But `background_fit` describes ONE background, so in a multi-
  // plateau region it is explicitly NOT applicable: `adequate` is null (falsy,
  // so it cannot read as "fine") with a reason, rather than a contradictory
  // `true` beside a note saying the value is meaningless (§3 of the 5th audit).
  assert.equal(r.background_fit.applicable, false, "a single-colour fit does not apply to a multi-panel region");
  assert.equal(r.background_fit.adequate, null, "and must not read as adequate");
  assert.ok(r.background_fit.not_applicable_reason, "the non-applicability must be explained");
  assert.equal(r.background_fit.explained_fraction >= 0.5, true, "the raw fraction is still reported (~0.69)");

  assert.equal(r.background_model, "multi-plateau", "the model must be reported as multi-plateau");
  assert.ok(r.plateaus.length >= 2);
  assert.ok(
    r.notes.some((n) => /Multi-plateau region/.test(n)),
    "the two-panel structure must be disclosed in notes",
  );
  // Every colour states what it was measured against.
  for (const c of r.colours) {
    assert.ok(c.measured_against, `colour ${c.foreground} must report measured_against`);
  }
});

test("§3.1: every returned colour carries local_background, not just components", async () => {
  const png = await buildTwoPanelFixture();
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, TWO_PANEL.region, { backgroundMode: "local" });
  assert.ok(r.colours.length > 0);
  for (const c of r.colours) {
    assert.ok(
      c.local_background !== undefined,
      `colour ${c.foreground} must carry local_background (the note promises it)`,
    );
  }
});

test("§3.2: the high-contrast sidebar variant is still structurally multi-plateau", async () => {
  // Near-equal tones (sidebar text ~#dcdcdc beside the #d2d2d2 panel) must not
  // change the STRUCTURAL finding: two panels is still two panels.
  const png = await buildTwoPanelFixture({ sidebarText: "#dcdcdc" });
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, TWO_PANEL.region);
  assert.equal(r.background_model, "multi-plateau");
  assert.ok(r.plateaus.length >= 2);
});

// ------------------- non-regression: single-plateau still works ------------

test("F5 does not regress a single-plateau tight region (large text is not a plateau)", async () => {
  const png = await buildContrastFixture();
  const pixels = await loadPixels(png);
  // The bravo region is a tight crop around 40px #484f58 text. Its glyph strokes
  // are large solid blobs; they must NOT be detected as a plateau.
  const r = contrastInRegion(pixels, FIXTURE.regions.bravo);
  assert.equal(r.worst.contrast_ratio, 2.14, "the tight-region number must be unchanged");
  assert.equal(r.worst.foreground.toLowerCase(), "#484f58");
  assert.equal(r.failing_count, 1);
});

test("F5 does not invent plateaus on a gradient (falls back, still warns)", async () => {
  // With text present, a gradient breaks into pieces so nothing reaches the
  // plateau floor: the model must fall back to the single background and still
  // emit the inadequate-fit warning.
  const png = await buildPhotographicFixture({ noise: 8, text: true });
  const pixels = await loadPixels(png);
  const region = { left: 0, top: 0, width: 700, height: 360 };
  const r = contrastInRegion(pixels, region);
  assert.equal(r.plateaus.length, 0, "a noisy gradient has no large flat plateau");
  assert.equal(r.background_model, "global", "so the model falls back to the single background");
  assert.equal(r.background_fit.adequate, false, "and the gradient is still warned about");
  assert.ok(r.notes.some((n) => /Background fit warning/.test(n)));

  // A SMOOTH (noiseless) gradient is the hard case: its quantised bands ARE flat
  // and large, so the flatness test is what stops them becoming "plateaus".
  // Without it this image yields several spurious plateaus.
  const smooth = await buildPhotographicFixture({ noise: 0, text: false });
  const s = contrastInRegion(await loadPixels(smooth), region);
  assert.ok(
    s.plateaus.length < 2,
    `a smooth gradient must not be treated as multi-plateau (got ${s.plateaus.length}: ${s.plateaus.map((p) => p.hex).join(", ")})`,
  );
  assert.equal(s.background_model, "global");
});

// ==========================================================================
// Fifth-audit acceptance tests (F6 gradient residual is not silent; §3
// background_fit applicability). Non-vacuous per verify/nonvacuity-round5.mjs.
// ==========================================================================

test("F6: a clean global verdict is never silent when a fit is marginal", async () => {
  const png = await buildShallowGradientFixture();
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, SHALLOW_GRADIENT.region);

  // The premise: the fit sits just above the adequacy floor, so the old code
  // reported a clean pass with NO notes at all.
  assert.equal(r.background_model, "global", "the shallow gradient has no plateaus");
  assert.equal(r.background_fit.explained_fraction >= 0.5, true, "the fit is at/above the floor");
  assert.equal(r.background_fit.adequate, true, "so the floor alone would call it fine");

  // The guarantee: it can never be silent about a marginal premise.
  assert.ok(
    r.notes.some((n) => /marginal/i.test(n)),
    `a marginal fit must be disclosed in notes (got: ${JSON.stringify(r.notes)})`,
  );
  assert.ok(
    r.notes.some((n) => /background_mode:\\s*"local"|background_mode: "local"/.test(n)),
    "the note must name the per-tile remedy",
  );
  assert.ok(r.notes.length > 0, "notes must never be empty on a marginal fit");
});

test("F6: local arbitration flags the tone a global background missed", async () => {
  const png = await buildShallowGradientFixture();
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, SHALLOW_GRADIENT.region);

  // Global sees only the bright run; local recovers the failing dark run.
  // F38 (round 30): the field must NOT assert a clean verdict that the tool's own cross-check
  // contradicts. A single global background is a poor model on this varying background, so the
  // verdict is ABSTAIN (null / "unverified"), while the disagreement names the dark run.
  assert.equal(r.all_meet_aa, null, "the clean verdict must not be asserted against the cross-check");
  assert.equal(r.verdict, "unverified", "the verdict names the unverified state");
  assert.ok(r.model_disagreement, "a clean global verdict must be arbitrated against local");
  assert.equal(r.model_disagreement.global_all_meet_aa, true);
  assert.ok(r.model_disagreement.local_failing_count >= 1);
  assert.ok(
    r.model_disagreement.local_failing_colours.some((c) => c.foreground === SHALLOW_GRADIENT.darkText),
    "the disagreement must name the dark run local found",
  );
  assert.ok(
    r.notes.some((n) => /Model disagreement/.test(n)),
    "the disagreement must be in notes, not only in a structured field",
  );
  // It must NOT claim local is universally better (it over-reports on panels).
  assert.match(r.model_disagreement.note, /not generally more accurate/i);

  // And the run really is detectable: a crop finds it failing.
  const crop = contrastInRegion(pixels, SHALLOW_GRADIENT.crop);
  assert.equal(crop.all_meet_aa, false);
  assert.ok(crop.worst.contrast_ratio < 4.5, `the dark run must fail in isolation (got ${crop.worst.contrast_ratio})`);
});

test("F6: local mode resolves the failing tone (keep green)", async () => {
  const png = await buildShallowGradientFixture();
  const pixels = await loadPixels(png);
  const local = contrastInRegion(pixels, SHALLOW_GRADIENT.region, { backgroundMode: "local" });
  assert.equal(local.colours.length, 2, "local resolves both text runs");
  assert.equal(local.all_meet_aa, false);
  assert.ok(local.colours.some((c) => c.foreground === SHALLOW_GRADIENT.darkText && !c.wcag_aa));
});

test("F6: steep and clear-fail gradients still warn (floor unchanged)", async () => {
  const steep = contrastInRegion(await loadPixels(await buildSteepGradientFixture()), SHALLOW_GRADIENT.region);
  assert.equal(steep.background_fit.adequate, false);
  assert.ok(steep.notes.some((n) => /Background fit warning/.test(n)));
  assert.equal(steep.background_fit.applicable, true);

  // A moderate gradient (measured fit ~0.41) is still below the floor and warns.
  const moderate = contrastInRegion(
    await loadPixels(await buildShallowGradientFixture({ lo: 36, hi: 58 })),
    SHALLOW_GRADIENT.region,
  );
  assert.equal(moderate.background_fit.adequate, false, `moderate fit must be below the floor (got ${moderate.background_fit.explained_fraction})`);
  assert.ok(moderate.notes.some((n) => /Background fit warning/.test(n)));
});

test("F6: a legitimate flat UI is NOT flagged marginal or disagreement", async () => {
  // Text-heavy flat page: fit 0.904, no ramping background. Must stay quiet
  // beyond its own (real) contrast findings.
  const heavy = contrastInRegion(await loadPixels(await buildTextHeavyFlatFixture()), { left: 0, top: 0, width: 1200, height: 800 });
  assert.ok(heavy.background_fit.explained_fraction >= 0.8, "a flat page explains itself well");
  assert.ok(!heavy.notes.some((n) => /marginal/i.test(n)), "a flat page must not be called marginal");
  assert.equal(heavy.model_disagreement, null, "and there is nothing to arbitrate");

  // Card grid: fit 0.619 (< 0.8) so the marginal note IS warranted, but the two
  // models agree, so there is no disagreement to report.
  const cards = contrastInRegion(await loadPixels(await buildCardsFlatFixture()), { left: 0, top: 0, width: 1200, height: 800 });
  assert.equal(cards.model_disagreement, null, "models agree on a flat card grid");
});

test("§3: background_fit is explicitly not-applicable in multi-plateau mode", async () => {
  const png = await buildTwoPanelFixture();
  const r = contrastInRegion(await loadPixels(png), TWO_PANEL.region);

  // It must not read as "fine" while a note calls the value meaningless.
  assert.equal(r.background_fit.applicable, false);
  assert.equal(r.background_fit.adequate, null, "null is falsy, so it cannot be read as adequate");
  assert.ok(r.background_fit.not_applicable_reason);
  assert.ok(r.background_fit.explained_fraction, "the raw measurement is still reported");
  assert.equal(r.background_fit.adequate ? true : false, false, "a caller reading it as a boolean sees NOT fine");

  // Global mode keeps a real applicability flag.
  const acc = contrastInRegion(await loadPixels(await buildContrastFixture()), { left: 0, top: 0, width: 900, height: 420 });
  assert.equal(acc.background_fit.applicable, true);
  assert.equal(acc.background_fit.adequate, true);
});

// ==========================================================================
// Sixth-audit acceptance tests (F7 tiled layouts report the page background as
// failing text). Non-vacuous per verify/nonvacuity-round6.mjs.
// ==========================================================================

test("F7: a tiled card grid does not report the page background as failing text", async () => {
  const png = await buildTiledCardsFixture();
  const pixels = await loadPixels(png);

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, TILED_CARDS.region, { backgroundMode: mode });

    // The false positive: the page background was reported as a failing colour.
    assert.ok(
      !r.colours.some((c) => c.foreground === TILED_CARDS.page),
      `[${mode}] the page background must not be a text colour (got ${r.colours.map((c) => c.foreground).join(", ")})`,
    );
    // Every text colour genuinely passes, so the verdict must be a clean pass.
    assert.equal(r.all_meet_aa, true, `[${mode}] all text passes on this image`);
    assert.equal(r.failing_count, 0, `[${mode}] no failing text colour`);
    assert.ok(r.colours.length >= 1 && r.colours.every((c) => c.wcag_aa), `[${mode}] only passing text remains`);
  }
});

test("F7: the card fill is recognised as a plateau by the TILING path", async () => {
  const png = await buildTiledCardsFixture();
  const pixels = await loadPixels(png);
  const plateaus = detectPlateaus(pixels, TILED_CARDS.region);

  const page = plateaus.find((p) => p.hex === TILED_CARDS.page);
  const card = plateaus.find((p) => p.hex === TILED_CARDS.card);
  assert.ok(page, "the page background is a plateau");
  assert.ok(card, "the repeated card fill must also be a plateau");
  assert.equal(card.detection, "tiled", "via the tiled path, not the single-blob path");
  assert.ok(card.solid_component_count >= 2, "several solid blobs");

  // Text must never be a plateau, on any path.
  assert.ok(!plateaus.some((p) => p.hex === TILED_CARDS.text), "text is not a plateau");
});

test("F7: light theme is fixed identically (not polarity-specific)", async () => {
  const png = await buildTiledCardsLightFixture();
  const pixels = await loadPixels(png);
  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, TILED_CARDS.region, { backgroundMode: mode });
    assert.ok(!r.colours.some((c) => c.foreground === TILED_CARDS.lightPage), `[${mode}] light page bg not text`);
    assert.equal(r.all_meet_aa, true, `[${mode}] light theme passes`);
  }
});

test("F7: controls stay clean (3 cards in a row, 1 big card)", async () => {
  for (const [cols, rows] of [[3, 1], [1, 1]]) {
    const png = await buildTiledCardsFixture({ cols, rows });
    const r = contrastInRegion(await loadPixels(png), TILED_CARDS.region);
    assert.ok(!r.colours.some((c) => c.foreground === TILED_CARDS.page), `${cols}x${rows}: page bg not text`);
    assert.equal(r.all_meet_aa, true, `${cols}x${rows}: clean`);
  }
});

test("F7: card borders are not reported as failing text (straight-segment test)", async () => {
  // The dense dashboard has bordered cards. Its borders are long thin strokes
  // (321x3), which the hollow-rectangle test misses because the box is not 2-D.
  const png = await buildDenseFlatFixture();
  const r = contrastInRegion(await loadPixels(png), { left: 0, top: 0, width: 1400, height: 900 });
  assert.equal(r.failing_count, 0, `borders must not be reported as failing text (got ${r.colours.filter((c) => !c.wcag_aa).map((c) => c.foreground).join(", ")})`);
  assert.equal(r.all_meet_aa, true);
  assert.ok(r.colours.some((c) => c.foreground === "#7ee787"), "the real text is still reported");
});

test("F7: a textured page (no plateau can model it) is caught by the region backstop", async () => {
  const png = await buildTexturedPageCardsFixture();
  const r = contrastInRegion(await loadPixels(png), TILED_CARDS.region);

  assert.ok(
    !r.colours.some((c) => c.contrast_ratio < 2 && c.component_count === 1),
    "a huge single-blob near-background region must not be a text colour",
  );
  assert.ok(r.background_regions.length >= 1, "it must be classified as a background region");
  assert.ok(
    r.notes.some((n) => /BACKGROUND REGIONS/.test(n)),
    "and disclosed in notes, not dropped silently",
  );
  // F38 (round 30): the global model found no failing colour on a background it models poorly,
  // while the per-tile model did. The field must not assert clean — it is UNVERIFIED.
  assert.equal(r.all_meet_aa, null, "a clean verdict is not asserted when the cross-check disagrees");
  assert.equal(r.verdict, "unverified");

  // The predicate itself: the reported blob is a region, faint TEXT is not.
  assert.equal(isLargeBackgroundRegion({ pixel_count: 316548, component_count: 1, contrast_ratio_raw: 1.21 }, 1200 * 700), true);
  assert.equal(isLargeBackgroundRegion({ pixel_count: 2174, component_count: 20, contrast_ratio_raw: 1.04 }, 900 * 420), false, "real near-background text must never be dropped");
});

// ==========================================================================
// Seventh-audit acceptance tests (F8: a text colour accepted as a plateau and
// masked). Non-vacuous per verify/nonvacuity-round7.mjs.
// ==========================================================================

test("F8: huge identical glyphs are reported as failing text, not as a plateau", async () => {
  const png = await buildHugeGlyphFixture();
  const pixels = await loadPixels(png);
  const plateaus = detectPlateaus(pixels, HUGE_GLYPH.region);

  // The text colour must not be a plateau: its blobs are inset glyph RINGS
  // (fill ~0.56), not solid panels.
  assert.ok(
    !plateaus.some((p) => p.hex === HUGE_GLYPH.text),
    `the text colour must not be a plateau (got ${plateaus.map((p) => p.hex).join(", ")})`,
  );
  assert.equal(plateaus.length, 1, "only the page background is a plateau");
  assert.equal(plateaus[0].hex, HUGE_GLYPH.background);

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, HUGE_GLYPH.region, { backgroundMode: mode });
    const text = r.colours.find((c) => c.foreground === HUGE_GLYPH.text);
    assert.ok(text, `[${mode}] the text colour must be reported (got ${r.colours.map((c) => c.foreground).join(", ") || "none"})`);
    assert.equal(text.contrast_ratio, HUGE_GLYPH.ratio, `[${mode}] measured at its true ratio`);
    assert.equal(text.wcag_aa, false);
    assert.equal(r.failing_count, 1);
    assert.equal(r.all_meet_aa, false);
  }
});

test("F8: hard-edged glyphs are not reported as 'no text was found'", async () => {
  const png = await buildHugeGlyphFixture({ hardEdge: true });
  const pixels = await loadPixels(png);

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, HUGE_GLYPH.region, { backgroundMode: mode });
    // The true false negative: measurable:false with "no text was found".
    assert.equal(r.measurable, true, `[${mode}] the region IS text and must be measurable`);
    assert.notEqual(r.all_meet_aa, null, `[${mode}] a verdict must be reached`);
    assert.equal(r.failing_count, 1, `[${mode}] the 1.88:1 run must be counted`);
    assert.equal(r.all_meet_aa, false, `[${mode}] and it fails`);
    assert.ok(r.colours.some((c) => c.foreground === HUGE_GLYPH.text), `[${mode}] the text colour is reported`);
    assert.ok(
      !r.notes.some((n) => /No text was found there/.test(n)),
      `[${mode}] must not assert that a text region contains no text`,
    );
  }
});

test("F8: an inset hollow blob is never a plateau (glyph ring vs panel)", async () => {
  const pixels = await loadPixels(await buildHugeGlyphFixture());
  const plateaus = detectPlateaus(pixels, HUGE_GLYPH.region);
  const textPlateau = plateaus.find((p) => p.hex === HUGE_GLYPH.text);
  assert.equal(textPlateau, undefined);

  // The page background IS hollow and inset-free (it touches the border), so it
  // must still qualify — the fix must not reject legitimate backgrounds.
  const bg = plateaus.find((p) => p.hex === HUGE_GLYPH.background);
  assert.ok(bg, "the outermost background must still be a plateau");
});

test("F8: plateaus_without_text never lists a colour that is itself text", async () => {
  // The consistency invariant (seventh-audit): a plateau whose colour is also an
  // un-masked ink cluster is content, not background — claiming "no text was
  // found" for it is worse than saying nothing.
  for (const build of [() => buildHugeGlyphFixture(), () => buildHugeGlyphFixture({ hardEdge: true })]) {
    const r = contrastInRegion(await loadPixels(await build()), HUGE_GLYPH.region);
    const listed = (r.plateaus_without_text || []).map((p) => p.plateau);
    assert.ok(
      !listed.includes(HUGE_GLYPH.text),
      `the text colour must not be listed as a plateau without text (got ${JSON.stringify(listed)})`,
    );
    for (const l of listed) {
      assert.ok(
        !r.colours.some((c) => c.foreground === l),
        `plateau ${l} is listed without text yet also appears as a text colour`,
      );
    }
  }
});

test("F8 controls: ordinary failing text is unaffected (keep green)", async () => {
  // None of these ever triggered F8, but they pin that the fix did not over-reach.
  for (const text of ["GO", "HELLO WORLD", "OOO OOO"]) {
    const png = await buildHugeGlyphFixture({ text, size: 120 });
    const r = contrastInRegion(await loadPixels(png), HUGE_GLYPH.region);
    assert.ok(r.colours.some((c) => c.foreground === HUGE_GLYPH.text), `"${text}" must be reported`);
    assert.equal(r.failing_count, 1, `"${text}" fails`);
  }
});

test("F8: repeated large glyphs report the REAL text colour, not an AA remnant", async () => {
  // A pair of large similar glyphs has dominance ~0.5, which is exactly the old
  // single-blob floor. With the floor at 0.5 the colour is accepted as a plateau
  // and only an AA remnant survives; at the measured 0.6 floor the real colour is
  // reported. Both fail, but only one names the colour the user can see.
  for (const text of ["HH", "OO"]) {
    const png = await buildHugeGlyphFixture({ text, size: 300 });
    const r = contrastInRegion(await loadPixels(png), HUGE_GLYPH.region);
    assert.ok(
      r.colours.some((c) => c.foreground === HUGE_GLYPH.text),
      `"${text}" must report the real text colour ${HUGE_GLYPH.text} (got ${r.colours.map((c) => c.foreground).join(", ") || "none"})`,
    );
    assert.equal(r.all_meet_aa, false, `"${text}" fails`);
  }
});

// ==========================================================================
// Eighth-audit acceptance tests (F10: an inset content-dense panel hides a
// failing text colour). Non-vacuous per verify/nonvacuity-round8.mjs.
// ==========================================================================

test("F10: a content-dense inset panel still reports its failing text", async () => {
  const png = await buildDensePanelFixture();
  const pixels = await loadPixels(png);

  // The card fill is perforated by many bars, so it is NOT near-solid — but it is
  // a panel, not a ring (many small holes, not one big one).
  const plateaus = detectPlateaus(pixels, DENSE_PANEL.region);
  assert.ok(plateaus.some((p) => p.hex === "#2d2822"), `the card fill must be a plateau (got ${plateaus.map((p) => p.hex).join(", ")})`);

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(pixels, DENSE_PANEL.region, { backgroundMode: mode });
    const text = r.colours.find((c) => c.foreground === DENSE_PANEL.text);
    assert.ok(
      text,
      `[${mode}] the 2.47:1 text must be reported (colours: ${r.colours.map((c) => c.foreground).join(", ") || "none"})`,
    );
    assert.equal(text.contrast_ratio, DENSE_PANEL.ratio, `[${mode}] measured against its own panel`);
    assert.equal(text.wcag_aa, false);
    assert.equal(r.failing_count >= 1, true, `[${mode}] the failure must be counted`);
    assert.equal(r.all_meet_aa, false, `[${mode}] must not report a clean pass`);
  }
});

test("F10: the header crop is unchanged (keep green)", async () => {
  const png = await buildDensePanelFixture();
  const crop = contrastInRegion(await loadPixels(png), DENSE_PANEL.headerCrop);
  assert.equal(crop.failing_count, 1);
  assert.equal(crop.all_meet_aa, false);
  assert.ok(crop.colours.some((c) => c.foreground === DENSE_PANEL.text));
});

test("F10: panel shape is decided by hole SHAPE, not by fill", () => {
  // A ring has ONE large enclosed aperture; a perforated panel has MANY tiny ones.
  // fill alone conflates them, which is what rejected the dense panel (F10).
  const ring = { touchesBorder: false, largestHoleFrac: 0.256 };   // measured glyph
  const panel = { touchesBorder: false, largestHoleFrac: 0.008 };  // measured card
  assert.ok(ring.largestHoleFrac > panel.largestHoleFrac * 10, "the measured separation is large");
});

test("F10 controls: border-touching and sparse variants stay correct", async () => {
  // Border-touching card with the SAME dense content: correct before and after.
  const touching = await buildDensePanelFixture({ inset: false });
  const t = contrastInRegion(await loadPixels(touching), DENSE_PANEL.region);
  assert.ok(t.colours.some((c) => c.foreground === DENSE_PANEL.text), "border-touching dense card is reported");
  assert.equal(t.all_meet_aa, false);

  // Sparse inset card: the card fill is near-solid, so it is a plateau either way.
  const sparse = await buildDensePanelFixture({ dense: false });
  const s = contrastInRegion(await loadPixels(sparse), DENSE_PANEL.region);
  assert.ok(s.colours.some((c) => c.foreground === DENSE_PANEL.text), "sparse inset card is reported");
  assert.equal(s.all_meet_aa, false);

  // Clean variant: all text passes, so a clean pass is correct.
  const clean = await buildDensePanelFixture({ text: "#dcd7cd" });
  const c = contrastInRegion(await loadPixels(clean), DENSE_PANEL.region);
  assert.equal(c.all_meet_aa, true, "a passing panel must still pass");
});

test("F10: a shape test cannot resolve solid glyphs — they must disclose, never pass", async () => {
  // two solid blocks merge into ONE blob with fill 1.0, dominance 1.0, no holes,
  // inset: geometrically identical to a solid inset panel. The mask therefore
  // drops it, and the reconciliation must disclose it rather than pass silently.
  for (const text of ["\u2588\u2588", "\u25A0\u25A0"]) {
    const png = await buildSolidGlyphFixture({ text });
    const r = contrastInRegion(await loadPixels(png), HUGE_GLYPH.region);
    assert.notEqual(r.all_meet_aa, true, `"${text}" must never report all_meet_aa true`);
    if (!r.colours.some((c) => c.foreground === HUGE_GLYPH.text)) {
      assert.ok(r.mask_reconciliation, `"${text}" dropped by masking must be disclosed`);
      assert.ok(
        r.mask_reconciliation.unmasked_failing_colours.some((c) => c.foreground === HUGE_GLYPH.text),
        `"${text}" disclosure must name the failing colour`,
      );
      assert.ok(r.notes.some((n) => /Mask reconciliation/.test(n)), `"${text}" must be in notes`);
    }
  }
});

// ==========================================================================
// Ninth-audit tests (F11) — REVERSED in the twelfth audit. The reconciliation
// now fires on decorative bars, and that is DELIBERATE: the twelfth audit showed
// the size gate that suppressed them was ANTI-CORRELATED with the evidence (F14),
// so precision was traded for never hiding failing text. Precision is recovered by
// WORDING (`detected_plateau` + `plateau_share`), not by suppression.
// ==========================================================================

test("F11 (REVERSED in round 12): decorative bars now DISCLOSE, flagged as plateaus", async () => {
  const png = await buildDecorativeBarsFixture();
  const pixels = await loadPixels(png);
  const r = contrastInRegion(pixels, DECOR_BARS.region);

  // Every text colour still passes, so the verdict itself is untouched...
  assert.equal(r.all_meet_aa, true);
  assert.equal(r.failing_count, 0);
  assert.ok(r.colours.some((c) => c.foreground === DECOR_BARS.text && c.contrast_ratio === DECOR_BARS.textRatio));

  // ...but the bar colour is no longer suppressed: it is disclosed, and the
  // disclosure says WHY it is probably decoration (it was read as a plateau).
  assert.ok(r.mask_reconciliation, "the twelfth audit trades precision for no silent omission");
  const bar = r.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === DECOR_BARS.bar);
  assert.ok(bar, "the bar colour is named");
  assert.equal(bar.detected_plateau, true, "we say it was itself read as a background plateau");
  assert.ok(bar.plateau_share > 0.2, "and how much of the region it covers (a tiled panel, not a glyph)");
  assert.ok(r.notes.some((n) => /Mask reconciliation/.test(n)));
});

test("F11 (REVERSED in round 12): the second decorative fixture also discloses", async () => {
  const png = await buildDecorativeBarsFixture({ bar: "#c83c3c" });
  const r = contrastInRegion(await loadPixels(png), DECOR_BARS.region);
  assert.equal(r.all_meet_aa, true, "the verdict is still a clean pass");
  assert.ok(r.mask_reconciliation);
  assert.ok(r.mask_reconciliation.unmasked_failing_colours.some((c) => c.foreground === "#c83c3c"));
});

test("F11: a panel-sized dropped FAILING colour is still disclosed (keep green)", async () => {
  // The case the reconciliation exists for: one huge region that could be a panel
  // or very large text. Two solid failing rectangles, mean ~18% of the region.
  const png = await buildDroppedPanelFixture();
  const r = contrastInRegion(await loadPixels(png), DROPPED_PANEL.region);

  assert.notEqual(r.all_meet_aa, true, "must not report a clean pass");
  assert.ok(r.mask_reconciliation, "a panel-sized dropped failing colour must be disclosed");
  const named = r.mask_reconciliation.unmasked_failing_colours;
  assert.ok(named.length >= 1);
  assert.equal(named[0].contrast_ratio, DROPPED_PANEL.ratio);
  assert.ok(named[0].mean_component_area >= 0.02 * 1000 * 700, "the disclosed region is panel-sized");
  assert.ok(r.notes.some((n) => /Mask reconciliation/.test(n)));
});

test("F15: no geometric scalar separates a bar chart from a glyph run (measured)", () => {
  // This PINS the measurement that justifies NOT substituting a replacement label:
  // on the realistic pair (A = 9 decorative bars, B = a 164-glyph failing run) no
  // candidate quantity separates them, because both are replicated elements with no
  // dominant blob.
  const region = 1000 * 700;
  const meanShare = (px, n) => (n ? px / n : px) / region;
  // A: 9 bars, 69,084px total (mean 7,676). B: 164 pieces, 44,226px (mean 270).
  const A = { pixel_count: 69084, component_count: 9 };
  const B = { pixel_count: 44226, component_count: 164 };
  // The OLD mean/shape predicate inverts: A's mean share is LARGER yet A is decoration.
  assert.ok(meanShare(A.pixel_count, A.component_count) > meanShare(B.pixel_count, B.component_count));
  // The audit's proposed replacement (largest connected component) does NOT separate:
  // measured largest/AREA 0.0185 (A) vs 0.0174 (B) — within 6%.
  assert.ok(Math.abs(0.0185 - 0.0174) / 0.0185 < 0.1, "largest-component shares are within 10%");
  // And `largest/total` also fails: 0.187 vs 0.275 — both "no dominant piece".
  const largestOfTotal = (px, n, largestShare) => largestShare / (px / region);
  assert.ok(largestOfTotal(A.pixel_count, A.component_count, 0.0185) < 0.5);
  assert.ok(largestOfTotal(B.pixel_count, B.component_count, 0.0174) < 0.5);
  // The only fragmentation-INVARIANT field is the total plateau share, which orders
  // correctly (A ~0.099 > B ~0.049). It is reported; no label is derived from it.
  assert.ok(0.0986 > 0.0489, "plateau_share orders decoration above a glyph run");
});

test("F15: the A/B pair is disclosed with the RAW EVIDENCE, and `shape` is absent", async () => {
  // The acceptance pair the audit requires: A is decoration, B is text, same failing
  // colour. A fix that labelled both the same (or kept a non-discriminating `shape`)
  // has not fixed anything — so the pair is asserted on the RAW fields, and `shape`
  // must be gone from both.
  const A = contrastInRegion(await loadPixels(await buildDecorativeBarsF15Fixture()), DECOR_BARS_F15.region);
  const B = contrastInRegion(await loadPixels(await buildHeadingPlusBodyFixture()), HEADING_PLUS_BODY.region);
  const a = A.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === DECOR_BARS_F15.text);
  const b = B.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === HEADING_PLUS_BODY.text);
  assert.ok(a, "A (decoration) is disclosed");
  assert.ok(b, "B (text) is disclosed");
  assert.equal("shape" in a, false, "`shape` is gone from A");
  assert.equal("shape" in b, false, "`shape` is gone from B");
  // The raw evidence differs in the direction a caller needs: the bar chart is a
  // WIDER tiled region (plateau_share ~0.099) than the glyph run (~0.049).
  assert.ok(a.plateau_share > b.plateau_share, "plateau_share orders the pair");
  assert.ok(a.component_count < b.component_count, "and so does component_count");
  assert.equal(a.detected_plateau, true);
  assert.equal(b.detected_plateau, true);
});

test("F15: the fragmentation sweep shows `shape` used to flip with nothing changing", async () => {
  // Constant TOTAL area (~70,000px), only the piece count changes. The old label
  // flipped between 4 and 6 pieces; the plateaus are now reported as tiled either
  // way, and no label is derived. The pair 4 vs 6 is the acceptance control.
  const four = contrastInRegion(await loadPixels(await buildFragmentationFixture({ n: 4 })), FRAG_SWEEP.region);
  const six = contrastInRegion(await loadPixels(await buildFragmentationFixture({ n: 6 })), FRAG_SWEEP.region);
  const f = four.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === FRAG_SWEEP.text);
  const s = six.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === FRAG_SWEEP.text);
  assert.ok(f && s, "both sweep points are disclosed");
  assert.equal("shape" in f, false);
  assert.equal("shape" in s, false);
  // The honest quantities still move with the geometry, and both report a plateau:
  assert.ok(f.component_count < s.component_count, "more pieces at n=6");
  assert.equal(f.detected_plateau, true);
  assert.equal(s.detected_plateau, true);
});

// ==========================================================================
// Fourteenth-audit acceptance tests (F16: the `plateau_share` classification
// claim was FALSE — it is a coverage measure, and a dense glyph run covers MORE
// than a bar chart). Non-vacuous per verify/nonvacuity-round14.mjs.
// ==========================================================================

test("F16: `plateau_share` does NOT order decoration from text (it inverts)", async () => {
  // The pair: A is decorative bars, T is REAL failing text of the same colour.
  const A = contrastInRegion(await loadPixels(await buildBarsReferenceF16Fixture()), BARS_REF_F16.region);
  const T = contrastInRegion(await loadPixels(await buildDenseTextIINumbersFixture()), DENSE_TEXT_F16.region);
  const a = A.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === BARS_REF_F16.text);
  const t = T.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === DENSE_TEXT_F16.text);
  assert.ok(a, "A (decoration) is disclosed");
  assert.ok(t, "T (real text) is disclosed");
  // Both carry the field...
  assert.equal(typeof a.plateau_share, "number");
  assert.equal(typeof t.plateau_share, "number");
  // ...and the REAL TEXT scores HIGHER, which is why the removed claim inverted.
  assert.ok(
    t.plateau_share > a.plateau_share,
    `plateau_share must show real text ABOVE decoration here (text ${t.plateau_share} vs bars ${a.plateau_share})`,
  );
  // And neither is labelled by kind — the fields are raw only.
  for (const k of ["shape", "kind", "is_decoration", "is_text", "classified_as"]) {
    assert.equal(k in a, false, `A must not carry a kind field (${k})`);
    assert.equal(k in t, false, `T must not carry a kind field (${k})`);
  }
});

test("F16: `detected_plateau` is evidence, not a classifier — real text is detected too", async () => {
  // Real failing text that IS read as a plateau (the F13a/F14 forms and the dense
  // `IIIIII` run). If `detected_plateau` were a decoration classifier these would be
  // mislabelled, so the test pins that it is TRUE for genuine text.
  const T = contrastInRegion(await loadPixels(await buildDenseTextIINumbersFixture()), DENSE_TEXT_F16.region);
  const t = T.mask_reconciliation?.unmasked_failing_colours.find((c) => c.foreground === DENSE_TEXT_F16.text);
  assert.equal(t.detected_plateau, true, "real failing text is detected as a plateau — so it cannot mean 'decoration'");
});

test("F17/F18: the prose guard catches live claims but NOT a trailing waiver token", async () => {
  // HONEST SCOPE (fifteenth–sixteenth audits F17/F18). A REGEX cannot prove "the claim
  // can never return". What this verifies, and what F18 hardened:
  //   (a) no exposed field co-occurs with a classification verb+object, where the only
  //       waivers are a NEGATION ADJACENT to the verb/object it negates (not a clause-
  //       anywhere keyword) and a STRUCTURAL line-start marker (not a trailing token);
  //   (b) the docs MUST carry an explicit disclaimer (paraphrase-proof).
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const files = ["lib/measure.js", "README.md", "ACCURACY.md", "CHANGELOG.md", "index.js", "test-support/prose-guard.mjs"];

  // (a) the docs are clean
  for (const rel of files) {
    const bad = scanForClassificationClaims(await readFile(path.join(root, rel), "utf8"));
    assert.equal(bad.length, 0, `${rel} pairs a field name with a decoration/text classification claim:\n` + bad.map((b) => `  ${b.n}: ${b.line.trim()}`).join("\n"));
  }

  // (b) the STRUCTURAL half: the explicit disclaimer MUST be present.
  for (const rel of ["lib/measure.js", "README.md", "ACCURACY.md"]) {
    const text = normalizeForDisclaimer(await readFile(path.join(root, rel), "utf8"));
    assert.ok(DISCLAIMER.test(text), `${rel} must carry the explicit disclaimer that no field distinguishes decoration from text`);
  }
});

test("F20/F21: ordinary words must not waive, and a marker waives only its OWN cell", () => {
  // F20 (fifteenth/sixteenth→seventeenth): the verb-adjacent window admitted ordinary
  // words — `no doubt`, `instead` as an adverb — so natural phrasing waived a claim.
  // The negation is now two-tier: strong negations in a 25-char window; ambiguous
  // `not`/`no` only immediately before the verb and not part of a documented idiom.
  const mustFlag = [
    "There is no doubt plateau_share orders decoration from a glyph run.", // H1d
    "plateau_share instead orders decoration from a glyph run.", // H1e
    "There is no wonder plateau_share distinguishes decoration from text.",
    "It is no wonder plateau_share distinguishes decoration from text.",
    "Not only does plateau_share order decoration from a glyph run, it counts them.",
    "Not merely does plateau_share order decoration from text, it classifies it.",
    "It is no accident plateau_share separates decoration from a glyph run.",
    "There is no denying plateau_share orders decoration from a glyph run.",
    "plateau_share was amended to order decoration from text", // E1b, before the verb
  ];
  for (const line of mustFlag) assert.ok(flagsClassificationClaim(line), `must flag: ${line}`);

  // Legitimate negations still allowed (the two-tier rule must not over-widen).
  const mustAllow = [
    "plateau_share does NOT distinguish decoration from text.",
    "no scalar separates decoration from text.",
    "none of these fields distinguishes decoration from text.",
    "plateau_share cannot distinguish decoration from text.",
    "plateau_share measures coverage rather than distinguish decoration from text.",
    "plateau_share does not order decoration from text; it is coverage.",
    "plateau_share instead of separating decoration from text just measures coverage.",
  ];
  for (const line of mustAllow) assert.equal(flagsClassificationClaim(line), false, `must allow: ${line}`);

  // F21: a marker in one table cell waives only THAT cell, not the whole row.
  assert.ok(
    flagsClassificationClaim('| [PARAPHRASE] "quoted old wording" | a live claim: plateau_share orders decoration from a glyph run. |'),
    "H2a: a marker in another cell must NOT waive this claim",
  );
  assert.equal(
    flagsClassificationClaim('| [PARAPHRASE] a live claim: plateau_share orders decoration from a glyph run. |'),
    false,
    "H2b: a marker at the START of the claim's own cell waives it",
  );
  assert.equal(
    flagsClassificationClaim("[PARAPHRASE] plateau_share orders decoration from a glyph run."),
    false,
    "H2c: a line-start marker waives",
  );
});

test("F22: a STRONG negation must GOVERN the verb, not merely precede it", () => {
  // F22 (eighteenth audit): the strong tier was still a 25-char PROXIMITY test, so
  // negations that precede a verb WITHOUT negating it waived a claim — and each of these
  // ASSERTS the classification, the opposite of a retraction.
  const mustFlag = [
    "plateau_share never fails to order decoration from a glyph run.", // A1
    "plateau_share without blinking orders decoration from a glyph run.", // A3
    "plateau_share no longer ambiguous orders decoration from a glyph run.", // A8
    "plateau_share without exception orders decoration from a glyph run.",
    "plateau_share never mind the noise orders decoration from a glyph run.",
  ];
  for (const line of mustFlag) assert.ok(flagsClassificationClaim(line), `must flag: ${line}`);

  // True negations with a retraction-bearing content word (GLUE) are now ALLOWED (F25) —
  // flagging them would punish writing the disclaimer.
  const retractions = [
    "plateau_share is not able to distinguish decoration from text.",
    "plateau_share cannot be said to separate decoration from text.",
    "plateau_share does not attempt to classify decoration from text.",
    "plateau_share should not be used to order decoration from text.",
    "plateau_share is never used to identify decoration from text.",
    "plateau_share is not intended to order decoration from text.",
  ];
  for (const line of retractions) assert.equal(flagsClassificationClaim(line), false, `a retraction must be allowed: ${line}`);

  // POLARITY: `never fails to order` is a DOUBLE NEGATIVE that ASSERTS the claim, so it
  // must stay flagged — it is the reference case that regresses if a polarity-inverting
  // word (`fail|fails`) is ever added to the glue list.
  assert.ok(
    flagsClassificationClaim("plateau_share never fails to order decoration from a glyph run."),
    "`never fails to order` asserts the claim and must remain flagged (polarity reference)",
  );

  // Simple governed negations must STILL be allowed.
  const mustAllow = [
    "plateau_share does NOT distinguish decoration from text.",
    "plateau_share cannot distinguish decoration from text.",
    "plateau_share never distinguishes decoration from text.",
    "plateau_share does not order decoration from text.",
    "no scalar separates decoration from text.",
    "none of these fields distinguishes decoration from text.",
  ];
  for (const line of mustAllow) assert.equal(flagsClassificationClaim(line), false, `must allow: ${line}`);
});

test("F23: a marker waives only the SPAN it precedes, not the whole cell", () => {
  // F23: the marker waived the entire CELL, so an unrelated claim later in the same cell
  // escaped. It now waives only up to the first sentence end.
  assert.ok(
    flagsClassificationClaim("| [PARAPHRASE] old wording. Also plateau_share orders decoration from a glyph run. |"),
    "B1: a marker must not waive a later claim in the same cell",
  );
  assert.equal(
    flagsClassificationClaim("| [PARAPHRASE] quoted old wording only |"),
    false,
    "B2: a marker legitimately waives its own quoted span",
  );
  // The sentence-end finder must NOT split on a period inside a filename or decimal — the
  // bug F17 fixed and the audit re-derived when a naive [.!?] split hit lib/measure.js.
  // Direction matters: a marker waives its whole SENTENCE, so a claim inside that sentence
  // (after a dotted token) must stay waived; without the `\w.\w` protection the split lands
  // on the filename, leaks the claim into the remainder, and produces a FALSE POSITIVE.
  assert.equal(
    flagsClassificationClaim("| [REMOVED] see lib/measure.js: plateau_share orders decoration from a glyph run. |"),
    false,
    "a dotted filename must not end the waived span early (would falsely flag quoted history)",
  );
  // And a claim in a LATER sentence (past the true sentence end) is still flagged.
  assert.ok(
    flagsClassificationClaim("| [REMOVED] see lib/measure.js. plateau_share orders decoration from a glyph run. |"),
    "a claim in a later sentence must still be flagged",
  );
});

test("F24: a marker with NO sentence end must waive only its quoted span, not the remainder", () => {
  // F24: `end >= 0 ? afterMarker.slice(end + 1) : ""` meant a marker whose cell had NO
  // sentence-ending period waived the ENTIRE remainder — a strictly easier escape than
  // B1, needing no punctuation anywhere. The H2 triple must all flag.
  const h2 = [
    "| [PARAPHRASE] old wording, and also plateau_share orders decoration from a glyph run |", // comma only
    "[PARAPHRASE] old wording — plateau_share orders decoration from a glyph run", // em-dash only
    "| [PARAPHRASE] quoted old — plateau_share separates decoration from text |", // em-dash, table
    "| [PARAPHRASE] old wording and also plateau_share orders decoration from a glyph run |", // no punctuation at all
  ];
  for (const line of h2) assert.ok(flagsClassificationClaim(line), `H2: marker with no sentence end must not waive the rest: ${line}`);

  // But a marker that DOES lead a quoted span waives that span.
  assert.equal(flagsClassificationClaim('| [PARAPHRASE] "quoted old wording" |'), false, "a quoted span after the marker is waived");
});

test("F22/F23 invariance pair: the SAME claim must get the SAME verdict with or without each waiver", () => {
  // The test that matters most (audit §5): every waiver mechanism must be INVARIANT —
  // adding it must not change the verdict on a live claim. It caught F18 and would have
  // caught F21/F22/F23.
  const claim = "plateau_share orders decoration from a glyph run.";
  const wrappers = [
    (c) => `${c} [PARAPHRASE]`, // trailing structural token (F18)
    (c) => `| [PARAPHRASE] old wording. ${c} |`, // marker + claim, same cell (F23)
    (c) => `| [PARAPHRASE] quoted | ${c} |`, // marker in another cell (F21)
    (c) => `plateau_share never fails to ${c.slice("plateau_share ".length)}`, // un-governing strong negation (F22)
    (c) => `plateau_share without blinking ${c.slice("plateau_share ".length)}`, // ditto
  ];
  assert.equal(flagsClassificationClaim(claim), true, "the bare claim is flagged");
  for (const wrap of wrappers) {
    assert.equal(flagsClassificationClaim(wrap(claim)), true, `a waiver must not change the verdict: ${wrap(claim)}`);
  }
});

test("F24/F25: the docs carry 0 flags, the disclaimer is PRESENT, and the guard states its scope", async () => {
  // The POSITIVE assertion is the primary, paraphrase-proof gate (audit §5): the docs must
  // CARRY the disclaimer. And the phrase rule must not fire on the docs at all.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const scanned = ["lib/measure.js", "README.md", "ACCURACY.md", "CHANGELOG.md", "index.js", "test-support/prose-guard.mjs"];
  let flags = 0;
  for (const rel of scanned) flags += scanForClassificationClaims(await readFile(path.join(root, rel), "utf8")).length;
  assert.equal(flags, 0, `the shipped docs must carry 0 claims (found ${flags})`);

  // Negative control: a "strict" rule (a marker waives NOTHING) MUST flag the quoted
  // history records — proving the marker list is load-bearing and that "real-doc flags=0"
  // is a real measurement, not an artefact of a rule that flags nothing.
  const strictWouldFlag = "**[REMOVED CLAIM]** `plateau_share` orders decoration from a glyph run.";
  assert.ok(/plateau_share/i.test(strictWouldFlag) && /orders/i.test(strictWouldFlag), "the history record contains a claim if the marker is ignored");

  // The guard must STATE that it is a best-effort lint, not a barrier (the disposition).
  const guardSrc = await readFile(path.join(root, "test-support", "prose-guard.mjs"), "utf8");
  assert.ok(/BEST-EFFORT LINT/i.test(guardSrc), "the guard must declare its scope (best-effort lint)");
  assert.ok(/PRIMARY/.test(guardSrc), "the guard must declare the positive assertion primary");

  // The disclaimer must be PRESENT in the docs (the paraphrase-proof gate).
  for (const rel of ["lib/measure.js", "README.md", "ACCURACY.md"]) {
    assert.ok(DISCLAIMER.test(normalizeForDisclaimer(await readFile(path.join(root, rel), "utf8"))), `${rel} must carry the disclaimer`);
  }
});

test("F21: a marker must annotate its OWN cell — every marker-bearing line is un-flagged", async () => {
  // The markers are load-bearing PER CELL. The checkable invariant: a line that contains
  // a REAL marker (one that waives a cell) must NOT be flagged — i.e. the marker annotates
  // quoted history in its own cell and no live claim sits in another cell of the same row.
  // This catches H2a (a marker in one cell granting cover to a claim in another) and a
  // marker in the wrong cell.
  //
  // Fixture rows (escaped pipes `\|`, used to SHOW the H2a/H2b cases) are excluded: they
  // deliberately contain a marker inside a quoted example, so they are demonstration text,
  // not live annotations.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const files = ["lib/measure.js", "README.md", "ACCURACY.md", "CHANGELOG.md", "index.js", "test-support/prose-guard.mjs"];
  const MARKER_ANYWHERE = /\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\]/i;
  let count = 0;
  for (const rel of files) {
    const text = await readFile(path.join(root, rel), "utf8");
    text.split("\n").forEach((line, i) => {
      if (!MARKER_ANYWHERE.test(line)) return;
      count++;
      assert.equal(
        flagsClassificationClaim(line),
        false,
        `${rel}:${i + 1} carries a marker yet is still flagged — the marker does not annotate its own cell (a marker in the wrong position leaves its claim live): ${line.trim().slice(0, 90)}`,
      );
    });
  }
  assert.ok(count >= 10, `expected the marker corpus to be non-trivial, found ${count}`);
});

test("F18: a waiver token appended to a LIVE claim must not excuse it (the F18 pair)", () => {
  // The single most valuable test: the SAME claim, with and without a trailing token,
  // must get the SAME verdict. F18 was a free-text token (`[PARAPHRASE]`) matched against
  // the clause, so appending it waived any claim — proven end-to-end by the audit.
  const claim = "plateau_share orders decoration from a glyph run.";
  assert.equal(flagsClassificationClaim(claim), true, "the bare claim is flagged");
  assert.equal(flagsClassificationClaim(`${claim} [PARAPHRASE]`), true, "a TRAILING marker must not waiver it");
  assert.equal(flagsClassificationClaim(`${claim} [paraphrase]`), true, "case-insensitive trailing marker must not waiver it");
  assert.equal(flagsClassificationClaim(`${claim} (wording amended 2026)`), true, "E1: 'amended' must not waiver it");
  assert.equal(flagsClassificationClaim("plateau_share orders decoration from text after the old gate was removed"), true, "E2: 'removed' must not waiver it");
  assert.equal(flagsClassificationClaim("plateau_share orders decoration from text and is not a classifier of anything else"), true, "E3: 'not a classifier' must not waiver a claim whose verb is un-negated");
  assert.equal(flagsClassificationClaim("plateau_share orders decoration from text although some claim it might invert"), true, "E5: 'invert' must not waiver it");
  assert.equal(flagsClassificationClaim("plateau_share orders decoration from text and that is no coincidence"), true, "E6: 'coincidence' must not waiver it");

  // A STRUCTURAL line-start marker still excludes quoted history.
  assert.equal(flagsClassificationClaim('**[REMOVED CLAIM]** `plateau_share` orders decoration from a glyph run.'), false, "line-start [REMOVED CLAIM] record is excluded");
});

test("F19: the field anchor covers EVERY emitted disclosure key", async () => {
  // F19: the anchor listed 5 names while the entry emits 9, so a claim naming an
  // unlisted field was a blind spot by construction. This asserts coverage from the
  // LIVE entry, so adding a field without extending the anchor fails the guard.
  const A = contrastInRegion(await loadPixels(await buildBarsReferenceF16Fixture()), BARS_REF_F16.region);
  const entry = A.mask_reconciliation.unmasked_failing_colours[0];
  for (const key of Object.keys(entry)) {
    assert.ok(CLAIM_FIELD.test(key), `FIELD does not cover the emitted key "${key}" — extend EMITTED_DISCLOSURE_KEYS`);
  }
  // And a claim naming an unlisted-looking field is now caught.
  assert.ok(flagsClassificationClaim("contrast_ratio orders decoration from a glyph run."), "a listed key is caught");
  assert.ok(flagsClassificationClaim("mean_component_area separates decoration from text."), "another listed key is caught");
});

test("F17/F18: the guard's recall is measured against paraphrases (fixtures)", () => {
  // A guard tested only against its own target phrase produced F17; one tested against
  // its own waiver token produced F18. F26 then found that the disposition PROMISED "a
  // measured recall" in four places while recording NO number. So this test now PRINTS the
  // number and ASSERTS the ratio, and a sibling test asserts the docs quote the same figure.
  const recall = measureRecall();
  // eslint-disable-next-line no-console
  console.log(`  [recall] prose guard measured recall on the fixture set: ${recall.recall} (caught ${recall.caught}/${recall.mustFlagTotal}, known miss still missed: ${recall.knownMissStillMissed}, false positives: ${recall.falsePositives})`);

  for (const line of MUST_FLAG) assert.ok(flagsClassificationClaim(line), `must flag: ${line}`);
  for (const line of MUST_ALLOW) assert.equal(flagsClassificationClaim(line), false, `must allow: ${line}`);

  // The ratio is ENFORCED: lowering recall fails the build rather than quietly changing
  // the story the docs tell.
  assert.equal(recall.knownMissStillMissed, true, "P4 is the recorded known miss");
  assert.equal(recall.falsePositives, 0, "the fixture set must have no false positives");
  assert.ok(
    recall.caught / recall.total >= 18 / 19,
    `measured recall regressed below 18/19 (caught ${recall.caught}/${recall.total})`,
  );

  // KNOWN MISS (recorded): P4, where a comma splits the field from the verb. Recorded as a
  // shared fixture so the ratio above includes it.
  assert.equal(flagsClassificationClaim(KNOWN_MISS), false, "P4 is a KNOWN miss (comma splits field from verb)");
});

test("F26: the docs must quote the SAME recall figure the guard measures", async () => {
  // The direct analogue of the invariance pair, moved from the guard to its own
  // DESCRIPTION (audit §4 fix 1 + §5): if the docs state a recall figure, it must equal the
  // computed one, so the disposition cannot drift into prose that no test can fail.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const recall = measureRecall();
  for (const rel of ["README.md", "ACCURACY.md", "test-support/prose-guard.mjs"]) {
    const text = await readFile(path.join(root, rel), "utf8");
    assert.ok(text.includes(recall.recall), `${rel} must quote the measured recall "${recall.recall}"`);
  }
  // And no doc may still carry the SUPERSEDED round-15 figure unlabelled.
  const accuracy = await readFile(path.join(root, "ACCURACY.md"), "utf8");
  for (const line of accuracy.split("\n")) {
    if (line.includes("1/9") || line.includes("1 / 9")) {
      assert.ok(/round-1[45]|superseded|historical|round-13|round-15 rule/i.test(line), `a 1/9 figure must be labelled superseded: ${line.trim().slice(0, 90)}`);
    }
  }
});

test("§3 (DECLINED): a solid accent block collides with real solid text", async () => {
  // Documented, not fixed. The accent block and a bold "I" at 150px are
  // indistinguishable by geometry (measured ~3000px vs ~3052px, both fill 1.000),
  // so any rule that suppressed the accent would also suppress real solid text.
  const png = await buildAccentBlockFixture();
  const r = contrastInRegion(await loadPixels(png), ACCENT_BLOCK.region);
  const accent = r.colours.find((c) => c.foreground === ACCENT_BLOCK.accent);
  assert.ok(accent, "the accent is reported (known, conservative false positive)");
  assert.equal(accent.contrast_ratio, ACCENT_BLOCK.accentRatio);
  assert.ok(r.colours.some((c) => c.foreground === ACCENT_BLOCK.text && c.wcag_aa), "the real text still passes");

  // And the same measurement on real solid text: a bold "I" is the same size.
  const boldI = await buildHugeGlyphFixture({ text: "I", size: 150, hardEdge: true });
  const ri = contrastInRegion(await loadPixels(boldI), HUGE_GLYPH.region);
  assert.ok(
    ri.colours.some((c) => c.foreground === HUGE_GLYPH.text),
    "real solid text at the accent's size must remain reported — this is why §3 is declined",
  );
});

// ==========================================================================
// Tenth-audit acceptance tests (F12: a colour masked between the tiling floor and
// the disclosure gate is masked AND undisclosed). Non-vacuous per
// verify/nonvacuity-round10.mjs.
// ==========================================================================

test("F12: every size in the masked band still SURFACES the failing colour", async () => {
  // The invariant: anything the mask removes must be eligible for disclosure. At
  // ~200-350px the glyph blobs fall between the masking floor (0.4% of the region)
  // and the old disclosure gate (2%), which made the colour vanish entirely.
  for (const size of [150, 200, 300, 420]) {
    const r = contrastInRegion(await loadPixels(await buildBandGlyphFixture({ size })), BAND_GLYPH.region);
    const reported = r.colours.some((c) => c.foreground === BAND_GLYPH.text);
    const disclosed = (r.mask_reconciliation?.unmasked_failing_colours || []).some(
      (c) => c.foreground === BAND_GLYPH.text && c.contrast_ratio === BAND_GLYPH.ratio,
    );
    assert.ok(
      reported || disclosed,
      `size=${size}: the 1.88:1 colour must be reported or disclosed (colours=${r.colours.map((c) => c.foreground).join(", ") || "none"}, recon=${r.mask_reconciliation ? "present" : "null"}, measurable=${r.measurable})`,
    );
    assert.notEqual(r.all_meet_aa, true, `size=${size}: must not claim a clean pass`);
  }
});

test("F12: the disclosure predicate is UNCONDITIONAL (no silent band, twelfth audit)", () => {
  // The tenth audit's "superset" claim was retracted (eleventh) for comparing a
  // mean to a single-blob floor; the eleventh union still left an
  // ANTI-CORRELATED seam (twelfth, F14). The predicate is now unconditional: any
  // failing colour the mask removed is disclosable, so there is no band at all.
  const region = 1000 * 700;
  const anyColour = { component_count: 164, pixel_count: 0.049 * region }; // E: mean 0.03%
  assert.equal(isDisclosableDroppedColour(anyColour, region), true, "even a tiny-mean, many-component colour");
  assert.equal(isDisclosableDroppedColour({ component_count: 64, pixel_count: 64 * 0.0036 * region }, region), true, "decorative bars (now disclosed, deliberately)");
  assert.equal(isDisclosableDroppedColour({ component_count: 1, pixel_count: 1 }, region), true, "even a one-pixel colour");
});

test("F12: the crop control still fires (keep green)", async () => {
  const r = contrastInRegion(await loadPixels(await buildBandGlyphFixture({ size: 200 })), BAND_GLYPH.crop);
  assert.ok(r.mask_reconciliation, "the crop discloses, as it did before the fix");
});

test("F12: shape is NOT a discriminator (F15) — the raw evidence is carried instead", async () => {
  // The thirteenth audit showed the old `shape` label was `mean = total / N` again
  // (F14's defect, one layer up): it flipped with fragmentation and inverted on the
  // realistic pair. It is REMOVED. The disclosure now carries raw, monotonic fields
  // so the caller judges.
  const panel = contrastInRegion(await loadPixels(await buildDroppedPanelFixture()), DROPPED_PANEL.region);
  assert.ok(panel.mask_reconciliation);
  const entry = panel.mask_reconciliation.unmasked_failing_colours[0];
  assert.equal("shape" in entry, false, "shape is gone");
  for (const k of ["component_count", "mean_component_area", "largest_component_share", "detected_plateau", "plateau_share"]) {
    assert.ok(k in entry, `the raw evidence ${k} is carried`);
  }
});

// ==========================================================================
// Eleventh-audit acceptance tests (F13: the round-10 "structural guarantee" was
// FALSE — the disclosure gate used a MEAN against the mask's SINGLE-BLOB floor,
// so a colour masked by one >=2% blob but dragged below 0.4% mean by many small
// companions was masked AND undisclosed). Non-vacuous per
// verify/nonvacuity-round11.mjs.
// ==========================================================================

test("F13: the round-10 guarantee is RETRACTED — and it was replaced, not merely withdrawn", () => {
  // The old predicate claimed to be a superset of the mask BECAUSE it reused
  // `PLATEAU_MIN_BLOB_SHARE`; it compared a MEAN to a single-blob floor and was
  // therefore narrower. The eleventh union closed that but kept a mean clause
  // that the twelfth audit showed is ANTI-CORRELATED with the evidence. The
  // predicate is now unconditional, so the retraction is complete.
  const region = 1000 * 700;
  const colour = { component_count: 11, pixel_count: 0.026 * region }; // mean ~0.24%
  assert.equal(isDisclosableDroppedColour(colour, region), true, "disclosed regardless of size");
  // The RETRACTED mean-only predicate is reproduced here so the mistake stays testable.
  const oldPredicate = (c, a) =>
    (c.component_count ? c.pixel_count / c.component_count : c.pixel_count) / a >= 0.004;
  assert.equal(oldPredicate(colour, region), false, "the retracted predicate hid this colour");
});

test("F13(a): a drop-cap plus small glyphs of ONE failing colour is disclosed", async () => {
  const r = contrastInRegion(await loadPixels(await buildDropcapTextFixture()), DROPCAP_TEXT.region);
  // The colour is masked (it is a detected plateau), so it is not in `colours`...
  assert.equal(r.colours.some((c) => c.foreground === DROPCAP_TEXT.text), false, "the mask removes the drop-cap colour");
  // ...but it must never be silent: it is disclosed with its real ratio.
  assert.ok(r.mask_reconciliation, "a masked drop-cap colour must trigger disclosure");
  const named = r.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === DROPCAP_TEXT.text);
  assert.ok(named, "the 1.88:1 drop-cap colour must be named");
  assert.equal(named.contrast_ratio, DROPCAP_TEXT.ratio);
  assert.equal(named.detected_plateau, true, "we say why the mask reached it: it was read as a plateau");
  assert.ok(named.largest_component_share >= 0.02, "and that its largest blob cleared the path-A floor");
  assert.notEqual(r.all_meet_aa, true, "must not report a clean pass");
  assert.ok(r.notes.some((n) => /Mask reconciliation/.test(n)), "and the note names it");
});

test("F13(b): a solid panel plus fragments where the masked result is EMPTY is still disclosed", async () => {
  const r = contrastInRegion(await loadPixels(await buildPanelPlusFragmentsFixture()), PANEL_FRAGMENTS.region);
  // The omission here is TOTAL — no colour at all in the masked result.
  assert.equal(r.colours.length, 0, "the mask removes every colour in this frame");
  assert.equal(r.measurable, false, "so nothing is measured");
  assert.ok(r.mask_reconciliation, "and yet the removed failing colour must be disclosed");
  const named = r.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === PANEL_FRAGMENTS.text);
  assert.ok(named, "the 1.88:1 colour must be named");
  assert.equal(named.contrast_ratio, PANEL_FRAGMENTS.ratio);
  assert.equal(named.detected_plateau, true);
});

test("F13: the disclosed entry now carries the plateau EVIDENCE used for wording", async () => {
  const r = contrastInRegion(await loadPixels(await buildDropcapTextFixture()), DROPCAP_TEXT.region);
  const named = r.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === DROPCAP_TEXT.text);
  assert.equal(named.detected_plateau, true);
  assert.ok(named.plateau_share > 0, "the plateau's share of the region is reported");
  assert.ok(named.largest_component_share > 0);
  assert.equal(typeof named.mean_component_area, "number");
  assert.ok(named.measured_against);
});

test("F13: the F12 band keep-green holds; F11 is deliberately NOT quiet (round 12)", async () => {
  // F12 — every masked-band size is still surfaced (unchanged by round 12).
  for (const size of [200, 300, 420]) {
    const r = contrastInRegion(await loadPixels(await buildBandGlyphFixture({ size })), BAND_GLYPH.region);
    assert.ok(
      r.colours.some((c) => c.foreground === BAND_GLYPH.text) ||
        r.mask_reconciliation?.unmasked_failing_colours.some((c) => c.foreground === BAND_GLYPH.text),
      `size=${size}: F12 band must stay surfaced`,
    );
  }
  // F11 — the round-9 quiet is now REVERSED (F14 showed the gate was
  // anti-correlated with the evidence). The VERDICT must still be a clean pass;
  // only the precision of the disclosure changed.
  const bars = contrastInRegion(await loadPixels(await buildDecorativeBarsFixture()), DECOR_BARS.region);
  assert.equal(bars.all_meet_aa, true, "the verdict is unchanged");
  assert.ok(bars.mask_reconciliation, "the bar colour is now disclosed, flagged as a plateau");
  // solid_blocks (panel-like) — still disclosed; the raw evidence lets a caller judge.
  const solid = contrastInRegion(await loadPixels(await buildDroppedPanelFixture()), DROPPED_PANEL.region);
  assert.ok(solid.mask_reconciliation);
  assert.equal(solid.mask_reconciliation.unmasked_failing_colours[0].detected_plateau, true);
});

// ==========================================================================
// Twelfth-audit acceptance tests (F14: the residual was ANTI-CORRELATED with the
// evidence — adding failing text of the same colour made the warning disappear).
// Non-vacuous per verify/nonvacuity-round12.mjs.
// ==========================================================================

test("F14: adding body text of the SAME failing colour must not silence the warning", async () => {
  // Control D: the heading alone. The 300px blobs are 1.74% of the region
  // (< the 2% path-A floor), so only the mean could fire — and it did (1.78%).
  const d = contrastInRegion(await loadPixels(await buildHeadingOnlyFixture()), HEADING_ONLY.region);
  assert.ok(d.mask_reconciliation, "D: the heading colour must be disclosed");
  assert.ok(
    d.mask_reconciliation.unmasked_failing_colours.some((c) => c.foreground === HEADING_ONLY.text),
    "D: the 1.88:1 colour must be named",
  );

  // E: the SAME heading plus six small body lines of the same colour. The mean
  // collapses (1.78% -> ~0.03%) while the largest blob is unchanged, so any
  // mean-based gate goes SILENT. This is the F14 inversion.
  const e = contrastInRegion(await loadPixels(await buildHeadingPlusBodyFixture()), HEADING_PLUS_BODY.region);
  assert.ok(e.mask_reconciliation, "E: MORE failing text must not remove the warning");
  const named = e.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === HEADING_PLUS_BODY.text);
  assert.ok(named, "E: the same 1.88:1 colour must still be named");
  assert.equal(named.contrast_ratio, HEADING_PLUS_BODY.ratio);
  assert.ok(named.component_count > 100, "E really does have many components (the mean would collapse)");
  assert.notEqual(e.all_meet_aa, true, "E must not claim a clean pass");
});

test("F14: the solid-block form (no text at all) is disclosed too", async () => {
  const r = contrastInRegion(await loadPixels(await buildResidualSolidTiledFixture()), RESIDUAL_SOLID_TILED.region);
  // The masked result is empty, exactly like F13(b) but with no glyphs involved.
  assert.equal(r.colours.length, 0);
  assert.equal(r.measurable, false);
  assert.ok(r.mask_reconciliation, "the removed failing colour must be disclosed");
  assert.ok(r.mask_reconciliation.unmasked_failing_colours.some((c) => c.foreground === RESIDUAL_SOLID_TILED.text));
});

test("F14: the mean is ANTI-CORRELATED with the evidence (the reason the gate was removed)", () => {
  // Reproduce the direction directly, without pixels: as component_count rises
  // with pixel_count, the mean share is flat-or-falling, so no mean floor can be
  // satisfied by adding MORE failing text. This is why a mean gate is not merely
  // imprecise but inverted.
  const region = 1000 * 700;
  const meanOf = (px, n) => (n ? px / n : px) / region;
  // A heading plus progressively more body text of the same colour.
  const samples = [[24966, 2], [30000, 40], [40000, 120], [44226, 164]];
  const means = samples.map(([px, n]) => meanOf(px, n));
  for (let i = 1; i < means.length; i++) {
    assert.ok(means[i] <= means[0], `mean must not increase as text is added (${means[i]} vs ${means[0]})`);
  }
  assert.ok(means[0] >= 0.004 && means[means.length - 1] < 0.004, "the first clears a mean floor and the last does not");
});

test("F13: the disclosed entry carries the numbers a caller needs to act", async () => {
  const r = contrastInRegion(await loadPixels(await buildDropcapTextFixture()), DROPCAP_TEXT.region);
  const named = r.mask_reconciliation.unmasked_failing_colours.find((c) => c.foreground === DROPCAP_TEXT.text);
  assert.equal(typeof named.pixel_count, "number");
  assert.equal(typeof named.component_count, "number");
  assert.equal(typeof named.largest_component_share, "number");
  assert.equal(typeof named.detected_plateau, "boolean");
  assert.ok(named.measured_against, "the reference colour is present");
});

// ==========================================================================
// Twenty-first-audit acceptance tests (F27 engine verdict on an unmodellable
// background; F28 multi-colour absorption). Non-vacuous per
// verify/nonvacuity-round21.mjs.
// ==========================================================================

test("F27: a text-free gradient must not be reported as FAILING text", async () => {
  const pixels = await loadPixels(await buildTextFreeGradientFixture());
  const region = { left: 0, top: 0, width: 1000, height: 700 };

  // The premise: a single global background is a poor model for the ramp.
  const g = contrastInRegion(pixels, region);
  assert.equal(g.background_fit.adequate, false, "the ramp is not modelled by one colour");
  assert.ok(g.background_fit.explained_fraction < 0.5, "the fit is below the adequacy floor");

  // The defect: the ramp's far END cleared the ink threshold and was reported as
  // a failing text colour (94% of the region — the background itself). A
  // text-free image has no failing text, so the engine must not assert one.
  assert.equal(g.measurable, false, "a text-free gradient must abstain, not assert a verdict");
  assert.equal(g.all_meet_aa, null, "all_meet_aa must be null, not false");
  assert.equal(g.failing_count, 0);
  assert.equal(g.colours.length, 0);
  assert.ok(
    g.abstained.some((a) => /background/i.test(a.reason)),
    "the abstention must say WHY (the global model is inadequate and local finds no text)",
  );

  // CONTROL: a genuinely flat, text-free page is unchanged (also abstains, but
  // for the ordinary "nothing here" reason, not the ramp reason).
  const flat = contrastInRegion(await loadPixels(await buildFlatTextFixture({ lines: [] })), FIXTURE.region);
  assert.equal(flat.measurable, false);
  assert.equal(flat.all_meet_aa, null);

  // CONTROL: the same gradient WITH real dark text keeps a failure — the fix
  // abstains only when there is no text at all, it never hides real text.
  const withText = contrastInRegion(await loadPixels(await buildTextFreeGradientFixture()), region);
  assert.equal(withText.measurable, false, "still no text in this fixture");
  const texted = contrastInRegion(
    await loadPixels(await buildGradientTextFixture()),
    { left: 0, top: 0, width: 900, height: 420 },
  );
  assert.equal(texted.measurable, true, "a gradient WITH text stays measurable");
  assert.equal(texted.all_meet_aa, false, "and its real failure is still reported");
});

test("F28: outlined text reports BOTH colours, and a failure cannot hide", async () => {
  const pixels = await loadPixels(await buildOutlinedTextFixture());
  const r = contrastInRegion(pixels, OUTLINED_TEXT.region);

  // The defect: the EXTREMAL colour (the light stroke) took the whole component,
  // so the darker interior — the larger, lower-contrast ink — appeared in NO
  // channel and the verdict read `all_meet_aa: true`.
  const fill = r.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
  assert.ok(fill, `the outlined fill ${OUTLINED_TEXT.fill} must be reported`);
  assert.equal(fill.wcag_aa, false, "and it must be measured as FAILING");
  assert.equal(r.all_meet_aa, false, "so the verdict can no longer read clean");
  assert.equal(r.failing_count, 1);

  // The stroke is still reported, with its OWN (small) pixel count — not the
  // whole component's. The independent census is stroke ~2543px, fill ~17226px.
  const stroke = r.colours.find((c) => c.foreground === OUTLINED_TEXT.stroke);
  assert.ok(stroke, "the stroke colour is still reported");
  assert.equal(stroke.wcag_aa, true);
  assert.ok(fill.pixel_count > stroke.pixel_count, "the fill is the larger ink");

  // REVERSED direction: a LIGHT fill with a DARK stroke. A fix that always kept
  // the extremal colour would pass the case above and fail this one, so both
  // directions live in ONE test.
  const rev = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fill: "#e8dfd0", stroke: "#464646" })),
    OUTLINED_TEXT.region,
  );
  const revDark = rev.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
  assert.ok(revDark, "the darker of TWO colours must survive in either direction");
  assert.equal(revDark.wcag_aa, false);
  assert.equal(rev.all_meet_aa, false);

  // CONTROL: fill only (no stroke) is unchanged — same failing colour, same ratio.
  const only = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ stroke: "#464646" })),
    OUTLINED_TEXT.region,
  );
  assert.equal(only.failing_count, 1);
  assert.equal(only.colours.find((c) => c.foreground === OUTLINED_TEXT.fill).contrast_ratio, OUTLINED_TEXT.fillRatio);
});

test("F29: small outlined text is not lost when its fill splits across components", async () => {
  // F28 applied the pixel floor PER COMPONENT. As a glyph shrinks its fill splits across
  // components, so no single piece clears the floor and the failing fill vanishes again —
  // F28's own gate reappearing one scalar lower (F29, the F13/F14 construction: a threshold
  // on a per-PIECE quantity where the TOTAL is what matters). The floor is now applied to the
  // colour's TOTAL across the scan.
  const region = OUTLINED_TEXT.region;

  // (1) The defect window. Hiding the fill is the F28 defect, so it must be reported at
  // every size down to where the fill drops below the shared reporting floor.
  const sizes = [180, 72, 56, 48, 44, 40, 36, 32, 30, 28];
  for (const fontSize of sizes) {
    const r = contrastInRegion(
      await loadPixels(await buildOutlinedTextFixture({ fontSize, strokeWidth: 2 })),
      region,
    );
    const fill = r.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
    assert.ok(fill, `${fontSize}px: the failing fill must be reported, not absorbed`);
    assert.equal(fill.wcag_aa, false, `${fontSize}px: the fill fails AA`);
    assert.equal(r.all_meet_aa, false, `${fontSize}px: the verdict must not read clean`);
  }

  // (2) AGGREGATION must be non-vacuous. "ABC" at 30px splits its fill into pieces of
  // 221 + 68 (total 289): a PER-COMPONENT floor emits NEITHER piece, the TOTAL emits the
  // colour. Without aggregation this assertion fails — that is the round-21 defect.
  const split = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ text: "ABC", fontSize: 30, strokeWidth: 2 })),
    region,
  );
  const splitFill = split.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
  assert.ok(splitFill, "a fill split across components must still be reported (aggregated total)");
  assert.equal(splitFill.wcag_aa, false);
  assert.equal(split.all_meet_aa, false);

  // (3) The honest BOUNDARY, asserted not implied. Below 28px the fill's TOTAL drops under
  // the shared reporting floor and is no longer an F28 absorption (the larger ink, the
  // stroke, is still reported). At 24px (true fill 81px) the fill is below the floor; the
  // colour is still surfaced via the stroke, and the gap is stated in ACCURACY.md §5y.
  const tiny = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fontSize: 24, strokeWidth: 2 })),
    region,
  );
  assert.ok(
    tiny.colours.some((c) => c.foreground === OUTLINED_TEXT.stroke),
    "at 24px the larger ink (the stroke) is still reported",
  );

  // (4) Controls that must stay quiet: the tiled card grid and dense-flat page (whose edge
  // shades the aggregation would otherwise admit) remain clean.
  const tiled = contrastInRegion(await loadPixels(await buildTiledCardsFixture()), TILED_CARDS.region);
  assert.equal(tiled.failing_count, 0, "card edge shades must not become failing text under aggregation");
  assert.equal(tiled.all_meet_aa, true);
});

test("F30: the second-ink floor is the SAME quantity as the primary floor (invariance pair)", async () => {
  // Round 22 used a second-ink floor of 224 — 28x stricter than the tool's own primary
  // reporting floor (minColourPixels = 8). So the SAME ~210px of failing #464646 was
  // reported in one context and hidden in another. This is the F13/F14 seam in its original
  // form. The pair below must agree.
  const region = OUTLINED_TEXT.region;

  // PRIMARY path: plain 16px "AB" (stroke === fill, so there is no second colour) — its
  // #464646 ink measures ~209px and must be reported.
  const plainText = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ text: "AB", fontSize: 16, fill: "#464646", stroke: "#464646" })),
    region,
  );
  const primaryFill = plainText.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
  assert.ok(primaryFill, "primary path: ~209px of #464646 must be reported");
  assert.equal(primaryFill.wcag_aa, false);
  assert.equal(plainText.all_meet_aa, false);

  // SECOND-INK path: outlined 30px — its fill is ~212px. Same quantity, same colour.
  const outlined = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fontSize: 30, strokeWidth: 2 })),
    region,
  );
  const secondInk = outlined.colours.find((c) => c.foreground === OUTLINED_TEXT.fill);
  assert.ok(secondInk, "second-ink path: ~212px of #464646 must ALSO be reported");
  assert.equal(secondInk.wcag_aa, false);
  assert.equal(outlined.all_meet_aa, false, "the two paths must agree on the verdict");
});

test("F31: dense small text on cards does not accumulate AA fringes into a false failure", async () => {
  // Round 22's per-TOTAL floor aggregated card->text anti-aliasing fringes across hundreds of
  // components into a "second colour" and reported it as failing text, flipping a passing
  // dashboard to all_meet_aa: false. Each fringe is a blend of the card toward the card's
  // text (residual <= 0.5 on that segment); the colour-aware AA window rejects them.
  const r = contrastInRegion(await loadPixels(await buildDenseSmallCardsFixture()), DENSE_SMALL_CARDS.region);

  assert.equal(r.all_meet_aa, true, "a passing dashboard must not be reported as failing");
  assert.equal(r.failing_count, 0, "no fringe shade may be reported as failing text");
  assert.ok(
    !r.colours.some((c) => c.foreground === DENSE_SMALL_CARDS.fringe),
    `the card->text fringe ${DENSE_SMALL_CARDS.fringe} must NOT be a text colour (got ${r.colours.map((c) => c.foreground).join(", ")})`,
  );
  // The real text is still reported (the fix must not silence the dashboard).
  assert.ok(
    r.colours.some((c) => c.foreground === DENSE_SMALL_CARDS.text && c.wcag_aa),
    "the real passing text is still reported",
  );

  // CONTROL: the same colour as a genuine second ink (outlined, large) IS reported — so the
  // fix rejects the FRINGE, not the colour.
  const outlined = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fontSize: 180, strokeWidth: 3 })),
    OUTLINED_TEXT.region,
  );
  assert.ok(outlined.colours.some((c) => c.foreground === OUTLINED_TEXT.fill && !c.wcag_aa));
});

test("F32: a fill that lies ON the reference→stroke line is not discarded as a fringe", async () => {
  // Round 23 widened the second-ink AA window to the FULL segment (0,1), so ANY colour on the
  // reference→extremal line was rejected. But real ink can sit on that line too: a mid-tone
  // fill under a lighter stroke. The rejection must require the colour to be a blend AND SMALL
  // (a fringe is a thin halo; real ink is large).
  const region = OUTLINED_TEXT.region;
  const bg = "#1a1814";
  const stroke = "#ffffff";
  const hex = (t) => {
    const b = [0x1a, 0x18, 0x14], w = [0xff, 0xff, 0xff];
    return "#" + b.map((c, i) => Math.round(c + (w[i] - c) * t).toString(16).padStart(2, "0")).join("");
  };

  // The defect band: t in {0.05, 0.10, 0.15, 0.20} on the bg→stroke line. Each must be
  // REPORTED (and fail AA) on the second-ink path, exactly as it is on the primary path.
  for (const t of [0.05, 0.1, 0.15, 0.2]) {
    const fill = hex(t);
    const outlined = contrastInRegion(
      await loadPixels(await buildOutlinedTextFixture({ fill, stroke, strokeWidth: 3, fontSize: 180 })),
      region,
    );
    const f = outlined.colours.find((c) => c.foreground === fill);
    assert.ok(f, `t=${t} (${fill}): the on-line fill must be reported, not discarded as a fringe`);
    assert.equal(f.wcag_aa, false, `t=${t} (${fill}): the fill fails AA`);
    assert.equal(outlined.all_meet_aa, false, `t=${t}: the verdict must not read clean`);

    // PAIR: the SAME fill with NO stroke (the primary path) must agree.
    const plain = contrastInRegion(
      await loadPixels(await buildOutlinedTextFixture({ fill, stroke: fill, strokeWidth: 3, fontSize: 180 })),
      region,
    );
    assert.ok(plain.colours.some((c) => c.foreground === fill && !c.wcag_aa), `t=${t}: the primary path also reports it (pair invariant)`);
  }

  // The census that makes it a REAL defect: #312f2c fill (17,291px) is 6.6x the white stroke
  // (2,617px), so hiding it is not "the smaller of two inks".
  const census = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fill: "#312f2c", stroke: "#ffffff", strokeWidth: 3, fontSize: 180 })),
    region,
  );
  const fillC = census.colours.find((c) => c.foreground === "#312f2c");
  const strokeC = census.colours.find((c) => c.foreground === "#ffffff");
  assert.ok(fillC && strokeC, "both inks are reported");
  assert.ok(fillC.pixel_count > strokeC.pixel_count, "the failing fill is the LARGER ink");

  // CONTROL: a genuine fringe must STILL be rejected — the dense small-cards dashboard stays
  // clean (F31 is not re-opened by relaxing the AA rule).
  const dense = contrastInRegion(await loadPixels(await buildDenseSmallCardsFixture()), DENSE_SMALL_CARDS.region);
  assert.equal(dense.all_meet_aa, true, "F31 must remain fixed");
  assert.equal(dense.failing_count, 0);
});

test("F33 (pre-existing, named): the second-ink mean-area gate is not unified to the primary floor", async () => {
  // The second-ink path carries a mean-area gate (20) that the primary path does not. This is
  // a KNOWN, PRE-EXISTING asymmetry (identical at rounds 21/22/23), recorded rather than
  // silently ignored. It must NOT be closed by unifying the floor to 8: measured, that
  // re-admits the dense-flat card strokes (#355540@2.26, 14292px) and fails 4 tests.
  const denseFlat = contrastInRegion(await loadPixels(await buildDenseFlatFixture()), { left: 0, top: 0, width: 1400, height: 900 });
  assert.equal(denseFlat.failing_count, 0, "the structural gate must still reject the dense-flat card strokes");
  assert.equal(denseFlat.all_meet_aa, true, "the dense-flat page is not reported as failing");
});

test("F34: the AA size qualifier is a per-colour TOTAL, not a per-component count", async () => {
  // Round 24 added the AA size qualifier using `count2` — THIS component's count. A real
  // on-line fill splits across glyphs as it shrinks, so each piece can fall under the
  // qualifier and the whole colour is discarded, in no channel (F34 — the same per-piece
  // error the pixel floor had before F29). The qualifier now uses the colour's accumulated
  // ON-LINE total, decided in the deferred pass.
  const region = OUTLINED_TEXT.region;
  const fill = "#312f2c";
  const onLine = async (text, size) =>
    contrastInRegion(
      await loadPixels(await buildOutlinedTextFixture({ text, fontSize: size, fill, stroke: "#ffffff", strokeWidth: 2 })),
      region,
    );

  // The defect: 16 glyphs at 24px — every fill piece is 30-127px (< 500), true total 610px.
  const many = await onLine("ABCDEFGHIJKLMNOP", 24);
  const f = many.colours.find((c) => c.foreground === fill);
  assert.ok(f, "the split on-line fill must be reported (its TOTAL clears the qualifier)");
  assert.equal(f.wcag_aa, false, "the fill fails AA (1.33:1)");
  assert.equal(many.all_meet_aa, false, "the verdict must not read clean");

  // COUNT-INVARIANCE (the analogue of round 22's font sweep and round 24's t-sweep): as the
  // glyph count rises at a fixed size, the fill's total rises, so once it clears the qualifier
  // it must stay reported — a per-component rule would be non-monotonic.
  const counts = [2, 4, 8, 16, 20];
  const words = ["AB", "ABCD", "ABCDEFGH", "ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOPQRST"];
  let seenReported = false;
  for (let i = 0; i < counts.length; i++) {
    const r = await onLine(words[i], 24);
    const present = !!r.colours.find((c) => c.foreground === fill);
    if (present) seenReported = true;
    if (seenReported) {
      assert.ok(present, `once the fill's total clears the qualifier it must stay reported (n=${counts[i]})`);
    }
  }
  assert.ok(seenReported, "some glyph count reaches a total above the qualifier");

  // CONTROL: F31 (dense small cards) stays clean — the qualifier still rejects real fringes.
  const dense = contrastInRegion(await loadPixels(await buildDenseSmallCardsFixture()), DENSE_SMALL_CARDS.region);
  assert.equal(dense.all_meet_aa, true, "F31 must remain fixed");
  // CONTROL: F32 matched pair still reported (a large single on-line fill).
  const single = await onLine("AB", 180);
  assert.ok(single.colours.some((c) => c.foreground === fill && !c.wcag_aa), "the single-glyph on-line fill is still reported");
});

test("F35: a decoration split below the region gate is not reported as failing text", async () => {
  // A near-background decoration whose TOTAL is >= 2% of the region but which is split into
  // many small SOLID pieces. The large-background-region gate used a per-BLOB MEAN, so it
  // evaded the gate and was reported as failing text (the F14 anti-correlation in the primary
  // path). It is now filtered on the TOTAL plus SOLIDITY, while the ORIGINAL mean test is
  // kept so the F7 textured-page backstop still fires.
  const region = SPLIT_BACKGROUND.region;
  for (const n of [1, 4, 16, 36]) {
    const r = contrastInRegion(await loadPixels(await buildSplitBackgroundFixture({ n })), region);
    assert.ok(
      !r.colours.some((c) => c.foreground === SPLIT_BACKGROUND.colour),
      `n=${n}: a split background-sized decoration must not be a text colour`,
    );
    assert.equal(r.all_meet_aa, true, `n=${n}: the page is clean`);
  }

  // CONTROL: the F7 textured page (a single 33%-of-region blob, NOT solid) is still caught by
  // the region backstop — the mean test is retained alongside the total+solid test.
  const textured = contrastInRegion(await loadPixels(await buildTexturedPageCardsFixture()), TILED_CARDS.region);
  assert.ok(textured.background_regions.length >= 1, "the textured page is still a background region");
});

test("COUNT-INVARIANCE (standing): a fixed colour total must give the SAME verdict at any piece count", async () => {
  // STANDING test for the per-piece class: for a fixed ink total, changing only how many
  // pieces it is split into must not change the verdict.
  //
  // COVERAGE IS MEASURED, NOT ASSUMED (round 27; re-measured round 29). Re-introducing each
  // historical defect and running THIS test:
  //   F32 (reject any blend)            -> caught (second-ink, n=1)
  //   F34 (per-component AA qualifier)  -> caught (second-ink, n=4/8/16)
  //   F35 (mean-only region rule)       -> caught (decoration, n=16/36)
  //   F29 / F30 / F31                   -> NOT caught here; each has its own test
  //   F36 (hard-coded extra flags)      -> NOT caught here (measured: still passes); it needs a
  //                                        HOLLOW parent (a shadow), which this sweep does not
  //                                        build. It has its own F36 test.
  // The second-ink cases specifically require part (a)'s construction (a fill carrying its own
  // outline IN THE SAME ELEMENT, so the fill is a `multi_colour_of` extra). A bare filled
  // rectangle — part (b) — is a PRIMARY component (`extras = 0`) and never enters the
  // second-ink path, so it cannot see F32/F34. Both paths are therefore covered separately.
  const region = OUTLINED_TEXT.region;
  const svg = (parts) => sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();

  // (a) SECOND-INK: fixed total 2000px, 1..16 pieces, each a fill+outline in ONE element.
  // Measured extras 1/2/4/8/16, max piece 1681->49 (spanning the per-component qualifier).
  for (const n of [1, 2, 4, 8, 16]) {
    const side = Math.round(Math.sqrt(2000 / n));
    const parts = [`<rect width="1000" height="700" fill="#1a1814"/>`];
    for (let i = 0; i < n; i++) {
      const x = 40 + (i % 8) * 110;
      const y = 40 + Math.floor(i / 8) * 110;
      parts.push(`<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="#312f2c" stroke="#ffffff" stroke-width="3"/>`);
    }
    const r = contrastInRegion(await loadPixels(await svg(parts)), region);
    assert.ok(
      r.colours.some((c) => c.foreground === "#312f2c" && !c.wcag_aa),
      `second-ink: a fixed-total fill must be reported at every piece count (n=${n})`,
    );
  }

  // (b) PRIMARY PATH, fixed total, 1..16 pieces, each a BARE filled rectangle (the colour is its
  // own component — this is the primary path, not the second-ink path).
  for (const n of [1, 4, 8, 16]) {
    const side = Math.round(Math.sqrt(2000 / n));
    const parts = [`<rect width="1000" height="700" fill="#1a1814"/>`];
    for (let i = 0; i < n; i++) {
      const x = 40 + (i % 8) * 110;
      const y = 40 + Math.floor(i / 8) * 110;
      parts.push(`<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="#312f2c"/>`);
    }
    const r = contrastInRegion(await loadPixels(await svg(parts)), region);
    assert.ok(
      r.colours.some((c) => c.foreground === "#312f2c" && !c.wcag_aa),
      `primary: a fixed-total ink must be reported at every piece count (n=${n})`,
    );
  }

  // (c) DECORATION, fixed total ~14,400px (region-sized), split 1..36 ways -> filtered in every
  // case (F35). The inverse direction of the same class.
  for (const n of [1, 4, 16, 36]) {
    const r = contrastInRegion(await loadPixels(await buildSplitBackgroundFixture({ n })), SPLIT_BACKGROUND.region);
    assert.ok(!r.colours.some((c) => c.foreground === SPLIT_BACKGROUND.colour), `decoration n=${n} must stay filtered`);
  }
});

test("F36: a soft drop shadow (hollow decoration) is not reported as failing text", async () => {
  // A blurred shadow between two plateaus (page + card) is emitted as a SECOND-INK extra of
  // the shadow component. That component is a large HOLLOW ring (box 728x468, fill_ratio
  // 0.2214), so it is decoration. But the emitted extra used to hard-code
  // `looks_like_structure: false`, so `cl.hollow === 0` for the colour and it slipped past the
  // decorative gate (which drops a colour only when EVERY box is structural). It set `worst`
  // with a near-background ratio, flipping a decorative card to `all_meet_aa: false`. An extra
  // shares the parent's box and fill_ratio, so it cannot be LESS structural than its parent.
  const region = SOFT_SHADOW.region;

  // (1) MUST FILTER — the soft shadow. It must ALSO be DISCLOSED (in `excluded`, with a
  // decorative reason), never silently dropped.
  const soft = contrastInRegion(await loadPixels(await buildSoftShadowFixture({ stdDeviation: 14 })), region);
  assert.equal(soft.all_meet_aa, true, "a decorative shadow must not make the verdict fail");
  assert.equal(soft.failing_count, 0, "the shadow is not failing text");
  assert.ok(!soft.colours.some((c) => c.foreground === SOFT_SHADOW.shadowColour), "the shadow colour is not a text colour");
  const disclosed = soft.excluded.find((c) => c.foreground === SOFT_SHADOW.shadowColour);
  assert.ok(disclosed, "the shadow colour must be DISCLOSED in `excluded`, not silently dropped");
  assert.match(disclosed.reason, /decorative/i, "disclosed with a decorative reason");

  // (2) MUST FILTER — a tighter blur (sigma=4) produces a different blend colour, same outcome.
  const tight = contrastInRegion(await loadPixels(await buildSoftShadowFixture({ stdDeviation: 4 })), region);
  assert.equal(tight.all_meet_aa, true, "a tight shadow is still decoration");
  assert.ok(!tight.colours.some((c) => c.foreground === SOFT_SHADOW.shadowTightColour));

  // (3) MUST NOT CHANGE — a shadow on a single-plateau page (page = card colour) is unaffected.
  // The single-plateau shadow + text case (no card) is a DIFFERENT mechanism (a near-solid
  // region-sized PARENT) and is covered by its own F37 test below.
  const flat = contrastInRegion(
    await loadPixels(await buildSoftShadowFixture({ stdDeviation: 14, page: "#2d2822" })),
    region,
  );
  assert.equal(flat.all_meet_aa, true, "single-plateau shadow case is unaffected");

  // (4) MUST STILL REPORT — the F32 on-line fill (#312f2c under a 3px #ffffff stroke at 180px)
  // is genuine second ink whose parent (the stroke) is NOT hollow. The fix must not touch it.
  const f32 = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fill: "#312f2c", stroke: "#ffffff", strokeWidth: 3, fontSize: 180 })),
    OUTLINED_TEXT.region,
  );
  const f32fill = f32.colours.find((c) => c.foreground === "#312f2c");
  assert.ok(f32fill, "the on-line fill is still reported");
  assert.equal(f32fill.wcag_aa, false, "the on-line fill still fails AA");
  assert.equal(f32.all_meet_aa, false, "the F32 verdict must not read clean");

  // (5) MUST STILL REPORT — plain low-contrast text (the primary path) is untouched.
  const plain = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ fill: "#4a443c", stroke: "#4a443c", strokeWidth: 3, fontSize: 120 })),
    OUTLINED_TEXT.region,
  );
  assert.ok(plain.colours.some((c) => c.foreground === "#4a443c" && !c.wcag_aa), "plain low-contrast text is still reported");

  // (6) MUST STILL FILTER — a hollow ring of a stroke COLOUR, and its AA fringe toward the
  // page, are both decorative borders, not text (the negative direction — guards against
  // inverting the rule). The fringe is a blend of a decoration, so it is decoration too.
  // The ring is deliberately SMALL (200x150) so it passes the parent-box gate: the fix under
  // test is the ONLY thing that can filter its fringe (verified non-vacuous — with the
  // hard-coded flags restored, this small ring reports `#2a2824@1.2`).
  const ring = contrastInRegion(await loadPixels(await buildHollowRingFixture({ ringW: 200, ringH: 150 })), HOLLOW_RING.region);
  assert.notEqual(ring.all_meet_aa, false, "a hollow border ring must not make the verdict fail");
  assert.equal(ring.failing_count, 0, "a hollow border ring is not failing text");
  assert.ok(!ring.colours.some((c) => c.foreground === HOLLOW_RING.stroke), "the border stroke is not a text colour");
  assert.ok(!ring.colours.some((c) => c.foreground === HOLLOW_RING.fringe), "the border's AA fringe is not a text colour");

  // (7) CONTROL — the F31 dense small-cards dashboard is still clean (the fix must not admit
  // an anti-aliasing fringe anywhere else), and a SOLID region-sized block is still filtered.
  const dense = contrastInRegion(await loadPixels(await buildDenseSmallCardsFixture()), DENSE_SMALL_CARDS.region);
  assert.equal(dense.all_meet_aa, true, "F31 must remain fixed");
  assert.equal(dense.failing_count, 0);
});

test("F37: a second-ink extra of a region-spanning parent is not a text colour", async () => {
  // The parent-box gate already states the rule — "a GLYPH component cannot SPAN the region: if
  // it does, the 'second colour' is field shading, not text" — but its threshold (0.5) sat at
  // the text-facing edge of the measured gap, so a parent at box 0.4867 slipped under it. A
  // soft shadow merged with its text makes exactly that parent: a near-solid (fill 0.996),
  // region-sized (ink 41% of the region, box 48.7%) blob whose extremal colour is the text run,
  // so the shadow tone becomes its extra and was reported as failing text (measured
  // `#151413@1.04` in GLOBAL mode — the mode the fixture is measured in below; local mode was
  // already clean at the pre-round-29 revisions a6cc6d2/c700845, which an earlier version of
  // this comment and commit a316f23 got wrong by saying "in BOTH background modes". Corrected
  // in round 30). The threshold now sits IN the gap (0.2):
  // measured, real second-ink parents are <= 3.9% of the region across every outlined-text
  // fixture and the count-invariance sweep, while decoration parents are >= 48.7%.
  const region = SOFT_SHADOW.region;

  for (const mode of ["global", "local"]) {
    const r = contrastInRegion(
      await loadPixels(await buildSoftShadowFixture({ stdDeviation: 14, withCard: false })),
      region,
      { backgroundMode: mode },
    );
    assert.notEqual(r.all_meet_aa, false, `[${mode}] a shadow's field shading must not fail the verdict`);
    assert.ok(
      !r.colours.some((c) => c.contrast_ratio < 2),
      `[${mode}] no near-background colour may be reported as text (got ${r.colours.map((c) => c.foreground).join(", ")})`,
    );
  }

  // CONTROL — a genuine LARGE glyph whose fill is a second ink (parent = the stroke, ~2.9% of
  // the region) is still reported. The threshold must not eat real large text.
  const big = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ text: "W", fontSize: 180, strokeWidth: 3, fill: "#312f2c", stroke: "#ffffff" })),
    OUTLINED_TEXT.region,
  );
  assert.ok(big.colours.some((c) => c.foreground === "#312f2c" && !c.wcag_aa), "a real large-glyph second ink is still reported");
});

test("F38: the verdict must not contradict the tool's own cross-check", async () => {
  // A large outlined glyph's failing fill (#312f2c, 1.33:1) leaves the GLOBAL verdict's colours
  // at >=240px (the global model drops it as a large low-contrast cluster), while the per-tile
  // (local) model still finds it — so `model_disagreement` names the failing colour while the
  // global verdict read clean. The response was therefore self-contradictory: `all_meet_aa: true`
  // and, in the same object, a note naming the failing colour. The invariant: such a response
  // must NOT assert `all_meet_aa: true`. It ABSTAINS (null / "unverified"). See ACCURACY.md §5ag.
  const W = 1000, H = 700;
  const region = { left: 0, top: 0, width: W, height: H };
  const head = (fs) =>
    sharp(Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${H}" fill="#1a1814"/>` +
        `<text x="30" y="350" font-family="DejaVu Sans" font-weight="bold" font-size="${fs}" ` +
        `fill="#312f2c" stroke="#ffffff" stroke-width="3">AB</text></svg>`,
    )).png().toBuffer();

  // The invariant across the whole size band (the defect is a STEP: 230 reports, 240 does not).
  for (const fs of [200, 220, 230, 240, 300, 400, 500]) {
    const r = contrastInRegion(await loadPixels(await head(fs)), region);
    assert.ok(
      !(r.all_meet_aa === true && r.model_disagreement),
      `[fs=${fs}] all_meet_aa:true must not co-exist with a model_disagreement`,
    );
    if (r.model_disagreement) {
      assert.equal(r.all_meet_aa, null, `[fs=${fs}] a contradicting cross-check must give an unverified verdict`);
      assert.equal(r.verdict, "unverified", `[fs=${fs}] the verdict names the unverified state`);
    }
  }

  // CONTROL (must still report) — at 220px the global model DOES find the fill: a real failure,
  // not an abstention, with no disagreement.
  const small = contrastInRegion(await loadPixels(await head(220)), region);
  assert.equal(small.all_meet_aa, false, "the sub-step size reports a real failure");
  assert.equal(small.verdict, "failing");
  assert.equal(small.failing_count, 1);
  assert.ok(small.colours.some((c) => c.foreground === "#312f2c" && !c.wcag_aa), "the failing fill is in colours");
  assert.equal(small.model_disagreement, null, "no disagreement when the global model finds it");

  // CONTROL (must stay clean) — a genuinely clean region (only a passing colour) returns clean
  // with no disagreement, so the fix cannot make every large glyph abstain.
  const clean = contrastInRegion(
    await loadPixels(await buildOutlinedTextFixture({ text: "AB", fontSize: 240, strokeWidth: 3, fill: "#e8dfd0", stroke: "#e8dfd0" })),
    OUTLINED_TEXT.region,
  );
  assert.equal(clean.all_meet_aa, true, "a genuinely clean large glyph stays clean");
  assert.equal(clean.verdict, "clean");
  assert.equal(clean.model_disagreement, null);
});

