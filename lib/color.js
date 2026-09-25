// ==========================================
// WCAG 2.x colour maths + colour parsing.
// ==========================================
// Pure and deterministic: no I/O, no globals, no model calls. Everything in
// this module is measurable ground truth, which is the whole point — a
// quantitative claim about colour must be computed, never guessed by an LLM.

/**
 * Clamp and round a channel value into the 0..255 integer range.
 * @param {number} n
 * @returns {number}
 */
export function clamp255(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Parse a CSS-ish colour string into `{ r, g, b, a }`.
 * Supports: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space
 * separated, `/` alpha), and the two keywords `white`/`black` (which are all
 * the LLM is ever likely to emit).
 * @param {string} input
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function parseColor(input) {
  if (typeof input !== "string") {
    throw new Error(`parseColor: expected a string, received ${typeof input}`);
  }
  const s = input.trim().toLowerCase();
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };

  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = [...h].map((c) => c + c).join("");
    }
    if (h.length !== 6 && h.length !== 8) {
      throw new Error(`parseColor: invalid hex colour "${input}"`);
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(Number.isNaN)) {
      throw new Error(`parseColor: invalid hex colour "${input}"`);
    }
    return { r, g, b, a };
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter((p) => p !== "");
    if (parts.length < 3) {
      throw new Error(`parseColor: invalid rgb() colour "${input}"`);
    }
    const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p));
    if ([r, g, b].some((v) => Number.isNaN(v))) {
      throw new Error(`parseColor: invalid rgb() colour "${input}"`);
    }
    const a = parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Number.isFinite(a) ? a : 1 };
  }

  throw new Error(`parseColor: unsupported colour format "${input}"`);
}

/**
 * Convert a single sRGB channel (0..255) to linear-light.
 * @param {number} channel
 * @returns {number}
 */
export function srgbChannelToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 2.x relative luminance of an sRGB colour.
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {number} 0..1
 */
export function relativeLuminance(rgb) {
  const R = srgbChannelToLinear(rgb.r);
  const G = srgbChannelToLinear(rgb.g);
  const B = srgbChannelToLinear(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG 2.x contrast ratio between two sRGB colours. Always >= 1.
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG 2.x conformance assessment for a measured contrast ratio.
 * @param {number} ratio
 * @param {{ large?: boolean }} [opts] `large` = >=18pt (or >=14pt bold).
 * @returns {{ wcag_aa: boolean, wcag_aaa: boolean, required_aa: number, required_aaa: number }}
 */
export function wcagCompliance(ratio, opts = {}) {
  const large = !!opts.large;
  const requiredAA = large ? 3 : 4.5;
  const requiredAAA = large ? 4.5 : 7;
  return {
    wcag_aa: ratio >= requiredAA - 1e-9,
    wcag_aaa: ratio >= requiredAAA - 1e-9,
    required_aa: requiredAA,
    required_aaa: requiredAAA,
  };
}

/**
 * Format as a `#rrggbb` hex string.
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {string}
 */
export function toHex(rgb) {
  const h = (v) => clamp255(v).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

/**
 * Euclidean distance in RGB space. Used to decide whether two sampled pixels
 * are "the same colour" within a tolerance.
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 */
export function rgbDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Round a ratio for display (2 dp), preserving full precision numerics
 * elsewhere in the payload.
 * @param {number} ratio
 * @returns {number}
 */
export function roundRatio(ratio) {
  return Math.round(ratio * 100) / 100;
}
