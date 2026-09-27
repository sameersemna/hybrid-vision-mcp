// Non-vacuity verification for the TWENTY-THIRD-audit tests (F30: the second-ink floor was
// 28x stricter than the primary floor; F31: the per-total floor aggregated card/text AA
// fringes into a false failure). Perturbs each round-23 guard in lib/measure.js, confirms the
// matching test FAILS, then restores byte-identically.
//
// SAFETY: mutates lib/measure.js temporarily. Kept OUT of test/ discovery.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "background.test.js");
const MEASURE = "lib/measure.js";
const F30 = "the second-ink floor is the SAME quantity as the primary floor";
const F31 = "dense small text on cards does not accumulate AA fringes";

const cases = [
  {
    id: "F30 the unified floor (a 224 scalar instead of the primary floor hides the 30px fill)",
    test: F30,
    file: MEASURE,
    // Re-introduce the round-22 scalar: the 30px outlined fill (221px) drops under it and the
    // second-ink side of the invariance pair fails. (The primary floor is threaded down, so
    // the perturbation must be on the shared DEFAULT itself.)
    from: "  const multicolourFloor = opts.minColourPixels ?? DEFAULT_MIN_COLOUR_PIXELS;",
    to: "  const multicolourFloor = 224;",
  },
  {
    id: "F31 the colour-aware AA window (the conservative 0.25 window re-admits off-line shades)",
    test: "huge identical glyphs",
    file: MEASURE,
    // Restore the general merge path's conservative window: the card->text fringes at
    // t=0.048..0.994 slip through again and the dashboard flips to failing.
    from: "const MULTICOLOUR_AA_OPTS = { minT: 0, maxT: 1 };",
    to: "const MULTICOLOUR_AA_OPTS = { minT: 0.25, maxT: 0.98 };",
  },
  {
    id: "F31 the structural (mean-area) gate (removing it re-admits fragmented decoration)",
    test: "card borders are not reported as failing text",
    file: MEASURE,
    // Drop the structural gate: at the shared floor the dense-flat card strokes (7-8 tiny
    // fragments) aggregate into a reported colour and the F7 verdict fails.
    from: "      if (total / comps < minMulticolourMeanArea) continue;",
    to: "      if (false && total / comps < minMulticolourMeanArea) continue;",
  },
  {
    id: "F29 the per-colour TOTAL aggregation (a per-piece floor re-hides the split fill)",
    test: "small outlined text is not lost when its fill splits across components",
    file: MEASURE,
    // At the unified floor 8 the total and the piece coincide (no piece is <8px), so the
    // aggregation only bites at a LARGER floor. Perturb BOTH: raise the floor and revert to
    // the per-piece test; then 48px's 400+485 pieces are each <512 and the fill vanishes.
    from: "      if (total < multicolourFloor) continue;",
    to: "      if (extra.count < 512) continue;",
  },
  {
    id: "F31 the plateau-adjacency gate (plateau-adjacent shades must not become second ink)",
    test: "card borders are not reported as failing text",
    file: MEASURE,
    from: "      if (backgrounds && backgrounds.some((b) => rgbDistance(rgb2, b) <= PLATEAU_MERGE_DIST)) continue;",
    to: "      if (false && backgrounds && backgrounds.some((b) => rgbDistance(rgb2, b) <= PLATEAU_MERGE_DIST)) continue;",
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

console.log("\n=== ROUND-23 NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR            ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(`${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll round-23 guards confirmed non-vacuous." : "\nSOME GUARDS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
