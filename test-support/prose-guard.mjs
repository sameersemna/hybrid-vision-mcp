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
// HONEST SCOPE (F17-F25) — SEVEN rounds of one class. Each round narrowed the SCOPE of an
// exclusion (line -> clause -> 25 chars -> <=6 chars -> governed -> quote-span) and left
// its KIND: a proximity/vocabulary test on author-controlled prose. Each fix produced a
// new escape class. NO MORE SCOPE NARROWINGS — this file is FROZEN as a best-effort lint:
//   * *PRIMARY gate* is the POSITIVE disclaimer assertion (`DISCLAIMER`): the docs must
//     STATE the opposite of the claim. It is paraphrase-proof and is a named test.
//   * this phrase rule is a BEST-EFFORT LINT whose recall is MEASURED AND ENFORCED: the
//     fixture set in `prose-recall-fixtures.mjs` scores **18/19** and the test PRINTS that
//     number and FAILS if it drops below 18/19. It is a REGRESSION SCORE over the known
//     escape cases, NOT an estimate of recall over unseen prose. A doc test asserts the
//     docs quote the same figure.
//   * the test that matters most is the INVARIANCE PAIR: the same claim with and without
//     each waiver mechanism must get the SAME verdict.
// F24/F25 note: `GLUE` is vocabulary again and is the last list added. `fail|fails` is
// deliberately EXCLUDED (it inverts polarity: `never fails to order` ASSERTS the claim).
// Residuals: a negation >25 chars from the verb is missed; abbreviations (`e.g.`) inside a
// waived span are unmeasured. Both are documented in ACCURACY.md §5u.

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

/** Strong negations that unambiguously negate the verb they precede (F20 tier 1).
 *  NOTE (F22): `without \w+ing` was REMOVED — it is the widest offender (`without
 *  blinking`, `without pausing` read as emphasis), and dropping it was measured to close
 *  two escapes at zero added false positives. */
const NEG_STRONG = /(\bnever\b|\bnone of\b|\bneither\b|\bcannot\b|\bcan't\b|\brather than\b|\bdoes ?n[o']?t\b|\bis ?n[o']?t\b|\bare ?n[o']?t\b|\b(?:should|would|could|will|must|may|might|can|shall) ?n[o']?t\b|\bno longer\b|\binstead of\b)/i;

/** Ambiguous `not`/`no` count ONLY when immediately before the verb (F20 tier 2). This is
 *  the ONLY weak tier — a deliberate measure: an idiom list (`no doubt`, `instead`, ...)
 *  was tried and then REMOVED, because with the <=6-char immediate test it affected
 *  **0 of 20,526** real clauses (dead code). No idiom list means no new vocabulary surface. */
const NEG_WEAK_IMMEDIATE = /(?:\bnot\b|\bno\b)\s+$/i;

/** Function words that may stand between a negation and the verb it governs. If a CONTENT
 *  word intervenes (`never FAILS to order`), the negation does not govern the verb (F22). */
const FUNCTION_WORDS = /^(?:a|an|the|of|to|in|on|at|by|for|with|from|that|this|these|those|it|its|is|are|was|were|be|been|being|has|have|had|do|does|did|and|or|but|so|as|if|than|then|also|just|even|only|still|yet|not|no|never|none|neither|cannot|can't|rather|instead|without|longer|any|all|some|more|most|very|quite|really|simply|merely)$/i;

/**
 * GLUE words (F25). A retraction often puts a content word between the negation and the
 * verb — `is not ABLE to distinguish`, `cannot be SAID to separate`, `not INTENDED to
 * order`. Those content words carry the retraction, so they must still count as governed.
 *
 * POLARITY WARNING: `fail|fails` is deliberately ABSENT. `never FAILS to order` is a
 * DOUBLE NEGATIVE that ASSERTS the classification — adding `fail` here re-opened A1.
 * Any future glue word must be checked for this: does it make the sentence assert (bad
 * glue) or retract (good glue)? The glue list is vocabulary again, and rounds 16-19 show
 * what that costs; it is deliberately short and limited to words that carry retraction.
 */
const GLUE = /^(?:able|intended|used|going|supposed|meant|said|claimed|thought|designed|expected|allowed|permitted|attempt|attempts|try|tries|seek|seeks|likely|meant|destined|equipped|built|written)$/i;

/**
 * Does a STRONG negation GOVERN the verb at `verbIndex`? (F22 governed negation.)
 * The LAST strong negation before the verb must have only function words between it and
 * the verb, and be within 30 chars — so `never fails to order` is NOT excused (the content
 * word `fails` intervenes), while `does NOT distinguish` and `cannot distinguish` are.
 *
 *  KNOWN COST (measured, not hidden): this declines to excuse legitimate retractions that
 *  place a content word between the negation and the verb — `is not able to distinguish`,
 *  `cannot be said to separate`, `should not be used to order`. Those become FALSE
 *  POSITIVES (flagged although they retract) — which punishes writing the disclaimer.
 *  The GLUE list (F25) restores them: content words that CARRY retraction count as
 *  governed, while content words that invert polarity (`fails`) do not. Measured on the
 *  union harness: escapes 3 -> 0, false positives 5 -> 0.
 */
function strongNegationGoverns(clause, verbIndex) {
  const before = clause.slice(0, verbIndex);
  const re = new RegExp(NEG_STRONG.source, "ig");
  let m;
  let last = null;
  while ((m = re.exec(before))) last = m;
  if (!last) return false;
  const gap = before.slice(last.index + last[0].length);
  if (gap.length > 30) return false;
  const words = gap.toLowerCase().match(/[a-z']+/g) || [];
  return words.every((w) => FUNCTION_WORDS.test(w) || GLUE.test(w));
}

/** Structural exclusion: a marker at the START of a table CELL (or the line). Applied
 *  PER CELL — a marker waives only the span it precedes, not the whole cell (F21/F23). */
const MARKER = /^\s*(?:[-*>#]\s*)*(?:\*\*|__|`)*\s*\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\]/i;

/** Index of the first sentence end, NOT counting intra-token periods (`lib.measure.js`,
 *  0.0986) — F17's lesson, which the audit re-derived when a naïve [.!?] split hit
 *  `lib/measure.js`. Returns -1 when there is no sentence end. */
function firstSentenceEnd(text) {
  const re = /[.!?]/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === ".") {
      const before = text[m.index - 1] || "";
      const after = text[m.index + 1] || "";
      if (/[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) continue; // letter.letter => filename/decimal
    }
    return m.index;
  }
  return -1;
}

/**
 * Does a single CLAUSE assert that a field classifies decoration vs text?
 * A clause carrying field+verb+object is a claim UNLESS a negation that genuinely
 * negates the verb precedes it (F20 two-tier + F22 governed).
 */
export function clauseIsClaim(clause) {
  if (!CLAIM_FIELD.test(clause) || !CLAIM_VERB.test(clause) || !CLAIM_OBJECT.test(clause)) return false;
  const verbRe = new RegExp(CLAIM_VERB.source, "ig");
  let m;
  while ((m = verbRe.exec(clause))) {
    const immediate = clause.slice(Math.max(0, m.index - 6), m.index);
    const excused = strongNegationGoverns(clause, m.index) || NEG_WEAK_IMMEDIATE.test(immediate);
    if (!excused) return true; // an un-governed classification verb
  }
  return false;
}

/** Is a single table cell (or line segment) a live claim?
 *  A marker waives only the SPAN it precedes. F21 fixed the row-wide waiver, F23 the
 *  cell-wide one, F24 the no-sentence-end case (which waived the ENTIRE remainder — a
 *  strictly easier escape, needing no period anywhere). The rule is now:
 *    1. a complete lead clause ending in [.!?] waives that clause; else
 *    2. a leading QUOTED span (`"..."`, `` `...` ``, "...") waives that span; else
 *    3. the marker waives nothing and a leading claim is reported.
 */
function cellIsClaim(cell) {
  const m = cell.match(MARKER);
  if (m) {
    const afterMarker = cell.slice(m.index + m[0].length);
    const end = firstSentenceEnd(afterMarker);
    if (end >= 0) return afterMarker.slice(end + 1).split(/[;,:]/).some(clauseIsClaim);
    const quoted = afterMarker.match(/^\s*[`"'\u201c\u2018]([^`"'\u201d\u2019]*)[`"'\u201d\u2019]/);
    const remainder = quoted ? afterMarker.slice(quoted[0].length) : afterMarker;
    return remainder.split(/[;,:]/).some(clauseIsClaim);
  }
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
