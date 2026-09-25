// ==========================================
// Shared acceptance fixture for contrast/background tests.
// ==========================================
// Lives outside a *.test.js file so importing it does not re-register another
// file's test cases (which inflated the suite count when background.test.js
// imported from contrast.test.js).

import sharp from "sharp";

export const FIXTURE = {
  width: 900,
  height: 420,
  background: "#1a1814",
  colours: {
    heading: "#e8dfd0", // 13.42  pass
    bravo: "#484f58",   //  2.14  FAIL  (large text)
    charlie: "#a09588", //  6.03  pass  (13px, small)
    mark: "#7daa7a",    //  6.67  pass
    hotel: "#1e1c18",   //  1.04  FAIL  (near-background)
    border: "#4a433c",  //  1.82  decorative
  },
  expected: {
    "#e8dfd0": 13.42,
    "#a09588": 6.03,
    "#7daa7a": 6.67,
    "#484f58": 2.14,
    "#1e1c18": 1.04,
  },
  regions: {
    bravo: { left: 30, top: 96, width: 230, height: 52 },
    alpha: { left: 30, top: 26, width: 260, height: 52 },
    hotel: { left: 30, top: 372, width: 420, height: 40 },
  },
};

/** Render the hardening brief's fixture via SVG. Mirrors its geometry/colours. */
export async function buildContrastFixture() {
  const { width: W, height: H, background: BG, colours: C } = FIXTURE;
  const box = (i, label) => {
    const x = 30 + i * 215;
    return (
      `<rect x="${x}" y="220" width="190" height="110" fill="none" stroke="${C.border}" stroke-width="2"/>` +
      `<text x="${x + 18}" y="262" font-family="DejaVu Sans, sans-serif" font-size="22" fill="${C.heading}">${label}</text>` +
      `<text x="${x + 18}" y="302" font-family="DejaVu Sans, sans-serif" font-size="17" fill="${C.mark}">mark ${i === 1 ? "+" : "-"}</text>`
    );
  };
  const svg =
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="30" y="66" font-family="DejaVu Sans, sans-serif" font-size="40" fill="${C.heading}">ALPHA-ONE</text>` +
    `<text x="30" y="136" font-family="DejaVu Sans, sans-serif" font-size="40" fill="${C.bravo}">BRAVO-TWO</text>` +
    `<text x="30" y="181" font-family="DejaVu Sans, sans-serif" font-size="13" fill="${C.charlie}">CHARLIE-THREE-8g7x2</text>` +
    ["DELTA", "ECHO", "FOXTROT", "GOLF"].map((l, i) => box(i, l)).join("") +
    `<text x="30" y="402" font-family="DejaVu Sans, sans-serif" font-size="30" fill="${C.hotel}">HOTEL-FIVE-INVISIBLE</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** An image whose ONLY text colour comfortably passes AA. */
export async function buildAllPassingFixture() {
  const svg =
    `<svg width="400" height="120" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="400" height="120" fill="#1a1814"/>` +
    `<text x="20" y="70" font-family="DejaVu Sans, sans-serif" font-size="36" fill="#e8dfd0">ONLY PASSES</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Deterministic gradient + gaussian noise, optionally with known text. */
export async function buildPhotographicFixture({ w = 700, h = 360, noise = 8, text = false, seed = 5 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.6 + (y / h) * 0.4;
      const base = 115 + 70 * t;
      const i = (y * w + x) * 3;
      buf[i] = Math.max(0, Math.min(255, Math.round(base + gauss() * noise)));
      buf[i + 1] = Math.max(0, Math.min(255, Math.round(base * 0.96 + gauss() * noise)));
      buf[i + 2] = Math.max(0, Math.min(255, Math.round(base * 0.9 + gauss() * noise)));
    }
  }
  let img = sharp(buf, { raw: { width: w, height: h, channels: 3 } });
  if (text) {
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <text x="20" y="70" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#ffffff">PHOTO-WHITE-LINE</text>
      <text x="20" y="150" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#2b2b2b">PHOTO-DARK-LINE</text>
      <text x="20" y="235" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#f2b8b8">PHOTO-PINK-LINE</text>
    </svg>`;
    img = img.composite([{ input: Buffer.from(svg), blend: "over" }]);
  }
  return img.png().toBuffer();
}

/** A dense grid of flat panels (realistic dashboard) — bimodal tiles. */
export async function buildDenseFlatFixture() {
  const parts = [`<rect width="1400" height="900" fill="#0f1216"/>`];
  const greys = ["#161a20", "#1b2027", "#20262e"];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 20 + c * 345;
      const y = 20 + r * 146;
      parts.push(`<rect x="${x}" y="${y}" width="325" height="126" rx="6" fill="${greys[(r + c) % 3]}" stroke="#2a313a"/>`);
      parts.push(`<text x="${x + 14}" y="${y + 58}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#7ee787">${r}${c}</text>`);
    }
  }
  return sharp(Buffer.from(`<svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

export const PHOTO_TEXT_COLOURS = ["#ffffff", "#2b2b2b", "#f2b8b8"];

/**
 * Grayscale gradient + uniform noise, with known text lines.
 *
 * Reproduces the third-audit fixtures (F2/F4): a non-flat background plus text
 * tones that are collinear on the grey ramp, so a mid tone sits exactly between
 * the dark background and a brighter text run.
 *
 * @param {{ w?:number, h?:number, noise?:number, seed?:number,
 *           lines?: Array<{text:string,y:number,fill:string,size?:number}> }} [opts]
 */
export async function buildGradientTextFixture({
  w = 900, h = 420, noise = 14, seed = 7,
  lines = [
    { text: "BRIGHT-ONE", y: 60, fill: "#f0f0f0" },
    { text: "FAILING-TWO", y: 170, fill: "#5a5a5a" },
  ],
} = {}) {
  let s = seed >>> 0;
  const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = 20 + 120 * (x / w);
      const n = Math.round((rnd() * 2 - 1) * noise);
      const v = Math.max(0, Math.min(255, Math.round(base + n)));
      const i = (y * w + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    lines.map((l) => `<text x="40" y="${l.y}" font-family="DejaVu Sans, sans-serif" font-size="${l.size ?? 44}" fill="${l.fill}">${l.text}</text>`).join("") +
    `</svg>`;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .png().toBuffer();
}

/** Flat background with known text lines (control for the gradient fixture). */
export async function buildFlatTextFixture({
  w = 900, h = 420, background = "#141414",
  lines = [
    { text: "BRIGHT-ONE", y: 60, fill: "#f0f0f0" },
    { text: "MID-TWO", y: 170, fill: "#969696" },
  ],
} = {}) {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    lines.map((l) => `<text x="40" y="${l.y}" font-family="DejaVu Sans, sans-serif" font-size="${l.size ?? 44}" fill="${l.fill}">${l.text}</text>`).join("") +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Two large flat panels: a dark sidebar (left) and a bright content panel
 * (right), with text on each. Reproduces the third-audit F5 layout.
 *
 * The sidebar text is the point: it is low-contrast against its OWN panel
 * (default #3c3c3c on #161616 = 1.64:1, failing) but high-contrast against the
 * modal panel. A single-background model used to absorb it into the sidebar and
 * report `all_meet_aa: true`.
 *
 * @param {{ w?:number, h?:number, split?:number, sidebar?:string, content?:string,
 *           sidebarText?:string, contentText?:string, fontSize?:number }} [opts]
 */
export async function buildTwoPanelFixture({
  w = 900, h = 420, split = 270,
  sidebar = "#161616", content = "#d2d2d2",
  sidebarText = "#3c3c3c", contentText = "#282828",
  fontSize = 38,
} = {}) {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${split}" height="${h}" fill="${sidebar}"/>` +
    `<rect x="${split}" y="0" width="${w - split}" height="${h}" fill="${content}"/>` +
    `<text x="30" y="108" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="${sidebarText}">SIDEBAR</text>` +
    `<text x="30" y="188" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="${sidebarText}">SETTINGS</text>` +
    `<text x="${split + 30}" y="108" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="${contentText}">CONTENT-OK</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export const TWO_PANEL = {
  region: { left: 0, top: 0, width: 900, height: 420 },
  sidebarText: "#3c3c3c",
  sidebarRatio: 1.64,
  contentText: "#282828",
  contentRatio: 9.75,
  sidebarCrop: { left: 20, top: 60, width: 240, height: 130 },
};
