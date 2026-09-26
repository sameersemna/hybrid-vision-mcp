// Non-vacuity verification for the TENTH-audit tests (F12: a colour masked
// between the tiling floor and the disclosure gate is masked AND undisclosed).
// Reverts each round-10 guard, confirms the matching test FAILS, then restores.
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
    id: "F12 the disclosure gate is a superset of the masking floor",
    test: "every size in the masked band still SURFACES",
    file: "lib/measure.js",
    // Revert to the round-9 size gate, which is stricter than the mask's own floor
    // and therefore leaves the 0.4%-2% band masked and undisclosed.
    from: "  return mean / regionArea >= PLATEAU_MIN_BLOB_SHARE;",
    to: "  return false; // REVERTED: no colour is disclosable (round-9 gap)",
  },
  {
    id: "F12 the gate is not stricter than the mask (band coverage)",
    test: "every size in the masked band still SURFACES",
    file: "lib/measure.js",
    from: "  return mean / regionArea >= PLATEAU_MIN_BLOB_SHARE;",
    to: "  return mean / regionArea >= LARGE_REGION_AREA_FRACTION; // REVERTED: stricter than the mask (the F12 gap)",
  },
  {
    id: "F12 shape chooses the wording, not whether to disclose",
    test: "shape now chooses the WORDING",
    file: "lib/measure.js",
    from: "              shape: panelShaped ? \"panel-shaped\" : \"text-sized\",",
    to: "              shape: \"panel-shaped\", // REVERTED: no shape distinction",
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

console.log("\n=== ROUND-10 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-10 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
