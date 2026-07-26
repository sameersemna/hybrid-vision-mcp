# Hybrid Vision MCP Server — Improvement Log

## Cycle 0 — Orientation (2026-07-26)

### What this server is
Single-file (`index.js`, ~1880 lines) Node.js/Express MCP server exposing 14 vision-related
tools (OCR, image preprocessing, Ollama vision analysis, screenshot annotation, visual diff,
UI element detection, DOM extraction, repo graphing, URL image download) over three transports:
Streamable HTTP (`/mcp`), legacy SSE (`/sse` + `/messages`), plus a binary `/upload` endpoint.
Backed by local Tesseract.js (OCR), Sharp (image ops), and a local Ollama instance (vision LLM).

- SDK: `@modelcontextprotocol/sdk` v1.29.0 (Streamable HTTP + SSE transports, no `resources`/`prompts` capability — tools only).
- Runs as a live systemd service (`mcp-hybrid-vision.service`), bound to `0.0.0.0:11402`, currently active (uptime ~20h at time of writing).
- Git history shows this repo has already been through several prior hardening passes: upload MIME/magic-number validation, rate limiting, CORS config, crop-bounds validation, `upload://`/`download://` reference schemes, MCP request timeout config. This is not a fresh/naive codebase.

### Most important capabilities
1. `analyze_image` / `compare_images` / `find_text_element` / `browser_screenshot_analysis` / `detect_ui_elements` — Ollama vision model calls (the core value prop).
2. `fast_ocr_tesseract` — local OCR, no external calls.
3. `browser_screenshot_annotation` / `visual_diff` — SVG-overlay and pixel-diff image generation.
4. `download_image` — fetches a remote URL server-side and returns a `download://` reference.
5. `generate_repo_graph` — walks an arbitrary filesystem path and returns structure + Graphviz DOT.

### Priority goals for this loop (agreed with user before any code changes)
Given the server is **unauthenticated and network-bound**, security hardening was prioritized
over spec-compliance/ergonomics work this cycle. Two concrete vulnerabilities were confirmed
and the user explicitly authorized fixing both:

1. **SSRF** — `downloadImageToFile()` (used by both the `download_image` tool and transparent
   HTTP(S) URL resolution in every image-accepting tool) fetches any attacker-supplied URL from
   the server process with no restriction on destination. Any unauthenticated network client
   could use this to probe/reach the internal LAN, `localhost`, or cloud-metadata endpoints
   (e.g. `http://169.254.169.254/`) from the server's network vantage point.
2. **Unrestricted filesystem enumeration** — `generate_repo_graph` accepts any `repo_path` with
   no allowlist and recursively walks it (up to `max_depth`), returning the full tree structure.
   Since the server has no auth, any client could point this at `/`, `/etc`, `/home/<user>`, etc.
   and get back a structural map of the entire host filesystem.

Both are additive hardening (deny-by-default guard + allowlist), not schema-breaking changes —
existing legitimate callers (public image URLs, repo paths under the allowed root) are unaffected.

### How to exercise
- Health: `curl http://localhost:11402/health`
- No MCP Inspector installed in this environment; exercised via direct `curl` against `/mcp`
  (Streamable HTTP, JSON-RPC) and by reading `test_runner.mjs` / `test-mcp.js` (existing test
  scripts already cover happy-path + edge cases for every tool — see README "Testing" section).
- Service is managed by systemd (`systemctl restart mcp-hybrid-vision`); logs at `service.log`.

## Cycle 1 — SSRF guard + repo_path allowlist (2026-07-26)

### Findings addressed
1. **SSRF via outbound image URL fetch** (`downloadImageToFile`, used by `download_image` and
   transparent HTTP(S) resolution in every image-accepting tool). Added `assertPublicHttpUrl()`:
   resolves the hostname via DNS and rejects loopback, RFC1918, link-local/CGNAT, and other
   non-public ranges (IPv4 + IPv6, including IPv4-mapped IPv6) before fetching. Known limitation
   (documented inline): this is a DNS-lookup-time check, not connection-pinned, so it does not
   fully defend against DNS-rebinding — Node's built-in `fetch()` doesn't expose a way to pin
   the connection to the address that was validated. Flagged as a possible follow-up (custom
   `undici` dispatcher with a `lookup` override) if this deployment's threat model requires it.
2. **Unrestricted filesystem enumeration via `generate_repo_graph`**. Added `ALLOWED_REPO_ROOTS`
   env var (defaults to the server's own project directory) and `isPathAllowedForRepoGraph()`
   guard; any `repo_path` outside the allowlist is now rejected with a clear error naming the
   allowed roots.

### Test results
- `node --check index.js` — passes.
- Started a throwaway instance on port 11499 (systemd service left untouched pending restart
  approval — see below) and exercised over real MCP JSON-RPC (`/mcp`, Streamable HTTP):
  - `download_image` against `http://127.0.0.1:11499/health` → correctly blocked
    (`Blocked URL: "127.0.0.1" resolves to a private/internal address`).
  - `generate_repo_graph` against `/etc` → correctly rejected (outside allowlist).
  - `generate_repo_graph` against the project root → still works (49 nodes returned).
  - `download_image` against a real public URL (raw.githubusercontent.com) → still works,
    confirming no regression for legitimate use.
- No existing automated test suite covers these two tools' negative cases; `test_runner.mjs`
  wasn't extended in this cycle (see "next" below).

### Deferred / what's next
- The live systemd service (`mcp-hybrid-vision.service`) is still running the pre-fix code —
  restarting it requires `sudo` and wasn't done automatically. **Needs a manual
  `sudo systemctl restart mcp-hybrid-vision`** to pick up this fix.
- Add negative-path regression tests for both guards to `test_runner.mjs` so future changes
  don't silently regress them.
- The structural gap flagged in Cycle 0 remains: **no authentication at all** on `/mcp`/`/sse`.
  These two fixes reduce blast radius but don't close it — any network client can still call
  every vision tool freely. Worth a dedicated cycle (API key / bearer token gate) if this
  service will stay network-reachable.
- DNS-rebinding hardening for the SSRF guard (see above) if the threat model warrants it.

### Self-assessment: another cycle?
Yes, worth it — the no-auth gap is the highest-leverage remaining item, but it's a more
invasive change (new required header/config for every existing client) so it deserves its own
scoped conversation with the user rather than being bundled here. Stopping this cycle here
rather than proceeding unprompted into an auth model change.

### Deferred (not in scope this cycle, noted for later)
- No authentication at all on `/mcp`, `/sse`, `/messages` (only `/upload` has rate limiting).
  Flagging this as the single biggest structural gap — everything else is secondary while the
  whole tool surface is reachable by any network client that can hit port 11402.
- Local-file-path resolution in `resolveImageToBuffer` accepts any server-host path whose
  content passes an image-magic-byte check — not full arbitrary file read, but worth revisiting
  once auth exists.
- `generate_repo_graph`/vision tools have no per-tool rate limiting (only `/upload` does) — a
  DoS vector against Ollama if the server were exposed further.
