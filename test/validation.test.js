import test from "node:test";
import assert from "node:assert/strict";
import { resolveWithinBase, isPathWithinAllowedRoots } from "../lib/validation.js";

test("resolveWithinBase allows files inside the base directory", () => {
  assert.equal(resolveWithinBase("/tmp/base", "/tmp/base/file.png"), "/tmp/base/file.png");
});

test("resolveWithinBase rejects traversal outside the base directory", () => {
  assert.throws(() => resolveWithinBase("/tmp/base", "/tmp/base/../escape.png"), /outside the allowed directory/);
});

test("isPathWithinAllowedRoots rejects paths outside the workspace roots", () => {
  assert.equal(isPathWithinAllowedRoots("/tmp/escape", ["/tmp/workspace"]), false);
});
