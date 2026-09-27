// Non-vacuity verification for the NINETEENTH-audit tests (F24: a marker with no sentence
// end waived the entire remainder; F25: legitimate retractions were false positives, and
// the GLUE list restores them). Perturbs each round-19 guard, confirms the matching test
// FAILS, then restores byte-identically.
//
// SAFETY: mutates test-support/ temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const GUARD = "test-support/prose-guard.mjs";

const cases = [
  {
    id: "F24 a marker with no sentence end must waive only its quoted span",
    test: "marker with NO sentence end",
    file: GUARD,
    // Revert the no-sentence-end branch to "waive the rest": H2 must escape.
    from: "    const quoted = afterMarker.match(/^\\s*[`\"'\\u201c\\u2018]([^`\"'\\u201d\\u2019]*)[`\"'\\u201d\\u2019]/);\n    const remainder = quoted ? afterMarker.slice(quoted[0].length) : afterMarker;",
    to: "    const remainder = \"\"; // REVERTED: no sentence end => marker waives the rest",
  },
  {
    id: "F25 retractions with a GLUE word must be allowed",
    test: "STRONG negation must GOVERN the verb",
    file: GUARD,
    // Empty the GLUE list: the retractions become false positives again.
    from: "const GLUE = /^(?:able|intended|used|going|supposed|meant|said|claimed|thought|designed|expected|allowed|permitted|attempt|attempts|try|tries|seek|seeks|likely|meant|destined|equipped|built|written)$/i;",
    to: "const GLUE = /^(?:zzznevermatch)$/i; // REVERTED: no glue words",
  },
  {
    id: "F25 the polarity reference: `never fails to` must stay flagged",
    test: "STRONG negation must GOVERN the verb",
    file: GUARD,
    // Add `fail|fails` to GLUE: it inverts polarity, so `never fails to order` is excused
    // and the polarity assertion fails.
    from: "const GLUE = /^(?:able|intended|used|going|supposed|meant|said|claimed|thought|designed|expected|allowed|permitted|attempt|attempts|try|tries|seek|seeks|likely|meant|destined|equipped|built|written)$/i;",
    to: "const GLUE = /^(?:able|fail|fails|$)^/i; // REVERTED: fail(s) added (inverts polarity)",
  },
  {
    id: "F24/F25 the docs must carry 0 claims (the primary positive gate holds)",
    test: "docs carry 0 flags",
    file: "ACCURACY.md",
    // Inject a live claim; the docs-are-clean assertion must fail.
    from: "\n## 9. New module map",
    to: "\nplateau_share orders decoration from a glyph run.\n\n## 9. New module map",
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
  if (fs.readFileSync(filePath, "utf8") !== original) {
    results.push({ id: c.id, error: "RESTORE FAILED — file not byte-identical after revert" });
    continue;
  }
  results.push({ id: c.id, passesWithFix: before.ok, failsWithoutFix: !after.ok, nonVacuous: before.ok && !after.ok });
}

console.log("\n=== ROUND-19 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-19 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
