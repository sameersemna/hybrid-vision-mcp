// Non-vacuity verification for the TWENTY-FIRST-audit tests (F27: a text-free gradient
// was reported as FAILING text; F28: outlined text's darker colour was absorbed).
// Perturbs each round-21 guard in lib/measure.js, confirms the matching test FAILS,
// then restores byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";

const cases = [
  {
    id: "F27 the abstain-on-inadequate-fit branch (disabling it re-asserts the ramp failure)",
    test: "F27: a text-free gradient must not be reported as FAILING text",
    file: MEASURE,
    // Neuter the whole inadequate-fit arbitration: the text-free gradient then keeps
    // `measurable:true all_meet_aa:false`, which the test forbids.
    from: "  if (\n    !allMeetAA &&\n    backgroundMode === \"global\" &&\n    !multiPlateau &&\n    !explicitBg &&\n    backgroundFit &&\n    backgroundFit.applicable &&\n    !backgroundFit.adequate\n  ) {",
    to: "  if (\n    false &&\n    !allMeetAA &&\n    backgroundMode === \"global\" &&\n    !multiPlateau &&\n    !explicitBg &&\n    backgroundFit &&\n    backgroundFit.applicable &&\n    !backgroundFit.adequate\n  ) {",
  },
  {
    id: "F27 the local-measurable guard (treating local as unmeasurable must change with-text behaviour)",
    test: "F27: a text-free gradient must not be reported as FAILING text",
    file: MEASURE,
    // Make the branch ALWAYS take the abstain path, even when local finds text — the
    // gradient-with-text control then loses its measurable verdict.
    from: "    if (!local.measurable) {\n      const enumerated = evaluated",
    to: "    if (true || !local.measurable) {\n      const enumerated = evaluated",
  },
  {
    id: "F28 the extra-colour emission (dropping it re-hides the outlined fill)",
    test: "F28: outlined text reports BOTH colours, and a failure cannot hide",
    file: MEASURE,
    // Emit no extras at all: the dark fill vanishes from every channel and the verdict
    // reads clean, exactly the F28 defect. (Round 22 moved emission to a deferred pass.)
    from: "    for (const extra of extras) {\n      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
    to: "    for (const extra of []) {\n      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
  },
  {
    id: "F28 the absolute pixel floor (removing it lets AA fragments through)",
    test: "F28: outlined text reports BOTH colours, and a failure cannot hide",
    file: MEASURE,
    // With no floor, sub-threshold fragment "colours" appear; the test's census
    // assertions (larger ink wins) must fail. (Round 22 applies the floor to the TOTAL.)
    from: "      if ((extraTotals.get(extra.key) || 0) < MULTICOLOUR_MIN_PIXELS) continue;",
    to: "      if (false) continue;",
  },
  {
    id: "F28 the parent-box gate (region-spanning blobs must not spawn second-ink colours)",
    test: "local background mode recovers text colours a global background misses",
    file: MEASURE,
    // Drop the parent-box gate: a region-spanning gradient blob yields the photographic
    // fixture's pink tone as an extra, and the global bright-tone count changes.
    from: "    const parentIsGlyphSized =\n      boxW * boxH <= MULTICOLOUR_PARENT_MAX_BOX_FRACTION * scanArea;",
    to: "    const parentIsGlyphSized = true;",
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
  fs.writeFileSync(filePath, c.global ? original.split(c.from).join(c.to) : original.replace(c.from, c.to), "utf8");
  const after = runTest(c.test);
  fs.writeFileSync(filePath, original, "utf8");
  if (fs.readFileSync(filePath, "utf8") !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }
  results.push({ id: c.id, passesWithFix: before.ok, failsWithoutFix: !after.ok, nonVacuous: before.ok && !after.ok });
}

console.log("\n=== ROUND-21 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-21 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
