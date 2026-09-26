// Non-vacuity verification for the FOURTEENTH-audit tests (F16: `plateau_share` was
// claimed to classify decoration vs text; it is a coverage measure and a dense glyph
// run covers MORE than a bar chart). Reverts/perturbs each round-14 guard, confirms
// the matching test FAILS, then restores byte-identically.
//
// SAFETY: mutates files temporarily (lib/ AND a doc, for the prose guard). Kept OUT
// of test/ so `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

// A claim line that would violate the prose guard — used to prove the guard is real.
const INJECT_CLAIM = "\n<!-- inject --> `plateau_share` orders decoration from a glyph run.\n";

const cases = [
  {
    id: "F16 `detected_plateau` is evidence, not a classifier (field is produced)",
    test: "detected_plateau.*is evidence|is evidence, not a classifier",
    file: "lib/measure.js",
    // Remove the field's real value: the test asserting a real text run IS detected
    // as a plateau must fail.
    from: "              detected_plateau: matched !== null,",
    to: "              detected_plateau: null, // REVERTED: field not produced",
  },
  {
    id: "F16 the prose guard actually fails on a re-inserted claim",
    test: "catches the LITERAL regression",
    file: "ACCURACY.md",
    // This is the point of the prose guard: if a claim RETURNED to the docs, the test
    // must fail. Inject one and confirm. (Test name repointed in round 15, when the
    // guard was renamed to state its honest scope.)
    from: "\n## 9. New module map",
    to: INJECT_CLAIM + "\n## 9. New module map",
  },
  {
    id: "F16 the prose guard fails on a re-inserted claim in a code comment",
    test: "catches the LITERAL regression",
    file: "lib/measure.js",
    // Same, but in the source file — the layer where F14/F15's claim first lived.
    from: "export function isDisclosableDroppedColour(colour, regionArea) {",
    to: "// plateau_share orders decoration from a glyph run.\nexport function isDisclosableDroppedColour(colour, regionArea) {",
  },
  // NOTE (round 14): the "`plateau_share` does NOT order decoration from text (it
  // inverts)" test is NOT guarded here, deliberately. It asserts a measured ordering
  // between two fixtures (t.plateau_share > a.plateau_share) and has no dependency on
  // a single source line, so no revert can fail it — exactly like round 13's
  // "no scalar separates" test. Its failure mode is a wrong measurement, not a code
  // regression. A revert anchor for it would be vacuous by construction.
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

  const restored = fs.readFileSync(filePath, "utf8");
  if (restored !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }

  results.push({
    id: c.id,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== ROUND-14 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-14 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
