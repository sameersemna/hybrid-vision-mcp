// Single source of truth for the "no exposed field classifies decoration vs text"
// prose guard (F16/F17/F18/F19).
//
// HISTORY — four rounds, each of which found the previous rule too weak:
//   F16 (14th): no guard; the classification claim lived in the prose.
//   F17 (15th): a phrase guard existed but caught only the LITERAL wording (1/9
//               paraphrases); its exculpatory list was LINE-scoped, so a genuine claim
//               was excused by any stray word (`not decoration`, `large from small`).
//   F18 (16th): that was fixed with free-text waiver tokens ([PARAPHRASE],
//               "not a claim of this document") — which reintroduced the SAME defect
//               (a keyword used as a retraction scope): a trailing `[PARAPHRASE]` on a
//               live claim escaped it. Also, `amended`/`removed`/`invert`/`coincidence`
//               still waived real claims inside the clause.
//   F19 (16th): the field anchor listed 5 names while the entry emits 9, so a claim
//               naming an unlisted field was a blind spot by construction.
//
// MEASURED design (0 false positives on ~2000 real doc lines; 16/17 paraphrases caught):
//   - negation must be ADJACENT to the verb or object it negates (~25 chars before),
//     never "somewhere in the clause" — this is what closes the E1-E6 class;
//   - exclusions are STRUCTURAL (a marker at the start of the line), never a keyword —
//     this is what closes the trailing-token escape;
//   - the field anchor covers EVERY emitted disclosure key, asserted by a test.

/** Classification verbs. */
export const CLAIM_VERB = /(orders|order|distinguishes|distinguish|separates|separate|classifies|classify|tells? (?:apart|what is)|identif(?:y|ies)|filter(?:s)? out|pick(?:s)? out|labels?|sorts?|ranks?|routes?|recommends?)/i;

/** Objects a classification claim ranges over (the two classes). */
export const CLAIM_OBJECT = /(decoration|decorations|chart furniture|furniture|ornament|non-?text|not text|glyph|glyphs|copy|panel|text)/i;

/** Every key `mask_reconciliation.unmasked_failing_colours[]` emits. A test asserts
 *  FIELD covers all of these, so a newly added field cannot silently become a blind
 *  spot (F19). Keep in sync with lib/measure.js. */
export const EMITTED_DISCLOSURE_KEYS = [
  "foreground", "contrast_ratio", "pixel_count", "component_count", "mean_component_area",
  "detected_plateau", "plateau_share", "largest_component_share", "measured_against",
];

/** Field anchor = every emitted key except the two non-numeric/obvious ones is still a
 *  "field name" a claim could name; include them all so coverage is total. */
export const CLAIM_FIELD = new RegExp(`(${EMITTED_DISCLOSURE_KEYS.join("|")})`, "i");

/** A negation that NEGATES the token it precedes (checked ~25 chars before). */
const NEG_ADJACENT = /(\bnot\b|\bno\b|\bnever\b|\bnone\b|\bneither\b|\bcannot\b|\bcan't\b|\bwithout\b|\binstead\b|\brather than\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bno longer\b)/i;

/** Structural exclusion: a [REMOVED CLAIM]/[PARAPHRASE] marker at the START of the line
 *  or of a table cell. A TRAILING marker does not qualify — that is F18's fix. Implemented
 *  by splitting on table pipes and testing each cell's start, which also avoids the bug
 *  where a regex cell-prefix greedily ate a marker in the first cell. */
const MARKER = /^\s*(?:[-*>#]\s*)*(?:\*\*|__|`)*\s*\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\]/i;
export function hasStructuralMarker(line) {
  return line.split("|").some((cell) => MARKER.test(cell));
}

/**
 * Does a single CLAUSE assert that a field classifies decoration vs text?
 * A clause carrying field+verb+object is a claim UNLESS a negation immediately
 * precedes the verb or the object it would negate.
 */
export function clauseIsClaim(clause) {
  if (!CLAIM_FIELD.test(clause) || !CLAIM_VERB.test(clause) || !CLAIM_OBJECT.test(clause)) return false;
  const verbRe = new RegExp(CLAIM_VERB.source, "ig");
  let m;
  while ((m = verbRe.exec(clause))) {
    const before = clause.slice(Math.max(0, m.index - 25), m.index);
    if (!NEG_ADJACENT.test(before)) return true; // an un-negated classification verb
  }
  return false;
}

/**
 * Flag a line as a live classification claim.
 * Clause-scoped on [;,:] — NEVER on "." (file paths like lib/measure.js and decimals
 * like 0.0986 contain periods, which in F17 tore a retraction marker from its claim).
 */
export function flagsClassificationClaim(line) {
  if (hasStructuralMarker(line)) return false;
  return line.split(/[;,:]/).some(clauseIsClaim);
}

/** Scan text, returning `{ n, line }` for every flagged line. */
export function scanForClassificationClaims(text) {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => flagsClassificationClaim(line));
}

/** The explicit disclaimer the docs must CARRY (the paraphrase-proof structural half). */
export const DISCLAIMER = /not decoration from text|none of (these|them) distinguishes decoration|does not distinguish decoration/i;
export const normalizeForDisclaimer = (s) => s.replace(/[*`_]/g, "").replace(/\s+/g, " ");
