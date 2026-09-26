// Non-vacuity verification for the FIFTEENTH-audit tests (F17: the prose guard's own
// scope claim was broader than its rule — it caught the literal wording, not any
// paraphrase). Perturbs each round-15 guard, confirms the matching test FAILS, then
// restores byte-identically.
//
// SAFETY: mutates test/ AND lib/ temporarily. Kept OUT of test/ discovery — this file
// lives in verify/, and `node --test` only auto-runs test/.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const cases = [
  {
    id: "F17 the prose guard catches the LITERAL regression",
    test: "prose guard catches live claims",
    file: "ACCURACY.md",
    // Inject an un-retracted claim; the guard must fail.
    from: "\n## 9. New module map",
    to: "\n`plateau_share` orders decoration from a glyph run.\n\n## 9. New module map",
  },
  {
    id: "F17 the structural disclaimer must be PRESENT (fix #4)",
    test: "prose guard catches live claims",
    file: "README.md",
    // README carries the "not decoration from text" disclaimer in exactly ONE place, so
    // removing it must fail the positive assertion (b). (lib/measure.js carries it twice,
    // so reverting one occurrence there would not falsify the assertion.)
    from: "not decoration from text",
    to: "not large from small",
  },
  {
    id: "F17 scanning index.js is load-bearing (future-proofing case)",
    test: "prose guard catches live claims",
    file: "index.js",
    // index.js reaches callers through the tool schema and is now scanned. Inject a
    // claim there; the guard must fail, proving the newly-added file is real coverage
    // and not a dead entry in the list.
    from: "import { measureImage, analyzeStructured } from \"./lib/analyze.js\";",
    to: "import { measureImage, analyzeStructured } from \"./lib/analyze.js\";\n// plateau_share orders decoration from a glyph run.",
  },
  // NOTE (round 15): the F17 "guard's own recall is measured against paraphrases" test
  // is NOT guarded here, deliberately. It asserts that a RULE — defined inline in the
  // test from string fixtures — flags 9 paraphrases and allows 3 legitimate lines. No
  // single lib/ source line can be reverted to fail it (the rule is not imported), so an
  // anchor for it would be vacuous by construction — the exact anti-pattern this harness
  // exists to catch. Its sibling guard's behaviour is proven non-vacuous by the cases
  // above; the two F16 measured-ordering tests are likewise unguarded for the same
  // reason (documented in nonvacuity-round14.mjs).
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
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }

  results.push({
    id: c.id,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== ROUND-15 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-15 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
