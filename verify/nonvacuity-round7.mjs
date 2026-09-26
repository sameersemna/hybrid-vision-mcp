// Non-vacuity verification for the SEVENTH-audit acceptance tests (F8: a text
// colour accepted as a plateau and masked). Reverts each round-7 guard, confirms
// the matching test FAILS, then restores.
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
    id: "F8 inset hollow blobs are rejected as plateaus",
    test: "huge identical glyphs are reported as failing text",
    file: "lib/measure.js",
    from: "    const panelShape = b.touchesBorder || b.fill >= PLATEAU_SOLID_FILL;",
    to: "    const panelShape = true; // REVERTED: any blob may be a plateau",
  },
  {
    id: "F8 hard-edged glyphs are not 'no text was found'",
    test: "hard-edged glyphs are not reported as",
    file: "lib/measure.js",
    from: "    const panelShape = b.touchesBorder || b.fill >= PLATEAU_SOLID_FILL;",
    to: "    const panelShape = true; // REVERTED: any blob may be a plateau",
  },
  {
    id: "F8 plateaus_without_text never lists a text colour",
    test: "never lists a colour that is itself text",
    file: "lib/measure.js",
    from: "    const panelShape = b.touchesBorder || b.fill >= PLATEAU_SOLID_FILL;",
    to: "    const panelShape = true; // REVERTED: any blob may be a plateau",
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

console.log("\n=== ROUND-7 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-7 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
