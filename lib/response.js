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
    text = serialize({
      success: value.success === true,
      _truncation: {
        truncated: true,
        max_chars: maxChars,
        actions,
        note: "Response was too large to return even after trimming; only the envelope is included.",
      },
    });
  }
  return text;
}
