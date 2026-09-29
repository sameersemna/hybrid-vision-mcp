// Non-vacuity verification for the THIRTY-FIFTH-audit fix (F43: the masked-shade note was keyed on
// COLOUR ONLY, so it could declare a real text colour "not a distinct ink" — while the same response
// listed it as text). Perturbs the structural gate, confirms the matching test FAILS, restores.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const MEASURE = "lib/measure.js";
const F43 = "a REAL text colour on the masked line";

const cases = [
  {
    id: "F43 the structural SIZE gate on the shade test (a colour-only test misclassifies real text)",
    test: F43,
    testfile: "background.test.js",
    file: MEASURE,
    from: "        return meanArea < MIN_TEXT_MEAN_AREA;",
    to: "        return true;",
  },
  {
    id: "F43 the mirror note for structurally-text on-line colours (dropping it leaves the text undisclosed)",
    test: F43,
    testfile: "background.test.js",
    file: MEASURE,
    from: "      const onLineText = failing.filter(\n        (e) => !shadeLike(e) && maskedRgbs.some((m) => isAntiAliasingBlend(e.rgb, m, background, MULTICOLOUR_AA_OPTS)),\n      );",
    to: "      const onLineText = [];",
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

console.log("\n=== ROUND-35 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-35 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
