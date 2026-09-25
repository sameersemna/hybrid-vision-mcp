// ==========================================
// Legibility floor, scaling transparency, provenance.
// ==========================================
// §5.4: never silently downscale. §5.7: always report provenance.
//
// The old server never resized anything and never said what it sent, so a
// caller could not tell whether the model actually saw 1920px or a 336px
// internal reduction. Nothing here changes what the model sees by default —
// it only stops the server from being *silent* about dimensions, and gives an
// explicit, reported downscale path plus a legibility floor below which text
// claims are not trustworthy.

import sharp from "sharp";
import crypto from "node:crypto";

/** Default floor for short-side pixels below which small text is unreliable. */
export const DEFAULT_LEGIBILITY_FLOOR = {
  min_short_side: 256,
  min_total_pixels: 65536, // 256x256
  min_text_height_px: 12,
};

/**
 * Decide whether an image is above the legibility floor.
 * @param {number} width
 * @param {number} height
 * @param {object} [floor]
 */
export function assessLegibility(width, height, floor = DEFAULT_LEGIBILITY_FLOOR) {
  const shortSide = Math.min(width, height);
  const totalPixels = width * height;
  const warnings = [];

  const tooSmallBoth = shortSide < floor.min_short_side;
  const tooFewPixels = totalPixels < floor.min_total_pixels;

  if (tooSmallBoth) {
    warnings.push(
      `Short side is ${shortSide}px, below the ${floor.min_short_side}px legibility floor. ` +
        `Text transcription from this image is unreliable; a vision model may also reduce it internally.`,
    );
  }
  if (tooFewPixels) {
    warnings.push(
      `Total pixels ${totalPixels} are below the ${floor.min_total_pixels} floor. Detail-level claims are unreliable.`,
    );
  }

  return {
    width,
    height,
    short_side: shortSide,
    total_pixels: totalPixels,
    floor,
    legible: !tooSmallBoth && !tooFewPixels,
    warnings,
    recommendation: tooSmallBoth || tooFewPixels
      ? "Re-capture at a higher resolution, or pass a crop of the region of interest, before trusting text or fine detail."
      : null,
  };
}

/**
 * Prepare an image for sending to the vision model, reporting exactly what
 * will be sent. By default (`maxDimension: null`) no resize occurs and the
 * sent dimensions equal the input dimensions — this preserves existing
 * behaviour and simply makes it observable.
 *
 * @param {Buffer} buffer PNG/JPEG input
 * @param {{ maxDimension?: number|null, floor?: object }} [opts]
 */
export async function prepareForVision(buffer, opts = {}) {
  const { maxDimension = null, floor = DEFAULT_LEGIBILITY_FLOOR } = opts;
  const meta = await sharp(buffer).metadata();
  const inputWidth = meta.width;
  const inputHeight = meta.height;

  let outBuffer = buffer;
  let sentWidth = inputWidth;
  let sentHeight = inputHeight;
  let downscaled = false;
  let scaleFactor = 1;
  const warnings = [];

  if (maxDimension && (inputWidth > maxDimension || inputHeight > maxDimension)) {
    const resized = await sharp(buffer)
      .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const rmeta = await sharp(resized).metadata();
    outBuffer = resized;
    sentWidth = rmeta.width;
    sentHeight = rmeta.height;
    downscaled = true;
    scaleFactor = sentWidth / inputWidth;
    warnings.push(
      `Image downscaled from ${inputWidth}x${inputHeight} to ${sentWidth}x${sentHeight} ` +
        `(scale ${scaleFactor.toFixed(3)}) to respect maxDimension=${maxDimension}. ` +
        `Box coordinates from the model refer to the ${sentWidth}x${sentHeight} space — scale by ` +
        `${(1 / (scaleFactor || 1)).toFixed(3)} to map back to the original.`,
    );
  }

  const legibility = assessLegibility(sentWidth, sentHeight, floor);
  warnings.push(...legibility.warnings);

  // Independent of what we send, the model may reduce internally. Say so.
  const modelInternalNote =
    "Vision models commonly resize internally (e.g. to a ~336-448px short side); " +
    "transcription of small text can degrade regardless of the dimensions sent.";

  return {
    buffer: outBuffer,
    report: {
      input_dimensions: { width: inputWidth, height: inputHeight },
      sent_dimensions: { width: sentWidth, height: sentHeight },
      downscaled,
      scale_factor: scaleFactor,
      coordinate_space: "sent_dimensions",
      legibility,
      model_internal_resize_note: modelInternalNote,
      warnings,
    },
  };
}

/**
 * Split an image into a grid of overlapping tiles.
 * Used when an image is below the legibility floor and the caller explicitly
 * opts into tiling, rather than silently trusting a too-small image.
 *
 * @param {Buffer} buffer
 * @param {{ cols?: number, rows?: number, overlap?: number }} [opts]
 * @returns {Promise<{ tiles: Array<{buffer:Buffer, left:number, top:number, width:number, height:number}>, cols:number, rows:number }>}
 */
export async function tileImage(buffer, opts = {}) {
  const meta = await sharp(buffer).metadata();
  const cols = Math.max(1, opts.cols ?? 2);
  const rows = Math.max(1, opts.rows ?? 2);
  const overlap = Math.max(0, Math.min(0.5, opts.overlap ?? 0.1));

  const tileWidth = Math.ceil(meta.width / cols);
  const tileHeight = Math.ceil(meta.height / rows);
  const padX = Math.round(tileWidth * overlap);
  const padY = Math.round(tileHeight * overlap);

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = Math.max(0, col * tileWidth - padX);
      const top = Math.max(0, row * tileHeight - padY);
      const width = Math.min(meta.width - left, tileWidth + padX * 2);
      const height = Math.min(meta.height - top, tileHeight + padY * 2);
      if (width <= 0 || height <= 0) continue;
      const tileBuf = await sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
      tiles.push({ buffer: tileBuf, left, top, width, height });
    }
  }
  return { tiles, cols, rows };
}

/**
 * Shift a box from tile-local coordinates into full-image coordinates.
 * @param {{left:number,top:number,width:number,height:number}} box
 * @param {{left:number,top:number}} offset
 */
export function offsetBox(box, offset) {
  if (!box) return box;
  return {
    left: box.left + offset.left,
    top: box.top + offset.top,
    width: box.width,
    height: box.height,
  };
}

/**
 * Assemble the provenance block attached to every new structured response.
 * @param {object} params
 */
export function buildProvenance({ model, options, imageReport, extraWarnings = [], ocr = null, request = null, metrics = null }) {
  const warnings = [...(imageReport?.warnings || []), ...extraWarnings];
  return {
    model: model ?? null,
    options: options ?? null,
    request: request ?? null,
    image: imageReport
      ? {
          input_dimensions: imageReport.input_dimensions,
          sent_dimensions: imageReport.sent_dimensions,
          downscaled: imageReport.downscaled,
          scale_factor: imageReport.scale_factor,
          coordinate_space: imageReport.coordinate_space,
          legibility: imageReport.legibility,
        }
      : null,
    ocr: ocr ? { used: true, word_count: ocr.ocr_word_count ?? null, confidence: ocr.ocr_confidence ?? null } : { used: false },
    metrics: metrics ?? null,
    warnings,
  };
}

/**
 * Write a buffer to disk and return the path (mirrors existing feedback-dir
 * behaviour for large payloads).
 */
export async function writeFeedbackFile(dir, buffer, suffix = "") {
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  fsMod.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID()}${suffix}.png`;
  const full = pathMod.join(dir, name);
  fsMod.writeFileSync(full, buffer);
  return full;
}
