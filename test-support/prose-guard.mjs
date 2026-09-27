// Single source of truth for the "no exposed field classifies decoration vs text"
// prose guard (F16-F21).
//
// HISTORY — six rounds, each of which found the previous rule too weak. The recurring
// class: an AUTHOR-AUTHORED TOKEN whose mere presence suppresses reporting. Every round
// narrowed the token's SCOPE but left its KIND, and a new phrasing then escaped:
//   F16 (14th): no guard; the classification claim lived in the prose.
//   F17 (15th): a phrase guard existed but caught only the LITERAL wording (1/9
//               paraphrases); its exculpatory list was LINE-scoped.
//   F18 (16th): fixed with free-text waiver tokens ([PARAPHRASE], "not a claim of this
//               document") — reintroducing the SAME defect: a trailing token waived any
//               claim; and `amended`/`removed`/`invert`/`coincidence` still waived real
//               claims inside the clause.
//   F19 (16th): the field anchor listed 5 names while the entry emits 9.
//   F20 (17th): the verb-adjacent window (25 chars) admitted ORDINARY words — `no doubt`,
//               `instead` as an adverb — so natural phrasing waived a claim.
//   F21 (17th): a structural marker in ONE table cell waived a claim in ANOTHER cell
//               (`hasStructuralMarker` was line-wide).
//
// MEASURED design (0 false positives on ~2000 real doc lines):
//   - negation is TWO-TIER: strong negations anywhere in a 25-char window before the
//     verb; ambiguous `not`/`no` ONLY when immediately before the verb (<=6 chars),
//     which alone closes the idiom cases (`no doubt`, `instead`) — a separate idiom list
//     was measured redundant (0/20526 clauses);
//   - exclusions are STRUCTURAL and PER-CELL: a marker waives only the cell it starts;
//   - the field anchor covers EVERY emitted disclosure key, asserted by a test.
//
// HONEST SCOPE (F17/F18/F20): this is a BEST-EFFORT LINT with measured recall, NOT a
// barrier. The two-tier negation is BOUNDED, not complete (measured: a negation more than
// 25 chars from the verb is missed — `Not for a moment does plateau_share order ...`
// escapes). The paraphrase-proof part is the POSITIVE disclaimer assertion (`DISCLAIMER`).

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

/** Field anchor = every emitted key a claim could name. */
export const CLAIM_FIELD = new RegExp(`(${EMITTED_DISCLOSURE_KEYS.join("|")})`, "i");

/** Strong negations that unambiguously negate the verb they precede (F20 tier 1). */
const NEG_STRONG = /(\bnever\b|\bnone of\b|\bneither\b|\bcannot\b|\bcan't\b|\brather than\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\bno longer\b|\binstead of\b|\bwithout \w+ing\b)/i;

/** Ambiguous `not`/`no` count ONLY when immediately before the verb (F20 tier 2). This is
 *  the ONLY weak tier — a deliberate measure: an idiom list (`no doubt`, `instead`, ...)
 *  was tried and then REMOVED, because with the <=6-char immediate test it affected
 *  **0 of 20,526** real clauses (dead code), and vocabulary lists are exactly what caused
 *  F17 -> F18 -> F20. No idiom list means no new vocabulary surface. */
const NEG_WEAK_IMMEDIATE = /(?:\bnot\b|\bno\b)\s+$/i;

/** Structural exclusion: a marker at the START of a table CELL (or the line). Applied
 *  PER CELL — a marker waives only the cell it starts, not the whole row (F21). */
const MARKER = /^\s*(?:[-*>#]\s*)*(?:\*\*|__|`)*\s*\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\]/i;

/**
 * Does a single CLAUSE assert that a field classifies decoration vs text?
 * A clause carrying field+verb+object is a claim UNLESS a negation that genuinely
 * negates the verb precedes it (F20 two-tier rule).
 */
export function clauseIsClaim(clause) {
  if (!CLAIM_FIELD.test(clause) || !CLAIM_VERB.test(clause) || !CLAIM_OBJECT.test(clause)) return false;
  const verbRe = new RegExp(CLAIM_VERB.source, "ig");
  let m;
  while ((m = verbRe.exec(clause))) {
    const window = clause.slice(Math.max(0, m.index - 25), m.index);
    const immediate = clause.slice(Math.max(0, m.index - 6), m.index);
    const excused =
      NEG_STRONG.test(window) ||
      NEG_WEAK_IMMEDIATE.test(immediate);
    if (!excused) return true; // an un-negated classification verb
  }
  return false;
}

/** Is a single table cell (or line segment) a live claim? A cell that STARTS with a
 *  structural marker is excluded — and only that cell (F21). */
function cellIsClaim(cell) {
  if (MARKER.test(cell)) return false;
  return cell.split(/[;,:]/).some(clauseIsClaim);
}

/**
 * Flag a line as a live classification claim.
 * Table rows are split on "|" BEFORE clause-splitting, so a marker waives only its own
 * cell (F21). Clause-split on [;,:] — NEVER on "." (file paths like lib/measure.js and
 * decimals like 0.0986 contain periods, which in F17 tore a marker from its claim).
 */
export function flagsClassificationClaim(line) {
  return line.split("|").some(cellIsClaim);
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
