// ==========================================
// Response truncation tests.
// ==========================================
// These exist because a plain string slice cut structured JSON responses
// mid-token, producing output a consumer could not parse. Observed live: 3 of 6
// structured runs exceeded the client text cap and became unparseable.

import test from "node:test";
import assert from "node:assert/strict";

import {
  truncateForClient,
  truncateJsonForClient,
  DEFAULT_MAX_RESPONSE_TEXT_CHARS,
} from "../lib/response.js";

test("truncateForClient leaves short text untouched and marks long text", () => {
  assert.equal(truncateForClient("hello", 100), "hello");
  const long = "x".repeat(50);
  const out = truncateForClient(long, 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.match(out, /\[truncated for client context limits\]/);
});

test("truncateJsonForClient returns valid JSON for an under-limit payload", () => {
  const value = { success: true, summary: "small", claims: [] };
  const out = truncateJsonForClient(value);
  const parsed = JSON.parse(out);
  assert.equal(parsed.summary, "small");
  assert.equal(parsed._truncation, undefined, "must not mark untruncated payloads");
});

test("truncateJsonForClient keeps valid JSON when only large strings overflow", () => {
  const value = {
    success: true,
    summary: "s".repeat(4000),
    provenance: { model: "m", warnings: ["w".repeat(3000)] },
    claims: [{ claim: "x", kind: "text", confidence: 1 }],
  };
  // The payload serialises to ~7.2k, so cap below that to force truncation.
  const limit = 4000;
  const out = truncateJsonForClient(value, limit);
  assert.ok(out.length <= limit, `output must respect the limit (got ${out.length})`);
  const parsed = JSON.parse(out); // throws if invalid
  assert.equal(parsed.success, true);
  assert.equal(parsed._truncation.truncated, true);
  // Keys survive; only the big strings were shortened.
  assert.ok(Array.isArray(parsed.claims));
  assert.ok(parsed.provenance);
  assert.ok(
    parsed._truncation.actions.some((a) => a.action === "shortened_string"),
    "the string shortening must be reported",
  );
});

test("truncateJsonForClient keeps valid JSON when many small fields overflow", () => {
  const value = {
    success: true,
    claims: Array.from({ length: 300 }, (_, i) => ({ claim: `c${i}`, kind: "text", confidence: 0.5 })),
    text_items: Array.from({ length: 200 }, (_, i) => ({
      text: `T${i}`, source: "vl", box: { left: i, top: i, width: 10, height: 10 },
    })),
  };
  const out = truncateJsonForClient(value, 12000);
  assert.ok(out.length <= 12000, `output must respect the limit (got ${out.length})`);
  const parsed = JSON.parse(out); // the whole point: this must not throw

  // The envelope survives and content is trimmed rather than discarded.
  assert.equal(parsed.success, true);
  assert.ok(Array.isArray(parsed.claims), "claims must survive as an array");
  assert.ok(Array.isArray(parsed.text_items), "text_items must survive as an array");
  assert.ok(parsed.claims.length >= 1, "at least one claim is retained");
  assert.equal(parsed._truncation.truncated, true);
  assert.ok(
    parsed._truncation.actions.some((a) => a.action === "dropped_array_items"),
    "the trim must be reported",
  );
});

test("truncateJsonForClient records what it shortened so callers know the list is partial", () => {
  const value = {
    success: true,
    items: Array.from({ length: 500 }, (_, i) => ({ id: i, label: `item-${i}` })),
  };
  const out = truncateJsonForClient(value, 6000);
  const parsed = JSON.parse(out);
  const drop = parsed._truncation.actions.find((a) => a.action === "dropped_array_items");
  assert.ok(drop, "a dropped_array_items action must be recorded");
  assert.ok(drop.dropped > 0, "the number dropped must be reported");
  assert.equal(drop.remaining, parsed.items.length, "remaining count must match the payload");
  assert.match(parsed._truncation.note, /incomplete/i);
});

test("truncateJsonForClient never returns a partial token stream", () => {
  // A pathological payload that cannot be trimmed enough by arrays alone.
  const value = { success: true, blob: { deep: { very: "z".repeat(50000) } } };
  const out = truncateJsonForClient(value, 2000);
  assert.doesNotThrow(() => JSON.parse(out), "output must always parse as JSON");
  assert.ok(out.length <= 2000);
});

test("the default cap is a positive number and matches the documented value", () => {
  assert.equal(typeof DEFAULT_MAX_RESPONSE_TEXT_CHARS, "number");
  assert.ok(DEFAULT_MAX_RESPONSE_TEXT_CHARS > 0);
  assert.equal(DEFAULT_MAX_RESPONSE_TEXT_CHARS, 12000);
});
