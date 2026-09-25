// ==========================================
// Cross-validation: vision-model text vs OCR text.
// ==========================================
// This is the single highest-value change in the hardening. Before it, a
// fabricated string (F1's invented arrow glyphs, F2's phantom "st", F3's
// out-of-crop tab text) was indistinguishable from a real one — it looked the
// same as truth in the response payload.
//
// After it, every transcribed string must earn one of these states:
//
//   vl+ocr  -> the vision model and Tesseract agree      => confidence raised
//   ocr      -> only Tesseract saw it                    => OCR preferred for exact text
//   vl       -> only the vision model saw it             => confidence lowered + warning
//   unverified_text -> no OCR support AND no plausible box => explicitly flagged
//
// "No OCR support and no plausible box" is precisely the F1/F2/F3 signature.

import { runOcrWithBoxes } from "./ocr.js";
import { isBoxInsideCrop } from "./measure.js";

/**
 * Normalise a string for comparison: lowercase, strip everything that is not
 * a letter or digit. So "CHARLIE-THREE-8g7x2" == "charlie three 8g7x2".
 * @param {string} s
 */
export function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Compare two normalised strings, treating one containing the other as a
 * partial match (Tesseract often splits hyphenated tokens into words).
 * @param {string} a
 * @param {string} b
 * @returns {{ matched: boolean, exact: boolean, partial: boolean }}
 */
export function textMatch(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return { matched: false, exact: false, partial: false };
  if (na === nb) return { matched: true, exact: true, partial: false };
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
    return { matched: true, exact: false, partial: true };
  }
  return { matched: false, exact: false, partial: false };
}

/**
 * Find the best OCR support for a claimed string.
 * @param {string} text
 * @param {Array<{text:string, confidence:number, bbox:object, line?:string}>} words
 * @param {string} [fullText]
 */
export function findOcrSupport(text, words = [], fullText = "") {
  // 1. Exact/partial word match.
  for (const w of words) {
    const m = textMatch(text, w.text);
    if (m.matched) {
      return { word: w, match: m.exact ? "exact" : "partial", confidence: w.confidence };
    }
  }
  // 2. Compare against the whole normalised OCR blob (handles multi-word claims).
  const nt = normalizeText(text);
  const nFull = normalizeText(fullText);
  if (nt.length >= 4 && nFull.includes(nt)) {
    return { word: null, match: "fulltext", confidence: null };
  }
  return null;
}

/**
 * Cross-validate a set of vision-model text items against an OCR pass.
 *
 * @param {object} params
 * @param {Array<{text:string, box?:object, confidence?:number}>} params.vlText
 * @param {Array<object>} params.ocrWords
 * @param {string} [params.ocrText]
 * @param {{left:number,top:number,width:number,height:number}} [params.crop]
 * @returns {object}
 */
export function crossValidateText({ vlText = [], ocrWords = [], ocrText = "", crop = null }) {
  const items = [];
  const unverifiedText = [];
  const disagreements = [];

  for (const item of vlText) {
    const text = String(item?.text ?? "").trim();
    if (!text) continue;

    const box = item?.box || null;
    const baseConfidence = typeof item?.confidence === "number" ? item.confidence : 0.5;
    const flags = [];

    // Crop plausibility: if a crop was supplied, the claim must land inside it.
    let inCrop = null;
    if (crop && box) {
      const containment = isBoxInsideCrop(crop, box, { minOverlap: 0.5 });
      inCrop = containment.inside;
      if (!containment.inside) {
        flags.push("outside_crop");
      }
    }

    const support = findOcrSupport(text, ocrWords, ocrText);
    let source;
    let confidence;
    let verified;

    if (support) {
      source = "vl+ocr";
      confidence = Math.min(1, Math.max(baseConfidence, 0.5) + 0.25);
      verified = true;
    } else {
      // No OCR support. A plausible, in-crop box can still substantiate the
      // claim, but at reduced confidence and clearly marked as single-source.
      const plausibleBox =
        !!box &&
        Number.isFinite(box.width) &&
        Number.isFinite(box.height) &&
        box.width > 0 &&
        box.height > 0 &&
        (inCrop === null || inCrop === true);

      if (plausibleBox) {
        source = "vl";
        confidence = Math.max(0.1, baseConfidence * 0.5);
        verified = false;
        flags.push("single_source_unverified");
      } else {
        source = "unverified";
        confidence = Math.max(0.05, baseConfidence * 0.25);
        verified = false;
        flags.push("no_ocr_support");
        flags.push("no_plausible_box");
      }
    }

    if (item.legible === false) flags.push("model_marked_illegible");

    const entry = {
      text,
      box,
      source,
      confidence: Math.round(confidence * 100) / 100,
      original_confidence: baseConfidence,
      verified,
      ocr_match: support ? { match: support.match, word: support.word?.text ?? null, confidence: support.confidence } : null,
      in_crop: inCrop,
      flags,
    };
    items.push(entry);

    if (source === "unverified") {
      unverifiedText.push(entry);
    }
  }

  // OCR-only strings: text Tesseract found that the VL model never mentioned.
  // These are lower-risk (OCR does not hallucinate) but worth surfacing.
  const ocrOnly = [];
  for (const w of ocrWords) {
    if (!w.text || normalizeText(w.text).length < 3) continue;
    const seen = items.some((it) => textMatch(it.text, w.text).matched);
    if (!seen) {
      ocrOnly.push({ text: w.text, bbox: w.bbox, confidence: w.confidence });
    }
  }

  // Consistency (§3.5): `items` (surfaced as `text_items`) must include the
  // OCR-only strings. Previously text_items was populated solely from model
  // output, so a consumer iterating text_items saw nothing while ocr_only was
  // full. OCR is the more trustworthy source, so it now appears in both.
  for (const o of ocrOnly) {
    items.push({
      text: o.text,
      box: o.bbox
        ? { left: o.bbox.left, top: o.bbox.top, width: o.bbox.width, height: o.bbox.height }
        : null,
      source: "ocr",
      confidence: typeof o.confidence === "number" ? Math.round((o.confidence / 100) * 100) / 100 : null,
      confidence_percent: o.confidence ?? null,
      original_confidence: null,
      verified: true,
      ocr_match: { match: "exact", word: o.text, confidence: o.confidence ?? null },
      in_crop: null,
      flags: ["ocr_only_not_reported_by_model"],
      reported_by_model: false,
    });
  }

  const supported = items.filter((i) => i.verified).length;
  const total = items.length;

  return {
    items,
    unverified_text: unverifiedText,
    unverified_count: unverifiedText.length,
    ocr_only: ocrOnly,
    ocr_only_count: ocrOnly.length,
    disagreements,
    agreement_rate: total ? Math.round((supported / total) * 100) / 100 : null,
    ocr_word_count: ocrWords.length,
  };
}

/**
 * Full pipeline: run OCR, then cross-validate. Kept separate from the pure
 * reconciliation function so the latter can be tested without OCR.
 * @param {Buffer} imageBuffer
 * @param {object} params
 */
export async function crossValidateImage(imageBuffer, params = {}) {
  const { vlText = [], language = "eng", crop = null, recognizeFn } = params;
  let ocr;
  try {
    ocr = await runOcrWithBoxes(imageBuffer, language, { recognizeFn });
  } catch (err) {
    return {
      ...crossValidateText({ vlText, ocrWords: [], ocrText: "", crop }),
      ocr_error: err.message,
    };
  }
  return {
    ...crossValidateText({ vlText, ocrWords: ocr.words, ocrText: ocr.text, crop }),
    ocr_text: ocr.text,
    ocr_confidence: ocr.confidence,
  };
}

export const _internals = { findOcrSupport };
