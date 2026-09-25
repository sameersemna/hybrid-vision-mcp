// ==========================================
// End-to-end tool coverage.
// ==========================================
// Spawns the real server against a MOCK Ollama, then calls every tool. This
// exists because a wiring bug (a handler referencing an undefined variable) was
// not caught by unit-level accuracy tests: those covered the new modules, not
// every legacy handler's execution path.
//
// No real Ollama and no network egress are required.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(import.meta.dirname, "..");

async function freePort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** Mock Ollama: JSON schema responses when `format` is set, prose otherwise. */
function startMockOllama() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "mock-vl", capabilities: ["vision"], size: 1e9, details: {} }] }));
      }
      if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "mock-vl", size_vram: 1e9 }] }));
      }
      if (req.url === "/api/generate") {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const payload = parsed.format
          ? JSON.stringify({ summary: "mock summary", claims: [], text_items: [], abstained: [] })
          : "This is a mock vision description of the image.";
        res.write(JSON.stringify({ response: payload, done: true, eval_count: 5, load_duration: 1e6 }) + "\n");
        return res.end();
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise(async (resolve) => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    resolve({ server, port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) });
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy on port ${port}`);
}

test("every tool executes without error against a mock Ollama", { timeout: 90000 }, async (t) => {
  const mock = await startMockOllama();
  const port = await freePort();
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "hvm-tools-"));

  const child = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_TIMEOUT_MS: "15000",
      VISION_MODEL_FAST: "mock-vl",
      VISION_MODEL_HEAVY: "mock-vl",
      UPLOAD_DIR: path.join(tmpRoot, "uploads"),
      FEEDBACK_DIR: path.join(tmpRoot, "feedback"),
      DOWNLOAD_DIR: path.join(tmpRoot, "downloads"),
      OLLAMA_KEEP_ALIVE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });

  const cleanup = async () => {
    child.kill("SIGKILL");
    await mock.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  try {
    await waitForHealth(port);
  } catch (err) {
    await cleanup();
    throw new Error(`${err.message}\n--- server log ---\n${serverLog}`);
  }

  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  // A small valid PNG (fixture) as a data URI.
  const { buildFixturePng } = await import("../lib/fixtures.js");
  const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return r;
  };

  const cases = [
    ["check_vision_health", {}],
    ["fast_ocr_tesseract", { image_source: dataUri, language: "eng" }],
    ["preprocess_and_crop", { image_source: dataUri, crop: { left: 0, top: 0, width: 200, height: 200 }, grayscale: true }],
    ["analyze_image", { image_source: dataUri, prompt: "Describe the layout of this image." }],
    ["find_text_element", { image_source: dataUri, query: "DELTA" }],
    ["compare_images", { image_sources: [dataUri, dataUri], prompt: "Compare." }],
    ["browser_screenshot_analysis", { image_source: dataUri, focus: "layout", detail_level: "brief" }],
    ["browser_screenshot_annotation", { image_source: dataUri, annotations: [{ type: "box", x: 10, y: 10, width: 50, height: 50 }], return_base64: false }],
    ["visual_diff", { image_sources: [dataUri, dataUri], analyze: true }],
    ["detect_ui_elements", { image_source: dataUri }],
    ["textual_visual_feedback", { image_source: dataUri, include_ocr: false }],
    ["extract_semantic_page", { html_content: "<html><head><title>T</title></head><body><h1>Heading text</h1><p>A paragraph of sufficient length here.</p></body></html>" }],
    ["generate_repo_graph", { repo_path: ROOT, max_depth: 1 }],
    ["measure_image", { image_source: dataUri, mode: "all" }],
    ["analyze_image_structured", { image_source: dataUri, prompt: "Describe the image." }],
  ];

  const failures = [];
  for (const [name, args] of cases) {
    let r;
    try {
      r = await call(name, args);
    } catch (err) {
      failures.push(`${name}: threw ${err.message}`);
      continue;
    }
    if (r.isError) {
      failures.push(`${name}: isError -> ${r.content?.[0]?.text?.slice(0, 200)}`);
      continue;
    }
    if (!r.content || r.content.length === 0) {
      failures.push(`${name}: empty content`);
    }
  }

  await client.close();
  await cleanup();

  assert.deepEqual(failures, [], `tools must all succeed:\n${failures.join("\n")}`);

  // The legacy text tools must carry a provenance footer (additive change).
  const mcp = await import("../lib/vision.js"); // ensures module graph is loaded
  assert.ok(mcp, "modules load");
});

test("legacy text tools append a provenance footer", { timeout: 90000 }, async () => {
  const mock = await startMockOllama();
  const port = await freePort();
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "hvm-prov-"));

  const child = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      VISION_MODEL_FAST: "mock-vl",
      VISION_MODEL_HEAVY: "mock-vl",
      UPLOAD_DIR: path.join(tmpRoot, "uploads"),
      FEEDBACK_DIR: path.join(tmpRoot, "feedback"),
      DOWNLOAD_DIR: path.join(tmpRoot, "downloads"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port);
    const client = new Client({ name: "prov-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { buildFixturePng } = await import("../lib/fixtures.js");
    const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");

    for (const [name, args] of [
      ["analyze_image", { image_source: dataUri, prompt: "Describe the layout." }],
      ["find_text_element", { image_source: dataUri, query: "DELTA" }],
      ["browser_screenshot_analysis", { image_source: dataUri, focus: "layout", detail_level: "brief" }],
    ]) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
      assert.equal(r.isError, undefined, `${name} must not error`);
      const text = r.content[0].text;
      assert.match(text, /\[provenance\] model=mock-vl/, `${name} must report provenance`);
      assert.match(text, /temperature=0/, `${name} must report pinned sampling`);
      assert.match(text, /sent=\d+x\d+/, `${name} must report dimensions sent`);
    }

    // The structured tool returns the full object with provenance.
    const s = await client.callTool({ name: "analyze_image_structured", arguments: { image_source: dataUri, prompt: "Describe." } }, undefined, { timeout: 60000 });
    const sj = JSON.parse(s.content[0].text);
    assert.equal(sj.provenance.model, "mock-vl");
    assert.equal(sj.provenance.options.temperature, 0);

    await client.close();
  } finally {
    child.kill("SIGKILL");
    await mock.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
