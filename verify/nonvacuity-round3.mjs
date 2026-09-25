// Non-vacuity verification for the THIRD-audit acceptance tests (F1-F4).
// Reverts each round-3 guard, confirms the specific test FAILS, then restores.
//
// SAFETY: mutates source under lib/ and verify/ temporarily. Kept OUT of test/
// so `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const cases = [
  {
    id: "F1 mode consistency: contrast & all agree",
    test: "region-less contrast agrees",
    file: "lib/analyze.js",
    from: "    measurements.contrast = m;",
    to:
      "    if (mode === \"contrast\" && !region) { abstained.push({ question: \"contrast ratio\", reason: \"no region supplied (REVERTED)\" }); } else { measurements.contrast = m; }",
  },
  {
    id: "F2 local mode has no single background",
    test: "reports no single background colour",
    file: "lib/measure.js",
    from:
      "  const backgroundOut = backgroundMode === \"local\"\n    ? null\n    : { hex: toHex(background), rgb: background };",
    to: "  const backgroundOut = { hex: toHex(background), rgb: background }; // REVERTED: always present a single background",
  },
  {
    id: "F2 noise clusters are separated from text",
    test: "1-component low-contrast blob",
    file: "lib/measure.js",
    from: "  if (backgroundMode !== \"local\") return { kept: [...evaluated], suspected: [] };",
    to: "  if (true) return { kept: [...evaluated], suspected: [] }; // REVERTED: never separate suspected noise",
  },
  {
    id: "F4 structural guard prevents text-run folding",
    test: "structural guard stops the fold",
    file: "lib/measure.js",
    from: "            !looksLikeIndependentText(c, k) &&",
    to: "            true && // REVERTED: no structural guard",
  },
  {
    id: "F3 verify script probes the deployed port",
    test: "discovers the service port",
    file: "verify/verify-background-live.mjs",
    from: "  [process.env.PORT ? Number(process.env.PORT) : null, 11402, 11499].filter((p) => Number.isFinite(p)),",
    to: "  [process.env.PORT || 11499].filter((p) => Number.isFinite(p)), // REVERTED: hard-coded test port only",
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
    test: c.test,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== ROUND-3 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-3 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
