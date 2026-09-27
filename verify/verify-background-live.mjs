// Live verification of background_mode over the MCP tool.
// Confirms: the flat fixture is unchanged; a photographic image is warned about
// on the default path and improved by the opt-in local mode.
//
// Port discovery: this probes the deployed service port first (11402 is what the
// systemd unit listens on) and falls back to 11499 (the throwaway test instance).
// A previous version hard-coded 11499, so the advertised "live" check silently
// targeted a different configuration than the one actually deployed.
//
//   python3 verify/make-fixture.py
//   node index.js &                     # or: PORT=11402 node index.js &
//   node verify/verify-background-live.mjs
//
// Override with PORT=<port> if your service listens elsewhere.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "fixture.png");
if (!fs.existsSync(FIXTURE)) { console.error("Run: python3 verify/make-fixture.py"); process.exit(1); }

// Candidate ports, in priority order: explicit override first, then the deployed
// service port, then the throwaway test port. De-duplicated.
const CANDIDATE_PORTS = [...new Set(
  [process.env.PORT ? Number(process.env.PORT) : null, 11402, 11499].filter((p) => Number.isFinite(p)),
)];

/** Find the first candidate port answering the health endpoint. */
async function discoverPort() {
  const tried = [];
  for (const port of CANDIDATE_PORTS) {
    tried.push(port);
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return port;
    } catch {
      // not listening — try the next candidate
    }
  }
  console.error(
    `\nCould not reach a hybrid-vision service. Tried port(s): ${tried.join(", ")}.\n` +
      `Start the service, or point this check at the right port explicitly:\n` +
      `  PORT=<the port your service listens on> npm run verify:background\n` +
      `e.g. PORT=11402 npm run verify:background\n`,
  );
  process.exit(1);
}

const PORT = await discoverPort();
console.log(`Using hybrid-vision service on port ${PORT}.\n`);

const toUri = (buf) => "data:image/png;base64," + buf.toString("base64");

// Photographic probe image with known text.
async function photographic() {
  const w = 700, h = 360;
  let s = 5 >>> 0;
  const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (x / w) * 0.6 + (y / h) * 0.4, base = 115 + 70 * t, i = (y * w + x) * 3;
    buf[i] = Math.max(0, Math.min(255, Math.round(base + g() * 8)));
    buf[i + 1] = Math.max(0, Math.min(255, Math.round(base * 0.96 + g() * 8)));
    buf[i + 2] = Math.max(0, Math.min(255, Math.round(base * 0.9 + g() * 8)));
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <text x="20" y="70" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#ffffff">PHOTO-WHITE-LINE</text>
      <text x="20" y="150" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#2b2b2b">PHOTO-DARK-LINE</text>
      <text x="20" y="235" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#f2b8b8">PHOTO-PINK-LINE</text>
    </svg>`), blend: "over" }])
    .png().toBuffer();
}

const client = new Client({ name: "verify-bg", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content[0].text);

// Measured discriminator (see ACCEPTANCE in test/background.test.js): a global
// background resolves one bright tone on this image; the local model resolves
// both (white ~14.2 and pink ~8.3), plus the dark near-background text.
const brightTones = (r) => r.colours.filter((c) => c.contrast_ratio > 6).length;
const failingTones = (r) => r.colours.filter((c) => c.contrast_ratio < 2.5).length;

console.log("=== 1. FLAT fixture (default path must be unchanged) ===");
{
  const flat = toUri(fs.readFileSync(FIXTURE));
  const region = { left: 0, top: 0, width: 900, height: 420 };
  const d = await call("measure_image", { image_source: flat, mode: "contrast", region });
  const l = await call("measure_image", { image_source: flat, mode: "contrast", region, background_mode: "local" });
  const c = d.measurements.contrast;
  console.log(`  default : failing=${c.failing_count} all_meet_aa=${c.all_meet_aa} worst=${c.worst.contrast_ratio} best=${c.best.contrast_ratio} mode=${c.background_mode}`);
  const cl = l.measurements.contrast;
  console.log(`  local   : failing=${cl.failing_count} all_meet_aa=${cl.all_meet_aa} worst=${cl.worst.contrast_ratio} best=${cl.best.contrast_ratio} mode=${cl.background_mode} effT=${cl.median_ink_threshold}`);
  const same = c.failing_count === cl.failing_count && c.worst.contrast_ratio === cl.worst.contrast_ratio && c.best.contrast_ratio === cl.best.contrast_ratio;
  console.log(`  -> identical: ${same ? "YES (not regressed)" : "NO"}`);
}

console.log("\n=== 2. PHOTOGRAPHIC image ===");
{
  const photo = toUri(await photographic());
  const region = { left: 0, top: 0, width: 700, height: 360 };
  const d = await call("measure_image", { image_source: photo, mode: "contrast", region });
  const cd = d.measurements.contrast;
  console.log(`  default : bright_tones=${brightTones(cd)} failing_tones=${failingTones(cd)} groups=${cd.colours.length} fit=${cd.background_fit?.explained_fraction} mode=${cd.background_mode}`);
  console.log(`            warned=${d.notes.some((n) => /Background fit warning/i.test(n))}`);
  const l = await call("measure_image", { image_source: photo, mode: "contrast", region, background_mode: "local" });
  const cl = l.measurements.contrast;
  console.log(`  local   : bright_tones=${brightTones(cl)} failing_tones=${failingTones(cl)} groups=${cl.colours.length} effT=${Math.round(cl.median_ink_threshold)} mode=${cl.background_mode}`);
  console.log(`  -> local resolves more bright text tones: ${brightTones(cl) > brightTones(cd) ? "YES" : "no"}`);
}

// Round-3 checks (third audit F1/F2/F4), exercised over the real MCP transport.
async function twoToneFlat() {
  const w = 900, h = 420;
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#141414"/>
    <text x="40" y="80" font-family="DejaVu Sans, sans-serif" font-size="44" fill="#f0f0f0">BRIGHT-ONE</text>
    <text x="40" y="190" font-family="DejaVu Sans, sans-serif" font-size="44" fill="#969696">MID-TWO</text>
  </svg>`)).png().toBuffer();
}

console.log("\n=== 3. round-3 checks (F1 mode consistency, F2 null background, F4 no text-run fold) ===");
{
  const flat = toUri(fs.readFileSync(FIXTURE));
  const region = { left: 0, top: 0, width: 900, height: 420 };

  // F1: with NO region, mode "contrast" and mode "all" must answer identically.
  const onlyContrast = await call("measure_image", { image_source: flat, mode: "contrast" });
  const all = await call("measure_image", { image_source: flat, mode: "all" });
  const w1 = onlyContrast.measurements.contrast?.worst?.contrast_ratio;
  const w2 = all.measurements.contrast?.worst?.contrast_ratio;
  const f1 = onlyContrast.measurements.contrast?.failing_count === all.measurements.contrast?.failing_count;
  console.log(`  F1 contrast-only worst=${w1}  all worst=${w2}  -> agree: ${w1 === w2 && f1 ? "YES" : "NO"}`);
  console.log(`  F1 scope note disclosed: ${/WHOLE image/.test((onlyContrast.notes || []).join(" ")) ? "YES" : "no"}`);

  // F2: local mode must report NO single background colour.
  const local = await call("measure_image", { image_source: flat, mode: "contrast", region, background_mode: "local" });
  console.log(`  F2 local background field = ${JSON.stringify(local.measurements.contrast.background)} -> null: ${local.measurements.contrast.background === null ? "YES" : "NO"}`);

  // F4: two collinear tones (240 / 150) on a FLAT background must both survive.
  const two = toUri(await twoToneFlat());
  const twoRes = await call("measure_image", { image_source: two, mode: "contrast", region });
  const twoLocal = await call("measure_image", { image_source: two, mode: "contrast", region, background_mode: "local" });
  const n = twoRes.measurements.contrast.colours.length;
  const nl = twoLocal.measurements.contrast.colours.length;
  console.log(`  F4 two-tone colours global=${n} local=${nl} -> both recovered: ${n === 2 && nl === 2 ? "YES" : "NO"}`);
  console.log(`  F4 merged_anti_aliasing global=${JSON.stringify(twoRes.measurements.contrast.merged_anti_aliasing.map((m) => m.hex))}`);
}

// Round-4 checks (fourth audit F5 multi-panel), over the real MCP transport.
async function twoPanel() {
  const w = 900, h = 420, split = 270;
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${split}" height="${h}" fill="#161616"/>
    <rect x="${split}" y="0" width="${w - split}" height="${h}" fill="#d2d2d2"/>
    <text x="30" y="108" font-family="DejaVu Sans, sans-serif" font-size="38" fill="#3c3c3c">SIDEBAR</text>
    <text x="30" y="188" font-family="DejaVu Sans, sans-serif" font-size="38" fill="#3c3c3c">SETTINGS</text>
    <text x="${split + 30}" y="108" font-family="DejaVu Sans, sans-serif" font-size="38" fill="#282828">CONTENT-OK</text>
  </svg>`)).png().toBuffer();
}

console.log("\n=== 4. round-4 checks (F5 two-panel multi-plateau) ===");
{
  const panel = toUri(await twoPanel());
  const region = { left: 0, top: 0, width: 900, height: 420 };
  for (const mode of ["global", "local"]) {
    const r = await call("measure_image", { image_source: panel, mode: "contrast", region, background_mode: mode });
    const c = r.measurements.contrast;
    const sidebar = c.colours.find((x) => x.foreground === "#3c3c3c");
    const content = c.colours.find((x) => x.foreground === "#282828");
    console.log(`  [${mode}] model=${c.background_model} plateaus=${c.plateaus?.length} colours=${c.colours.length}`);
    console.log(`  [${mode}] sidebar #3c3c3c = ${sidebar ? sidebar.contrast_ratio + ":1" : "MISSING"}  all_meet_aa=${c.all_meet_aa}  failing=${c.failing_count}`);
    console.log(`  [${mode}] content #282828 = ${content ? content.contrast_ratio + ":1 vs " + content.measured_against : "MISSING"}`);
    console.log(`  [${mode}] local_background on colours: ${c.colours.every((x) => x.local_background !== undefined) ? "YES" : "NO"}  -> F5 fixed: ${sidebar && sidebar.contrast_ratio === 1.64 && c.all_meet_aa === false ? "YES" : "NO"}`);
    console.log(`  [${mode}] background_fit applicable=${c.background_fit?.applicable} adequate=${c.background_fit?.adequate}`);
  }
}

// Round-5 checks (fifth audit F6: the gradient residual must be disclosed).
async function shallowGradient() {
  const w = 900, h = 420, lo = 48, hi = 60;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(lo + (hi - lo) * (x / w));
    const i = (y * w + x) * 3;
    buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <text x="40" y="60" font-family="DejaVu Sans, sans-serif" font-size="46" fill="#f0f0f0">BRIGHT-ONE</text>
      <text x="40" y="200" font-family="DejaVu Sans, sans-serif" font-size="46" fill="#8c8c8c">DARK-TWO</text>
    </svg>`), blend: "over" }])
    .png().toBuffer();
}

console.log("\n=== 5. round-5 checks (F6 gradient residual is not silent) ===");
{
  const grad = toUri(await shallowGradient());
  const region = { left: 0, top: 0, width: 900, height: 420 };
  const r = await call("measure_image", { image_source: grad, mode: "contrast", region });
  const c = r.measurements.contrast;
  console.log(`  fit=${c.background_fit?.explained_fraction} adequate=${c.background_fit?.adequate} all_meet_aa=${c.all_meet_aa} colours=${c.colours.length} notes=${r.notes.length}`);
  console.log(`  marginal note: ${r.notes.some((n) => /marginal/i.test(n)) ? "YES" : "NO"}`);
  console.log(`  model_disagreement: ${c.model_disagreement ? JSON.stringify(c.model_disagreement.local_failing_colours.map((x) => x.foreground)) : "none"}`);
  console.log(`  -> not silent: ${r.notes.length > 0 && c.all_meet_aa === true ? "YES" : "NO"}`);
  const l = await call("measure_image", { image_source: grad, mode: "contrast", region, background_mode: "local" });
  const cl = l.measurements.contrast;
  console.log(`  local: colours=${cl.colours.length} #8c8c8c=${cl.colours.find((x) => x.foreground === "#8c8c8c")?.contrast_ratio}:1 failing=${cl.failing_count}`);
}

console.log("\n=== 6. round-5 checks (structured analysis carries the same caveats) ===");
{
  const grad = toUri(await shallowGradient());
  const s = await call("analyze_image_structured", {
    image_source: grad,
    prompt: "Are there any accessibility or contrast problems in this image?",
  });
  const prose = JSON.stringify([...(s.abstained || []), ...(s.observations || [])]);
  console.log(`  answered_by=${s.answered_by} model_consulted=${s.model_consulted}`);
  console.log(`  measurements.contrast.background_fit=${JSON.stringify(s.measurements?.contrast?.background_fit?.explained_fraction)}`);
  console.log(`  model_disagreement surfaced: ${s.measurements?.contrast?.model_disagreement ? "YES" : "NO"}`);
  console.log(`  prose mentions the dark tone: ${/8c8c8c/i.test(prose) ? "YES" : "NO"}  -> caveat reaches prose: ${/disagree|marginal/i.test(prose) ? "YES" : "NO"}`);
}

// Round-6 checks (sixth audit F7: a tiled layout must not report the page
// background as failing text).
async function tiledCards() {
  const w = 1200, h = 700, parts = [`<rect width="${w}" height="${h}" fill="#1a1814"/>`];
  for (let i = 0; i < 12; i++) {
    const x = 40 + (i % 4) * 280;
    const y = 40 + Math.floor(i / 4) * 220;
    parts.push(`<rect x="${x}" y="${y}" width="240" height="180" fill="#2d2822"/>`);
    parts.push(`<text x="${x + 16}" y="${y + 46}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#e8dfd0">KPI ${i + 1}</text>`);
    parts.push(`<text x="${x + 16}" y="${y + 96}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#e8dfd0">value 42</text>`);
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

console.log("\n=== 7. round-6 checks (F7 tiled layout does not report the page background) ===");
{
  const tiled = toUri(await tiledCards());
  const region = { left: 0, top: 0, width: 1200, height: 700 };
  for (const mode of ["global", "local"]) {
    const r = await call("measure_image", { image_source: tiled, mode: "contrast", region, background_mode: mode });
    const c = r.measurements.contrast;
    console.log(`  [${mode}] model=${c.background_model} plateaus=${c.plateaus.map((p) => p.hex).join("/")} colours=${c.colours.map((x) => x.foreground).join(",")}`);
    console.log(`  [${mode}] all_meet_aa=${c.all_meet_aa} failing=${c.failing_count} page_bg_in_colours=${c.colours.some((x) => x.foreground === "#1a1814") ? "YES (bad)" : "no"}  -> F7 fixed: ${c.all_meet_aa === true && !c.colours.some((x) => x.foreground === "#1a1814") ? "YES" : "NO"}`);
  }
}

// Round-7 checks (seventh audit F8: a text colour must not be accepted as a
// plateau and masked).
async function hugeGlyphs(hardEdge) {
  const w = 900, h = 420, bg = "#1a1814", fill = "#464646";
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="${bg}"/>
    <text x="10" y="320" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="300" fill="${fill}">OO</text>
  </svg>`;
  let buf = await sharp(Buffer.from(svg)).png().toBuffer();
  if (hardEdge) {
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const [tr, tg, tb] = hex(fill), [br, bgc, bb] = hex(bg);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += info.channels) {
      const dF = (data[i] - tr) ** 2 + (data[i + 1] - tg) ** 2 + (data[i + 2] - tb) ** 2;
      const dB = (data[i] - br) ** 2 + (data[i + 1] - bgc) ** 2 + (data[i + 2] - bb) ** 2;
      const c = dF < dB ? [tr, tg, tb] : [br, bgc, bb];
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
    buf = await sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
  }
  return buf;
}

console.log("\n=== 8. round-7 checks (F8 a text colour is not masked as a plateau) ===");
{
  const region = { left: 0, top: 0, width: 900, height: 420 };
  for (const [label, he] of [["AA present", false], ["hard-edged", true]]) {
    const g = toUri(await hugeGlyphs(he));
    const r = await call("measure_image", { image_source: g, mode: "contrast", region });
    const c = r.measurements.contrast;
    const text = c.colours.find((x) => x.foreground === "#464646");
    console.log(`  [${label}] plateaus=${c.plateaus.map((p) => p.hex).join("/")} colours=${c.colours.map((x) => x.foreground).join(",")}`);
    console.log(`  [${label}] #464646 = ${text ? text.contrast_ratio + ":1 failing=" + !text.wcag_aa : "MISSING"} measurable=${c.measurable} failing=${c.failing_count} all_meet_aa=${c.all_meet_aa}`);
    console.log(`  [${label}] no-text-found note: ${r.notes.some((n) => /No text was found there/.test(n)) ? "YES (bad)" : "no"}  -> F8 fixed: ${text && text.contrast_ratio === 1.88 && c.failing_count === 1 ? "YES" : "NO"}`);
  }
}

// Round-8 checks (eighth audit F10: an inset content-dense panel must not hide a
// failing text colour).
async function densePanel({ inset = true, dense = true, text = "#666460" } = {}) {
  const w = 1000, h = 700;
  const box = inset ? { x: 60, y: 40, w: 880, h: 620 } : { x: 0, y: 0, w, h };
  const parts = [`<rect width="${w}" height="${h}" fill="#f0efec"/>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#2d2822"/>`];
  if (dense) {
    let s4 = 4;
    const rnd = () => { s4 = (s4 * 1103515245 + 12345) & 0x7fffffff; return s4 / 0x7fffffff; };
    for (let i = 0; i < 64; i++) {
      const x = box.x + 18 + i * 13;
      const hh = 80 + Math.round(rnd() * 300);
      parts.push(`<rect x="${x}" y="${box.y + box.h - 40 - hh}" width="11" height="${hh}" fill="#ebe6dc"/>`);
    }
  }
  parts.push(`<text x="${box.x + 20}" y="${box.y + 50}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">DASHBOARD</text>`);
  parts.push(`<text x="${box.x + 20}" y="${box.y + 100}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">summary</text>`);
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

console.log("\n=== 9. round-8 checks (F10 inset content-dense panel reports its failing text) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  for (const [label, opts] of [["inset dense", {}], ["border-touching dense", { inset: false }], ["inset sparse", { dense: false }]]) {
    const p = toUri(await densePanel(opts));
    const r = await call("measure_image", { image_source: p, mode: "contrast", region });
    const c = r.measurements.contrast;
    const text = c.colours.find((x) => x.foreground === "#666460");
    console.log(`  [${label}] plateaus=${c.plateaus.map((x) => x.hex).join("/")} colours=${c.colours.map((x) => x.foreground).join(",")}`);
    console.log(`  [${label}] #666460 = ${text ? text.contrast_ratio + ":1" : "MISSING"} all_meet_aa=${c.all_meet_aa} failing=${c.failing_count}  -> F10 fixed: ${text && text.contrast_ratio === 2.47 && c.all_meet_aa === false ? "YES" : "NO"}`);
  }
  const clean = toUri(await densePanel({ text: "#dcd7cd" }));
  const rc = await call("measure_image", { image_source: clean, mode: "contrast", region });
  console.log(`  [clean inset dense] all_meet_aa=${rc.measurements.contrast.all_meet_aa} (must be true)`);
}

// Round-9 checks (ninth audit F11: reconciliation must be precise — decoration is
// not text).
async function decorativeBars() {
  const w = 1000, h = 700, parts = [`<rect width="${w}" height="${h}" fill="#f0efec"/>`,
    `<rect x="60" y="40" width="880" height="620" fill="#2d2822"/>`];
  for (let i = 0; i < 64; i++) {
    const x = 78 + i * 13;
    const hh = 80 + (i * 37) % 300;
    parts.push(`<rect x="${x}" y="${620 - hh}" width="11" height="${hh}" fill="#783c3c"/>`);
  }
  parts.push(`<text x="80" y="90" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#b9b5ae">DASHBOARD</text>`);
  parts.push(`<text x="80" y="140" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#b9b5ae">summary</text>`);
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

async function droppedPanel() {
  const w = 1000, h = 700;
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#1a1814"/>
    <rect x="60" y="40" width="420" height="620" fill="#464646"/>
    <rect x="520" y="40" width="420" height="620" fill="#464646"/>
  </svg>`)).png().toBuffer();
}

console.log("\n=== 10. round-9 checks (F11 decoration; REVERSED in round 12) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  const bars = await call("measure_image", { image_source: toUri(await decorativeBars()), mode: "contrast", region });
  const cb = bars.measurements.contrast;
  console.log(`  [decor decorative-bars] colours=${cb.colours.map((x) => x.foreground + "@" + x.contrast_ratio).join(",")} all_meet_aa=${cb.all_meet_aa}`);
  // Round 12: the bars are now DELIBERATELY disclosed (F14 showed the gate that
  // suppressed them was anti-correlated with the evidence). This check is therefore
  // INVERTED: the VERDICT must still be a clean pass, and the disclosure must fire
  // with the bar flagged as a detected plateau.
  const bar = cb.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#783c3c");
  console.log(`  [decor decorative-bars] mask_reconciliation=${cb.mask_reconciliation ? "FIRES (intended)" : "none"} bar_flagged_plateau=${bar?.detected_plateau}  -> verdict clean: ${cb.all_meet_aa === true ? "YES" : "NO"}`);

  const dp = await call("measure_image", { image_source: toUri(await droppedPanel()), mode: "contrast", region });
  const cd = dp.measurements.contrast;
  const named = cd.mask_reconciliation?.unmasked_failing_colours?.map((x) => x.foreground + "@" + x.contrast_ratio) ?? [];
  console.log(`  [panel-shaped dropped] mask_reconciliation=${cd.mask_reconciliation ? JSON.stringify(named) : "none"} all_meet_aa=${cd.all_meet_aa}  -> must still disclose: ${cd.mask_reconciliation ? "YES" : "NO"}`);
}

// Round-10 checks (tenth audit F12: a colour masked between the tiling floor and the
// disclosure gate must still be disclosed).
async function bandII(size) {
  const w = 1000, h = 700;
  const run = (y) => `<text x="60" y="${y}" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${size}" fill="#464646">II</text>`;
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#1a1814"/>${run(80 + size)}${run(400 + size)}
  </svg>`)).png().toBuffer();
}

console.log("\n=== 11. round-10 checks (F12 the masked band must still surface the colour) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  for (const size of [200, 300, 420]) {
    const r = await call("measure_image", { image_source: toUri(await bandII(size)), mode: "contrast", region });
    const c = r.measurements.contrast;
    const reported = c.colours.some((x) => x.foreground === "#464646");
    const disclosed = c.mask_reconciliation?.unmasked_failing_colours?.some((x) => x.foreground === "#464646");
    console.log(`  [II@${size}] colours=${c.colours.map((x) => x.foreground).join(",") || "none"} recon=${c.mask_reconciliation ? "FIRES" : "none"} measurable=${c.measurable} all_meet_aa=${c.all_meet_aa}`);
    console.log(`  [II@${size}] #464646 surfaced: ${reported ? "in colours" : disclosed ? "in mask_reconciliation" : "MISSING (bad)"}  -> F12 fixed: ${reported || disclosed ? "YES" : "NO"}`);
  }
}

// Round-11 checks (eleventh audit F13: the round-10 "structural guarantee" was
// false — the disclosure gate compared a MEAN against the mask's SINGLE-BLOB
// floor, so a colour masked by one >=2% blob but dragged below 0.4% mean by many
// small companions was masked AND undisclosed).
async function dropcapText() {
  const w = 1000, h = 700;
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#1a1814"/>
    <text x="20" y="300" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="330" fill="#464646">I</text>
    <text x="150" y="660" font-family="DejaVu Sans, sans-serif" font-size="55" fill="#464646">settings</text>
  </svg>`)).png().toBuffer();
}
async function panelPlusFragments() {
  const w = 1000, h = 700;
  const parts = [`<rect width="${w}" height="${h}" fill="#1a1814"/>`,
    `<rect x="100" y="100" width="200" height="80" fill="#464646"/>`];
  for (let i = 0; i < 10; i++) parts.push(`<rect x="${80 + i * 90}" y="420" width="24" height="14" fill="#464646"/>`);
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

console.log("\n=== 12. round-11 checks (F13 the retracted guarantee: a mask-caused omission must be disclosed) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };

  const drop = await call("measure_image", { image_source: toUri(await dropcapText()), mode: "contrast", region });
  const cDrop = drop.measurements.contrast;
  const dropNamed = cDrop.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#464646");
  console.log(`  [dropcap] colours=${cDrop.colours.map((x) => x.foreground).join(",") || "none"} recon=${cDrop.mask_reconciliation ? "FIRES" : "none"} all_meet_aa=${cDrop.all_meet_aa}`);
  console.log(`  [dropcap] #464646 disclosed: ${dropNamed ? `${dropNamed.contrast_ratio}:1 largest=${dropNamed.largest_component_share} plateau=${dropNamed.detected_plateau}` : "MISSING (bad)"}  -> F13 fixed: ${dropNamed ? "YES" : "NO"}`);

  const frag = await call("measure_image", { image_source: toUri(await panelPlusFragments()), mode: "contrast", region });
  const cFrag = frag.measurements.contrast;
  const fragNamed = cFrag.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#464646");
  console.log(`  [panel+fragments] colours=${cFrag.colours.length} measurable=${cFrag.measurable} recon=${cFrag.mask_reconciliation ? "FIRES" : "none"}`);
  console.log(`  [panel+fragments] empty masked result still disclosed: ${fragNamed ? `${fragNamed.contrast_ratio}:1` : "MISSING (bad)"}  -> F13 fixed: ${fragNamed ? "YES" : "NO"}`);

  // F11 is REMOVED from the keep-green list in round 12: it is now DELIBERATELY
  // disclosed (see section 13). The VERDICT must still be a clean pass.
  const bars = await call("measure_image", { image_source: toUri(await decorativeBars()), mode: "contrast", region });
  const cBars = bars.measurements.contrast;
  console.log(`  [F11 verdict] decorative bars all_meet_aa=${cBars.all_meet_aa} (verdict unchanged; disclosure now fires by design)`);
}

// Round-12 checks (twelfth audit F14: the disclosure gate was ANTI-CORRELATED with
// the evidence — adding failing text of the same colour made the warning vanish).
async function headingOnly() {
  return sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="700" fill="#1a1814"/>
    <text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="300" fill="#464646">II</text>
  </svg>`)).png().toBuffer();
}
async function headingPlusBody() {
  const body = Array.from({ length: 6 }, (_, l) =>
    `<text x="520" y="${300 + l * 36}" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#464646">The quick brown fox jumps over</text>`).join("");
  return sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="700" fill="#1a1814"/>
    <text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="300" fill="#464646">II</text>${body}
  </svg>`)).png().toBuffer();
}

console.log("\n=== 13. round-12 checks (F14 more failing text must not silence the warning) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  const d = await call("measure_image", { image_source: toUri(await headingOnly()), mode: "contrast", region });
  const cD = d.measurements.contrast;
  const dNamed = cD.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#464646");
  console.log(`  [D heading only]  colours=${cD.colours.map((x) => x.foreground).join(",") || "none"} recon=${cD.mask_reconciliation ? "FIRES" : "none"}`);
  console.log(`  [D heading only]  #464646 disclosed: ${dNamed ? `${dNamed.contrast_ratio}:1` : "MISSING"}  -> ${dNamed ? "YES" : "NO"}`);

  const e = await call("measure_image", { image_source: toUri(await headingPlusBody()), mode: "contrast", region });
  const cE = e.measurements.contrast;
  const eNamed = cE.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#464646");
  console.log(`  [E heading+body]  colours=${cE.colours.map((x) => x.foreground).join(",") || "none"} recon=${cE.mask_reconciliation ? "FIRES" : "none"}`);
  console.log(`  [E heading+body]  #464646 disclosed: ${eNamed ? `${eNamed.contrast_ratio}:1 comps=${eNamed.component_count}` : "MISSING"}  -> ${eNamed ? "YES" : "NO"}  (F14: more text must NOT silence)`);

  // F11 is now DELIBERATELY disclosed (precision traded for no silent omission).
  const bars = await call("measure_image", { image_source: toUri(await decorativeBars()), mode: "contrast", region });
  const cBars = bars.measurements.contrast;
  console.log(`  [F11 reversed]    decorative bars recon=${cBars.mask_reconciliation ? "FIRES (intended)" : "none"} all_meet_aa=${cBars.all_meet_aa}`);

  // F15: `shape` must be GONE, and the raw evidence present (round 13).
  const eEntry = cE.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === "#464646");
  console.log(`  [F15] shape field present: ${eEntry && "shape" in eEntry ? "YES (bad)" : "no"}  raw fields: comps=${eEntry?.component_count} plateau_share=${eEntry?.plateau_share} detected_plateau=${eEntry?.detected_plateau}`);
}

// Round-14 checks (fourteenth audit F16: `plateau_share` is coverage, NOT a
// decoration/text classifier — a dense glyph run covers MORE than a bar chart).
async function barsRefF16() {
  const bars = Array.from({ length: 9 }, (_, i) =>
    `<rect x="${80 + i * 95}" y="${520 - (i * 22 + 40)}" width="60" height="${i * 22 + 40}" rx="4" fill="#464646"/>`).join("");
  return sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="700" fill="#0d0c0b"/><rect x="0" y="0" width="1000" height="620" fill="#1c1a17"/>${bars}<text x="60" y="60" font-family="DejaVu Sans" font-size="30" font-weight="bold" fill="#e8dfd0">Revenue</text></svg>`)).png().toBuffer();
}
async function denseTextF16() {
  const t = (y) => `<text x="30" y="${y}" font-family="DejaVu Sans" font-weight="bold" font-size="260" fill="#464646">IIIIII</text>`;
  return sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="700" fill="#0d0c0b"/><rect x="0" y="0" width="1000" height="620" fill="#1c1a17"/>${t(300)}${t(580)}</svg>`)).png().toBuffer();
}

console.log("\n=== 15. round-14 checks (F16 plateau_share is coverage, not a classifier) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  const get = (c, fg) => c.mask_reconciliation?.unmasked_failing_colours?.find((x) => x.foreground === fg);
  const a = await call("measure_image", { image_source: toUri(await barsRefF16()), mode: "contrast", region });
  const t = await call("measure_image", { image_source: toUri(await denseTextF16()), mode: "contrast", region });
  const ca = a.measurements.contrast, ct = t.measurements.contrast;
  const ea = get(ca, "#464646"), et = get(ct, "#464646");
  console.log(`  [A bars]   disclosed=${!!ea} plateau_share=${ea?.plateau_share} comps=${ea?.component_count} kind_field=${ea && ("shape" in ea || "kind" in ea) ? "PRESENT (bad)" : "none"}`);
  console.log(`  [T text]   disclosed=${!!et} plateau_share=${et?.plateau_share} comps=${et?.component_count} kind_field=${et && ("shape" in et || "kind" in et) ? "PRESENT (bad)" : "none"}`);
  console.log(`  [F16] real text (${et?.plateau_share}) > bars (${ea?.plateau_share})? ${et && ea && et.plateau_share > ea.plateau_share ? "YES -> the old claim inverts, as expected" : "NO"}`);
}

// Round-15/16 checks (F17/F18/F19: the prose guard's scope claim, then the free-text
// waiver token and the field-anchor gap). Docs/rule probe — no MCP call; it uses the
// SHARED guard module so the rule has a single source of truth.
console.log("\n=== 16. round-15/16 checks (F17/F18/F19 the prose guard is structurally sound) ===");
{
  const fsmod = await import("node:fs/promises");
  const p = await import("node:path");
  const root = p.resolve(import.meta.dirname, "..");
  const { scanForClassificationClaims, flagsClassificationClaim, DISCLAIMER, normalizeForDisclaimer } =
    await import(pathToFileURL(p.join(root, "test-support", "prose-guard.mjs")).href);
  const files = ["lib/measure.js", "README.md", "ACCURACY.md", "CHANGELOG.md", "index.js"];
  let total = 0;
  for (const rel of files) {
    total += scanForClassificationClaims(await fsmod.readFile(p.join(root, rel), "utf8")).length;
  }
  console.log(`  [F17] un-retracted field+classification claims in the docs: ${total} -> ${total === 0 ? "clean" : "PROBLEM"}`);

  // F18: the same claim, with and without a trailing waiver token, must agree.
  const claim = "plateau_share orders decoration from a glyph run.";
  const bare = flagsClassificationClaim(claim);
  const tokened = flagsClassificationClaim(`${claim} [PARAPHRASE]`);
  console.log(`  [F18] bare=${bare} trailing-token=${tokened} -> ${bare === tokened ? "SAME verdict (fixed)" : "DIFFERENT (bad)"}`);
  // F20: ordinary words in the window must not waive.
  const noDoubt = flagsClassificationClaim("There is no doubt plateau_share orders decoration from a glyph run.");
  const instead = flagsClassificationClaim("plateau_share instead orders decoration from a glyph run.");
  console.log(`  [F20] 'no doubt'=${noDoubt} 'instead'=${instead} -> ${noDoubt && instead ? "both flagged (fixed)" : "ESCAPES (bad)"}`);
  // F21: a marker waives only its own cell.
  const crossCell = flagsClassificationClaim('| [PARAPHRASE] "quoted" | a live claim: plateau_share orders decoration from a glyph run. |');
  const sameCell = flagsClassificationClaim('| [PARAPHRASE] a live claim: plateau_share orders decoration from a glyph run. |');
  console.log(`  [F21] cross-cell=${crossCell} same-cell=${sameCell} -> ${crossCell && !sameCell ? "cell-scoped (fixed)" : "BAD"}`);
  // F22: a strong negation must GOVERN the verb, not merely precede it.
  const neverFails = flagsClassificationClaim("plateau_share never fails to order decoration from a glyph run.");
  const withoutBlink = flagsClassificationClaim("plateau_share without blinking orders decoration from a glyph run.");
  console.log(`  [F22] 'never fails to'=${neverFails} 'without blinking'=${withoutBlink} -> ${neverFails && withoutBlink ? "both flagged (fixed)" : "ESCAPES (bad)"}`);
  // F23: a marker waives only the span it precedes.
  const spanCell = flagsClassificationClaim("| [PARAPHRASE] old wording. Also plateau_share orders decoration from a glyph run. |");
  console.log(`  [F23] marker+later-claim same cell=${spanCell} -> ${spanCell ? "flagged (fixed)" : "ESCAPES (bad)"}`);
  // F24: a marker with NO sentence end must not waive the remainder.
  const noPeriod = flagsClassificationClaim("| [PARAPHRASE] old wording, and also plateau_share orders decoration from a glyph run |");
  console.log(`  [F24] marker with no sentence end=${noPeriod} -> ${noPeriod ? "flagged (fixed)" : "ESCAPES (bad)"}`);
  // F25: retractions must be ALLOWED (they were false positives).
  const retraction = flagsClassificationClaim("plateau_share is not able to distinguish decoration from text.");
  console.log(`  [F25] retraction 'is not able to'=${retraction} -> ${retraction ? "FLAGGED (bad)" : "allowed (fixed)"}`);
  // F26: the measured recall is PRINTED here too, so the number is visible outside the test.
  const { measureRecall } = await import(pathToFileURL(p.join(root, "test-support", "prose-recall-fixtures.mjs")).href);
  const rec = measureRecall();
  console.log(`  [F26] measured recall on the fixture set: ${rec.recall} (caught ${rec.caught}/${rec.mustFlagTotal}, false positives ${rec.falsePositives})`);
  // F19: the field anchor must cover every emitted key.
  const { EMITTED_DISCLOSURE_KEYS, CLAIM_FIELD } = await import(pathToFileURL(p.join(root, "test-support", "prose-guard.mjs")).href);
  const uncovered = EMITTED_DISCLOSURE_KEYS.filter((k) => !CLAIM_FIELD.test(k));
  console.log(`  [F19] emitted keys covered by the field anchor: ${EMITTED_DISCLOSURE_KEYS.length - uncovered.length}/${EMITTED_DISCLOSURE_KEYS.length}${uncovered.length ? " MISSING " + uncovered.join(",") : ""}`);

  const withDisc = [];
  for (const rel of ["lib/measure.js", "README.md", "ACCURACY.md"]) {
    if (DISCLAIMER.test(normalizeForDisclaimer(await fsmod.readFile(p.join(root, rel), "utf8")))) withDisc.push(rel);
  }
  console.log(`  [F17] files carrying the explicit disclaimer: ${withDisc.join(", ")} (${withDisc.length}/3)`);
}

// Round-21 checks (twenty-first audit F27/F28). F27: a text-free gradient was
// reported as FAILING text (the ramp's own end). F28: outlined text's darker
// colour was absorbed by the extremal stroke colour.
async function textFreeGradient() {
  const w = 1000, h = 700;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#101010"/><stop offset="1" stop-color="#606060"/>` +
    `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function outlinedText({ fill = "#464646", stroke = "#e8dfd0" } = {}) {
  const w = 1000, h = 700;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="60" y="385" font-family="DejaVu Sans, sans-serif" font-size="180" ` +
    `font-weight="bold" fill="${fill}" stroke="${stroke}" stroke-width="3">AB</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

console.log("\n=== 17. round-21 checks (F27 text-free gradient; F28 outlined text) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };

  // F27: a text-free gradient must abstain, not report the ramp as failing text.
  const g = await call("measure_image", { image_source: toUri(await textFreeGradient()), mode: "contrast", region });
  const gc = g.measurements.contrast;
  console.log(`  [F27] measurable=${gc.measurable} all_meet_aa=${gc.all_meet_aa} failing=${gc.failing_count} fit=${gc.background_fit?.explained_fraction?.toFixed(3)} adequate=${gc.background_fit?.adequate}`);
  console.log(`  [F27] abstention reason names the background: ${g.measurements.contrast.abstained?.some((a) => /background/i.test(a.reason)) ? "YES" : "NO"}  -> F27 fixed: ${gc.measurable === false && gc.all_meet_aa === null && gc.failing_count === 0 ? "YES" : "NO"}`);

  // F28: outlined text must report BOTH colours, in either direction.
  for (const [label, opts] of [["dark fill + light stroke", {}], ["light fill + dark stroke", { fill: "#e8dfd0", stroke: "#464646" }]]) {
    const r = await call("measure_image", { image_source: toUri(await outlinedText(opts)), mode: "contrast", region });
    const c = r.measurements.contrast;
    const dark = c.colours.find((x) => x.foreground === "#464646");
    console.log(`  [F28 ${label}] colours=${c.colours.map((x) => x.foreground + "@" + x.contrast_ratio + "(px=" + x.pixel_count + ")").join(", ")}`);
    console.log(`  [F28 ${label}] all_meet_aa=${c.all_meet_aa} failing=${c.failing_count} #464646 reported+FAILING=${dark && !dark.wcag_aa}  -> F28 fixed: ${dark && !dark.wcag_aa && c.all_meet_aa === false ? "YES" : "NO"}`);
  }
}

// Round-22 checks (twenty-second audit F29): the pixel floor must apply to a colour's
// TOTAL across the scan, not per component, or a small glyph's fill is lost as it splits.
async function outlinedSized(size, text = "AB", strokeWidth = 2) {
  const w = 1000, h = 700;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="60" y="${Math.round(size * 0.9) + 60}" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="${size}" font-weight="bold" fill="#464646" stroke="#e8dfd0" stroke-width="${strokeWidth}">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

console.log("\n=== 18. round-22 checks (F29 small outlined text: the floor is a per-colour TOTAL) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };

  // The defect window: while the fill is the larger ink, hiding it is the F28 defect.
  let allSizesOk = true;
  for (const fontSize of [72, 56, 48, 44, 40, 36, 32]) {
    const r = await call("measure_image", { image_source: toUri(await outlinedSized(fontSize)), mode: "contrast", region });
    const c = r.measurements.contrast;
    const fill = c.colours.find((x) => x.foreground === "#464646");
    const ok = fill && !fill.wcag_aa && c.all_meet_aa === false;
    if (!ok) allSizesOk = false;
    console.log(`  [F29 ${String(fontSize).padStart(3)}px] #464646 ${fill ? `px=${fill.pixel_count} FAIL` : "** ABSENT **"}  all_meet_aa=${c.all_meet_aa}  -> ${ok ? "ok" : "LOST"}`);
  }
  console.log(`  [F29] every size 32-72px reports the failing fill: ${allSizesOk ? "YES" : "NO"}`);

  // Aggregation non-vacuity: "ABC" at 30px splits the fill into pieces each below the 224px
  // floor (221 + 68 = 289 total), so only a TOTAL-based floor emits it.
  const split = await call("measure_image", { image_source: toUri(await outlinedSized(30, "ABC")), mode: "contrast", region });
  const sc = split.measurements.contrast;
  const sFill = sc.colours.find((x) => x.foreground === "#464646");
  console.log(`  [F29 split] "ABC" 30px pieces below floor -> #464646 ${sFill ? `px=${sFill.pixel_count} reported` : "** ABSENT **"}  -> aggregation ${sFill ? "WORKS" : "VACUOUS/BROKEN"}`);

  // Honest boundary: at 28px the fill (158px) is smaller than the stroke, so the larger ink
  // is reported and the rule correctly stays quiet.
  const tiny = await call("measure_image", { image_source: toUri(await outlinedSized(28)), mode: "contrast", region });
  const tc = tiny.measurements.contrast;
  console.log(`  [F29 28px boundary] larger ink (stroke) reported: ${tc.colours.some((x) => x.foreground === "#e8dfd0") ? "YES" : "NO"} (fill 158px < stroke 216px, so nothing larger is hidden)`);
}

// Round-23 checks (twenty-third audit F30/F31): the second-ink floor must be the SAME
// quantity as the primary floor, and accumulated card/text AA fringes must not become a
// false failure.
async function outlinedSizedR23(size, text = "AB") {
  const w = 1000, h = 700;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="60" y="${Math.round(size * 0.9) + 60}" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="${size}" font-weight="bold" fill="#464646" stroke="#e8dfd0" stroke-width="2">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function plainSizedR23(size, text = "AB") {
  const w = 1000, h = 700;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="60" y="${Math.round(size * 0.9) + 60}" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="${size}" font-weight="bold" fill="#464646">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function denseSmallCardsR23() {
  const w = 1000, h = 700, cols = 4, rows = 4;
  const parts = [`<rect width="${w}" height="${h}" fill="#1a1814"/>`];
  const cw = Math.floor((w - 40) / cols);
  const ch = Math.floor((h - 40) / rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 20 + c * cw, y = 20 + r * ch;
      parts.push(`<rect x="${x + 4}" y="${y + 4}" width="${cw - 8}" height="${ch - 8}" fill="#2d2822"/>`);
      for (let l = 0; l < 3; l++) {
        parts.push(`<text x="${x + 12}" y="${y + 22 + l * 16}" font-family="DejaVu Sans" font-size="13" fill="#e8dfd0">label ${r}${c}.${l}</text>`);
      }
    }
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

console.log("\n=== 19. round-23 checks (F30 unified floor; F31 dense small cards) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };

  // F30: the second-ink floor is the primary floor, so a 30px outlined fill (~221px) is
  // reported just like a plain 16px run (~209px).
  const outlined = await call("measure_image", { image_source: toUri(await outlinedSizedR23(30)), mode: "contrast", region });
  const oc = outlined.measurements.contrast;
  const ofill = oc.colours.find((x) => x.foreground === "#464646");
  console.log(`  [F30 outlined 30px] #464646 ${ofill ? `px=${ofill.pixel_count} reported` : "** ABSENT **"} all_meet_aa=${oc.all_meet_aa}  -> ${ofill && !ofill.wcag_aa ? "ok" : "LOST"}`);
  const plain = await call("measure_image", { image_source: toUri(await plainSizedR23(16)), mode: "contrast", region });
  const pc = plain.measurements.contrast;
  const pfill = pc.colours.find((x) => x.foreground === "#464646");
  console.log(`  [F30 plain 16px]    #464646 ${pfill ? `px=${pfill.pixel_count} reported` : "absent"}  -> the two paths agree: ${!!ofill === !!pfill ? "YES" : "NO"}`);

  // F31: a dense small-text dashboard must stay clean (no accumulated fringe failure).
  const dense = await call("measure_image", { image_source: toUri(await denseSmallCardsR23()), mode: "contrast", region });
  const dc = dense.measurements.contrast;
  const fringe = dc.colours.some((x) => !x.wcag_aa);
  console.log(`  [F31] colours=${dc.colours.length} all_meet_aa=${dc.all_meet_aa} failing=${dc.failing_count}  -> F31 fixed: ${dc.all_meet_aa === true && dc.failing_count === 0 ? "YES" : "NO"}`);
}

// Round-24 checks (twenty-fourth audit F32): a fill that lies ON the reference->stroke line
// must not be discarded as a fringe.
async function onLineFill(t) {
  const w = 1000, h = 700;
  const b = [0x1a, 0x18, 0x14], wh = [0xff, 0xff, 0xff];
  const fill = "#" + b.map((c, i) => Math.round(c + (wh[i] - c) * t).toString(16).padStart(2, "0")).join("");
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="60" y="240" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="180" ` +
    `fill="${fill}" stroke="#ffffff" stroke-width="3">AB</text></svg>`;
  return { fill, buf: await sharp(Buffer.from(svg)).png().toBuffer() };
}

console.log("\n=== 20. round-24 checks (F32 on-line fill is not discarded as a fringe) ===");
{
  const region = { left: 0, top: 0, width: 1000, height: 700 };
  let allOk = true;
  for (const t of [0.05, 0.1, 0.15, 0.2]) {
    const { fill, buf } = await onLineFill(t);
    const r = await call("measure_image", { image_source: toUri(buf), mode: "contrast", region });
    const c = r.measurements.contrast;
    const f = c.colours.find((x) => x.foreground === fill);
    const ok = f && !f.wcag_aa && c.all_meet_aa === false;
    if (!ok) allOk = false;
    console.log(`  [F32 t=${t}] ${fill} ${f ? `px=${f.pixel_count} reported` : "** ABSENT **"} all_meet_aa=${c.all_meet_aa}  -> ${ok ? "ok" : "DISCARDED"}`);
  }
  console.log(`  [F32] every on-line fill reported: ${allOk ? "YES" : "NO"}`);
}

await client.close();
