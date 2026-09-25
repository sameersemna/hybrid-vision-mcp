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
      if (field) {
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
    let bestKey = null;
    let bestDist = -1;
    let fallbackKey = null;
    let fallbackCount = -1;
    for (const [key, count] of localCounts) {
      const rgb = { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff };
      const d = rgbDistance(rgb, bg);
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
      box: { left: minX, top: minY, width: boxW, height: boxH },
      fill_ratio: roundRatio(fill * 100) / 100,
      // A thin closed outline (large box, tiny fill) is decorative chrome
      // (a border or rule), not a glyph. Text strokes are either small or
      // high-fill, so this test does not catch them.
      looks_like_hollow_rectangle: boxW >= 60 && boxH >= 60 && fill < 0.25,
    });
  }

  return {
    components,
    background: bg,
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
      mergedInto.push({ hex: c.hex, into: parent.hex, pixel_count: c.pixel_count });
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

  const inkResult = extractInkComponents(regionPixels, {
    background: regionBg,
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
      boxes: [], hollow: 0, distances: [],
    };
    g.pixel_count += c.pixel_count;
    g.component_count++;
    g.boxes.push(c.box);
    if (c.looks_like_hollow_rectangle) g.hollow++;
    g.distances.push(c.distance_from_background);
    // Keep the most extreme member as the representative.
    if (c.distance_from_background > (g.best_distance ?? -1)) {
      g.best_distance = c.distance_from_background;
      g.hex = c.hex;
      g.rgb = c.rgb;
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
      target.boxes.push(...g.boxes);
      target.members.push(g);
      if ((g.best_distance ?? -1) > (target.best_distance ?? -1)) {
        target.best_distance = g.best_distance;
        target.hex = g.hex;
        target.rgb = g.rgb;
      }
    }
  }

  // Split into text-like vs decorative, and separate "too small to judge".
  const evaluated = [];
  const excluded = [];
  const skipped = [];
  let unassessedNonBackground = 0;

  // Fold anti-aliasing artefacts into the colours they are blends of, so the
  // reported set does not depend on which renderer produced the image.
  const { clusters: finalClusters, merged_anti_aliasing: mergedAA } =
    mergeAntiAliasing(clusters, background);

  for (const cl of finalClusters) {
    const ratio = contrastRatio(cl.rgb, background);
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
      luminance_delta: roundRatio(Math.abs(relativeLuminance(cl.rgb) - bgLum) * 1000) / 1000,
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

  // Honest scope reporting: if a single global background explains only part of
  // the region, say so. Contrast enumerated against a global background on a
  // photographic/gradient image may miss text or report image regions as
  // colours; the caller is told rather than left to assume the check was sound.
  const backgroundFit = backgroundMode === "global"
    ? assessBackgroundFit(pixels, r)
    : null;
  if (backgroundFit && !backgroundFit.adequate) {
    notes.push(
      `Background fit warning: a single global background (${backgroundFit.background}) explains only ` +
        `${(backgroundFit.explained_fraction * 100).toFixed(1)}% of this region. This is likely a photographic, ` +
        `gradient or multi-tone image. Results above were computed against that global background; pass ` +
        `background_mode: "local" for a per-tile adaptive background, which handles such images better.`,
    );
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
  if (truncated) {
    notes.push("Component extraction hit its cap; the enumeration may be incomplete for this region.");
  }

  if (evaluated.length === 0) {
    const onlyDecorative = excluded.length > 0 && skipped.length === 0;
    return {
      region: { left: r.left, top: r.top, width: r.width, height: r.height },
      background: { hex: toHex(background), rgb: background, pixel_count: null },
      colours: [],
      worst: null,
      best: null,
      failing_count: 0,
      passing_count: 0,
      evaluated_count: 0,
      all_meet_aa: null,
      measurable: false,
      ink_pixel_count,
      background_mode: inkResult.background_mode,
      effective_ink_threshold: inkResult.effective_ink_threshold,
      median_ink_threshold: inkResult.median_ink_threshold,
      background_fit: backgroundFit,
      method: "pixel-components/extremal-per-glyph+cluster",
      notes,
      excluded,
      skipped,
      merged_anti_aliasing: mergedAA,
      abstained: [
        {
          question: "contrast ratio of text",
          reason: onlyDecorative
            ? "Only decorative (non-text) geometry was found in this region; no text colour could be assessed. " +
              "Pass include_decorative: true to assess decorative colours explicitly."
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

  return {
    region: { left: r.left, top: r.top, width: r.width, height: r.height },
    background: { hex: toHex(background), rgb: background },
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
    background_mode: inkResult.background_mode,
    effective_ink_threshold: inkResult.effective_ink_threshold,
    median_ink_threshold: inkResult.median_ink_threshold,
    background_fit: backgroundFit,
    method: "pixel-components/extremal-per-glyph+cluster",
    notes,
    excluded,
    skipped,
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
