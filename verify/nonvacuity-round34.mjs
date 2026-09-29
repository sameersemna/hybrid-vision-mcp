// Non-vacuity verification for the THIRTY-FOURTH-audit fixes (F42: the verdict tier, so the
// verdict survives a small cap; and the masked-shade note, so the failing list cannot read as
// independent text colours). Perturbs each fix, confirms the matching test FAILS, restores
// byte-identically.
//
// SAFETY: mutates lib/measure.js and lib/response.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const MEASURE = "lib/measure.js";
const RESPONSE = "lib/response.js";
const F42 = "AA shades of a MASKED colour say so";
const F41 = "the last-resort fallback keeps the VERDICT";

const cases = [
  {
    id: "F42 the masked-shade note (removing it lets the failing list read as independent text)",
    test: F42,
    testfile: "background.test.js",
    file: MEASURE,
    from: "    const maskedHexes = (maskReconciliation?.unmasked_failing_colours || []).map((c) => c.foreground);",
    to: "    const maskedHexes = [];",
  },
  {
    id: "F42 the verdict TIER (removing it loses the verdict at a small cap)",
    test: F41,
    testfile: "response.test.js",
    file: RESPONSE,
    from: "      const tier = buildVerdictTier(value);",
    to: "      const tier = { success: true };",
  },
  {
    id: "F41 the tier is serialized COMPACT (pretty re-overflows the small cap)",
    test: F41,
    testfile: "response.test.js",
    file: RESPONSE,
    from: "      text = JSON.stringify(tier); // compact: the verdict tier exists to fit a small cap",
    to: "      text = JSON.stringify(tier, null, 2);",
  },
];

// NOT a case here: the F42 control (the note must NOT fire without a masked colour). Measured, the
// outlined control's failing colour is not a blend of the background, and its masked set is empty —
// so the ONLY thing that suppresses the note there is the `maskedHexes.length > 0` scope, which no
// fixture-independent perturbation can make non-empty. The control is asserted in the test itself
// (it proves the note is not blanket) but cannot be perturbed into a failure, so it is not listed.
// This mirrors the round-30 note about the cross-check branch.

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

console.log("\n=== ROUND-34 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-34 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
