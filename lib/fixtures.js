// ==========================================
// Acceptance fixture: synthetic image + declared ground truth.
// ==========================================
// The fixture exists so "the tool was wrong" becomes decidable. Every claim
// the fixture makes about itself is *asserted in code* before any test relies
// on it (see `assertFixtureTruth`) — a wrong fixture would silently invalidate
// every downstream assertion, so it is validated first, not last.
//
// Reference background is #1a1814. Declared contrast values were computed with
// the same WCAG maths the server now uses, and are re-derived at build time.

import sharp from "sharp";
import { parseColor, contrastRatio, roundRatio } from "./color.js";
import { loadPixels, contrastInRegion, findColorBoxes, isBoxInsideCrop } from "./measure.js";

export const BACKGROUND = "#1a1814";
export const BOX_BORDER_COLOR = "#7FB3D5"; // distinct from label colour so boxes are countable
export const PLUS_MARKER_COLOR = "#FF7A00"; // unique colour -> the "+" is unambiguously locatable
export const LABEL_COLOR = "#E8DFD0";

export const CANVAS = { width: 1200, height: 760 };

/** Declared text lines, with their reference contrast against BACKGROUND. */
export const TEXT_SPECS = [
  {
    id: "alpha",
    text: "ALPHA-ONE",
    color: "#E8DFD0",
    font_size: 44,
    x: 40,
    baseline: 90,
    declared_contrast: 13.42,
    legible: true,
    role: "must_transcribe",
  },
  {
    id: "bravo",
    text: "BRAVO-TWO",
    color: "#484f58",
    font_size: 44,
    x: 40,
    baseline: 170,
    declared_contrast: 2.14,
    legible: false,
    role: "must_flag_low_contrast",
  },
  {
    id: "charlie",
    text: "CHARLIE-THREE-8g7x2",
    color: "#A09588",
    font_size: 22, // deliberately small
    x: 40,
    baseline: 245,
    declared_contrast: 6.03,
    legible: true,
    role: "must_transcribe_small_text",
  },
  {
    id: "hotel",
    text: "HOTEL-FIVE-INVISIBLE",
    color: "#1e1c18",
    font_size: 44,
    x: 40,
    baseline: 320,
    declared_contrast: 1.04,
    legible: false,
    role: "must_not_report_as_text",
  },
];

/** The four labelled boxes. ECHO is the only one containing the "+" marker. */
export const BOX_SPECS = [
  { label: "DELTA", x: 40, y: 380, width: 250, height: 320 },
  { label: "ECHO", x: 320, y: 380, width: 250, height: 320, has_plus: true },
  { label: "FOXTROT", x: 600, y: 380, width: 250, height: 320 },
  { label: "GOLF", x: 880, y: 380, width: 250, height: 320 },
];

export const ONLY_BOX_WITH_PLUS = "ECHO";

/** Crop used by the F3 marker test: exactly one box, nothing else. */
export const CROP_REGION = {
  left: BOX_SPECS[0].x,
  top: BOX_SPECS[0].y,
  width: BOX_SPECS[0].width,
  height: BOX_SPECS[0].height,
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the fixture SVG string. Exported so the fixture is inspectable
 * rather than opaque.
 * @returns {string}
 */
export function renderFixtureSvg() {
  const parts = [];
  parts.push(
    `<rect width="${CANVAS.width}" height="${CANVAS.height}" fill="${BACKGROUND}"/>`,
  );

  for (const t of TEXT_SPECS) {
    parts.push(
      `<text x="${t.x}" y="${t.baseline}" font-family="DejaVu Sans, Arial, sans-serif" ` +
        `font-size="${t.font_size}" fill="${t.color}">${escapeXml(t.text)}</text>`,
    );
  }

  for (const b of BOX_SPECS) {
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" ` +
        `fill="none" stroke="${BOX_BORDER_COLOR}" stroke-width="4"/>`,
    );
    parts.push(
      `<text x="${b.x + 25}" y="${b.y + 70}" font-family="DejaVu Sans, Arial, sans-serif" ` +
        `font-size="32" fill="${LABEL_COLOR}">${escapeXml(b.label)}</text>`,
    );
    if (b.has_plus) {
      parts.push(
        `<text x="${b.x + 25}" y="${b.y + 200}" font-family="DejaVu Sans, Arial, sans-serif" ` +
          `font-size="56" fill="${PLUS_MARKER_COLOR}">+</text>`,
      );
    }
  }

  return `<svg width="${CANVAS.width}" height="${CANVAS.height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

/**
 * Render the fixture to a PNG buffer.
 * @returns {Promise<Buffer>}
 */
export async function buildFixturePng() {
  return sharp(Buffer.from(renderFixtureSvg())).png().toBuffer();
}

/**
 * The fixture's self-description, including contrast values re-derived from
 * the same maths the server uses (not copied from a comment).
 * @returns {object}
 */
export function getGroundTruth() {
  const bg = parseColor(BACKGROUND);
  return {
    canvas: { ...CANVAS },
    background: BACKGROUND,
    box_border_color: BOX_BORDER_COLOR,
    plus_marker_color: PLUS_MARKER_COLOR,
    text: TEXT_SPECS.map((t) => ({
      id: t.id,
      text: t.text,
      color: t.color,
      legible: t.legible,
      role: t.role,
      declared_contrast: t.declared_contrast,
      computed_contrast: roundRatio(contrastRatio(parseColor(t.color), bg)),
      region: {
        left: t.x,
        top: t.baseline - t.font_size - 6,
        width: Math.max(120, t.text.length * t.font_size * 0.62 + 20),
        height: t.font_size * 1.7,
      },
      contrast_tolerance: t.id === "hotel" ? 6 : 24,
    })),
    boxes: BOX_SPECS.map((b) => ({ ...b })),
    box_count: BOX_SPECS.length,
    only_box_with_plus: ONLY_BOX_WITH_PLUS,
    crop_region: { ...CROP_REGION },
  };
}

/**
 * Assert the fixture agrees with its own declared ground truth.
 *
 * Runs purely deterministic checks (no model, no OCR). Throws with a precise
 * message if the fixture is wrong, because every downstream test is only as
 * trustworthy as this.
 *
 * @returns {Promise<object>} a verification report
 */
export async function assertFixtureTruth() {
  const png = await buildFixturePng();
  const gt = getGroundTruth();
  const pixels = await loadPixels(png);
  const failures = [];
  const checks = [];

  // 1. Real dimensions match the declared canvas.
  checks.push({
    check: "dimensions",
    expected: `${CANVAS.width}x${CANVAS.height}`,
    actual: `${pixels.width}x${pixels.height}`,
  });
  if (pixels.width !== CANVAS.width || pixels.height !== CANVAS.height) {
    failures.push(`dimensions: expected ${CANVAS.width}x${CANVAS.height}, got ${pixels.width}x${pixels.height}`);
  }

  // 2. Declared contrast values agree with WCAG maths.
  for (const t of gt.text) {
    const ok = Math.abs(t.declared_contrast - t.computed_contrast) < 0.02;
    checks.push({
      check: `declared_contrast:${t.id}`,
      declared: t.declared_contrast,
      computed: t.computed_contrast,
      ok,
    });
    if (!ok) failures.push(`contrast(${t.id}): declared ${t.declared_contrast} != computed ${t.computed_contrast}`);
  }

  // 3. Measured contrast of the rendered pixels reproduces the declared ratio
  //    (proves the renderer actually painted the intended colours).
  const measured = {};
  for (const t of gt.text) {
    const m = contrastInRegion(pixels, t.region, { tolerance: t.contrast_tolerance });
    measured[t.id] = m;
    if (m.measurable) {
      const delta = Math.abs(m.contrast_ratio - t.computed_contrast);
      const ok = delta < 0.25;
      checks.push({ check: `measured_contrast:${t.id}`, measured: m.contrast_ratio, expected: t.computed_contrast, ok });
      if (!ok) failures.push(`measured contrast(${t.id}): ${m.contrast_ratio} vs expected ${t.computed_contrast}`);
    } else if (t.id !== "hotel") {
      failures.push(`measured contrast(${t.id}): region was not measurable but should be`);
    }
  }

  // 4. Exactly four boxes, in the declared border colour, at the declared spots.
  const found = findColorBoxes(pixels, { color: BOX_BORDER_COLOR, minArea: 200, minWidth: 40, minHeight: 30 });
  checks.push({ check: "box_count", expected: gt.box_count, actual: found.count });
  if (found.count !== gt.box_count) {
    failures.push(`box_count: expected ${gt.box_count}, found ${found.count}`);
  }

  // 5. The "+" marker exists exactly once and lies inside ECHO's box.
  const plus = findColorBoxes(pixels, {
    color: PLUS_MARKER_COLOR,
    minArea: 20,
    minWidth: 5,
    minHeight: 5,
    tolerance: 30,
  });
  checks.push({ check: "plus_components", expected: 1, actual: plus.count });
  if (plus.count !== 1) {
    failures.push(`plus marker: expected exactly 1 component, found ${plus.count}`);
  } else {
    const c = plus.boxes[0];
    const owner = gt.boxes.find(
      (b) => c.cx >= b.x && c.cx <= b.x + b.width && c.cy >= b.y && c.cy <= b.y + b.height,
    );
    checks.push({ check: "plus_owner", expected: ONLY_BOX_WITH_PLUS, actual: owner ? owner.label : null });
    if (!owner || owner.label !== ONLY_BOX_WITH_PLUS) {
      failures.push(`plus owner: expected ${ONLY_BOX_WITH_PLUS}, got ${owner ? owner.label : "none"}`);
    }
  }

  // 6. The crop region contains only the DELTA box, so the F3 test is valid.
  const others = gt.boxes.filter((b) => b.label !== "DELTA");
  for (const b of others) {
    const r = isBoxInsideCrop(CROP_REGION, { left: b.x, top: b.y, width: b.width, height: b.height }, { minOverlap: 0.05 });
    checks.push({ check: `crop_excludes:${b.label}`, overlap: r.overlap });
    if (r.overlap > 0.05) failures.push(`crop region overlaps ${b.label} by ${r.overlap}`);
  }

  if (failures.length) {
    const err = new Error(`Fixture ground truth violated:\n- ${failures.join("\n- ")}`);
    err.failures = failures;
    err.checks = checks;
    throw err;
  }

  return { ok: true, checks, measured, ground_truth: gt };
}
