// ==========================================
// Orchestration: measurement + model + cross-validation -> one honest answer.
// ==========================================
// Two exported entry points, both returning plain objects (index.js does the
// MCP plumbing):
//
//   measureImage(...)       -> deterministic answers, NO model involved.
//                              This is what makes acceptance test #5 possible:
//                              quantitative questions succeed with Ollama down.
//   analyzeStructured(...)  -> schema-constrained claims, cross-validated
//                              against OCR, with provenance and abstention.

import sharp from "sharp";
import { queryOllamaStructured } from "./vision.js";
import {
  CLAIM_SCHEMA,
  buildDescribePrompt,
  detectQuantitativeQuestion,
} from "./prompts.js";
import { crossValidateImage } from "./crossvalidate.js";
import {
  loadPixels,
  contrastInRegion,
  dominantColors,
  findColorBoxes,
  nonBackgroundRatio,
  summarizeImage,
} from "./measure.js";
import { buildProvenance, prepareForVision, DEFAULT_LEGIBILITY_FLOOR } from "./legibility.js";

/**
 * Loose containment test used to decide whether an OCR word corresponds to a
 * model "unreadable" claim. Conservative on purpose: the OCR token must appear
 * verbatim (case-insensitive) inside the model's text. That catches the real
 * case ("The text is too small to read" alongside OCR reading "DELTA" would
 * NOT match on the token, so we only flag on genuine token overlap) while
 * avoiding false accusations.
 * @param {string} modelText
 * @param {string} ocrWord
 * @returns {boolean}
 */
function textMatchLoose(modelText, ocrWord) {
  const a = String(modelText || "").toLowerCase();
  const b = String(ocrWord || "").toLowerCase().trim();
  if (!a || !b || b.length < 3) return false;
  return a.includes(b);
}

/**
 * Deterministically measure an image. No Ollama, no OCR — pure pixel maths,
 * so this is available even when the vision model is unreachable or queued.
 *
 * @param {object} params
 * @param {Buffer} params.imageBuffer
 * @param {"contrast"|"colors"|"boxes"|"layout"|"all"} [params.mode]
 * @param {{left:number,top:number,width:number,height:number}} [params.region]
 * @param {string} [params.boxColor]
 * @param {string} [params.backgroundColor]
 * @param {number} [params.tolerance]
 * @param {boolean} [params.largeText]
 * @param {object} [params.extra]
 * @returns {Promise<object>}
 */
export async function measureImage(params) {
  const {
    imageBuffer,
    mode = "all",
    region = null,
    boxColor = null,
    backgroundColor = null,
    tolerance = 24,
    largeText = false,
    extra = {},
  } = params;

  const meta = await sharp(imageBuffer).metadata();
  const pixels = await loadPixels(imageBuffer);
  const measurements = {};
  const notes = [];
  const abstained = [];

  const wantContrast = mode === "contrast" || mode === "all";
  const wantColors = mode === "colors" || mode === "all";
  const wantBoxes = mode === "boxes" || mode === "all";
  const wantLayout = mode === "layout" || mode === "all";

  if (wantContrast) {
    // Region-less contrast: `mode: "contrast"` and `mode: "all"` MUST agree.
    // Previously `contrast` refused a full-frame request while `all` silently
    // measured it, so the SAME question produced two different answers that
    // depended only on `mode`. A caller cannot be asked to predict that.
    //
    // Both modes now measure the whole frame when no region is given, and the
    // full-frame scope is disclosed in `notes` so a caller is never told "fine"
    // about a region that was not actually the text region. (ACCURACY.md 5d)
    const effectiveRegion = region || { left: 0, top: 0, width: meta.width, height: meta.height };
    const wholeImage = !region;
    const m = contrastInRegion(pixels, effectiveRegion, {
      background: backgroundColor || undefined,
      tolerance,
      large: largeText,
      inkThreshold: extra.inkThreshold,
      includeDecorative: !!extra.includeDecorative,
      decorativeColors: extra.decorativeColors,
      backgroundMode: extra.backgroundMode,
      tileSize: extra.tileSize,
      noiseFactor: extra.noiseFactor,
    });
    measurements.contrast = m;
    if (wholeImage) {
      notes.push(
        "Contrast was measured over the WHOLE image because no `region` was supplied. Contrast depends on which " +
          "region holds the text, so this full-frame figure can include non-text detail; pass a `region` for a " +
          "question about specific text.",
      );
    }
    // Surface the enumeration's own caveats verbatim, so a caller can never
    // receive a verdict without the scope of the check it came from.
    for (const n of m.notes || []) notes.push(n);
    for (const a of m.abstained || []) abstained.push(a);
    if (!m.measurable) {
      abstained.push({
        question: "contrast ratio",
        reason: m.note || "no assessable text colour found in region",
      });
    }
  }

  if (wantColors) {
    measurements.colors = dominantColors(
      pixels,
      region || { left: 0, top: 0, width: meta.width, height: meta.height },
      { top: extra.colorCount ?? 8 },
    );
  }

  if (wantBoxes) {
    if (!boxColor) {
      // Counting boxes without knowing their border colour would be a guess.
      abstained.push({
        question: "box count",
        reason: "box_color not supplied; provide the border colour for a deterministic count",
      });
    } else {
      measurements.boxes = findColorBoxes(pixels, {
        color: boxColor,
        tolerance,
        minArea: extra.minArea ?? 200,
        minWidth: extra.minWidth ?? 40,
        minHeight: extra.minHeight ?? 30,
      });
    }
  }

  if (wantLayout) {
    measurements.layout = {
      width: meta.width,
      height: meta.height,
      aspect_ratio: meta.width && meta.height ? Math.round((meta.width / meta.height) * 100) / 100 : null,
      ...(region ? { region_content: nonBackgroundRatio(pixels, region, { background: backgroundColor || undefined, tolerance }) } : {}),
    };
    if (region) {
      notes.push(
        `Region content: ${measurements.layout.region_content.non_background_ratio}% of pixels differ from the ` +
          `background (${measurements.layout.region_content.background}).`,
      );
    }
  }

  const legibility = await prepareForVision(imageBuffer, { maxDimension: null, floor: DEFAULT_LEGIBILITY_FLOOR });

  return {
    success: true,
    mode,
    region,
    dimensions: { width: meta.width, height: meta.height, format: meta.format },
    measurements,
    notes,
    abstained,
    provenance: buildProvenance({
      model: null,
      options: null,
      imageReport: legibility.report,
      extraWarnings: [
        "All values in measurements were computed by deterministic pixel maths in this server; no language model was involved.",
      ],
      metrics: null,
    }),
    disclaimer:
      "Deterministic measurement. Reproducible without a vision model; results do not depend on model availability.",
  };
}

/**
 * Schema-constrained, cross-validated analysis of an image.
 *
 * @param {object} params
 * @param {Buffer} params.imageBuffer
 * @param {string} [params.prompt]
 * @param {string} params.model
 * @param {string} params.ollamaHost
 * @param {number} [params.timeoutMs]
 * @param {number} [params.seed]
 * @param {number} [params.temperature]
 * @param {number} [params.numPredict]
 * @param {number|string} [params.keepAlive]
 * @param {string} [params.language] OCR language
 * @param {{left:number,top:number,width:number,height:number}} [params.crop]
 * @param {boolean} [params.crossValidate] default true
 * @param {Function} [params.recognizeFn] injectable OCR (tests)
 * @param {(p:object)=>void} [params.onProgress]
 * @returns {Promise<object>}
 */
export async function analyzeStructured(params) {
  const {
    imageBuffer,
    prompt = "",
    model,
    ollamaHost,
    timeoutMs = 180000,
    seed,
    temperature = 0,
    numPredict,
    keepAlive,
    language = "eng",
    crop = null,
    crossValidate = true,
    recognizeFn,
    onProgress,
  } = params;

  // 1. Decide what we were actually asked.
  const question = detectQuantitativeQuestion(prompt);
  const userQuestion = prompt && prompt.trim() ? prompt.trim() : "Describe what is visible in this image.";

  // 1b. Quantitative short-circuit (§5.2 / acceptance test #5): a measurable
  //     question is answered entirely by deterministic pixel maths, with NO
  //     model call at all. This is what makes the guarantee real — the answer
  //     is correct and available even when Ollama is down or contended.
  if (question.quantitative) {
    const measured = await measureImage({
      imageBuffer,
      mode: "all",
      region: crop || null,
    });
    return {
      success: true,
      parsed: true,
      summary: null,
      claims: [],
      unsupported_claims: [],
      text_items: [],
      cross_validation: null,
      measurements: measured.measurements,
      counts: null,
      observations: measured.notes,
      unreadable: [],
      abstained: [
        ...measured.abstained,
        {
          question: userQuestion,
          reason:
            "Quantitative question. Answered by deterministic measurement in code; the vision model was deliberately " +
            "not consulted, so no numeric claim can be fabricated. See measurements.",
        },
      ],
      crop_applied: null,
      answered_by: "deterministic-measurement",
      model_consulted: false,
      matched_signals: question.matched,
      provenance: measured.provenance,
      warnings: measured.provenance.warnings,
    };
  }

  // 2. Physically apply the crop so the model cannot see outside it (fix F3 at
  //    the source, rather than trusting the model to respect instructions).
  let workBuffer = imageBuffer;
  let cropApplied = null;
  if (crop) {
    const cm = await sharp(imageBuffer).metadata();
    const left = Math.max(0, Math.min(cm.width - 1, Math.round(crop.left ?? 0)));
    const top = Math.max(0, Math.min(cm.height - 1, Math.round(crop.top ?? 0)));
    const width = Math.max(1, Math.min(cm.width - left, Math.round(crop.width ?? cm.width)));
    const height = Math.max(1, Math.min(cm.height - top, Math.round(crop.height ?? cm.height)));
    workBuffer = await sharp(imageBuffer).extract({ left, top, width, height }).png().toBuffer();
    cropApplied = { left, top, width, height };
  }

  // 3. Report provenance for exactly what will be sent.
  const prepared = await prepareForVision(workBuffer, { maxDimension: null, floor: DEFAULT_LEGIBILITY_FLOOR });

  // 4. Constrained query.
  const describePrompt = buildDescribePrompt({ question: userQuestion, includeText: true });
  const res = await queryOllamaStructured({
    model,
    prompt: describePrompt,
    images: [prepared.buffer],
    schema: CLAIM_SCHEMA,
    ollamaHost,
    timeoutMs,
    seed,
    temperature,
    numPredict,
    keepAlive,
    onProgress,
  });

  const warnings = [...res.warnings];
  const extraWarnings = [];

  if (!res.ok) {
    warnings.push(
      "The model's response could not be parsed as JSON matching the schema; no claims are reported. " +
        `Extraction strategies attempted: directive parse,  thinking-strip, brace-slice.`,
    );
  }

  const json = res.json || {};
  const claims = Array.isArray(json.claims) ? json.claims : [];
  const textItems = Array.isArray(json.text_items) ? json.text_items : [];
  const abstained = Array.isArray(json.abstained) ? json.abstained : [];

  // 5. Quantitative interception (fix F4): a measurable question must be
  //    answered by code or abstained — never by the model.
  const unsupportedClaims = [];
  let supportedClaims = claims;
  let measurements = null;

  if (question.quantitative) {
    const numericKinds = new Set(["contrast", "count", "color"]);
    supportedClaims = [];
    for (const c of claims) {
      if (numericKinds.has(c?.kind)) unsupportedClaims.push(c);
      else supportedClaims.push(c);
    }

    // Compute what we can, deterministically.
    const pixels = await loadPixels(prepared.buffer);
    const measurementRegion = { left: 0, top: 0, width: prepared.report.sent_dimensions.width, height: prepared.report.sent_dimensions.height };
    measurements = {
      contrast: contrastInRegion(pixels, measurementRegion, { large: false }),
      colors: dominantColors(pixels, measurementRegion, { top: 8 }),
      layout: {
        width: prepared.report.sent_dimensions.width,
        height: prepared.report.sent_dimensions.height,
      },
    };

    const looksLikeContrast = /contrast|wcag|accessib/i.test(prompt);
    abstained.push({
      question: userQuestion,
      reason:
        "This is a quantitative question. Numeric answers are computed deterministically in code, not by the vision model. " +
        (looksLikeContrast
          ? "See measurements.contrast (whole-image figure; pass a region for text-specific contrast)."
          : "See the measurements block."),
    });
    extraWarnings.push(
      `Detected a quantitative question (matched: ${question.matched.join(", ")}). ` +
        `${unsupportedClaims.length} model claim(s) asserting numbers were withheld as unsupported; ` +
        `measurements were computed in code instead.`,
    );
  }

  // 6. Cross-validate transcribed text against OCR (fix F1/F2/F3 signature).
  let crossValidation = null;
  if (crossValidate && (textItems.length > 0 || res.ok)) {
    const vlText = textItems.map((t) => ({ text: t.text, box: t.box, confidence: t.confidence, legible: t.legible }));
    // Boxes from the model refer to the cropped buffer, so containment is
    // validated against the crop's own bounds.
    const containmentCrop = { left: 0, top: 0, width: prepared.report.sent_dimensions.width, height: prepared.report.sent_dimensions.height };
    crossValidation = await crossValidateImage(prepared.buffer, {
      vlText,
      language,
      crop: containmentCrop,
      recognizeFn,
    });
    if (crossValidation.unverified_count > 0) {
      extraWarnings.push(
        `${crossValidation.unverified_count} transcribed string(s) have no OCR support and no plausible box; ` +
          `these are the fabrication signature (see unverified_text).`,
      );
    }
  }

  const modelUnreadable = Array.isArray(json.unreadable) ? json.unreadable : [];

  // §3.5: unreadable[] previously mixed model excuses with genuine
  // unreadability. Each entry now carries its source so a consumer can weigh
  // it, and a claim is flagged contested when OCR *did* read text the model
  // said was unreadable (observed on the fixture: "too small to read" while
  // Tesseract read four labels at 91-96% confidence).
  const ocrWords = crossValidation
    ? [
        ...(crossValidation.items || []).filter((i) => i.ocr_match),
        ...(crossValidation.ocr_only || []).map((o) => ({ text: o.text, confidence_percent: o.confidence })),
      ]
    : [];

  const unreadable = modelUnreadable.map((u) => {
    const text = typeof u === "string" ? u : (u?.text ?? String(u));
    const entry = {
      text,
      source: "model",
      basis: "vision-model-claim",
      verified: false,
      note: "Reported as unreadable by the vision model. This is a model claim, not a measurement.",
    };

    // Two kinds of contradiction, both surfaced (never silently swallowed):
    //  - precise:  the claimed-unreadable text is found by OCR
    //  - blanket:  a generic "too small/blurry to read" claim with no
    //              identifiable text, while OCR did read strings in the image.
    //              Observed on the fixture: "The text is too small to read."
    //              while Tesseract read four labels at 91-96% confidence.
    const precise = ocrWords.filter((w) => w.text && textMatchLoose(text, w.text));
    const namesSomething = /\b[A-Za-z0-9]{3,}\b/.test(text) &&
      ocrWords.some((w) => w.text && textMatchLoose(text, w.text));
    const generic = /too small|unreadable|can ?not read|cannot read|blurry|illegible|not legible|hard to read|difficult to read/i.test(text);

    if (precise.length > 0) {
      entry.contested = true;
      entry.contest_type = "precise";
      entry.contested_by = precise.map((w) => ({
        text: w.text,
        confidence_percent: w.confidence_percent ?? null,
      }));
      entry.note =
        "The model reported this as unreadable, but Tesseract OCR read corresponding text. " +
        "Prefer the OCR evidence over the model's claim.";
    } else if (generic && !namesSomething && ocrWords.length > 0) {
      entry.contested = true;
      entry.contest_type = "blanket";
      entry.contested_by = ocrWords.slice(0, 12).map((w) => ({
        text: w.text,
        confidence_percent: w.confidence_percent ?? null,
      }));
      entry.note =
        "Generic unreadability claim (no specific text named) while Tesseract OCR successfully read " +
        `${ocrWords.length} string(s) in the same image. Treat the model's claim as overstated and ` +
        "prefer the OCR evidence.";
    }
    return entry;
  });

  if (unreadable.some((u) => u.contested)) {
    extraWarnings.push(
      `${unreadable.filter((u) => u.contested).length} 'unreadable' claim(s) are contradicted by OCR evidence ` +
        `(the model said unreadable, OCR read text). See unreadable[].contested_by.`,
    );
  }

  return {
    success: true,
    parsed: res.ok,
    summary: json.summary || null,
    claims: supportedClaims.map((c) => ({
      ...c,
      source: "vl",
      verified: false,
      // A claim that survives the quantitative filter is still a model claim;
      // mark it as such so downstream code never treats it as measured fact.
      basis: "vision-model-observation",
    })),
    unsupported_claims: unsupportedClaims,
    text_items: crossValidation
      ? crossValidation.items
      : textItems.map((t) => ({
          text: t.text,
          box: t.box ?? null,
          source: "vl",
          confidence: typeof t.confidence === "number" ? t.confidence : null,
          verified: false,
          reported_by_model: true,
        })),
    cross_validation: crossValidation
      ? {
          agreement_rate: crossValidation.agreement_rate,
          unverified_text: crossValidation.unverified_text,
          unverified_count: crossValidation.unverified_count,
          ocr_only: crossValidation.ocr_only,
          ocr_only_count: crossValidation.ocr_only_count,
          ocr_word_count: crossValidation.ocr_word_count,
          ocr_error: crossValidation.ocr_error || null,
          text_items_count: crossValidation.items?.length ?? 0,
          text_items_sources: [...new Set((crossValidation.items || []).map((i) => i.source))],
        }
      : null,
    measurements,
    counts: json.counts || null,
    observations: Array.isArray(json.observations) ? json.observations : [],
    unreadable,
    abstained,
    crop_applied: cropApplied,
    raw_model_output: res.ok ? undefined : res.raw,
    provenance: buildProvenance({
      model,
      options: res.request?.options,
      imageReport: prepared.report,
      extraWarnings,
      ocr: crossValidation,
      request: res.request,
      metrics: res.metrics,
    }),
    warnings: [...warnings, ...extraWarnings],
  };
}

export const _internals = { measureImage, analyzeStructured };
