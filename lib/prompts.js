// ==========================================
// Claim schemas + prompt construction.
// ==========================================
// The schema below is the contract that stops free-text fabrication. Every
// statement the model makes must be attached to a `claims[]` entry that
// carries its own justification (box + confidence). `abstained[]` exists so
// that "I could not determine this" is a first-class, encouraged answer:
// a missing answer is strictly better than an invented one.

/** A bounding box in image pixels. */
export const BOX_SCHEMA = {
  type: "object",
  properties: {
    left: { type: "number" },
    top: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
  },
  required: ["left", "top", "width", "height"],
};

/**
 * The core structured-response schema. Shared by every vision tool so that
 * downstream agents can parse every tool identically.
 */
export const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One or two sentences. Only state what you can support with a claim below.",
    },
    claims: {
      type: "array",
      description: "Each factual assertion you are making, with its own justification.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The assertion, in plain language." },
          kind: {
            type: "string",
            enum: ["text", "element", "color", "contrast", "count", "layout", "other"],
          },
          box: BOX_SCHEMA,
          confidence: {
            type: "number",
            description: "0 to 1. Use a low value when you are unsure.",
          },
          evidence: {
            type: "string",
            description: "What in the image supports this claim.",
          },
        },
        required: ["claim", "kind", "confidence"],
      },
    },
    text_items: {
      type: "array",
      description: "Exact strings you can read in the image, each with its location.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          box: BOX_SCHEMA,
          confidence: { type: "number" },
          legible: { type: "boolean" },
        },
        required: ["text", "confidence"],
      },
    },
    counts: {
      type: "object",
      description: "Any counts you can support (e.g. number of boxes, buttons, columns).",
      additionalProperties: { type: "number" },
    },
    observations: {
      type: "array",
      items: { type: "string" },
      description: "Notable visual facts (layout, spacing, alignment) with no numeric claim.",
    },
    unreadable: {
      type: "array",
      items: { type: "string" },
      description: "Text you believe is present but cannot read reliably.",
    },
    abstained: {
      type: "array",
      description:
        "Questions you could NOT answer from the image. Populate this instead of guessing. " +
        "Abstaining is preferred over an unsupported answer.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          reason: { type: "string" },
        },
        required: ["question", "reason"],
      },
    },
  },
  required: ["summary", "claims", "abstained"],
};

/** Shared preamble that sets the anti-fabrication contract. */
export const GROUNDING_PREAMBLE = [
  "You are a strictly grounded image inspector.",
  "Rules you must follow:",
  "1. Only describe what is actually visible. Never infer text, icons, or layout from expectation or convention.",
  "2. Every statement must appear in claims[] with a bounding box when it refers to a region.",
  "3. Do NOT state numbers (contrast, counts, sizes, ratios) — measurements are performed separately in code.",
  "   If asked for a measurement, put the question in abstained[] with reason 'measurement-not-computable-by-vision'.",
  "4. It is expected and acceptable to abstain. A missing answer is better than a wrong one.",
  "5. If text is too small or low-contrast to read, list it in unreadable[] rather than guessing its content.",
  "6. Return only JSON matching the provided schema.",
].join("\n");

/**
 * Build a general description/extraction prompt.
 * @param {{ question?: string, includeText?: boolean }} opts
 */
export function buildDescribePrompt(opts = {}) {
  const question = opts.question && opts.question.trim()
    ? opts.question.trim()
    : "Describe what is visible in this image.";
  const textLine = opts.includeText === false
    ? ""
    : "For every piece of text you can actually read, add a text_items[] entry with its exact characters and bounding box.";

  return `${GROUNDING_PREAMBLE}

Task: ${question}
${textLine}

Respond with the JSON object defined by the schema.`;
}

/**
 * Prompt for reading text, optionally within a known crop.
 * @param {{ crop?: {left:number,top:number,width:number,height:number} }} opts
 */
export function buildTextExtractionPrompt(opts = {}) {
  const cropNote = opts.crop
    ? `The image you were given is the crop (${opts.crop.width}x${opts.crop.height}). ` +
      `Report every box coordinate relative to THIS crop, and only include text that appears inside the crop.`
    : "Report every box coordinate relative to the provided image.";

  return `${GROUNDING_PREAMBLE}

Task: Transcribe every string you can genuinely read in this image.
${cropNote}
If a string is present but not reliably readable (too small, too faint), do NOT guess it — add it to unreadable[].

Respond with the JSON object defined by the schema.`;
}

/**
 * Prompt for UI element detection with optional filtering.
 * @param {{ elementTypes?: string[] }} opts
 */
export function buildElementDetectionPrompt(opts = {}) {
  const types = Array.isArray(opts.elementTypes) && opts.elementTypes.length
    ? opts.elementTypes.join(", ")
    : "buttons, text inputs, links, cards, navigation bars, modals, dropdowns, checkboxes, radio buttons, tables, lists, icons, headings";

  return `${GROUNDING_PREAMBLE}

Task: Identify UI elements of these types only: ${types}.
For each element, add one claims[] entry with kind "element", a bounding box, and a short label.
Also record a count per element type in counts[] (e.g. {"button": 4}).
Only include element types that are actually present. Omit anything you cannot see.

Respond with the JSON object defined by the schema.`;
}

/**
 * Prompt for comparing two images.
 * @param {{ question?: string }} opts
 */
export function buildComparePrompt(opts = {}) {
  const q = opts.question && opts.question.trim()
    ? opts.question.trim()
    : "Describe the differences between the first image (before) and the second image (after).";

  return `${GROUNDING_PREAMBLE}

Two images are provided, in order: image 1 = before, image 2 = after.
Task: ${q}
Reference each image explicitly in the claim text (e.g. "in the after image..."). Boxes refer to the image named in the claim.

Respond with the JSON object defined by the schema.`;
}

/**
 * Prompt for screenshot-level analysis with a focus area.
 * @param {{ focus?: string, detailLevel?: string }} opts
 */
export function buildScreenshotAnalysisPrompt(opts = {}) {
  const focus = opts.focus || "all";
  const detail = opts.detailLevel || "standard";
  return `${GROUNDING_PREAMBLE}

Task: Analyse this browser screenshot.
Focus area: ${focus}. Level of detail: ${detail}.
Do not assert colour contrast, pixel sizes, or element counts — those are measured separately.
You may describe layout structure, grouping, alignment, and component identity, each as a claims[] entry.

Respond with the JSON object defined by the schema.`;
}

/**
 * Heuristics for "did the user ask a measurable question?".
 * Fixes the F4 failure mode at the tool boundary: a quantitative prompt must
 * be computed by code, or explicitly abstained, never answered by the model.
 * @param {string} prompt
 * @returns {{ quantitative: boolean, matched: string[] }}
 */
export function detectQuantitativeQuestion(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return { quantitative: false, matched: [] };
  }
  const patterns = [
    /contrast/i,
    /wcag|accessibilit?y ratio/i,
    /how many/i,
    /\bcount\b/i,
    /ratio/i,
    /\b\d+(\.\d+)?\s*:\s*1\b/,
    /pixel/i,
    /\bsize\b|\bdimension/i,
    /\balign(ed|ment)?\b/i,
    /\bwidth\b|\bheight\b/i,
    /spacing|gap|margin|padding/i,
    /\bhex\b|#[0-9a-f]{6}/i,
    /colour|color (code|value)/i,
  ];
  const matched = patterns.filter((p) => p.test(prompt)).map((p) => p.source);
  return { quantitative: matched.length > 0, matched };
}

export const _internals = { GROUNDING_PREAMBLE };
