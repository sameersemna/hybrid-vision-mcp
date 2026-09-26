// Non-vacuity verification for the NINTH-audit tests (F11: reconciliation
// precision — decoration is not text). Reverts the round-9 guard, confirms the
// matching test FAILS, then restores.
//
// SAFETY: mutates source under lib/ temporarily. Kept OUT of test/ so
// `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const cases = [
  {
    id: "F11 decorative bars now DISCLOSE (behaviour REVERSED in round 12)",
    test: "decorative bars now DISCLOSE",
    file: "lib/measure.js",
    // ANCHOR REPOINTED (twelfth audit). The ninth-audit rule (bars stay quiet) was
    // DELIBERATELY reversed: F14 showed the size gate was anti-correlated with the
    // evidence, so precision was traded for never hiding failing text. The guard
    // now proves the reversal is real: reverting the predicate to "never disclose"
    // must make the F11-discloses test fail.
    from: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return true;\n}",
    to: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return false; // REVERTED: nothing is disclosable\n}",
  },
  {
    id: "F11 second decorative fixture also DISCLOSES (reversed in round 12)",
    test: "second decorative fixture also discloses",
    file: "lib/measure.js",
    from: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return true;\n}",
    to: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return false; // REVERTED: nothing is disclosable\n}",
  },
  // NOTE (round 13): the former "shape still distinguishes panel from text in the
  // WORDING" case was REMOVED as obsolete rather than left vacuous. `shape` and
  // `isPanelShapedDroppedColour` were deleted (thirteenth audit F15) because the
  // label was `mean = total / N` again and inverted on the realistic pair. Its
  // replacement coverage lives in verify/nonvacuity-round13.mjs (the raw-evidence
  // fields are what a caller now uses).
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
    results.push({ id: c.id, error: "RESTORE FAILED — source not byte-identical after revert" });
    continue;
  }

  results.push({
    id: c.id,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== ROUND-9 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-9 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
