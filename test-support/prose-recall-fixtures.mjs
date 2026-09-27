// Round-20 F26: the recall fixture set, in ONE place, so the number the docs state is
// COMPUTED and ENFORCED rather than asserted in prose.
//
// IMPORTANT: this file is deliberately NOT in the guard's scanned file list. It CONTAINS
// live classification claims (they are the fixtures the guard must catch), so scanning it
// would flag it. It is a test-support module, not documentation.
import { flagsClassificationClaim } from "./prose-guard.mjs";

/** Claims the guard MUST catch. These are the accumulated escape cases from rounds 15-19 —
 *  18 fixtures. The 19th fixture is the KNOWN MISS (P4, below). */
export const MUST_FLAG = [
  "plateau_share is the field that orders decoration (a wide tiled region) from a glyph run.", // literal
  "use plateau_share to identify decoration rather than real text.", // P1
  "plateau_share lets a caller filter out chart furniture instead of copy.", // P2
  "plateau_share is how you tell what is decoration and what is text.", // P3
  "a high plateau_share distinguishes decoration from glyphs.", // P5
  "plateau_share orders decoration from text, which is what makes it not decoration-specific but genuinely useful.", // P6
  "plateau_share orders decoration from text by size; think of it as large from small coverage.", // P7
  "plateau_share separates chart furniture from copy.", // P8
  "decoration is distinguished from text by plateau_share.", // P9
  "plateau_share orders decoration from a glyph run. [PARAPHRASE]", // H1a
  "plateau_share orders decoration from a glyph run [paraphrase]", // H1c
  "contrast_ratio orders decoration from a glyph run.", // H2: previously unlisted key
  "mean_component_area distinguishes decoration from text.", // H2: previously unlisted key
  "plateau_share orders decoration from text (wording amended 2026)", // E1
  "plateau_share orders decoration from text after the old gate was removed", // E2
  "plateau_share orders decoration from text and is not a classifier of anything else", // E3
  "plateau_share orders decoration from text although some claim it might invert", // E5
  "plateau_share orders decoration from text and that is no coincidence", // E6
];

/** The KNOWN MISS: a comma splits the field from the verb. Recorded, not hidden. */
export const KNOWN_MISS = "plateau_share orders colours into buckets so that, with practice, a caller can reliably separate the wide tiled decorations seen here from a glyph run.";

/** Lines the guard MUST allow (legitimate negations, retractions, quoted history). */
export const MUST_ALLOW = [
  "plateau_share is the plateau's coverage of the region; it does NOT distinguish decoration from text.",
  "A bar chart and a glyph run are the same kind of object, so no scalar separates decoration from text.",
  "NONE of these distinguishes decoration from text (F16): plateau_share is coverage",
  "but it orders large from small, not decoration from text: a dense glyph run can cover MORE",
  '**[REMOVED CLAIM]** `plateau_share` orders decoration from a glyph run.',
  "A component that is long and thin is treated as decorative chrome, not text.",
  "plateau_share is not able to distinguish decoration from text.",
  "plateau_share cannot be said to separate decoration from text.",
];

/** Measure recall on the fixture set. Returns a stable object.
 *  NOTE: this is a REGRESSION SCORE over KNOWN escape cases, NOT an estimate of recall over
 *  unseen prose — the fixtures are the accumulated findings, so a high score here does not
 *  predict performance on a paraphrase nobody has written yet. */
export function measureRecall() {
  const caught = MUST_FLAG.filter((l) => flagsClassificationClaim(l)).length;
  const falsePositives = MUST_ALLOW.filter((l) => flagsClassificationClaim(l)).length;
  const knownMissStillMissed = !flagsClassificationClaim(KNOWN_MISS);
  const total = MUST_FLAG.length + 1; // +1 for the known miss, so 19
  return {
    caught,
    total,
    mustFlagTotal: MUST_FLAG.length,
    falsePositives,
    knownMissStillMissed,
    // The figure the docs quote: caught / (must-flag + known-miss).
    recall: `${caught}/${total}`,
  };
}
