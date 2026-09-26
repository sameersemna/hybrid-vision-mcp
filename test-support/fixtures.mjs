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

/**
 * A shallow, NOISELESS horizontal gradient with two text runs — the fifth-audit
 * F6 fixture.
 *
 * It is the disclosed residual made concrete: `explained_fraction` lands at ~0.5
 * (just above the adequacy floor, so the global path calls it fine), yet the
 * background ramps across the region, so a global background misses the dark
 * text run that the per-tile model resolves. The point of the fixture is that
 * the response must not read `all_meet_aa: true` with empty `notes`.
 *
 * @param {{ w?:number, h?:number, lo?:number, hi?:number, bright?:string,
 *           dark?:string, fontSize?:number }} [opts]
 */
export async function buildShallowGradientFixture({
  w = 900, h = 420, lo = 48, hi = 60,
  bright = "#f0f0f0", dark = "#8c8c8c", fontSize = 46,
} = {}) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(lo + (hi - lo) * (x / w));
      const i = (y * w + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="40" y="60" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="${bright}">BRIGHT-ONE</text>` +
    `<text x="40" y="200" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="${dark}">DARK-TWO</text>` +
    `</svg>`;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .png().toBuffer();
}

/** A STEEP noiseless gradient (a clear failure of the single-colour model). */
export async function buildSteepGradientFixture() {
  return buildShallowGradientFixture({ lo: 20, hi: 220 });
}

/** A plain flat UI with a grid of cards — a legitimate single-background case. */
export async function buildCardsFlatFixture() {
  const W = 1200, H = 800;
  const parts = [`<rect width="${W}" height="${H}" fill="#f5f5f5"/>`];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = 40 + c * 380;
      const y = 40 + r * 240;
      parts.push(`<rect x="${x}" y="${y}" width="340" height="200" rx="8" fill="#ffffff" stroke="#dddddd"/>`);
      parts.push(`<text x="${x + 20}" y="${y + 60}" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#333333">Card ${r}${c}</text>`);
    }
  }
  return sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

/** A text-heavy FLAT page — must NOT be flagged as a marginal/gradient region. */
export async function buildTextHeavyFlatFixture() {
  const W = 1200, H = 800;
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`<text x="20" y="${30 + i * 25}" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#222222">The quick brown fox jumps over the lazy dog 0123456789</text>`);
  }
  return sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#ffffff"/>${lines.join("")}</svg>`)).png().toBuffer();
}

export const SHALLOW_GRADIENT = {
  region: { left: 0, top: 0, width: 900, height: 420 },
  darkText: "#8c8c8c",
  crop: { left: 30, top: 180, width: 400, height: 70 },
};

/**
 * A tiled card dashboard: repeated identical cards on a page background with
 * ALL text one high-contrast colour.
 *
 * This is the sixth-audit F7 fixture. The card fill is "many small identical
 * blobs" — the same signature as a glyph run — so the single-blob plateau test
 * rejected it, the page background became one huge "ink" component, and the page
 * was reported as failing text even though every text colour passes.
 *
 * @param {{ w?:number, h?:number, cols?:number, rows?:number, page?:string,
 *           card?:string, text?:string }} [opts]
 */
export async function buildTiledCardsFixture({
  w = 1200, h = 700, cols = 4, rows = 3,
  page = "#1a1814", card = "#2d2822", text = "#e8dfd0",
} = {}) {
  const parts = [`<rect width="${w}" height="${h}" fill="${page}"/>`];
  for (let i = 0; i < cols * rows; i++) {
    const x = 40 + (i % cols) * 280;
    const y = 40 + Math.floor(i / cols) * 220;
    parts.push(`<rect x="${x}" y="${y}" width="240" height="180" fill="${card}"/>`);
    parts.push(`<text x="${x + 16}" y="${y + 46}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="${text}">KPI ${i + 1}</text>`);
    parts.push(`<text x="${x + 16}" y="${y + 96}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="${text}">value 42</text>`);
    parts.push(`<text x="${x + 16}" y="${y + 141}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="${text}">trend</text>`);
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

/** The same tiled structure in a light theme (opposite polarity). */
export async function buildTiledCardsLightFixture() {
  return buildTiledCardsFixture({ page: "#f0efec", card: "#ffffff", text: "#1e1e1e" });
}

/** A page background that is TEXTURED (not flat) with regular cards on it.
 *  The page fails the plateau flatness test, so only the large-background-region
 *  backstop can stop it being reported as failing text. */
export async function buildTexturedPageCardsFixture({ w = 1200, h = 700 } = {}) {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = 26 + Math.round((rnd() - 0.5) * 10);
      buf[i] = v; buf[i + 1] = v - 2; buf[i + 2] = v - 6;
    }
  }
  const parts = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 40 + c * 280;
      const y = 40 + r * 220;
      parts.push(`<rect x="${x}" y="${y}" width="240" height="180" fill="#2d2822"/>`);
      parts.push(`<text x="${x + 16}" y="${y + 46}" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#e8dfd0">KPI</text>`);
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`), blend: "over" }])
    .png().toBuffer();
}

export const TILED_CARDS = {
  region: { left: 0, top: 0, width: 1200, height: 700 },
  page: "#1a1814",
  card: "#2d2822",
  text: "#e8dfd0",
  lightPage: "#f0efec",
  lightCard: "#ffffff",
  lightText: "#1e1e1e",
};

/**
 * Two huge, IDENTICAL glyphs on a plain background — the seventh-audit F8 fixture.
 *
 * A 300px bold glyph "blob" is a RING: inset from the region border with a low
 * fill (measured 0.556). Two identical rings give the colour a dominance of
 * exactly 0.5, which was the single-blob plateau threshold, so the TEXT COLOUR
 * was accepted as a plateau, became background, and the failing text was either
 * reduced to AA remnants or (hard-edged) not reported at all.
 *
 * @param {{ w?:number, h?:number, text?:string, fill?:string, background?:string,
 *           size?:number, hardEdge?:boolean }} [opts]
 */
export async function buildHugeGlyphFixture({
  w = 900, h = 420, text = "OO", fill = "#464646", background = "#1a1814",
  size = 300, hardEdge = false,
} = {}) {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    `<text x="10" y="${size + 20}" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${size}" fill="${fill}">${text}</text>` +
    `</svg>`;
  let img = sharp(Buffer.from(svg));
  if (hardEdge) {
    // Posterise to exactly two colours, removing anti-aliasing entirely: the
    // rendering condition under which the failure is completely invisible.
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    const target = [
      parseInt(fill.slice(1, 3), 16), parseInt(fill.slice(3, 5), 16), parseInt(fill.slice(5, 7), 16),
    ];
    const bg = [
      parseInt(background.slice(1, 3), 16), parseInt(background.slice(3, 5), 16), parseInt(background.slice(5, 7), 16),
    ];
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += channels) {
      const dF = (data[i] - target[0]) ** 2 + (data[i + 1] - target[1]) ** 2 + (data[i + 2] - target[2]) ** 2;
      const dB = (data[i] - bg[0]) ** 2 + (data[i + 1] - bg[1]) ** 2 + (data[i + 2] - bg[2]) ** 2;
      const c = dF < dB ? target : bg;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
    img = sharp(out, { raw: { width, height: info.height, channels } });
  }
  return img.png().toBuffer();
}

export const HUGE_GLYPH = {
  region: { left: 0, top: 0, width: 900, height: 420 },
  text: "#464646",
  ratio: 1.88,
  background: "#1a1814",
};

/**
 * A content-dense inset panel (chart card) — the eighth-audit F10 fixture.
 *
 * A dark inset card is perforated by many light bars. The card's fill therefore
 * drops below a global fill threshold, and the pre-fix `fill >= 0.85` shape test
 * rejected the card as a panel: the card fill became ink, its representative
 * colour resolved against the LIGHT bars (11.74:1, passing), and the real text
 * `#666460` at 2.47:1 was absorbed and never enumerated — a false pass.
 *
 * An inset panel whose interior is dense content is an ordinary shape (chart
 * card, table, thumbnail grid), so this must be treated as a panel.
 *
 * @param {{ w?:number, h?:number, page?:string, card?:string, bar?:string,
 *           text?:string, inset?:boolean, dense?:boolean, bars?:number }} [opts]
 */
export async function buildDensePanelFixture({
  w = 1000, h = 700, page = "#f0efec", card = "#2d2822", bar = "#ebe6dc",
  text = "#666460", inset = true, dense = true, bars = 64,
} = {}) {
  const box = inset ? { x: 60, y: 40, w: 880, h: 620 } : { x: 0, y: 0, w, h };
  const parts = [`<rect width="${w}" height="${h}" fill="${page}"/>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${card}"/>`];
  if (dense) {
    // Deterministic pseudo-random bar heights (no RNG dependency).
    let s = 4;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < bars; i++) {
      const x = box.x + 18 + i * 13;
      const hh = 80 + Math.round(rnd() * 300);
      parts.push(`<rect x="${x}" y="${box.y + box.h - 40 - hh}" width="11" height="${hh}" fill="${bar}"/>`);
    }
  }
  if (text) {
    parts.push(`<text x="${box.x + 20}" y="${box.y + 50}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">DASHBOARD</text>`);
    parts.push(`<text x="${box.x + 20}" y="${box.y + 100}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">summary</text>`);
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

export const DENSE_PANEL = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  text: "#666460",
  ratio: 2.47,
  headerCrop: { left: 70, top: 45, width: 300, height: 90 },
};

/**
 * Two huge SOLID glyph blocks on a plain background — the residual F10 shape the
 * shape tests cannot resolve (a solid glyph has fill 1.0, dominance 1.0, no holes,
 * inset — indistinguishable from a solid inset panel by geometry alone). It must
 * therefore ABSTAIN or DISCLOSE, never report `all_meet_aa: true`.
 */
export async function buildSolidGlyphFixture({ text = "\u2588\u2588", size = 300, w = 900, h = 420 } = {}) {
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#1a1814"/>` +
    `<text x="20" y="${size}" font-family="DejaVu Sans, sans-serif" font-size="${size}" fill="#464646">${text}</text>` +
    `</svg>`,
  )).png().toBuffer();
}

/**
 * An inset card whose interior is filled by many DECORATIVE bars, with all text
 * passing — the ninth-audit F11 fixture.
 *
 * The bars are themselves a tiled "panel" colour, so the un-masked reconciliation
 * pass re-reads them as text and (pre-fix) told the caller a CORRECT verdict was
 * unverified. Decoration is not text, so the disclosure must not fire here.
 *
 * @param {{ bar?:string, text?:string, bars?:number, inset?:boolean }} [opts]
 */
export async function buildDecorativeBarsFixture({
  bar = "#783c3c", text = "#b9b5ae", bars = 64, inset = true, w = 1000, h = 700,
} = {}) {
  const box = inset ? { x: 60, y: 40, w: 880, h: 620 } : { x: 0, y: 0, w, h };
  const parts = [`<rect width="${w}" height="${h}" fill="#f0efec"/>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#2d2822"/>`];
  for (let i = 0; i < bars; i++) {
    const x = box.x + 18 + i * 13;
    const hh = 80 + (i * 37) % 300;
    parts.push(`<rect x="${x}" y="${box.y + box.h - 40 - hh}" width="11" height="${hh}" fill="${bar}"/>`);
  }
  parts.push(`<text x="${box.x + 20}" y="${box.y + 50}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">DASHBOARD</text>`);
  parts.push(`<text x="${box.x + 20}" y="${box.y + 100}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="${text}">summary</text>`);
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

/**
 * A panel-shaped colour that the mask dropped and that an un-masked pass measures
 * as FAILING, where the region is large enough to be either a panel or very large
 * text — the shape the reconciliation exists to disclose. Two solid failing
 * rectangles on a dark page (each ~18% of the region).
 */
export async function buildDroppedPanelFixture({ fill = "#464646", background = "#1a1814", w = 1000, h = 700 } = {}) {
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    `<rect x="60" y="40" width="420" height="620" fill="${fill}"/>` +
    `<rect x="520" y="40" width="420" height="620" fill="${fill}"/>` +
    `</svg>`,
  )).png().toBuffer();
}

/**
 * Two large solid bold "II" runs in a failing colour — the tenth-audit F12 fixture.
 *
 * Region 1000x700. The glyph blobs land between the tiling floor (0.4% of the
 * region) and the old reconciliation gate (2%), so at ~200-350px the colour was
 * MASKED as a plateau and then never disclosed: `colours: []`, `measurable: false`,
 * `mask_reconciliation: null`. Below ~180px it is not masked and is reported
 * normally; above ~400px the old gate fired. Cropping always fired, so the full
 * frame was less informative than a crop.
 *
 * @param {{ size?:number, text?:string, fill?:string, background?:string, w?:number, h?:number }} [opts]
 */
export async function buildBandGlyphFixture({
  size = 200, text = "II", fill = "#464646", background = "#1a1814", w = 1000, h = 700,
} = {}) {
  // Two stacked runs, matching the audit's layout.
  const run = (y, label) =>
    `<text x="60" y="${y}" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${size}" fill="${fill}">${label}</text>`;
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    run(80 + size, text) +
    run(400 + size, text) +
    `</svg>`,
  )).png().toBuffer();
}

export const BAND_GLYPH = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  text: "#464646",
  ratio: 1.88,
  crop: { left: 40, top: 60, width: 400, height: 260 },
};

/**
 * A large drop-cap "I" plus a run of small glyphs, ALL in one failing colour —
 * the eleventh-audit F13(a) fixture.
 *
 * The drop-cap blob alone holds >= 2% of the region, so the plateau detector
 * accepts the colour as a plateau (path A) and the mask removes it. But the
 * colour's MEAN blob is dragged below 0.4% by the many small companion glyphs, so
 * the old disclosure gate (`mean >= 0.4%`, the tenth-audit fix) returned false and
 * the colour vanished: `colours` held only AA remnants, `mask_reconciliation` was
 * null. This is the exact seam the tenth audit claimed could not exist, because it
 * compared a mean against a single-blob floor. Same colour as BAND_GLYPH (1.88:1),
 * so the two share a ratio and a ground truth.
 */
export async function buildDropcapTextFixture({
  fill = "#464646", background = "#1a1814", w = 1000, h = 700,
} = {}) {
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    `<text x="20" y="300" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="330" fill="${fill}">I</text>` +
    `<text x="150" y="660" font-family="DejaVu Sans, sans-serif" font-size="55" fill="${fill}">settings</text>` +
    `</svg>`,
  )).png().toBuffer();
}

export const DROPCAP_TEXT = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  text: "#464646",
  ratio: 1.88,
};

/**
 * One solid inset PANEL (200x80 = 2.29% of the region) beside ten small
 * fragments, all of one failing colour — the eleventh-audit F13(b) fixture.
 *
 * The panel clears the mask's path-A floor (a single blob >= 2%) so the colour is
 * masked; the ten fragments pull the mean well below 0.4%, so the old gate hid it.
 * Unlike F13(a) the masked result is EMPTY (`colours: []`, `measurable: false`), so
 * an omission here is total: the caller sees no colour and no disclosure at all.
 */
export async function buildPanelPlusFragmentsFixture({
  fill = "#464646", background = "#1a1814", w = 1000, h = 700, fragments = 10,
} = {}) {
  const parts = [`<rect width="${w}" height="${h}" fill="${background}"/>`,
    `<rect x="100" y="100" width="200" height="80" fill="${fill}"/>`];
  for (let i = 0; i < fragments; i++) {
    parts.push(`<rect x="${80 + i * 90}" y="420" width="24" height="14" fill="${fill}"/>`);
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

export const PANEL_FRAGMENTS = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  text: "#464646",
  ratio: 1.88,
};

/**
 * A 300px solid bold "II" heading in a failing colour, and nothing else — the
 * twelfth-audit F14 control D.
 *
 * The heading glyph blobs land at largest-blob 1.74% of the region (< the mask's
 * path-A floor of 2%) with only two components, so clause 2 (the mean) is the only
 * channel: mean 1.78% and it DISCLOSES.
 */
export async function buildHeadingOnlyFixture({
  fill = "#464646", background = "#1a1814", w = 1000, h = 700,
} = {}) {
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    `<text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="300" fill="${fill}">II</text>` +
    `</svg>`,
  )).png().toBuffer();
}

/**
 * The same 300px heading PLUS six 28px body lines in the SAME failing colour —
 * the twelfth-audit F14 fixture E.
 *
 * This is the inversion: the colour's `pixel_count` and `component_count` rise
 * together (24,966px/2 → 44,226px/164), so the mean COLLAPSES from 1.78% to 0.04%
 * and the largest blob is unchanged at 1.74%. Adding more failing text therefore
 * made the warning DISAPPEAR under any mean-based gate — the seam was
 * anti-correlated with the evidence, not merely ambiguous. Now disclosed.
 */
export async function buildHeadingPlusBodyFixture({
  fill = "#464646", background = "#1a1814", w = 1000, h = 700, lines = 6,
} = {}) {
  const body = Array.from({ length: lines }, (_, l) =>
    `<text x="520" y="${300 + l * 36}" font-family="DejaVu Sans, sans-serif" font-size="28" fill="${fill}">The quick brown fox jumps over</text>`).join("");
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>` +
    `<text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="300" fill="${fill}">II</text>` +
    body +
    `</svg>`,
  )).png().toBuffer();
}

/**
 * Five solid rectangles at 0.446% each (path B sums to 2.26%, so they mask) plus
 * twenty small fragments, ALL one failing colour — the twelfth-audit F14
 * solid-block form, with no text at all.
 *
 * The masked result is EMPTY (`colours: []`, `measurable: false`) and the largest
 * blob is 0.45% / mean 0.11%, so both the old clauses were false: the seam with the
 * F13(b) omission but no glyphs involved.
 */
export async function buildResidualSolidTiledFixture({
  fill = "#464646", background = "#1a1814", w = 1000, h = 700, blocks = 5, fragments = 20,
} = {}) {
  const big = Array.from({ length: blocks }, (_, i) =>
    `<rect x="${60 + i * 180}" y="80" width="52" height="60" fill="${fill}"/>`).join("");
  const small = Array.from({ length: fragments }, (_, i) =>
    `<rect x="${40 + (i % 10) * 95}" y="${420 + Math.floor(i / 10) * 40}" width="14" height="10" fill="${fill}"/>`).join("");
  return sharp(Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${background}"/>${big}${small}</svg>`,
  )).png().toBuffer();
}

export const HEADING_ONLY = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  text: "#464646",
  ratio: 1.88,
};
export const HEADING_PLUS_BODY = { ...HEADING_ONLY };
export const RESIDUAL_SOLID_TILED = { ...HEADING_ONLY };
/**
 * A dashboard with a small SOLID decorative accent block — the ninth-audit §3
 * observation. Deliberately retained as a KNOWN, DECLINED false positive: see
 * ACCURACY.md 5k for the measurement showing a bold "I" at 150px is
 * indistinguishable from it (3000px vs 3052px, both fill 1.000), so any rule that
 * suppresses the accent would also suppress real solid text.
 */
export async function buildAccentBlockFixture({ accent = "#3c5a3c", cards = 4, w = 1200, h = 700 } = {}) {
  const parts = [`<rect width="${w}" height="${h}" fill="#1a1814"/>`];
  for (let i = 0; i < cards; i++) {
    const x = 40 + i * 290;
    parts.push(`<rect x="${x}" y="40" width="250" height="620" fill="#2d2822"/>`);
    parts.push(`<rect x="${x + 20}" y="140" width="50" height="60" fill="${accent}"/>`);
    parts.push(`<text x="${x + 20}" y="100" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#e8dfd0">KPI</text>`);
  }
  return sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`)).png().toBuffer();
}

export const DECOR_BARS = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  bar: "#783c3c",
  text: "#b9b5ae",
  textRatio: 7.15,
};

export const DROPPED_PANEL = {
  region: { left: 0, top: 0, width: 1000, height: 700 },
  fill: "#464646",
  ratio: 1.88,
};

export const ACCENT_BLOCK = {
  region: { left: 0, top: 0, width: 1200, height: 700 },
  accent: "#3c5a3c",
  accentRatio: 1.89,
  text: "#e8dfd0",
};
