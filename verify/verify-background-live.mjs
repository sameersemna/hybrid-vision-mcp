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

await client.close();
