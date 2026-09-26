// Non-vacuity verification for the TWELFTH-audit tests (F14: the disclosure gate
// was ANTI-CORRELATED with the evidence — adding failing text of the same colour
// made the warning disappear). Reverts each round-12 guard, confirms the matching
// test FAILS, then restores.
//
// SAFETY: mutates source under lib/ temporarily. Kept OUT of test/ so
// `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const PREDICATE = "export function isDisclosableDroppedColour(colour, regionArea) {\n  return true;\n}";
const MEAN_GATE =
  "export function isDisclosableDroppedColour(colour, regionArea) {\n" +
  "  const mean = colour.component_count ? colour.pixel_count / colour.component_count : colour.pixel_count;\n" +
  "  return mean / regionArea >= PLATEAU_MIN_BLOB_SHARE; // REVERTED: the retracted mean-only gate (silences F14 E)\n" +
  "}";

const cases = [
  {
    id: "F14 adding body text of the SAME colour must not silence the warning",
    test: "adding body text of the SAME failing colour",
    file: "lib/measure.js",
    // The twelfth-audit defect itself: the mean-only gate hid E (mean 0.03%).
    from: PREDICATE,
    to: MEAN_GATE,
  },
  {
    id: "F14 the solid-block form (no text) is disclosed",
    test: "the solid-block form",
    file: "lib/measure.js",
    from: PREDICATE,
    to: MEAN_GATE,
  },
  {
    id: "F14 the disclosed entry carries the plateau evidence (wording, not suppression)",
    test: "carries the plateau EVIDENCE",
    file: "lib/measure.js",
    from: "              detected_plateau: matched !== null,",
    to: "              detected_plateau: false, // REVERTED: no plateau evidence",
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

console.log("\n=== ROUND-12 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-12 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
