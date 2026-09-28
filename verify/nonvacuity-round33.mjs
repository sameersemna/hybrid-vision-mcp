// Non-vacuity verification for the THIRTY-THIRD-audit fixes (F40: the service carried its own
// cluster tolerance, so the tested path and the shipped path diverged; plus the cause-(b)
// disclosure). Perturbs each fix in lib/measure.js / lib/analyze.js, confirms the matching test
// FAILS, then restores byte-identically.
//
// SAFETY: mutates lib/measure.js and lib/analyze.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const ANALYZE = "lib/analyze.js";
const F40 = "the service entry point and the library agree";

const cases = [
  {
    id: "F40 the service defers to the library default (a service default of 24 re-opens the split)",
    test: F40,
    file: ANALYZE,
    from: "    tolerance = undefined,",
    to: "    tolerance = 24,",
  },
  {
    id: "F40 the library default is the shared constant (a different value re-splits the two paths)",
    test: F40,
    file: MEASURE,
    from: "export const DEFAULT_CLUSTER_TOLERANCE = 16;",
    to: "export const DEFAULT_CLUSTER_TOLERANCE = 24;",
  },
  {
    id: "F40 cluster_tolerance is surfaced (removing it hides the parameter that changes worst)",
    test: F40,
    file: MEASURE,
    from: "    cluster_tolerance: clusterTolerance,",
    to: "",
  },
  {
    id: "cause (b) disclosure (removing the note returns a silent clean pass)",
    test: F40,
    file: MEASURE,
    from: "          `Contrast here could not be measured independently: the per-tile (local) model enumerated ` +",
    to: "          `DISABLED` +",
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

// Structural invariant: analyze.js must NOT contain a numeric tolerance default.
const analyzeSrc = fs.readFileSync(path.join(ROOT, ANALYZE), "utf8");
const noLocalDefault = !/tolerance = \d+/.test(analyzeSrc);
const measureSrc = fs.readFileSync(path.join(ROOT, MEASURE), "utf8");
const singleConstant = /export const DEFAULT_CLUSTER_TOLERANCE = 16;/.test(measureSrc) &&
  /opts\.clusterTolerance \?\? opts\.tolerance \?\? DEFAULT_CLUSTER_TOLERANCE/.test(measureSrc);

console.log("\n=== ROUND-33 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(`${(noLocalDefault ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: analyze.js carries NO numeric tolerance default (noLocalDefault=${noLocalDefault})`);
console.log(`${(singleConstant ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: measure.js has ONE named constant used as the fallback (singleConstant=${singleConstant})`);
if (!noLocalDefault || !singleConstant) allGood = false;

console.log(allGood ? "\nAll round-33 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
