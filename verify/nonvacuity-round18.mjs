// Non-vacuity verification for the EIGHTEENTH-audit tests (F22: the strong negation was
// still a 25-char PROXIMITY test, so `never fails to order` waived a claim; F23: a marker
// waived its whole CELL, so an unrelated claim later in the cell escaped). Perturbs each
// round-18 guard, confirms the matching test FAILS, then restores byte-identically.
//
// SAFETY: mutates test-support/ and ACCURACY.md temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const GOVERNED = "    const excused = strongNegationGoverns(clause, m.index) || NEG_WEAK_IMMEDIATE.test(immediate);";

const cases = [
  {
    id: "F22 the strong negation must GOVERN the verb (proximity re-admits `never fails to`)",
    test: "STRONG negation must GOVERN the verb",
    file: "test-support/prose-guard.mjs",
    // Revert to the proximity test: `never fails to order` then waives again.
    from: GOVERNED,
    to: "    const excused = /(\\bnever\\b|\\bnone of\\b|\\bneither\\b|\\bcannot\\b|\\bcan't\\b|\\brather than\\b|\\bdoes ?n[o']?t\\b|\\bis ?n[o']?t\\b|\\bare ?n[o']?t\\b|\\bno longer\\b|\\binstead of\\b)/i.test(clause.slice(Math.max(0, m.index - 25), m.index)) || NEG_WEAK_IMMEDIATE.test(immediate); // REVERTED: proximity strong tier",
  },
  {
    id: "F22 the govern gap must be bounded (a far negation does not govern)",
    test: "STRONG negation must GOVERN the verb",
    file: "test-support/prose-guard.mjs",
    // Remove the gap cap and the content-word test so ANY preceding negation governs:
    // then `is not able to distinguish` is allowed, and the documented FP assertion fails.
    from: "  const words = gap.toLowerCase().match(/[a-z']+/g) || [];\n  return words.every((w) => FUNCTION_WORDS.test(w));",
    to: "  return true; // REVERTED: any preceding negation governs",
  },
  {
    id: "F23 a marker waives only its SPAN (cell-wide re-admits B1)",
    test: "marker waives only the SPAN",
    file: "test-support/prose-guard.mjs",
    // Revert to cell-wide: B1 escapes and the invariance pair must fail.
    from: "    const remainder = end >= 0 ? afterMarker.slice(end + 1) : \"\"; // no sentence end => marker waives the rest\n    return remainder.split(/[;,:]/).some(clauseIsClaim);",
    to: "    return false; // REVERTED: marker waives the whole cell",
  },
  {
    id: "F23 the sentence-end finder must not split a dotted filename",
    test: "marker waives only the SPAN",
    file: "test-support/prose-guard.mjs",
    // Remove the \\w.\\w protection: `lib/measure.js` then splits, the test must fail.
    from: "      if (/[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) continue; // letter.letter => filename/decimal",
    to: "      // REVERTED: no dotted-token protection",
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
  if (fs.readFileSync(filePath, "utf8") !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }
  results.push({ id: c.id, passesWithFix: before.ok, failsWithoutFix: !after.ok, nonVacuous: before.ok && !after.ok });
}

console.log("\n=== ROUND-18 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-18 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
