// Non-vacuity verification for the TWENTY-SECOND-audit tests (F29: the per-component pixel
// floor re-hid a fill split across components — F28's own gate one scalar lower).
// Perturbs each round-22 guard in lib/measure.js, confirms the matching test FAILS, then
// restores byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F29 = "F29: small outlined text is not lost when its fill splits across components";

const cases = [
  {
    id: "F29 the per-colour TOTAL aggregation (reverting to a per-component floor re-hides the split fill)",
    test: F29,
    file: MEASURE,
    // Apply the floor to the PIECE instead of the TOTAL: the 30px "ABC" fill (pieces 221+68,
    // total 289) then emits neither piece, and the F29 assertion fails.
    from: "      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
    to: "      if (extra.count < MULTICOLOUR_MIN_PIXELS) continue;",
  },
  {
    id: "F29 the extra-colour emission (dropping it re-hides every fill)",
    test: F29,
    file: MEASURE,
    from: "    for (const extra of extras) {\n      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
    to: "    for (const extra of []) {\n      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
  },
  {
    id: "F29 the plateau-adjacency gate (plateau-adjacent shades must not become second ink)",
    test: "card borders are not reported as failing text",
    file: MEASURE,
    // Drop the plateau-adjacency test: the dense-flat page's card tones then aggregate past
    // the floor and the verdict fails.
    from: "      if (backgrounds && backgrounds.some((b) => rgbDistance(rgb2, b) <= PLATEAU_MERGE_DIST)) continue;",
    to: "      if (false && backgrounds && backgrounds.some((b) => rgbDistance(rgb2, b) <= PLATEAU_MERGE_DIST)) continue;",
  },
  {
    id: "F28 the parent-box gate (region-spanning blobs must not spawn second-ink colours)",
    test: "local background mode recovers text colours a global background misses",
    file: MEASURE,
    from: "    const parentIsGlyphSized =\n      boxW * boxH <= MULTICOLOUR_PARENT_MAX_BOX_FRACTION * scanArea;",
    to: "    const parentIsGlyphSized = true;",
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

console.log("\n=== ROUND-22 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-22 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
