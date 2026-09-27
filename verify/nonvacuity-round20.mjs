// Non-vacuity verification for the TWENTIETH-audit tests (F26: the disposition PROMISED a
// measured recall in four places while recording no number). Perturbs each round-20 guard,
// confirms the matching test FAILS, then restores byte-identically.
//
// SAFETY: mutates test-support/ and a doc temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const cases = [
  {
    id: "F26 the recall figure is MEASURED and ENFORCED (dropping a fixture lowers it)",
    test: "recall is measured against paraphrases",
    file: "test-support/prose-recall-fixtures.mjs",
    // Remove a must-flag fixture: caught drops, and the ratio assertion must fail.
    from: '  "plateau_share separates chart furniture from copy.", // P8\n',
    to: "",
  },
  {
    id: "F26 the docs must quote the SAME figure the guard measures",
    test: "docs must quote the SAME recall figure",
    file: "README.md",
    // Break the doc's figure: the consistency assertion must fail.
    from: "18/19",
    to: "17/19",
  },
  {
    id: "F26 the superseded 1/9 figure must be labelled historical",
    test: "docs must quote the SAME recall figure",
    file: "ACCURACY.md",
    // Strip the historical label entirely (not a word that still matches the regex).
    from: "| 15 (superseded rule) | phrase guard | caught 1/9 paraphrases (SUPERSEDED \u2014 the rule has since been hardened; current recall 18/19, \u00a75v) |",
    to: "| 15 | phrase guard | caught 1/9 paraphrases |",
  },
  {
    id: "F26 the guard header must state the measured figure",
    test: "docs must quote the SAME recall figure",
    file: "test-support/prose-guard.mjs",
    // Break BOTH header occurrences of 18/19 (the header mentions it twice) so no
    // occurrence matches the computed figure.
    from: "18/19",
    to: "99/99",
    global: true,
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
  fs.writeFileSync(filePath, c.global ? original.split(c.from).join(c.to) : original.replace(c.from, c.to), "utf8");
  const after = runTest(c.test);
  fs.writeFileSync(filePath, original, "utf8");
  if (fs.readFileSync(filePath, "utf8") !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }
  results.push({ id: c.id, passesWithFix: before.ok, failsWithoutFix: !after.ok, nonVacuous: before.ok && !after.ok });
}

console.log("\n=== ROUND-20 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-20 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
