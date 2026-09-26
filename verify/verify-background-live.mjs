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
}

await client.close();
