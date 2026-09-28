// Non-vacuity verification for the TWENTY-NINTH-audit test (F36: a soft drop shadow — a
// region-sized HOLLOW decoration — was emitted as a second-ink extra carrying hard-coded
// `looks_like_structure: false`, so it bypassed the decorative gate and was reported as
// failing text). Perturbs the F36 fix in lib/measure.js, confirms the matching test FAILS,
// then restores byte-identically. Also asserts the CONSTRUCTION SITE copies the parent's
// structural flags, so a future edit cannot quietly reintroduce the hard-coded `false`s.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F36 = "a soft drop shadow";

// The exact construction-site lines the fix introduced (the durable invariant).
const COPIED_FLAGS = [
  "looks_like_hollow_rectangle: parent.looks_like_hollow_rectangle,",
  "looks_like_straight_segment: parent.looks_like_straight_segment,",
  "looks_like_structure: parent.looks_like_structure,",
];
const HARDCODED_FLAGS = [
  "looks_like_hollow_rectangle: false,",
  "looks_like_straight_segment: false,",
  "looks_like_structure: false,",
];

const cases = [
  {
    id: "F36 the extra copies the parent's structural flags (hard-coding false re-admits the shadow)",
    test: F36,
    file: MEASURE,
    // Revert to the round-25 construction: hard-coded non-structural flags. The shadow's
    // hollow parent yields an extra flagged non-structural, so the decorative gate misses it
    // and it is reported as failing text again.
    from:
      "        looks_like_hollow_rectangle: parent.looks_like_hollow_rectangle,\n" +
      "        looks_like_straight_segment: parent.looks_like_straight_segment,\n" +
      "        looks_like_structure: parent.looks_like_structure,",
    to:
      "        looks_like_hollow_rectangle: false,\n" +
      "        looks_like_straight_segment: false,\n" +
      "        looks_like_structure: false,",
  },
  {
    id: "F36 the copy is FAITHFUL, not a blanket 'always structural' (breaking F28/F32/F34)",
    test: "outlined text reports BOTH colours",
    file: MEASURE,
    // Force EVERY extra structural. Real outlined-text extras (parent stroke, NOT hollow) then
    // become decorative and vanish, so F28's "both colours reported" fails. This proves the
    // fix depends on the parent's ACTUAL flag (hollow shadow vs non-hollow stroke), not on a
    // constant — the same property the F36 test relies on.
    from: "        looks_like_structure: parent.looks_like_structure,",
    to: "        looks_like_structure: true,",
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

// Structural invariant: the extra-construction site must COPY the parent's flags, and must NOT
// hard-code a structural `false` WITHIN THAT LITERAL. Scoped to the extras block (the one that
// carries `multi_colour_of: parent.hex`) — the primary construction legitimately has
// `looks_like_structure: false` as a placeholder before both flags are known.
const src = fs.readFileSync(path.join(ROOT, MEASURE), "utf8");
const anchorIdx = src.indexOf("multi_colour_of: parent.hex");
const blockStart = anchorIdx >= 0 ? src.lastIndexOf("components.push({", anchorIdx) : -1;
const extrasBlock = blockStart >= 0 ? src.slice(blockStart, anchorIdx + "multi_colour_of: parent.hex".length) : "";
const copiesAll = COPIED_FLAGS.every((l) => extrasBlock.includes(l));
const noHardcoded = extrasBlock.length > 0 && HARDCODED_FLAGS.every((l) => !extrasBlock.includes(l));

console.log("\n=== ROUND-29 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(`${(copiesAll ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: extra copies all three parent structural flags (copiesAll=${copiesAll})`);
console.log(`${(noHardcoded ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} CONSTRUCTION-SITE guard: no hard-coded structural \`false\` remains (noHardcoded=${noHardcoded})`);
if (!copiesAll || !noHardcoded) allGood = false;

console.log(allGood ? "\nAll round-29 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
