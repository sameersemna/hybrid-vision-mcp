import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import dns from "node:dns";
import net from "node:net";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveWithinBase, isPathWithinAllowedRoots } from "./lib/validation.js";

// --- Accuracy hardening modules (additive) ---
import { queryOllamaVisionText, getModelResidency, listInstalledVisionModels } from "./lib/vision.js";
import { measureImage, analyzeStructured } from "./lib/analyze.js";
import { CLAIM_SCHEMA, detectQuantitativeQuestion } from "./lib/prompts.js";
import { crossValidateText } from "./lib/crossvalidate.js";
import { buildProvenance, prepareForVision, DEFAULT_LEGIBILITY_FLOOR } from "./lib/legibility.js";
import {
  truncateForClient,
  truncateJsonForClient as truncateJsonForClientImpl,
} from "./lib/response.js";

// ==========================================
// .env Loader (zero-dependency)
// ==========================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
const LOG_PREFIX = "[hybrid-vision-mcp]";

function logInfo(message, ...details) {
  console.error(`${LOG_PREFIX} ${message}`, ...details);
}

function logWarn(message, ...details) {
  console.error(`${LOG_PREFIX} WARN ${message}`, ...details);
}

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
  logInfo(`[CONFIG] Loaded environment from ${envPath}`);
}

// ==========================================
// Process Guards
// ==========================================
process.on("uncaughtException", (err) => {
  logWarn("Caught uncaught exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  logWarn("Caught unhandled rejection:", reason);
});

// ==========================================
// Configuration
// ==========================================
const PORT = process.env.PORT || 11402;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 180000;
// Vision models are heavy (VRAM/unified-memory bound); running several concurrently has been
// observed to crash the host. Default to strictly serialized Ollama calls; raise only if the
// host has headroom to run more than one vision inference at a time.
const MAX_PARALLEL_OLLAMA_REQUESTS = Math.max(1, Number(process.env.MAX_PARALLEL_OLLAMA_REQUESTS) || 1);
// Caps how many callers can be queued waiting for a slot before new requests are rejected
// outright, so a burst of clients fails fast instead of piling up indefinitely.
const MAX_OLLAMA_QUEUE_SIZE = Math.max(0, Number(process.env.MAX_OLLAMA_QUEUE_SIZE) || 20);
const MCP_REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 300000;
const VISION_MODEL_FAST = process.env.VISION_MODEL_FAST || "llava:13b";
const VISION_MODEL_HEAVY = process.env.VISION_MODEL_HEAVY || "qwen3-vl:30b";
// How long Ollama keeps a model resident after a request (Ollama default is 5m).
// Passed through so callers can pin or pre-load models deliberately.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || undefined;
// Sampling is pinned for reproducibility. A vision model given temperature 0
// plus an explicit seed produces stable output for the same input.
const VISION_TEMPERATURE = Number(process.env.VISION_TEMPERATURE ?? 0);
const VISION_SEED = Number(process.env.VISION_SEED ?? 42);
const VISION_NUM_PREDICT = Number(process.env.VISION_NUM_PREDICT ?? 2048);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/hvm-uploads";
const FEEDBACK_DIR = process.env.FEEDBACK_DIR || "/tmp/hvm-feedback";
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || "./tmp/hvm-downloads");
const MAX_UPLOAD_AGE_MS = 15 * 60 * 1000;
// Parse the configured megabyte value *first*, then scale. The previous form
// `Number(env) * 1024 * 1024 || 20 * 1024 * 1024` only fell back to 20MB because
// NaN propagates through the multiplication, which is opaque and silently
// swallowed a typo'd value. This mirrors the MAX_DOWNLOAD_SIZE_BYTES idiom
// immediately below and warns when the configured value is unusable.
const MAX_UPLOAD_SIZE_MB = (() => {
  const raw = process.env.MAX_UPLOAD_SIZE_MB;
  if (raw === undefined || raw === "") return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logWarn(`[CONFIG] MAX_UPLOAD_SIZE_MB="${raw}" is not a positive number; using default 20MB.`);
    return 20;
  }
  return parsed;
})();
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_DOWNLOAD_SIZE_BYTES = (Number(process.env.MAX_DOWNLOAD_SIZE_MB) || 50) * 1024 * 1024;
const MAX_RESPONSE_TEXT_CHARS = Number(process.env.MAX_RESPONSE_TEXT_CHARS) || 12000;
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.UPLOAD_RATE_LIMIT) || 10;
const CORS_ORIGINS = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()) : [];

// Roots that generate_repo_graph is permitted to walk. Defaults to the server's own
// project directory so the tool remains useful out of the box without granting
// full-filesystem enumeration to any unauthenticated network client. Override with a
// comma-separated absolute path list if other repos should be mappable.
const ALLOWED_REPO_ROOTS = (process.env.ALLOWED_REPO_ROOTS
  ? process.env.ALLOWED_REPO_ROOTS.split(",").map((s) => s.trim()).filter(Boolean)
  : [__dirname]
).map((p) => path.resolve(p));

const uploadRateLimiter = new Map();
function checkUploadRateLimit(clientIp) {
  const now = Date.now();
  const window = uploadRateLimiter.get(clientIp);
  if (!window) {
    uploadRateLimiter.set(clientIp, [now]);
    return true;
  }
  const recent = window.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  uploadRateLimiter.set(clientIp, recent);
  return true;
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

function setCorsHeaders(req, res) {
  const origin = req.get("origin");
  if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Content-Length");
    res.header("Access-Control-Max-Age", "86400");
  }
}

function resolveMimeTypeFromMagic(buf, declaredType) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  }
  if (declaredType && ALLOWED_UPLOAD_MIME_TYPES.has(declaredType)) return declaredType;
  return null;
}

// ==========================================
// Helper Functions & Image Validation
// ==========================================

function sanitizeBase64(input) {
  if (!input || typeof input !== "string") return "";
  let cleaned = input.trim();
  if (cleaned.includes("%")) {
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // fallback if not valid URI encoding
    }
  }
  // Replace space artifacts from HTTP query/body decoding back to '+'
  // and strip line breaks/whitespace
  return cleaned.replace(/ /g, "+").replace(/[\r\n\s]/g, "");
}

/**
 * Truncate a JSON-serialisable value while keeping the result VALID JSON.
 *
 * Delegates to lib/response.js so the behaviour is unit-tested directly
 * (index.js is a server entrypoint and exports nothing).
 *
 * A plain string slice cut structured responses mid-token, producing output
 * that could not be parsed (observed live when a structured analysis response
 * exceeded the cap).
 *
 * @param {any} value
 * @param {number} [maxChars]
 * @returns {string} valid JSON
 */
function truncateJsonForClient(value, maxChars = MAX_RESPONSE_TEXT_CHARS) {
  return truncateJsonForClientImpl(value, maxChars);
}

function isSupportedImageBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WEBP (RIFF)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

async function resolveImageToBuffer(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Image input must be a non-empty string.");
  }

  let trimmed = input.trim();

  // 1. Data URI (e.g., data:image/png;base64,...)
  if (trimmed.startsWith("data:image/")) {
    const parts = trimmed.split(",");
    if (parts.length < 2) throw new Error("Invalid Data URI format.");
    const cleanBase64 = sanitizeBase64(parts[1]);
    const buf = Buffer.from(cleanBase64, "base64");
    if (!isSupportedImageBuffer(buf)) {
      throw new Error("Data URI payload does not contain valid binary image header bytes.");
    }
    return buf;
  }

  // 2. Handle file:// URI scheme
  if (trimmed.startsWith("file://")) {
    try {
      trimmed = fileURLToPath(trimmed);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, "");
    }
  }

  // 3. Handle ~ expansion for home directory
  if (trimmed.startsWith("~/") || trimmed === "~") {
    trimmed = trimmed.replace(/^~/, os.homedir());
  }

  // 4. HTTP / HTTPS URL — download to disk, then return buffer
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const result = await downloadImageToFile(trimmed);
    return fs.promises.readFile(result.filePath);
  }

  // 5. Local File Path (Only works if client and MCP server share a filesystem)
  if (trimmed.startsWith("upload://")) {
    const filename = trimmed.slice("upload://".length);
    const fullPath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(fullPath)) {
      const buf = await fs.promises.readFile(fullPath);
      if (buf.length === 0) throw new Error(`Uploaded file "${filename}" is empty.`);
      if (!isSupportedImageBuffer(buf)) throw new Error(`Uploaded file "${filename}" is not a supported image format.`);
      return buf;
    }
    throw new Error(`Upload reference not found: "${trimmed}". Upload the image to /upload first.`);
  }

  // 5b. download:// reference — resolves from DOWNLOAD_DIR
  if (trimmed.startsWith("download://")) {
    const filename = trimmed.slice("download://".length);
    const fullPath = path.join(DOWNLOAD_DIR, filename);
    if (fs.existsSync(fullPath)) {
      const buf = await fs.promises.readFile(fullPath);
      if (buf.length === 0) throw new Error(`Downloaded file "${filename}" is empty.`);
      if (!isSupportedImageBuffer(buf)) throw new Error(`Downloaded file "${filename}" is not a supported image format.`);
      return buf;
    }
    throw new Error(`Download reference not found: "${trimmed}". Download the image using the download_image tool first.`);
  }

  if (fs.existsSync(trimmed)) {
    const buf = await fs.promises.readFile(trimmed);
    if (buf.length === 0) {
      throw new Error(`File at "${trimmed}" is 0 bytes (empty file).`);
    }
    if (!isSupportedImageBuffer(buf)) {
      throw new Error(`File found at "${trimmed}", but does not contain valid image header bytes.`);
    }
    return buf;
  }

  // 6. Pure Base64 String Fallback
  const cleanBase64 = sanitizeBase64(trimmed);
  if (cleanBase64.length > 50) {
    const buf = Buffer.from(cleanBase64, "base64");
    if (isSupportedImageBuffer(buf)) {
      return buf;
    }
  }

  throw new Error(
    `Unable to resolve image source. File not found on MCP server host at: "${trimmed}". Because the MCP server is hosted remotely, transmit the image as a Base64 Data URI ('data:image/png;base64,...') or an HTTP URL.`
  );
}

// ==========================================
// SSRF Guard
// ==========================================
// Blocks outbound image fetches from reaching loopback, private (RFC1918), link-local
// (incl. cloud metadata endpoints like 169.254.169.254), and other non-public address
// ranges. This is a DNS-resolution-time check: it mitigates the common case (attacker
// passes a URL whose hostname resolves to an internal address) but does not fully
// defend against DNS-rebinding attacks (the resolved IP could differ at connect time),
// since Node's fetch() does not expose a way to pin the connection to the IP we
// validated. Revisit with a custom dispatcher/lookup override if that threat model
// matters for this deployment.
function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // "this" network
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice("::ffff:".length)); // IPv4-mapped
    return false;
  }
  return true; // unrecognized -> fail closed
}

async function assertPublicHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL: must start with http:// or https://. Received: "${url.substring(0, 80)}"`);
  }
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    throw new Error(`Blocked URL: "${parsed.hostname}" resolves to the local host. Fetching internal/loopback addresses is not permitted.`);
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new Error(`Could not resolve hostname "${parsed.hostname}": ${err.message}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Hostname "${parsed.hostname}" did not resolve to any address.`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`Blocked URL: "${parsed.hostname}" resolves to a private/internal address (${address}). Fetching internal network destinations is not permitted.`);
    }
  }
}

async function downloadImageToFile(url) {
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    throw new Error(`Invalid URL: must start with http:// or https://. Received: "${typeof url === "string" ? url.substring(0, 80) : typeof url}"`);
  }

  await assertPublicHttpUrl(url);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HybridVisionMCP/1.0",
        "Accept": "image/png,image/jpeg,image/webp,image/*,*/*;q=0.8",
      },
    });
  } catch (err) {
    throw new Error(`Failed to fetch image URL (${url}): ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${response.statusText ? ": " + response.statusText : ""} when fetching ${url}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html") || contentType.includes("application/json")) {
    throw new Error(`URL returned content-type '${contentType}' instead of a valid image. Only image URLs are supported.`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(`Downloaded image exceeds maximum size of ${Math.round(MAX_DOWNLOAD_SIZE_BYTES / 1024 / 1024)}MB (Content-Length: ${Math.round(Number(contentLength) / 1024 / 1024)}MB).`);
  }

  const arrayBuf = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  if (buf.length === 0) {
    throw new Error(`Fetched image payload is empty for URL: ${url}`);
  }

  if (buf.length > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(`Downloaded image exceeds maximum size of ${Math.round(MAX_DOWNLOAD_SIZE_BYTES / 1024 / 1024)}MB (actual: ${Math.round(buf.length / 1024 / 1024)}MB).`);
  }

  if (!isSupportedImageBuffer(buf)) {
    throw new Error(`Fetched URL payload does not contain valid binary image headers. The URL may not point to a valid image file.`);
  }

  const mimeType = resolveMimeTypeFromMagic(buf, contentType) || "image/png";
  const ext = mimeType.split("/")[1] || "png";
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  try {
    fs.writeFileSync(filePath, buf);
  } catch (err) {
    throw new Error(`Failed to save downloaded image to disk: ${err.message}`);
  }

  let width = null;
  let height = null;
  try {
    const meta = await sharp(buf).metadata();
    width = meta.width;
    height = meta.height;
  } catch {}

  const downloadRef = `download://${filename}`;

  logInfo(`[DOWNLOAD] Saved ${url} -> ${filePath} (${buf.length} bytes, ${mimeType}, ${width}x${height})`);

  return { filePath, originalUrl: url, mimeType, size: buf.length, width, height, downloadRef };
}

async function normalizeToPngBuffer(buffer) {
  try {
    if (!isSupportedImageBuffer(buffer)) {
      throw new Error("Decoded image buffer does not contain a valid image header. The Base64 payload may be truncated, corrupted, or contains non-image data.");
    }
    return await sharp(buffer).toFormat("png").toBuffer();
  } catch (err) {
    if (err.message.includes("libpng read error") || err.message.includes("vipspng")) {
      throw new Error(
        `Image data was truncated or corrupted in transit (libpng read error). Check if the Base64 payload was truncated by LLM token limits. Consider using the /upload endpoint to send large images.`
      );
    }
    throw new Error(`Unsupported or corrupted image data: ${err.message}`);
  }
}

// ==========================================
// Ollama Concurrency Gate
// ==========================================
// A single Node process serves every MCP session, but Ollama vision inference is
// GPU/unified-memory bound; letting concurrent tool calls hit Ollama in parallel has been
// observed to crash the host. This gate serializes (or caps, via MAX_PARALLEL_OLLAMA_REQUESTS)
// access to queryOllamaVision so requests queue in-process instead of piling onto Ollama.
let activeOllamaRequests = 0;
const ollamaWaitQueue = [];

function acquireOllamaSlot() {
  if (activeOllamaRequests < MAX_PARALLEL_OLLAMA_REQUESTS) {
    activeOllamaRequests++;
    return Promise.resolve();
  }
  if (ollamaWaitQueue.length >= MAX_OLLAMA_QUEUE_SIZE) {
    return Promise.reject(
      new Error(
        `Ollama request queue is full (${MAX_OLLAMA_QUEUE_SIZE} already waiting, ${activeOllamaRequests} running). ` +
        `Try again shortly, or raise MAX_OLLAMA_QUEUE_SIZE / MAX_PARALLEL_OLLAMA_REQUESTS if the host has headroom.`
      )
    );
  }
  logInfo(`[OLLAMA QUEUE] Slot busy (${activeOllamaRequests}/${MAX_PARALLEL_OLLAMA_REQUESTS} active) — queuing (position ${ollamaWaitQueue.length + 1}).`);
  return new Promise((resolve) => ollamaWaitQueue.push(resolve));
}

function releaseOllamaSlot() {
  const next = ollamaWaitQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter; activeOllamaRequests stays occupied.
    next();
  } else {
    activeOllamaRequests--;
  }
}

// Vision inference goes through the hard-won concurrency gate (kept intact:
// parallel vision inference has crashed this host). The HTTP layer itself is
// now delegated to the hardened streaming client, which pins sampling params,
// distinguishes model *loading* from *inferring*, and produces timeout errors
// grounded in what is actually resident/installed on this host (F5).
//
// Returns `{ text, metrics, warnings, request }`.
async function queryOllamaVision(model, prompt, imageBuffers, opts = {}) {
  await acquireOllamaSlot();
  try {
    return await queryOllamaVisionText({
      model,
      prompt,
      images: imageBuffers,
      ollamaHost: OLLAMA_HOST,
      timeoutMs: opts.timeoutMs || OLLAMA_TIMEOUT_MS,
      keepAlive: opts.keepAlive !== undefined ? opts.keepAlive : OLLAMA_KEEP_ALIVE,
      temperature: opts.temperature !== undefined ? opts.temperature : VISION_TEMPERATURE,
      seed: opts.seed !== undefined ? opts.seed : VISION_SEED,
      numPredict: opts.numPredict !== undefined ? opts.numPredict : VISION_NUM_PREDICT,
      onProgress: opts.onProgress,
    });
  } finally {
    releaseOllamaSlot();
  }
}

// Build a compact, always-present provenance line appended to legacy text
// responses, so an agent can see which model answered, with what settings, at
// what resolution, and whether any warnings apply (§5.7).
function provenanceFooter(res, { model, sentDimensions = null, downscaled = false } = {}) {
  const m = res?.metrics || {};
  const parts = [
    `model=${model}`,
    `temperature=${res?.request?.options?.temperature ?? VISION_TEMPERATURE}`,
    `seed=${res?.request?.options?.seed ?? VISION_SEED}`,
    m.time_to_first_token_ms != null ? `ttft_ms=${m.time_to_first_token_ms}` : null,
    m.total_ms != null ? `total_ms=${m.total_ms}` : null,
    sentDimensions ? `sent=${sentDimensions.width}x${sentDimensions.height}` : null,
    `downscaled=${downscaled}`,
  ].filter(Boolean);
  const warns = (res?.warnings || []).filter(Boolean);
  let footer = `\n\n[provenance] ${parts.join(" ")}`;
  if (warns.length) {
    footer += `\n[warnings] ${warns.join(" | ")}`;
  }
  return footer;
}

function normalizeImageSources(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string") return null;

  const trimmed = input.trim();

  if (trimmed.startsWith('"[') && trimmed.endsWith(']"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON */ }
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON */ }
  }

  return null;
}

function escapeXml(input) {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return { r: 255, g: 0, b: 0, alpha: 1 };
  let clean = hex.replace("#", "");
  if (clean.length === 3) clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  const num = parseInt(clean, 16);
  if (isNaN(num)) return { r: 255, g: 0, b: 0, alpha: 1 };
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
    alpha: 1,
  };
}

function buildAnnotationOverlay(annotations, imgWidth, imgHeight) {
  if (!annotations || !Array.isArray(annotations) || annotations.length === 0) return null;

  let svgBoxes = "";
  const escapedFont = "DejaVu Sans, sans-serif";

  for (const ann of annotations) {
    if (!ann || typeof ann !== "object") continue;
    const type = String(ann.type || "").toLowerCase();
    const color = ann.color || "#FF0000";
    const rgb = hexToRgb(color);
    const font_size = Math.max(10, Math.min(72, Number(ann.font_size) || 16));

    if (type === "label" && typeof ann.text === "string" && ann.text.trim() !== "") {
      const tx = Number(ann.x) || 0;
      const ty = Number(ann.y) || 0;
      const textContent = escapeXml(ann.text);
      svgBoxes +=
        `<rect x="${tx}" y="${ty - font_size + 2}" width="${Math.max(1, Math.round(textContent.length * font_size * 0.6 + 10))}" height="${font_size + 4}" fill="rgba(${rgb.r},${rgb.g},${rgb.b},0.85)" rx="3"/>`;
      svgBoxes +=
        `<text x="${tx + 5}" y="${ty}" font-family="${escapedFont}" font-size="${font_size}" fill="white">${textContent}</text>`;
    }

    if (type === "box" || type === "rectangle") {
      const bx = Number(ann.x) || 0;
      const by = Number(ann.y) || 0;
      const bw = Math.max(1, Number(ann.width) || 50);
      const bh = Math.max(1, Number(ann.height) || 50);
      svgBoxes +=
        `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${color}" stroke-width="3" rx="2"/>`;
    }

    if (type === "circle") {
      const cx = Number(ann.x) || 0;
      const cy = Number(ann.y) || 0;
      const r = Math.max(1, Number(ann.width) || 25);
      svgBoxes +=
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="3"/>`;
    }

    if (type === "arrow") {
      const x1 = Number(ann.x) || 0;
      const y1 = Number(ann.y) || 0;
      const x2 = Number(ann.target_x) || (Number(ann.x) || 0) + 50;
      const y2 = Number(ann.target_y) || (Number(ann.y) || 0) + 50;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) continue;
      const ux = dx / len;
      const uy = dy / len;
      const arrowSize = 12;
      const tipX = x2;
      const tipY = y2;
      const baseX = x2 - ux * arrowSize;
      const baseY = y2 - uy * arrowSize;
      const perpX = -uy;
      const perpY = ux;
      svgBoxes +=
        `<line x1="${x1}" y1="${y1}" x2="${baseX}" y2="${baseY}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
      svgBoxes +=
        `<polygon points="${tipX},${tipY} ${baseX + perpX * arrowSize * 0.6},${baseY + perpY * arrowSize * 0.6} ${baseX - perpX * arrowSize * 0.6},${baseY - perpY * arrowSize * 0.6}" fill="${color}" stroke="none"/>`;
    }
  }

  if (svgBoxes === "") return null;

  const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">${svgBoxes}</svg>`;
  return Buffer.from(svg);
}

function normalizeDomFragment(dom) {
  if (!dom || typeof dom !== "string") return "";
  const trimmed = dom.trim();
  if (trimmed.length < 3) return "";
  return trimmed;
}

function normalizeCssSnapshot(css) {
  if (!css || typeof css !== "string") return "";
  const trimmed = css.trim();
  if (trimmed.length < 3) return "";
  return trimmed;
}

function extractSemanticPage(html, minTextLength = 10, includeRaw = false) {
  const controlMap = {
    title: "",
    meta: {},
    headings: [],
    navigation: { items: [], links: [] },
    main_content: [],
    lists: [],
    forms: [],
    tables: [],
    media: [],
    footer: {},
    sections: [],
    raw_stats: {}
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) controlMap.title = titleMatch[1].trim();

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  if (descMatch) controlMap.meta.description = descMatch[1];

  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const level = parseInt(hMatch[1]);
    const text = hMatch[2].replace(/<[^>]+>/g, "").trim();
    if (text.length >= minTextLength) {
      controlMap.headings.push({ level, text });
    }
  }

  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
  if (navMatch) {
    controlMap.navigation.raw = navMatch[1].trim();
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lMatch;
    while ((lMatch = linkRegex.exec(navMatch[1])) !== null) {
      controlMap.navigation.links.push({
        href: lMatch[1],
        text: lMatch[2].replace(/<[^>]+>/g, "").trim()
      });
    }
  }

  const sectionRegex = /<(main|article|section)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let sMatch;
  while ((sMatch = sectionRegex.exec(html)) !== null) {
    const tag = sMatch[1].toLowerCase();
    const attrs = sMatch[2];
    const inner = sMatch[3];
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (text.length >= minTextLength || tag === "main") {
      controlMap.sections.push({ tag, attrs, text_preview: text.substring(0, 200) });
      if (tag === "main") {
        controlMap.main_content.push({
          type: tag,
          text_preview: text.substring(0, 500),
          paragraph_count: (inner.match(/<p[^>]*>/gi) || []).length
        });
      }
    }
  }

  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(html)) !== null) {
    const text = pMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text.length >= minTextLength) {
      controlMap.main_content.push({ type: "paragraph", text_preview: text.substring(0, 200) });
    }
  }

  const listRegex = /<(ul|ol)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let listMatch;
  while ((listMatch = listRegex.exec(html)) !== null) {
    const tag = listMatch[1];
    const inner = listMatch[3];
    const items = [];
    const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let iMatch;
    while ((iMatch = itemRegex.exec(inner)) !== null) {
      const text = iMatch[1].replace(/<[^>]+>/g, "").trim();
      if (text.length >= minTextLength) items.push(text.substring(0, 100));
    }
    if (items.length > 0) {
      controlMap.lists.push({ type: tag, item_count: items.length, items: items.slice(0, 20) });
    }
  }

  const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
  let fMatch;
  while ((fMatch = formRegex.exec(html)) !== null) {
    const inner = fMatch[1];
    const inputs = (inner.match(/<input[^>]*>/gi) || []).length;
    const textareas = (inner.match(/<textarea[^>]*>/gi) || []).length;
    const selects = (inner.match(/<select[^>]*>/gi) || []).length;
    controlMap.forms.push({ inputs, textareas, selects, text_preview: inner.replace(/<[^>]+>/g, "").trim().substring(0, 200) });
  }

  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tMatch;
  while ((tMatch = tableRegex.exec(html)) !== null) {
    const inner = tMatch[1];
    const rows = (inner.match(/<tr[^>]*>/gi) || []).length;
    const headers = (inner.match(/<th[^>]*>/gi) || []).length;
    const cells = (inner.match(/<td[^>]*>/gi) || []).length;
    controlMap.tables.push({ rows, headers, cells });
  }

  const footerMatch = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  if (footerMatch) {
    controlMap.footer.text = footerMatch[1].replace(/<[^>]+>/g, "").trim().substring(0, 300);
  }

  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    controlMap.media.push({ type: "image", src: imgMatch[1], alt: imgMatch[2] });
  }

  if (includeRaw) {
    controlMap.raw_stats = {
      total_tags: (html.match(/<[^>]+>/g) || []).length,
      total_links: (html.match(/<a[^>]*>/gi) || []).length,
      total_images: (html.match(/<img[^>]*>/gi) || []).length,
      char_count: html.length
    };
  }

  return controlMap;
}

function isPathAllowedForRepoGraph(resolvedPath) {
  return isPathWithinAllowedRoots(resolvedPath, ALLOWED_REPO_ROOTS);
}

async function generateRepoGraph(repoPath, maxDepth = 5, includeNodeModules = false) {
  const resolvedPath = resolveWithinBase(__dirname, repoPath);

  if (!isPathAllowedForRepoGraph(resolvedPath)) {
    throw new Error(
      `Path "${resolvedPath}" is outside the allowed repo root(s) (${ALLOWED_REPO_ROOTS.join(", ")}). ` +
      `Set ALLOWED_REPO_ROOTS in the server's .env to permit mapping other directories.`
    );
  }

  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }
  } catch (err) {
    throw new Error(`Invalid repo path: ${resolvedPath}. ${err.message}`);
  }

  const nodes = [];
  const edges = [];
  const extCounts = {};
  const fileCounts = { total: 0, by_ext: {} };

  async function walkDir(dirPath, depth, parentId) {
    if (depth > maxDepth) return;

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!includeNodeModules && entry.name === "node_modules") continue;
        if (entry.name.startsWith(".") && entry.name !== ".git") continue;

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(resolvedPath, fullPath);
        const nodeId = relativePath.replace(/\\/g, "/");

        let nodeType = "file";
        let extension = "";
        let size = 0;

        if (entry.isDirectory()) {
          nodeType = "directory";
        } else {
          extension = path.extname(entry.name).toLowerCase();
          if (!extension.startsWith(".")) extension = "";
          try {
            const stat = await fs.promises.stat(fullPath);
            size = stat.size;
          } catch {}

          extCounts[extension || "no_ext"] = (extCounts[extension || "no_ext"] || 0) + 1;
          fileCounts.total++;
          fileCounts.by_ext[extension || "no_ext"] = (fileCounts.by_ext[extension || "no_ext"] || 0) + 1;
        }

        nodes.push({
          id: nodeId,
          type: nodeType,
          path: fullPath,
          relative_path: nodeId,
          extension: extension,
          size: size
        });

        if (parentId) {
          edges.push({ source: parentId, target: nodeId });
        }

        if (entry.isDirectory()) {
          await walkDir(fullPath, depth + 1, nodeId);
        }
      }
    } catch (err) {
      // Permission denied etc - skip
    }
  }

  await walkDir(resolvedPath, 0, null);

  const dotLines = [
    'digraph repo {',
    '  rankdir=TB;',
    '  node [shape=box, style=filled, fontname="Helvetica,Arial,sans-serif"];',
    '  edge [arrowhead=vee, fontname="Helvetica,Arial,sans-serif"];',
    ''
  ];

  for (const node of nodes) {
    const label = node.relative_path.split("/").pop();
    const fillColor = node.type === "directory" ? "#E1F5FE" : "#F5F5F5";
    const shape = node.type === "directory" ? "folder" : "box";
    dotLines.push(`  "${node.relative_path.replace(/"/g, '\\"')}" [label="${label}", shape=${shape}, fillcolor="${fillColor}"];`);
  }

  for (const edge of edges) {
    dotLines.push(`  "${edge.source.replace(/"/g, '\\"')}" -> "${edge.target.replace(/"/g, '\\"')}";`);
  }

  dotLines.push("}");

  return {
    json: {
      success: true,
      repo_path: resolvedPath,
      max_depth: maxDepth,
      node_count: nodes.length,
      edge_count: edges.length,
      file_counts: fileCounts,
      extension_distribution: extCounts,
      nodes: nodes,
      edges: edges
    },
    dot: dotLines.join("\n")
  };
}

// ==========================================
// MCP Server Factory
// ==========================================
function createMcpServer() {
  const toolSchemas = {
    imageSource: z.string().min(1).describe("Image input as data URI, URL, file path, upload://, or download:// reference."),
    imageSources: z.array(z.string().min(1)).min(2).describe("Array of image inputs."),
    optionalString: z.string().optional(),
  };
  const server = new Server(
    {
      name: "hybrid-vision-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "fast_ocr_tesseract",
          description: "Fast CPU-based WebAssembly OCR extraction for text in images.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to process. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              language: { type: "string", description: "Language code (e.g., 'eng', 'spa'). Default: 'eng'." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "preprocess_and_crop",
          description: "Computer vision image preprocessing (crop, grayscale, sharpen) using Sharp.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to preprocess. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              crop: {
                type: "object",
                properties: {
                  left: { type: "number" },
                  top: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["left", "top", "width", "height"],
              },
              grayscale: { type: "boolean" },
              sharpen: { type: "boolean" },
            },
            required: ["image_source"],
          },
        },
        {
          name: "analyze_image",
          description: "Analyze image contents or extract context using local Ollama Vision Models.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to analyze. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              prompt: { type: "string", description: "Question or instruction for analyzing the image." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "find_text_element",
          description: "Locate specific text, UI elements, or objects visually within an image.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to search. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              query: { type: "string", description: "Target text or element to locate." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source", "query"],
          },
        },
        {
          name: "compare_images",
          description: "Compare two or more images side-by-side using local Ollama Vision Models. CRITICAL: image_sources MUST be a raw JSON array of strings. NEVER wrap the array in quotes as a single string. Example: [\"data:image/png;base64,...\", \"https://...\"]",
          inputSchema: {
            type: "object",
            properties: {
              image_sources: {
                type: "array",
                minItems: 2,
                items: {
                  type: "string",
                  description: "Image input. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                  "x-mcp-file": true,
                  "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
                },
                description: "Array of image inputs. Each element accepts Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
              },
              prompt: { type: "string", description: "Comparison instructions." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_sources"],
          },
        },
        {
          name: "check_vision_health",
          title: "Vision Health Check",
          description: "Check connectivity to local Ollama service and verify vision engines.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "browser_screenshot_analysis",
          title: "Browser Screenshot Analysis",
          description: "Perform high-level visual and semantic analysis of a browser screenshot or UI image. Generates a rich description of layout, components, visual hierarchy, colors, typography, spacing, and overall design 'vibe' to help agents understand the current UI state without manual inspection.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Screenshot to analyze. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              focus: { type: "string", description: "Analysis focus area.", enum: ["all", "layout", "components", "accessibility", "design", "content"] },
              detail_level: { type: "string", description: "Level of detail.", enum: ["brief", "standard", "detailed"] },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "browser_screenshot_annotation",
          title: "Browser Screenshot Annotation",
          description: "Annotate a screenshot or image with text labels, bounding boxes, arrows, or circles to highlight specific UI components, regions of interest, or action targets. Useful for explaining UI changes or marking elements for further analysis.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to annotate. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              annotations: {
                type: "array",
                description: "Array of annotation objects to draw on the image. Each object must specify a 'type' field.",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", description: "Annotation type: 'label' for text, 'box' for bounding box, 'arrow' for direction indicator, 'circle' for highlight ring.", enum: ["label", "box", "arrow", "circle"] },
                    text: { type: "string", description: "Text content for 'label' annotations." },
                    x: { type: "number", description: "X coordinate (pixels). Anchor for label/box/circle, origin for arrow." },
                    y: { type: "number", description: "Y coordinate (pixels). Anchor for label/box/circle, origin for arrow." },
                    width: { type: "number", description: "Width in pixels for 'box', radius for 'circle'." },
                    height: { type: "number", description: "Height in pixels for 'box'." },
                    target_x: { type: "number", description: "Target X coordinate for 'arrow' endpoint." },
                    target_y: { type: "number", description: "Target Y coordinate for 'arrow' endpoint." },
                    color: { type: "string", description: "Hex color for the annotation (e.g. '#FF0000'). Default: '#FF0000'." },
                    font_size: { type: "number", description: "Font size in pixels for 'label'. Default: 16." },
                  },
                  required: ["type"],
                },
              },
              return_base64: { type: "boolean", description: "If true, returns the annotated image as a full Base64 Data URI. Default: true." },
            },
            required: ["image_source", "annotations"],
          },
        },
        {
          name: "visual_diff",
          title: "Visual Diff",
          description: "Compare two screenshots and highlight visual changes between them. Generates a pixel-level diff image that colors changed regions, and optionally an AI description of what differs between the 'before' and 'after' states.",
          inputSchema: {
            type: "object",
            properties: {
              image_sources: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: {
                  type: "string",
                  description: "Image input. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                  "x-mcp-file": true,
                  "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
                },
                description: "Array of exactly 2 image inputs: [before, after].",
              },
              threshold: { type: "number", description: "Minimum combined RGB delta to mark a pixel as changed (0-255). Default: 15." },
              highlight_color: { type: "string", description: "Hex color for changed pixels in the diff image (e.g. '#FF00FF'). Default: '#FF00FF'." },
              analyze: { type: "boolean", description: "If true, includes an Ollama Vision description of the differences. Default: true." },
            },
            required: ["image_sources"],
          },
        },
        {
          name: "detect_ui_elements",
          title: "Detect UI Elements",
          description: "Detect UI components and interactive elements in a screenshot using a vision model. Returns structured element descriptions with approximate bounding boxes and optional overlay visualization.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Screenshot to analyze. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              element_types: {
                type: "array",
                items: { type: "string" },
                description: "Filter to specific element types (e.g. ['button', 'input', 'link', 'card', 'navigation', 'modal', 'dropdown', 'checkbox', 'radio', 'table', 'list', 'icon', 'heading']). Default: scans all common UI elements.",
              },
              return_overlay: { type: "boolean", description: "If true, attempts to overlay detected elements as bounding boxes on the image. Default: false." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "textual_visual_feedback",
          title: "Textual Visual Feedback",
          description: "Generate a concise feedback object in JSON format integrating a screenshot, DOM tree, CSS styles, and OCR-derived text data. The image is saved to a local file to avoid context window overflow.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Screenshot for feedback. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              dom_fragment: { type: "string", description: "Optional HTML DOM fragment as string to include in the feedback." },
              css_snapshot: { type: "string", description: "Optional CSS styles as string to include in the feedback." },
              include_ocr: { type: "boolean", description: "If true, run OCR on the screenshot to extract text. Default: true." },
              ocr_language: { type: "string", description: "OCR language code. Default: 'eng'." }
            },
            required: ["image_source"],
          },
        },
        {
          name: "extract_semantic_page",
          title: "Extract Semantic Page",
          description: "Extract structured semantic layout from HTML using DomDistiller-inspired algorithms. Produces a structured Control Map with headings, navigation, content blocks, forms, tables, and other semantic elements.",
          inputSchema: {
            type: "object",
            properties: {
              html_content: { type: "string", description: "HTML content as string to analyze." },
              min_text_length: { type: "number", description: "Minimum character length for text blocks to include. Default: 10." },
              include_raw: { type: "boolean", description: "If true, include raw text stats in output. Default: false." }
            },
            required: ["html_content"],
          },
        },
        {
          name: "generate_repo_graph",
          title: "Generate Repo Graph",
          description: "Generate repository structural map using Graphviz DOT and JSON formats. Analyzes file tree, classifies files by extension, builds dependency-like parent-child graph for deep codebase understanding.",
          inputSchema: {
            type: "object",
            properties: {
              repo_path: { type: "string", description: "Absolute path to repository root directory." },
              max_depth: { type: "number", description: "Maximum directory depth to traverse. Default: 5." },
              include_node_modules: { type: "boolean", description: "If true, include node_modules in traversal. Default: false." }
            },
            required: ["repo_path"],
          },
        },
        {
          name: "download_image",
          title: "Download Image",
          description: "Download an image from a URL into the server's DOWNLOAD_DIR and return a download:// reference that can be passed to any other tool. Validates the URL, checks content-type, verifies image magic bytes, and enforces size limits.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "HTTP or HTTPS URL of the image to download." },
              filename: { type: "string", description: "Optional custom filename (without path). If omitted, a UUID-based name is generated." },
            },
            required: ["url"],
          },
        },
        {
          name: "measure_image",
          title: "Measure Image (deterministic)",
          description:
            "Answer MEASURABLE questions about an image with code, not a language model: WCAG contrast ratio, " +
            "dominant/background colours, box counts, region content. Uses exact pixel maths (Sharp), so results are " +
            "reproducible and remain available even when Ollama is unavailable or contended. No vision model is consulted. " +
            "Use this instead of asking a vision tool any question involving numbers.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to measure. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              mode: {
                type: "string",
                enum: ["contrast", "colors", "boxes", "layout", "all"],
                description: "Which measurement(s) to perform. Default: 'all'.",
              },
              region: {
                type: "object",
                description: "Region of interest for contrast/content measures: { left, top, width, height } in pixels.",
                properties: {
                  left: { type: "number" },
                  top: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["left", "top", "width", "height"],
              },
              box_color: {
                type: "string",
                description: "Border colour (hex) of the boxes to count. Required for mode 'boxes' — counting without it would be a guess.",
              },
              background_color: {
                type: "string",
                description: "Optional explicit background colour (hex). If omitted, the modal colour of the region is used.",
              },
              tolerance: { type: "number", description: "RGB distance tolerance for colour matching (0-255). Default: 24." },
              large_text: { type: "boolean", description: "Assess against WCAG large-text thresholds (3:1) instead of 4.5:1." },
              ink_threshold: {
                type: "number",
                description:
                  "RGB distance from the background above which a pixel counts as 'ink' during contrast enumeration. " +
                  "Default: 4. Lower it to catch text closer to the background colour (a 1.04:1 string sits ~7 units away).",
              },
              include_decorative: {
                type: "boolean",
                description:
                  "Include decorative (thin hollow rectangle) colours in the contrast summary. Default: false — such " +
                  "colours are reported separately under 'excluded' with an explicit note.",
              },
              decorative_colors: {
                type: "array",
                items: { type: "string" },
                description: "Hex colours to treat as decorative explicitly (excluded from worst/best unless include_decorative is true).",
              },
              background_mode: {
                type: "string",
                enum: ["global", "local"],
                description:
                  "How the background is modelled for contrast. 'global' (default) is a single modal colour and is " +
                  "correct for flat UI screenshots. 'local' uses a per-tile robust background with a noise-scaled " +
                  "threshold, which handles photographic, gradient or multi-tone images — note that a 48px tile " +
                  "straddling two flat panels can over-threshold, so it is opt-in rather than automatic.",
              },
              tile_size: { type: "number", description: "Tile edge in pixels for background_mode 'local'. Default: 48." },
              noise_factor: {
                type: "number",
                description: "k in `threshold = max(ink_threshold, k * local_noise_sigma)` for background_mode 'local'. Default: 4.",
              },
            },
            required: ["image_source"],
          },
        },
        {
          name: "analyze_image_structured",
          title: "Analyze Image (schema-constrained, cross-validated)",
          description:
            "Analyze an image and return STRUCTURED, EVIDENCE-BACKED output instead of free prose. Every statement is a " +
            "claims[] entry carrying its own box and confidence; transcribed text is cross-validated against Tesseract OCR and " +
            "flagged as 'unverified' when it has no OCR support and no plausible box (the fabrication signature). " +
            "Abstention is first-class: the model is instructed to use abstained[] rather than guess. " +
            "Quantitative questions are answered by deterministic measurement in code, never by the model. " +
            "Includes full provenance: model, sampling options, dimensions actually sent, and any warnings.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: {
                type: "string",
                description: "Image to analyze. Accepts: Base64 Data URI, HTTP URL, local file path, or upload://<filename>.",
                "x-mcp-file": true,
                "x-mcp-file-accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
              },
              prompt: { type: "string", description: "What to find out. A quantitative question here is routed to deterministic measurement." },
              model: { type: "string", description: "Optional Ollama vision model override." },
              crop: {
                type: "object",
                description: "Optional region to physically crop to before analysis: { left, top, width, height }. Text outside the crop cannot appear in the result.",
                properties: {
                  left: { type: "number" },
                  top: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["left", "top", "width", "height"],
              },
              cross_validate: { type: "boolean", description: "Cross-validate transcribed text against Tesseract OCR. Default: true." },
              ocr_language: { type: "string", description: "OCR language code for cross-validation. Default: 'eng'." },
              timeout_ms: { type: "number", description: "Per-request Ollama timeout in ms. Default: OLLAMA_TIMEOUT_MS." },
              keep_alive: { type: "string", description: "Ollama keep_alive value, e.g. '5m' or '0' to unload the model after this call." },
              seed: { type: "number", description: "Sampling seed for reproducibility. Default: 42." },
              temperature: { type: "number", description: "Sampling temperature. Default: 0 (deterministic)." },
            },
            required: ["image_source"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const parseArgs = (schema) => {
      const result = schema.safeParse(args);
      if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
        throw new Error(`Invalid tool arguments: ${issues}`);
      }
      return result.data;
    };

    try {
      if (name === "check_vision_health") {
        let ollamaStatus = "Disconnected";
        let modelsList = [];

        try {
          const res = await fetch(`${OLLAMA_HOST}/api/tags`);
          if (res.ok) {
            ollamaStatus = `Connected (${OLLAMA_HOST})`;
            const data = await res.json();
            modelsList = (data.models || []).map((m) => m.name);
          }
        } catch (e) {
          ollamaStatus = `Connection Error: ${e.message}`;
        }

        const healthLines = [
          "=== Vision MCP Health Status ===",
          `- Ollama Service: ${ollamaStatus}`,
          `- Installed Ollama Models: ${modelsList.length > 0 ? modelsList.join(", ") : "None detected"}`,
          "- Tesseract OCR Engine: Ready (WebAssembly)",
          "- Sharp CV Engine: Ready",
          `- Ollama Concurrency: ${activeOllamaRequests}/${MAX_PARALLEL_OLLAMA_REQUESTS} active, ${ollamaWaitQueue.length} queued (max queue ${MAX_OLLAMA_QUEUE_SIZE}).`,
        ];

        // --- Additive (F5): report which models actually hold memory right now.
        // A different model being resident is the single most common cause of a
        // slow first vision call, and the old health check never showed it.
        try {
          const residency = await getModelResidency(OLLAMA_HOST);
          if (residency.loaded.length > 0) {
            healthLines.push(
              `- Models Resident Now: ${residency.loaded
                .map((m) => `${m.name} (~${(m.size_vram / 1e9).toFixed(1)}GB VRAM${m.expires_at ? `, expires ${m.expires_at}` : ""})`)
                .join("; ")}`,
            );
            const targetResident = residency.loaded.some(
              (m) => m.name === VISION_MODEL_HEAVY || m.name === VISION_MODEL_FAST,
            );
            if (!targetResident) {
              healthLines.push(
                `- Residency Note: neither configured default vision model (${VISION_MODEL_FAST}, ${VISION_MODEL_HEAVY}) is resident. ` +
                  `The next heavy vision call must load a model from disk, and will time out sooner while another model holds memory (the observed F5 failure mode).`,
              );
            }
          } else {
            healthLines.push("- Models Resident Now: none (the next vision call will load a model from disk).");
          }
          const visionModels = await listInstalledVisionModels(OLLAMA_HOST);
          healthLines.push(
            `- Installed Vision Models: ${visionModels.length ? visionModels.map((m) => m.name).join(", ") : "none detected"}`,
          );
        } catch (e) {
          healthLines.push(`- Residency Check: unavailable (${e.message})`);
        }

        const healthText = healthLines.join("\n");

        return { content: [{ type: "text", text: healthText }] };
      }

      if (name === "measure_image") {
        const parsed = parseArgs(z.object({
          image_source: toolSchemas.imageSource,
          mode: z.enum(["contrast", "colors", "boxes", "layout", "all"]).optional(),
          region: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).optional(),
          box_color: toolSchemas.optionalString,
          background_color: toolSchemas.optionalString,
          tolerance: z.number().optional(),
          large_text: z.boolean().optional(),
          ink_threshold: z.number().optional(),
          include_decorative: z.boolean().optional(),
          decorative_colors: z.array(z.string()).optional(),
          background_mode: z.enum(["global", "local"]).optional(),
          tile_size: z.number().optional(),
          noise_factor: z.number().optional(),
        }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);

        const result = await measureImage({
          imageBuffer: pngBuf,
          mode: parsed.mode || "all",
          region: parsed.region || null,
          boxColor: parsed.box_color || null,
          backgroundColor: parsed.background_color || null,
          tolerance: parsed.tolerance,
          largeText: !!parsed.large_text,
          extra: {
            inkThreshold: parsed.ink_threshold,
            includeDecorative: !!parsed.include_decorative,
            decorativeColors: parsed.decorative_colors || [],
            backgroundMode: parsed.background_mode,
            tileSize: parsed.tile_size,
            noiseFactor: parsed.noise_factor,
          },
        });

        return { content: [{ type: "text", text: truncateJsonForClient(result) }] };
      }

      if (name === "analyze_image_structured") {
        const parsed = parseArgs(z.object({
          image_source: toolSchemas.imageSource,
          prompt: toolSchemas.optionalString,
          model: toolSchemas.optionalString,
          crop: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).optional(),
          cross_validate: z.boolean().optional(),
          ocr_language: toolSchemas.optionalString,
          timeout_ms: z.number().optional(),
          keep_alive: z.string().optional(),
          seed: z.number().optional(),
          temperature: z.number().optional(),
        }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);
        const model = parsed.model || VISION_MODEL_FAST;

        await acquireOllamaSlot();
        let result;
        try {
          result = await analyzeStructured({
            imageBuffer: pngBuf,
            prompt: parsed.prompt || "",
            model,
            ollamaHost: OLLAMA_HOST,
            timeoutMs: parsed.timeout_ms || OLLAMA_TIMEOUT_MS,
            seed: parsed.seed !== undefined ? parsed.seed : VISION_SEED,
            temperature: parsed.temperature !== undefined ? parsed.temperature : VISION_TEMPERATURE,
            keepAlive: parsed.keep_alive !== undefined ? parsed.keep_alive : OLLAMA_KEEP_ALIVE,
            language: parsed.ocr_language || "eng",
            crop: parsed.crop || null,
            crossValidate: parsed.cross_validate !== false,
            numPredict: VISION_NUM_PREDICT,
          });
        } finally {
          releaseOllamaSlot();
        }

        return { content: [{ type: "text", text: truncateJsonForClient(result) }] };
      }

      if (name === "fast_ocr_tesseract") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, language: toolSchemas.optionalString }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);
        const lang = parsed.language || "eng";

        const { data } = await Tesseract.recognize(pngBuf, lang);

        return {
          content: [
            {
              type: "text",
              text: truncateForClient(`[Tesseract OCR Engine - Language: ${lang} - Confidence: ${data.confidence}%]\n\n${data.text || "(No text detected)"}`),
            },
          ],
        };
      }

      if (name === "preprocess_and_crop") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, crop: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).optional(), grayscale: z.boolean().optional(), sharpen: z.boolean().optional() }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        let pipeline = sharp(rawBuf);

        if (parsed.crop) {
          const meta = await pipeline.metadata();
          const imgWidth = meta.width || 1;
          const imgHeight = meta.height || 1;

          const cropLeft = Math.round(parsed.crop.left || 0);
          const cropTop = Math.round(parsed.crop.top || 0);
          const cropWidth = Math.round(parsed.crop.width || 1);
          const cropHeight = Math.round(parsed.crop.height || 1);

          if (cropLeft < 0 || cropTop < 0 || cropWidth <= 0 || cropHeight <= 0) {
            throw new Error("Crop dimensions must be positive numbers.");
          }

          if (cropLeft >= imgWidth || cropTop >= imgHeight) {
            throw new Error("Crop region starts outside the image boundaries.");
          }

          if (cropLeft + cropWidth > imgWidth || cropTop + cropHeight > imgHeight) {
            throw new Error("Crop region exceeds image boundaries.");
          }

          pipeline = pipeline.extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight });
        }

        if (parsed.grayscale) {
          pipeline = pipeline.grayscale();
        }
        if (parsed.sharpen) {
          pipeline = pipeline.sharpen();
        }

        const processedBuffer = await pipeline.toBuffer();
        const base64 = processedBuffer.toString("base64");
        const meta = await sharp(processedBuffer).metadata();

        const outputFilename = `${Date.now()}-${crypto.randomUUID()}.png`;
        const outputPath = path.join(FEEDBACK_DIR, outputFilename);
        fs.writeFileSync(outputPath, processedBuffer);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Image preprocessed successfully.",
                width: meta.width,
                height: meta.height,
                format: meta.format,
                operations: {
                  crop: parsed.crop || null,
                  grayscale: !!parsed.grayscale,
                  sharpen: !!parsed.sharpen,
                },
                output_file_path: outputPath,
                output_file_size: processedBuffer.length,
              }, null, 2),
            },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }

      if (name === "analyze_image") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, prompt: toolSchemas.optionalString, model: toolSchemas.optionalString }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);

        const prompt = parsed.prompt || "Describe this image in detail.";
        const model = parsed.model || VISION_MODEL_FAST;

        // F4 fix at the tool boundary: a quantitative question is answered by
        // deterministic measurement, or explicitly abstained — never guessed by
        // the model. This path does not consult Ollama at all, so it still
        // succeeds when the model is unavailable.
        const quant = detectQuantitativeQuestion(prompt);
        if (quant.quantitative) {
          const measured = await measureImage({ imageBuffer: pngBuf, mode: "all" });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ...measured,
                answered_by: "deterministic-measurement",
                model_consulted: false,
                reason:
                  "The prompt asks a quantitative question. Numeric answers are computed in code, not generated by the vision model.",
                matched_signals: quant.matched,
              }, null, 2),
            }],
          };
        }

        const prepared = await prepareForVision(pngBuf, { floor: DEFAULT_LEGIBILITY_FLOOR });
        const res = await queryOllamaVision(model, prompt, [prepared.buffer]);
        return {
          content: [{
            type: "text",
            text: truncateForClient(
              res.text +
                provenanceFooter(res, {
                  model,
                  sentDimensions: prepared.report.sent_dimensions,
                  downscaled: prepared.report.downscaled,
                }),
            ),
          }],
        };
      }

      if (name === "find_text_element") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, query: z.string().min(1), model: toolSchemas.optionalString }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);

        const prompt = `Locate the element or text matching: "${parsed.query}". Provide the bounding box coordinates or visual position within the image.`;
        const model = parsed.model || VISION_MODEL_HEAVY;

        const prepared = await prepareForVision(pngBuf, { floor: DEFAULT_LEGIBILITY_FLOOR });
        const res = await queryOllamaVision(model, prompt, [prepared.buffer]);
        return {
          content: [{
            type: "text",
            text: truncateForClient(
              res.text +
                provenanceFooter(res, {
                  model,
                  sentDimensions: prepared.report.sent_dimensions,
                  downscaled: prepared.report.downscaled,
                }),
            ),
          }],
        };
      }

      if (name === "compare_images") {
        const parsed = parseArgs(z.object({ image_sources: toolSchemas.imageSources, prompt: toolSchemas.optionalString, model: toolSchemas.optionalString }));
        const rawSources = normalizeImageSources(parsed.image_sources);
        if (!rawSources || rawSources.length < 2) {
          throw new Error(
            "Parameter 'image_sources' must be a JSON array containing at least 2 image strings. " +
            "Do NOT pass a single stringified array (e.g., \"[...]\") or a single Base64 string. " +
            "Correct format: [\"data:image/png;base64,...\", \"https://example.com/img2.png\"]"
          );
        }

        const buffers = [];
        for (const src of rawSources) {
          const buf = await resolveImageToBuffer(src);
          await normalizeToPngBuffer(buf);
          buffers.push(buf);
        }

        const prompt = parsed.prompt || "Compare these images in detail and highlight any differences or similarities.";
        const model = parsed.model || VISION_MODEL_HEAVY;

        const res = await queryOllamaVision(model, prompt, buffers);
        return { content: [{ type: "text", text: truncateForClient(res.text + provenanceFooter(res, { model })) }] };
      }

      if (name === "browser_screenshot_analysis") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, focus: z.enum(["all", "layout", "components", "accessibility", "design", "content"]).optional(), detail_level: z.enum(["brief", "standard", "detailed"]).optional(), model: toolSchemas.optionalString }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);

        const focus = (parsed.focus || "all").toLowerCase();
        const detailLevel = (parsed.detail_level || "standard").toLowerCase();

        const prompts = {
          brief: `Provide a concise summary of this browser screenshot. Identify the page type (login, dashboard, form, etc.), primary content, and any obvious UI anomalies. Focus: ${focus}.`,
          standard: `Analyze this browser screenshot in detail. Describe the page layout, visual hierarchy, color scheme, typography, spacing, and overall design vibe. Identify UI components (nav, sidebar, buttons, cards, modals, forms), accessibility cues, and visual patterns. Focus: ${focus}.`,
          detailed: `Perform a comprehensive visual and semantic analysis of this browser screenshot. Describe the full layout structure, grid system, visual hierarchy, color palette, typography choices, spacing rhythm, component types, interactive elements, content groupings, potential UX issues, and the overall aesthetic vibe. Focus: ${focus}.`,
        };

        const model = parsed.model || VISION_MODEL_HEAVY;
        const prompt = prompts[detailLevel] || prompts.standard;

        const prepared = await prepareForVision(pngBuf, { floor: DEFAULT_LEGIBILITY_FLOOR });
        const res = await queryOllamaVision(model, prompt, [prepared.buffer]);
        return {
          content: [
            {
              type: "text",
              text:
                `[Browser Screenshot Analysis - Focus: ${focus} - Detail: ${detailLevel}]\n\n${res.text}` +
                provenanceFooter(res, {
                  model,
                  sentDimensions: prepared.report.sent_dimensions,
                  downscaled: prepared.report.downscaled,
                }),
            },
          ],
        };
      }

      if (name === "browser_screenshot_annotation") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, annotations: z.array(z.object({ type: z.enum(["label", "box", "arrow", "circle"]), text: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), target_x: z.number().optional(), target_y: z.number().optional(), color: z.string().optional(), font_size: z.number().optional() })).min(1), return_base64: z.boolean().optional() }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        await normalizeToPngBuffer(rawBuf);

        const invalid = parsed.annotations.find((a) => !a || typeof a !== "object" || !a.type);
        if (invalid) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: true,
                  code: "INVALID_ANNOTATION",
                  message: "Each annotation must be an object with a 'type' field.",
                  validTypes: ["label", "box", "arrow", "circle"],
                  invalidItem: invalid,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        const meta = await sharp(rawBuf).metadata();
        if (!meta.width || !meta.height) {
          throw new Error("Could not determine image dimensions for annotation overlay.");
        }

        const overlayBuffer = buildAnnotationOverlay(parsed.annotations, meta.width, meta.height);
        if (!overlayBuffer) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: true,
                  code: "NO_VALID_ANNOTATIONS",
                  message: "No valid annotations could be rendered. Check that each annotation has the required fields for its type.",
                  received: parsed.annotations.map((a) => ({ type: a.type, hasText: !!a.text, textLength: (a.text || "").length })),
                  suggestions: ["Ensure 'label' annotations include 'text'", "Ensure coordinate fields (x, y) are numbers"],
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        const annotatedBuffer = await sharp(rawBuf)
          .composite([{ input: overlayBuffer, blend: "over" }])
          .png()
          .toBuffer();

        const base64 = annotatedBuffer.toString("base64");
        const dataUri = `data:image/png;base64,${base64}`;

        const outputFilename = `${Date.now()}-${crypto.randomUUID()}-annotated.png`;
        const outputPath = path.join(FEEDBACK_DIR, outputFilename);
        fs.writeFileSync(outputPath, annotatedBuffer);

        if (parsed.return_base64 !== false) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: `Annotation applied. ${parsed.annotations.length} annotation(s) rendered.`,
                  width: meta.width,
                  height: meta.height,
                  format: "image/png",
                  data_uri_length: base64.length,
                  output_file_path: outputPath,
                  output_file_size: annotatedBuffer.length,
                  data_uri: dataUri,
                }, null, 2),
              },
              { type: "image", data: base64, mimeType: "image/png" },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Annotation applied (base64 returned separately).",
                width: meta.width,
                height: meta.height,
                format: "image/png",
                data_uri_length: base64.length,
                output_file_path: outputPath,
                output_file_size: annotatedBuffer.length,
                data_uri: dataUri,
              }, null, 2),
            },
          ],
        };
      }

      if (name === "detect_ui_elements") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, element_types: z.array(z.string()).optional(), return_overlay: z.boolean().optional(), model: toolSchemas.optionalString }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const normalizedBuf = await normalizeToPngBuffer(rawBuf);

        const meta = await sharp(normalizedBuf).metadata();
        const elementTypes = Array.isArray(parsed.element_types)
          ? parsed.element_types.join(", ")
          : "buttons, text inputs, links/images acting as links, cards, navigation bars, modals, dropdowns, checkboxes, radio buttons, tables, lists, icons, headings, and form labels";

        const prompt = `Analyze this screenshot and detect the following UI elements: ${elementTypes}. For each element you identify, provide: 1) the element type, 2) a brief label describing what it is or the text it contains, 3) approximate bounding box coordinates in pixels as [x, y, width, height] where (x,y) is the top-left corner. Return the results as a JSON array where each item has keys: "type", "label", "x", "y", "width", "height". If an element type is not visible, omit it from the array. Focus on accuracy for both labels and coordinates.`;
        const model = parsed.model || VISION_MODEL_HEAVY;
        const prepared = await prepareForVision(normalizedBuf, { floor: DEFAULT_LEGIBILITY_FLOOR });
        const res = await queryOllamaVision(model, prompt, [prepared.buffer]);
        const textResult = res.text;

        let overlay = null;
        let overlayPath = null;
        if (parsed.return_overlay === true) {
          const boxes = [];
          try {
            const jsonMatch = textResult.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item && item.type && typeof item.x === "number" && typeof item.y === "number") {
                    boxes.push({
                      type: "box",
                      x: item.x,
                      y: item.y,
                      width: Math.max(10, Number(item.width) || 50),
                      height: Math.max(10, Number(item.height) || 20),
                      color: "#00FF00",
                    });
                  }
                }
              }
            }
          } catch {}

          if (boxes.length > 0) {
            const overlayBuf = buildAnnotationOverlay(boxes, meta.width, meta.height);
            if (overlayBuf) {
              const annotated = await sharp(normalizedBuf)
                .composite([{ input: overlayBuf, blend: "over" }])
                .png()
                .toBuffer();
              overlay = annotated.toString("base64");
              const overlayFilename = `${Date.now()}-${crypto.randomUUID()}-overlay.png`;
              overlayPath = path.join(FEEDBACK_DIR, overlayFilename);
              fs.writeFileSync(overlayPath, annotated);
            }
          }
        }

        const response = {
          success: true,
          message: `UI elements detected from screenshot (${meta.width}x${meta.height}).`,
          width: meta.width,
          height: meta.height,
          detection: textResult,
          provenance: {
            model,
            options: res.request?.options || null,
            image: {
              input_dimensions: prepared.report.input_dimensions,
              sent_dimensions: prepared.report.sent_dimensions,
              downscaled: prepared.report.downscaled,
            },
            metrics: res.metrics,
            warnings: [...(res.warnings || []), ...(prepared.report.warnings || [])],
          },
        };
        if (overlay) {
          response.overlay_data_uri = `data:image/png;base64,${overlay}`;
          response.overlay_file_path = overlayPath;
          response.overlay_file_size = overlay.length;
        }

        const content = [{ type: "text", text: JSON.stringify(response, null, 2) }];
        if (overlay) {
          content.push({ type: "image", data: overlay, mimeType: "image/png" });
        }
        return { content };
      }

      if (name === "visual_diff") {
        const parsed = parseArgs(z.object({ image_sources: toolSchemas.imageSources, threshold: z.number().min(0).max(255).optional(), highlight_color: z.string().optional(), analyze: z.boolean().optional() }));
        const rawSources = normalizeImageSources(parsed.image_sources);
        if (!rawSources || rawSources.length < 2) {
          throw new Error(
            "Parameter 'image_sources' must be a JSON array with at least 2 images. " +
            "Format: [\"before_image\", \"after_image\"]"
          );
        }

        const buffers = [];
        const metas = [];
        for (const src of rawSources.slice(0, 2)) {
          const buf = await resolveImageToBuffer(src);
          await normalizeToPngBuffer(buf);
          buffers.push(buf);
          metas.push(await sharp(buf).metadata());
        }

        const threshold = Math.max(0, Math.min(255, Number(parsed.threshold) || 15));
        const highlightColor = parsed.highlight_color || "#FF00FF";
        const rgb = hexToRgb(highlightColor);

        const w1 = metas[0].width || 400;
        const h1 = metas[0].height || 400;
        const w2 = metas[1].width || 400;
        const h2 = metas[1].height || 400;

        const aspect1 = w1 / (h1 || 1);
        const aspect2 = w2 / (h2 || 1);
        let targetWidth, targetHeight;
        if (Math.abs(aspect1 - aspect2) < 0.1) {
          targetWidth = Math.max(1, Math.min(w1, w2));
          targetHeight = Math.max(1, Math.round(targetWidth / (aspect1 || 1)));
        } else {
          targetWidth = Math.max(1, Math.min(w1, w2, 400));
          targetHeight = Math.max(1, Math.round(targetWidth / ((aspect1 + aspect2) / 2 || 1)));
        }

        const raw1 = await sharp(buffers[0]).resize(targetWidth, targetHeight).removeAlpha().raw().toBuffer();
        const raw2 = await sharp(buffers[1]).resize(targetWidth, targetHeight).removeAlpha().raw().toBuffer();

        const pixelCount = targetWidth * targetHeight;
        const diffPixels = Buffer.alloc(pixelCount * 4);
        let changed = 0;

        for (let i = 0; i < pixelCount; i++) {
          const idx = i * 3;
          const rDiff = Math.abs(raw1[idx] - raw2[idx]);
          const gDiff = Math.abs(raw1[idx + 1] - raw2[idx + 1]);
          const bDiff = Math.abs(raw1[idx + 2] - raw2[idx + 2]);
          const totalDiff = rDiff + gDiff + bDiff;

          if (totalDiff > threshold * 3) {
            diffPixels[i * 4] = rgb.r;
            diffPixels[i * 4 + 1] = rgb.g;
            diffPixels[i * 4 + 2] = rgb.b;
            diffPixels[i * 4 + 3] = 255;
            changed++;
          } else {
            diffPixels[i * 4] = 20;
            diffPixels[i * 4 + 1] = 20;
            diffPixels[i * 4 + 2] = 20;
            diffPixels[i * 4 + 3] = 255;
          }
        }

        const diffBuf = await sharp(diffPixels, { raw: { width: targetWidth, height: targetHeight, channels: 4 } }).png().toBuffer();
        const base64 = diffBuf.toString("base64");

        const diffFilename = `${Date.now()}-${crypto.randomUUID()}-diff.png`;
        const diffPath = path.join(FEEDBACK_DIR, diffFilename);
        fs.writeFileSync(diffPath, diffBuf);

        let aiDescription = "";
        let aiDescriptionProvenance = null;
        if (parsed.analyze !== false) {
          const prompt = "Compare these two screenshots. The first image is the 'before' state, the second is the 'after' state. Describe all visual differences you can identify, including what changed, where on the screen, and any visual regressions or improvements.";
          const res = await queryOllamaVision(VISION_MODEL_HEAVY, prompt, buffers);
          aiDescription = res.text + provenanceFooter(res, { model: VISION_MODEL_HEAVY });
          aiDescriptionProvenance = {
            model: VISION_MODEL_HEAVY,
            options: res.request?.options || null,
            metrics: res.metrics,
            warnings: res.warnings || [],
          };
        }

        const response = {
          success: true,
          message: "Visual diff computed successfully.",
          width: targetWidth,
          height: targetHeight,
          changed_pixels: changed,
          total_pixels: pixelCount,
          change_ratio: (changed / pixelCount * 100).toFixed(2) + "%",
          threshold: threshold,
          highlight_color: highlightColor,
          format: "image/png",
          data_uri_length: base64.length,
          diff_file_path: diffPath,
          diff_file_size: diffBuf.length,
          data_uri: `data:image/png;base64,${base64}`,
        };
        if (aiDescription) {
          response.ai_description = aiDescription;
        }
        if (aiDescriptionProvenance) {
          response.ai_description_provenance = aiDescriptionProvenance;
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }

      if (name === "textual_visual_feedback") {
        const parsed = parseArgs(z.object({ image_source: toolSchemas.imageSource, dom_fragment: z.string().optional(), css_snapshot: z.string().optional(), include_ocr: z.boolean().optional(), ocr_language: z.string().optional() }));
        const rawBuf = await resolveImageToBuffer(parsed.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);
        const meta = await sharp(pngBuf).metadata();

        let ocrText = "";
        let ocrConfidence = 0;
        if (parsed.include_ocr !== false) {
          try {
            const lang = parsed.ocr_language || "eng";
            const { data } = await Tesseract.recognize(pngBuf, lang);
            ocrText = data.text || "";
            ocrConfidence = data.confidence || 0;
          } catch (e) {
            ocrText = `[OCR Error: ${e.message}]`;
          }
        }

        const domFragment = normalizeDomFragment(parsed.dom_fragment);
        const cssSnapshot = normalizeCssSnapshot(parsed.css_snapshot);

        const base64 = pngBuf.toString("base64");
        const filename = `${Date.now()}-${crypto.randomUUID()}.png`;
        const filePath = path.join(FEEDBACK_DIR, filename);
        fs.writeFileSync(filePath, pngBuf);

        const feedback = {
          success: true,
          timestamp: new Date().toISOString(),
          screenshot: {
            mime_type: "image/png",
            width: meta.width,
            height: meta.height,
            data_uri_length: base64.length,
            file_path: filePath
          },
          ocr: {
            enabled: parsed.include_ocr !== false,
            language: parsed.ocr_language || "eng",
            confidence: ocrConfidence,
            text: ocrText
          },
          dom: {
            provided: domFragment.length > 0,
            fragment_length: domFragment.length,
            fragment_preview: domFragment.substring(0, 500)
          },
          css: {
            provided: cssSnapshot.length > 0,
            snapshot_length: cssSnapshot.length,
            snapshot_preview: cssSnapshot.substring(0, 500)
          }
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(feedback, null, 2) }
          ],
        };
      }

      if (name === "extract_semantic_page") {
        const parsed = parseArgs(z.object({ html_content: z.string().min(3), min_text_length: z.number().optional(), include_raw: z.boolean().optional() }));
        if (!parsed.html_content || typeof parsed.html_content !== "string" || parsed.html_content.trim().length < 3) {
          throw new Error("Parameter 'html_content' must be a non-empty HTML string.");
        }

        const minTextLength = Math.max(0, Number(parsed.min_text_length) || 10);
        const includeRaw = !!parsed.include_raw;

        const controlMap = extractSemanticPage(parsed.html_content, minTextLength, includeRaw);

        return {
          content: [
            { type: "text", text: JSON.stringify({ success: true, control_map: controlMap }, null, 2) }
          ],
        };
      }

      if (name === "generate_repo_graph") {
        const parsed = parseArgs(z.object({ repo_path: z.string().min(1), max_depth: z.number().optional(), include_node_modules: z.boolean().optional() }));
        if (!parsed.repo_path || typeof parsed.repo_path !== "string") {
          throw new Error("Parameter 'repo_path' must be a non-empty string.");
        }

        const maxDepth = Math.max(1, Math.min(20, Number(parsed.max_depth) || 5));
        const includeNodeModules = !!parsed.include_node_modules;

        const result = await generateRepoGraph(parsed.repo_path, maxDepth, includeNodeModules);

        const response = {
          success: true,
          graph: result.json,
          dot_preview: result.dot.substring(0, 2000),
          dot_length: result.dot.length,
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
            { type: "text", text: `--- Graphviz DOT ---\n${result.dot}` }
          ],
        };
      }

      if (name === "download_image") {
        const parsed = parseArgs(z.object({ url: z.string().min(1), filename: z.string().optional() }));
        if (!parsed.url || typeof parsed.url !== "string") {
          throw new Error("Parameter 'url' must be a non-empty string.");
        }

        const result = await downloadImageToFile(parsed.url);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Image downloaded successfully from URL.`,
                downloadRef: result.downloadRef,
                file_path: result.filePath,
                original_url: result.originalUrl,
                mime_type: result.mimeType,
                size: result.size,
                width: result.width,
                height: result.height,
              }, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool requested: ${name}`);
    } catch (err) {
      logWarn(`[Tool Execution Error - ${name}]:`, err.message);
      return {
        content: [
          {
            type: "text",
            text: `Error executing tool '${name}': ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ==========================================
// Express App & Routing
// ==========================================
const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.status(200).send("Hybrid Vision MCP Server Active.");
});

// Streamable HTTP Transports (/mcp)
const streamableTransports = new Map();

app.all("/mcp", async (req, res) => {
  logInfo(`[HTTP] ${req.method} ${req.path}`);
  const sessionId = req.headers["mcp-session-id"] || req.query.sessionId;
  let transport = streamableTransports.get(sessionId);

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        streamableTransports.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        streamableTransports.delete(transport.sessionId);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// SSE Transports (/sse and /messages)
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  logInfo(`[HTTP] ${new Date().toLocaleTimeString()} -> GET /sse`);

  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);

  transport.onclose = () => {
    logInfo(` -> SSE connection closed for session: ${transport.sessionId}`);
    sseTransports.delete(transport.sessionId);
  };

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).send("Missing sessionId query parameter.");
    return;
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

// ==========================================
// Self-healing: Upload Endpoint
// ==========================================
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const cleanupUploads = () => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(UPLOAD_DIR);
    for (const file of files) {
      const full = path.join(UPLOAD_DIR, file);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > MAX_UPLOAD_AGE_MS) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
};
setInterval(cleanupUploads, 5 * 60 * 1000);
cleanupUploads();

fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const cleanupDownloads = () => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(DOWNLOAD_DIR);
    for (const file of files) {
      const full = path.join(DOWNLOAD_DIR, file);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > MAX_UPLOAD_AGE_MS) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
};
setInterval(cleanupDownloads, 5 * 60 * 1000);
cleanupDownloads();

const cleanupFeedback = () => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(FEEDBACK_DIR);
    for (const file of files) {
      const full = path.join(FEEDBACK_DIR, file);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > MAX_UPLOAD_AGE_MS) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
};
setInterval(cleanupFeedback, 5 * 60 * 1000);
cleanupFeedback();

app.post("/upload", express.raw({ type: "*/*", limit: `${MAX_UPLOAD_SIZE_MB}mb` }), async (req, res) => {
  setCorsHeaders(req, res);

  const clientIp = getClientIp(req);
  if (!checkUploadRateLimit(clientIp)) {
    return res.status(429).json({ error: "Rate limit exceeded", message: `Maximum ${RATE_LIMIT_MAX} uploads per minute.` });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "No image binary body received.", message: "Send raw binary image data with Content-Type header (e.g., image/png)." });
  }

  if (req.body.length > MAX_UPLOAD_SIZE_BYTES) {
    return res.status(413).json({ error: "Upload too large", maxBytes: MAX_UPLOAD_SIZE_BYTES, received: req.body.length });
  }

  const declaredType = req.get("content-type") || "";
  const mimeType = resolveMimeTypeFromMagic(req.body, declaredType);
  if (!mimeType) {
    return res.status(415).json({ error: "Unsupported media type", message: "Uploaded file is not a recognized image format (PNG, JPEG, WEBP, GIF, BMP)." });
  }

  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    return res.status(415).json({ error: "MIME type not allowed", allowed: Array.from(ALLOWED_UPLOAD_MIME_TYPES), received: mimeType });
  }

  if (!isSupportedImageBuffer(req.body)) {
    return res.status(422).json({ error: "Invalid image data", message: "File magic numbers do not match the declared image format." });
  }

  const ext = mimeType.split("/")[1] || "bin";
  const filename = `${crypto.randomUUID()}.${ext}`;
  const fullPath = path.join(UPLOAD_DIR, filename);

  try {
    fs.writeFileSync(fullPath, req.body);
  } catch (err) {
    return res.status(500).json({ error: "Failed to save upload", message: err.message });
  }

  let width = null;
  let height = null;
  try {
    const meta = await sharp(req.body).metadata();
    width = meta.width;
    height = meta.height;
  } catch {}

  logInfo(`[UPLOAD] ${clientIp} uploaded ${filename} (${req.body.length} bytes, ${mimeType}, ${width}x${height})`);

  res.status(200).json({
    uploadRef: `upload://${filename}`,
    filename,
    mimeType,
    size: req.body.length,
    width,
    height,
  });
});

app.options("/upload", (req, res) => {
  setCorsHeaders(req, res);
  res.status(204).send();
});

app.listen(PORT, "0.0.0.0", () => {
  logInfo(`
========================================
 Hybrid Vision MCP Server Running 
 Listening on: http://0.0.0.0:${PORT}
 - Streamable HTTP: http://localhost:${PORT}/mcp
 - SSE Endpoint:    http://localhost:${PORT}/sse
========================================
`);
});