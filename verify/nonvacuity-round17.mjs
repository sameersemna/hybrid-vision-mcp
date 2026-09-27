// Non-vacuity verification for the SEVENTEENTH-audit tests (F20: the verb-adjacent
// window admitted ordinary words — `no doubt`, `instead`; F21: a marker in one table cell
// waived a claim in another). Perturbs each round-17 guard, confirms the matching test
// FAILS, then restores byte-identically.
//
// SAFETY: mutates test-support/ and ACCURACY.md temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const WEAK_TIER =
  "    const excused =\n" +
  "      NEG_STRONG.test(window) ||\n" +
  "      NEG_WEAK_IMMEDIATE.test(immediate);";

const cases = [
  {
    id: "F20 the weak tier must be IMMEDIATE (a 25-char weak window re-admits `no doubt`)",
    test: "ordinary words must not waive",
    file: "test-support/prose-guard.mjs",
    // Widen the weak tier back to the 25-char window: `no doubt` then excuses the verb.
    from: WEAK_TIER,
    to:
      "    const excused =\n" +
      "      NEG_STRONG.test(window) ||\n" +
      "      /(?:\\bnot\\b|\\bno\\b)/i.test(window); // REVERTED: weak tier at 25 chars",
  },
  {
    id: "F20 strong negations still work at 25 chars (cannot / does not)",
    test: "ordinary words must not waive",
    file: "test-support/prose-guard.mjs",
    // Remove the strong tier: legitimate `cannot` / `does NOT` negations stop being
    // excused, so the must-allow fixtures fail.
    from: WEAK_TIER,
    to:
      "    const excused =\n" +
      "      NEG_WEAK_IMMEDIATE.test(immediate); // REVERTED: no strong tier",
  },
  {
    id: "F21 a marker waives only its OWN cell (not the whole row)",
    test: "ordinary words must not waive",
    file: "test-support/prose-guard.mjs",
    // Revert to a line-wide marker check: H2a escapes and the test must fail.
    from: "export function flagsClassificationClaim(line) {\n  return line.split(\"|\").some(cellIsClaim);\n}",
    to: "export function flagsClassificationClaim(line) {\n  if (MARKER.test(line)) return false; // REVERTED: line-wide marker\n  return line.split(/[;,:]/).some(clauseIsClaim);\n}",
  },
  {
    id: "F21 a marker-bearing line must be un-flagged (misplaced marker detected)",
    test: "marker must annotate its OWN cell",
    file: "ACCURACY.md",
    // Move a marker OUT of its own cell so it no longer annotates the quoted claim; the
    // quoted claim then becomes live and the line is flagged while still mentioning a
    // marker — the assertion must fail.
    from: "| [PARAPHRASE] `plateau_share orders decoration from a glyph run.` (control) | 109 / 1 fail | 111 / 1 fail |",
    to: "| `plateau_share orders decoration from a glyph run.` (control) [PARAPHRASE] | 109 / 1 fail | 111 / 1 fail |",
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

console.log("\n=== ROUND-17 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-17 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
