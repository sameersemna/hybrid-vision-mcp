// Non-vacuity verification for the background-mode tests.
// Reverts each fix the tests depend on, confirms the test FAILS, restores.
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
    id: "flat equivalence: local collapses to floor",
    test: "IDENTICAL to global on a flat fixture",
    file: "lib/measure.js",
    from: "        const t = Math.max(inkThreshold, noiseFactor * f.s);",
    to: "        const t = inkThreshold + 40; // REVERTED: local mode no longer collapses to the floor",
  },
  {
    id: "tile field measures noise",
    test: "zero noise scale on a flat image",
    file: "lib/measure.js",
    from: "      scale[ty][tx] = MAD_TO_SIGMA * dev[dev.length >> 1];",
    to: "      scale[ty][tx] = 99; // REVERTED: fake noise scale",
  },
  {
    id: "background-fit warning is emitted",
    test: "cannot explain the image",
    file: "lib/measure.js",
    // The test asserts on the note pushed into the enumeration result, so the
    // revert must target that site (not assessBackgroundFit's own warnings).
    from: "  if (backgroundFit && !backgroundFit.adequate) {",
    to: "  if (false) { // REVERTED: never disclose an inadequate background model",
  },
  {
    id: "background-fit threshold detects flat images",
    test: "NOT warned about",
    file: "lib/measure.js",
    from: "    adequate: frac >= 0.5,",
    to: "    adequate: false, // REVERTED: always claim the background is inadequate",
  },
  {
    id: "local mode recovers photographic text",
    test: "recovers text colours a global background misses",
    file: "lib/measure.js",
    from: "  const field = backgroundMode === \"local\" ? tileBackgroundField(pixels, tileSize) : null;",
    to: "  const field = null; // REVERTED: local mode no longer uses a local background",
  },
  {
    id: "options are honoured and echoed",
    test: "configurable and echoed",
    file: "lib/measure.js",
    from: "    tile_size: field ? tileSize : null,",
    to: "    tile_size: null, // REVERTED: never report the tile size used",
  },
  {
    id: "default path stays global",
    test: "opt-in rather than automatic",
    file: "lib/measure.js",
    from: "  const backgroundMode = opts.backgroundMode === \"local\" ? \"local\" : \"global\";",
    to: "  const backgroundMode = \"local\"; // REVERTED: local mode is applied unconditionally",
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

  const before = runTest(c.test);
  if (!original.includes(c.from)) {
    results.push({ id: c.id, error: `anchor not found in ${c.file}` });
    continue;
  }
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
    test: c.test,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== BACKGROUND NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR  ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll background tests confirmed non-vacuous." : "\nSOME TESTS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
