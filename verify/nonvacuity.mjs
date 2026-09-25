// Non-vacuity verification.
// For each acceptance test, revert the specific fix it depends on, confirm the
// test FAILS, then restore the source. A test that still passes with its fix
// reverted proves nothing.
//
// SAFETY: this script temporarily mutates source files under lib/. It is kept
// OUT of test/ on purpose so `node --test` can never discover and run it.
// Sources are restored after every case; the run aborts if restoration fails.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESTFILE = path.join(ROOT, "test", "accuracy.test.js");

const cases = [
  {
    id: "T1/T4 contrast flagging",
    test: "contrast",
    file: "lib/color.js",
    from: "    wcag_aa: ratio >= requiredAA - 1e-9,",
    to: "    wcag_aa: true, // REVERTED: pretend contrast is always compliant",
  },
  {
    id: "T2 box counting",
    test: "box count",
    file: "lib/measure.js",
    from: "  const mask = maskByColor(pixels, color, tolerance);\n  const components = findComponents(pixels, mask, { minArea });",
    to: "  const mask = new Uint8Array(pixels.width * pixels.height).fill(1); // REVERTED: ignore colour, count everything\n  const components = findComponents(pixels, mask, { minArea });",
  },
  {
    id: "T3 crop containment",
    test: "crop awareness",
    file: "lib/analyze.js",
    from: "    const containmentCrop = { left: 0, top: 0, width: prepared.report.sent_dimensions.width, height: prepared.report.sent_dimensions.height };",
    to: "    const containmentCrop = null; // REVERTED: no crop containment checking",
  },
  {
    id: "T5 quantitative without model",
    test: "model entirely unavailable",
    file: "lib/analyze.js",
    from: "  if (question.quantitative) {\n    const measured = await measureImage({",
    to: "  if (false && question.quantitative) { // REVERTED: always consult the model\n    const measured = await measureImage({",
  },
  {
    id: "T6 schema-constrained request",
    test: "schema validity",
    file: "lib/vision.js",
    from: "  else if (schema) payload.format = schema;",
    to: "  else if (schema) { /* REVERTED: send no format constraint */ }",
  },
  {
    id: "T7 no fabrication from prose",
    test: "abstention is first-class",
    file: "lib/analyze.js",
    from: "  const json = res.json || {};",
    to: "  const json = res.json || { summary: res.raw, claims: [{ claim: res.raw, kind: \"other\", confidence: 0.9 }], abstained: [] }; // REVERTED: trust prose",
  },
  {
    id: "T8 provenance reporting",
    test: "provenance",
    file: "lib/legibility.js",
    from: "    model: model ?? null,",
    to: "    model: null, // REVERTED: drop the model name from provenance",
  },
  {
    id: "T9 pinned streaming sampling",
    test: "determinism",
    file: "lib/vision.js",
    from: "    stream: true,",
    to: "    stream: false, // REVERTED: no streaming => no load-vs-infer signal",
  },
  {
    id: "T10 actionable timeout hint",
    test: "timeout is fast",
    file: "lib/vision.js",
    from: "  const err = new Error(lines.join(\"\\n\"));",
    to: "  const err = new Error(`Ollama request timed out after 180000ms. Try a lighter model (e.g., llava:7b), reduce image size, or increase OLLAMA_TIMEOUT_MS.`); // REVERTED",
  },
];

function runTest(pattern) {
  const r = spawnSync(
    process.execPath,
    ["--test", `--test-name-pattern=${pattern}`, TESTFILE],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

const results = [];
for (const c of cases) {
  const filePath = path.join(ROOT, c.file);
  const original = fs.readFileSync(filePath, "utf8");

  // 1. Baseline: with the fix in place the test must pass.
  const before = runTest(c.test);

  // 2. Revert the fix.
  if (!original.includes(c.from)) {
    results.push({ id: c.id, error: `anchor not found in ${c.file}` });
    continue;
  }
  fs.writeFileSync(filePath, original.replace(c.from, c.to), "utf8");

  // 3. The test must now FAIL.
  const after = runTest(c.test);

  // 4. Restore.
  fs.writeFileSync(filePath, original, "utf8");

  results.push({
    id: c.id,
    test: c.test,
    passesWithFix: before.ok,
    failsWithoutFix: !after.ok,
    nonVacuous: before.ok && !after.ok,
  });
}

console.log("\n=== NON-VACUITY REPORT ===");
let allGood = true;
for (const r of results) {
  if (r.error) { console.log(`ERR  ${r.id}: ${r.error}`); allGood = false; continue; }
  const tag = r.nonVacuous ? "NON-VACUOUS" : "VACUOUS/UNRELIABLE";
  if (!r.nonVacuous) allGood = false;
  console.log(`${tag.padEnd(18)} ${r.id}  (pass-with-fix=${r.passesWithFix}, fail-without-fix=${r.failsWithoutFix})`);
}
console.log(allGood ? "\nAll tests confirmed non-vacuous." : "\nSOME TESTS ARE VACUOUS — investigate.");
process.exitCode = allGood ? 0 : 1;
