// Non-vacuity verification for the THIRTY-FIRST-audit gaps (G1: the abstention note contradicted
// the response's own `adequate` field; G2: a local witness that IS the background forced the
// abstention; G4: `verdict` was undefined on the abstention early-returns). Perturbs each fix in
// lib/measure.js, confirms the round-31 test FAILS, then restores byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const G_TEST = "the note never contradicts the response's own `adequate` field";

const cases = [
  {
    id: "G1 the note's premise binds to the PUBLISHED `adequate` field (0.8 re-introduces the contradiction)",
    test: G_TEST,
    file: MEASURE,
    from: "        const adequateFit = !!(backgroundFit && backgroundFit.applicable && backgroundFit.adequate);",
    to: "        const adequateFit = !!(backgroundFit && backgroundFit.applicable && backgroundFit.explained_fraction >= GOOD_FIT_FRACTION);",
  },
  {
    id: "G2/F39 the DECISION is the background-identity test (widening it to PLATEAU_MERGE_DIST deletes low-contrast text)",
    test: "the witness filter must not delete low-contrast text",
    file: MEASURE,
    // The round-32 regression (F39): using the WIDE distance as the decision turns the most
    // failing text (distance 5.2-13.9) into a clean pass. This perturbs the decision back to the
    // wide rule, which the F39 test must catch. (The round-31 form of this case asserted the
    // wider property; it is corrected here to the narrower one.)
    from: "      const decisive = raw.filter((c) => dist(c) > 0);",
    to: "      const decisive = raw.filter((c) => dist(c) > PLATEAU_MERGE_DIST);",
  },
  {
    id: "G2 the background-identity filter (dropping it lets #1a1814@1:1 force an abstention)",
    test: "the witness filter must not delete low-contrast text",
    file: MEASURE,
    // The identity-only case (k=16) lives in the F39 test, so the property is observable there.
    from: "      const decisive = raw.filter((c) => dist(c) > 0);",
    to: "      const decisive = raw;",
  },
  {
    id: "G4 the abstention early-return sets `verdict` (removing it makes the field undefined)",
    test: G_TEST,
    file: MEASURE,
    // The F27 arbitration early-return — the path the test's text-free/photographic fixtures hit.
    from:
      "        evaluated_count: 0,\n" +
      "        all_meet_aa: null,\n" +
      "        wcag_aa: null,\n" +
      "        verdict: \"unverified\",\n" +
      "        measurable: false,",
    to: "        evaluated_count: 0,\n        all_meet_aa: null,\n        wcag_aa: null,\n        measurable: false,",
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

// Structural invariant: both abstention early-returns carry a string `verdict`.
const src = fs.readFileSync(path.join(ROOT, MEASURE), "utf8");
const earlyReturnVerdicts = (src.match(/verdict: "unverified",/g) || []).length;
const bothEarlyReturns = earlyReturnVerdicts >= 2;

console.log("\n=== ROUND-31 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(`${(bothEarlyReturns ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: both abstention early-returns carry \`verdict\` (found ${earlyReturnVerdicts} literal(s), need >= 2)`);
if (!bothEarlyReturns) allGood = false;

console.log(allGood ? "\nAll round-31 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
