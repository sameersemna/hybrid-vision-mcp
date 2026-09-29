#!/usr/bin/env node
/**
 * review-harness.mjs — one command that runs every DETERMINISTIC check this audit loop
 * performs by hand, and exits non-zero if anything regressed.
 *
 * It replaces the back-and-forth for everything that has a ground truth:
 *   - deploy currency (service vs source, by CONTENT not mtime)
 *   - npm test + every non-vacuity guard (with the harness's OWN verdict parsed)
 *   - the live harness against the deployed port
 *   - the standing regression set (documented verdicts per fixture)
 *   - the parameter sweeps that have produced findings (tolerance x fixture,
 *     font size on a blend line, colour distance from the page, response cap)
 *   - channel enumeration for a colour (the "is it disclosed ANYWHERE" test)
 *   - the blend/line test (is a colour real ink or an anti-aliasing blend)
 *
 * What it deliberately does NOT do: decide whether a note's prose is warranted, or
 * whether a behaviour change is intended. Those are printed as EVIDENCE for a human.
 *
 * Usage:
 *   node verify/review-harness.mjs                 # full run, human summary
 *   node verify/review-harness.mjs --json          # machine-readable
 *   node verify/review-harness.mjs --verbose       # include every sweep row
 *   node verify/review-harness.mjs --port 11498    # live probe against scratch
 *   node verify/review-harness.mjs --baseline verify/review-baseline.json
 *                                                 # compare against a saved baseline
 *   node verify/review-harness.mjs --save-baseline verify/review-baseline.json
 *
 * Exit codes: 0 = all deterministic checks pass; 1 = at least one FAIL; 2 = harness error.
 */
import { spawnSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const VERBOSE = flag("--verbose");
const JSON_OUT = flag("--json");
const PORT = opt("--port", "11402");
const SAVE = opt("--save-baseline", null);
const BASELINE = opt("--baseline", null);

const results = [];
const record = (section, name, ok, detail) => results.push({ section, name, ok, detail });
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

// ---------------------------------------------------------------------------
// 1. Deploy currency — compare CONTENT, never mtime
// ---------------------------------------------------------------------------
function checkDeploy() {
  const st = sh("git", ["status", "--short"]);
  const lines = (st.stdout || "").trim().split("\n").filter(Boolean);
  // GATE: no MODIFIED tracked file. (A modified lib/ is the thing that invalidates a
  // "verified on the deployed build" claim.)
  const tracked = lines.filter((l) => !l.startsWith("??"));
  record("deploy", "no modified tracked file", tracked.length === 0,
    tracked.length ? tracked.slice(0, 5).join(" | ") : "clean");
  // ADVISORY: untracked files are normal while working (this harness itself, tmp probes).
  const untracked = lines.filter((l) => l.startsWith("??"));
  record("deploy", "untracked files present (advisory)", true,
    untracked.length ? untracked.slice(0, 6).map((l) => l.slice(3)).join(", ") : "none");

  const diff = sh("git", ["diff", "--stat", "HEAD", "--", "lib", "index.js"]);
  const libDirty = (diff.stdout || "").trim();
  record("deploy", "lib/ + index.js == HEAD", libDirty === "", libDirty || "identical");

  const src = sh("bash", ["-lc", "stat -c '%Y' lib/measure.js 2>/dev/null || echo 0"]).stdout.trim();
  const active = sh("bash", ["-lc",
    "systemctl show mcp-hybrid-vision -p ActiveEnterTimestampValue 2>/dev/null | cut -d= -f2"]).stdout.trim();
  const head = sh("git", ["rev-parse", "--short", "HEAD"]).stdout.trim();
  // Timestamp comparison is advisory only; the CONTENT checks above are the gate.
  const newer = Number(active) && Number(active) > Number(src);
  record("deploy", "service restarted after source mtime (advisory)", true,
    `HEAD ${head}, service ${newer ? "newer" : "older"} than source — content checks are authoritative`);
  return head;
}

// ---------------------------------------------------------------------------
// 2. Unit suite + non-vacuity guards
// ---------------------------------------------------------------------------
function checkSuite() {
  const r = sh("npm", ["test"]);
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number((out.match(/^# pass (\d+)/m) || out.match(/pass (\d+)/) || [])[1] || 0);
  const fail = Number((out.match(/^# fail (\d+)/m) || out.match(/fail (\d+)/) || [])[1] || 0);
  record("suite", "npm test", r.status === 0 && fail === 0, `pass ${pass}, fail ${fail}`);
  return { pass, fail };
}

async function checkGuards() {
  const dir = path.join(ROOT, "verify");
  const files = fs.readdirSync(dir).filter((f) => /^nonvacuity.*\.mjs$/.test(f)).sort();
  let green = 0;
  const failing = [];
  const vacuous = [];
  // Run in parallel: each harness is an independent process, and the suite is the slow part.
  // SERIAL, AND NOT NEGOTIABLE. Each non-vacuity harness perturbs the tree IN PLACE
  // (`fs.writeFileSync(filePath, mutated)` … `writeFileSync(filePath, original)`) across
  // lib/measure.js AND the docs (ACCURACY.md, README.md). Running two at once — or one
  // alongside `npm test` — interleaves their read/mutate/restore cycles and leaves the
  // repository MUTATED: measured, `lib/measure.js` was left with a perturbed line and the
  // prose-guard tests then failed 4/139 while the docs kept an edited recall figure.
  // Serial is ~4x slower and is the only correct mode.
  const verdicts = [];
  for (const f of files) {
    const v = await new Promise((resolve) => {
      execFile("node", [path.join("verify", f)], { cwd: ROOT, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        const raw = ((stdout || "") + (stderr || "")).toLowerCase();
        // "vacuous" is a SUBSTRING of "non-vacuous": strip the healthy spelling FIRST, or
        // every healthy harness reads as vacuous (this exact bug was written twice).
        const ran = /non-vacuous|pass-with-fix/.test(raw);
        const stripped = raw.replace(/non-vacuous/g, "").replace(/nonvacuous/g, "");
        const saysVacuous = /some guards are vacuous/.test(stripped);
        resolve({ f, ok: !err && ran && !saysVacuous, ran, err: err ? String(err.message || err).slice(0, 60) : null });
      });
    });
    verdicts.push(v);
  }
  for (const { f, ok, ran, err } of verdicts) {
    if (ok) green++;
    else if (!ran && err) failing.push(`${f} (${err})`);
    else (ran ? vacuous : failing).push(f);
  }
  record("guards", "all non-vacuity harnesses green",
    failing.length === 0 && vacuous.length === 0,
    `${green}/${files.length} green${failing.length ? `; error/absent: ${failing.join(",")}` : ""}${vacuous.length ? `; vacuous: ${vacuous.join(",")}` : ""}`);
  return { green, total: files.length, failing, vacuous };
}

// ---------------------------------------------------------------------------
// 3. Live harness against the deployed (or scratch) service
// ---------------------------------------------------------------------------
function checkLive() {
  const port = process.env.PORT || PORT;
  const r = sh("node", ["verify/verify-background-live.mjs"], { env: { ...process.env, PORT: port } });
  const out = (r.stdout || "") + (r.stderr || "");
  const yes = (out.match(/YES/g) || []).length;
  const no = (out.match(/:\s*NO\b/g) || []).length;
  record("live", `live harness on :${port}`, r.status === 0 && no === 0, `exit ${r.status}, YES ${yes}, NO ${no}`);
  return { yes, no, exit: r.status, out };
}

// ---------------------------------------------------------------------------
// 4. Standing regression set — documented verdicts that must not drift
// ---------------------------------------------------------------------------
async function checkStanding() {
  const { loadPixels, contrastInRegion } = await import(path.join(ROOT, "lib/measure.js"));
  const F = await import(path.join(ROOT, "test-support/fixtures.mjs"));
  const R = { left: 0, top: 0, width: 1000, height: 700 };
  // name -> { all_meet_aa, verdict } as recorded in ACCURACY.md
  const EXPECTED = {
    buildContrastFixture: { all_meet_aa: false, verdict: "failing" },
    buildDenseSmallCardsFixture: { all_meet_aa: true, verdict: "clean" },
    buildDenseFlatFixture: { all_meet_aa: true, verdict: "clean" },
    buildDecorativeBarsFixture: { all_meet_aa: true, verdict: "clean" },
    buildAllPassingFixture: { all_meet_aa: true, verdict: "clean" },
    buildSplitBackgroundFixture: { all_meet_aa: true, verdict: "clean" },
    buildShallowGradientFixture: { all_meet_aa: null, verdict: "unverified" },
    buildTexturedPageCardsFixture: { all_meet_aa: null, verdict: "unverified" },
    buildPhotographicFixture: { all_meet_aa: null, verdict: "unverified" },
    buildDropcapTextFixture: { all_meet_aa: false, verdict: "failing" },
    buildHugeGlyphFixture: { all_meet_aa: false, verdict: "failing" },
    buildSteepGradientFixture: { all_meet_aa: false, verdict: "failing" },
  };
  const drift = [];
  const rows = [];
  for (const [fn, exp] of Object.entries(EXPECTED)) {
    if (typeof F[fn] !== "function") { drift.push(`${fn}: builder missing`); continue; }
    let got;
    try {
      const r = contrastInRegion(await loadPixels(await F[fn]()), R);
      got = { all_meet_aa: r.all_meet_aa, verdict: r.verdict };
    } catch (e) { drift.push(`${fn}: threw ${e.message.slice(0, 40)}`); continue; }
    const same = String(got.all_meet_aa) === String(exp.all_meet_aa) && got.verdict === exp.verdict;
    if (!same) drift.push(`${fn}: expected ${exp.all_meet_aa}/${exp.verdict}, got ${got.all_meet_aa}/${got.verdict}`);
    rows.push({ fixture: fn, got, exp, same });
  }
  record("standing", "standing verdicts match the record", drift.length === 0,
    drift.length ? drift.join(" | ") : `${rows.length} fixtures stable`);
  return rows;
}

// ---------------------------------------------------------------------------
// 5. Parameter sweeps — the ones that have produced findings
// ---------------------------------------------------------------------------
async function sweepTolerance() {
  const { loadPixels, contrastInRegion } = await import(path.join(ROOT, "lib/measure.js"));
  const F = await import(path.join(ROOT, "test-support/fixtures.mjs"));
  const R = { left: 0, top: 0, width: 1000, height: 700 };
  const fixtures = [
    ["outlined", build(F.buildOutlinedTextFixture)],
    ["dropcap", build(F.buildDropcapTextFixture)],
    ["dense text II", build(F.buildDenseTextIINumbersFixture)],
    ["acceptance", build(F.buildContrastFixture)],
  ];
  const rows = [];
  const offenders = [];
  for (const [name, builder] of fixtures) {
    if (!builder) continue;
    const px = await loadPixels(await builder());
    const seen = new Map();
    for (const t of [8, 12, 16, 20, 24, 32]) {
      const r = contrastInRegion(px, R, { tolerance: t });
      const key = `${r.all_meet_aa}/${r.verdict}`;
      seen.set(t, key);
    }
    const distinct = new Set(seen.values());
    // A verdict that CHANGES with the clustering tolerance is a finding, not a fact.
    const unstable = distinct.size > 1;
    if (unstable) offenders.push(`${name}: ${[...seen].map(([t, v]) => `${t}:${v}`).join(" ")}`);
    rows.push({ fixture: name, seen: Object.fromEntries(seen), stable: !unstable });
  }
  record("sweep", "verdict stable across clustering tolerance", offenders.length === 0,
    offenders.length ? offenders.join(" | ") : `${rows.length} fixtures stable over t=8..32`);
  return rows;

  function build(fn) { return typeof fn === "function" ? fn : null; }
}

/** Font size swept along a background->masked line: is real text ever miscalled a shade? */
async function sweepTextOnLine() {
  const sharp = (await import("sharp")).default;
  const { loadPixels, contrastInRegion } = await import(path.join(ROOT, "lib/measure.js"));
  const W = 1000, H = 700, R = { left: 0, top: 0, width: W, height: H };
  const hex = (c) => "#" + ["r", "g", "b"].map((k) => c[k].toString(16).padStart(2, "0")).join("");
  const p2 = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
  const a = p2("#1a1814"), b = p2("#464646");
  const MID = hex({ r: Math.round(a.r + 0.5 * (b.r - a.r)), g: Math.round(a.g + 0.5 * (b.g - a.g)), b: Math.round(a.b + 0.5 * (b.b - a.b)) });
  const rows = [];
  const mislabelled = [];
  for (const fs of [10, 12, 14, 16, 18, 24, 30, 40, 80]) {
    const buf = await sharp(Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${H}" fill="#1a1814"/>` +
        `<rect x="30" y="380" width="940" height="290" fill="#464646"/>` +
        `<text x="30" y="150" font-family="DejaVu Sans" font-size="${fs}" fill="${MID}">Settings panel label</text></svg>`,
    )).png().toBuffer();
    const r = contrastInRegion(await loadPixels(buf), R);
    const notes = (r.notes || []).join("\n");
    const calledShade = /ANTI-ALIASING shades of a MASKED/.test(notes) && new RegExp(MID, "i").test((r.notes || []).find((n) => /ANTI-ALIASING shades/.test(n)) || "");
    const asText = (r.notes || []).some((n) => /structurally TEXT|lie between the background and a MASKED/.test(n) && new RegExp(MID, "i").test(n));
    // A real text colour must NEVER be called a shade.
    if (calledShade) mislabelled.push(`${fs}px`);
    rows.push({ fs, calledShade, asText });
  }
  record("sweep", "real text on a blend line is never called a shade", mislabelled.length === 0,
    mislabelled.length ? `mislabelled at ${mislabelled.join(", ")}` : "clean across 10-80px");
  return rows;
}

/** Channel enumeration: is a given colour disclosed ANYWHERE, or silently dropped? */
async function enumerationProbe() {
  const { buildDropcapTextFixture, DROPCAP_TEXT } = await import(path.join(ROOT, "test-support/fixtures.mjs"));
  const { loadPixels, contrastInRegion } = await import(path.join(ROOT, "lib/measure.js"));
  const r = contrastInRegion(await loadPixels(await buildDropcapTextFixture()), { left: 0, top: 0, width: 1000, height: 700 });
  const target = (DROPCAP_TEXT && DROPCAP_TEXT.text) || "#464646";
  const channels = {
    colours: (r.colours || []).filter((c) => c.foreground === target).length,
    excluded: (r.excluded || []).filter((c) => c.foreground === target).length,
    skipped: (r.skipped || []).filter((c) => c.foreground === target).length,
    suspected_noise: (r.suspected_noise || []).filter((c) => c.foreground === target).length,
    background_regions: (r.background_regions || []).filter((c) => c.foreground === target).length,
    panel_fills: (r.panel_fills || []).filter((c) => c.foreground === target).length,
    mask_reconciliation: r.mask_reconciliation?.unmasked_failing_colours?.filter((c) => c.foreground === target).length ?? 0,
  };
  const anywhere = Object.values(channels).some((n) => n > 0);
  record("channels", `dropcap's declared text (${target}) is disclosed somewhere`, anywhere,
    anyway_line(channels));
  return channels;

  function anyway_line(ch) { return Object.entries(ch).map(([k, v]) => `${k}:${v}`).join(" "); }
}

// ---------------------------------------------------------------------------
// 6. Response cap sweep — the verdict must never be silently dropped
// ---------------------------------------------------------------------------
async function sweepCap() {
  const { buildTexturedPageCardsFixture } = await import(path.join(ROOT, "test-support/fixtures.mjs"));
  const { measureImage } = await import(path.join(ROOT, "lib/analyze.js"));
  const { truncateJsonForClient } = await import(path.join(ROOT, "lib/response.js"));
  const s = await measureImage({
    imageBuffer: await buildTexturedPageCardsFixture(),
    mode: "contrast",
    region: { left: 0, top: 0, width: 1000, height: 700 },
  });
  const rows = [];
  const bad = [];
  for (const cap of [12000, 4000, 1500, 700, 400, 300]) {
    const t = truncateJsonForClient(s, cap);
    let j = null, valid = true;
    try { j = JSON.parse(t); } catch { valid = false; }
    const verdict = j?.verdict ?? j?.measurements?.contrast?.verdict ?? null;
    const success = j?.success;
    // Invariant: if success is TRUE a verdict must be present (no envelope claiming success).
    const ok = valid && !(success === true && verdict === null && !j?.abstained);
    if (!ok) bad.push(`cap ${cap}`);
    rows.push({ cap, len: t.length, valid, success, verdict });
  }
  record("cap", "no success envelope without a verdict", bad.length === 0,
    bad.length ? `violations: ${bad.join(", ")}` : "invariant holds at every cap");
  return rows;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// INTEGRITY GATE — after all in-place perturbation, every tracked file the harnesses
// touch must be byte-identical to HEAD. A leftover mutation is the worst kind of false
// result: the suite goes red for a reason that is not in the code. (Measured the hard
// way: parallel guards left lib/measure.js perturbed AND the docs with an edited
// recall figure, turning 139/0 into 134/5.)
// ---------------------------------------------------------------------------
function checkIntegrity() {
  const d = sh("git", ["diff", "--name-only", "HEAD", "--", "lib", "index.js", "test-support", "ACCURACY.md", "README.md", "CHANGELOG.md"]);
  const changed = (d.stdout || "").trim();
  const rev = sh("bash", ["-lc", "grep -rl REVERTED lib index.js test-support 2>/dev/null | head -5"]).stdout.trim();
  const clean = changed === "" && rev === "";
  record("integrity", "tree byte-identical to HEAD after perturbation", clean,
    clean ? "clean" : [changed && `mutated: ${changed.split("\n").join(", ")}`, rev && `REVERTED in: ${rev.split("\n").join(", ")}`].filter(Boolean).join(" | "));
}

async function main() {
  const t0 = Date.now();
  const head = checkDeploy();
  const suite = checkSuite();
  const guards = await checkGuards();
  checkIntegrity();
  const live = checkLive();
  const standing = await checkStanding();
  const tol = await sweepTolerance();
  const line = await sweepTextOnLine();
  const channels = await enumerationProbe();
  const cap = await sweepCap();

  const failed = results.filter((r) => !r.ok);
  const report = { head, ms: Date.now() - t0, results, failed: failed.length, sweeps: { tolerance: tol, textOnLine: line, cap }, channels, standing };

  if (SAVE) {
    fs.writeFileSync(path.join(ROOT, SAVE), JSON.stringify(report, null, 2));
    say(`baseline written to ${SAVE}`);
  }
  if (BASELINE) {
    const prevPath = path.join(ROOT, BASELINE);
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      const cur = new Set(results.map((r) => `${r.section}|${r.name}|${r.ok}`));
      const was = new Set((prev.results || []).map((r) => `${r.section}|${r.name}|${r.ok}`));
      const newly = [...cur].filter((k) => !was.has(k));
      const fixed = [...was].filter((k) => !cur.has(k));
      record("baseline", "no NEW failures vs baseline", !newly.some((k) => k.endsWith("|false")),
        newly.length ? `new/changed: ${newly.join(", ")}` : "no new failures" + (fixed.length ? `; resolved: ${fixed.join(", ")}` : ""));
    } else {
      record("baseline", "baseline exists", false, `${BASELINE} not found`);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    say(`\n=== review harness  (HEAD ${head})  ${Date.now() - t0}ms ===\n`);
    const bySection = {};
    for (const r of results) (bySection[r.section] ||= []).push(r);
    for (const [sec, rs] of Object.entries(bySection)) {
      say(`[${sec}]`);
      for (const r of rs) say(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok && !VERBOSE ? "" : `  — ${r.detail}`}`);
    }
    if (VERBOSE) {
      say("\n[sweep rows]");
      for (const row of tol) say(`  tolerance ${row.fixture}: ${JSON.stringify(row.seen)}`);
      for (const row of line) say(`  line fs=${row.fs}: shade=${row.calledShade} text=${row.asText}`);
      for (const row of cap) say(`  cap ${row.cap}: len ${row.len} success=${row.success} verdict=${row.verdict}`);
    }
    say(`\n=== ${failed.length} failure(s) · tests ${suite.pass}/${suite.pass + suite.fail} · guards ${guards.green}/${guards.total} · live YES ${live.yes} NO ${live.no} ===`);
    say(failed.length ? "REVIEW NEEDED — a deterministic check regressed." : "All deterministic checks pass.");
    // The two things only a human can judge — printed as evidence, not asserted.
    say("\nFor human judgement (not asserted):");
    say("  - did any standing/sw-eep row CHANGE versus the record? (§standing, §sweep)");
    say("  - is any new note's prose warranted by the evidence in §channels?");
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
