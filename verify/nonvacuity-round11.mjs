// Non-vacuity verification for the ELEVENTH-audit tests (F13: the round-10
// "structural guarantee" was FALSE — the disclosure gate compared a MEAN against
// the mask's SINGLE-BLOB floor, so a colour masked by one >=2% blob but dragged
// below 0.4% mean by many small companions was masked AND undisclosed).
// Reverts each round-11 guard, confirms the matching test FAILS, then restores.
//
// SAFETY: mutates source under lib/ temporarily. Kept OUT of test/ so
// `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");

const PREDICATE = "export function isDisclosableDroppedColour(colour, regionArea) {\n  return true;\n}";

const cases = [
  {
    id: "F13(a) a drop-cap plus small glyphs of ONE failing colour is disclosed",
    test: "F13\\(a\\): a drop-cap plus small glyphs",
    file: "lib/measure.js",
    // ANCHOR REPOINTED (twelfth audit). The union was replaced by an unconditional
    // predicate; reverting it to "never disclose" reproduces the omission F13(a)
    // guards against (in the round-10/11 form the mean clause hid the drop-cap).
    from: PREDICATE,
    to: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return false; // REVERTED: the F13 omission\n}",
  },
  {
    id: "F13(b) an empty masked result still discloses",
    test: "F13\\(b\\): a solid panel plus fragments",
    file: "lib/measure.js",
    from: PREDICATE,
    to: "export function isDisclosableDroppedColour(colour, regionArea) {\n  return false; // REVERTED: the F13 omission\n}",
  },
  {
    id: "F13 the round-10 guarantee is retracted (no size gate at all)",
    test: "the round-10 guarantee is RETRACTED",
    file: "lib/measure.js",
    // Reintroduce the retracted mean-only gate: it must make the retraction test
    // fail, proving the test pins the REMOVAL rather than merely re-asserting it.
    from: PREDICATE,
    to: "export function isDisclosableDroppedColour(colour, regionArea) {\n  const mean = colour.component_count ? colour.pixel_count / colour.component_count : colour.pixel_count;\n  return mean / regionArea >= PLATEAU_MIN_BLOB_SHARE; // REVERTED: the retracted mean-only gate\n}",
  },
  {
    id: "F13 the disclosed entry says WHY the mask reached the colour",
    test: "carries the plateau EVIDENCE",
    file: "lib/measure.js",
    from: "              detected_plateau: matched !== null,",
    to: "              detected_plateau: false, // REVERTED: does not say the colour was a plateau",
  },
  {
    id: "F13 the disclosed entry carries the largest-blob share",
    test: "carries the plateau EVIDENCE",
    file: "lib/measure.js",
    from: "              largest_component_share: matched ? matched.largest_component_share ?? null : null,",
    to: "              largest_component_share: null, // REVERTED: omits the decisive number",
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

console.log("\n=== ROUND-11 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll round-11 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
