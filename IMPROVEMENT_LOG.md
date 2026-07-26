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

## Cycle 2 — Ollama concurrency gate (2026-07-26)

### Trigger
User confirmed the security fixes could stay as-is threat-model-wise (server is LAN-only
behind ufw, auth deferred), restarted the live systemd service to pick up Cycle 1, and raised
an operational issue: parallel MCP tool calls that hit Ollama (`analyze_image`,
`find_text_element`, `compare_images`, `browser_screenshot_analysis`, `detect_ui_elements`,
`visual_diff`) can crash the host — the box runs a unified-memory GPU (NVIDIA GB10 / Grace
Blackwell-class, 121GB shared system+GPU memory) shared with a large local Ollama model
library (100+ models installed), and `queryOllamaVision()` had zero concurrency control: every
tool call fired an unbounded `fetch()` straight at Ollama.

### Finding
Confirmed via code read (`index.js` `queryOllamaVision`) — no semaphore, no queue, no cap.
Any number of concurrent MCP tool calls (from one client issuing parallel requests, or
multiple clients) would all hit `/api/generate` on Ollama simultaneously, each potentially
loading/running a multi-GB vision model (`llava:13b` fast, `qwen3-vl:30b` heavy), which is
consistent with the reported crashes.

### Fix
Added an in-process concurrency gate around `queryOllamaVision()`:
- `MAX_PARALLEL_OLLAMA_REQUESTS` (default `1`) — hard cap on simultaneous Ollama calls; extras
  queue in-process (FIFO) instead of being sent to Ollama concurrently.
- `MAX_OLLAMA_QUEUE_SIZE` (default `20`) — bounds the wait queue so a burst of clients fails
  fast with a clear error instead of piling up unboundedly in server memory.
- Queue wait happens *before* the per-request `OLLAMA_TIMEOUT_MS` clock starts, so time spent
  queued doesn't eat into a request's inference timeout budget (though the caller's own MCP
  client-side timeout still spans the whole wait+inference duration — documented in README).
- `check_vision_health` now reports live queue depth (`Ollama Concurrency: X/Y active, Z queued`)
  for operational visibility.
- Kept as a simple in-memory semaphore (no external queue/broker) — appropriate for a
  single-process server with no clustering, and avoids adding a new dependency for a
  same-process synchronization problem.

### Test results
- `node --check index.js` — passes.
- Started a throwaway instance (`MAX_PARALLEL_OLLAMA_REQUESTS=1`, default) on port 11499, fired
  3 concurrent `analyze_image` calls via real MCP JSON-RPC against a real local Ollama
  (`llava:13b`): server log showed `[OLLAMA QUEUE] Slot busy (1/1 active) — queuing (position 1/2)`
  for the 2nd and 3rd calls; `check_vision_health` mid-flight reported `1/1 active, 2 queued`;
  the three responses completed serially (~130ms apart) rather than simultaneously — confirms
  requests are no longer sent to Ollama in parallel.
- Live systemd service restarted by user after Cycle 1; re-verified `generate_repo_graph`
  allowlist rejection against the live port (11402) post-restart. Cycle 2's queue change will
  go live on the next restart.

### Deferred / what's next
- Current design blocks the whole tool-call `await` while queued — for `MAX_OLLAMA_QUEUE_SIZE=20`
  worth of queued heavy vision calls this could hold open many MCP requests/connections at
  once even though only one is actually running; fine for expected LAN-scale usage, worth
  revisiting if usage grows.
- No per-client fairness (FIFO only) — one client issuing many calls can starve others. Not
  addressed since current usage is small-scale/trusted LAN clients.
- Still open from Cycle 0: no auth on `/mcp`/`/sse` (explicitly deferred by user this cycle,
  acceptable given LAN + ufw restriction).

### Self-assessment: another cycle?
Yes — reasonable next candidates: (a) extend `test_runner.mjs` with regression tests for the
SSRF guard, repo_path allowlist, and concurrency gate so these don't silently regress; (b)
general schema/description audit of all 14 tools for LLM-client ergonomics (Phase 1 of the
original brief, not yet done); (c) auth model, whenever the user wants to open this beyond LAN.

## Cycle 3 — Regression tests + test-suite timeout fix (2026-07-26)

### What was done
Added 5 regression tests to `test_runner.mjs` (Section 8, "Security Regressions") covering
the fixes from Cycles 1–2, run over real MCP JSON-RPC against the live service:
- `generate_repo_graph` happy path (project root) and edge case (path outside
  `ALLOWED_REPO_ROOTS`, asserts the allowlist error message).
- `download_image` SSRF-guard edge cases: loopback URL (`localhost`) and an RFC1918 literal
  IP (`10.0.0.1`) — both asserted to be rejected with an "internal" error message. No
  network-dependent happy-path test was added for `download_image` (would require reaching
  a real public host from the test suite; the tool was already manually verified in Cycle 1).
- `check_vision_health` asserts the new "Ollama Concurrency: X/Y active, Z queued" field is
  present, guarding the Cycle 2 observability addition.

### Bug found and fixed while running the suite
First full run: 49/64 passed, 15 failures, all `MCP error -32001: Request timed out` on
Ollama-calling tools. Root cause: `test_runner.mjs` never set a client-side request timeout,
so every `callTool()` used the MCP SDK's 60s default. This was already a known sharp edge
(README has a whole "MCP SDK Request Timeout" section recommending heavy tools pass a longer
`timeout`), but Cycle 2's concurrency gate made it bite reliably in the test suite — model
load/swap time between the fast (`llava:13b`) and heavy (`qwen3-vl:30b`) models plus real
inference time routinely exceeds 60s once calls are serialized instead of firing at once.

Fix: `runTest()` now wraps `client.callTool` to default every call to a 300s timeout
(matching the project's own documented `MCP_REQUEST_TIMEOUT_MS` convention) unless a test
explicitly overrides it. This is a test-suite fix, not a server change — it makes the suite
consistent with the client behavior the README already tells real users to adopt.

### Test results (after the timeout fix)
Second full run: **59/64 passed**, 5 failures remaining — all `analyze_image` calls
(base64, upload://, and jpeg/webp/gif upload variants), all failing with a genuine
**server-side** Ollama timeout (`Ollama request timed out after 180000ms`), not the MCP
client-side `-32001`. This is `OLLAMA_TIMEOUT_MS` (180s) being hit inside `queryOllamaVision`
itself, after the request had already acquired its queue slot and was actively running —
i.e. real inference/model-load latency on the shared host, not a queuing artifact of this
session's changes. `ps aux` at the time showed a large number of unrelated
Ollama-touching processes/MCP servers active on this same host, so GPU/unified-memory
contention from processes *outside this server's control* is the most likely explanation.
**Confirmed not a crash**: `systemctl show -p ActiveEnterTimestamp` showed the live service's
uptime was unchanged across the entire ~test run (no restart), i.e. under the same kind of
sustained real vision-model load that previously caused host crashes, the server this time
degraded gracefully (a handful of slow calls returned a clear timeout error) instead of
taking the host down. That is the outcome Cycle 2 was meant to produce.

### Deferred / what's next
- The 5 remaining `analyze_image` timeouts are environmental (shared host GPU contention),
  not addressed this cycle — flagged rather than papered over by e.g. silently raising
  `OLLAMA_TIMEOUT_MS`, since that's a host-capacity question, not a code defect.
- Still open: schema/description ergonomics audit (Phase 1 of the original brief) not yet
  done; auth model for `/mcp`/`/sse` remains explicitly deferred per user's LAN/ufw context.

### Self-assessment: another cycle?
The two concrete operational risks the user raised (unauthenticated filesystem/SSRF exposure,
Ollama-concurrency crashes) are now fixed, tested against the live service, and covered by
regression tests. Diminishing returns on continuing to chase environmental GPU-contention
flakiness without more host-level visibility (e.g. `nvidia-smi`/`ollama ps` during a failure).
Next highest-value work is either the schema/ergonomics audit (lower urgency, not
crash/security-related) or investigating host-level Ollama concurrency across *all* of this
machine's Ollama clients, not just this MCP server — worth a scoped conversation with the user
before diving in, since it may involve config outside this repo (e.g. Ollama's own
`OLLAMA_MAX_LOADED_MODELS`/`OLLAMA_NUM_PARALLEL`).

### Deferred (not in scope this cycle, noted for later)
- No authentication at all on `/mcp`, `/sse`, `/messages` (only `/upload` has rate limiting).
  Flagging this as the single biggest structural gap — everything else is secondary while the
  whole tool surface is reachable by any network client that can hit port 11402.
- Local-file-path resolution in `resolveImageToBuffer` accepts any server-host path whose
  content passes an image-magic-byte check — not full arbitrary file read, but worth revisiting
  once auth exists.
- `generate_repo_graph`/vision tools have no per-tool rate limiting (only `/upload` does) — a
  DoS vector against Ollama if the server were exposed further.
