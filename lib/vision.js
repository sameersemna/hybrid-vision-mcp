// ==========================================
// Schema-constrained Ollama vision client.
// ==========================================
// The original server posted { model, prompt, images, stream:false } and took
// whatever free text came back. That is how a 13B/32B VL model ended up
// emitting confident, specific, wrong claims (F1 fabricated arrow glyphs,
// F2 invented "clipped" text, F4 asserted contrast it never measured).
//
// This module changes the contract in four ways:
//
//   1. `format` is always a JSON schema, so the model *cannot* answer in prose.
//      Every claim must land in a declared field.
//   2. Sampling is pinned (`temperature: 0`, explicit `seed`) for determinism.
//   3. The response is streamed so we can tell *loading* from *inferring*
//      (time-to-first-token), instead of blocking opaquely for 180s.
//   4. Timeout errors are actionable and reference models that are *actually
//      installed on this host*, not a hardcoded suggestion (F5).

const DEFAULT_LOAD_WINDOW_MS = 20000;
const DEFAULT_NUM_PREDICT = 2048;
const DEFAULT_SEED = 42;

/**
 * List installed models (from /api/tags) with their capabilities.
 * @param {string} host
 * @returns {Promise<Array<{ name: string, capabilities: string[], size: number }>>}
 */
export async function listInstalledModels(host) {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    capabilities: m.capabilities || [],
    size: m.size,
    parameter_size: m.details?.parameter_size || null,
    quantization: m.details?.quantization_level || null,
  }));
}

/**
 * List *vision-capable* installed models. Used to make timeout hints real.
 * @param {string} host
 */
export async function listInstalledVisionModels(host) {
  const models = await listInstalledModels(host);
  return models.filter((m) => m.capabilities.includes("vision"));
}

/**
 * Which models currently hold memory (from /api/ps), and how much VRAM each
 * occupies. This is the residency signal that explains F5: a *different*
 * model (an embedding model, in the observed case) was resident and holding
 * memory, so the requested vision model had to load from scratch.
 * @param {string} host
 * @returns {Promise<{ loaded: Array<{name:string,size_vram:number,expires_at:string|null}>, error?: string }>}
 */
export async function getModelResidency(host) {
  try {
    const res = await fetch(`${host}/api/ps`);
    if (!res.ok) return { loaded: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      loaded: (data.models || []).map((m) => ({
        name: m.name,
        size_vram: m.size_vram ?? m.size ?? 0,
        expires_at: m.expires_at || null,
      })),
    };
  } catch (err) {
    return { loaded: [], error: err.message };
  }
}

/**
 * Extract a JSON value from model output that may be wrapped in prose or
 * ` thinking` blocks (some installed models — e.g. qwen3-vl — are thinking
 * models, and Ollama's JSON mode is not always honoured by them).
 * @param {string} text
 * @returns {{ value: any, strategy: string } | null}
 */
export function extractJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;

  const candidates = [];
  candidates.push({ s: text.trim(), strategy: "direct" });

  const noThinking = text.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  if (noThinking !== text.trim()) candidates.push({ s: noThinking, strategy: "strip-think" });

  for (const { s, strategy } of candidates) {
    try {
      return { value: JSON.parse(s), strategy };
    } catch { /* try harder */ }
  }

  // First balanced {...} object.
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return { value: JSON.parse(text.slice(objStart, objEnd + 1)), strategy: "brace-slice" };
    } catch { /* fall through */ }
  }

  // First [...] array.
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return { value: JSON.parse(text.slice(arrStart, arrEnd + 1)), strategy: "bracket-slice" };
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Build an actionable timeout error, grounded in observed host reality.
 * @param {object} ctx
 */
export function buildTimeoutError(ctx) {
  const {
    model,
    elapsedMs,
    timeoutMs,
    firstTokenMs,
    residencyBefore,
    installedVision,
    loadWindowMs,
  } = ctx;

  const others = (residencyBefore?.loaded || []).filter((m) => m.name !== model);
  const targetResident = (residencyBefore?.loaded || []).some((m) => m.name === model);

  const lines = [
    `Ollama did not return a usable response within ${timeoutMs}ms (elapsed ${elapsedMs}ms).`,
    `Model: ${model}`,
    `First token: ${firstTokenMs === null ? "never received" : `${firstTokenMs}ms`}`,
  ];

  if (targetResident) {
    lines.push(
      `Diagnosis: "${model}" was ALREADY resident, and the first token ${
        firstTokenMs === null || firstTokenMs > loadWindowMs ? "was slow" : "arrived quickly"
      } — this points at inference cost, not model loading. Reduce image size or lower num_predict.`,
    );
  } else if (others.length > 0) {
    const held = others
      .map((m) => `${m.name} (~${(m.size_vram / 1e9).toFixed(1)}GB VRAM)`)
      .join(", ");
    lines.push(
      `Diagnosis: "${model}" was NOT resident, and other model(s) currently hold memory: ${held}. ` +
        `The request likely had to load "${model}" from disk under memory contention (this is the ` +
        `observed F5 failure mode). Consider unloading the other model (keep_alive: 0) or raising OLLAMA_TIMEOUT_MS.`,
    );
  } else {
    lines.push(
      `Diagnosis: "${model}" is not resident and no other model is resident; this looks like a cold ` +
        `model load. Raise OLLAMA_TIMEOUT_MS, or pre-load the model.`,
    );
  }

  if (Array.isArray(installedVision) && installedVision.length > 0) {
    lines.push(
      `Vision models actually installed on this host: ${installedVision.map((m) => m.name).join(", ")}.`,
    );
  } else {
    lines.push(
      `No vision-capable models were detected via /api/tags — check that Ollama is reachable and that a vision model is pulled.`,
    );
  }

  const err = new Error(lines.join("\n"));
  err.code = "OLLAMA_TIMEOUT";
  err.details = ctx;
  return err;
}

/**
 * Run a schema-constrained vision query against Ollama, streaming the response.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.prompt
 * @param {Buffer[]} params.images
 * @param {object} params.schema JSON schema for `format`
 * @param {string} [params.ollamaHost]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.seed]
 * @param {number} [params.temperature]
 * @param {number} [params.numPredict]
 * @param {number|string} [params.keepAlive] e.g. "5m" or 0 to unload
 * @param {number} [params.loadWindowMs]
 * @param {boolean} [params.jsonMode] pass `format: "json"` instead of a schema
 * @param {(p: object) => void} [params.onProgress]
 * @returns {Promise<object>}
 */
export async function queryOllamaStructured(params) {
  const {
    model,
    prompt,
    images = [],
    schema,
    ollamaHost = "http://localhost:11434",
    timeoutMs = 180000,
    seed = DEFAULT_SEED,
    temperature = 0,
    numPredict = DEFAULT_NUM_PREDICT,
    keepAlive,
    loadWindowMs,
    jsonMode = false,
    onProgress,
  } = params;

  const started = Date.now();
  const effectiveLoadWindow = loadWindowMs ?? Math.min(DEFAULT_LOAD_WINDOW_MS, Math.floor(timeoutMs * 0.25));

  // Snapshot residency BEFORE the call so timeout errors can explain reality.
  let residencyBefore = { loaded: [] };
  try {
    residencyBefore = await getModelResidency(ollamaHost);
  } catch { /* non-fatal */ }

  const options = { temperature, seed, num_predict: numPredict };
  const payload = {
    model,
    prompt,
    images: images.map((b) => b.toString("base64")),
    stream: true,
    options,
  };
  if (jsonMode) payload.format = "json";
  else if (schema) payload.format = schema;
  if (keepAlive !== undefined) payload.keep_alive = keepAlive;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let firstTokenMs = null;
  let accumulated = "";
  let finalChunk = null;
  let status = 200;

  const emit = (phase, extra = {}) => {
    if (typeof onProgress === "function") {
      try { onProgress({ phase, elapsed_ms: Date.now() - started, ...extra }); } catch { /* ignore */ }
    }
  };

  try {
    emit("request-sent", { model, residency_before: residencyBefore.loaded.map((m) => m.name) });

    let response;
    try {
      response = await fetch(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw buildTimeoutError({
          model, elapsedMs: Date.now() - started, timeoutMs, firstTokenMs: null,
          residencyBefore, installedVision: await safeVisionModels(ollamaHost), loadWindowMs: effectiveLoadWindow,
        });
      }
      const e = new Error(`Could not connect to Ollama at ${ollamaHost}: ${err.message}`);
      e.code = "OLLAMA_UNREACHABLE";
      throw e;
    }

    status = response.status;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const e = new Error(`Ollama API error (${response.status}): ${body || response.statusText}`);
      e.code = "OLLAMA_API_ERROR";
      e.status = response.status;
      throw e;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) {
          throw buildTimeoutError({
            model, elapsedMs: Date.now() - started, timeoutMs, firstTokenMs,
            residencyBefore, installedVision: await safeVisionModels(ollamaHost), loadWindowMs: effectiveLoadWindow,
          });
        }
        throw err;
      }
      if (readResult.done) break;

      buffer += decoder.decode(readResult.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk;
        try {
          chunk = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (chunk.error) {
          const e = new Error(`Ollama returned an error: ${chunk.error}`);
          e.code = "OLLAMA_API_ERROR";
          throw e;
        }
        if (typeof chunk.response === "string" && chunk.response.length > 0) {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - started;
            emit("first-token", {
              time_to_first_token_ms: firstTokenMs,
              likely_loaded_model: firstTokenMs > effectiveLoadWindow,
            });
          }
          accumulated += chunk.response;
        }
        if (chunk.done) {
          finalChunk = chunk;
          emit("done", { eval_count: chunk.eval_count, total_duration: chunk.total_duration });
        }
      }
    }

    // Flush any trailing buffered line.
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim());
        if (typeof chunk.response === "string") accumulated += chunk.response;
        if (chunk.done) finalChunk = chunk;
      } catch { /* ignore */ }
    }
  } finally {
    clearTimeout(timer);
  }

  const totalMs = Date.now() - started;
  const parsed = extractJson(accumulated);

  const metrics = {
    model,
    timeout_ms: timeoutMs,
    load_window_ms: effectiveLoadWindow,
    time_to_first_token_ms: firstTokenMs,
    total_ms: totalMs,
    // Ollama reports load_duration in nanoseconds.
    load_duration_ms: finalChunk?.load_duration != null ? Math.round(finalChunk.load_duration / 1e6) : null,
    prompt_eval_count: finalChunk?.prompt_eval_count ?? null,
    eval_count: finalChunk?.eval_count ?? null,
    eval_duration_ms: finalChunk?.eval_duration != null ? Math.round(finalChunk.eval_duration / 1e6) : null,
    likely_model_load: firstTokenMs === null ? true : firstTokenMs > effectiveLoadWindow,
    residency_before: residencyBefore.loaded.map((m) => ({ name: m.name, size_vram: m.size_vram })),
    keep_alive: keepAlive ?? null,
    http_status: status,
  };

  const warnings = [];
  if (firstTokenMs === null) {
    warnings.push("No streamed token was received; the model produced no output.");
  } else if (metrics.likely_model_load) {
    warnings.push(
      `Time to first token was ${firstTokenMs}ms (> ${effectiveLoadWindow}ms window); a model load likely occurred, ` +
        `so latency reflects disk load, not image difficulty.`,
    );
  }
  if (metrics.load_duration_ms != null && metrics.load_duration_ms > effectiveLoadWindow) {
    warnings.push(`Ollama reported a model load of ${metrics.load_duration_ms}ms (cold start).`);
  }

  return {
    ok: parsed !== null,
    json: parsed ? parsed.value : null,
    json_strategy: parsed ? parsed.strategy : null,
    raw: accumulated,
    metrics,
    warnings,
    request: {
      model,
      options,
      format: jsonMode ? "json" : (schema ? "json-schema" : "none"),
      keep_alive: keepAlive ?? null,
    },
  };
}

async function safeVisionModels(host) {
  try {
    return await listInstalledVisionModels(host);
  } catch {
    return [];
  }
}

/**
 * Free-text variant used by the pre-existing tools, so they inherit the same
 * streaming, pinned sampling, and honest fast-fail timeout behaviour without
 * changing their output contract (plain text in, plain text out).
 *
 * @param {object} params same shape as queryOllamaStructured, minus `schema`
 * @returns {Promise<{ text: string, metrics: object, warnings: string[], request: object }>}
 */
export async function queryOllamaVisionText(params) {
  const res = await queryOllamaStructured({ ...params, schema: null, jsonMode: false });
  const warnings = [...res.warnings];
  if (res.raw.trim() === "") {
    warnings.push("Model returned an empty response.");
  }
  return {
    text: res.raw,
    metrics: res.metrics,
    warnings,
    request: res.request,
  };
}

export const _internals = { DEFAULT_LOAD_WINDOW_MS, DEFAULT_NUM_PREDICT, DEFAULT_SEED };
