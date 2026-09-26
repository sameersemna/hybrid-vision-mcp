// Non-vacuity verification for the SIXTH-audit acceptance tests (F7 tiled
// layouts / large background regions). Reverts each round-6 guard, confirms the
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
    id: "F7 tiling path recognises a repeated card fill",
    test: "card fill is recognised as a plateau by the TILING path",
    file: "lib/measure.js",
    from: "      pathB = sizeCv <= PLATEAU_SIZE_CV;",
    to: "      pathB = false; // REVERTED: no tiling path",
  },
  {
    id: "F7 tiling requires solid blobs (not text)",
    test: "card fill is recognised as a plateau by the TILING path",
    file: "lib/measure.js",
    from: "      (c) => c.area / total >= PLATEAU_MIN_BLOB_SHARE && c.fill >= PLATEAU_SOLID_FILL,",
    to: "      (c) => c.pixel_count >= 0, // REVERTED: no solidity/size requirement",
  },
  {
    id: "F7 straight-segment test rejects card borders",
    test: "card borders are not reported as failing text",
    file: "lib/measure.js",
    from: "      justPushed.looks_like_hollow_rectangle || justPushed.looks_like_straight_segment;",
    to: "      justPushed.looks_like_hollow_rectangle; // REVERTED: only 2-D hollow shapes",
  },
  {
    id: "F7 large-background-region backstop",
    test: "textured page",
    file: "lib/measure.js",
    from: "    if (!isLargeBackgroundRegion(e, regionArea)) return true;",
    to: "    if (true) return true; // REVERTED: no large-region backstop",
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

console.log("\n=== ROUND-6 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-6 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
