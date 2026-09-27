// Non-vacuity verification for the SIXTEENTH-audit tests (F18: the fix for P6/P7
// reintroduced it via free-text waiver tokens; F19: the field anchor covered 5 of 9
// emitted keys). Perturbs each round-16 guard, confirms the matching test FAILS, then
// restores byte-identically.
//
// SAFETY: mutates test-support/ and lib/ temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const GUARD = path.join(ROOT, "test-support", "prose-guard.mjs");

const cases = [
  {
    id: "F18 the structural exclusion is at the LINE START (a trailing marker must not waive)",
    test: "waiver token appended to a LIVE claim",
    file: "test-support/prose-guard.mjs",
    // Revert to "any marker anywhere waives" — the F18 defect. A trailing [PARAPHRASE]
    // would then excuse a live claim and the F18-pair test must fail.
    from: "const MARKER = /^\\s*(?:[-*>#]\\s*)*(?:\\*\\*|__|`)*\\s*\\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\\]/i;",
    to: "const MARKER = /\\[(?:REMOVED CLAIM|PARAPHRASE|REMOVED)\\]/i; // REVERTED: any marker waives",
  },
  {
    id: "F18 the negation must be ADJACENT to the verb (clause-anywhere reintroduces E1-E6)",
    test: "waiver token appended to a LIVE claim",
    file: "test-support/prose-guard.mjs",
    // Revert ADJACENCY to a WHOLE-CLAUSE vocabulary test — the round-15 defect, where
    // `amended`/`removed`/`invert`/`coincidence` anywhere in the clause excused a live
    // claim. (Changing only the vocabulary is not enough: E1's "amended" sits AFTER the
    // verb, so it must be the SCOPE that reverts.)
    from:
      "    const excused =\n" +
      "      NEG_STRONG.test(window) ||\n" +
      "      NEG_WEAK_IMMEDIATE.test(immediate);",
    to: "    const excused = !/(amend|removed|invert|coincidence|\\bnot\\b|\\bno\\b)/i.test(clause); // REVERTED: clause-wide vocabulary",
  },
  {
    id: "F19 the field anchor covers every emitted key",
    test: "field anchor covers EVERY emitted",
    file: "test-support/prose-guard.mjs",
    // Narrow FIELD back to the 5 round-15 names; the coverage assertion must fail.
    from: "export const EMITTED_DISCLOSURE_KEYS = [\n  \"foreground\", \"contrast_ratio\", \"pixel_count\", \"component_count\", \"mean_component_area\",\n  \"detected_plateau\", \"plateau_share\", \"largest_component_share\", \"measured_against\",\n];",
    to: "export const EMITTED_DISCLOSURE_KEYS = [\n  \"plateau_share\", \"largest_component_share\", \"mean_component_area\", \"detected_plateau\", \"component_count\",\n]; // REVERTED: 5 of 9 keys",
  },
  {
    id: "F18 a genuine claim is still caught (the guard is not over-widened)",
    test: "recall is measured against paraphrases",
    file: "test-support/prose-guard.mjs",
    // Break the verb list so a real claim slips; the recall fixtures must fail.
    from: "export const CLAIM_VERB = /(orders|order|distinguishes|distinguish|separates|separate|classifies|classify|tells? (?:apart|what is)|identif(?:y|ies)|filter(?:s)? out|pick(?:s)? out|labels?|sorts?|ranks?|routes?|recommends?)/i;",
    to: "export const CLAIM_VERB = /(classifies)/i; // REVERTED: verb list gutted",
  },
];

function runTest(pattern) {
  const r = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, TESTFILE], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

const results = [];
for (const c of cases) {
  const filePath = path.join(ROOT, c.file);
  const original = fs.readFileSync(filePath, "utf8");

  if (!original.includes(c.from)) {
    results.push({ id: c.id, error: `anchor not found in ${c.file}` });
    continue;
  }
  const before = runTest(c.test);
  fs.writeFileSync(filePath, original.replace(c.from, c.to), "utf8");
  const after = runTest(c.test);
  fs.writeFileSync(filePath, original, "utf8");

  const restored = fs.readFileSync(filePath, "utf8");
  if (restored !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }

  results.push({
    id: c.id,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== ROUND-16 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-16 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
