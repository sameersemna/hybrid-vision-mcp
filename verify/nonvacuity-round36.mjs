// Non-vacuity verification for the THIRTY-SIXTH-audit fix (F44: the shade separator keyed on
// MIN_TEXT_MEAN_AREA (100) misclassified ordinary UI text as "not a distinct ink"; the fix asserts
// the VALUE relationship always, classifies only where structure is decisive, and leaves the
// overlap band unclassified). Perturbs each part, confirms the F44 test FAILS, restores.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const MEASURE = "lib/measure.js";
const F44 = "ordinary UI text on the masked line";

const cases = [
  {
    id: "F44 the unclassified overlap band (classifying it by the 100px line mislabels body text)",
    test: F44,
    testfile: "background.test.js",
    file: MEASURE,
    // Re-introduce the round-35 behaviour: the shade bound becomes the full 100px line.
    from: "      const shadeDecisiveMax = MIN_TEXT_MEAN_AREA / 4; // 25px: below the measured real-text floor",
    to: "      const shadeDecisiveMax = MIN_TEXT_MEAN_AREA;",
  },
  {
    id: "F43 the structurally-TEXT note (dropping it leaves on-line real text undisclosed as text)",
    test: "a REAL text colour on the masked line",
    testfile: "background.test.js",
    file: MEASURE,
    from: "      const asText = onLine.filter((e) => meanOf(e) >= MIN_TEXT_MEAN_AREA);",
    to: "      const asText = [];",
  },
];

function runTest(pattern, testfile) {
  const r = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(ROOT, "test", testfile)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const ran = Number((out.match(/^ℹ tests (\d+)/m) || [])[1] || 0);
  return { ok: r.status === 0 && ran > 0, ran, out };
}

const results = [];
for (const c of cases) {
  const filePath = path.join(ROOT, c.file);
  const original = fs.readFileSync(filePath, "utf8");
  if (!original.includes(c.from)) {
    results.push({ id: c.id, error: `anchor not found in ${c.file}` });
    continue;
  }
  const before = runTest(c.test, c.testfile);
  fs.writeFileSync(filePath, original.replace(c.from, c.to), "utf8");
  const after = runTest(c.test, c.testfile);
  fs.writeFileSync(filePath, original, "utf8");
  if (fs.readFileSync(filePath, "utf8") !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }
  results.push({ id: c.id, passesWithFix: before.ok, failsWithoutFix: !after.ok, nonVacuous: before.ok && !after.ok });
}

// Structural invariant: the note must be THREE-way (value always; shade / text / ambiguous split),
// not a single colour-only classification.
const src = fs.readFileSync(path.join(ROOT, MEASURE), "utf8");
const threeWay = /const shades = onLine\.filter/.test(src) && /const asText = onLine\.filter/.test(src) && /const ambiguous = onLine\.filter/.test(src);
const keepsOverlap = /OVERLAP/.test(src);

console.log("\n=== ROUND-36 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(`${(threeWay ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: the on-line note is three-way (shade/text/ambiguous) (threeWay=${threeWay})`);
console.log(`${(keepsOverlap ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: the overlap band is disclosed, not silently classified (keepsOverlap=${keepsOverlap})`);
if (!threeWay || !keepsOverlap) allGood = false;

console.log(allGood ? "\nAll round-36 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
