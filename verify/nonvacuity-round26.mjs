// Non-vacuity verification for the TWENTY-SIXTH-audit tests (F35: a decoration split below the
// large-background-region gate's per-blob mean was reported as failing text). Perturbs each
// round-26 guard in lib/measure.js, confirms the matching test FAILS, then restores
// byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F35 = "a decoration split below the region gate";

const cases = [
  {
    id: "F35 the TOTAL clause (reverting to the mean-only gate re-admits the split decoration)",
    test: F35,
    file: MEASURE,
    // Revert to the original mean-only form: the split decoration evades and is reported.
    from: "  return lowContrast && (meanIsRegionSized || (totalIsRegionSized && solid));",
    to: "  return lowContrast && meanIsRegionSized;",
  },
  {
    id: "F35 the MEAN clause (dropping it filters real ink, breaking F32/F34)",
    test: "a fill that lies ON the reference",
    file: MEASURE,
    // Remove the mean clause so ONLY total applies: solid on-line fills (F32's, F34's) exceed
    // the region fraction and are filtered as background, so the F32 test fails.
    from: "  return lowContrast && (meanIsRegionSized || (totalIsRegionSized && solid));",
    to: "  return lowContrast && totalIsRegionSized;",
  },
  {
    id: "F35 the solidity threshold (a lower threshold filters solid on-line ink)",
    test: "the AA size qualifier is a per-colour TOTAL",
    file: MEASURE,
    from: "const LARGE_REGION_SOLID_FILL = 0.9;",
    to: "const LARGE_REGION_SOLID_FILL = 0.2;",
  },
  {
    id: "F34 the total-based AA qualifier (a per-component qualifier re-hides the split fill)",
    test: "the AA size qualifier is a per-colour TOTAL",
    file: MEASURE,
    from: "      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
    to: "      if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;\n      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
  },
  {
    id: "COUNT-INVARIANCE second-ink part (a) covers the AA qualifier (F34 defect -> the sweep fails)",
    test: "COUNT-INVARIANCE",
    file: MEASURE,
    from: "      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
    to: "      if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;\n      candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: rgbDistance(rgb2, compRef), blend });",
  },
  {
    id: "COUNT-INVARIANCE covers the primary path (F35 mean-only defect -> the sweep fails)",
    test: "COUNT-INVARIANCE",
    file: MEASURE,
    from: "  return lowContrast && (meanIsRegionSized || (totalIsRegionSized && solid));",
    to: "  return lowContrast && meanIsRegionSized;",
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

console.log("\n=== ROUND-26 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-26 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
