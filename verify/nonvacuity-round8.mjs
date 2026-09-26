// Non-vacuity verification for the EIGHTH-audit acceptance tests (F10: an inset
// content-dense panel hides a failing text colour). Reverts each round-8 guard,
// confirms the matching test FAILS, then restores.
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
    id: "F10 panel shape uses hole SHAPE, not raw fill",
    test: "content-dense inset panel still reports its failing text",
    file: "lib/measure.js",
    from: "    const isRing = !b.touchesBorder && b.largestHoleFrac >= RING_HOLE_FRACTION;",
    to: "    const isRing = !b.touchesBorder && b.fill < PLATEAU_SOLID_FILL; // REVERTED: fill-based",
  },
  {
    id: "F8 repeated glyphs rejected by the dominance floor",
    test: "repeated large glyphs report the REAL text colour",
    file: "lib/measure.js",
    from: "const PLATEAU_DOMINANCE = 0.6;",
    to: "const PLATEAU_DOMINANCE = 0.5; // REVERTED: repeated glyphs pass at 0.5",
  },
  {
    id: "F10 mask reconciliation discloses dropped failing colours",
    test: "a shape test cannot resolve solid glyphs",
    file: "lib/measure.js",
    from: "  if (plateauFills.length > 0 || multiPlateau) {",
    to: "  if (false) { // REVERTED: no un-masked reconciliation",
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

console.log("\n=== ROUND-8 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-8 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
