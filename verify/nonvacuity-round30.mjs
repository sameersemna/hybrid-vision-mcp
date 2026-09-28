// Non-vacuity verification for the THIRTIETH-audit test (F38: a verdict field must not
// contradict the tool's own cross-check — a clean `all_meet_aa` while `model_disagreement`
// names a failing colour). Perturbs the fix in lib/measure.js, confirms the F38 test FAILS,
// then restores byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F38 = "the verdict must not contradict";

const cases = [
  {
    id: "F38 the abstain (dropping it re-asserts the clean verdict against the cross-check)",
    test: F38,
    file: MEASURE,
    // Restore the pre-F38 behaviour: the clean field is left alone and only a note is added.
    from: "        allMeetAA = null;\n        verdict = \"unverified\";\n        notes.push(",
    to: "        notes.push(",
  },
  {
    id: "F38 the verdict follows the field (a hard-coded 'clean' breaks the invariant)",
    test: F38,
    file: MEASURE,
    from: "  let verdict = allMeetAA ? \"clean\" : \"failing\";",
    to: "  let verdict = \"clean\";",
  },
];

// NOT a case here: disabling the cross-check branch entirely. That removes the very
// contradiction this test is about (with no disagreement there is nothing for the field to
// contradict), so it cannot make the F38 test fail — the branch's EXISTENCE is guarded by
// round-21's "the local-measurable guard" case, not by this one.

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

// Structural invariant: the response carries a three-valued `verdict`, and the abstain sets it
// to "unverified" (so a caller never has to interpret a bare null).
const src = fs.readFileSync(path.join(ROOT, MEASURE), "utf8");
const hasVerdict = src.includes("verdict,") && /verdict = allMeetAA \? "clean" : "failing"/.test(src);
const abstainsAsUnverified = src.includes('verdict = "unverified";');

console.log("\n=== ROUND-30 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(`${(hasVerdict ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: response carries the three-valued \`verdict\` (hasVerdict=${hasVerdict})`);
console.log(`${(abstainsAsUnverified ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: the abstain sets \`verdict = "unverified"\` (${abstainsAsUnverified})`);
if (!hasVerdict || !abstainsAsUnverified) allGood = false;

console.log(allGood ? "\nAll round-30 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
