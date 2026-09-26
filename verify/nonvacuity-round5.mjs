// Non-vacuity verification for the FIFTH-audit acceptance tests (F6 gradient
// residual disclosure; §3 background_fit applicability). Reverts each round-5
// guard, confirms the matching test FAILS, then restores.
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
    id: "F6 marginal-fit note is emitted",
    test: "clean global verdict is never silent",
    file: "lib/measure.js",
    from: "  } else if (backgroundFit && backgroundFit.applicable && backgroundFit.explained_fraction < GOOD_FIT_FRACTION) {",
    to: "  } else if (false) { // REVERTED: marginal fits are silent again",
  },
  {
    id: "F6 local arbitration runs on a clean global verdict",
    test: "local arbitration flags the tone",
    file: "lib/measure.js",
    from: "  if (allMeetAA && backgroundMode === \"global\" && !multiPlateau && !explicitBg) {",
    to: "  if (false) { // REVERTED: no self-check on a clean verdict",
  },
  {
    id: "§3 background_fit is not-applicable in multi-plateau mode",
    test: "background_fit is explicitly not-applicable",
    file: "lib/measure.js",
    from: "    ? multiPlateau\n      ? {\n          ...rawFit,\n          adequate: null,",
    to: "    ? multiPlateau\n      ? {\n          ...rawFit,\n          adequate: rawFit.adequate, // REVERTED: reads as adequate",
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

console.log("\n=== ROUND-5 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-5 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
