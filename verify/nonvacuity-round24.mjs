// Non-vacuity verification for the TWENTY-FOURTH-audit tests (F32: widening the AA window to
// the full segment discarded real ink that lies on the reference→stroke line). Perturbs the
// round-24 guard in lib/measure.js, confirms the matching test FAILS, then restores
// byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F32 = "a fill that lies ON the reference";

const cases = [
  {
    id: "F32 the AA size-guard (colour-proximity alone discards the on-line fill)",
    test: F32,
    file: MEASURE,
    // Revert to the round-23 rule: reject ANY blend regardless of size. The on-line fill
    // vanishes again and the F32 test fails.
    from: "      if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;",
    to: "      if (blend) continue;",
  },
  {
    id: "F32 the AA window itself (a conservative (0.25,0.98) window changes the on-line treatment)",
    test: F32,
    file: MEASURE,
    // A conservative window makes the verdict differ from the primary path in a different way;
    // the F32 pair assertion must fail.
    from: "const MULTICOLOUR_AA_OPTS = { minT: 0, maxT: 1 };",
    to: "const MULTICOLOUR_AA_OPTS = { minT: 0.25, maxT: 0.98 };",
  },
  {
    id: "F31/F32 both: the structural mean-area gate (removing it re-admits fragmented decoration)",
    test: "card borders are not reported as failing text",
    file: MEASURE,
    from: "      if (total / comps < minMulticolourMeanArea) continue;",
    to: "      if (false && total / comps < minMulticolourMeanArea) continue;",
  },
  {
    id: "F33 the structural gate must keep the dense-flat card strokes rejected",
    test: "pre-existing, named",
    file: MEASURE,
    from: "      if (total / comps < minMulticolourMeanArea) continue;",
    to: "      if (false && total / comps < minMulticolourMeanArea) continue;",
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

console.log("\n=== ROUND-24 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-24 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
