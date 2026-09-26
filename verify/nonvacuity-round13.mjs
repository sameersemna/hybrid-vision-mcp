// Non-vacuity verification for the THIRTEENTH-audit tests (F15: the `shape` label
// was `mean = total / N` again — F14's defect one layer up — so it was removed and
// the tests assert the RAW evidence is carried and `shape` is absent). Reverts each
// round-13 guard, confirms the matching test FAILS, then restores.
//
// SAFETY: mutates source under lib/ temporarily. Kept OUT of test/ so
// `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const LARGEST_LINE = "              largest_component_share: matched ? matched.largest_component_share ?? null : null,";
const PLATEAU_LINE = "              plateau_share: matched ? matched.share : null,";

const cases = [
  {
    id: "F15 the A/B pair carries raw evidence and `shape` is ABSENT",
    test: "the A/B pair is disclosed with the RAW EVIDENCE",
    file: "lib/measure.js",
    // Re-introduce the removed `shape` label: the pair test asserts its absence.
    from: LARGEST_LINE,
    to: LARGEST_LINE + "\n              shape: \"text-sized\", // REVERTED: the removed label",
  },
  {
    id: "F15 the fragmentation sweep reports no `shape`",
    test: "the fragmentation sweep shows",
    file: "lib/measure.js",
    from: LARGEST_LINE,
    to: LARGEST_LINE + "\n              shape: \"text-sized\", // REVERTED: the removed label",
  },
  {
    id: "F15 plateau_share (the fragmentation-invariant field) is carried",
    test: "the A/B pair is disclosed with the RAW EVIDENCE",
    file: "lib/measure.js",
    // Drop the invariant field that orders decoration from text.
    from: PLATEAU_LINE,
    to: "              plateau_share: null, // REVERTED: drops the invariant field",
  },
  // NOTE (round 13): the \"no geometric scalar separates a bar chart from a glyph run\"
  // test is NOT guarded here, deliberately. It is a pure arithmetic assertion about
  // the measured fixture numbers (meanShare(A) > meanShare(B), |largest_A -
  // largest_B| small, both largest/total < 0.5) and has NO dependency on
  // lib/measure.js, so no source revert can fail it. Its failure mode is a wrong
  // measurement, not a code regression. Adding a revert anchor for it would be
  // vacuous by construction, which is the exact anti-pattern this harness exists to
  // catch. Documented rather than left as a vacuous placeholder.
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

console.log("\n=== ROUND-13 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-13 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
