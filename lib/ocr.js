// ==========================================
// Tesseract OCR with word-level bounding boxes.
// ==========================================
// The server already depends on Tesseract for `fast_ocr_tesseract`, and the
// task explicitly states that tool is correct. Here we use the *same* engine
// in a different role: as an independent second opinion on what text is
// actually present, so a vision model's transcription can be cross-checked
// against something that cannot hallucinate.
//
// `recognizeFn` is injectable so the cross-validation logic can be unit-tested
// deterministically, without a real OCR run.

import Tesseract from "tesseract.js";

/**
 * Flatten Tesseract's nested blocks structure into a flat list of words.
 * Defensive: the shape varies between runs and empty pages yield nulls.
 * @param {any} data
 * @returns {Array<{ text: string, confidence: number, bbox: {left:number,top:number,width:number,height:number}, line: string }>}
 */
export function flattenWords(data) {
  const words = [];
  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const lineText = (line?.text || "").replace(/\s+/g, " ").trim();
        for (const word of line?.words || []) {
          const bbox = word?.bbox;
          if (!bbox) continue;
          const text = (word.text || "").trim();
          if (!text) continue;
          words.push({
            text,
            confidence: typeof word.confidence === "number" ? word.confidence : 0,
            bbox: {
              left: bbox.x0,
              top: bbox.y0,
              width: Math.max(0, bbox.x1 - bbox.x0),
              height: Math.max(0, bbox.y1 - bbox.y0),
            },
            line: lineText,
          });
        }
      }
    }
  }
  return words;
}

/**
 * Run OCR and return both the flat text and per-word boxes.
 * @param {Buffer} imageBuffer
 * @param {string} [language]
 * @param {{ recognizeFn?: Function }} [opts]
 * @returns {Promise<{ text: string, confidence: number, words: Array<object>, blocks: any }>}
 */
export async function runOcrWithBoxes(imageBuffer, language = "eng", opts = {}) {
  if (typeof opts.recognizeFn === "function") {
    const res = await opts.recognizeFn(imageBuffer, language);
    const data = res?.data ?? res;
    return {
      text: data?.text || "",
      confidence: typeof data?.confidence === "number" ? data.confidence : 0,
      words: flattenWords(data),
      blocks: data?.blocks ?? null,
    };
  }

  // Use a worker so we can request the `blocks` output format; the top-level
  // Tesseract.recognize() convenience wrapper does not expose that cleanly.
  let worker;
  try {
    worker = await Tesseract.createWorker(language);
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true, text: true });
    return {
      text: data?.text || "",
      confidence: typeof data?.confidence === "number" ? data.confidence : 0,
      words: flattenWords(data),
      blocks: data?.blocks ?? null,
    };
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
  }
}
