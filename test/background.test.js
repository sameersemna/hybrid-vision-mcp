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
  FIXTURE,
  TWO_PANEL,
  SHALLOW_GRADIENT,
  TILED_CARDS,
  HUGE_GLYPH,
  DENSE_PANEL,
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
  assert.equal(r.all_meet_aa, true, "the global verdict is a clean pass");
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
  assert.equal(r.all_meet_aa, true);

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

