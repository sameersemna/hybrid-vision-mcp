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
    id: "F11 reconciliation is gated (decoration excluded)",
    test: "does not fire on decorative bars",
    file: "lib/measure.js",
    // Anchor updated in round 11, when the gate became a UNION and moved inside a
    // filter closure. The ninth-audit rule that decoration is excluded still holds
    // (F11's bars fall below BOTH clauses), so reverting the gate to "disclose
    // every removed failing colour" must still make the F11 test fail.
    from: "        return isDisclosableDroppedColour(c, regionArea, largestShareOf(c.foreground));",
    to: "        return true; // REVERTED: disclose every dropped failing colour",
  },
  {
    id: "F11 second decorative fixture stays quiet",
    test: "second decorative fixture",
    file: "lib/measure.js",
    from: "        return isDisclosableDroppedColour(c, regionArea, largestShareOf(c.foreground));",
    to: "        return true; // REVERTED: disclose every dropped failing colour",
  },
  {
    id: "F11 shape still distinguishes panel from text in the WORDING",
    test: "shape now chooses the WORDING",
    file: "lib/measure.js",
    // Round 10 moved this from a gate to a label, so it is now pinned by the
    // wording test rather than by the F11 tests.
    from: "  return mean / regionArea >= LARGE_REGION_AREA_FRACTION;",
    to: "  return mean / regionArea > 0; // REVERTED: everything labelled panel-shaped",
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
