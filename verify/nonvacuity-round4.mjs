// Non-vacuity verification for the FOURTH-audit acceptance tests (F5 multi-
// panel, §3.1 local_background). Reverts each round-4 guard, confirms the
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
    id: "F5 multi-plateau model is engaged for two panels",
    test: "whole-image contrast reports the failing sidebar text",
    file: "lib/measure.js",
    from: "  const multiPlateau = plateaus.length >= 2;",
    to: "  const multiPlateau = false; // REVERTED: single-background model",
  },
  {
    id: "F5 ring background resolves text against its own panel",
    test: "whole-image contrast reports the failing sidebar text",
    file: "lib/measure.js",
    from: "    const ring = backgrounds\n      ? ringBackground({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })\n      : null;",
    to: "    const ring = null; // REVERTED: no local ring reference",
  },
  {
    id: "F5 dominance test rejects text-as-plateau in a tight crop",
    test: "single-plateau tight region",
    file: "lib/measure.js",
    // ANCHOR REPOINTED (eleventh audit — the anchor had gone stale when `panelShape`
    // was appended in round 8; it broke silently, leaving this guard unreported).
    from: "    const pathA = regionShare >= minShare && dominance >= PLATEAU_DOMINANCE && panelShape;",
    to: "    const pathA = regionShare >= minShare && panelShape; // REVERTED: no component-dominance test",
  },
  {
    id: "F5 flatness test rejects a gradient band as a plateau",
    test: "does not invent plateaus on a gradient",
    file: "lib/measure.js",
    from: "    if (flatness < flatShare) continue;",
    to: "    // REVERTED: no flatness test (so smooth gradient bands become plateaus)",
  },
  // NOTE (round 6): the former "minimum-region test rejects small/AA regions"
  // case was REMOVED as obsolete rather than left vacuous. `detectPlateaus` now
  // has two acceptance paths, and each carries its own size floor
  // (`regionShare >= minShare` for dominant-blob; `PLATEAU_MIN_BLOB_SHARE` per
  // blob with `solid.length >= 2` for tiled — i.e. >= 0.8% minimum). The earlier
  // shared `bucketShare` gate is therefore subsumed, verified by removing it and
  // observing no test change (ACCURACY.md 5g). No successor anchor is possible
  // for the tiled floor without a contrived fixture, because any tiling that
  // satisfies the per-blob floor necessarily exceeds the 2% region floor.
  {
    id: "3.1 local_background is delivered on colours[]",
    test: "every returned colour carries local_background",
    file: "lib/measure.js",
    from: "      local_background: cl.background_reference || null,",
    to: "      // REVERTED: local_background not delivered on colours[]",
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

console.log("\n=== ROUND-4 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-4 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
