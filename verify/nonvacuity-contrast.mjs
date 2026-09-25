// Non-vacuity verification for the contrast-enumeration acceptance tests.
// Reverts each fix the tests depend on, confirms the test FAILS, restores.
//
// SAFETY: mutates source under lib/ temporarily. Kept OUT of test/ so
// `node --test` can never discover and run it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "contrast.test.js");

const cases = [
  {
    id: "T1 worst-case selection",
    test: "reports the worst case",
    file: "lib/measure.js",
    // Revert to the original bug: headline = BEST (most legible) colour.
    from: "    contrast_ratio: worst.contrast_ratio,",
    to: "    contrast_ratio: best.contrast_ratio, // REVERTED: report the most legible colour",
  },
  {
    id: "T1 wcag_aa aliases worst case",
    test: "reports the worst case",
    file: "lib/measure.js",
    from: "    wcag_aa: all_meet_aa,",
    to: "    wcag_aa: true, // REVERTED: pretend AA is met",
  },
  {
    id: "T1 enumerates all colours",
    test: "enumerates every text colour",
    file: "lib/measure.js",
    from: "    colours: evaluated,",
    to: "    colours: evaluated.slice(evaluated.length - 1), // REVERTED: only the best colour",
  },
  {
    id: "T1b near-background text detected",
    test: "enumerates every text colour",
    file: "lib/measure.js",
    // The caller's default threshold is what makes a 1.04:1 string (~7 RGB units
    // from the background) detectable in the enumeration.
    from: "  const clusterTolerance = opts.clusterTolerance ?? opts.tolerance ?? 16;\n  const inkThreshold = opts.inkThreshold ?? 4;",
    to: "  const clusterTolerance = opts.clusterTolerance ?? opts.tolerance ?? 16;\n  const inkThreshold = opts.inkThreshold ?? 24; // REVERTED: original tolerance drops 1.04:1 text",
  },
  {
    id: "T4 no hardcoded failure",
    test: "only text colour passes AA",
    file: "lib/measure.js",
    from: "    all_meet_aa: allMeetAA,",
    to: "    all_meet_aa: false, // REVERTED: always claim failure",
  },
  {
    id: "T5 structured surfaces failures",
    test: "exposes failing colours",
    file: "lib/analyze.js",
    from: "      measurements: measured.measurements,",
    to: "      measurements: { contrast: { contrast_ratio: 13.42, wcag_aa: true, colours: [] } }, // REVERTED: single passing ratio",
  },
  {
    id: "AA merge renderer independence",
    test: "renderer independence",
    file: "lib/measure.js",
    from: "  const { clusters: finalClusters, merged_anti_aliasing: mergedAA } =\n    mergeAntiAliasing(textClusters, background);",
    to: "  const { clusters: finalClusters, merged_anti_aliasing: mergedAA } = { clusters: textClusters, merged_anti_aliasing: [] }; // REVERTED: no AA merge",
  },
  {
    id: "AA blend discriminator protects dark text",
    test: "never swallow real text",
    file: "lib/measure.js",
    from: "  return t > minT && t < maxT && residual < maxResidual;",
    to: "  return residual < maxResidual; // REVERTED: ignores blend fraction, swallows dark text",
  },
  {
    id: "§3.5 text_items includes OCR results",
    test: "labelled by source and contested",
    file: "lib/crossvalidate.js",
    from: "  for (const o of ocrOnly) {\n    items.push({",
    to: "  for (const o of []) { // REVERTED: text_items excludes OCR-only strings\n    items.push({",
  },
  {
    id: "§3.5 contested unreadable claims",
    test: "labelled by source and contested",
    file: "lib/analyze.js",
    from: "    } else if (generic && !namesSomething && ocrWords.length > 0) {",
    to: "    } else if (false) { // REVERTED: never flag a blanket unreadable claim",
  },
  {
    id: "§3.5 unreadable carries a source label",
    test: "labelled by source and contested",
    file: "lib/analyze.js",
    from: "    const entry = {\n      text,\n      source: \"model\",",
    to: "    const entry = {\n      text,\n      source: undefined, // REVERTED: no provenance on the claim",
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

  // Belt-and-braces: confirm the restore actually took.
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

console.log("\n=== CONTRAST NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR  ${r.id}: ${r.error}`); allGood = false; continue; }
  if (!r.nonVacuous) allGood = false;
  console.log(
    `${(r.nonVacuous ? "NON-VACUOUS" : "VACUOUS").padEnd(14)} ${r.id}  ` +
      `(pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`,
  );
}
console.log(allGood ? "\nAll contrast tests confirmed non-vacuous." : "\nSOME TESTS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
