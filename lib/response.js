// ==========================================
// Client-facing response truncation.
// ==========================================
// These helpers cap how much text is returned to a client. They live in their
// own module so they can be unit-tested directly (index.js is a server
// entrypoint with no exports).
//
// Background: the original single helper sliced strings at a fixed character
// count. That is fine for prose, but for a JSON payload it cut mid-token and
// produced output that could not be parsed — observed live when a structured
// analysis response exceeded the cap. `truncateJsonForClient` exists so a
// structured response always remains valid JSON.

export const DEFAULT_MAX_RESPONSE_TEXT_CHARS = 12000;

/**
 * Truncate free text at a character limit, appending a visible marker.
 * Appropriate for prose responses (OCR output, model descriptions).
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateForClient(text, maxChars = DEFAULT_MAX_RESPONSE_TEXT_CHARS) {
  if (typeof text !== "string") return text;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated for client context limits]`;
}

/**
 * Truncate a JSON-serialisable value while guaranteeing the result is VALID
 * JSON (or, in the worst case, a small valid object explaining why).
 *
 * Strategy, in order:
 *   1. Do nothing if it already fits.
 *   2. Shorten the largest string fields (keeps every key and array length).
 *   3. Drop items from the longest arrays (keeps the document well-formed).
 *   4. Last resort: return a minimal valid envelope — never a partial token.
 *
 * A `_truncation` block records exactly what was done, so a caller can tell an
 * incomplete list from a complete one. Space for that block is reserved up
 * front; otherwise the payload is trimmed to the limit and then pushed back
 * over it by the metadata (a bug this reserve specifically prevents).
 *
 * @param {any} value
 * @param {number} [maxChars]
 * @returns {string} valid JSON
 */
export function truncateJsonForClient(value, maxChars = DEFAULT_MAX_RESPONSE_TEXT_CHARS) {
  const serialize = (v) => JSON.stringify(v, null, 2);
  if (serialize(value).length <= maxChars) return serialize(value);

  // Round 33 (F41): before mutating anything, try the COMPACT form of the SAME value. The cap
  // protects the client's context, not indentation; 2-space pretty-printing is 30-45% larger than
  // compact. Measured: the photographic fixture is 13,969 chars pretty but 9,660 compact — inside
  // the cap, with every colour and the full disclosure block intact. This keeps the response
  // COMPLETE rather than degrading it, and it is measured on the untouched value, so no field is
  // silently altered without a `_truncation` record.
  const compactFull = JSON.stringify(value);
  if (compactFull.length <= maxChars) return compactFull;

  const TRUNCATION_RESERVE = 800;
  const budget = Math.max(1024, maxChars - TRUNCATION_RESERVE);
  const actions = [];

  // Phase 1: shorten the largest string fields.
  const strings = [];
  const walkStrings = (node, pathLabel) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        if (typeof child === "string" && child.length > 256) {
          strings.push({ length: child.length, path: `${pathLabel}[${i}]`, set: (nv) => { node[i] = nv; } });
        } else {
          walkStrings(child, `${pathLabel}[${i}]`);
        }
      });
      return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === "string" && child.length > 256) {
        strings.push({ length: child.length, path: `${pathLabel}.${key}`, set: (nv) => { node[key] = nv; } });
      } else {
        walkStrings(child, `${pathLabel}.${key}`);
      }
    }
  };
  walkStrings(value, "$");
  strings.sort((a, b) => b.length - a.length);
  for (const s of strings) {
    if (serialize(value).length <= budget) break;
    s.set(`…[truncated ${s.length} chars to keep this response valid JSON]`);
    actions.push({ action: "shortened_string", path: s.path, original_chars: s.length });
  }

  // Phase 2: drop items from the longest arrays.
  let guard = 0;
  while (serialize(value).length > budget && guard++ < 64) {
    const arrays = [];
    const walkArrays = (node, pathLabel) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (node.length > 1) arrays.push({ length: node.length, path: pathLabel, node });
        node.forEach((child, i) => walkArrays(child, `${pathLabel}[${i}]`));
        return;
      }
      for (const key of Object.keys(node)) walkArrays(node[key], `${pathLabel}.${key}`);
    };
    walkArrays(value, "$");
    if (arrays.length === 0) break;

    arrays.sort((a, b) => b.length - a.length);
    const target = arrays[0];
    const was = target.node.length;
    let removed = 0;
    while (target.node.length > 1 && serialize(value).length > budget) {
      target.node.pop();
      removed++;
    }
    actions.push({ action: "dropped_array_items", path: target.path, dropped: removed, remaining: target.node.length, was });
    if (removed === 0) break;
  }

  value._truncation = {
    truncated: true,
    max_chars: maxChars,
    actions,
    note:
      "The response exceeded the client text limit. Large string fields were shortened and/or long " +
      "arrays were trimmed to keep this a VALID JSON document; treat trimmed lists as incomplete.",
  };

  let text = serialize(value);
  if (text.length > maxChars) {
    // LAST RESORT (round 33, F41). The previous fallback returned `{ success, _truncation }` — it
    // reported `success: true` with the VERDICT REMOVED. A caller reads a success envelope, finds
    // no `measurements`, and cannot tell an unmeasured result from a broken one. Measured live:
    // the photographic fixture came back as an envelope with no `measurements`, which crashed the
    // standing live harness.
    //
    // Keep the VERDICT SKELETON instead: the scalar fields a caller acts on (the verdict, the
    // worst/best ratio, the counts) and the disclosure block, with the bulky per-colour detail
    // dropped. Valid JSON, honest (`_truncation` says what was dropped), and it never pretends a
    // measurement succeeded while withholding the answer.
    const skeleton = buildVerdictSkeleton(value);
    skeleton._truncation = {
      truncated: true,
      max_chars: maxChars,
      actions,
      note:
        "The response exceeded the client text limit even after shortening strings and trimming arrays, " +
        "so it was reduced to the VERDICT SKELETON: the verdict, worst/best ratio, counts, and disclosure " +
        "block are present, but per-colour detail (`colours`, `excluded`, `skipped`, `suspected_noise`, " +
        "`background_regions`, `panel_fills`) was dropped. Treat dropped lists as incomplete.",
    };
    text = serialize(skeleton);
    if (text.length > maxChars) {
      // Even the skeleton is too big: return the minimal envelope, but make `success` HONEST — do
      // NOT claim a successful full measurement when the answer is absent.
      text = serialize({
        success: false,
        _truncation: {
          truncated: true,
          max_chars: maxChars,
          actions,
          note: "Response was too large to return even after trimming to the verdict skeleton; only the envelope is included. The measurement did NOT return a verdict.",
        },
      });
    }
  }
  return text;
}

/**
 * Reduce a measurement response to its VERDICT SKELETON: the scalar fields a caller acts on, plus
 * the disclosure block — never a bare envelope that reports success with the answer removed.
 *
 * @param {any} value
 * @returns {any}
 */
function buildVerdictSkeleton(value) {
  if (!value || typeof value !== "object") return value;
  const c = value.measurements?.contrast;
  const out = {
    success: value.success === true,
    truncated_to: "verdict_skeleton",
  };
  if (value.mode !== undefined) out.mode = value.mode;
  if (value.region !== undefined) out.region = value.region;
  if (value.dimensions !== undefined) out.dimensions = value.dimensions;
  if (c) {
    out.measurements = {
      contrast: {
        verdict: c.verdict,
        all_meet_aa: c.all_meet_aa,
        wcag_aa: c.wcag_aa,
        measurable: c.measurable,
        failing_count: c.failing_count,
        passing_count: c.passing_count,
        evaluated_count: c.evaluated_count,
        worst: c.worst,
        best: c.best,
        cluster_tolerance: c.cluster_tolerance,
        background_mode: c.background_mode,
        // The disclosure block is the CONTRACT here — keep it, even though it is the biggest
        // scalar block, because a verdict without its scope is the thing this project forbids.
        notes: c.notes,
        model_disagreement: c.model_disagreement,
        background_fit: c.background_fit,
        colours: [], // dropped here (the bulky part); _truncation records it
        excluded: [], skipped: [], suspected_noise: [], background_regions: [], panel_fills: [],
      },
    };
  }
  if (value.notes !== undefined) out.notes = value.notes;
  if (value.abstained !== undefined) out.abstained = value.abstained;
  if (value.disclaimer !== undefined) out.disclaimer = value.disclaimer;
  return out;
}
