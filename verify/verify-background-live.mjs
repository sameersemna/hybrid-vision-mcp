// Live verification of background_mode over the MCP tool.
// Confirms: the flat fixture is unchanged; a photographic image is warned about
// on the default path and improved by the opt-in local mode.
//
//   python3 verify/make-fixture.py
//   PORT=11499 node index.js &
//   node verify/verify-background-live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.PORT || 11499;
const FIXTURE = path.join(ROOT, "fixture.png");
if (!fs.existsSync(FIXTURE)) { console.error("Run: python3 verify/make-fixture.py"); process.exit(1); }

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

await client.close();
