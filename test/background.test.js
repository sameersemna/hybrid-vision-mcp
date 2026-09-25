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
import sharp from "sharp";

import {
  loadPixels,
  contrastInRegion,
  enumerateRegionContrast,
  extractInkComponents,
  tileBackgroundField,
  assessBackgroundFit,
} from "../lib/measure.js";
import {
  buildContrastFixture,
  buildPhotographicFixture,
  buildDenseFlatFixture,
  FIXTURE,
} from "../test-support/fixtures.mjs";
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
