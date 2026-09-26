// ==========================================
// Deterministic pixel measurement layer.
// ==========================================
// Every function here answers a *measurable* question with code: how many
// boxes, what colour, what contrast, how much non-background content in a
// region. None of it touches Ollama, so these answers remain available even
// when the vision model is down or contended (acceptance test #5).
//
// Design note: the server previously answered "is the contrast sufficient?"
// by *asking a language model*, which produced a confident wrong answer
// (F4: claimed good contrast on measured 1.76:1 text). Contrast is arithmetic.

import sharp from "sharp";
// MAD -> sigma conversion for a normal distribution. Used to turn a robust
// per-tile spread estimate into a noise scale.
const MAD_TO_SIGMA = 1.4826;

// --- Structural anti-aliasing guard thresholds (measured, see ACCURACY.md 5e) ---
// Anti-aliasing fragments are SMALL and NUMEROUS (librsvg halos: 1-2 components,
// ~34px mean area). Genuine text runs are FEW and LARGE (a 7-glyph line: 7-10
// components, ~320px mean area). Mean component area therefore separates a real
// text line from an AA halo, where colour alone cannot: a mid-grey text run is
// exactly collinear between the background and a brighter text run, so it
// satisfies the "is a blend" colour test and was swallowed on gradient images.
// A candidate is treated as independently text-like when BOTH hold.
const MIN_TEXT_COMPONENTS = 3;   // an AA halo fragments into 1-2 pieces per glyph edge
const MIN_TEXT_MEAN_AREA = 100;  // px; measured AA fragments are ~34px, real glyphs ~300px
const minMeanAreaRatio = 0.5;    // text strokes are not far thinner than a sibling run's

// --- Multi-plateau background detection (third-audit F5, ACCURACY.md 5e) ---
// A "plateau" is a large flat colour region (a panel, a card, a page background).
// A UI commonly has two or more (sidebar + content). One modal background cannot
// model them, so text on the non-modal panel must be measured against ITS OWN
// panel — and panel fills must be treated as background rather than as ink.
const PLATEAU_QUANT = 8;         // per-channel quantisation step for bucketing
const PLATEAU_MIN_SHARE = 0.02;  // a plateau's largest connected region holds >= 2%
const PLATEAU_MERGE_DIST = 12;   // plateaus nearer than this are one plateau
const PLATEAU_FLAT_SHARE = 0.85; // one exact colour must dominate the region (flatness).
  // Measured (ACCURACY.md 5e): real flat panels score 0.99+; a smooth gradient
  // band is one big connected region but only ~0.10-0.18 of it is any one exact
  // colour. 0.85 sits in the measured gap, so a gradient never becomes a
  // "plateau" while a rendered panel (even with slight dithering) always does.
// A single blob must hold this share of its colour's pixels to be a panel. This
// rejects REPEATED glyphs: two identical letters give dominance ~0.50, while
// every real panel measures >= 0.78 (measured: F10 perforated card 0.997,
// acceptance bg 0.781, two-panel 0.995/0.998, dense bg 1.000, F7 page 1.000;
// repeated glyphs 0.500-0.505). The threshold sits in that gap.
// An exception is the TILED path (B), which exists precisely because a repeated
// card fill has low dominance (F7 cards 0.083) but is solid and panel-sized.
const PLATEAU_DOMINANCE = 0.6;

// --- Ring vs perforated panel (eighth-audit F10, ACCURACY.md 5i) ---
// An INSET blob with one large enclosed aperture is a glyph RING; an inset blob
// perforated by many small holes is a content-dense panel. Measured largest
// enclosed hole as a fraction of the bbox: ring 0.253-0.257, every panel
// (perforated card 0.008, solid card, page, dense background) <= 0.033.
const RING_HOLE_FRACTION = 0.12;

// --- Tiled-panel detection (sixth-audit F7, ACCURACY.md 5g) ---
// A dashboard tiles its plane with repeated cards, so a panel FILL is also
// "many small identical blobs" — the same signature as a glyph run. Blob COUNT
// therefore cannot separate a card grid from text (twelve cards give
// dominance ~0.08, which the single-blob test above rejects). What separates
// them is SOLIDITY and SIZE per blob: a card is a large near-solid rectangle,
// a glyph stroke is small and thin.
const PLATEAU_MIN_BLOB_SHARE = 0.004; // a panel blob holds >= 0.4% of the region
                                      // (measured: cards 0.65%, acceptance bg 74%,
                                      //  text glyphs 0.003-0.03%)
const PLATEAU_SOLID_FILL = 0.85;      // a panel blob is a near-solid rectangle
                                      // (measured: cards >= 0.989, text strokes <= 0.60)
const PLATEAU_SIZE_CV = 0.5;          // tiled blobs repeat similar sizes
                                      // (measured CV: cards ~0.0, glyph runs ~1.0+)
const PLATEAU_MIN_ELONGATION_WIDTH = 4; // a straight segment is <=4px thick across
                                      // (measured: card borders 1-3px, glyph strokes 19px)

// A single-colour fit below this is a "marginal" model even when it clears the
// adequacy floor: the floor (0.5) is a round number and an image can sit just
// above it (measured: 0.501) while a global background is still poor. Below this
// bar the response says so, so a verdict is never silent about a marginal
// premise. Measured on real flat UIs (2026-09-25): text-heavy white page 0.904,
// card grid on grey 0.619, acceptance fixture 0.962, two-panel 0.693 (multi-
// plateau). 0.8 flags a gradient (0.007-0.081) and the shallow-gradient residual
// (0.501) without firing on a clean flat screenshot.
const GOOD_FIT_FRACTION = 0.8;

import {
  parseColor,
  contrastRatio,
  wcagCompliance,
  toHex,
  rgbDistance,
  relativeLuminance,
  roundRatio,
} from "./color.js";

/**
 * Decode an image buffer into raw 8-bit RGB pixels.
 * @param {Buffer} buffer
 * @returns {Promise<{ data: Buffer, width: number, height: number, channels: number }>}
 */
export async function loadPixels(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Read a pixel as `{ r, g, b }` (assumes 3-channel input from loadPixels).
 * @param {{ data: Buffer, width: number, channels: number }} pixels
 * @param {number} x
 * @param {number} y
 */
export function pixelAt(pixels, x, y) {
  const idx = (y * pixels.width + x) * pixels.channels;
  return { r: pixels.data[idx], g: pixels.data[idx + 1], b: pixels.data[idx + 2] };
}

/**
 * Normalise/clip a region to the image bounds.
 * @param {{ width: number, height: number }} pixels
 * @param {{ left?: number, top?: number, width?: number, height?: number }} region
 */
export function clampRegion(pixels, region = {}) {
  const left = Math.max(0, Math.min(pixels.width - 1, Math.floor(region.left ?? 0)));
  const top = Math.max(0, Math.min(pixels.height - 1, Math.floor(region.top ?? 0)));
  const width = Math.max(1, Math.min(pixels.width - left, Math.floor(region.width ?? pixels.width)));
  const height = Math.max(1, Math.min(pixels.height - top, Math.floor(region.height ?? pixels.height)));
  return { left, top, width, height };
}

/**
 * Build an exact-colour histogram over a region.
 * @returns {Map<number, number>} key = packed rgb, value = pixel count
 */
export function colorHistogram(pixels, region) {
  const r = clampRegion(pixels, region);
  const hist = new Map();
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) {
      const idx = (y * pixels.width + x) * pixels.channels;
      const key = (pixels.data[idx] << 16) | (pixels.data[idx + 1] << 8) | pixels.data[idx + 2];
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  return hist;
}

/**
 * Convert a packed-key histogram into a sorted array of colour entries.
 * @param {Map<number, number>} hist
 * @returns {Array<{ rgb: {r:number,g:number,b:number}, hex: string, count: number }>}
 */
export function histogramToEntries(hist) {
  return [...hist.entries()]
    .map(([key, count]) => ({
      rgb: { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff },
      hex: toHex({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff }),
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Report the dominant colours within a region.
 * @param {object} pixels
 * @param {object} region
 * @param {{ top?: number }} [opts]
 */
export function dominantColors(pixels, region, opts = {}) {
  const entries = histogramToEntries(colorHistogram(pixels, region));
  const total = entries.reduce((s, e) => s + e.count, 0);
  return entries.slice(0, opts.top ?? 8).map((e) => ({
    ...e,
    share: total ? roundRatio((e.count / total) * 100) : 0,
  }));
}

/**
 * Extract "ink" components — connected regions of pixels that differ from the
 * background — and reduce each one to the single colour that best represents
 * its glyph core.
 *
 * Why components rather than a colour histogram:
 * A naive histogram of an anti-aliased screenshot contains hundreds of edge
 * shades (the fixture has 608 distinct colours, most of them 1-2px halos).
 * Filtering those by frequency *or* by contrast is exactly how a genuinely
 * low-contrast string gets dropped. Grouping pixels into spatial components
 * instead means each glyph contributes one candidate colour — its most extreme
 * pixel — so anti-aliasing is removed by structure rather than by a threshold.
 *
 * @param {object} pixels
 * @param {{ background?: object, inkThreshold?: number, minArea?: number, maxComponents?: number, region?: object,
 *           backgroundMode?: "global"|"local", tileSize?: number, noiseFactor?: number }} [opts]
 * @returns {{ components: Array<object>, background: object, ink_pixel_count: number, truncated: boolean,
 *             background_mode: string, effective_ink_threshold: number|null, median_ink_threshold: number|null }}
 */
export function extractInkComponents(pixels, opts = {}) {
  const { data, width, height, channels } = pixels;
  const background = opts.background || null;
  const backgrounds = Array.isArray(opts.backgrounds) && opts.backgrounds.length
    ? opts.backgrounds
    : null; // multi-plateau: a pixel is background if near ANY of these
  const inkThreshold = opts.inkThreshold ?? 4;
  const minArea = opts.minArea ?? 6;
  const maxComponents = opts.maxComponents ?? 4000;
  const backgroundMode = opts.backgroundMode === "local" ? "local" : "global";
  const tileSize = opts.tileSize ?? 48;
  // k in `threshold = max(floor, k * sigma_local)`. Measured (ACCURACY.md §5c):
  // k=4 gives 0 spurious colour groups on text-free noise and full recovery of
  // known text colours, across noise levels 3..20.
  const noiseFactor = opts.noiseFactor ?? 4;

  const bg = background || dominantColors(pixels, { left: 0, top: 0, width, height }, { top: 1 })[0].rgb;
  const field = backgroundMode === "local" ? tileBackgroundField(pixels, tileSize) : null;

  // With multiple plateaus the reference for a colour is the NEAREST plateau —
  // text on a dark sidebar must be measured against that sidebar, not against a
  // bright content panel that happens to be the modal colour (third-audit F5).
  const refFor = (rgb) => {
    if (!backgrounds) return bg;
    let best = backgrounds[0];
    let bestD = Infinity;
    for (const p of backgrounds) {
      const d = rgbDistance(rgb, p);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  /**
   * The local background a component sits on: the modal colour of the
   * non-ink (mask == 0) pixels in a small ring just outside the component's
   * bounding box. This is the SURROUNDING fill, which is what text visually
   * contrasts against.
   *
   * Why not the nearest plateau to the glyph core: a dark glyph on a bright
   * panel has a dark core, so "nearest plateau to the core" picks a dark panel
   * that the glyph is not actually on. The ring measures where the glyph sits.
   */
  const ringBackground = (box) => {
    const pad = 3;
    const l = Math.max(scan.left, box.left - pad);
    const t = Math.max(scan.top, box.top - pad);
    const rgt = Math.min(scan.left + scan.width, box.left + box.width + pad);
    const bot = Math.min(scan.top + scan.height, box.top + box.height + pad);
    const counts = new Map();
    for (let y = t; y < bot; y++) {
      for (let x = l; x < rgt; x++) {
        const idx = y * width + x;
        if (mask[idx]) continue; // ink of this or another component
        const i = idx * channels;
        const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    if (counts.size === 0) return null;
    let bestK = 0;
    let bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { bestN = n; bestK = k; }
    return { r: (bestK >> 16) & 0xff, g: (bestK >> 8) & 0xff, b: bestK & 0xff };
  };

  // Optional region restriction: only pixels inside it are considered, but all
  // reported coordinates remain absolute to the full image.
  const scan = opts.region
    ? clampRegion(pixels, opts.region)
    : { left: 0, top: 0, width, height };

  // 1. Ink mask: any pixel meaningfully different from the background.
  //    With background_mode "local" the reference is a per-tile robust
  //    background and the threshold scales with that tile's measured noise, so
  //    photographic/gradient backgrounds do not drown the mask. On a flat image
  //    the local noise scale is 0 and the threshold equals the floor, so this is
  //    identical to the global path.
  const mask = new Uint8Array(width * height);
  let inkPixels = 0;
  const thresholdsUsed = [];
  for (let y = scan.top; y < scan.top + scan.height; y++) {
    for (let x = scan.left; x < scan.left + scan.width; x++) {
      const idx = (y * width + x) * channels;
      const px = { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
      if (backgrounds) {
        // Multi-plateau: background is ANY nearby plateau. This is what keeps a
        // dark sidebar from being treated as one giant "ink" blob whose colour
        // is the panel fill.
        let isBg = false;
        for (const p of backgrounds) {
          if (rgbDistance(px, p) <= inkThreshold) { isBg = true; break; }
        }
        if (!isBg) {
          mask[y * width + x] = 1;
          inkPixels++;
        }
      } else if (field) {
        const f = field.at(x, y);
        const t = Math.max(inkThreshold, noiseFactor * f.s);
        if (thresholdsUsed.length < 4096) thresholdsUsed.push(t);
        if (rgbDistance(px, f.bg) > t) {
          mask[y * width + x] = 1;
          inkPixels++;
        }
      } else if (rgbDistance(px, bg) > inkThreshold) {
        mask[y * width + x] = 1;
        inkPixels++;
      }
    }
  }
  thresholdsUsed.sort((a, b) => a - b);
  const medianThreshold = thresholdsUsed.length
    ? thresholdsUsed[thresholdsUsed.length >> 1]
    : (field ? inkThreshold : null);
  const maxThreshold = thresholdsUsed.length ? thresholdsUsed[thresholdsUsed.length - 1] : null;

  // 2. Group spatial pixels, then pick each group's most extreme colour.
  const seen = new Uint8Array(width * height);
  const stack = [];
  const components = [];
  let truncated = false;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    const members = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const localCounts = new Map();

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width;
      const y = (idx / width) | 0;
      members.push(idx);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const p = idx * channels;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      localCounts.set(key, (localCounts.get(key) || 0) + 1);

      if (x > 0) { const n = idx - 1; if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (x < width - 1) { const n = idx + 1; if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y > 0) { const n = idx - width; if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y < height - 1) { const n = idx + width; if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
    }

    if (members.length < minArea) continue;
    if (components.length >= maxComponents) { truncated = true; break; }

    // Extremal colour with at least 2 identical pixels = the glyph core.
    // (A 1-pixel outlier cannot outvote the core, which prevents stray noise
    //  from becoming a spurious low-contrast "colour".)
    // Distance is measured against the SURROUNDING background (the ring the
    // glyph sits on), falling back to the component's own reference when the
    // ring is empty. This is what makes text on a non-modal panel resolved
    // correctly: the extremal pixel is the glyph core measured from ITS panel.
    const ring = backgrounds
      ? ringBackground({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
      : null;
    let modalKey = 0;
    let modalN = -1;
    for (const [key, count] of localCounts) {
      if (count > modalN) { modalN = count; modalKey = key; }
    }
    const compRef = ring || refFor({
      r: (modalKey >> 16) & 0xff,
      g: (modalKey >> 8) & 0xff,
      b: modalKey & 0xff,
    });
    let bestKey = null;
    let bestDist = -1;
    let fallbackKey = null;
    let fallbackCount = -1;
    for (const [key, count] of localCounts) {
      const rgb = { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff };
      const d = rgbDistance(rgb, compRef);
      if (count >= 2 && d > bestDist) { bestDist = d; bestKey = key; }
      if (count > fallbackCount) { fallbackCount = count; fallbackKey = key; }
    }
    const key = bestKey ?? fallbackKey;
    const rgb = { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff };

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const fill = members.length / (boxW * boxH);
    // For a local background, record the reference colour actually used here,
    // so a caller can see which background each component was compared against.
    const localBg = field ? field.at(Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2)).bg : null;

    components.push({
      hex: toHex(rgb),
      rgb,
      pixel_count: members.length,
      distance_from_background: bestDist,
      local_background: localBg ? toHex(localBg) : null,
      background_reference: toHex(compRef),
      box: { left: minX, top: minY, width: boxW, height: boxH },
      fill_ratio: roundRatio(fill * 100) / 100,
      // A large, near-solid region is a panel FILL, not a glyph. Reported so a
      // caller (and the enumeration) can tell that a "colour" is really a
      // background plateau rather than text.
      looks_like_plateau_fill: boxW >= 60 && boxH >= 60 && fill >= 0.5 && members.length >= 2000,
      // A thin closed outline (large box, tiny fill) is decorative chrome
      // (a border or rule), not a glyph. Text strokes are either small or
      // high-fill, so this test does not catch them.
      looks_like_hollow_rectangle: boxW >= 60 && boxH >= 60 && fill < 0.25,
      // A single straight run — long and thin in ONE axis — is a rule, a
      // divider or a card border, not a glyph. (A glyph box is not 60:1.
      // Measured on a tiled dashboard: card borders are 321x3 / 3x122 / 315x1,
      // which the hollow-rectangle test misses because the box is not 2-D.)
      looks_like_straight_segment:
        (boxW >= 60 && boxH <= PLATEAU_MIN_ELONGATION_WIDTH) ||
        (boxH >= 60 && boxW <= PLATEAU_MIN_ELONGATION_WIDTH),
      looks_like_structure: false, // set below once both flags are known
    });
    const justPushed = components[components.length - 1];
    justPushed.looks_like_structure =
      justPushed.looks_like_hollow_rectangle || justPushed.looks_like_straight_segment;
  }

  return {
    components,
    background: bg,
    backgrounds: backgrounds || null,
    ink_pixel_count: inkPixels,
    truncated,
    background_mode: backgroundMode,
    effective_ink_threshold: maxThreshold,
    median_ink_threshold: medianThreshold,
    noise_factor: field ? noiseFactor : null,
    tile_size: field ? tileSize : null,
  };
}

/**
 * Is colour `x` plausibly an anti-aliased blend between the background and the
 * stronger colour `y`?
 *
 * Anti-aliasing mixes background and glyph colour, so an AA shade must lie
 * (near-)exactly on the segment bg→y at a mid-point fraction. Requiring a
 * mid-point `t` is what protects genuinely dark text: a 1.04:1 string sits very
 * close to the background, so its blend fraction is ~0.07 — far below the 0.25
 * floor — and it is correctly NOT treated as an artefact.
 *
 * @param {{r:number,g:number,b:number}} x candidate (weaker) colour
 * @param {{r:number,g:number,b:number}} y the stronger colour it might belong to
 * @param {{r:number,g:number,b:number}} bg
 * @param {{ minT?: number, maxT?: number, maxResidual?: number }} [opts]
 */
export function isAntiAliasingBlend(x, y, bg, opts = {}) {
  const minT = opts.minT ?? 0.25;
  const maxT = opts.maxT ?? 0.98;
  const maxResidual = opts.maxResidual ?? 3;

  const d = { r: y.r - bg.r, g: y.g - bg.g, b: y.b - bg.b };
  const ts = [];
  if (d.r !== 0) ts.push((x.r - bg.r) / d.r);
  if (d.g !== 0) ts.push((x.g - bg.g) / d.g);
  if (d.b !== 0) ts.push((x.b - bg.b) / d.b);
  if (ts.length === 0) return false;

  const t = ts.reduce((s, v) => s + v, 0) / ts.length;
  const predicted = { r: bg.r + t * d.r, g: bg.g + t * d.g, b: bg.b + t * d.b };
  const residual = rgbDistance(x, predicted);

  return t > minT && t < maxT && residual < maxResidual;
}

/**
 * Does a cluster look like a self-contained text run rather than an AA halo?
 *
 * Anti-aliasing fragments are small and numerous; real glyphs are few and large.
 * This is the structural check that a colour-only test cannot make.
 *
 * @param {{ pixel_count: number, component_count: number }} c
 * @param {{ pixel_count: number, component_count: number }|null} [parent]
 */
export function looksLikeIndependentText(c, parent = null) {
  const comps = c.component_count || 0;
  if (comps < MIN_TEXT_COMPONENTS) return false;
  const meanArea = comps ? c.pixel_count / comps : 0;
  if (meanArea < MIN_TEXT_MEAN_AREA) return false;
  if (parent) {
    const parentMean = parent.component_count ? parent.pixel_count / parent.component_count : 0;
    if (parentMean > 0 && meanArea < parentMean * minMeanAreaRatio) return false;
  }
  return true;
}

// A cluster only counts as suspected noise when it is BOTH very weak AND
// structurally untext-like. The weak floor is set at 1.25:1 — just above the
// darkest real near-background text the acceptance fixture contains (1.04:1),
// which has 20 large components and is therefore never classified as noise.
const NOISE_CONTRAST_CEILING = 1.25;

/**
 * Is this cluster more likely residual background noise than text?
 *
 * Used only under `background_mode: "local"`, where per-tile backgrounds leave
 * weak residual clusters. A single small blob of noise must not be reported as
 * failing text (third-audit F2). Real text — few, large components — always
 * fails this test and is kept.
 *
 * @param {{ pixel_count:number, component_count:number, contrast_ratio_raw:number }} entry
 */
export function isSuspectedNoiseCluster(entry) {
  const meanArea = entry.component_count
    ? entry.pixel_count / entry.component_count
    : entry.pixel_count;
  const weak = entry.contrast_ratio_raw < NOISE_CONTRAST_CEILING;
  const noisy = !looksLikeIndependentText({
    pixel_count: entry.pixel_count,
    component_count: entry.component_count,
  });
  return { suspected: weak && noisy, weak, noisy, mean_area: roundRatio(meanArea) };
}

// A weak cluster whose blobs are individually huge is a background REGION (a
// page background separated by cards), not a text run. Measured (ACCURACY.md
// 5g): across every fixture the mean blob of real text is at most 0.10% of the
// region, while a tiled layout's page background is 37.7% — a 360x separation,
// so the AREA test is the discriminator and this threshold has enormous margin.
// The contrast ceiling only guards against dropping high-contrast content; it is
// deliberately the weakest signal, set a little above the noise ceiling so a
// faintly-textured page background (measured 1.27:1) is still caught.
const LARGE_REGION_AREA_FRACTION = 0.02;
const LARGE_REGION_CONTRAST_CEILING = 1.5;

/**
 * Is this weak cluster actually a large background region rather than text?
 *
 * Defence in depth for the sixth-audit F7 shape. The multi-plateau model
 * normally stops such a region becoming "ink" at all; this catches layouts the
 * plateau detector cannot model (e.g. a page background that is textured rather
 * than flat, so it fails the plateau flatness test).
 *
 * @param {{ pixel_count:number, component_count:number, contrast_ratio_raw:number }} entry
 * @param {number} regionArea width*height of the region
 */
export function isLargeBackgroundRegion(entry, regionArea) {
  if (!regionArea || regionArea <= 0) return false;
  const meanArea = entry.component_count
    ? entry.pixel_count / entry.component_count
    : entry.pixel_count;
  return (
    entry.contrast_ratio_raw < LARGE_REGION_CONTRAST_CEILING &&
    meanArea / regionArea > LARGE_REGION_AREA_FRACTION
  );
}

/**
 * Split evaluated colours into real text vs suspected background noise.
 *
 * Only applied under `background_mode: "local"` (per-tile backgrounds leave weak
 * residual clusters). Everything removed is returned in `suspected[]` so it can
 * still be disclosed — nothing is silently dropped.
 *
 * @param {Array<object>} evaluated
 * @param {"global"|"local"} backgroundMode
 * @returns {{ kept: Array<object>, suspected: Array<object> }}
 */
export function partitionSuspectedNoise(evaluated, backgroundMode) {
  if (backgroundMode !== "local") return { kept: [...evaluated], suspected: [] };
  const kept = [];
  const suspected = [];
  for (const e of evaluated) {
    const cls = isSuspectedNoiseCluster(e);
    if (cls.suspected) {
      suspected.push({
        foreground: e.foreground,
        pixel_count: e.pixel_count,
        component_count: e.component_count,
        mean_component_area: cls.mean_area,
        contrast_ratio: e.contrast_ratio,
        reason:
          "low-contrast cluster with untext-like component geometry; consistent with residual " +
          'background noise under background_mode:"local", not a text run',
      });
      continue;
    }
    kept.push(e);
  }
  return { kept, suspected };
}

/**
 * Should a FAILING colour that the plateau mask dropped be disclosed?
 *
 * The invariant (tenth-audit F12): **anything the mask removes must be eligible
 * for disclosure.** Suppressing the fact is what creates a silent gap.
 *
 * CORRECTION (eleventh-audit F13) — the previous claim was false. The tenth audit
 * asserted this predicate was a structural SUPERSET of the mask "because it reuses
 * the mask's own constant `PLATEAU_MIN_BLOB_SHARE`". Reusing the NAME is not the
 * same property as being a superset, and the two constants measure DIFFERENT
 * quantities:
 *
 *   - `PLATEAU_MIN_SHARE` (0.02) is a SINGLE blob's share of the region, used by
 *     the mask's path A;
 *   - `PLATEAU_MIN_BLOB_SHARE` (0.004) was the MEAN across blobs used here.
 *
 * Since `mean = total / N`, the mean can fall below the per-blob floor as N grows.
 * A colour masked by a single >= 2%-of-region blob that also has many smaller
 * companions therefore had `mean < 0.4%`, was masked, and was never disclosed: a
 * large drop-cap `I` beside 9 small glyphs of the SAME failing colour (F13(a)), or
 * an inset panel beside ten small fragments (F13(b)). The old predicate's `false`
 * was a silent gap, and the doc-comment's guarantee was wrong.
 *
 * The predicate is now the UNION of one clause per masking path:
 *
 *   1. `largestShare >= PLATEAU_MIN_SHARE` — TRUE BY CONSTRUCTION for a colour the
 *      mask reached via path A: path A accepts only when the largest blob holds
 *      >= 2% of the region, so any path-A-masked colour clears this clause and is
 *      always disclosed. This is the mask's OWN acceptance test applied per colour,
 *      not a lookalike statistic — so the F13 seam is closed structurally.
 *
 *   2. `mean >= PLATEAU_MIN_BLOB_SHARE` — keeps the path-B (tiled solid blobs)
 *      case disclosed. A tiling accepts only blobs that clear the per-blob floor,
 *      so a colour whose blobs are ALL solid has `mean >= 0.4%` and is disclosed
 *      (the tenth-audit F12 band).
 *
 * THE RESIDUAL GAP — measured, documented, NOT a guarantee. A colour the mask
 * reached via path B that mixes >= 2 solid blobs with smaller sub-floor blobs can
 * have BOTH `mean < 0.4%` AND `largestShare < 2%`, and is then masked and
 * undisclosed. That signature is a varying-size tiled block — a bar chart / icon
 * grid (the ninth-audit F11 decoration, which must stay quiet), but it is
 * IRREDUCIBLY ambiguous: a headline of two huge glyphs plus many small ones, all
 * failing, has the same shape. We keep F11 quiet and name the seam here and in
 * ACCURACY.md 5m rather than cry wolf on every dashboard. Earlier rejected gates
 * are recorded in ACCURACY.md 5l (a component-count ceiling, blob aspect, size CV,
 * and plain mean — all failed on measurement).
 *
 * @param {{pixel_count:number, component_count:number}} colour an un-masked failing colour
 * @param {number} regionArea width*height
 * @param {number} [largestShare] the colour's largest blob as a share of the region
 */
export function isDisclosableDroppedColour(colour, regionArea, largestShare = 0) {
  if (!regionArea || regionArea <= 0) return false;
  const mean = colour.component_count
    ? colour.pixel_count / colour.component_count
    : colour.pixel_count;
  return largestShare >= PLATEAU_MIN_SHARE || mean / regionArea >= PLATEAU_MIN_BLOB_SHARE;
}

/**
 * Is the dropped colour panel-shaped (a large region) rather than text-sized?
 *
 * Used only to choose the disclosure WORDING, never to suppress it: a panel-shaped
 * region is the genuinely ambiguous case ("a panel, or very large text?"), while a
 * text-sized one is more likely a large glyph. Retained at its original threshold
 * because the wording it drives was verified in the ninth audit.
 *
 * @param {{pixel_count:number, component_count:number}} colour an un-masked failing colour
 * @param {number} regionArea width*height
 */
export function isPanelShapedDroppedColour(colour, regionArea) {
  if (!regionArea || regionArea <= 0) return false;
  const mean = colour.component_count
    ? colour.pixel_count / colour.component_count
    : colour.pixel_count;
  return mean / regionArea >= LARGE_REGION_AREA_FRACTION;
}

/**
 * Fold anti-aliasing artefacts into the colour they are a blend of.
 *
 * Without this, the set of reported colours depends on the *renderer*: PIL and
 * librsvg anti-alias differently, and librsvg's handling of small text can leave
 * fragments whose most-extreme pixel never reaches the full text colour (e.g.
 * #787065 at 3.63:1 appearing beside a real #a09588 at 6.03:1). Those fragments
 * are artefacts, not text colours, and reporting them would both inflate the
 * failing count and make results renderer-dependent.
 *
 * @param {Array<object>} clusters sorted desc by distance from background
 * @param {{r:number,g:number,b:number}} bg
 * @returns {Array<object>} filtered clusters with merged pixel counts
 */
export function mergeAntiAliasing(clusters, bg) {
  const enriched = clusters.map((c) => ({
    ...c,
    distance: rgbDistance(c.rgb, bg),
  }));
  // Strongest (furthest from background) first = preferred parents.
  enriched.sort((a, b) => b.distance - a.distance);

  const kept = [];
  const mergedInto = [];

  for (const c of enriched) {
    // Guard 1: a cluster that is itself a closed outline (hollow rectangle) is
    // structural chrome, not an anti-aliasing artefact of something else.
    const cIsHollow =
      c.boxes.length > 0 && c.hollow === c.boxes.length && c.boxes.length > 0;

    // Guard 2: an anti-aliasing artefact is a minority of a glyph's edge; it
    // cannot carry MORE ink than the colour it is a blend of. (Observed
    // failure without this: a 4768px border folding into a 639px text colour.)
    const parent = !cIsHollow
      ? kept.find(
          (k) =>
            !k.is_hollow &&
            c.pixel_count < k.pixel_count &&
            !looksLikeIndependentText(c, k) &&
            isAntiAliasingBlend(c.rgb, k.rgb, bg),
        )
      : null;

    if (parent) {
      parent.pixel_count += c.pixel_count;
      parent.component_count += c.component_count;
      parent.hollow += c.hollow;
      parent.boxes.push(...c.boxes);
      parent.merged_members = parent.merged_members || [];
      parent.merged_members.push({ hex: c.hex, pixel_count: c.pixel_count });
      mergedInto.push({
        hex: c.hex,
        into: parent.hex,
        pixel_count: c.pixel_count,
        component_count: c.component_count,
        mean_component_area: c.component_count
          ? roundRatio(c.pixel_count / c.component_count)
          : null,
      });
    } else {
      kept.push({ ...c, is_hollow: cIsHollow });
    }
  }

  return { clusters: kept, merged_anti_aliasing: mergedInto };
}

/**
 * Robust per-tile background field and local noise scale.
 *
 * Motivation (measured, see ACCURACY.md §5c): a single global background colour
 * is an adequate model for flat UI screenshots but a poor one for photographic
 * or gradient backgrounds, where only a small part of the image matches the
 * modal colour.
 *
 * Each tile's background is its per-channel MEDIAN (robust: text is a minority
 * of tile pixels), and its noise scale is the MAD of pixel distances to that
 * median scaled to sigma (1.4826 x MAD). Tiles are bilinearly interpolated.
 *
 * On a flat image the MAD is 0, so the derived threshold collapses to the floor
 * and behaviour is identical to the global model — which is why this does not
 * regress the flat fixture.
 *
 * @param {object} pixels
 * @param {number} [tile]
 */
export function tileBackgroundField(pixels, tile = 48) {
  const { width: W, height: H, channels: C, data } = pixels;
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);
  const med = Array.from({ length: rows }, () => Array(cols).fill(null));
  const scale = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const yEnd = Math.min(H, (ty + 1) * tile);
      const xEnd = Math.min(W, (tx + 1) * tile);
      const n = (yEnd - ty * tile) * (xEnd - tx * tile);
      if (n <= 0) { med[ty][tx] = { r: 0, g: 0, b: 0 }; continue; }

      const R = new Uint8Array(n);
      const G = new Uint8Array(n);
      const B = new Uint8Array(n);
      let p = 0;
      for (let y = ty * tile; y < yEnd; y++) {
        for (let x = tx * tile; x < xEnd; x++) {
          const i = (y * W + x) * C;
          R[p] = data[i]; G[p] = data[i + 1]; B[p] = data[i + 2];
          p++;
        }
      }
      const mid = (a) => { a.sort(); return a[a.length >> 1]; };
      const br = mid(R.slice());
      const bg = mid(G.slice());
      const bb = mid(B.slice());

      const ds = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        ds[k] = Math.sqrt((R[k] - br) ** 2 + (G[k] - bg) ** 2 + (B[k] - bb) ** 2);
      }
      const sorted = Array.from(ds).sort((a, b) => a - b);
      const m = sorted[sorted.length >> 1];
      const dev = sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b);

      med[ty][tx] = { r: br, g: bg, b: bb };
      scale[ty][tx] = MAD_TO_SIGMA * dev[dev.length >> 1];
    }
  }

  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const S = (yy, xx) => ({
    bg: med[cl(yy, 0, rows - 1)][cl(xx, 0, cols - 1)],
    s: scale[cl(yy, 0, rows - 1)][cl(xx, 0, cols - 1)],
  });

  return {
    tile,
    rows,
    cols,
    /** Background + noise scale at a pixel, bilinearly interpolated. */
    at(x, y) {
      const fx = x / tile - 0.5;
      const fy = y / tile - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = cl(fx - x0, 0, 1);
      const ay = cl(fy - y0, 0, 1);
      const c00 = S(y0, x0), c10 = S(y0, x0 + 1), c01 = S(y0 + 1, x0), c11 = S(y0 + 1, x0 + 1);
      const L = (a, b, t) => a + (b - a) * t;
      return {
        bg: {
          r: L(L(c00.bg.r, c10.bg.r, ax), L(c01.bg.r, c11.bg.r, ax), ay),
          g: L(L(c00.bg.g, c10.bg.g, ax), L(c01.bg.g, c11.bg.g, ax), ay),
          b: L(L(c00.bg.b, c10.bg.b, ax), L(c01.bg.b, c11.bg.b, ax), ay),
        },
        // Conservative: use the noisiest contributing tile.
        s: Math.max(c00.s, c10.s, c01.s, c11.s),
        max_tile_scale: Math.max(c00.s, c10.s, c01.s, c11.s),
      };
    },
  };
}

/**
 * How well does a single global background colour explain the image?
 *
 * Used to warn honestly when the global model is inadequate (photographic or
 * gradient backgrounds), because in that case contrast enumeration over a
 * global background may miss text or invent colours. Reported, not acted upon
 * silently.
 *
 * @param {object} pixels
 * @param {object} [region]
 * @param {number} [tolerance]
 */
export function assessBackgroundFit(pixels, region, tolerance = 8) {
  const r = clampRegion(pixels, region);
  const entries = histogramToEntries(colorHistogram(pixels, r));
  const bg = entries[0].rgb;
  const total = entries.reduce((s, e) => s + e.count, 0);
  const within = entries
    .filter((e) => rgbDistance(e.rgb, bg) <= tolerance)
    .reduce((s, e) => s + e.count, 0);
  const frac = total ? within / total : 0;

  const warnings = [];
  if (frac < 0.5) {
    warnings.push(
      `A single global background colour accounts for only ${(frac * 100).toFixed(1)}% of this region ` +
        `(within ${tolerance} RGB units of ${toHex(bg)}). This image is likely photographic, gradient or ` +
        `multi-tone, where a global background is a poor model: contrast enumeration may miss text or report ` +
        `image regions as "colours". Pass background_mode: "local" to use a per-tile adaptive background.`,
    );
  }
  return {
    background: toHex(bg),
    explained_fraction: Math.round(frac * 1000) / 1000,
    tolerance,
    adequate: frac >= 0.5,
    warnings,
  };
}

/**
 * Largest ENCLOSED aperture inside a blob's bounding box, in pixels.
 *
 * A region of non-`fillRgb` pixels is "enclosed" when it cannot reach the bbox
 * border without crossing the blob colour. A glyph ring encloses one large such
 * region; a content-dense panel is perforated by many small ones; a plain panel
 * has none. This is the measurement that separates an inset glyph RING (reject as
 * background) from an inset perforated PANEL (accept), which a single fill
 * threshold cannot express (eighth-audit F10).
 *
 * @param {object} pixels
 * @param {number} minX @param {number} minY bbox origin
 * @param {number} boxW @param {number} boxH bbox size
 * @param {{r:number,g:number,b:number}} fillRgb the blob's own colour
 * @returns {number} largest enclosed hole area in pixels
 */
function largestEnclosedHole(pixels, minX, minY, boxW, boxH, fillRgb) {
  const { data, width, channels } = pixels;
  const isFill = (x, y) => {
    const i = (y * width + x) * channels;
    return data[i] === fillRgb.r && data[i + 1] === fillRgb.g && data[i + 2] === fillRgb.b;
  };
  const size = (boxW + 2) * (boxH + 2);
  const seen = new Uint8Array(size);
  const at = (x, y) => (y - minY + 1) * (boxW + 2) + (x - minX + 1);
  let largest = 0;
  const stack = [];
  for (let y = minY; y < minY + boxH; y++) {
    for (let x = minX; x < minX + boxW; x++) {
      if (isFill(x, y) || seen[at(x, y)]) continue;
      stack.length = 0;
      stack.push([x, y]);
      seen[at(x, y)] = 1;
      let n = 0;
      let touches = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        n++;
        if (cx === minX || cy === minY || cx === minX + boxW - 1 || cy === minY + boxH - 1) touches = true;
        const neigh = [
          cx > minX ? [cx - 1, cy] : null,
          cx < minX + boxW - 1 ? [cx + 1, cy] : null,
          cy > minY ? [cx, cy - 1] : null,
          cy < minY + boxH - 1 ? [cx, cy + 1] : null,
        ];
        for (const nb of neigh) {
          if (!nb) continue;
          const [nx, ny] = nb;
          if (isFill(nx, ny) || seen[at(nx, ny)]) continue;
          seen[at(nx, ny)] = 1;
          stack.push([nx, ny]);
        }
      }
      if (!touches && n > largest) largest = n;
    }
  }
  return largest;
}

/**
 * Detect large flat colour plateaus in a region (panels, cards, page fill).
 *
 * Motivation (third-audit F5): a single modal background cannot model a UI with
 * two or more large flat panels. The old ink mask treated the whole non-modal
 * panel as ink, producing one giant component whose "colour" was the panel FILL
 * (`fill_ratio: 1.0`, spanning the panel's box). Text sitting on that panel was
 * absorbed into it and vanished from every channel, so a sidebar string at
 * 1.64:1 could be reported as `all_meet_aa: true`.
 *
 * Method: quantise each channel, histogram the quantised keys, and keep buckets
 * holding at least `minShare` of the region. Each plateau's representative is the
 * MODAL EXACT colour inside its bucket (the true fill, not the quantised centre,
 * so contrast is computed against the real colour). Near-identical plateaus are
 * merged.
 *
 * A gradient or photograph has no bucket holding a meaningful share, so this
 * returns an empty list and the caller falls back to the existing single/
 * per-tile background model unchanged.
 *
 * @param {object} pixels
 * @param {{left:number,top:number,width:number,height:number}} region
 * @param {{quant?:number, minShare?:number, mergeDist?:number}} [opts]
 * @returns {Array<{rgb:object, hex:string, count:number, share:number}>} largest first
 */
export function detectPlateaus(pixels, region, opts = {}) {
  const r = clampRegion(pixels, region);
  const quant = opts.quant ?? PLATEAU_QUANT;
  const minShare = opts.minShare ?? PLATEAU_MIN_SHARE;
  const mergeDist = opts.mergeDist ?? PLATEAU_MERGE_DIST;
  const flatShare = opts.flatShare ?? PLATEAU_FLAT_SHARE;
  const { data, width, height, channels } = pixels;

  // 1. Quantise every pixel into a colour bucket, and label each pixel with its
  //    bucket id so a connected-component pass can run over the labels.
  const idOf = new Map();
  const label = new Int32Array(width * height).fill(-1);
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) {
      const i = (y * width + x) * channels;
      const qk =
        ((data[i] / quant) | 0) << 16 |
        ((data[i + 1] / quant) | 0) << 8 |
        ((data[i + 2] / quant) | 0);
      let id = idOf.get(qk);
      if (id === undefined) { id = idOf.size; idOf.set(qk, id); }
      label[y * width + x] = id;
    }
  }

  // 2. One flood fill over the labels. Per bucket, record EVERY component's
  //    area and box (not just the largest) plus the largest one's own exact
  //    histogram, so the two acceptance paths below can both be evaluated.
  const seen = new Uint8Array(width * height);
  const stack = [];
  const stats = new Map(); // id -> { comps: [{area, boxW, boxH, fill}], best }
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) {
      const start = y * width + x;
      const id = label[start];
      if (id < 0 || seen[start]) continue;
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      let area = 0;
      let minX = width, minY = height, maxX = -1, maxY = -1;
      const counts = new Map();
      while (stack.length) {
        const idx = stack.pop();
        area++;
        const cx = idx % width;
        const cy = (idx / width) | 0;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;
        const i = idx * channels;
        const ek = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(ek, (counts.get(ek) || 0) + 1);
        const neigh = [
          cx > r.left ? idx - 1 : -1,
          cx < r.left + r.width - 1 ? idx + 1 : -1,
          cy > r.top ? idx - width : -1,
          cy < r.top + r.height - 1 ? idx + width : -1,
        ];
        for (const n of neigh) {
          if (n < 0 || seen[n] || label[n] !== id) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const e = stats.get(id) || { comps: [], best: null };
      const touchesBorder =
        minX <= r.left || minY <= r.top || maxX >= r.left + r.width - 1 || maxY >= r.top + r.height - 1;
      e.comps.push({ area, boxW, boxH, fill: area / (boxW * boxH), touchesBorder });
      if (!e.best || area > e.best.area) {
        let modalKey = 0;
        let modalN = -1;
        for (const [k, n] of counts) if (n > modalN) { modalN = n; modalKey = k; }
        const modalRgb = { r: (modalKey >> 16) & 0xff, g: (modalKey >> 8) & 0xff, b: modalKey & 0xff };
        // Largest ENCLOSED aperture within the blob's bbox, as a fraction of the
        // bbox (eighth-audit F10). A glyph RING has ONE big hole; a content-dense
        // panel is perforated by MANY SMALL holes; a plain panel has none.
        // Measured: ring 0.253-0.257, every panel (perforated card 0.008, solid
        // card, page, dense background <= 0.033). This separates "is a ring" from
        // "is perforated", which a single fill threshold cannot: fill conflates
        // the two and so rejected legitimate dense-content panels.
        const largestHole = largestEnclosedHole(pixels, minX, minY, boxW, boxH, modalRgb);
        e.best = {
          area,
          modalCount: modalN,
          modalRgb,
          fill: area / (boxW * boxH),
          touchesBorder,
          largestHoleFrac: largestHole / (boxW * boxH),
        };
      }
      stats.set(id, e);
    }
  }

  // 3. A colour is a plateau (a background panel) under EITHER of two paths.
  //
  //    (A) DOMINANT-BLOB: one big connected region that is flat and holds most
  //        of the colour's pixels. Correct for a single full-width panel or the
  //        page background.
  //    (B) TILED: several large, near-solid, similar-sized blobs. Correct for a
  //        repeated card/mosaic layout, where the fill is "many small identical
  //        blobs" — the same signature as a glyph run, which is why blob count
  //        alone classifies a dashboard as text (sixth-audit F7).
  //
  //    Both share a FLATNESS requirement, so a gradient band (one big region,
  //    broad colour spread) is rejected by neither path.
  //
  //    Text is rejected by (B) because its blobs are either tiny (a glyph stroke
  //    is ~0.01% of the region) or hollow/thin (fill < 0.85), and by (A) because
  //    its many blobs share the colour. Both thresholds were measured against
  //    text, cards, borders and panels before being chosen.
  const total = r.width * r.height;
  const plateaus = [];
  for (const [id, e] of stats) {
    if (total === 0) continue;
    const b = e.best;
    if (!b) continue;

    const bucketPixels = e.comps.reduce((s, c) => s + c.area, 0);
    const bucketShare = bucketPixels / total;
    if (bucketShare < minShare) continue;

    const flatness = b.modalCount / b.area;
    if (flatness < flatShare) continue;

    // (A) dominant single blob. Three shape requirements, all measured:
    //     - one blob holds most of the colour's pixels (repeated glyphs give
    //       ~0.5; every real panel gives >= 0.78);
    //     - an INSET blob must not be a RING. The OUTERMOST colour may have a low
    //       fill and many holes (it is the background with panels/glyphs cut out
    //       of it), so it qualifies by touching the border. An inset blob with one
    //       large enclosed aperture is a glyph ring; an inset blob perforated by
    //       small holes is a content-dense panel. (seventh/eighth audits F8/F10)
    const regionShare = b.area / total;
    const dominance = bucketPixels ? b.area / bucketPixels : 0;
    const isRing = !b.touchesBorder && b.largestHoleFrac >= RING_HOLE_FRACTION;
    const panelShape = b.touchesBorder || !isRing;
    const pathA = regionShare >= minShare && dominance >= PLATEAU_DOMINANCE && panelShape;

    // (B) tiled solid blobs. A tiling is solid by definition; the outermost
    //     (background) colour is handled by path (A), which is why a hollow page
    //     background still qualifies there while a hollow glyph never does here.
    const solid = e.comps.filter(
      (c) => c.area / total >= PLATEAU_MIN_BLOB_SHARE && c.fill >= PLATEAU_SOLID_FILL,
    );
    const solidShare = solid.reduce((s, c) => s + c.area, 0) / total;
    let pathB = false;
    let sizeCv = null;
    if (solid.length >= 2 && solidShare >= minShare) {
      const areas = solid.map((c) => c.area);
      const mean = areas.reduce((s, a) => s + a, 0) / areas.length;
      const variance = areas.reduce((s, a) => s + (a - mean) ** 2, 0) / areas.length;
      sizeCv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      // A tiled layout repeats SIMILAR blobs; a stray mixture is not a tiling.
      pathB = sizeCv <= PLATEAU_SIZE_CV;
    }

    if (!pathA && !pathB) continue;

    plateaus.push({
      rgb: b.modalRgb,
      hex: toHex(b.modalRgb),
      share: Math.round((pathA ? regionShare : solidShare) * 10000) / 10000,
      detection: pathA ? "dominant-blob" : "tiled",
      largest_component_px: b.area,
      largest_component_share: Math.round(regionShare * 10000) / 10000,
      solid_component_count: solid.length,
      flatness: Math.round(flatness * 10000) / 10000,
      dominance: Math.round(dominance * 10000) / 10000,
      ...(sizeCv !== null ? { size_cv: Math.round(sizeCv * 10000) / 10000 } : {}),
    });
  }
  plateaus.sort((a, b) => b.largest_component_px - a.largest_component_px);

  // Merge near-identical plateaus (adjacent quantisation buckets of one panel).
  const merged = [];
  for (const p of plateaus) {
    if (merged.some((m) => rgbDistance(m.rgb, p.rgb) <= mergeDist)) continue;
    merged.push(p);
  }
  // Re-express `share` as the total pixel share of the plateau colour, so a
  // caller sees how much of the region the panel really covers.
  for (const m of merged) {
    let cnt = 0;
    for (let y = r.top; y < r.top + r.height; y++) {
      for (let x = r.left; x < r.left + r.width; x++) {
        const i = (y * width + x) * channels;
        if (rgbDistance({ r: data[i], g: data[i + 1], b: data[i + 2] }, m.rgb) <= mergeDist) cnt++;
      }
    }
    m.count = cnt;
    m.share = total ? Math.round((cnt / total) * 10000) / 10000 : 0;
  }
  return merged;
}

/**
 * The plateau a colour should be measured against: the nearest one by RGB
 * distance. Returns null when there are no plateaus.
 *
 * @param {{r:number,g:number,b:number}} rgb
 * @param {Array<{rgb:object, hex:string}>} plateaus
 */
export function nearestPlateau(rgb, plateaus) {
  if (!plateaus || plateaus.length === 0) return null;
  let best = null;
  let bestD = Infinity;
  for (const p of plateaus) {
    const d = rgbDistance(rgb, p.rgb);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { ...best, distance: bestD };
}

/**
 * Enumerate contrast for EVERY text-like colour in a region, and report the
 * worst case.
 *
 * This replaces the previous "pick the most legible colour and report it"
 * behaviour, which produced a false negative: an image containing large text
 * at 2.14:1 and 1.04:1 was summarised as `wcag_aa: true`, i.e. "no problems",
 * because the 13.42:1 heading won the max-luminance-delta contest.
 *
 * Design rules:
 *  - Never filter by legibility. The worst-contrast colour is the point.
 *  - Exclude only *structural* non-text (thin hollow rectangles) and say so.
 *  - Report how many candidates were skipped, so a caller is never told
 *    "fine" about a scope the check did not cover.
 *
 * @param {object} pixels
 * @param {object} region
 * @param {object} [opts]
 */
export function enumerateRegionContrast(pixels, region, opts = {}) {
  const r = clampRegion(pixels, region);
  const explicitBg = opts.background ? parseColor(opts.background) : null;
  const clusterTolerance = opts.clusterTolerance ?? opts.tolerance ?? 16;
  const inkThreshold = opts.inkThreshold ?? 4;
  const minColourPixels = opts.minColourPixels ?? 8;
  const includeDecorative = !!opts.includeDecorative;
  const backgroundMode = opts.backgroundMode === "local" ? "local" : "global";
  const tileSize = opts.tileSize ?? 48;
  const noiseFactor = opts.noiseFactor ?? 4;
  const explicitDecorative = new Set(
    (opts.decorativeColors || []).map((c) => String(c).toLowerCase()),
  );
  const large = !!opts.large;

  const regionPixels = pixels;
  // Background: explicit if given, else the modal colour OF THE REGION (a tight
  // region's background can differ from the whole image's).
  const regionBg = explicitBg
    || dominantColors(pixels, r, { top: 1 })[0].rgb;

  // Multi-plateau model (third-audit F5). A UI commonly has two or more large
  // flat panels. With >= 2 plateaus, every plateau is background and each colour
  // is measured against the NEAREST one, so text on a non-modal panel is neither
  // absorbed into a panel-sized "ink" blob nor measured against the wrong panel.
  // With <= 1 plateau (flat fixture, or a gradient/photo with no flat regions)
  // this reduces exactly to the previous single/per-tile model.
  const plateaus = opts._noPlateaus ? [] : detectPlateaus(pixels, r);
  const multiPlateau = plateaus.length >= 2;
  const plateauRefs = multiPlateau ? plateaus.map((p) => p.rgb) : null;

  const inkResult = extractInkComponents(regionPixels, {
    background: regionBg,
    backgrounds: plateauRefs,
    region: r,
    inkThreshold,
    minArea: opts.minComponentArea ?? 6,
    maxComponents: opts.maxComponents ?? 4000,
    backgroundMode,
    tileSize,
    noiseFactor,
  });
  const { components, background, ink_pixel_count, truncated } = inkResult;

  // Components are already restricted to the region by the scan bounds.
  const inRegion = components;

  const bgLum = relativeLuminance(background);

  // Group components by canonical colour: start with exact-hex grouping, then
  // merge representatives that are perceptually the same colour (absorbs
  // leftover anti-aliasing fragments).
  const byHex = new Map();
  for (const c of inRegion) {
    const g = byHex.get(c.hex) || {
      hex: c.hex, rgb: c.rgb, pixel_count: 0, component_count: 0,
      boxes: [], hollow: 0, distances: [], plateau_fill: 0,
      background_reference: c.background_reference || null,
    };
    g.pixel_count += c.pixel_count;
    g.component_count++;
    g.boxes.push(c.box);
    if (c.looks_like_structure) g.hollow++;
    if (c.looks_like_plateau_fill) g.plateau_fill++;
    g.distances.push(c.distance_from_background);
    // Keep the most extreme member as the representative.
    if (c.distance_from_background > (g.best_distance ?? -1)) {
      g.best_distance = c.distance_from_background;
      g.hex = c.hex;
      g.rgb = c.rgb;
      g.background_reference = c.background_reference || g.background_reference;
    }
    byHex.set(c.hex, g);
  }

  const rawGroups = [...byHex.values()].sort((a, b) => b.pixel_count - a.pixel_count);

  // Merge near-identical colours into clusters.
  const clusters = [];
  for (const g of rawGroups) {
    let target = null;
    for (const cl of clusters) {
      if (rgbDistance(cl.rgb, g.rgb) <= clusterTolerance) { target = cl; break; }
    }
    if (!target) {
      clusters.push({ ...g, members: [g] });
    } else {
      target.pixel_count += g.pixel_count;
      target.component_count += g.component_count;
      target.hollow += g.hollow;
      target.plateau_fill += g.plateau_fill;
      target.boxes.push(...g.boxes);
      target.members.push(g);
      if ((g.best_distance ?? -1) > (target.best_distance ?? -1)) {
        target.best_distance = g.best_distance;
        target.hex = g.hex;
        target.rgb = g.rgb;
        target.background_reference = g.background_reference || target.background_reference;
      }
    }
  }

  // Split into text-like vs decorative, and separate "too small to judge".
  let evaluated = [];
  const excluded = [];
  const skipped = [];
  let unassessedNonBackground = 0;

  // Panel FILLS are background, not text. A large near-solid region whose colour
  // is one of the detected plateaus is a panel, and its pixels are not a colour
  // anyone reads. Removing these before the anti-aliasing fold also prevents
  // genuine text on a *different* panel from being folded into a panel fill.
  // (third-audit F5: this is what let a 1.64:1 sidebar string vanish entirely.)
  const plateauFillClusters = multiPlateau
    ? clusters.filter(
        (cl) =>
          cl.plateau_fill > 0 &&
          plateaus.some((p) => rgbDistance(p.rgb, cl.rgb) <= PLATEAU_MERGE_DIST),
      )
    : [];
  const fillSet = new Set(plateauFillClusters);
  const textClusters = clusters.filter((cl) => !fillSet.has(cl));

  const plateauFills = plateauFillClusters.map((cl) => ({
    foreground: cl.hex,
    pixel_count: cl.pixel_count,
    component_count: cl.component_count,
    reason: "panel fill: a large near-solid region matching a detected background plateau, not text",
  }));

  // Fold anti-aliasing artefacts into the colours they are blends of, so the
  // reported set does not depend on which renderer produced the image.
  const { clusters: finalClusters, merged_anti_aliasing: mergedAA } =
    mergeAntiAliasing(textClusters, background);

  for (const cl of finalClusters) {
    // The reference is the SURROUNDING fill the colour was measured from (set
    // per component from its local ring), so text on a non-modal panel is
    // compared against its own panel — not the modal one, and not a panel it
    // merely happens to be the nearest colour to. Falls back to the single
    // region background when there is no plateau model.
    const measuredAgainst = cl.background_reference
      ? parseColor(cl.background_reference)
      : background;
    const refPlateau = multiPlateau
      ? plateaus.find((p) => rgbDistance(p.rgb, measuredAgainst) <= PLATEAU_MERGE_DIST) || null
      : null;
    const ratio = contrastRatio(cl.rgb, measuredAgainst);
    const compliance = wcagCompliance(ratio, { large });
    const entry = {
      foreground: cl.hex,
      rgb: cl.rgb,
      pixel_count: cl.pixel_count,
      component_count: cl.component_count,
      contrast_ratio: roundRatio(ratio),
      contrast_ratio_raw: ratio,
      wcag_aa: compliance.wcag_aa,
      wcag_aaa: compliance.wcag_aaa,
      required_aa: compliance.required_aa,
      required_aaa: compliance.required_aaa,
      meets_aa: compliance.wcag_aa,
      luminance_delta:
        roundRatio(Math.abs(relativeLuminance(cl.rgb) - relativeLuminance(measuredAgainst)) * 1000) / 1000,
      measured_against: toHex(measuredAgainst),
      measured_against_plateau: refPlateau ? refPlateau.hex : null,
      local_background: cl.background_reference || null,
      geometry: {
        boxes_count: cl.boxes.length,
        hollow_boxes: cl.hollow,
        all_hollow: cl.boxes.length > 0 && cl.hollow === cl.boxes.length,
      },
    };

    const isDecorative =
      explicitDecorative.has(cl.hex) ||
      (cl.boxes.length > 0 && cl.hollow === cl.boxes.length);

    if (isDecorative && !includeDecorative) {
      excluded.push({ ...entry, reason: "decorative: thin hollow rectangle geometry (border/rule), not text" });
      continue;
    }
    if (cl.pixel_count < minColourPixels) {
      unassessedNonBackground += cl.pixel_count;
      skipped.push({ ...entry, reason: `below minColourPixels=${minColourPixels}` });
      continue;
    }
    evaluated.push(entry);
  }

  evaluated.sort((a, b) => a.contrast_ratio_raw - b.contrast_ratio_raw);

  const notes = [];
  const abstained = [];

  // Noise separation (relevant to local mode on non-flat backgrounds).
  // With per-tile backgrounds, residual noise above the tile threshold can form
  // a single, small, weak cluster that is NOT a text run. Reporting it as
  // failing text asserts something no user could see on screen, so clusters that
  // are weak AND structurally untext-like are moved to `suspected_noise` and are
  // NOT allowed to set worst/failing_count. They are still listed (never
  // silently dropped) and named in `notes`. A real text run (few, large
  // components) is untouched by this test.
  const suspectedNoise = [];
  if (backgroundMode === "local") {
    const partition = partitionSuspectedNoise(evaluated, backgroundMode);
    evaluated = partition.kept;
    suspectedNoise.push(...partition.suspected);
  }

  // Large-background-region backstop (sixth-audit F7). A weak cluster whose
  // blobs are individually huge is a background REGION the plateau model did not
  // recognise, not a text run. This runs on BOTH modes and is the guarantee
  // behind the second invariant: no response may report `all_meet_aa: false`
  // naming a colour that is a background region rather than text. Real faint
  // text is ~1000x smaller per blob, so this cannot catch it.
  const regionArea = r.width * r.height;
  const backgroundRegions = [];
  evaluated = evaluated.filter((e) => {
    if (!isLargeBackgroundRegion(e, regionArea)) return true;
    const meanArea = e.component_count ? e.pixel_count / e.component_count : e.pixel_count;
    backgroundRegions.push({
      foreground: e.foreground,
      pixel_count: e.pixel_count,
      component_count: e.component_count,
      mean_component_area: roundRatio(meanArea),
      area_fraction: Math.round((meanArea / regionArea) * 10000) / 10000,
      contrast_ratio: e.contrast_ratio,
      reason:
        "background region, not text: a near-background cluster whose blobs are individually large " +
        "(a page background separated by cards/panels was not recognised as a plateau)",
    });
    return false;
  });
  if (backgroundRegions.length > 0) {
    notes.push(
      `${backgroundRegions.length} low-contrast cluster(s) were classified as BACKGROUND REGIONS, not text ` +
        `(near-background colour with large per-blob area, i.e. a region separated by panels rather than a text run): ` +
        backgroundRegions.map((n) => `${n.foreground} (${n.contrast_ratio}:1, ${n.component_count} blob(s))`).join(", ") +
        `. They are listed under \`background_regions\` and excluded from worst/failing_count/all_meet_aa.`,
    );
  }

  // MASK RECONCILIATION — the guarantee behind the third invariant.
  //
  // Any colour that the plateau/panel masking dropped could, in principle, have
  // been text (a huge glyph ring, a solid-block glyph) rather than a panel fill.
  // The shape tests above decide that case by case; this is the safety net that
  // makes the decision non-silent: re-enumerate with NO plateau mask and, if the
  // un-masked run finds a failing colour that is absent from the masked result,
  // disclose it. It can only ADD disclosure, never change the verdict, so it
  // cannot regress a correct result (eighth-audit F10, fix 3).
  //
  // PRECISION + COVERAGE (ninth and tenth audits).
  //
  // Ninth (F11): firing on every dropped failing colour made this cry wolf —
  // decorative chart bars are themselves a tiled "panel" colour, so the un-masked
  // pass re-reads them as text and the caller was told a CORRECT verdict was
  // unverified.
  //
  // Tenth (F12): the fix for that used a blob-size threshold (>= 2% of the region)
  // that was STRICTER than the mask's own floor (a tiled plateau masks blobs
  // >= 0.4%). A colour whose blobs fell between the two was masked and never
  // disclosed, so whether a caller learned about it depended only on crop size.
  //
  // The rule is now (eleventh audit — see isDisclosableDroppedColour): a colour is
  // disclosed if it is failing un-masked AND either (a) its largest blob holds
  // >= 2% of the region (the mask's path-A acceptance test, applied per colour, so
  // it is true by construction for a dominant-blob mask), or (b) its mean blob
  // clears the per-blob tiling floor (the path-B acceptance test). Shape only
  // chooses the wording. Masking is detected by re-running WITHOUT the plateau mask
  // and looking for colours that vanish; a colour that is itself a detected plateau
  // is disclosed and flagged `detected_plateau`.
  //
  // Runs only when masking actually occurred, so the common path is unaffected.
  let maskReconciliation = null;
  if (plateauFills.length > 0 || multiPlateau) {
    const unmasked = enumerateRegionContrast(pixels, r, {
      ...opts,
      background: undefined,
      backgroundMode: "global",
      _noPlateaus: true,
    });
    if (unmasked.measurable) {
      const present = new Set(evaluated.map((e) => e.foreground));
      const regionArea = r.width * r.height;
      const detected = detectPlateaus(pixels, r);
      const largestShareOf = (hex) => {
        const rgb = parseColor(hex);
        let best = 0;
        for (const p of detected) {
          if (rgbDistance(p.rgb, rgb) <= PLATEAU_MERGE_DIST) {
            best = Math.max(best, p.largest_component_share ?? 0);
          }
        }
        return best;
      };
      const dropped = unmasked.colours.filter((c) => {
        if (c.wcag_aa || present.has(c.foreground)) return false;
        return isDisclosableDroppedColour(c, regionArea, largestShareOf(c.foreground));
      });
      if (dropped.length > 0) {
        maskReconciliation = {
          unmasked_failing_colours: dropped.map((c) => {
            const panelShaped = isPanelShapedDroppedColour(c, regionArea);
            return {
              foreground: c.foreground,
              contrast_ratio: c.contrast_ratio,
              pixel_count: c.pixel_count,
              component_count: c.component_count,
              mean_component_area: c.component_count
                ? Math.round(c.pixel_count / c.component_count)
                : c.pixel_count,
              largest_component_share: Math.round(largestShareOf(c.foreground) * 10000) / 10000,
              detected_plateau: detected.some(
                (p) => rgbDistance(p.rgb, parseColor(c.foreground)) <= PLATEAU_MERGE_DIST,
              ),
              shape: panelShaped ? "panel-shaped" : "text-sized",
              measured_against: c.measured_against,
            };
          }),
          note:
            "masking a background region also removed colour(s) that an un-masked pass measures as failing. " +
            "A panel-shaped region could be very large text; a text-sized one is more likely a large glyph. " +
            "If either is text, re-measure that specific text with a `region`.",
        };
        notes.push(
          `Mask reconciliation: masking a background region also removed ` +
            dropped
              .map(
                (c) =>
                  `${c.foreground} (${c.contrast_ratio}:1, ` +
                  `${isPanelShapedDroppedColour(c, regionArea) ? "panel-shaped" : "text-sized"})`,
              )
              .join(", ") +
            `, which an un-masked pass measures as failing. These are usually backgrounds or decoration, but they ` +
            `could be text; if so, re-measure that text with a \`region\`.`,
        );
      }
    }
  }

  // Honest scope reporting: if a single global background explains only part of
  // the region, say so. Contrast enumerated against a global background on a
  // photographic/gradient image may miss text or report image regions as
  // colours; the caller is told rather than left to assume the check was sound.
  //
  // `background_fit` describes whether ONE colour models the region, so it is
  // only meaningful when there is one background. In a multi-plateau region it
  // is explicitly marked not-applicable: previously it was still populated with
  // `adequate: true` while a note said it "is not meaningful here", so a caller
  // reading `adequate` was told "fine" by a value we called meaningless.
  const rawFit = backgroundMode === "global" ? assessBackgroundFit(pixels, r) : null;
  const backgroundFit = rawFit
    ? multiPlateau
      ? {
          ...rawFit,
          adequate: null, // null = not applicable, and falsy, so it cannot read as "fine"
          applicable: false,
          not_applicable_reason:
            "the region has multiple large flat plateaus, so a single-colour fit does not describe it",
        }
      : { ...rawFit, applicable: true }
    : null;

  if (backgroundFit && backgroundFit.applicable && !backgroundFit.adequate) {
    notes.push(
      `Background fit warning: a single global background (${backgroundFit.background}) explains only ` +
        `${(backgroundFit.explained_fraction * 100).toFixed(1)}% of this region. This is likely a photographic, ` +
        `gradient or multi-tone image. Results above were computed against that global background; pass ` +
        `background_mode: "local" for a per-tile adaptive background, which handles such images better.`,
    );
  } else if (backgroundFit && backgroundFit.applicable && backgroundFit.explained_fraction < GOOD_FIT_FRACTION) {
    // MARGINAL fit. The 0.5 floor is a round number, and an image can sit just
    // above it (a shallow gradient was measured at 0.501) while a global
    // background is still a poor model. A verdict must never be silent about a
    // marginal premise, so this is disclosed even though `adequate` is true.
    notes.push(
      `Background fit is marginal: a single global background (${backgroundFit.background}) explains only ` +
        `${(backgroundFit.explained_fraction * 100).toFixed(1)}% of this region, so a global background is a weak ` +
        `model here. The result above was computed against that global background. If this region is a gradient or ` +
        `photograph, pass background_mode: "local", which resolves more text tones.`,
    );
  }

  // Multi-plateau disclosure. When a region has several large flat panels, a
  // single modal background is inadequate EVEN IF it explains most of the area
  // (the audit's 30/70 layout had a modal fraction of 0.693 and scored
  // "adequate"). Say so, and say which background each colour was measured
  // against, so a caller can never read a single-baseline verdict as covering
  // every panel.
  if (multiPlateau) {
    const biggest = plateaus[0];
    notes.push(
      `Multi-plateau region: ${plateaus.length} large flat colour plates were detected (` +
        plateaus.map((p) => `${p.hex} ${(p.share * 100).toFixed(1)}%`).join(", ") +
        `). A single modal background (${biggest.hex}) explains ${(biggest.share * 100).toFixed(1)}% of the area, ` +
        `so contrast for each text colour was measured against ITS OWN nearest plateau; each colour reports ` +
        `\`measured_against\`. A region-wide background_fit is not meaningful here.`,
    );
  }
  if (plateauFills.length > 0) {
    notes.push(
      `${plateauFills.length} panel fill colour(s) were treated as background, not text ` +
        `(large near-solid regions matching a detected plateau): ` +
        plateauFills.map((p) => `${p.foreground} (${p.pixel_count}px)`).join(", ") +
        `. Their pixels are not text; text sitting ON them is measured against them.`,
    );
  }

  // Every plateau must reference itself (a plateau's own contrast is 1.0:1 and is
  // never a text colour), and at least one evaluated text colour must sit on a
  // plateau for that plateau to be considered covered. Disclose any plateau with
  // no evaluated text colour, so "all_meet_aa: true" never implies a panel was
  // audited when nothing on it was assessed.
  let plateausWithoutText = [];
  if (multiPlateau) {
    plateausWithoutText = plateaus
      .filter((p) => {
        const referenced = evaluated.some(
          (e) => e.measured_against_plateau && rgbDistance(parseColor(e.measured_against), p.rgb) <= PLATEAU_MERGE_DIST,
        );
        return !referenced;
      })
      .map((p) => ({ plateau: p.hex, share: Math.round(p.share * 1000) / 1000 }));
    if (plateausWithoutText.length > 0) {
      notes.push(
        `Scope note: ${plateausWithoutText.length} detected plateau(s) have no assessed text colour on them ` +
          `(${plateausWithoutText.map((p) => `${p.plateau} ${(p.share * 100).toFixed(1)}%`).join(", ")}). ` +
          `No text was found there; that is not a claim that such text passes contrast.`,
      );
    }
  }

  if (excluded.length > 0) {
    notes.push(
      `Excluded ${excluded.length} non-text colour(s) from the contrast summary based on geometry ` +
        `(thin hollow rectangles are treated as decorative borders, not text): ` +
        excluded.map((e) => `${e.foreground} (${e.contrast_ratio}:1, ${e.pixel_count}px)`).join(", ") +
        `. Pass include_decorative: true to assess them anyway.`,
    );
  }
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} non-background colour(s) covering ${unassessedNonBackground}px were detected but NOT ` +
        `assessed for contrast because they fall below the reporting floor (${minColourPixels}px): ` +
        skipped.map((e) => `${e.foreground} (${e.pixel_count}px)`).join(", ") +
        `. They are excluded from worst/best and from all_meet_aa.`,
    );
  }
  if (mergedAA.length > 0) {
    notes.push(
      `${mergedAA.length} anti-aliasing shade(s) were folded into the colour they blend towards (they are not ` +
        `distinct text colours): ` +
        mergedAA.map((m) => `${m.hex} -> ${m.into} (${m.pixel_count}px)`).join(", ") +
        `. This keeps the result independent of the rasteriser used to produce the image.`,
    );
  }
  if (suspectedNoise.length > 0) {
    notes.push(
      `${suspectedNoise.length} low-contrast cluster(s) were classified as SUSPECTED BACKGROUND NOISE, not text, ` +
        `under background_mode:"local" (weak contrast AND untext-like component geometry): ` +
        suspectedNoise
          .map((n) => `${n.foreground} (${n.contrast_ratio}:1, ${n.pixel_count}px, ${n.component_count} comp)`)
          .join(", ") +
        `. They are listed under \`suspected_noise\` and excluded from worst/failing_count/all_meet_aa.`,
    );
  }
  if (backgroundMode === "local") {
    notes.push(
      'background_mode:"local" has NO single background colour by construction; `background` is reported as null ' +
        `and each colour carries \`local_background\`. This avoids presenting a text colour as a "background".`,
    );
  }
  if (truncated) {
    notes.push("Component extraction hit its cap; the enumeration may be incomplete for this region.");
  }

  // In local mode there is no single background, so do not return one. A global
  // modal colour on a gradient/photo can coincide with a text tone, and a caller
  // reading `background` would then act on a colour that is actually text.
  const backgroundOut = backgroundMode === "local"
    ? null
    : { hex: toHex(background), rgb: background };

  if (evaluated.length === 0) {
    const onlyDecorative = excluded.length > 0 && skipped.length === 0;
    const onlySuspectedNoise = suspectedNoise.length > 0 && excluded.length === 0 && skipped.length === 0;
    return {
      region: { left: r.left, top: r.top, width: r.width, height: r.height },
      background: backgroundOut,
      background_mode: inkResult.background_mode,
      plateaus: plateaus.map((p) => ({ hex: p.hex, share: Math.round(p.share * 1000) / 1000 })),
      background_model: multiPlateau ? "multi-plateau" : backgroundMode,
      plateaus_without_text: plateausWithoutText,
      colours: [],
      worst: null,
      best: null,
      failing_count: 0,
      passing_count: 0,
      evaluated_count: 0,
      all_meet_aa: null,
      measurable: false,
      ink_pixel_count,
      effective_ink_threshold: inkResult.effective_ink_threshold,
      median_ink_threshold: inkResult.median_ink_threshold,
      background_fit: backgroundFit,
      method: "pixel-components/extremal-per-glyph+cluster",
      notes,
      excluded,
      skipped,
      panel_fills: plateauFills,
      suspected_noise: suspectedNoise,
      background_regions: backgroundRegions,
      mask_reconciliation: maskReconciliation,
      merged_anti_aliasing: mergedAA,
      abstained: [
        {
          question: "contrast ratio of text",
          reason: onlyDecorative
            ? "Only decorative (non-text) geometry was found in this region; no text colour could be assessed. " +
              "Pass include_decorative: true to assess decorative colours explicitly."
            : onlySuspectedNoise
              ? "No assessable text colour was found: the only non-background clusters were classified as " +
                "suspected background noise (see `suspected_noise`), not text."
              : "No assessable text colour was found in this region (it may be uniform or contain only sub-threshold detail).",
        },
      ],
      note: "No assessable text colour found in region.",
    };
  }

  const worst = evaluated[0];
  const best = evaluated[evaluated.length - 1];
  const failing = evaluated.filter((e) => !e.meets_aa);
  const allMeetAA = failing.length === 0;

  if (!allMeetAA) {
    notes.push(
      `${failing.length} of ${evaluated.length} evaluated text colour(s) fail WCAG AA: ` +
        failing.map((e) => `${e.foreground} at ${e.contrast_ratio}:1 (needs ${e.required_aa}:1)`).join(", ") +
        `.`,
    );
  }

  // ------------------------------------------------------------------------
  // LOCAL ARBITRATION — the guard that closes the "silent clean verdict" path.
  //
  // The invariant this server defends is: no response may read
  // `all_meet_aa: true` with no caveat while a text run in scope fails contrast
  // and an available mode returns it. A global background that ramps (a
  // gradient) can satisfy the adequacy floor (measured: 0.501) and still miss a
  // failing tone that the per-tile model resolves.
  //
  // So when the global verdict is about to be a clean pass, re-run the SAME
  // region with the per-tile model and disclose any disagreement. This is only
  // a disclosure: local over-reports on dense flat panels (see ACCURACY.md 5c),
  // so the note reports the disagreement and asks for a region, and does not
  // claim local is universally better.
  // ------------------------------------------------------------------------
  let modelDisagreement = null;
  if (allMeetAA && backgroundMode === "global" && !multiPlateau && !explicitBg) {
    const local = enumerateRegionContrast(pixels, r, {
      ...opts,
      background: undefined,
      backgroundMode: "local",
      tileSize,
      noiseFactor,
    });
    if (local.measurable) {
      const localFailing = local.colours.filter((c) => !c.meets_aa);
      if (localFailing.length > 0) {
        modelDisagreement = {
          global_all_meet_aa: true,
          local_all_meet_aa: local.all_meet_aa,
          local_failing_count: localFailing.length,
          local_failing_colours: localFailing.map((c) => ({
            foreground: c.foreground,
            contrast_ratio: c.contrast_ratio,
            pixel_count: c.pixel_count,
            component_count: c.component_count,
            measured_against: c.measured_against,
          })),
          note:
            "the two background models disagree on this region: the global model finds no failing text colour, " +
            "the per-tile (local) model finds " + localFailing.length + ". This usually means the background varies " +
            "across the region (a gradient or photograph). Treat the clean verdict as UNVERIFIED and re-measure the " +
            "specific text with a `region`. Note that local mode is not generally more accurate: it over-reports on " +
            "dense flat panels, which is why it is not the default.",
        };
        notes.push(
          `Model disagreement: the global background model reports no failing text colour, but the per-tile ` +
            `(local) model reports ${localFailing.length} (` +
            localFailing.map((c) => `${c.foreground} at ${c.contrast_ratio}:1`).join(", ") +
            `). The background likely varies across this region. Treat this clean verdict as unverified and ` +
            `re-measure the specific text with a \`region\`.`,
        );
      }
    }
  }

  return {
    region: { left: r.left, top: r.top, width: r.width, height: r.height },
    background: backgroundOut,
    background_mode: inkResult.background_mode,
    plateaus: plateaus.map((p) => ({ hex: p.hex, share: Math.round(p.share * 1000) / 1000 })),
    background_model: multiPlateau ? "multi-plateau" : backgroundMode,
    plateaus_without_text: plateausWithoutText,
    colours: evaluated,
    worst,
    best,
    failing_count: failing.length,
    passing_count: evaluated.length - failing.length,
    evaluated_count: evaluated.length,
    all_meet_aa: allMeetAA,
    wcag_aa: allMeetAA, // alias: "no text colour fails AA" (worst case, not best)
    measurable: true,
    ink_pixel_count,
    effective_ink_threshold: inkResult.effective_ink_threshold,
    median_ink_threshold: inkResult.median_ink_threshold,
    background_fit: backgroundFit,
    model_disagreement: modelDisagreement,
    method: "pixel-components/extremal-per-glyph+cluster",
    notes,
    excluded,
    skipped,
    panel_fills: plateauFills,
    suspected_noise: suspectedNoise,
    background_regions: backgroundRegions,
    mask_reconciliation: maskReconciliation,
    merged_anti_aliasing: mergedAA,
    abstained,
  };
}

/**
 * Measure text/foreground contrast inside a region.
 *
 * Returns the WORST-CASE text colour as the headline scalar, so a caller asking
 * "does this have contrast problems?" cannot be told "fine" because one
 * heading happened to be legible. `best` preserves the old number.
 *
 * @param {object} pixels
 * @param {object} region
 * @param {{ background?: string, tolerance?: number, large?: boolean, inkThreshold?: number, includeDecorative?: boolean }} [opts]
 */
export function contrastInRegion(pixels, region, opts = {}) {
  const enumerated = enumerateRegionContrast(pixels, region, opts);

  if (!enumerated.measurable) {
    return {
      ...enumerated,
      foreground: null,
      contrast_ratio: null,
      wcag_aaa: null,
      required_aa: 4.5,
      required_aaa: 7,
    };
  }

  const { worst, best, colours, failing_count, evaluated_count, all_meet_aa } = enumerated;
  return {
    ...enumerated,
    // Back-compatible scalar: now the WORST case (was previously the best).
    foreground: { hex: worst.foreground, rgb: worst.rgb, pixel_count: worst.pixel_count },
    contrast_ratio: worst.contrast_ratio,
    contrast_ratio_raw: worst.contrast_ratio_raw,
    wcag_aa: all_meet_aa,
    wcag_aaa: worst.wcag_aaa,
    required_aa: worst.required_aa,
    required_aaa: worst.required_aaa,
    worst_case: worst,
    best_case: best,
    failing_count,
    passing_count: enumerated.passing_count,
    evaluated_count,
    colour_count: colours.length,
  };
}

/**
 * Build a boolean mask of pixels within `tolerance` RGB distance of `color`.
 * @param {object} pixels
 * @param {string|object} color
 * @param {number} [tolerance]
 * @returns {Uint8Array} length = width*height, 1 = match
 */
export function maskByColor(pixels, color, tolerance = 24) {
  const target = typeof color === "string" ? parseColor(color) : color;
  const { data, width, height, channels } = pixels;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const px = { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
      mask[y * width + x] = rgbDistance(px, target) <= tolerance ? 1 : 0;
    }
  }
  return mask;
}

/**
 * 4-connected component labelling over a boolean mask.
 *
 * This is what makes "count the boxes" a *measurement* rather than a model
 * opinion. Connected runs of a chosen border colour give exact box counts and
 * pixel-accurate bounding boxes.
 *
 * @param {object} pixels
 * @param {Uint8Array} mask
 * @param {{ minArea?: number, maxComponents?: number }} [opts]
 * @returns {Array<{ x:number,y:number,width:number,height:number,area:number,cx:number,cy:number }>}
 */
export function findComponents(pixels, mask, opts = {}) {
  const { width, height } = pixels;
  const minArea = opts.minArea ?? 20;
  const maxComponents = opts.maxComponents ?? 512;
  const seen = new Uint8Array(width * height);
  const out = [];
  const stack = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width;
      const y = (idx / width) | 0;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      // 4-neighbourhood
      if (x > 0) {
        const n = idx - 1;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
      if (y > 0) {
        const n = idx - width;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }

    if (area >= minArea) {
      out.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area,
        cx: Math.round(sumX / area),
        cy: Math.round(sumY / area),
      });
      if (out.length >= maxComponents) break;
    }
  }

  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/**
 * Count rectangular boxes drawn in a specific border colour.
 * @param {object} pixels
 * @param {{ color: string, tolerance?: number, minArea?: number, minWidth?: number, minHeight?: number }} opts
 */
export function findColorBoxes(pixels, opts) {
  const {
    color,
    tolerance = 24,
    minArea = 200,
    minWidth = 40,
    minHeight = 30,
  } = opts;
  const mask = maskByColor(pixels, color, tolerance);
  const components = findComponents(pixels, mask, { minArea });
  const boxes = components.filter((c) => c.width >= minWidth && c.height >= minHeight);
  return {
    count: boxes.length,
    color: typeof color === "string" ? color : toHex(color),
    tolerance,
    boxes: boxes.map((b, i) => ({ id: `box_${i + 1}`, ...b })),
    rejected_small_components: components.length - boxes.length,
  };
}

/**
 * Fraction of pixels in a region that differ from a background colour.
 * Used to answer "is there any visible content here?" deterministically
 * (e.g. "does this card contain a '+' glyph?").
 * @param {object} pixels
 * @param {object} region
 * @param {{ background?: string, tolerance?: number }} [opts]
 */
export function nonBackgroundRatio(pixels, region, opts = {}) {
  const r = clampRegion(pixels, region);
  const bg = opts.background ? parseColor(opts.background) : null;
  const tolerance = opts.tolerance ?? 24;

  let nonBg = 0;
  let total = 0;
  let reference = bg;
  if (!reference) {
    const entries = histogramToEntries(colorHistogram(pixels, r));
    reference = entries[0].rgb;
  }

  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) {
      const idx = (y * pixels.width + x) * pixels.channels;
      const px = { r: pixels.data[idx], g: pixels.data[idx + 1], b: pixels.data[idx + 2] };
      total++;
      if (rgbDistance(px, reference) > tolerance) nonBg++;
    }
  }
  return {
    region: { left: r.left, top: r.top, width: r.width, height: r.height },
    background: toHex(reference),
    non_background_pixels: nonBg,
    total_pixels: total,
    non_background_ratio: total ? roundRatio((nonBg / total) * 100) : 0,
    has_content: nonBg > 0,
  };
}

/**
 * Verify that a claimed text box lies inside a supplied crop region.
 * Fixes F3: a model transcribed tab-bar labels that were *outside* the crop.
 * @param {{ left:number,top:number,width:number,height:number }} crop
 * @param {{ left:number,top:number,width:number,height:number }} box
 * @param {{ minOverlap?: number }} [opts] minOverlap = fraction of box area inside crop
 */
export function isBoxInsideCrop(crop, box, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.5;
  const bx1 = box.left ?? box.x ?? 0;
  const by1 = box.top ?? box.y ?? 0;
  const bw = box.width ?? 0;
  const bh = box.height ?? 0;
  const bx2 = bx1 + bw;
  const by2 = by1 + bh;

  const ix1 = Math.max(bx1, crop.left);
  const iy1 = Math.max(by1, crop.top);
  const ix2 = Math.min(bx2, crop.left + crop.width);
  const iy2 = Math.min(by2, crop.top + crop.height);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  const boxArea = Math.max(1, bw * bh);
  const overlap = intersection / boxArea;

  return {
    inside: overlap >= minOverlap,
    overlap: roundRatio(overlap * 100) / 100,
    intersection: { left: ix1, top: iy1, width: iw, height: ih },
  };
}

/**
 * Summarise an image: real dimensions, aspect ratio, and dominant colours.
 * @param {Buffer} buffer
 */
export async function summarizeImage(buffer) {
  const meta = await sharp(buffer).metadata();
  const pixels = await loadPixels(buffer);
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    channels: meta.channels,
    aspect_ratio: meta.width && meta.height ? roundRatio(meta.width / meta.height) : null,
    dominant_colors: dominantColors(pixels, { left: 0, top: 0, width: meta.width, height: meta.height }, { top: 5 }),
  };
}
