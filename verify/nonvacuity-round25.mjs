// Non-vacuity verification for the TWENTY-FIFTH-audit tests (F34: the AA size qualifier used
// a PER-COMPONENT count, so a real on-line fill split across glyphs was discarded). Perturbs
// each round-25 guard in lib/measure.js, confirms the matching test FAILS, then restores
// byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F34 = "the AA size qualifier is a per-colour TOTAL";

const cases = [
  {
    id: "F34 the total-based AA qualifier (a per-component qualifier re-hides the split fill)",
    test: F34,
    file: MEASURE,
    // Move the size qualifier back to the candidate loop, on the per-component count, BEFORE
    // the candidate is recorded — the exact round-24 form.
    from: "      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
    to: "      if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;\n      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
  },
  {
    id: "F34 the deferred-pass qualifier (removing it re-admits every fringe)",
    test: "huge identical glyphs",
    file: MEASURE,
    from: "      if (blendTotal > 0 && blendTotal < MULTICOLOUR_AA_MIN_PIXELS) continue;",
    to: "      if (false) continue;",
  },
  {
    id: "F31/F32 the structural mean-area gate (removing it re-admits fragmented decoration)",
    test: "card borders are not reported as failing text",
    file: MEASURE,
    from: "      if (total / comps < minMulticolourMeanArea) continue;",
    to: "      if (false && total / comps < minMulticolourMeanArea) continue;",
  },
  {
    id: "F32 the AA window (a conservative window changes the on-line treatment)",
    test: "a fill that lies ON the reference",
    file: MEASURE,
    from: "const MULTICOLOUR_AA_OPTS = { minT: 0, maxT: 1 };",
    to: "const MULTICOLOUR_AA_OPTS = { minT: 0.25, maxT: 0.98 };",
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

console.log("\n=== ROUND-25 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-25 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
