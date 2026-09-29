# Accuracy Hardening

This document records an accuracy-hardening pass on `hybrid-vision-mcp`.

The trigger: a downstream agent used these tools to verify a web UI and received
**confident, specific, wrong** answers. The tools offered no signal that the
output was unreliable, so the agent nearly reported fabricated layout defects to
a user, while one false negative masked a real accessibility bug.

This was treated as a correctness problem, not a prompt-wording problem. A
7B/32B vision-language model cannot be made reliable by asking it more politely,
so the fixes are **architectural**:

1. measurable questions are answered by code,
2. model output is schema-constrained,
3. model text is cross-validated against OCR,
4. how every answer was produced is reported.

---

## 1. Root causes found in the code

Everything below was confirmed by reading `index.js`, not inferred.

| # | Cause | Where | Effect |
|---|-------|-------|--------|
| R1 | Ollama was called with **no `format`**, no `temperature`, no `seed`, no `num_predict`, no `keep_alive` | `queryOllamaVision()` | Free prose was accepted as fact; nothing constrained a claim to a field; sampling was random. |
| R2 | No `format` schema existed anywhere in the server | whole file | Even `detect_ui_elements`, which asks for a JSON array in its prompt, had no enforced shape. |
| R3 | A single opaque `AbortController` with `OLLAMA_TIMEOUT_MS` (default 180000) | `queryOllamaVision()` | No distinction between *loading a model* and *inferring*; no progress; no residency context. |
| R4 | Timeout hint named `llava:7b` | `queryOllamaVision()` | That model was **not installed on this host**; the hint advised a model that also could not work. |
| R5 | No cross-validation against Tesseract in any VL path | `analyze_image`, etc. | A hallucinated string and a real string were indistinguishable in the response. |
| R6 | `analyze_image` answered quantitative questions in prose | `analyze_image` handler | F4: asserted "sufficient contrast" without measuring anything. |
| R7 | No image resizing — and no report of dimensions sent | `normalizeToPngBuffer()` | The caller could not tell what resolution the model actually saw. |
| R8 | No crop containment checking | — | F3: text outside a supplied crop was reported as if inside it. |

**Note on F2 (claimed silent downscaling):** the brief suspected the server was
downscaling images and thereby losing legibility. Reading the code, **there is
no resize step anywhere** — `normalizeToPngBuffer` only converts format.
`analyze_image` sent the image at its original size. So F2 was **not** caused by
server-side downscaling. Rather than assume, the new layer now *reports* sent vs
input dimensions, so this class of question is answerable from the response
instead of by inference. No silent resize was introduced; an explicit, reported
`maxDimension` path exists for callers who want one.

---

## 2. What changed

### 2.1 A deterministic measurement layer (`lib/color.js`, `lib/measure.js`)

Anything with a numeric answer is computed from pixels:

- **WCAG 2.x contrast** — true relative-luminance maths, plus `wcag_aa` /
  `wcag_aaa` and the required threshold. Validated against the fixture's
  declared values to 2 decimal places (13.42, 2.14, 6.03, 1.04).
- **Colours** — exact-colour histograms, dominant colours, per-region
  background/foreground identification.
- **Counts** — 4-connected component labelling over a colour mask gives exact
  box counts and pixel-accurate bounding boxes.
- **Region content** — fraction of pixels differing from the background
  ("is there anything visible here?").
- **Crop containment** — geometric overlap test.

None of this touches Ollama, so these answers remain correct and available even
when the model is unreachable or queued.

New tool: **`measure_image`** (`mode: contrast | colors | boxes | layout | all`).

### 2.2 Schema-constrained output (`lib/prompts.js`, `lib/vision.js`)

Every structured call now sends Ollama a **JSON schema** in `format`, plus the
schema echoed in the prompt (the officially recommended practice). Sampling is
pinned (`temperature: 0`, explicit `seed`, capped `num_predict`).

The schema requires `summary`, `claims[]`, and `abstained[]`. Every claim
carries its own justification:

```
claims[]  { claim, kind, box{left,top,width,height}, confidence, evidence }
                                    + server-added: source, verified, basis
```

`abstained[]` is required by the schema and the prompt explicitly states that
abstaining is preferred to guessing. A model returning unparseable prose yields
**zero** claims and an explanatory warning — the raw text is retained under
`raw_model_output` for inspection, never promoted to a fact.

New tool: **`analyze_image_structured`**.

### 2.3 Cross-validation against Tesseract (`lib/crossvalidate.js`)

The highest-value change. Every transcribed string is classified:

| `source` | Meaning | Confidence effect |
|----------|---------|-------------------|
| `vl+ocr` | VL model and Tesseract agree | **raised** (+0.25, capped at 1) |
| `vl` | Only the model saw it, but the box is plausible and in-crop | **halved**, flagged `single_source_unverified` |
| `unverified` | No OCR support **and** no plausible box | **quartered**, flagged `no_ocr_support` + `no_plausible_box` |

`unverified` is the F1/F2/F3 fabrication signature, now explicit rather than
indistinguishable from truth. Strings found by OCR but omitted by the model are
surfaced under `cross_validation.ocr_only`.

### 2.4 Quantitative questions are never guessed (`lib/analyze.js`)

`detectQuantitativeQuestion()` recognises measurable prompts (contrast, counts,
ratios, sizes, colours, alignment). When triggered:

- `analyze_image_structured` and `analyze_image` **short-circuit to
  deterministic measurement and never call the model**;
- the response says `answered_by: "deterministic-measurement"` and
  `model_consulted: false`;
- any model claim that *did* assert a number is moved to `unsupported_claims`.

This is what makes acceptance test 5 real: the guarantee holds with the model
completely down, because no model call is made.

### 2.5 No silent downscaling; explicit legibility floor (`lib/legibility.js`)

- Default behaviour is unchanged: the image is sent at its original size.
- The response now always reports `input_dimensions`, `sent_dimensions`,
  `downscaled`, `scale_factor`, and `coordinate_space`.
- Below the legibility floor (short side < 256px, or < 65536 total pixels) a
  warning is raised recommending re-capture or a crop.
- `tileImage()` exists for callers who want to split an image rather than trust
  a too-small one, so the "tile **or** warn" branch is real, not warn-only.
- The response also notes that vision models commonly resize internally, so
  dimension reporting is not mistaken for a guarantee about internal treatment.

### 2.6 Crop awareness (`analyze.js`, `measure.js`)

The crop is **physically applied** with Sharp before the model sees anything, so
content outside the crop cannot reach it. Returned boxes are additionally
checked for containment against the crop bounds and flagged `outside_crop` when
they do not overlap it.

### 2.7 Honest, fast timeouts (`lib/vision.js`)

The request is streamed, so we can distinguish:

- **loading** — time-to-first-token exceeds a load window, or Ollama reports
  `load_duration` above it;
- **inferring** — first token arrived quickly, so latency is inference cost.

A timeout error now reports: model, elapsed, timeout, first-token time, a
**residency snapshot** (`/api/ps`), a diagnosis, an actionable remedy, and the
**vision models actually installed on this host** (from `/api/tags`). The old
`llava:7b` hint is gone. `keep_alive` is exposed and honoured, including `"0"`
to unload.

### 2.8 Provenance on every response (`lib/legibility.js`)

`provenance` carries `model`, `options` (temperature, seed, num_predict),
`request` (format kind, keep_alive), `image` (dimensions, downscaled, scale,
coordinate space, legibility), `ocr`, `metrics` (time-to-first-token, total,
load_duration, eval_count, likely_model_load, residency), and `warnings`.

The pre-existing text tools (`analyze_image`, `find_text_element`,
`compare_images`, `browser_screenshot_analysis`, `detect_ui_elements`) also
append a compact `[provenance]` / `[warnings]` footer, so even the legacy output
shape now says which model answered and at what resolution.

`check_vision_health` additionally reports which models are **resident right
now** and their VRAM — the F5 condition the old health check hid.

---

## 3. API compatibility

Tool names, argument names, and existing JSON keys were **not renamed or
removed**. The changes are additive: new tools (`measure_image`,
`analyze_image_structured`), new response fields (`provenance`, `warnings`,
`claims[]`, `cross_validation`, …), and a provenance footer appended to legacy
text output. An existing client that ignores unknown fields is unaffected.

---

## 4. Acceptance fixture

`lib/fixtures.js` builds a synthetic PNG and a declared ground truth, and
`assertFixtureTruth()` **asserts the fixture against itself** before any test
relies on it (a wrong fixture invalidates everything downstream).

Reference background `#1a1814`:

| Text | Colour | Contrast | Required behaviour | Verified |
|------|--------|----------|--------------------|----------|
| `ALPHA-ONE` | `#E8DFD0` | 13.42:1 | must be transcribed | ✅ measured 13.42 |
| `BRAVO-TWO` | `#484f58` | 2.14:1 | must be flagged low contrast | ✅ measured 2.14, `wcag_aa:false` |
| `CHARLIE-THREE-8g7x2` | `#A09588` | 6.03:1 | must be transcribed (small text) | ✅ measured 6.03 |
| `DELTA`/`ECHO`/`FOXTROT`/`GOLF` | `#E8DFD0` | 13.42:1 | exactly **4** boxes | ✅ counted 4 |
| `HOTEL-FIVE-INVISIBLE` | `#1e1c18` | 1.04:1 | must **not** be reported as text | ✅ absent from OCR |

`only_box_with_plus == "ECHO"` is asserted: exactly one marker component exists
and it resolves inside the ECHO box.

Run it:

```bash
npm run test:fixture  # assert the fixture against its own ground truth
npm run test:nonvacuity  # prove each test fails when its fix is reverted
```

---

## 5. Acceptance tests

`test/accuracy.test.js`, wired into the existing `npm test` command
(`node --test`). Model interactions use a local mock on an ephemeral port; the
deterministic tests call library code directly.

| # | Test | Result |
|---|------|--------|
| 0 | fixture ground truth asserted first | ✅ |
| 1 | fixture transcription (legible read, low-contrast flagged, invisible absent) | ✅ |
| 2 | box count is exactly 4; ECHO is the only box with `+` | ✅ |
| 3 | crop awareness: `"Internal"` outside the crop → `unverified`, `outside_crop` | ✅ |
| 4 | contrast ≈ 2.14 with `wcag_aa:false` | ✅ |
| 5 | quantitative answers succeed with the model **unavailable** | ✅ |
| 6 | schema validity: request carries a JSON schema, pinned sampling, streaming | ✅ |
| 7 | abstention is first-class; prose cannot become a claim | ✅ |
| 8 | provenance: model, options, real dimensions sent, warnings | ✅ |
| 9 | determinism: identical inputs → identical measurements | ✅ |
| 10 | timeout is fast, explains residency, names installed models | ✅ |

```bash
npm test              # full suite (existing + accuracy + tool coverage)
npm run test:accuracy # the ten acceptance tests only
```

### Tool coverage (regression guard)

`test/tools.test.js` spawns the real server against a **mock Ollama** and calls
**every** tool, then asserts the legacy text tools carry a provenance footer.
This exists because a wiring bug introduced during this work (`browser_screenshot_analysis`
referencing an undefined `pngBuf`) slipped past the unit-level accuracy tests,
which only covered the new modules. The test was confirmed to catch it: with the
bug reintroduced, it fails with
`browser_screenshot_analysis: isError -> pngBuf is not defined`.

### Non-vacuity

Each test was confirmed **non-vacuous** by reverting the specific fix it depends
on and observing the test fail, then restoring the source:

```bash
npm run test:nonvacuity
```

Result — all confirmed:

```
NON-VACUOUS  T1/T4 contrast flagging
NON-VACUOUS  T2 box counting
NON-VACUOUS  T3 crop containment
NON-VACUOUS  T5 quantitative without model
NON-VACUOUS  T6 schema-constrained request
NON-VACUOUS  T7 no fabrication from prose
NON-VACUOUS  T8 provenance reporting
NON-VACUOUS  T9 pinned streaming sampling
NON-VACUOUS  T10 actionable timeout hint
```

---

## 5b. Multi-colour contrast enumeration (follow-up hardening)

### The defect

`contrastInRegion` used to select the single colour with the **maximum luminance
delta** from the background — i.e. the colour that was *easiest* to read — and
report only that. On an image containing large text at 2.14:1 and 1.04:1
alongside a 13.42:1 heading, the whole-image result was:

```json
{ "foreground": "#e8dfd0", "contrast_ratio": 13.42, "wcag_aa": true,
  "notes": [], "abstained": [] }
```

A caller asking "does this screenshot have contrast problems?" therefore
received `wcag_aa: true`, reading as **"no problems"**. `#484f58` and `#1e1c18`
were absent from the result entirely. Because the number was presented as a
deterministic measurement, the false negative looked *more* authoritative than
the original prose failure it replaced.

This was a **selection and reporting** bug. The WCAG maths was already correct
(a tight region cropped to `#484f58` returned exactly 2.14) and was not changed.

### The fix

Contrast is now enumerated per text colour, and the headline scalar is the
**worst** case:

```json
"contrast": {
  "worst": { "foreground": "#1e1c18", "contrast_ratio": 1.04, "wcag_aa": false },
  "best":  { "foreground": "#e8dfd0", "contrast_ratio": 13.42, "wcag_aa": true },
  "failing_count": 2,
  "all_meet_aa": false,
  "colours": [ /* one entry per evaluated text colour */ ],
  "excluded": [ /* decorative colours, with the reason */ ],
  "notes": [ /* explicit scope disclosure */ ]
}
```

**Method — spatial components, not a colour histogram.** A histogram of an
anti-aliased screenshot contains hundreds of edge shades (the fixture has 608
distinct colours, mostly 1–2px halos). Filtering those by frequency *or* by
contrast is exactly how low-contrast text gets dropped. Instead, pixels are
grouped into connected "ink" components and each component contributes one
candidate colour — its most extreme pixel. Anti-aliasing is removed by
structure rather than by a threshold.

**Near-background text is still caught.** `#1e1c18` sits only ~7 RGB units from
the `#1a1814` background, so an ink threshold above that discards it. The
threshold is configurable (`ink_threshold`, default 4).

**Renderer independence.** PIL and librsvg anti-alias differently; librsvg left
fragments like `#787065` (3.63:1) around the 13px text, which would inflate the
failing count and make results depend on the rasteriser. Such shades are a
*blend* of background and glyph colour, so they are detected geometrically
(mid-point blend fraction with near-zero collinearity residual) and folded into
their parent. Two guards keep this safe:

- an artefact cannot carry **more ink than the colour it blends towards**
  (without this, a 4768px border folded into a 639px text colour);
- a cluster that is **itself a closed outline** is structural chrome, not a
  blend.

`#1e1c18` is protected because its blend fraction is ~0.07, below the 0.25
floor — a real near-background colour is not mistaken for an artefact.

### `wcag_aa` semantics — explicit change

At the `measurements.contrast` level, `wcag_aa` now **aliases the worst case**
(`all_meet_aa`): it is `true` only when *every* evaluated text colour passes AA.
Previously it meant "the most legible colour passes", which could be `true` on
an image full of failing text. `best.contrast_ratio` preserves the old number,
and `contrast_ratio` / `contrast_ratio_raw` / `foreground` now refer to the
worst case.

This is documented rather than silently renamed: an existing caller reading
`wcag_aa` was being told something misleading, so keeping it meaning "best case"
would have preserved the defect.

### Never "fine" without scope

If a colour is excluded (decorative) or skipped (below the reporting floor), it
is listed under `excluded` / `skipped` and described in `notes` with its ratio
and pixel count, and it is excluded from `all_meet_aa`. If nothing assessable is
found, the result is `measurable: false` with an `abstained[]` entry rather than
a verdict.

### §3.5 consistency fixes

- **`text_items` is no longer empty.** It previously drew only on model output
  while `cross_validation.ocr_only[]` was populated, so a consumer iterating
  `text_items` saw nothing. OCR-sourced strings are now included with
  `source: "ocr"` and `reported_by_model: false`. `cross_validation` also
  reports `text_items_count` and `text_items_sources` so the two cannot drift.
- **`unreadable[]` carries provenance.** Each entry has `source: "model"` and
  `verified: false`. A claim is flagged `contested` when OCR read corresponding
  text — either `"precise"` (the named text was read) or `"blanket"` (a generic
  "too small to read" claim while OCR read strings in the same image, which is
  what was observed on the fixture while Tesseract read four labels at 91–96%
  confidence). Contradiction is also surfaced in `warnings`.

### Contrast tests (`test/contrast.test.js`)

| # | Test |
|---|------|
| 1 | whole image: `failing_count == 2`, `all_meet_aa == false`, `#484f58`@2.14 and `#1e1c18`@1.04 enumerated, passing `#e8dfd0`@13.42 / `#a09588`@6.03 / `#7daa7a`@6.67 also enumerated, `worst == 1.04`, `best == 13.42`, border excluded with a note |
| 2 | tight region of `#484f58`: `worst == best == 2.14`, `wcag_aa == false` |
| 3 | tight region of `#e8dfd0`: `all_meet_aa == true` |
| 4 | all-passing image: `all_meet_aa == true` (proves `false` is not hard-coded) |
| 5 | `analyze_image_structured` on a contrast question exposes the failing colours, not a single passing ratio |
| 6 | box counting (4 boxes, even 215px spacing) and the WCAG maths unchanged |
| + | anti-aliasing merge, renderer independence, §3.5 consistency |

```bash
npm run test:contrast
npm run test:nonvacuity:contrast
npm run fixture:make && node index.js &      # then:
npm run verify:contrast-live
```

---

## 6. F1–F5 status, with observed evidence
| # | Status | Evidence |
|---|--------|----------|
| **F1** fabricated arrow glyphs | **Flagging mechanism added; not reproduced with the model tested.** | With real `llava:13b` the failure mode observed on this fixture was *omission*, not fabrication (empty `text_items`), so fabrication could not be induced. The flagging path is proven deterministically: `crossValidateText` classifies text with no OCR support and no plausible box as `unverified` (test + non-vacuity T7). |
| **F2** phantom "clipped" text | **Addressed by measurement + provenance.** | Box count measured **4**; sent dimensions reported as `1200x760` (no silent downscale). |
| **F3** out-of-crop text | **Fixed.** | The crop is physically applied; a box outside it is flagged `outside_crop` and `unverified`. Live: nothing from outside the crop surfaced. |
| **F4** invented contrast | **Fixed.** | `BRAVO-TWO` measured **2.14** with `wcag_aa:false`; quantitative prompts answered with `model_consulted:false` in ~48ms. |
| **F5** opaque 180s block | **Fixed.** | Real Ollama: failed in **3044ms** instead of 180000ms, diagnosing that `minicpm-v:8b` was not resident while `llava:13b` held ~9.2GB VRAM, and listing the vision models actually installed. |

Real-model verification scripts (require a running server and Ollama):

```bash
PORT=11499 node index.js &
npm run verify:contrast   # region contrast on the live server
npm run verify:real       # F4 + F3 + fabrication paths
npm run verify:timeout    # fast-fail error payload
```

---

## 7. Deliberately left alone

Per the rules of engagement, these were **not** touched:

- **`fast_ocr_tesseract`** — confirmed still correct. It is *used* by the new
  cross-validation layer in a read-only way; its own behaviour is unchanged.
- **`visual_diff`** — confirmed correct (pixel maths). The only change on its
  path is a provenance object attached to the optional AI description. The
  comparison itself is untouched.
- **`check_vision_health`** — extended additively only.
- **The Ollama concurrency gate** — preserved. Parallel vision inference has
  crashed this host, so serialization stays; the new tools acquire the same slot.
- **Tool/argument names and existing JSON keys** — unchanged (hard constraint).

---

## 8. Known limitations / not fixed

Reported rather than silently skipped:

1. **F1 not reproduced against a real model.** The observed real-model failure
   here was omission, not fabrication. The anti-fabrication mechanism is
   verified deterministically but has not been exercised by a genuinely
   hallucinating model run on this host. A model more prone to hallucination
   than `llava:13b` would be a better reproduction vehicle.
2. **OCR is a strong but not perfect verifier.** On the synthetic fixture,
   Tesseract read all six high/medium-contrast strings and correctly omitted the
   two low-contrast ones. On a *large crisp isolated* rendering it also read the
   invisible string at ~90% confidence, so OCR success alone is **not** a
   legibility gate — which is exactly why contrast is measured rather than
   inferred from OCR. This is recorded as an empirical result, not hidden.
3. **Whole-image contrast is not meaningful without a region.** `measure_image`
   in `contrast` mode with no `region` abstains rather than guess. Callers
   should pass the region that holds the text.
4. **`HOTEL-FIVE-INVISIBLE` returns `measurable: false`** at the default colour
   tolerance, because its colour is within 24 RGB units of the background. That
   is the honest answer (the tool cannot separate text from background), not a
   measured ratio.
5. **Structured output depends on the model honouring `format`.** Thinking
   models sometimes wrap JSON in ` thinking` or fences; `extractJson` strips
   these, but if parsing still fails the server reports `parsed: false` and
   returns no claims rather than guessing.
6. **Model-internal resizing is outside our control.** The server reports what
   it sends and notes that the model may resize internally; it cannot observe
   the model's internal treatment.
7. **Pre-existing, unrelated:** `MAX_UPLOAD_SIZE_BYTES` is computed as
   `Number(env) * 1024 * 1024 || 20MB`, which is fragile though currently
   correct. Out of scope for this task and left as-is.

---

## 8b. Robustness follow-ups

Two defects found while attempting to reproduce the fabrication failure live.

### 8b.1 Structured responses could be unparseable

A plain character slice at `MAX_RESPONSE_TEXT_CHARS` cut JSON mid-token. Three of
six live structured runs exceeded the cap and could not be `JSON.parse`d by a
consumer, which defeats the point of schema-constrained output.

Truncation is now JSON-aware (`lib/response.js`):

1. do nothing if it fits,
2. shorten the largest **string fields**,
3. drop items from the longest **arrays**,
4. last resort: a minimal but strictly valid object.

A `_truncation` block reports every action with counts, so a consumer can tell an
incomplete list from a complete one. Space for that block is reserved before
trimming — without the reserve the payload is trimmed to the limit and then
pushed back over it by the metadata, which triggered the last-resort path and
discarded content that would have fitted (a bug caught by testing, not review).

Verified live: the two previously-failing responses now parse, at 11716 and
11610 characters, reporting `dropped 3 of 12` and `dropped 4 of 12`.

### 8b.2 Upload size limit was silently ineffective

`MAX_UPLOAD_SIZE_BYTES` was `Number(env) * 1024 * 1024 || 20 * 1024 * 1024` —
correct only by accident of `NaN` propagation — and the Express body limit was
built from that byte count, giving `"20971520mb"` (~20TB). The body parser
therefore never rejected an oversized upload.

The megabyte value is now parsed and validated before scaling (matching the
`MAX_DOWNLOAD_SIZE_BYTES` idiom already in the file), non-numeric values log a
warning and fall back to 20MB, and the Express limit is `"20mb"`.

### 8b.3 Live fabrication: attempted, not reproduced

`verify/reproduce-fabrication.mjs` runs fabrication-inducing prompts (invent
symbols, invent an offscreen tab bar, reconstruct tiny text) against real models.
On this host, across `llava:13b` and `minicpm-v:8b`:

- **No text with `source === "unverified"`.** With `format` enforced, both models
  returned `parsed: false` (zero claims) rather than inventing content.
- **No `unreadable` claim contradicted by OCR.**

So the anti-fabrication and unreadable-contesting mechanisms remain verified
**deterministically** (see `test/accuracy.test.js`, `test/contrast.test.js`), not
against a live hallucination. This is reported rather than overclaimed. The
script is committed so a more fabrication-prone model can be substituted via
`REPRO_MODELS=...`.

## 5c. Background modelling, and why the local model is opt-in

The last open item from the earlier audit was the fixed ink threshold
(`?? 4` RGB units from the background), tuned for flat UI screenshots and
suspected to misbehave on photographic images.

### What the measurement actually showed

The threshold *value* was not the problem. A sweep on a text-free noisy canvas
showed that **raising** the threshold makes things worse, because raising it does
not fix the underlying issue:

| threshold T | spurious colour groups on a text-free noisy image |
|---|---|
| 1-4 | 1 |
| 8 | 15 (noise=6), 237 (noise=3) |
| 20 | 354 (noise=6), 1408 (noise=12) |

The real defect is that **one global background colour cannot model a gradient or
photograph**. On a noisy canvas the global modal colour explains ~0.7-6% of
pixels, so most of the image is "not background", and it lands in the enumeration
as a single 175,000-pixel "colour". With text present, the global model resolved
only 1 of 3 known text tones.

Two models were compared:

| case | global | local (per-tile median + noise-scaled threshold) |
|---|---|---|
| flat fixture | 5 text colours (validated) | **byte-identical** |
| text-free noisy photo | 1 group of ~175k px | **0 groups** |
| noisy photo with text | 1 of 3 tones | **2 of 2 bright + dark tone** |
| dense flat dashboard | 190 components (correct) | **622 — over-thresholds, swallows text** |

### The conclusion, and the tradeoff

Neither model is universally correct, so the default is unchanged:

- **Default (`background_mode: "global"`)** — correct for UI screenshots, which
  is the primary use case, and bit-for-bit unchanged for the validated fixture.
- **Opt-in (`background_mode: "local"`)** — per-tile median background with
  `threshold = max(ink_threshold, noise_factor * sigma_local)`, where
  `sigma_local = 1.4826 * MAD`. Handles photographic/gradient/multi-tone images.

`noise_factor` (k) was chosen from a sweep rather than assumed: k=4 gave zero
spurious groups on text-free noise and full recovery of known text colours across
noise levels 3-20. The conversion constant is absorbed into k, so k is
empirically fitted and is documented as such.

**Why local is not automatic:** a 48px tile straddling two flat panels is
bimodal, so its MAD is large and the derived threshold inflates (median effective
threshold 21, max 86 on a dense dashboard). Real text is then swallowed while
panel fills become "ink". This is pinned by a test so the reason is not lost.

**Why flat images are unaffected:** a flat tile has MAD 0, so the local
threshold collapses to the floor (4) and local mode is byte-identical to global
on the fixture. This is asserted directly
(`test/background.test.js`: "local background mode is IDENTICAL to global on a
flat fixture").

### The reporting gap this closed

Previously a caller could receive a confident contrast verdict computed against a
background that explained 0.7% of the image, with no indication the premise had
failed. Every contrast result now carries `background_fit`, and when the fit is
inadequate a warning is pushed into `notes` naming the fraction explained and the
remedy (`background_mode: "local"`). Silent confidence about an unexamined
premise is the exact failure class this hardening pass exists to remove.

### Test-infrastructure fix found along the way

`background.test.js` initially imported from `contrast.test.js`, which caused
Node's test runner to **register those 9 tests twice**. The shared fixtures now
live in `test-support/fixtures.mjs` (outside `test/`, which Node treats entirely
as tests), and the suite count is correct: 46 = 15 + 9 + 9 + 7 + 2 + 3 + 1.

## 5d. Follow-up audit: mode consistency, honest local backgrounds, and text runs

A third independent audit re-verified §1-§5c and found four residual issues in
the new `background_mode` work. All four are fixed here. The class of failure is
the same one the earlier rounds removed, one layer further in: a **confident,
precise-sounding verdict about pixels the code did not correctly classify**.

### F1 — `mode: "contrast"` and `mode: "all"` gave different answers

With no `region`, `mode: "contrast"` abstained while `mode: "all"` silently
measured the whole frame. The same question produced two different answers that
depended only on `mode`, and the abstention text was documented nowhere.

**Fix:** both modes now measure the whole frame when no region is supplied, and
both push a `notes` entry disclosing that the figure is full-frame, so a caller
cannot receive a number without knowing its scope. Asserted by
`test/background.test.js` "F1: region-less contrast agrees between mode
'contrast' and mode 'all'", which also pins the unchanged valid numbers
(worst 1.04, best 13.42, failing 2).

### F2 — in local mode a *text* colour could be reported as the `background`

`enumerateRegionContrast` always returned a `background: { hex, rgb }` derived
from the region's modal colour. On a gradient that modal value can coincide with
a text tone — reproduced on the audit fixture, where local mode reported
`background: #5a5a5a`, which is exactly the `FAILING-TWO` **text** fill.

**Fix:** under `background_mode: "local"` there is no single background by
construction, so `background` is now `null` (a documented response-shape change,
see CHANGELOG). Each colour still carries its own `local_background`, and a note
explains the null.

Separately, `worst` could be set by a single small cluster of residual noise
(the audit measured 291px in 1 component at 1.06:1). Noise is now separated:
a cluster is classified as **suspected noise** only when it is weak
(`contrast < 1.25:1`) **and** structurally untext-like (fewer than 3 components
or mean component area < 100px). Suspected-noise clusters are returned in
`suspected_noise`, named in `notes` as suspected noise, and excluded from
`worst`/`failing_count`/`all_meet_aa` — never silently dropped. Genuine
near-background text (acceptance fixture `#1e1c18`, 1.04:1, 20 components) is
never reclassified. `partitionSuspectedNoise()` / `isSuspectedNoiseCluster()` are
exported and directly tested with the audit's own numbers.

### F4 — anti-aliasing folding swallowed a whole text run

This was the most serious finding, and the audit flagged it as *not proven*: on a
gradient, a mid-grey text line is exactly collinear between the dark background
and a brighter text run, so `isAntiAliasingBlend` returned true and the run was
folded as an "anti-aliasing shade". Reproduced: three known text runs in, one
colour out (`all_meet_aa: true`).

**Counter-evidence to the audit's control claim.** The audit reported the defect
as local-mode-only, with flat+`global` behaving correctly. That does **not**
reproduce on an independently generated fixture: two collinear text tones on a
flat background fold in **both** `global` and `local` on the previous code. The
defect is a property of the colour-only guard, not of local mode. (Recorded
rather than asserted — the audit invited exactly this.)

**Why the audit's suggested spatial test does not work.** Box-overlap between a
would-be AA candidate and its parent was measured at **0% for both genuine AA
fragments and the false fold** — the fragments are already merged into the
parent's boxes. The working discriminator is **component geometry**:

| cluster | components | mean component area | should fold? |
|---|---|---|---|
| genuine AA fragment (`#787065 -> #a09588`) | 2 | 34px | yes |
| genuine AA fragment (`#847c70 -> #a09588`) | 1 | 34px | yes |
| real text run (MID-TWO) | 7 | 322px | **no** |

Real text is *few, large* components; AA halos are *tiny and numerous*.

**Fix:** `mergeAntiAliasing` now requires the candidate to be **not**
independently text-like (`looksLikeIndependentText`: components < 3 **or** mean
area < 100px or < 0.5x the parent's mean area). The colour test is unchanged, so
genuine AA fragments still fold (#787065 and #847c70 still merge into #a09588 —
otherwise the acceptance fixture would report 5 colours instead of 5+2). Merge
records now also carry `component_count` and `mean_component_area`.

### F3 — the advertised live check targeted the wrong port

`verify-background-live.mjs` hard-coded `11499` (a throwaway test port) while the
systemd unit listens on `11402`, so `npm run verify:background` failed with
`ECONNREFUSED` or, worse, silently described a different configuration than the
one deployed.

**Fix:** the script probes the deployed port (`11402`) first, then `11499`, then
honours an explicit `PORT` override, prints which port it used, and on failure
names the ports tried and how to override (`PORT=11402 npm run verify:background`).

### Acceptance evidence for §5d

| check | result |
|---|---|
| `npm test` | **54/54** (was 46; +8 round-3 tests) |
| F1 contrast vs all, no region | agree (worst 1.04 / failing 2 / measurable true) |
| F2 local `background` | `null` on the audit fixture; global unchanged |
| F2 noise vs text partition | 291px/1comp/1.06 -> noise; 2174px/20comp/1.04 -> text |
| F4 mid-tone run | reported as its own colour (7 components), `all_meet_aa: false` |
| F4 flat control | 2 colours in **both** modes |
| §1 flat/local equivalence | byte-identical; `effective_ink_threshold: 4` |
| §1 acceptance numbers | 5 colours / worst 1.04 / best 13.42 / failing 2 |
| live MCP (new code, port 11498) | F1 agree YES, F2 null YES, F4 2/2 YES |
| non-vacuity | 9 + 11 + 7 + **5 (round 3)** all non-vacuous |

## 5e. Fourth audit: multi-panel backgrounds and the adequacy gate

A fourth independent audit found the worst kind of defect yet: on a two-panel UI
the tool reported `all_meet_aa: true` while a sidebar string at **1.64:1** was
present and visible. This section records the mechanism, the fix, and the
non-regression that protects the earlier rounds.

### The defect (F5)

Fixture: 900x420, a dark sidebar (30%, `#161616`) and a bright content panel
(70%, `#d2d2d2`), with `#3c3c3c` text on the sidebar (1.64:1, **fails AA**).

Reproduced exactly as reported: `colour_count: 1`, `failing_count: 0`,
`all_meet_aa: true`, and `#3c3c3c` absent from **every** channel — not in
`colours`, `merged_anti_aliasing`, `excluded`, `skipped`, `suspected_noise` or
`notes`. A crop of the sidebar alone found it at 1.64:1 with 14 components, so it
is real, text-like, and merely invisible at full frame.

**Mechanism (confirmed, not hypothesised).** Two effects compounded:

1. **Panel-as-ink.** The ink mask uses ONE background. The whole dark sidebar
   differs from the modal `#d2d2d2`, so all ~113k sidebar pixels became "ink" —
   one connected region, box `{0,0,270,420}`, `fill_ratio: 1.0`. A component's
   colour is its most extreme pixel, so that blob's "colour" was the panel FILL
   `#161616`. The sidebar text lived *inside* that blob and was absorbed.
2. **AA fold of real text.** Content text `#282828` (on the bright panel, 11
   components) is collinear on the segment 210→22, so it folded into `#161616`
   as an "anti-aliasing shade".

The audit's adequacy hypothesis was also right: `explained_fraction` was **0.693**
because 70% of the image *is* one flat colour. `adequate: frac >= 0.5` can never
fault a UI whose modal panel is large — which is almost every UI.

### The fix: multi-plateau background modelling

*This was the audit's recommendation 1, implemented as recommended, not as an
approximation.*

`detectPlateaus()` finds large flat colour regions (panels, cards, page fill).
When **two or more** are present, the enumeration switches to a multi-plateau
model:

- a pixel is background if it is within `ink_threshold` of **any** plateau, so a
  panel is no longer ink;
- each text colour is measured against the **surrounding fill** it sits on (a
  small ring of non-ink pixels around the component), not the modal colour and
  not merely its nearest colour — this is what makes `#282828` measure 9.75:1
  against `#d2d2d2` instead of 1.23:1 against the far dark panel;
- every colour reports `measured_against`, and panel fills are moved to
  `panel_fills[]` and disclosed in `notes`;
- `background_model: "multi-plateau"` and `plateaus[]` (with share, largest
  component, flatness, dominance) are reported, and the region is disclosed as
  multi-plateau **even though the single-colour fit is ~0.69** — closing the
  adequacy gap the audit identified.

**A plateau must pass four measured tests** — each was calibrated against
fixtures, and each is separately pinned by a non-vacuity case:

| test | real panel | rejects |
|---|---|---|
| largest connected region ≥ 2% of area | 69–29% | small swatches/AA |
| **dominance** ≥ 0.5 (largest blob / colour's pixels) | 0.78–1.0 | text in a tight crop (glyph strokes are many blobs) |
| **flatness** ≥ 0.85 (one exact colour / region) | 0.99+ | a smooth gradient band (~0.10–0.18) |
| connectivity (flood fill) | one blob | scattered specks |

Two of these were **necessary and found by measurement, not assumed**: a thick
38px glyph stroke is a big solid blob (so an early version mistook text for a
panel and deleted it — caught by the existing tight-region test), and a smooth
gradient's quantised bands are genuinely flat (flatness 1.0 at zero noise), so
`0.85` — sitting in the measured gap between 0.18 and 0.99 — is what stops a
gradient becoming a panel.

### §3.1 — `local_background` is now actually delivered

The round-3 note promised that "each colour carries `local_background`", but it
only existed on the internal `components[]`. Every returned `colours[]` entry now
carries `local_background` **and** `measured_against`.

### §3.2 — structural, not contrast-dependent

The high-contrast sidebar variant (near-equal tones) previously returned
`colour_count: 1`. It is now correctly multi-plateau: the number of panels is a
**structural** finding and does not depend on whether any text on them is legible.

### Non-regression (this is the important part)

| fixture | plateaus | behaviour |
|---|---|---|
| acceptance fixture (one flat bg) | **1** | unchanged: 5 colours / 1.04 / 13.42 / 2 |
| flat fixture, local mode | 1 | byte-identical, `effT 4` |
| gradient/photo | **0** | falls back to the existing model; still warns |
| dense dashboard | 3 | still measures; no regression |
| bravo tight crop | 1 | still `#484f58 @ 2.14` |

With fewer than two plateaus the code takes the **original** path, so the whole
of §1-§5d is preserved by construction rather than by re-tuning.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **61/61** (was 54; +7 round-4 tests) |
| F5 sidebar text, global **and** local | reported at 1.64:1, `all_meet_aa: false` |
| F5 content text | 9.75:1 against its OWN panel (`measured_against: #d2d2d2`) |
| F5 model/plateaus | `multi-plateau`, 2 plateaus, disclosed in `notes` |
| §3.1 | every colour carries `local_background` |
| §3.2 | high-contrast variant still 2 plateaus |
| §1 acceptance numbers | 5 colours / 1.04 / 13.42 / 2, boxes 4, decorative disclosed |
| flat/local equivalence | byte-identical, `effT 4` |
| gradient | 0 plateaus, falls back, warning intact |
| live MCP (new code, port 11498) | F5 fixed: YES in both modes |
| non-vacuity | 9 + 11 + 7 + 5 + **6 (round 4)** all non-vacuous |

## 5f. Fifth audit: the gradient residual must be visible to the caller

The fourth round disclosed a residual in `CHANGELOG.md`: a noise-free smooth
gradient can band into flat quantised plateaus. The fifth audit made a narrow and
correct objection — **the disclosure was in the changelog, not in the response**.
A caller sees only the JSON.

### The defect (F6)

Fixture: a shallow noiseless gradient (48→60 over 900px) with `#f0f0f0` text
(11.25:1) and `#8c8c8c` text (failing). Reproduced:

```json
"plateaus": [], "background_model": "global",
"colours": [ { "foreground": "#f0f0f0", "contrast_ratio": 11.25 } ],
"all_meet_aa": true, "notes": [],
"background_fit": { "explained_fraction": 0.542, "adequate": true }
```

`#8c8c8c` is absent, a crop finds it failing, and `background_mode: "local"`
returns it. So the tool had a working answer and did not say so.

**The gate is a knife-edge.** `adequate: frac >= 0.5` decides everything, and the
audit's fixture landed at 0.501 (silent) while a slightly steeper one landed at
0.419 (warned). The difference is not semantic — it is which side of a round
number the image fell on.

### What was measured before choosing a fix

Two candidate signals were tested and **rejected on evidence**:

- **Tile-modal spatial spread** (does the background ramp across tiles?):
  acceptance 0.0, two-panel 325.6, dense dashboard 21, shallow gradient 17.3. The
  shallow gradient does not separate from the two-panel layout, so it cannot be a
  lone gate.
- **Raising the adequacy floor.** Measured fit on legitimate flat UIs: text-heavy
  white page 0.904, card grid on grey 0.619, acceptance 0.962. A text-heavy flat
  UI sits at 0.619, so any threshold that catches a 0.542 gradient would also flag
  a perfectly flat page. **The floor was left at 0.5.**

A third signal — the local/global self-check — was tested and *nearly* over-claimed:
on a dense dashboard the two models disagree because local *over-reports* (the
known §5c behaviour). So it is used as a **detector**, and its wording explicitly
says local is **not** generally more accurate.

### The fix: never silent about a weak premise

1. **Marginal-fit disclosure.** Any single-colour fit below `GOOD_FIT_FRACTION`
   (0.8) is disclosed in `notes`, naming the gradient possibility and the `local`
   remedy — **even when the 0.5 floor calls it adequate**. This guarantees
   `notes` is non-empty for every weak premise and carries no threshold risk,
   because it only adds a note.
2. **Local arbitration on a clean verdict.** When the global verdict is about to
   be a clean pass (`all_meet_aa: true`), the same region is re-measured with the
   per-tile model. Any failing tone local finds is disclosed in a
   `model_disagreement` block and in `notes`. This is the guard that closes the
   stated invariant: *no response may read `all_meet_aa: true` with empty `notes`
   while a text run in scope fails contrast and an available mode returns it.*
   The note asks the caller to re-measure with a `region`.

### §3 — `background_fit` no longer contradicts its own note

In multi-plateau mode a note said `background_fit` "is not meaningful here" while
the value was still populated with `adequate: true`. It now carries
`applicable: false`, `adequate: null` (falsy, so it cannot be read as "fine") and
`not_applicable_reason`; `explained_fraction` is still reported for information.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **67/67** (was 61; +6 round-5 tests) |
| F6 global | `fit 0.542`, `adequate true`, **notes non-empty**, `model_disagreement` names `#8c8c8c` |
| F6 local | 2 colours, `#8c8c8c` failing |
| F6 crop | finds `#8c8c8c` failing in isolation |
| steep / moderate gradients | `adequate: false`, warning present (floor unchanged) |
| §3 multi-plateau | `applicable: false`, `adequate: null`, reason present |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2, `applicable: true`, no marginal note, no disagreement |
| flat/local equivalence | byte-identical, `effT 4` |
| legitimate flat UIs | text-heavy page (0.904) not flagged marginal; card grid (0.619) flagged marginal but no false disagreement |
| live MCP (new code, 11498) | F6 not silent: YES; caveat reaches structured prose: YES |
| non-vacuity | 9 + 11 + 7 + 5 + 6 + **3 (round 5)** all non-vacuous |

### Cost and residual

The self-check runs one extra enumeration **only when the global verdict is a
clean pass**. Measured: acceptance 76ms, dense dashboard 579ms, full-HD flat
813ms — all model-free and sub-second.

The underlying residual is unchanged and now **disclosed in the response rather
than only the changelog**: a noise-free synthetic gradient still bands, and the
global model can still miss a tone on it. What has changed is that the caller is
told, and given the mode that resolves it.

## 5g. Sixth audit: tiled layouts reported the page background as failing text

The fifth round guarded against a **silent pass**. This round guards the other
direction: a **spurious fail**. Both are needed for a verdict to be trustworthy.

### The defect (F7)

Fixture: a 4×3 grid of identical cards on a page background, with ALL text one
high-contrast colour (`#e8dfd0` at 11.05:1 on the card, 13.42:1 on the page).
Reproduced in both themes and both modes:

```json
"colours": [
  { "foreground": "#1a1814", "contrast_ratio": 1.21, "pixel_count": 316548, "component_count": 1, "wcag_aa": false },
  { "foreground": "#e8dfd0", "contrast_ratio": 11.05, "wcag_aa": true }
],
"failing_count": 1, "all_meet_aa": false,
"plateaus": [ { "hex": "#1a1814", "share": 0.377 } ]
```

`#1a1814` is the **page background** — one connected region around the cards. The
tool asserted a contrast failure on something that is not text, which is the same
"asserting something no user could see on screen" defect `suspected_noise` was
built to remove, resurfacing through a different door.

### The structural cause

Two guards discriminate text from panel by **blob count**, and a tiled layout has
the same signature as a glyph run — many small identical blobs:

- `detectPlateaus` required `dominance ≥ 0.5` (one blob holding most of the
  colour). Twelve separate cards give dominance ≈ 0.08, so the **card fill was
  rejected as a plateau**;
- with only the page background in `plateaus`, `multiPlateau` never engaged, so
  the round-4 protection that fixed F5 did not apply;
- `partitionSuspectedNoise` would have caught it, but it is gated to `local` mode.

So the page background became one 316k-pixel ink component and was reported as a
colour.

### The fix: a tiling path, plus two backstops

**1. A second plateau path (structural).** `detectPlateaus` now recognises a
colour as a panel under **either**:

| path | shape | evidence |
|---|---|---|
| **dominant-blob** (existing) | one big connected region holding most of the colour | page background, full-width panel |
| **tiled** (new) | ≥ 2 blobs that are **panel-sized** (≥ 0.4% of the region) and **near-solid** (fill ≥ 0.85), of **similar size** (CV ≤ 0.5) | repeated cards, mosaics |

Both keep the flatness requirement, so a gradient band is still rejected. Text
fails the tiled path because its blobs are tiny (a glyph stroke is ~0.01% of the
region) or hollow/thin (fill ≤ 0.60 measured). With the card fill recognised,
`plateaus` contains both fills, multi-plateau engages, and the page background is
never ink — the F7 case is fixed in **both** modes by construction.

**2. Straight-segment rejection (a regression this round found and fixed).** The
tiling path exposed a latent false positive: the dense dashboard's card
**borders** (`321×3`, fill 0.66) were reported as failing text, because the
existing hollow-rectangle test requires a 2-D box (`boxH ≥ 60`) and misses a
1-D stroke. A component that is long and thin in one axis (≥ 60px long, ≤ 4px
across) is now treated as decorative chrome — a rule, divider or border — not a
glyph. Measured: borders are 1–3px thick, glyph strokes are 19px.

**3. A large-background-region backstop.** For shapes the plateau model cannot
reach (a page background that is *textured* rather than flat, so it fails
flatness), a near-background cluster whose blobs are individually large is moved
to `background_regions` and disclosed. Measured margin: real text averages at
most **0.10%** of the region per blob; a page background is **37.7%** — a 360×
separation, so this cannot drop a text run.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **73/73** (was 67; +6 round-6 tests) |
| F7 dark 4×3, global + local | page bg not a text colour; `all_meet_aa: true`; 1 colour |
| F7 light 4×3 | same (not polarity-specific) |
| controls (3-in-a-row, 1 big card) | clean |
| dense dashboard | `failing_count 0` — borders no longer misreported; the real `#7ee787` text still reported |
| textured page | caught by `background_regions` + note; `all_meet_aa: true` |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2 |
| F5 two-panel | sidebar `#3c3c3c` still 1.64:1 failing |
| F6 gradient | marginal note + `model_disagreement` still present |
| live MCP (new code, 11498) | F7 fixed: YES in both modes |
| non-vacuity | 9 + 11 + 7 + 5 + 6 + 3 + **4 (round 6)** all non-vacuous |

### The second invariant

Alongside "a clean verdict must never be silent", the server now enforces: **no
response may report `all_meet_aa: false` naming a colour that is a background
region rather than text.** A verdict is only trustworthy if it can fail in
neither direction.

### Residual (disclosed)

A page background that is textured (fails flatness) *and* fragmented by panels
into many blobs (defeating the region backstop) is not caught. That combination —
a non-flat page plus a card grid — is a shape constructed to defeat the guards
rather than one observed in practice; it is recorded here rather than papered
over.

## 5h. Seventh audit: a text colour accepted as a plateau and masked

The third edge of the same triangle. Round 5 stopped a **silent pass**, round 6
stopped a **spurious fail**; this round stops a **text colour being reclassified
as background and then going unreported**.

### The defect (F8)

Fixture: two huge **identical** glyphs ("OO" at 300px bold) in one colour that
fails contrast (`#464646` at **1.88:1**). Reproduced exactly, in both renderings:

| rendering | result |
|---|---|
| with anti-aliasing | `plateaus: [#1a1814 84.6%, #464646 15.1%]` — the **text colour is a plateau**; `colours` holds only AA remnants (`#252320` 1.66, `#424141` 1.74) |
| hard-edged (posterised to 2 colours) | `colours: []`, `measurable: false`, `all_meet_aa: null`, and a note asserting *"No text was found there"* about a region that is **entirely text** |

The second form is a **true false negative**: the failing text is not merely
missed, the response states there is no text at all.

### The attribution — corrected by measurement

The audit attributed this to the tiling path it recommended. **That is not what
happened**, and the distinction matters for where the fix belongs. Instrumenting
the plateau record showed:

```
#464646  share=0.1505  detection=dominant-blob  dominance=0.5  solid_component_count=0
```

The colour was accepted by the **pre-existing dominant-blob path** (round 4), not
by the tiling path. Two *identical* glyphs give `dominance = largest blob / colour
pixels = 0.5` exactly — the threshold — and the ring's fill is **0.556**, below
the tiling path's `PLATEAU_SOLID_FILL` (0.85), so the tiling path **never fired**.
So F8 is a boundary weakness that predates the tiling round; the tiling round
simply gave the audit a reason to look at large glyphs. (Round 6's own
counter-finding — the card-border false positive — *was* introduced by the tiling
path and was fixed there.)

### The fix: a plateau blob must be the outermost colour or a solid panel

Measured blob geometry separated the cases cleanly:

| colour | blob fill | touches region border? | is a panel? |
|---|---|---|---|
| **glyph ring `#464646`** (F8) | **0.556** | no (inset) | **no** — a glyph |
| card fill (F7, dashboard) | 0.96–0.99 | no | yes |
| two-panel page / panel | 0.96–0.99 | yes | yes |
| acceptance background | 0.75 | yes (whole region) | yes |
| dense dashboard background | 0.20 | yes | yes |

The physical distinction: the **outermost colour is the background with
everything else cut out of it**, so its fill is low by nature and must be allowed
to be hollow — otherwise every page background would be rejected. An **inset**
blob, by contrast, is only a panel if it is near-solid; an inset *hollow* blob is a
glyph ring. The dominant-blob path therefore now requires
`touchesBorder || fill >= PLATEAU_SOLID_FILL`.

This is a **shape** test, not a threshold tune, so it composes with the existing
paths: the tiling path keeps its solidity requirement (a tiling is solid by
definition), and the outer background keeps qualifying through `touchesBorder`.

### Consistency of `plateaus_without_text`

The disclosure added in round 4 can now never assert something false: because the
text colour is no longer a plateau, it cannot be listed as a plateau "without
text". This is asserted directly, and the assertion fails if the shape guard is
removed (see non-vacuity below).

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **78/78** (was 73; +5 round-7 tests) |
| F8a (AA) | `#464646` reported at **1.88:1 failing**; `plateaus: [#1a1814]` only |
| F8b (hard-edged) | `measurable: true`, `failing_count: 1`, `all_meet_aa: false`, no "no text" note |
| F8 controls (`GO`@150, words@64, `HEADING`+`OO`, `OOO`×2, `WWWWWW…`, `MM` tiled) | all reported |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2; decorative border still `excluded`, not a plateau |
| F5 two-panel | sidebar `#3c3c3c` still 1.64:1 failing; both panel colours still plateaus (fill 0.96–0.99) |
| F6 gradient | marginal note + `model_disagreement` still present |
| F7 tiled (dark + light) | still `all_meet_aa: true`, only `#e8dfd0`, `plateaus_without_text` disclosed |
| dense dashboard | 3 plateaus, `failing_count 0` (borders still excluded) |
| live MCP (new code, 11498) | F8 fixed: YES in both renderings |
| non-vacuity | 9 + 11 + 7 + 5 + 5 + 3 + 4 + **3 (round 7)** all non-vacuous |

### The third invariant

A verdict is now constrained on all three edges: **a clean result is never
silent**, **a failure is never attributed to a background region**, and **a text
colour is never reclassified as a background region and then unreported**.

## 5i. Eighth audit: an inset content-dense panel hid a failing text colour

The third invariant (round 7) leaked through the `panelShape` gate that round 7
added. This is the same class as the original F4/F5 false negatives, re-entering
one layer in: the tool reported `all_meet_aa: true` on an image whose card text is
at 2.47:1.

### The defect (F10)

Fixture: a dark inset card on a light page, the card perforated by 64 light bars,
with `#666460` text on the card. Reproduced exactly:

```json
"plateaus": [ { "#f0efec", 21.8% }, { "#ebe6dc", 24.8% } ],
"colours": [ { "foreground": "#2d2822", "contrast_ratio": 11.74, "wcag_aa": true } ],
"failing_count": 0, "all_meet_aa": true
```

The card's own fill is **not** a plateau; the reported "colour" is the card fill
measured against the **bars** at 11.74:1; and the real text `#666460` at
**2.47:1** is absent from every channel. A crop of the header finds it — so it is
real and detectable, and disappears only at full-frame.

**Cause.** Round 7's shape test was `touchesBorder || fill >= 0.85`. Dense content
perforates the card, dropping its fill below 0.85, so the card stopped being a
plateau; its fill then became ink, and its representative colour resolved against
the light bars (passing), absorbing the text. **`fill` conflates "is a ring" with
"is perforated"** — a glyph ring is hollow for one reason (a single aperture), a
content-dense panel for a completely different one (many small holes).

The audit's border-touching control isolates it: identical content density, only
`touchesBorder` differing, and the result flips from wrong to right.

### The fix: measure the SHAPE of the holes, not the fill

Measured, per blob, the **largest enclosed aperture as a fraction of its bbox**:

| case | fill | holes | largest hole / bbox |
|---|---|---|---|
| **glyph ring** (F8) | 0.56 | 1 | **0.253–0.257** |
| **perforated card** (F10) | 0.67 | 80 | **0.008** |
| solid card / page / panel / dense background | 0.20–0.99 | — | 0.001–0.033 |

A ring has **one large aperture**; a perforated panel has **many small ones**. So
the inset test became `largestHoleFrac >= 0.12` (measured gap: rings ≥ 0.25,
panels ≤ 0.033) instead of `fill >= 0.85`. The outermost-colour exemption
(`touchesBorder`) is retained and is now *required*: a page frame's largest "hole"
is the card inside it (measured 0.669), so it must qualify by touching the border,
not by hole shape.

**The dominance floor was raised to 0.6** (was 0.5), from a measured gap: two
identical glyphs give dominance 0.50–0.505, while every real panel is ≥ 0.78. This
is not required for the *verdict* (the ring test already rejects rings) but for the
*colour*: at 0.5 a glyph pair is accepted as a plateau and only an AA remnant
survives, so the reported failing colour is not the one the user can see.

### The guarantee: mask reconciliation (the audit's fix 3)

The shape tests decide each case, but a **solid** glyph block (fill 1.0, dominance
1.0, no holes, inset) is, by geometry alone, indistinguishable from a solid inset
panel. Rather than pretend otherwise, the mask is now **reconciled**: when masking
occurred, the region is re-enumerated with no plateau mask, and any failing colour
that the masked run dropped is disclosed in `mask_reconciliation` and in `notes`.

This is disclosure, not refusal — the same shape as round 5's global-vs-local
arbitration — so it cannot turn a correct verdict into a wrong one. The audit's
*refusal* variant was correctly rejected: it would regress F5, because the
two-panel's dark page legitimately appears as ink in the un-masked run.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **84/84** (was 78; +6 round-8 tests) |
| F10 inset dense, global + local | card fill is a plateau; `#666460` reported at **2.47:1 failing**; `all_meet_aa: false` |
| F10 header crop | unchanged (failing 1) |
| F10 controls (border-touching dense, inset sparse, clean) | all correct |
| solid-block glyphs | **never** `all_meet_aa: true`; disclosed via `mask_reconciliation` |
| F8 (OO, hard-edged, and the whole glyph family) | still report `#464646` 1.88:1 |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2; no reconciliation |
| F5 two-panel | sidebar 1.64:1 failing; no reconciliation |
| F7 tiled (dark + light) | `all_meet_aa: true`, only `#e8dfd0` |
| live MCP (new code, 11498) | F10 fixed: YES; clean variant still passes |
| non-vacuity | 9+11+7+5+4+3+4+3+**3 (round 8)** all non-vacuous |

### Residual (disclosed, not hidden)

Two shapes remain genuinely ambiguous and are **disclosed rather than decided**:

- a **single huge glyph ring** that is large enough to touch the region border
  (its `touchesBorder` exemption lets it pass the inset test);
- a run of **solid** glyph blocks that merge into one blob (no hole to measure).

Both now carry `mask_reconciliation` naming the failing colour, and neither can
report `all_meet_aa: true` while dropping it. The first is pathological; the second
is the input the audit classed as narrow.

## 5j. Ninth audit: the reconciliation fired on decoration

Round 8 added `mask_reconciliation` to cover the shapes the geometry cannot decide.
It worked — but it fired on **decorative chart bars** and told the caller that a
*correct* verdict was unverified. A disclosure that cries wolf on ordinary
dashboards is worth less than one that is quiet and correct. This round makes it
precise; that is the marginal value now that the classification terms are settled.

### The defect (F11)

A light page, a dark inset card, 64 decorative red bars, and text at **7.15:1**.
Every text colour passes, so the verdict is a clean pass — yet:

```json
"all_meet_aa": true,
"colours": [ { "foreground": "#b9b5ae", "contrast_ratio": 7.15, "wcag_aa": true } ],
"mask_reconciliation": {
  "unmasked_failing_colours": [ { "foreground": "#783c3c", "contrast_ratio": 1.75, "component_count": 64 } ]
}
```

`#783c3c` is the **bar colour**. The mechanism: the bars are themselves a *tiled
panel colour*, so the un-masked pass re-reads them as text and the (correct) verdict
was labelled unverified.

### The gate — and why the intuitive version is wrong

Measured, per dropped colour:

| case | expectation | blobs | mean blob / region |
|---|---|---|---|
| decorative bars | **must not fire** | 64 | 0.004 |
| decorative icon grid | **must not fire** | 24 | 0.012 |
| decorative stripe row | **must not fire** | 12 | 0.010 |
| **panel-shaped dropped colour** | **must fire** | 1 | **0.256** |
| ordinary text | not a single run | many | ≪ 0.004 |

The gate is therefore `mean blob area ≥ 2% of the region` — the shape that is
genuinely ambiguous: *one large region: a panel, or very large text?* Decorative
repeats and ordinary text are many blobs and cannot be a single text run.

**This is the opposite of the intuitive reading.** The audit suggested gating on
"text-shaped: few components **and small** mean area". That would have excluded the
very case the disclosure exists for — the ambiguous region is a *large* blob, not a
small one — and so reintroduced a silent false negative. The measurement was what
distinguished the two; the reasoning alone would have got it wrong.

**Wording** was softened too: the note now says the removed region could be *a panel
or very large text* and asks for a `region` re-measure, rather than declaring the
verdict "unverified".

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **89/89** (was 84; +5 round-9 tests) |
| F11 decorative bars (both fixtures) | `all_meet_aa: true`, `mask_reconciliation: null` |
| panel-shaped dropped colour | **still disclosed** (`#1a1814` 1.88), `all_meet_aa: null` |
| solid-block glyphs | still never `all_meet_aa: true` |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2 |
| two-panel / F7 / F8 / F10 / dashboard | all unchanged |
| live MCP (new code, 11498) | F11 fixed: YES; panel-shaped case still discloses: YES |
| non-vacuity | 9+11+7+5+4+3+4+3+3+**3 (round 9)** all non-vacuous |

## 5k. The §3 accent block: measured, and DECLINED

The ninth audit also observed that a small **solid decorative accent block**
(`#3c5a3c`, 1.89:1) is reported as a failing *text* colour. It is pre-existing,
conservative in direction, and **not fixed** — for a measured reason rather than a
judgement call:

| shape | largest blob | fill |
|---|---|---|
| **accent block** (chrome, reported) | 3000 px (0.357% of region) | **1.000** |
| **bold "I" at 150px** (real text, must stay reported) | 3052 px (0.363%) | **1.000** |

The two are indistinguishable by blob size *and* by fill. Any rule that suppressed
the accent would also suppress real solid text — a false negative, which is the
class of failure this whole effort exists to eliminate. Trading a conservative false
positive for a false negative is the wrong direction, so the accent stays reported
and is documented here.

A safer route exists (require *multiple* similar solid blocks **and** a
non-extremal position, i.e. not `touchesBorder`), and the accent does form four
identical blocks — but it is a new classification term, and this round's lesson is
that new terms create boundary defects. It is left as a documented observation
rather than an unmeasured ninth term.

## 5l. Tenth audit: the disclosure gate was narrower than the masking floor

> **RETRACTED (eleventh audit).** The fix below **did not** deliver the guarantee
> it claimed. It reused the *name* `PLATEAU_MIN_BLOB_SHARE` but compared a **mean**
> across blobs, whereas the mask's path-A floor is a **single blob's** share
> (`PLATEAU_MIN_SHARE`). A mean falls below the floor as the blob count grows, so a
> colour masked by one ≥ 2% blob with many small companions was still masked and
> undisclosed (F13). Section §5m records the correction. The text is left in place,
> marked, so the mistake is auditable rather than erased.

Round 9 made the disclosure precise by requiring a dropped colour to be
panel-shaped — mean blob ≥ 2% of the region. But the **masking** floor is 0.4%
(the tiling path masks any blob ≥ `PLATEAU_MIN_BLOB_SHARE`). Two independently
chosen constants, 5× apart, so any colour whose blobs fell between them was
**masked and never disclosed**.

### The defect (F12)

Region 1000×700, two large solid bold "II" runs in a failing colour (1.88:1):

| glyph size | behaviour (pre-fix) |
|---|---|
| 150 px | not masked — reported normally |
| **200 px** | **masked, `colours: []`, `measurable: false`, `mask_reconciliation: null`** |
| **300 px** | **masked and silent** |
| 420 px | masked, but the 2% gate fired |

Cropping the *same image* always fired, so the full frame was less informative
than a crop — a caller cannot predict that.

### The fix: one shared constant, not two

The gate now reuses the mask's own constant:

```js
isDisclosableDroppedColour(colour, regionArea) → mean blob / regionArea >= PLATEAU_MIN_BLOB_SHARE
```

Because a masked region's blobs clear that floor **by construction**, the
disclosure trigger can no longer be stricter than the mask — which is the
structural guarantee the audit asked for: *anything the mask removes is eligible
for disclosure; shape decides the wording, not whether to mention it.* The wording
now labels each entry `panel-shaped` or `text-sized`.

**Why the mean, and not the alternatives.** Five candidate discriminators were
measured and **rejected** before this one (all recorded so they are not retried):

| candidate | measured failure |
|---|---|
| component-count ceiling | a 17-`I` headline exceeded it and went silent |
| blob aspect (elongation) | decorative icon grids and swatches are square (1.0), overlapping glyphs |
| size-variance (CV) | real varied text (`"Illi"`) measured 0.44 — inside the decoration range |
| plateau `detection` type | F12's colour is `tiled`, exactly like the decorative bars |
| removal mechanism | both F11 and F12 are removed by the same tiling path |

The mean works because a chart's bars **vary in height**, dragging the mean below
the per-blob floor (0.0036 < 0.004), while a text run of one size clears it (the
F12 band measures 0.005–0.018).

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **93/93** (was 89; +4 round-10 tests) |
| F12 at 150/200/300/420 px | colour **surfaced** in every case; never `all_meet_aa: true` |
| crop control | still fires |
| F11 decorative bars (both fixtures) | still `all_meet_aa: true`, `mask_reconciliation: null` |
| panel-shaped dropped colour | still disclosed, now labelled `panel-shaped` |
| 17-blob headline (the count-ceiling case) | now disclosed |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2 |
| two-panel / F7 / F8 / F10 / dashboard | unchanged |
| live MCP (new code, 11498) | F12 fixed at every size; F11 still quiet |
| non-vacuity | 9+11+7+5+4+3+4+3+3+3+**3 (round 10)** all non-vacuous |

### The invariant now holds structurally

> **THIS SECTION IS FALSE — RETRACTED (eleventh audit).** The trigger and the
> masking floor were **not** the same number: clause `PLATEAU_MIN_SHARE = 0.02` is a
> single blob's share, `PLATEAU_MIN_BLOB_SHARE = 0.004` is a mean. The relationship
> asserted below holds only for the tiling (path-B) case where every blob clears the
> per-blob floor; it does **not** hold for a path-A mask of a dominant 2% blob
> accompanied by smaller blobs. See §5m for the corrected formulation.

The disclosure trigger and the masking floor are **the same number**, so they
cannot drift apart. This is the first round whose fix is a *relationship between
constants* rather than a new threshold — which is what the ninth and tenth audits
both argued was the missing piece.

## 5m. Eleventh audit: the round-10 guarantee was false — a correct UNION

### What was wrong

Round 10 asserted a *structural guarantee*: because the gate reused
`PLATEAU_MIN_BLOB_SHARE`, "anything the mask removes is eligible for disclosure".
The audit showed this was a **substitution of names, not of semantics**. The two
constants measure different quantities and the gate was still narrower than one of
the mask's two acceptance tests.

### The arithmetic (the audit's §2, reproduced independently)

Region = 1000 × 700 = 700,000 px.

- **Path A masks** when a **single blob** holds ≥ `PLATEAU_MIN_SHARE` = **2%** of the
  region (≥ 14,000 px).
- The **round-10 gate disclosed** when the **mean** blob held ≥
  `PLATEAU_MIN_BLOB_SHARE` = **0.4%** (≥ 2,800 px).
- Since `mean = total / N`, a colour can have `largest ≥ 14,000` **and**
  `mean < 2,800` whenever `N > largest / 2,800`. Both are trivially reachable: a
  14,000 px blob plus 10 tiny companions gives `mean = 1,356 = 0.19% < 0.4%`.

So the round-10 predicate returned `false` — a **silent** omission — for exactly the
shape the reconciliation exists to catch. This was **not** disputable; the gate was
measured to hide a 2.1%-blob colour.

### Measured reproducer

| fixture | want | N | largest/region | mean/region | round-10 gate | union |
|---|---|---|---|---|---|---|
| F13(a) drop-cap `I` + `settings` | disclose | 10 | **2.10%** | 0.29% | **false → silent** | **true** |
| F13(b) panel 200×80 + 10 fragments | disclose | 11 | **2.29%** | 0.26% | **false → silent** | **true** |
| F11 decorative bars | quiet | 64 | 0.59% | 0.36% | false → quiet ✓ | **false → quiet** |
| F12 `II`@200/300/420 | disclose | 4 | 0.77–3.41% | 0.80–2.82% | true | **true** |
| solid_blocks (two big rects) | disclose | 1 | 25.6% | 25.6% | true | **true** |

F13(a) reported `colours: [#40403f, #201e1a]` (AA remnants only) and
`mask_reconciliation: null`; F13(b) reported `colours: []`, `measurable: false`,
`mask_reconciliation: null`. In both, the failing `#464646` was present in every
channel's **absence** — removed by the mask, named nowhere.

### The fix: a UNION of the mask's two acceptance tests

```js
isDisclosableDroppedColour(colour, regionArea, largestShare) →
  largestShare >= PLATEAU_MIN_SHARE            // clause 1: path-A test, per colour
  || mean / regionArea >= PLATEAU_MIN_BLOB_SHARE   // clause 2: path-B per-blob floor
```

- **Clause 1 is TRUE BY CONSTRUCTION for a path-A mask.** Path A accepts a colour
  only when its largest blob holds ≥ 2% of the region, so any path-A-masked colour
  clears clause 1 and is always disclosed. The mask's *own* acceptance test is
  applied per colour rather than a lookalike statistic — this is what closes F13
  structurally.
- **Clause 2 keeps the tiled (path-B) case disclosed.** A tiling accepts only blobs
  that clear the per-blob floor, so a colour whose blobs are all solid has
  `mean ≥ 0.4%` and is disclosed (F12). It is **not** a guarantee for a path-B mask
  with mixed blob sizes — see the residual gap below.

Each disclosure entry now also carries `largest_component_share` and
`detected_plateau`, so the caller can see that the colour was itself read as a
plateau rather than dropped as an anti-aliasing remnant.

### Which formulation, and is it a guarantee?

- **Guarantee (true by construction):** a colour removed by a **path-A**
  (dominant-blob) mask is always disclosed. This is the F13 seam and it is closed
  structurally, not by a margin.
- **Heuristic with a documented seam:** the union as a whole. A colour removed by a
  **path-B** mask that mixes `≥ 2` solid blobs with smaller **sub-floor** blobs can
  have both `mean < 0.4%` and `largestShare < 2%`, and is then masked and
  undisclosed. That signature is a varying-size tiled block — a bar chart / icon
  grid (the F11 decoration, which must stay quiet) — but it is **irreducibly
  ambiguous**, because a headline of two huge glyphs plus many small failing ones
  has the same shape. No per-statistic rule can separate them (measured below).

This is stated plainly rather than dressed as a proof: **the previous claim was
made on a substitution of names rather than of semantics, and that is the thing not
to repeat.**

### Measured and REJECTED discriminators (round 11 — do not retry)

Building the union, these were measured against the full population and failed:

| candidate | measured failure |
|---|---|
| mean only (round 10) | F13(a) 0.29%, F13(b) 0.26% both **below** F11's 0.36% → cannot separate |
| largest-blob only (2%) | F12@200 largest 0.77%, F12@300 1.74% → silences the F12 band |
| dominance (largest/total) | F11 0.026 vs F12 0.25 **but** long uniform text runs measure 0.06 → a count ceiling in disguise |
| component count | already rejected in round 9 (a 17-`I` headline) |
| blob aspect / thinness | F11's 11-px bars measure thin, but a 1-px stroke glyph is equally thin |
| "was it a detected plateau" | true for F11, F12, F13 alike — no separation |

The **union of clauses 1 and 2** is the only formulation that (a) is true by
construction for the F13 shape and (b) keeps the F12 band and F11 quiet.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **99/99** (was 93; +6 round-11 tests) |
| F13(a) drop-cap | `#464646` disclosed, `largest_component_share` 2.10%, `detected_plateau: true` |
| F13(b) panel + fragments | `colours: []` but **disclosed** — the empty-result case is no longer silent |
| F12 150/200/300/420 px | still surfaced; never `all_meet_aa: true` |
| F11 decorative bars (both) | still `all_meet_aa: true`, `mask_reconciliation: null` |
| solid_blocks | still disclosed, labelled `panel-shaped` |
| §1 acceptance | unchanged: 1 plateau, 5 colours, 1.04 / 13.42, failing 2 |
| two-panel / F7 / F8 / F10 / dashboard | unchanged |
| live MCP (new code, 11498) | §12: F13(a)/(b) disclosed, F11 keep-green — **0 regressions** |
| non-vacuity | 61 guards, all non-vacuous (+6 round 11) |

### Stale anchors repaired

This refactor moved the gate into a filter closure, breaking the literal anchors in
**two** earlier harnesses. Both were **silent** — a missing anchor is only reported,
never failing the run — so round 4's guard had been unreported and round 9's
repointed:

- `verify/nonvacuity-round4.mjs` — "dominance test rejects text-as-plateau": its
  anchor had gone stale when `panelShape` was appended to `pathA` in round 8.
- `verify/nonvacuity-round9.mjs` — "reconciliation is gated (decoration excluded)".
- `verify/nonvacuity-round10.mjs` — both F12 anchors.

### A framing correction (twelfth audit)

This section called the remaining seam **"irreducibly ambiguous"**. The twelfth audit
falsified that: the seam has a **direction** (see §5n), so "ambiguous" — which implies
directionless — understated it. The retraction of round 10's guarantee stands; it is
not to be replaced by a framing that implies the residual is symmetric.

## 5n. Twelfth audit: the disclosure gate was ANTI-CORRELATED with the evidence

### What was wrong

The eleventh-audit union kept a mean clause (`mean >= PLATEAU_MIN_BLOB_SHARE`) as the
path-B channel. The audit showed that clause is not merely imprecise — it is
**inverted**: adding failing text of the *same colour* makes the warning **vanish**.

### The inversion (the audit's D/E reproduction, byte-matched)

Two 1000×700 panels, background `#1a1814`, all text `#464646` = **1.88:1, failing**.
Both have the identical 300px bold `II` heading. Panel **E** adds six 28px body lines
in the *same* colour.

| fixture | failing px | N | mean | largest | clause 1 | clause 2 | result |
|---|---|---|---|---|---|---|---|
| **D** `buildHeadingOnlyFixture` | 24,966 | 2 | **1.78%** | 1.74% | ✗ | ✓ | **FIRES** |
| **E** `buildHeadingPlusBodyFixture` | **44,226** | 164 | **0.04%** | 1.74% | ✗ | ✗ | **silent (bug)** |

The largest blob is **identical** in D and E (1.74%, below the 2% path-A floor), so the
mean is the only channel — and the mean collapses as `N` rises. In E, `#464646` is a
detected plateau at 4.9% and appears in **no** channel: not `colours`, not
`mask_reconciliation`, not `panel_fills`, not `excluded`.

### Why more text makes it worse (measured)

`mean = pixel_count / component_count`. As body text is added, both rise together, so
the mean is flat-or-falling. A sweep with the 300px bars fixed and only the small
glyphs resized:

```
small px | mean   | largest | recon (round 11)
      24 | 0.0009 |  0.0174 | null
      32 | 0.0005 |  0.0174 | null
      40 | 0.0006 |  0.0174 | null
      52 | 0.0009 |  0.0174 | null
```

**No amount of additional failing text can satisfy a mean floor.** The gate did not
have a boundary in the wrong place; it had the boundary *pointing the wrong way*.

### Single-property controls (so a fix cannot just invert the rule)

| control | role | result |
|---|---|---|
| `buildHeadingOnlyFixture` (D) | heading alone; largest 1.74% < 2%, so only the mean can fire | **FIRES** (mean 1.78%) |
| `buildHeadingPlusBodyFixture` (E) | same + body text; mean collapses | **disclosed** (was silent) |
| `buildResidualSolidTiledFixture` | 5 solid rects @0.446% (path B sums 2.26%) + 20 fragments, **no text** | **disclosed**; largest 0.45%, mean 0.11% |
| hero (200×80 button + dots) | blob mixture fails `dominance`/`panelShape` first | **`null`** — never masked, question never arises |
| `real_head_and_body` (150px "Heading" + body) | a *natural* heading is **not** solid enough for path B | surfaced in `colours` — the seam needs path B's solid-blob condition |

### The fix: remove the gate

`isDisclosableDroppedColour(colour, regionArea) → true`. The trigger *is* the mask's
own evidence (`unmasked.colours` minus `colours`), with no second opinion. This is the
only formulation true by construction. Three attempts to add a size gate each opened a
silent seam (F12, F13, F14), so the stable choice is no gate.

### Deliberate consequence and the trade

`mask_reconciliation` now **fires on decorative dashboards** — the ninth-audit **F11**
case. That reverses the ninth audit's precision choice, and it is intentional: the
disclosure is advisory and names its own uncertainty, whereas the F14 omission was
**silent**. Precision is recovered by wording: each entry carries `detected_plateau`
and `plateau_share` (read from the already-computed `plateaus` array), so a caller can
filter decoration. The **verdict** (`all_meet_aa`) is unchanged — F11 still reports
`all_meet_aa: true`.

> **AMENDED (thirteenth audit F15).** The original sentence here read "precision is
> *recovered* by wording", implying the wording **classifies** the disclosure. It does
> not, and the field that purported to (`shape`) was removed in round 13. The claim is
> downgraded from a capability to an offer: the tool reports raw evidence and does
> **not** resolve "decoration or text" for the caller. See §5o.

### What this audit has NOT proven

- No **natural** page was found where a *large solid* failing element and *small*
  failing text share one colour. The seam needs path B's solid-blob condition; a 150px
  "Heading" does **not** satisfy it (`real_head_and_body.png` surfaces `#464646`
  normally). The construct is a heading built from solid bars / blocky glyphs
  (numerals, `II`, logos) plus small text in the same colour.
- Lowering `PLATEAU_MIN_BLOB_SHARE` alone was **not** tested as a fix. `mean` is
  0.0004, so it would need to drop >10×, **likely silencing F11**. Not assumed to work
  — it is why the gate was removed instead.
- The **frequency** of the construct in real screenshots was not measured. The claim is
  **reachability and direction**, not prevalence.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **102/102** (was 99; +3 round-12 tests) |
| F14 D / E / solid-tiled | all **disclosed** — E no longer silent |
| F13(a)/(b) | still disclosed (no regression) |
| F12 band 150/200/300/420 | still surfaced |
| F11 decorative bars | **now disclosed** (deliberate); verdict still `all_meet_aa: true` |
| must-quiet set | acceptance, sidebar, dense_small_cards, hero, sentence/paragraph, F7 cards, textured page, cards-flat — **all `mask_reconciliation: null`** |
| live MCP (scratch 11498) | §13: D and E both disclosed; F11 fires by design |
| non-vacuity | 61 guards, all non-vacuous (3 new in round 12) |

### Stale anchors repaired (recurring cost)

Removing the predicate body broke literal anchors in **three** harnesses — all silent
(a missing anchor is reported, never a failure):

- `verify/nonvacuity-round9.mjs` — repointed to the new predicate, and the two F11
  guards now assert the **reversal** (they were "decoration stays quiet").
- `verify/nonvacuity-round10.mjs` — repointed; the obsolete "mean-clause" case was
  **removed** (no mean clause exists) and its coverage moved to the unconditional
  case + round 12.
- `verify/nonvacuity-round11.mjs` — repointed to the predicate body and the restored
  evidence fields.

## 5o. Thirteenth audit: `shape` was not a discriminator (the F14 defect, one layer up)

### What was wrong

The twelfth audit removed the *disclosure* gate but kept a `shape` label on each
entry — `"panel-shaped"` or `"text-sized"` — produced by
`isPanelShapedDroppedColour` = `mean / regionArea >= LARGE_REGION_AREA_FRACTION`, i.e.
`pixel_count / component_count / area`. That is **the same `mean = total / N`
construction** the twelfth audit (F14) identified as anti-correlated with the
evidence. F14 was fixed at the disclosure layer; the identical construction survived
at the wording layer.

### The inversion (measured, live 11402)

| fixture | comps | mean_component_area | `shape` (old) | what it is |
|---|---|---|---|---|
| A: 9 decorative bars (F11) | 9 | 7,676 | **`text-sized`** | chart bars, 11% of the region |
| B: failing heading + body | 164 | 270 | `text-sized` | real failing text |

Identical label. The bars occupy an order of magnitude more area per component yet
are called `text-sized` — the label is anti-correlated with "is this a panel".

### The fragmentation sweep (constant total area, only piece count varies)

~70,000px of failing colour in every row; only the number of pieces changes:

| bars | mean_area | mean/AREA | `shape` (old) |
|---|---|---|---|
| 2 | 34,980 | 0.0500 | panel-shaped |
| 3 | 23,340 | 0.0333 | panel-shaped |
| 4 | 17,520 | 0.0250 | panel-shaped |
| **6** | 11,640 | 0.0166 | **text-sized** — flips here |
| 9 | 7,800 | 0.0111 | text-sized |
| 12 | 5,820 | 0.0083 | text-sized |

Directly: `isPanelShapedDroppedColour({ pixel_count: 70000, component_count: 1 }, 700000)`
is `true` while `{ pixel_count: 70000, component_count: 12 }` is `false`. So `shape` was
a function of **fragmentation**, not of panel-ness.

### The fix: remove `shape`, do NOT substitute a threshold

`isPanelShapedDroppedColour` and the `shape` field are **deleted** (audit fix #2). The
audit's fix #1 — base `shape` on the largest connected component — was **measured and
does not work**, so it was not adopted:

| candidate | A (decoration) | B (text) | separates? |
|---|---|---|---|
| `mean_component_area / area` (old) | 0.0110 | 0.0004 | inverted |
| `largest_component_share` (fix #1) | **0.0185** | **0.0174** | **no (within 6%)** |
| `largest / total_failing` | 0.187 | 0.275 | no (both "no dominant piece") |
| `plateau_share` (total region share) | 0.0986 | 0.0489 | **appeared** to (see §5p — it does NOT; this pair was a coincidence) |

`largest_component_share` is itself `total / N` shaped, so it flips identically in the
sweep. Structurally, a 9-bar chart and a 164-glyph run are **the same kind of object**
— replicated elements with no dominant blob — so **no geometric scalar can name the
difference** without a threshold that will invert in turn. Substituting a new constant
would hand the next audit a fresh inversion, so none was added.

What a caller gets instead is the raw evidence already carried on each
entry: `component_count`, `mean_component_area`, `plateau_share`,
`largest_component_share`, `detected_plateau`, `pixel_count`, `contrast_ratio`,
`measured_against`. **None of these classifies decoration vs text** (fourteenth audit
F16 — see §5p).

### No false-positive flooding (audit controls, all `recon: null`)

| control | result |
|---|---|
| `fp_dashboard_muted` (cards, dividers, muted captions) | `recon: null` |
| `fp_decor_band` (separator band + 12 icon dots) | `recon: null` |
| `fp_shadow_card` (rounded card + soft drop shadow) | `recon: null` |
| `fp_icon_grid_fail` (16 icon tiles + failing headline/body, same colour) | FIRES, exactly 1 entry — correct |
| acceptance fixture / `sidebar` / `dense_small_cards` | all `recon: null` |

The removal of the gate looks safe on this population; the defect was the wording
field, not the disclosure rate.

### What this audit has NOT proven

- No *natural* screenshot was shown to produce the inversion. The fixtures are
  constructed; the claim is **reachability and direction** (more fragmentation ⇒ less
  "panel"), not frequency.
- Whether removing `shape` entirely and relying on `plateau_share` alone is
  **sufficient** for a caller to route was **not tested**. §5p then showed it is not
  even **correct** — `plateau_share` orders large from small, not decoration from
  text — so this is now moot for routing purposes.
- How many real dashboards flag more than one colour was **not measured**, so the
  "several extra round trips" consequence is reasoning from the mechanism, not a count.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **104/104** (was 102; +2 round-13 tests) |
| A/B pair | both disclosed, `shape` ABSENT from both, raw evidence present |
| fragmentation 4 vs 6 | both disclosed, no label, `component_count` differs |
| F14 D/E, F13(a)/(b), F12 band | unchanged (still disclosed) |
| must-quiet set | acceptance, sidebar, dense_small_cards, hero, F7/textured/cards-flat — all `mask_reconciliation: null` |
| live MCP (scratch 11498) | §14: `shape` absent, raw fields present |
| non-vacuity | all guards non-vacuous (+3 round 13); the "no scalar separates" test is deliberately NOT guarded (pure arithmetic, no source dependency — a revert anchor would be vacuous) |

### Stale anchors repaired

Deleting `shape` broke literal anchors in `verify/nonvacuity-round9.mjs` and
`-round10.mjs`; both obsolete cases were **removed** with documentation (their
coverage moved to round 13).

## 5p. Fourteenth audit: `plateau_share` does not classify either

### What was wrong

Round 13 removed the `shape` *label*. But the **prose** kept asserting the same
classification, in four places:

- **[REMOVED CLAIM]** `lib/measure.js` — *"`plateau_share` … orders decoration (a wide tiled region) from a glyph run."*
- **[REMOVED CLAIM]** `lib/measure.js` (function note) — *"the field that actually orders the pair"*
- **[REMOVED CLAIM]** `ACCURACY.md` §5o — *"`plateau_share` is the field that actually orders the pair"*
- **[REMOVED CLAIM]** `CHANGELOG.md` — *"invariant field that orders the pair (0.099 decoration vs 0.049 text)"*

This is the **third round in a row** with the same defect class — a scalar claimed to
separate two classes it cannot distinguish — and the claim had moved from a *threshold*
(F14) to a *label* (F15) to the *commentary*, where no test could fail it.

### The measurement (live 11402, region 0,0,1000,700, failing `#464646`)

| fixture | what it is | comps | `plateau_share` |
|---|---|---|---|
| `A_bars_reference` | 9 decorative chart bars | 9 | **0.0986** |
| `T_real_text_dense_II` | six 260px bold `IIIIII` runs — **real failing text** | 12 | **0.1561** |

**Real text scores HIGHER than the decoration.** `plateau_share` is
`colour_area / region_area` — a **coverage** measure. It orders *large from small*, not
decoration from text.

### The direction is the dangerous way round

A caller following the comment would read the **highest** `plateau_share` as "most
likely decoration" — and in the fixture above that value belongs to the **real failing
text**. The field is not merely uninformative here; its stated meaning **inverts** the
reading. The round-13 pair (0.099 bars vs 0.049 text) ordered that way by
**coincidence**, and I generalised from one sample.

### Independent corroboration of the structural argument (audit's `fill` measurement)

The audit computed `fill = area / bounding_box_area` per connected component in Python,
**outside the tool**, for the failing colour:

| fixture | comps | mean_fill | max_fill |
|---|---|---|---|
| decorative bars | 9 | 0.997 | 0.998 |
| real failing text (`IIIIII` @260px) | 12 | **1.000** | 1.000 |

Solid-stem glyphs (`I`, blocky numerals) are **pixel-identical to rectangles**, so
rectangularity cannot separate them either. This is a **stronger negative** than the two
scalars we each proposed: it shows the components themselves are the same shape. My round
13 conclusion — that a bar chart and a replicated glyph run are the *same kind of object*
— holds for a third measure.

### The fix: delete the claim, keep the fields, keep the honest note

1. All four sites now state the measurable truth: `plateau_share` is the plateau's
   **coverage**; it is fragmentation-invariant; it does **NOT** distinguish decoration
   from text, because a dense glyph run can exceed a bar chart.
2. `detected_plateau` is kept but re-described as **evidence, not a classifier**: real
   text is frequently read as a plateau (F13a `plateau_share` 0.021, F14/E 0.0489,
   `T_real_text_dense_II` 0.1561 all *are* detected plateaus).
3. The **runtime note was already honest** and is unchanged — it hedges ("usually
   backgrounds or decoration, but they could be text") and does not classify.
4. **No new scalar was added.** Three are now measured and rejected: mean component
   area, largest component share, component rectangularity (`fill`).

### What this audit has NOT proven

- No **natural** screenshot was shown where a caller would misread the field. The claim
  is that the assertion is **false and misdirecting**, not that it has already produced a
  wrong report.
- **No** geometric scalar over connected components was found that separates the pair.
  That is **not** a claim that none exists — only that three candidates fail, and that
  `fill` is the strongest negative because solid glyph stems and bars are pixel-identical.
- Whether a **colour-count** or **baseline-alignment** feature would separate them was
  **not measured**. Those are outside the per-component geometry the code already
  computes and would be new work — and by round 13/14's lesson, a new classification
  term is a design decision, not a patch.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **106/106** (was 104; +2 round-14 tests) |
| A/T pair | both disclosed, neither labelled by kind |
| prose guard | a test asserts **none** of `lib/measure.js` / `ACCURACY.md` / `CHANGELOG.md` / `README.md` carries an un-retracted claim that a field classifies the two kinds |
| must-quiet set | acceptance, sidebar, dense_small_cards, hero, `fp_*` — all `mask_reconciliation: null` |
| live MCP (scratch 11498) | §15: `plateau_share` present for both, no kind field, honest note |
| non-vacuity | all guards non-vacuous (+2 round 14) |

### The durable lesson (three rounds)

The defect is not any single scalar — it is **claiming a scalar separates two classes
that are geometrically the same**. F14 removed a threshold, F15 removed a label, F16
removed the claim from the prose. Each fix was correct and each left the claim alive one
layer out. The guard that finally closes the **literal** regression is a **prose
assertion in the test suite**.

> **AMENDED (fifteenth audit F17).** An earlier version of this sentence said the claim
> "cannot silently return". That overstates a regex guard — see §5q: it catches the
> literal wording, not arbitrary paraphrases. The honest claim is narrower.

## 5q. Fifteenth audit: the guard's scope claim exceeded its rule

### What was wrong

Round 14 called the prose guard *"durable"* and said *"the claim cannot silently
return"*. F14 removed a threshold, F15 a label, and round 14 closed the prose layer —
but the **guard's own description** then claimed more than the rule delivered. Measured
by re-running the exact round-14 regexes against paraphrases that assert the same false
thing:

| # | paraphrase (quoted example — NOT a claim of this document) | caught by the round-14 rule? |
|---|---|---|
| — | literal old wording | **YES** |
| P1 | [PARAPHRASE] "use `plateau_share` to **identify** decoration rather than real text." | no — verb not listed |
| P2 | [PARAPHRASE] "…**filter out chart furniture** instead of copy." | no — verb + synonyms |
| P3 | [PARAPHRASE] "…**tell what is** decoration and what is text." | no — no `from` construction |
| P4 | [PARAPHRASE] "…can reliably **separate** the wide tiled **decorations** … **from a glyph run**." | no — 81 chars between verb and object (limit 60) |
| P5 | [PARAPHRASE] "…distinguishes decoration from **glyphs**." | no — object must be `glyph run` |
| P6 | [PARAPHRASE] "…orders decoration from text, which is what makes it **not decoration**-specific…" | no — **genuine claim excused** |
| P7 | [PARAPHRASE] "…orders decoration from text by size; think of it as **large from small**…" | no — **genuine claim excused** |
| P8 | [PARAPHRASE] "…**separates chart furniture from copy**." | no — synonyms |
| P9 | [PARAPHRASE] "decoration **is distinguished** from text by `plateau_share`." | no — passive |

**One of nine caught.** So "the claim cannot return" was false: the guard was bound to
one verb set and one object phrase.

### Two distinct gaps

- **Coverage gap (fixable by list growth):** P1, P2, P3, P5, P8, P9 escape because the
  verb/object lists are finite.
- **Correctness gap (the sharper half):** P6 and P7 escape because the round-14 rule
  tested `EXCULPATORY` against the **whole line**, so one exculpatory word anywhere
  waived the claim — and `not decoration` / `large from small` are both words a
  **genuine claim can contain** (they were, in fact, in the round-14 exculpatory list).
  This is the same shape as F14's `mean = total/N`: a single scalar applied to something
  it does not describe. **Third round running** where an anti-defect mechanism
  reproduces the defect it was built to stop.

### The fix: clause-scoped, field-anchored, plus a positive assertion

> **PARTIALLY SUPERSEDED (sixteenth audit F18).** The "clause-scoped" claim below
> **overstates** what this rule achieved. It fixed the **two words** P6/P7 named, and left
> the rest of the exculpatory list in place — `amended`, `removed`, `not a classifier`,
> `invert`, `coincidence` all still waived a **real** claim (measured E1–E6, §5r). The
> same-clause test is the wrong **scope**: a negation must negate the token it applies to.
> §5r replaces it with a verb/object-adjacent test and removes the free-text waiver tokens.

The new rule splits a line into clauses on `[;,:]` — **never on `.`**, because file
paths (`lib/measure.js`) and decimals (`0.0986`) contain periods and splitting on them
tears a retraction marker away from the claim it excuses. A clause is flagged only if it
contains **all three** of a field name, a classification verb, and a decoration/text
object, **and** no negation in the *same clause*.

Measured on the audit's nine paraphrases plus six legitimate lines:

| rule | paraphrases caught | false positives (sample) | false positives (real docs, ~2000 lines) |
|---|---|---|---|
| round-14 (verb list, line-scoped waiver) | 1 / 9 | 0 | 0 |
| round-15 (clause-scoped + field-anchored) | **9 / 10** | **0 / 6** | **0** |
| round-16 (verb/object-adjacent, structural exclusion) | **16 / 17** | **0 / 6** | **0** |
| broad proximity rule (audit's probe) | 7 / 7 | **1 (the correct negation)** | — |

The two changes that closed the *named* P6/P7 cases: the negation must be in the same
clause, and the widened verb/object lists are constrained by requiring the **field name in
the same clause** — without that anchor the widened lists produced **26 false positives**
on the real docs ("a region separated by panels", "classifies a dashboard as text", …).
Round 16 then replaced the same-clause test with adjacency (§5r), because "same clause" is
still too coarse a **scope**.

**Fix #4 — the structural half.** Because no regex achieves recall and precision together,
the guard is paired with a **positive assertion**: the explicit disclaimer *must* be
present in `lib/measure.js`, `README.md`, and `ACCURACY.md`. That is paraphrase-proof and
turns "we hope nobody paraphrases the claim" into "the docs must state the opposite".

### The honest scope

The test is named *"the prose guard catches live claims (not 'any claim, ever')"* and its
comment states the limit. **No regex found so far achieves both recall and the legitimate
negations**, so the claim is "the literal regression is caught".

### What this audit has NOT proven

- That a paraphrase has **reached** the docs. The finding is that the guard *would not
  catch* one, not that one exists.
- That P4 is uncatchable. It escapes because its comma splits the field from the verb;
  the 10th paraphrase is a **known miss**, recorded rather than hidden. A rule that
  caught it would need cross-clause proximity, which reintroduces the false positives
  the field-anchor exists to prevent.
- That the disclaimer presence is enough. It proves the docs state the opposite; it does
  not prove a caller reads it.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **110/110** (was 108; +2 round-16 tests) |
| paraphrase fixtures | 17 flagged in round 16 (incl. the E and H sets), legitimate negations allowed, P4 recorded as a known miss |
| real docs | 0 un-retracted claims across `lib/measure.js`, `README.md`, `ACCURACY.md`, `CHANGELOG.md`, `index.js` |
| disclaimer presence | 3/3 files |
| non-vacuity | all guards non-vacuous (round 16: 4 guards, incl. the F18 pair and the F19 key-coverage assertion) |
| live MCP (scratch 11498) | §16: 0 claims, F18 same-verdict, field anchor 9/9, 3/3 disclaimers |

## 5r. Sixteenth audit: the F18 waiver token and the F19 field-anchor gap

### F18 — the fix for P6/P7 reintroduced P6/P7, exploitably

Round 15 added two **free-text waiver tokens** to `NEG` — `\[paraphrase\]` and `not a claim
of this document` — so the §5q escape table could quote the paraphrases. A token is matched
against the **clause**, so any claim sharing a clause with it is waived. That made them
load-bearing: the guard *depended* on a keyword whose only semantic content is "ignore
this" — the P6/P7 defect exactly, reintroduced by the patch written to remove it. **Fourth
round running.**

End-to-end, through the real guard (claim appended to `README.md`, full suite run):

| line appended to `README.md` | suite | verdict |
|---|---|---|
| [PARAPHRASE] `plateau_share orders decoration from a glyph run.` (**control**) | 107 pass / **1 fail** | caught |
| [PARAPHRASE] `plateau_share orders decoration from a glyph run. [PARAPHRASE]` | **108 / 0** | **escaped** |
| [PARAPHRASE] `… [paraphrase]` (lowercase) | **108 / 0** | **escaped** |
| [PARAPHRASE] `… (wording amended 2026)` | **108 / 0** | **escaped** |

The load-bearing proof: `sed -i 's/\[PARAPHRASE\] //g' ACCURACY.md` made the guard fail
(107/1) — the guard depended on the token.

**One precise nuance.** `…orders decoration from a glyph run, not a claim of this document`
was *caught*, only because the comma split it into a second clause so the waiver no longer
shared the claim's clause. The two tokens thus behaved differently: `[PARAPHRASE]` worked
in the same clause; the phrase only worked **inside** the claim's clause.

**And the P6/P7 class was not closed.** The same-clause exculpatory list still waived real
claims:

| case | line | round-15 verdict |
|---|---|---|
| E1 | [PARAPHRASE] `plateau_share orders decoration from text (wording amended 2026)` | escaped |
| E2 | [PARAPHRASE] `plateau_share orders decoration from text after the old gate was removed` | escaped |
| E3 | [PARAPHRASE] `plateau_share orders decoration from text and is not a classifier of anything else` | escaped |
| E5 | [PARAPHRASE] `plateau_share orders decoration from text although some claim it might invert` | escaped |
| E6 | [PARAPHRASE] `plateau_share orders decoration from text and that is no coincidence` | escaped |
| E4 | `…from text; earlier versions mislabelled it` | caught (the `;` split the clause) |

So round 15 fixed the **two** words P6/P7 named and left the rest of the list in place.
The class was not eliminated; two members were renamed.

### F19 — the field anchor made any unlisted field a blind spot

`FIELD` listed **5** names, but the entry emits **9** keys:

```
listed:   plateau_share, largest_component_share, mean_component_area, detected_plateau, component_count
unlisted: contrast_ratio, foreground, pixel_count, measured_against
```

A claim naming an unlisted or future field escaped **by construction** — not hypothetical,
since the next field added is a field the guard does not know, and the guard's silence
reads as "checked":

| case | line | round-15 verdict |
|---|---|---|
| H2a | `ink_coverage orders decoration from a glyph run.` | escaped |
| H2b | `the plateau's share separates decoration from a glyph run.` | escaped |
| H2c | `plateau_dominance distinguishes decoration from text.` | escaped |
| H2d | `mean area per blob distinguishes decoration from text.` | escaped |

### The fix (every element measured, per the audit's warning)

**1. Exclude by STRUCTURE, not by keyword.** The escape table and the `[REMOVED CLAIM]`
records need excluding because they are **quoted history**, which is a structural property.
`STRUCTURAL_MARKER` matches only at the **start of a line** (allowing table cells and
markdown markers before it) — a trailing token no longer waives.

**2. Scope the negation to the token it negates (fix #2, measured).** A claim is waived only
when a negation is within ~25 chars **before the verb** it negates (`does not **order**`),
not "somewhere in the clause"). Measured before adopting:

| rule | paraphrases + E/H caught | FP (sample, 6) | FP (real docs) |
|---|---|---|---|
| round-15 clause-anywhere NEG | 9 / 17 | 0 | 0 |
| **verb/object-adjacent NEG** | **16 / 17** | **0** | **0** |

**3. Derive `FIELD` from the emitted keys (fix #3).** `EMITTED_DISCLOSURE_KEYS` lists all
9, and a test asserts `CLAIM_FIELD` covers every key on a **live** entry — so adding a
field without extending the anchor fails the guard.

**4. Keep the positive assertion.** It remains the best part; its limit stands (it asserts
the disclaimer is present, not that nothing contradicts it) — which is why making (a)
sound matters.

**5. Single-source the rule.** The guard now lives in `test-support/prose-guard.mjs` and is
imported by the test **and** the live script, so the rule cannot drift between them.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **110/110** (was 108; +2 round-16 tests) |
| F18 pair (same claim ± trailing token) | **same verdict** — proven end-to-end (control and tokened both 109/1) |
| E1–E6 | now all flagged (`amended`/`removed`/`invert`/`coincidence` no longer waive) |
| H2a–H2d | unlisted/plausible fields now caught by the widened anchor |
| field anchor coverage | 9/9 emitted keys |
| real docs | 0 un-retracted claims; 0 false positives |
| non-vacuity | +4 round-16 guards (line-start exclusion, verb adjacency, key coverage, verb list) |
| live MCP (scratch 11498) | §16: 0 claims, F18 same-verdict, 9/9 keys, 3/3 disclaimers |

### What this audit has NOT proven

- That fix #2 (verb-adjacent negation) holds across **all** paraphrases: measured 16/17, so
  **P4 still escapes** (its comma splits field from verb). Unchanged from F17.
- That any **other** file outside the scanned list carries a claim (`docs/`, older
  `CHANGELOG` history, MCP schema prose beyond what is grepped) — the scan list is finite.
- That a real claim **has** been waived by these tokens — only that one **would** be, proven
  end-to-end (the control fails, the tokened line passes).

### Stale anchors repaired

Renaming the guard test left `verify/nonvacuity-round14.mjs` and `-round15.mjs` with
`--test-name-pattern` values that no longer matched, so **zero** tests ran and their guards
passed **vacuously**. Both were repointed. This is the same silent-stale-anchor trap noted
since round 9 — a *pattern* that matches nothing is indistinguishable from a passing guard.

## 5s. Seventeenth audit: the adjacency window and the cell-scoped marker

### F20 — the window admitted ordinary words

Round 16 scoped the negation to a 25-character window before the verb. But `NEG_ADJACENT`
contained words that are **not negations in ordinary use**, so natural phrasing waived a
claim:

| # | line | round-16 verdict |
|---|---|---|
| H1d | [PARAPHRASE] `There is no doubt plateau_share orders decoration from a glyph run.` | **escaped** — `no doubt` |
| H1e | [PARAPHRASE] `plateau_share instead orders decoration from a glyph run.` | **escaped** — `instead` as adverb |

End-to-end, appending to `README.md` and running the full suite:

| appended | round-16 | **round-17** |
|---|---|---|
| [PARAPHRASE] `plateau_share orders decoration from a glyph run.` (control) | 109 / 1 fail | 111 / 1 fail |
| [PARAPHRASE] `There is no doubt plateau_share orders decoration from a glyph run.` | **110 / 0 — escaped** | **111 / 1 fail** |
| [PARAPHRASE] `plateau_share instead orders decoration from a glyph run.` | **110 / 0 — escaped** | **111 / 1 fail** |

This is the **fifth round** of the same class — a vocabulary item applied as a retraction
scope — and it survived because the fix moved the scope from *"anywhere in the clause"* to
*"within 25 chars before the verb"*, which excludes ordinary usage of those words but not
their proximity.

### F21 — a marker in one cell waived a claim in another

`hasStructuralMarker` used `.some()` over cells, then `flagsClassificationClaim` returned
`false` for the **whole line**. So a marker anywhere in a row waived every claim in that row:

| # | line | round-16 | **round-17** |
|---|---|---|---|
| H2a | a marker in cell 1 (annotating a quote) + a live classification claim in cell 2 | **escaped** | **flagged** |
| H2b | a marker at the start of the claim's own cell | allowed | allowed |

`ACCURACY.md` carries **19** `[PARAPHRASE]` markers, so each was a live row-wide waiver.

### The fix — two-tier negation, and the idiom list measured DEAD

**F20.** The negation is now **two-tier**: strong negations (`cannot`, `does not`, `never`,
`no longer`, `rather than`, `instead of`, `without …ing`) keep the 25-char window;
ambiguous `not`/`no` are excused **only when immediately before the verb** (≤6 chars).

The audit proposed an **idiom list** (`no doubt`, `not only`, …) alongside this. I
implemented it, then **measured whether it is load-bearing** — and it is **not**: with the
≤6-char immediate tier, the idiom list changed the verdict on **0 of 20,526** real clauses.
So it was **removed**. That is strictly better than adding it: an idiom list is vocabulary,
and vocabulary is exactly what produced F17 → F18 → F20. No list, no new surface.

| rule | escapes (18 probes) | false positives (7 legitimate) | real-doc FP |
|---|---|---|---|
| round-16 (25-char `not`/`no`) | 4 | 0 | 0 |
| **round-17 two-tier, no idiom list** | **0** | **0** | **0** |

**F21.** `flagsClassificationClaim` now splits on `|` **first**, then evaluates each cell,
so a marker waives only the cell it starts. Plus a **structural assertion** that every
marker-bearing line is un-flagged — checkable, unlike the audit's "annotates its own text".

### The structural read (five rounds, one class)

| round | mechanism changed | the hole that opened |
|---|---|---|
| 14 | removed the threshold | the claim lived in the prose |
| 15 (superseded rule) | phrase guard | caught 1/9 paraphrases (SUPERSEDED — the rule has since been hardened; current recall 18/19, §5v) |
| 16 | free-text waiver token | trailing token waived any claim |
| 17 | verb-adjacent negation, structural marker | ordinary words in the window; marker waived the row |

Each fix narrowed the **scope** of an exclusion and left its **kind** alone — an
author-authored token whose presence suppresses reporting. As long as suppression is
triggered by text the author controls, a new phrasing will waive a claim. The **positive
disclaimer assertion** is the only element a paraphrase cannot defeat, so it is the primary
check and the phrase guard is a **best-effort lint whose recall is a measured number (18/19 on the
fixture set, enforced)** — see §5v. What is true of the lint is that it is **frozen** and that we no
longer rely on its **completeness**; it still fails the build when it fires. The guard's own header
now says exactly this.

### Corroboration of the audit's retraction

The audit retracted its **own** hypothesis H1a–H1c (that negating *after* the verb escapes).
I confirm: the loop tests each verb occurrence and the trailing negation falls outside the
window, so all three are **caught**. The window is one-directional, and that direction is
the safe one.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **112/112** (was 110; +2 round-17 tests) |
| H1d / H1e | flagged (proven end-to-end: 111/1) |
| H2a / H2b | cross-cell flagged, same-cell allowed |
| idiom set (`no doubt`, `not only`, `no wonder`, `no accident`, …) | all flagged |
| two-tier measurement | 0/18 escapes, 0/7 false positives; idiom list 0/20,526 → removed |
| real docs | 0 un-retracted claims; 0 false positives |
| non-vacuity | +4 round-17 guards (weak-tier scope, strong tier, per-cell marker, marker-bearing-line assertion) |
| live MCP (scratch 11498) | §16: F20 both flagged, F21 cell-scoped |

### What this audit has NOT proven

- That the phrase space is exhausted. A negation **more than 25 chars from the verb**
  escapes — measured:
  [PARAPHRASE] `Not for a moment does plateau_share order decoration from a glyph run.` is **missed** (the negation is 36 chars before the verb). This is a **second,
  distinct residual** from the idiom case, and it is recorded here rather than hidden.
- That the two-tier rule holds on a corpus beyond this repo's ~2,000 lines.
- That a marker whose cell contains unrelated quoting (e.g. pipes inside code spans) cannot
  waive a claim — `split("|")` treats escaped pipes as separators; **not measured**.
- That the **19** markers each annotate exactly the text they claim to.

## 5t. Eighteenth audit: the strong-negation window and the span-scoped marker

### Withdrawals and confirmations

- **The audit WITHDRAWS its idiom-list recommendation.** It re-implemented the shipped rule
  with and without an idiom list and counted clause-level diffs across the corpus:
  `clauses=20813 idiom-affects=0`. So the ≤6-char immediate tier does all the work and the
  list is dead code — my round-17 measurement was right.
- **My H1a–H1c retraction is confirmed** independently: negation *after* the verb is caught,
  because the loop re-tests each verb occurrence.

### F22 — the *strong* tier was still a proximity test

`NEG_STRONG` was matched against a 25-char window, and it contained words that routinely
precede a verb **without negating it**. Each line below **asserts** the classification:

| # | line | round-17 verdict |
|---|---|---|
| A1 | [PARAPHRASE] `plateau_share never fails to order decoration from a glyph run.` | **escaped** |
| A3 | [PARAPHRASE] `plateau_share without blinking orders decoration from a glyph run.` | **escaped** |
| A8 | [PARAPHRASE] `plateau_share no longer ambiguous orders decoration from a glyph run.` | **escaped** |

End-to-end through the real suite (appending to `README.md`):

| appended | round-17 | **round-18** |
|---|---|---|
| [PARAPHRASE] `plateau_share orders decoration from a glyph run.` (control) | 111 / 1 fail | 111 / 1 fail |
| [PARAPHRASE] `plateau_share never fails to order decoration from a glyph run.` | **112 / 0 — escaped** | **111 / 1 fail** |
| [PARAPHRASE] `plateau_share without blinking orders decoration from a glyph run.` | **112 / 0 — escaped** | **111 / 1 fail** |
| [PARAPHRASE] `plateau_share no longer ambiguous orders decoration from a glyph run.` | **112 / 0 — escaped** | **111 / 1 fail** |

### F23 — a marker waived its whole cell

`cellIsClaim` returned `false` for the entire cell once a marker was found, so an unrelated
claim later in the same cell escaped:

| # | line | round-17 | **round-18** |
|---|---|---|---|
| B1 | a marker, then an unrelated classification claim, both in the same cell | **escaped** | **flagged** |
| B2 | a marker annotating only its own quoted span | allowed | allowed |

The marker count has grown **19 → 31**, so each cell-wide waiver was more costly than last
round.

### The fix, and the cost the audit did not see

**F22 — governed negation.** The **last** strong negation before the verb must have only
**function words** between it and the verb, within 30 chars. So `never fails to order` is
*not* excused (the content word `fails` intervenes), while `does NOT distinguish` and
`cannot distinguish` are.

I also **removed `without \w+ing`** from `NEG_STRONG` — the widest offender (`without
blinking`, `without pausing` read as emphasis).

**The cost, measured on the fair union** (must-flag **and** must-allow, including long
retractions) — the audit's fix design measured only the must-flag set and real docs, so it
did not see this:

| variant | escapes (9) | false positives (13) |
|---|---|---|
| round-17 (proximity, keep `without X-ing`) | 3 | 1 |
| proximity, drop `without X-ing` | 2 | 1 |
| governed, keep `without X-ing` | 1 | **5** |
| **governed, drop `without X-ing`** | **0** | **5** |

Governing trades escapes for false positives: legitimate retractions that put a **content
word** between the negation and the verb — `is not able to distinguish`, `cannot be said to
separate`, `should not be used to order` — are now **flagged although they retract**. Those
five FPs are **asserted in the test suite** so the trade cannot silently reverse. Adopted
because **escapes are silent** (a caller never sees the omitted disclosure) while false
positives are loud (the guard fails, someone reads the line) — the same asymmetry that drove
the F14 decision.

**F23 — span-scoped marker.** A marker waives only up to the **first sentence end**; the
cell's remainder is still checked.

### The period-splitting regression, in the audit's own candidate

The audit's first F23 attempt split on `[.!?]` and produced a real-doc false positive by
splitting on the **period in `lib/measure.js`** — *precisely* the bug F17 fixed and that
this file comments about at length. That is the clearest evidence yet that the rule keeps
re-deriving the same mistake. The repair — and the one shipped — excludes periods that are
not sentence ends (`\w\.\w`) before splitting.

### The disposition (§5 of the audit) — adopted

Six rounds of one class is enough to change the **goal**, not the pattern. The guard's own
header now states:

- the **positive disclaimer assertion is PRIMARY** — the docs must *state the opposite* of
  the claim, and that is the one mechanism a paraphrase cannot defeat;
- the phrase guard is a **best-effort lint whose recall is a measured number
  (18/19)**, not "coverage";
- the test that matters most is the **invariance pair** — the same claim ± each waiver
  mechanism must get the **same** verdict. It caught F18 and would have caught F21/F22/F23,
  so it is now a named acceptance test.

The **reviewable-allowlist** option (require every field-name mention to be inside a marked
quoted-history span or accompanied by the disclaimer) is **not adopted this round** — it is
a re-architecture, and the positive assertion already supplies the paraphrase-proof core.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **115/115** (was 112; +3 round-18 tests) |
| A1 / A3 / A8 | flagged (proven end-to-end: 111/1 each) |
| B1 / B2 | cross-span flagged, own-span allowed |
| invariance pair | 5 wrappers, all same-verdict |
| governed-negation FPs | asserted (documented, not hidden) |
| real docs | 0 un-retracted claims; 0 false positives |
| non-vacuity | +4 round-18 guards |
| live MCP (scratch 11498) | §16: F22 both flagged, F23 span-scoped |

### What this audit has NOT proven

- That the strong-negation space is exhausted — `without X-ing` was one family and it is now
  dropped rather than governed.
- That governed negation holds beyond these 15 cases and this repo's ~20,800 clauses; no
  external prose was tested.
- That the `\w\.\w` repair is sufficient in general — **abbreviations** (`e.g.`, `i.e.`) and
  **ellipses** (`...`) were not tested.
- That any of these escapes occurred in the shipped docs — the docs are clean today; these
  are waivers available to a future author.

## 5u. Nineteenth audit: the no-sentence-end marker and the retraction false positives

### F24 — a marker with no sentence end waived the entire remainder

```js
const end = firstSentenceEnd(afterMarker);
const remainder = end >= 0 ? afterMarker.slice(end + 1) : "";  // "no sentence end => marker waives the rest"
```

The comment was accurate and the branch was the bug: a marker whose cell had **no
sentence-ending period** waived everything after it. This is a **strictly easier** escape
than B1 (F23) — it needs no punctuation anywhere:

| # | line | round-18 | **round-19** |
|---|---|---|---|
| H2a | a marker, then a claim, separated by a comma (no sentence end) | **escaped** | **flagged** |
| H2b | a marker, then a claim, separated by an em-dash | **escaped** | **flagged** |
| H2c | a marker then a claim in a table cell, em-dash separator | **escaped** | **flagged** |
| H2d | a marker then a claim with no punctuation at all | — | **flagged** |

End-to-end, appending to `README.md`: the control fails (114/1) while **H2a escaped (115/0)**
at round 18 and now **fails (113/2)**. F23's fix had made a sentence end a **precondition** for
the marker to stop waiving, so the marker was strongest exactly where the text was least
structured.

### F25 — the accepted false positives were retractions, and they were latent in the repo

Round 18 accepted 5 false positives. The audit measured the family as **broader**, and every
member **retracts** the classification — so flagging them punishes writing the disclaimer:

| # | line | round-18 | **round-19** |
|---|---|---|---|
| H1a | `plateau_share is not able to distinguish decoration from text.` | **flagged** | allowed |
| H1b | `plateau_share does not attempt to classify decoration from text.` | **flagged** | allowed |
| H1c | `plateau_share cannot be said to separate decoration from text.` | **flagged** | allowed |
| H1d | `plateau_share should not be used to order decoration from text.` | **flagged** | allowed |
| H1e | `plateau_share is never used to identify decoration from text.` | **flagged** | allowed |
| H1f | `plateau_share is not intended to order decoration from text.` | **flagged** | allowed |

**And it was latent in the shipped docs.** `ACCURACY.md`, `CHANGELOG.md`, and
`prose-guard.mjs` all contain `is not able to distinguish` / `cannot be said to separate` —
passing only because they are **fragments without a field name**. The same words in a full
sentence with `plateau_share` **fail the suite** (measured 114/1). So the docs survived on
phrasing luck, and the next author writing the disclaimer in full sentences would be blocked.

### The fix, and the polarity trap

**GLUE words (F25).** A retraction often puts a content word carrying the retraction between
the negation and the verb — `is not **able** to distinguish`, `cannot be **said** to
separate`, `not **intended** to order`. Those now count as governed. Modal negations
(`should not`, `would not`, `must not`, …) were added to `NEG_STRONG`.

**POLARITY WARNING.** `fail|fails` is **deliberately excluded**: `never **fails** to order`
is a *double negative that ASSERTS the claim*. Adding `fail` to the glue list re-opened A1 —
so `never fails to order` is now a permanent must-flag fixture and the reference case for a
polarity-inverting word.

**Quote-span markers (F24).** The rule is now: a complete lead clause ending in `[.!?]` waives
that clause; else a leading **quoted span** waives that span; else the marker waives **nothing**
and a leading claim is reported.

### The four-design measurement

| design | escapes (20 cases) | false positives | real-doc flags |
|---|---|---|---|
| round-18 (shipped) | 2–3 (H2a/b) | 5 (H1a–e) | 0 |
| marker=**strict** (waive nothing) | 0 | 5 | **5** |
| marker=quote alone | 0 | 5 | 0 |
| **glue(no `fail`) + quote-span** | **0** | **0** | **0** |

`marker=strict` is the **negative control**: it gives 0 escapes but **5 real-doc flags** — it
re-flags the `[REMOVED CLAIM]` history records. So the marker must waive *something*; the
question is only how much. The adopted design needs no exemption anywhere.

### The recommendation, accepted: STOP extending this guard

Seven rounds on one mechanism, and the trajectory is diagnostic:

| round | escapes found | new escapes created by the fix |
|---|---|---|
| 15 | 8 of 9 paraphrases | trailing token |
| 16 | free-text token | — |
| 17 | ordinary words in window | marker waives the row |
| 18 | strong-negation proximity | marker waives the cell; 5 new FPs |
| 19 | marker with no sentence end | — |

The measured exchange rate is **one new escape class per fix**. Accordingly:

1. **The positive assertion is now the PRIMARY gate** — the docs must **contain** the
   disclaimer. It is paraphrase-proof, it is what a paraphrase cannot defeat, and it is a
   named test (`F24/F25: the docs carry 0 flags, the disclaimer is PRESENT`).
2. **The phrase rule is FROZEN as a best-effort lint** with its recall stated as a measured
   number, not "coverage". Its own header now says so, and the test asserts that the header
   says so.
3. **The invariance pair stays** as the acceptance test that matters.
4. **Effort redirected.** F1–F14 were correctness defects in the *measurement engine*, found
   by fixtures with known ground truth. F15–F25 are one guard in the docs. The engine is where
   the value was, and the next round should not be a seventh scope narrowing.

The **reviewable-allowlist** (every field-name mention inside a marked quoted-history span or
carrying the disclaimer) remains an unimplemented option; the positive gate already supplies
the paraphrase-proof core, so it is deferred rather than rejected.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **117/117** (was 115; +2 round-19 tests) |
| H2 triple/d quadruple | all flagged (proven end-to-end: 113/2) |
| H1a–H1f | all allowed (were flagged) |
| `never fails to order` | flagged (polarity reference) |
| real docs | 0 flags, with a **strict negative control** proving the rule is not inert |
| disclaimer present | 3/3 files; the primary gate is a named test |
| non-vacuity | +4 round-19 guards |
| live MCP (scratch 11498) | §16: F24 all flagged, F25 retractions allowed |

### What this audit has NOT proven

- That the **glue** space is exhausted — `able|intended|used|going|supposed|meant|said|
  attempt|try|seek` was chosen from examples; words that carry retraction in other
  constructions were not tested. The glue list is vocabulary again.
- That the design holds on prose beyond this repo's ~20,800 clauses.
- That the guard **contradicts** the required disclaimer — it does not today; the current
  disclaimer phrasings pass. What was shown is that full-sentence forms of the same words are
  flagged, i.e. the docs survive on phrasing luck and are one phrasing from the contradiction.
- That `firstSentenceEnd` handles **abbreviations** (`e.g.`, `i.e.`) inside a waived span.

## 5v. Twentieth audit: the disposition was declared, not recorded

### F26 — "a measured recall" was asserted four times and measured nowhere

Round 19's disposition promised that the phrase guard's recall would be **a measured number**.
It was written in **four places** — `test-support/prose-guard.mjs` (header), `ACCURACY.md` §5q
and §5t, and `README.md` — and **no number appeared anywhere**. The only figure in the repo
was the **stale** round-15 value `caught 1/9 paraphrases`, describing the *broken* rule.

This is the **F16 defect one layer up**. F16 was a classification claim no test could fail;
F26 is a **scope claim about the guard** that no test could fail either. The disposition was
the right change of goal, but *stating it in prose* is exactly the move the previous seven
rounds kept punishing — a claim introduced by the fix for the class of claims.

### The number, now measured and enforced

The fixture set moved to one place, `test-support/prose-recall-fixtures.mjs` (deliberately
**not** in the guard's scanned file list — it *contains* live claims, they are the fixtures):

```
measured recall on the fixture set: 18/19 (caught 18/18, known miss still missed: true, false positives: 0)
```

The test **prints** that line and **asserts the ratio** (≥ 18/19), so a regression that lowers
recall **fails the build** rather than silently changing the story the docs tell. A sibling
test asserts the docs **quote the same figure**, and that the stale `1/9` (round-15 rule,
superseded) is **labelled historical**.

**18/19 is a REGRESSION SCORE over the known escape cases, NOT an estimate of recall over
unseen prose** — the fixtures are the accumulated findings, so the figure does not predict a
paraphrase nobody has written yet. Stated in the prose, not just here.

### "Not a barrier" was true of intent and false of mechanism

`README.md` and `ACCURACY.md` both called the lint *"not a barrier"*. Measured:

| check | observed |
|---|---|
| mechanism | assert-only — 22 `assert.ok(flagsClassificationClaim(…))` calls |
| advisory/warning path in `prose-guard.mjs` | **none** |
| injecting a claim into `README.md` | **`fail 2`** — the build fails |

So it **is** a barrier: any doc edit it dislikes fails the suite (precisely round 16's F18
situation). The accurate sentence, now used:

> The phrase lint **fails the build** when it sees a claim; what we no longer rely on is its
> **completeness**. The part we trust is the positive assertion: the docs must **contain** the
> disclaimer. The lint is frozen and best-effort; its measured recall on the fixture set is
> **18/19** (P4 is the known miss).

### The audit's falsified GLUE-polarity hypothesis

The audit predicted the new `GLUE` list would produce escapes, on the theory that
*"is said to order"* is an assertion. It measured all twelve and **all twelve are correctly
flagged** — because `GLUE` is only consulted *after* a negation is found, so `is said to order`
(no negation) flags on the un-negated verb. Its hypothesis was wrong.

This is the **second** entry in the record of audit hypotheses that did not survive
measurement:

| round | hypothesis | measured outcome |
|---|---|---|
| 17 | negation *after* the verb escapes | **caught** — the window is one-directional and safe |
| 20 | `GLUE` words (`said`, `thought`, …) produce escapes | **all 12 flagged** — glue is gated on a prior negation |

Both are worth recording: they show the guard is stronger than the adversarial model of it in
these two spots.

### Acceptance evidence

| check | result |
|---|---|
| `npm test` | **118/118** (was 117; +1 round-20 test) |
| recall printed + ratio asserted | `18/19`, ≥ 18/19 enforced |
| doc-consistency assertion | `README` / `ACCURACY` / guard header must quote `18/19` |
| stale `1/9` | labelled `(superseded rule)` |
| non-vacuity | +4 round-20 guards (fixture removal, doc figure, historical label, guard header) |
| live MCP (scratch 11498) | §16 prints `18/19` |

### What this audit has NOT proven

- That the *"not a barrier"* wording **has misled** a contributor — it was shown to describe
  the **intent** rather than the **mechanism**.
- Recall on anything beyond the fixture set. **18/19 is on the fixtures**, which is what the
  text claims; it is **not** extended to real prose.
- That the 18 must-flag fixtures are a **representative sample** — they are the accumulated
  escape cases, so 18/19 is a **regression score for known cases**, not an estimate over
  unseen prose.

## 5w. Twenty-first audit: back to the engine — two measured verdict defects

Round 20 ended with a disposition: **stop extending the documentation guard** and spend the
next round on the **measurement engine**, where the defects are real and findable by fixture
ground truth. This round does that. The guard is untouched (frozen, recall still `18/19`).

Both defects share a shape this project keeps meeting: **a tool that sounds certain about
something it did not measure.** In each case the engine already *had* the evidence that its
model was wrong (an inadequate background fit; a component that is visibly two colours) and
**still published a verdict**.

### F27 — a text-free gradient was reported as FAILING text

**Reproduction.** A 1000×700 linear gradient `#101010` → `#606060` with **no text at all**.
Reported:

```
measurable=true  all_meet_aa=false  failing=1
colours: #606060 @ 2.98 px=659000  comps=1
background_fit: explained_fraction=0.083  adequate=false
```

The "failing colour" is `#606060` across **659,000px — 94% of the region**. It is the ramp's
own far end. A single global background explains only **8.3%** of the region, so the ramp end
clears the ink threshold *against the modal colour* and becomes "text". **Control:** a flat
no-text image reports `measurable=false` — the tool is not simply always-failing; the ramp is
what makes it fire.

The mechanism is a **verdict/evidence inversion**: `all_meet_aa` and `failing_count` are
computed from the failing list **before** `background_fit` exists, and the `!adequate` branch
only appends a *note*. So the tool **already knew** the model was poor (`adequate: false`)
and populated the verdict fields anyway.

**Discriminator, measured** (not tuned): re-running the region with the per-tile (`local`)
model, which exists precisely for ramps and photographs:

| fixture | global | local |
|---|---|---|
| text-free gradient | `#606060@2.98` (ramp end) | **not measurable** |
| gradient WITH text | `#606060@3.34` (ramp end) | real tones `#080808@1.05`, `#3e3e3e@1.96` |
| flat (control) | not measurable | not measurable |

`adequate:false` occurs for exactly three fixtures (steep gradient 0.051, gradient text 0.081,
text-free gradient 0.083) and **never** for a flat page or a photo. So the branch is scoped to
`adequate:false` and nothing else moves.

**The fix.** When the global verdict is a **failure**, the model is **inadequate**, and the
region is **not** multi-plateau or explicit-background: re-run local.

- If local finds **nothing assessable** ⇒ **ABSTAIN** (`measurable:false`, `all_meet_aa:null`,
  `failing_count:0`) and say the enumerated colour is the background ramp. This is the
  text-free gradient.
- If local **does** find text ⇒ keep the global verdict — the F5 contract is that a
  gradient/photo **falls back to the single background and warns** — and disclose the local
  model's failing colours in `model_disagreement`.

This is the **mirror of the F6 clean-pass guard**: F6 arbitrates a *clean* global verdict
against local; F27 arbitrates a *failing* global verdict against local when the premise is
known-bad. It does **not** change the ink threshold, and it does **not** make local the
default — local over-reports on dense flat panels, which is why it is not the default.

### F28 — outlined text: the darker of two colours was discarded and a failure hidden

**Reproduction.** Fill `#464646` (**1.88:1 — FAILS**) with a 3px stroke `#e8dfd0`
(13.42:1 — passes). Reported:

```
colours: #e8dfd0 @ 13.42  px=22725
all_meet_aa: true
```

The verdict is **clean**. But an independent pixel census of the same glyph shows:

| colour | true pixels | reported pixels | contrast |
|---|---|---|---|
| `#e8dfd0` (stroke) | **2,617** | 22,725 (the whole component) | 13.42 pass |
| `#464646` (fill) | **17,269** | **— in NO channel —** | **1.88 FAIL** |

The fill is **6.6× larger** than the stroke and is the failing ink; it was attributed to the
stroke colour and surfaced in no channel.

**Mechanism.** A component's colour has always been its **extremal pixel** (furthest from the
background). For an outlined glyph the *light stroke* is extremal, so the *darker interior* is
absorbed; and `pixel_count` was `members.length`, giving the whole component to the stroke.
`localCounts` held the true split the entire time.

**The fix.** Each additional colour in a component that clears the gates below is emitted as
its **own entry** with `multi_colour_of` = the parent's hex, inheriting the box but carrying
its **own** pixel count. The parent's count is then reduced by what was broken out, so the two
entries **sum to the component** (stroke 5,499 + fill 17,226 = 22,725) and the larger ink is
the larger count.

**The gates, each measured** (all four were needed; two earlier candidates were measured and
**rejected**):

| gate | value | measurement that set it |
|---|---|---|
| absolute pixel floor | `MULTICOLOUR_MIN_PIXELS = 512` | true second ink **2,561–20,706px**; AA fragments **68–158px**; no fixture between 158 and 2561 |
| not an AA blend of the extremal colour | — | a fringe is a blend of the colour it merges toward, not a second ink |
| not background-sized **and** low-contrast | area > 2% **and** ratio < 1.5 | dense-flat page tones: 124,945/181,941/185,191px at 18–27% of the region, ratio 1.04–1.29 |
| parent box ≤ 50% of the region | `MULTICOLOUR_PARENT_MAX_BOX_FRACTION = 0.5` | a **glyph cannot span the region**: photographic parent = **1.000**, dense-flat = **1.000**, real outlined glyph = **0.028** |

**Rejected candidates (measured, not guessed):**

- **A *share* floor (`count2/component ≥ 0.2`) — REJECTED.** A share is **anti-correlated with
  size**: a 2px component's single AA pixel is 50% of it, while the outlined fill is only ~10%
  of *its* component. So a share floor is simultaneously too loose for tiny glyphs and too tight
  for the real defect, and it **failed the reversed direction** (light fill + dark stroke) outright.
  This is the same share-vs-size anti-correlation that produced **F14, F15, F20**.
- **A structure gate (skip decorative borders) — MEASURED REDUNDANT, removed.** Border edge
  shades measure 68–313px, **below the 512px floor**, so the floor already covers them. Removing
  it kept **120/120** — no untested predicate is carried.

**Both directions live in ONE test.** A fix that always kept the extremal colour would pass the
dark-fill case and **fail** the reversed (light-fill + dark-stroke) case:

| fixture | reported | `all_meet_aa` |
|---|---|---|
| dark fill `#464646` + light stroke `#e8dfd0` | `#464646@1.88` (17,226px), `#e8dfd0@13.42` (5,499px) | **false** |
| light fill `#e8dfd0` + dark stroke `#464646` | `#464646@1.88` (2,561px), `#e8dfd0@13.42` (20,096px) | **false** |
| fill only (control) | `#464646@1.88` (22,657px) | false (unchanged) |

### The relation to §5k, and one deliberate non-goal

§5k's DECLINED trade was about a **different** case — a large content-dense *panel* colour that
the mask treats as background — and is unaffected by this round.

F28's fix does **not** claim the engine now attributes a multi-colour component perfectly. The
photographic fixture shows a **deeper, open limitation**: a drifting gradient links its tones
into **one region-spanning blob**, so the pink **text** tone `#f2b8b8` sits inside a blob whose
box is the whole region. That is why the parent-box gate must reject such blobs — the "second
colour" there is field shading, not a glyph's second ink. Surfacing that text tone under a
single global background remains **unproven**; the per-tile model resolves it, which is what
`background_mode:"local"` is for. This is stated, not implied.

**What is now guaranteed:** the darker of two inks in a glyph is **no longer silently
absorbed** — it appears as its own entry (`multi_colour_of` marks it) and the failing one can
no longer be hidden behind a passing extremal colour.

### Acceptance evidence

| case | before | after |
|---|---|---|
| text-free gradient | `all_meet_aa:false failing:1` (`#606060@2.98`) | `measurable:false all_meet_aa:null failing:0` |
| outlined dark fill + light stroke | `#e8dfd0@13.42 px=22725`, `all_meet_aa:true` | `#464646@1.88 px=17226` surfaced, `all_meet_aa:false` |
| outlined light fill + dark stroke | dark stroke absorbed | `#464646@1.88` surfaced, `all_meet_aa:false` |
| acceptance fixture (flat) | 5 colours, worst `#1e1c18@1.04` | **unchanged** |
| `npm test` | 118 | **120** (F27 + F28 tests) |
| non-vacuity | 90 guards | **95** (+5 round-21 guards) |
| live MCP (scratch 11498) | — | §17: F27 fixed, F28 fixed both directions |

### The four gates measured, and the one that was cut

Five guards were carried; a sixth (the structure gate) was **measured redundant** and removed
rather than kept untested — the project does not carry predicates no test can fail.

### What this audit has NOT proven

- That the engine attributes a multi-colour component **exhaustively** — the photographic
  region-spanning-blob case above is open, and is named as such.
- That the 512px floor is universal. It sits in a **measured gap** (158 → 2561) across the
  standing fixtures; a text colour thinner than ~512px in **both** its inks is outside the
  evidence.
- That the local model is **generally** better. It is preferred **only** when the global model
  is inadequate; on flat panels it over-reports and is not the default.

## 5x. Twenty-second audit: F28's own gate reappears one scalar lower

The twenty-first-audit fix (§5w) was **correct in its direction and incomplete in its
aggregation**. F28 lowered a threshold that was applied **per component**, where the quantity
that matters is the colour's **total**. That is the **F13/F14 construction** again: a
threshold on a **per-piece** quantity, where adding or splitting evidence changes the
verdict.

### F29 — the pixel floor was per component, so a shrinking glyph lost its fill

§5w justified `MULTICOLOUR_MIN_PIXELS = 512` as *"AA fringes are small; real second ink is
thousands of pixels."* That is true of a **total**, but the floor was applied to a **single
component's** `count2`. As outlined text shrinks, its fill **splits across connected
components**, and no single piece clears 512 — so the failing fill was emitted in **no
channel** and `all_meet_aa: true` was returned, exactly the defect F28 exists to prevent.

`buildOutlinedTextFixture({ fontSize, strokeWidth: 2 })` sweep (the same builder the F28 test
uses — the window is inside the current fixture family):

| fontSize | `all_meet_aa` | failing | `#464646` (true ratio 1.88 — FAIL) |
|---|---|---|---|
| 56 | false | 1 | reported 1306px |
| **48** | **true** | **0** | **ABSENT** |
| **44** | **true** | **0** | **ABSENT** |
| 40 | false | 1 | reported 530px |
| **36** | **true** | **0** | **ABSENT** |
| 28 | **true** | **0** | **ABSENT** |

**Non-monotonic** (56 reports, 48 silent, 40 reports, 36 silent) — the signature of a
threshold sitting on top of noise, not of a size below which text stops mattering.

### The census and the mechanism

Independently counted (exact colour, tolerance 2) and per component:

| fontSize | true `#e8dfd0` stroke | true `#464646` fill | fill per component |
|---|---|---|---|
| 48 | 405 | **885** | 400 + 485 (both < 512) |
| 44 | 351 | 695 | 323 + 372 (both < 512) |
| 40 | 311 | 545 | 545 (**≥ 512 → reported**) |
| 36 | 278 | 380 | 380 (< 512) |

At 48px the fill is a single logical ink of **885px — larger than the 405px stroke and
failing** — but because it is split across two connected components, no `count2` reached 512
and it appeared in **no channel**: `colours: 1, excluded: 0, skipped: 0, panel_fills: 0,
suspected_noise: 0, background_regions: 0, merged_anti_aliasing: 0, mask_reconciliation: null`.

### The fix — aggregate, then decide once per colour

The floor is now applied to the colour's **total across the whole scan** (`extraTotals`),
decided once per colour, then emitted in each component that holds it. The AA-blend and
plateau-adjacency gates stay per component (they are structural, and the reference differs per
component); only the **floor** moved to the total. This is fragmentation-invariant — the same
repair that closed F13.

### The floor moved with the granularity: 512 → 224, measured

Aggregation changes what the floor must be. Re-measured over plain text (no outline) at every
size 10–96px and across many small text runs, **ordinary-text AA fringes produce ZERO candidate
extras** — the AA-blend test already removes them, so the constraint that set 512 is gone once
the quantity is a total. The binding constraint moved to **structural card shades**. Measured
floor sweep (full suite failures):

| floor | failures | note |
|---|---|---|
| 0 | 31 | everything, incl. real AA fringes (they are removed by aggregation, but other colours leak) |
| 128 | 4 | tiled card shade families leak: `#413c35@1.34` (356px), `#e6e6e6@1.25` (350px) |
| 200 | 2 | tiled card edge shade `#4b463e@1.56` (204px) |
| **224** | **0** | chosen — just above the measured false positives, just below the smallest defect case |

**224 is not a re-tuned 512.** It is a different quantity (a total): the outlined fill
dominates its stroke down to **32px** (fill 252px vs stroke 722px) and the rule must fire
there; the next false positive up is a tiled card edge shade at 204–224px.

### Two gates: one restored, one measured redundant and cut

Turning the floor into a total also changed which gates are needed:

- **Plateau-adjacency gate — ADDED, and load-bearing.** Skip an extra whose colour is within
  `PLATEAU_MERGE_DIST` of a detected plateau. Without it the dense-flat page's border tones sum
  past the total floor (measured: `#232931` to **2560px**) and the F7 verdict fails. Measured
  separation: the dense-flat card extras are **4.1–9.5** from a plateau; the outlined fill is
  **80.9** away. Non-vacuous (`verify/nonvacuity-round22.mjs`).
- **Structure gate — measured REDUNDANT, removed.** A dedicated `looks_like_structure` skip
  was needed at a per-component floor in round 21; at the 224px **total** floor it is not —
  the floor already rejects the tiled card edge (204px). Verified: removing it kept **121/121**,
  so it is not carried (no untested predicate).

### The measured-and-rejected floor-0 attempt (as the audit asked)

Dropping the floor entirely and relying on the AA-blend test alone was measured: it
**disturbs the flat cases** (tiled grid, huge glyph, flat/local identity). The AA test alone is
**not sufficient** at per-component granularity. With **aggregation**, plain-text AA fringes do
vanish — but other sub-floor colours still leak (31 failures at floor 0). Recorded as
**measured-and-rejected**, not a recommendation.

### The honest boundary — stated, not implied

The fix reaches every case where the **defect applies**: the fill is the **larger** ink (so
hiding it is F28 absorption). Measured, the fill dominates the stroke down to **32px**. At
**28px the fill (158px) is SMALLER than the stroke (216px)**, so the larger failing-capable ink
**is** reported and hiding the smaller one is a **reporting-floor** question, not the F28
defect — the rule correctly stays quiet there. A font-size sweep asserting the fill at 28px
would therefore be asserting something the evidence does not support; the test sweeps
**32–180px** instead and asserts the boundary explicitly.

### Acceptance evidence

| case | before | after |
|---|---|---|
| 48px outlined "AB" | `all_meet_aa:true`, fill **ABSENT** | `#464646 px=870 FAIL`, `all_meet_aa:false` |
| "ABC" 30px (split 221 + 68) | fill **ABSENT** | `#464646 px=277` (aggregated total 289) |
| tiled card grid | clean | **clean** (plateau-adjacency gate) |
| dense-flat page | clean | **clean** (plateau-adjacency gate) |
| acceptance fixture | worst `#1e1c18@1.04` | unchanged |
| `npm test` | 120 | **121** (F29 test) |
| non-vacuity | 95 guards | **99** (+4 round-22; round-21 anchors repointed to the two-pass code) |
| live MCP (scratch 11498) | — | §18: every size 32–72px reports the fill; aggregation WORKS; 28px boundary honest |

### What this audit has NOT proven

- The split is **instrumented** by me directly (per-component fill counts, tolerance 2), not
  inferred — but I tested Latin bold glyphs at one stroke width (2px) and one background. Other
  scripts, weights, stroke widths, or a multi-plateau page could shift where the window sits.
- **Frequency unmeasured.** Small outlined text is plausible in real screenshots (labels,
  badges) but I did not count occurrences; this is a control-backed **verdict error**, not a
  prevalence claim.
- I did **not** fix the **300px single-glyph abstention** (large display glyphs return
  `all_meet_aa: null` via `abstained: "contrast ratio of text"`). Verified **identical at
  HEAD** (pre-existing, out of scope), but it also hides a failing fill and may merit its own
  round. Named **F30** here so it is not lost.
  **SUPERSEDED (round 28, §5ad):** the 300px case was **incidentally fixed by round 23** — it now
  returns a correct `all_meet_aa: false`. A glyph at `fontSize ≥ ~700` still abstains, **but**
  discloses `#464646` in `plateaus` plus a scope note, so it is **not silent**. This item is
  therefore **not** an open defect.

## 5y. Twenty-third audit: the second-ink path had its own scalar, not the primary path's gates

Round 22 fixed F29 by applying the pixel floor to a colour's **total** across the scan. It
kept a **separate, 28× larger scalar** (224) for the second-ink path. This round shows that
the scalar was the whole problem, on **both sides at once**: it **hid** failing ink (F30) and
its companion per-total behaviour **admitted** accumulated decoration (F31). Both were
reproduced before any change.

### F30 — the second-ink floor was 28× the tool's own primary floor

The primary path reports **every** ink colour above `minColourPixels = 8`. The second-ink path
required **224**. So the SAME failing ink got opposite verdicts:

| fixture | failing `#464646` | path | floor | verdict |
|---|---|---|---|---|
| plain **16px** `"AB"` | 209px | primary | 8 | **reported**, `all_meet_aa:false` |
| outlined **30px** | 221px | second-ink | 224 | **hidden**, `all_meet_aa:true` |

**Same colour, same ~210px quantity, opposite verdicts.** That is the **F13/F14 seam in its
original form**: a gate stricter than the mask's own floor, making the same quantity visible
or invisible depending only on which path it arrived by. Round 21's own acceptance set only
pinned `fontSize:180`; `buildOutlinedTextFixture` already exposed `fontSize`, so the window was
inside the current fixture family.

### F31 — the per-total floor admitted accumulated decoration

`dense_small_cards` (a dashboard of small text on cards) **changed verdict** between rounds:

| round | colours | `all_meet_aa` |
|---|---|---|
| 21 (`a304c0e`) | 1 | **true** |
| 23 (`11e6757`) | 2 | **false** — new failing `#443f38@1.4` |

Independent census: true `#443f38` is **663px (0.08%)**, yet reported as **1226px,
`component_count: 227`**. Mechanism, measured: `isAntiAliasingBlend(#443f38, card=#2d2822 →
text=#e8dfd0)` is a **true blend at t=0.12** — a card↔text anti-aliasing fringe — appearing
across 227 components, and the per-`TOTAL` floor aggregated it past the gate. This is the
**mirror of F29**: per-piece thresholds hid split ink (fix: aggregate); per-total thresholds
then admit accumulated decoration. The fix for F29 introduced the opposite error one layer out.

**F30 and F31 are one problem: the second-ink path needed the primary path's GATES, not its
own scalar.**

### The fix, and what each gate is measured to do

| gate | value | measured role |
|---|---|---|
| unified floor | the primary `minColourPixels` (8) | same quantity both paths; was 224 (28×) |
| **AA window** | the **full** `(0, 1)` segment | rejects fringes by **residual**, not by position |
| **mean-area** | `20` px | rejects off-line decoration fragmented into many tiny pieces |
| plateau-adjacency | ≤ `PLATEAU_MERGE_DIST` | rejects plateau-adjacent shades (kept) |
| parent-box | ≤ 50% of region | rejects region-spanning blobs (kept) |

**The AA window is the colour-aware gate.** A candidate is rejected when it lies **on the
segment** from the component's reference to its extremal colour. Measured along that segment:

| case | t | residual | on the line? |
|---|---|---|---|
| dense_small card→text fringes | 0.048–0.994 | **≤ 0.5** | **yes** (fringe) |
| outlined text fill `#464646` | 0.237 | **7.4** | **no** (real ink) |
| dense-flat card strokes `#292f37` | 0.221 | **19.8** | no |

So correctness comes from **`maxResidual`**, once the window stops excluding the ends of the
segment (the general merge path's conservative `(0.25, 0.98)` is kept for the merge step; the
second-ink test uses the full segment).

**The mean-area gate is the structural gate** — the primary path's own doctrine:
a colour fragmented into many tiny pieces is decoration, not a text run. Measured pre-gate:

| class | mean area |
|---|---|
| real outlined fill `#464646` | **22–9048** |
| card→text fringes (dense_small, tiled) | **≤ 12** |
| dense-flat card strokes | 8–316 but ≤10 from a plateau (adjacency gate) |

The measured gap is **12 (decoration) → 22 (real ink)**; **20** sits in it. This is a
**different quantity** from the primary path's `MIN_TEXT_MEAN_AREA` (100): a fragmented run's
mean falls as text is **added** (F14), so 100 here hid real ink at mean 75–94 — measured. 20
keeps **recall 11/11** (AB/ABC/ABCDE at 20–30px all report `#464646@1.88`).

**Both gates are load-bearing** (non-vacuity): reverting the AA window fails 4 tests; removing
the mean-area gate fails 5. A mean-area-only or AA-only configuration does not work.

### What the suite does and does not assert — the answer to the audit's question

The auditor asked whether the suite asserts `all_meet_aa` for the in-process dense-panel
fixture, since F31 was invisible to CI. **Answer: the in-process fixture is a different
family.** `buildDensePanelFixture` is `#666460@2.47` — a **real** failure (the F10 dashboard),
not the tiled-cards family the auditor snapshotted. The auditor's `dense_small_cards` is the
`buildTiledCardsFixture` family, whose in-process form does **not** reproduce the regression
(measured: identical to the snapshot's structure but a different render). So the regression was
invisible to CI **by construction**, exactly as the auditor suspected.

Fixed by adding **`buildDenseSmallCardsFixture`** (dense small text on 16 cards), which
reproduces F31 in-process — verified: on the round-22 code it returns `all_meet_aa:false` with
`#534d45@1.75`, and on this code it is clean. It is now asserted by the F31 test.

### Acceptance evidence

| case | before | after |
|---|---|---|
| outlined 30px fill | hidden, `all_meet_aa:true` | `#464646 px=212` reported, `false` |
| plain 16px (control) | reported | reported (unchanged) — paths agree |
| dense_small_cards | `all_meet_aa:false`, `#443f38@1.4` | `all_meet_aa:true`, 1 colour |
| tiled cards / dense flat | clean | **clean** |
| acceptance fixture | worst `#1e1c18@1.04` | unchanged |
| `npm test` | 121 | **123** (F30 invariance pair, F31 dense-small-cards) |
| non-vacuity | 99 guards | **104** (+5 round-23; rounds 21/22 anchors repointed) |
| live MCP (scratch 11498) | — | §19: F30 paths agree, F31 fixed |

### The floor ratio, before and after

`224 / 8 = 28×` stricter → `8 / 8 = 1×` (unified). The quantity is now the tool's own reporting
floor, and the separation is done by the gates.

### What this audit has NOT proven

- I did not exhaust F30's band; the sweep covers 20–180px at one stroke width (2px), one
  background, Latin bold glyphs. Other scripts, weights, or a multi-plateau page could move the
  mean-area boundary.
- F31 is judged from the blend relationship and component structure; I reproduce it with a
  generated fixture, but the auditor's exact snapshot is a different render (its pixels differ).
- The mean-area constant 20 sits in the measured 12→22 gap with a small margin; sizes 19–22 are
  all suite-green, 18 fails, so it is a band, not a knife-edge — but a new fixture could narrow
  it.
- **Frequency unmeasured.** Small outlined text at label sizes is plausible but I did not count
  occurrences; this is a control-backed verdict error, not a prevalence claim.

## 5z. Twenty-fourth audit: the second-ink path diverged on a third axis — colour proximity

Round 23 (§5y) aligned the second-ink path with the primary path on **size** (unified floor)
and **accumulation grain** (per-total), but widened the AA test to the **full segment**
`{0, 1}`. That closed F31 and opened **F32**: a real fill that lies **on** the
reference→stroke line is now discarded by construction — the **third** consecutive round in
which the second-ink path diverged from the primary path, and each divergence produced a false
pass.

### F32 — a fill on the reference→stroke line is discarded

**Repro** (1000×700, background `#1a1814`, fill a colour *on* the `#1a1814`→`#ffffff` ramp,
3px white stroke). The `t`-sweep, now vs round 22:

| t | fill | contrast vs bg | round 22 (`11e6757`) | round 23 (`c91554c`) |
|---|---|---|---|---|
| 0.05 | `#252420` | 1.14 FAIL | **reported** | **ABSENT** |
| 0.10 | `#312f2c` | 1.33 FAIL | **reported** | **ABSENT** |
| 0.15 | `#3c3b37` | 1.58 FAIL | **reported** | **ABSENT** |
| 0.20 | `#484643` | 1.88 FAIL | **reported** | **ABSENT** |
| 0.25 | `#53524f` | 2.27 | absent | absent |

**Independent census** (`#312f2c`, tolerance 2): fill **17,291px**, white stroke **2,617px** —
the failing fill is **6.6×** the stroke. **No channel carries it** at round 23:
`all_meet_aa=true, failing_count=0, measurable=true; colours: [#ffffff@17.73]` — and the string
`#312f2c` appears **nowhere** in the response. The **primary path** reports the same colour at
the same ratio (`all_meet_aa=false, #312f2c@1.33`). It is the F30/F31 shape again, now on the
**colour** axis.

### The audit's proposed fix (#1) does not work — measured

The audit proposed a **residual-only** criterion, reasoning that "the measured discriminator is
residual (fringes ≤ 0.5 on the line; real ink 3.45–7.4 off it)". That is true for the F28/F29
fills — but **false for F32**: the `#312f2c` fill sits at **t=0.10, residual 0.4** — geometrically
**identical to a fringe**. So there is **no colour-space test** that keeps an on-line fill while
rejecting an on-line fringe; colour proximity cannot separate them. The discriminator is
**structure / size**.

### The fix — the AA test rejects a blend only when it is SMALL

```
blend = isAntiAliasingBlend(rgb2, rgb, compRef, {minT:0, maxT:1})
     || isAntiAliasingBlend(rgb, rgb2, compRef, {minT:0, maxT:1});
if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;   // MULTICOLOUR_AA_MIN_PIXELS = 500
```

A **fringe is a thin halo** (small per-component count); **real ink is large**. Measured
per-component `count2` of on-line blends: F32's fill reaches **9,306px**; the F31 fringes are
already removed by the plateau-adjacency gate before this point, and the dense-flat card strokes
by the mean-area gate. Grid over `MULTICOLOUR_AA_MIN_PIXELS ∈ {200, 300, 500, 800, 1000}`: suite
green, F32 reported, F31/dense-flat/tiled/F29 all correct.

### F33 — a pre-existing asymmetry, recorded not fixed

The audit also raised **F33**: the second-ink path carries a **mean-area** gate (20) that the
primary path does not — a second scalar for the same concept, at 2.5× instead of 28×. Two
measured findings:

- **It is pre-existing, not a round-23 regression.** The F33 table (small single-glyph ink
  reported on the primary path, absent on the second-ink path) is **identical at rounds 21
  (`a304c0e`), 22 (`11e6757`) and 23 (`c91554c`)** — verified by `git checkout`, not by reading
  the diff.
- **The audit's own table is indicative, not matched** (they flagged it as such), and its census
  does not reproduce: the true `#464646` fill at A@{10, 14, 16}px is **0px** (tolerance 2), not
  7–11px; at A@20px it is 8px, A@24px 32px, A@30px 105px. At 10–20px the fill is **not even a
  candidate component**.

**It must NOT be closed by unifying the floor to 8.** Measured: that re-admits the dense-flat
card strokes (`#355540@2.26`, 14,292px) and fails 4 tests. The mean-area scalar stays, with its
measured basis (decoration ≤ 12 vs real ink ≥ 22), and F33 is a **named, pre-existing** limitation.

### Alternatives measured and rejected

| candidate | measured outcome |
|---|---|
| residual-only AA (no t-window) | **would reject the F32 fill too** (residual 0.4) — does not work |
| largest-component floor (instead of mean) | breaks **F28-reversed** (the stroke fragments into small pieces) |
| "fragmented AND weak" gate (`comps ≥ 3 && mean < 100`, the primary constants) | fails F28/F29/F31 |
| mean-area floor 8 / 12 / 16 with the AA size-guard | 4 / 3 / 1 failures; **20** is the first green value |

### The three axes of divergence, and the lesson

The second-ink path has now diverged from the primary path on **three axes**, and **each
divergence produced a false pass**:

| round | axis | divergence | defect |
|---|---|---|---|
| 23 | size | its own floor (224 vs 8) | **F30** — 30px fill hidden |
| 23 | accumulation grain | per-component vs per-total | **F29** — split fill hidden |
| 24 | **colour proximity** | its own AA rule (reject any on-line colour) | **F32** — on-line fill discarded |

Each fix moved the divergence one axis over. The lesson, now written into the code: **the
second-ink path must not carry its own criterion for a quantity the primary path already
decides** — it shares the primary floor, the primary accumulation grain, and (from this round)
it no longer rejects by colour alone.

### Acceptance evidence

| case | before (round 23) | after |
|---|---|---|
| F32 `#312f2c` fill + white stroke | **ABSENT**, `all_meet_aa:true` | `#312f2c px=17226`, `false` |
| F32 t-sweep {0.05,0.10,0.15,0.20} | all ABSENT | **all reported**, each paired with the primary path |
| F31 dense_small_cards | clean | **clean** |
| F28 dark/light outlined | `#464646@1.88` reported | reported (unchanged) |
| acceptance fixture | worst `#1e1c18@1.04` | unchanged |
| `npm test` | 123 | **125** (F32 t-sweep pair, F33 named) |
| non-vacuity | 104 guards | **108** (+4 round-24) |
| live MCP (scratch 11498) | — | §20: every on-line fill reported |

### What this audit has NOT proven

- The `maxT = 1` (near-extremal) end. The t-sweep covered 0.05–0.30; the upper end is
  unmeasured, and an on-line colour near the **stroke** end could still be affected.
- How often a real screenshot contains a fill on the reference→stroke line (mid-tone grey on
  dark with a light outline — disabled buttons, placeholder text). Reachability and a
  control-backed verdict error are claimed; **prevalence is not**.
- F33 as a clean matched pair (the two renderings do not produce identical ink totals at a given
  size), and whether the mean is the right quantity — only that unifying to 8 re-admits the
  dense-flat strokes.
- Whether `MULTICOLOUR_AA_MIN_PIXELS = 500` is the correct value; it sits in a measured gap
  (F32 fill 9,306 vs fringes already gated earlier) and the grid is green from 200–1000.

## 5aa. Twenty-fifth audit: the per-piece error, fourth appearance — the AA size qualifier

Round 24 (§5z) fixed F32 by adding a **size qualifier** to the AA test. It used `count2` — the
count **within one component** — which is **F29's exact error, one guard over**. A real on-line
fill split across glyphs has every piece under the qualifier and is discarded wholesale. This is
the **fourth consecutive round** in which a second-ink-path gate used a per-piece quantity where
a total was meant.

### F34 — the AA size qualifier was per-component

**Repro** (`ABCDEFGHIJKLMNOP` @24px, white 2px stroke, fill `#312f2c`). Per-component
instrumentation:

| component | fill-in-box | on-line? | `< 500`? |
|---|---|---|---|
| #ffffff px=859 | 106 | true | **rejected** |
| #ffffff px=622 | 95 | true | **rejected** |
| #ffffff px=230 | 30 | true | **rejected** |
| … 16 glyphs, every piece 30–127px … | | | **all rejected** |

True total on-line fill = **610px**. Verdict at the defective revision: `all_meet_aa=true`,
`failing_count=0`, `colours=1` — `#312f2c` in **no channel**.

**The glyph-count sweep** (tolerance 2) shows the threshold is a lottery on how the fill
fragments:

| text @ size | true on-line fill | reported at HEAD |
|---|---|---|
| `AB` @180 | 17,291px | yes |
| `ABCDEFGH` @40 | 2,031px | yes (one piece reached 550px ≥ 500) |
| **`ABCDEFGHIJKLMNOP` @24** | **610px** | **ABSENT** |
| `ABCDEFGHIJKLMNOPQRST` @18 | 106px | absent |

### The fix — the qualifier uses the colour's ON-LINE total, decided in the deferred pass

The reject cannot be inline: at the moment each component is visited the running total may still
be below the threshold. So the **blend flag is recorded** on the candidate, its pixels are
accumulated into `extraBlendTotals` per colour, and the qualifier is applied in the **deferred
pass** where `total` is known:

```
// candidate loop — records, does not reject:
candidateExtras.push({ key: k2, rgb: rgb2, count: count2, dist: …, blend });
if (blend) extraBlendTotals.set(k2, (extraBlendTotals.get(k2) || 0) + count2);

// deferred pass — the total is now known:
const blendTotal = extraBlendTotals.get(extra.key) || 0;
if (blendTotal > 0 && blendTotal < MULTICOLOUR_AA_MIN_PIXELS) continue;
```

**Measured result** (all controls unchanged):

| case | before | after |
|---|---|---|
| `ABCDEFGHIJKLMNOP` @24 (610px) | **ABSENT** | **reported px=569** |
| `ABCDEFGH` @40 | reported | reported |
| F32 `#312f2c` / `#484643` matched pair | reported | reported |
| F31 dense small cards | `all_meet_aa: true` | `true` |
| dense-flat / tiled / photo | clean | clean |

### `MULTICOLOUR_AA_MIN_PIXELS` re-derived under the total quantity (500 → 500)

The audit asked whether the value should be re-derived once the criterion is total-based. It now
sits in a measured gap of **on-line totals**: fringes ≤ **164** (huge-glyph shades 50–164; F32's
own stroke shades 130–154) vs real on-line fills ≥ **569** (F34 @24px). **500** is inside that
gap, so the value stands — but it is now **justified against the total**, not the per-component
count. The grid over `{200, 300, 500, 800, 1200}` is green.

### The structural rule, and the four appearances

| round | gate | per-piece quantity | fix |
|---|---|---|---|
| 22 | pixel floor (F29) | `count2` per component | total across the scan |
| 23 | floor alignment (F30) | a second scalar (224) | the primary floor (8) |
| 23 | accumulation grain (F31) | per-component totals | per-total across the scan |
| **24/25** | **AA size qualifier (F34)** | **`count2` per component** | **on-line total in the deferred pass** |

The pattern is now the **dominant failure mode of this subsystem**. The structural rule adopted:

> **In the second-ink path, no gate may use a per-component quantity without stating why the
> total is wrong.**

This is written into the code at the candidate loop and the deferred pass. The remaining inline
gates were audited for the same ordering issue:

- **plateau-adjacency** — a **colour** test against a detected plateau (not a count), so it is
  order-independent; safe.
- **background-size** — uses `count2 / scanArea` (per-component). A background colour split
  across components could currently evade it. **Not a live defect** on any fixture (no fixture
  exercises it), and it is the conservative direction (under-rejects background rather than
  discarding ink), but it is the same shape and is **named here** as a latent risk.
- **mean-area** (deferred) — already total-based.

### F33 — one correction to the audit's own reproduction

The audit re-ran the F33 table across rounds and found it *mostly* pre-existing with **one** entry
that round 23 changed (`A 24px`: absent → reported), which they correctly labelled an
**improvement**, not a regression. Accepted: the earlier "identical at 21/22/23" was very slightly
off, in the direction of the fix having helped. F33 remains **indicative only**.

### Acceptance evidence

| case | before | after |
|---|---|---|
| F34 16 glyphs @24px | `all_meet_aa:true`, fill in no channel | `#312f2c px=569`, `false` |
| glyph-count sweep {2,4,8,16} | non-monotonic | once reported, stays reported (count-invariant) |
| `npm test` | 125 | **126** (F34 count-invariance test) |
| non-vacuity | 108 guards | **112** (+4 round-25; round-24 anchor repointed) |
| live MCP (scratch 11498) | — | §21: 16 glyphs reported, count-invariant |

### What this audit has NOT proven

- The fix beyond this repo's fixtures. The 500 qualifier is justified by the on-line total gap
  (164 → 569) on the standing fixtures; a different font, stroke width, or region size could move
  it.
- Whether the **background-size** inline gate is ever reached with a genuinely split background
  colour — no fixture exercises it; it is named as a latent risk, not a demonstrated defect.
- F33's status beyond "indicative, mostly pre-existing".

## 5ab. Twenty-sixth audit: the per-component error produces a FALSE POSITIVE, and the fix was not the one proposed

Round 25 (§5aa) closed F34 by moving the AA size qualifier to the colour total. The audit then
reported **F35** — a colour whose **total** is region-sized but which is split into small pieces
— and diagnosed it as the **fifth per-component gate**, naming the **second-ink background-size
test** (`count2 / scanArea`). **The reproduction stands; the attribution is wrong**, and so is
the proposed fix. Both corrections are measured below.

### F35 reproduced, and attributed

A near-background decoration (`#2e2a24`, contrast **1.24**) drawn as **solid rectangles** whose
**total** clears the 2% region fraction but whose **pieces** do not:

| pieces | piece size | total | share of region | verdict |
|---|---|---|---|---|
| 1 | 200×75 | 15,000px | 2.14% | filtered |
| 4 | 100×37 | 14,800px | 2.11% | filtered |
| **16** | **50×18** | **14,400px** | **2.06%** | **reported @1.24 — false positive** |
| **36** | **34×12** | **14,688px** | **2.10%** | **reported @1.24 — false positive** |

**Provenance: pre-existing since round 21.** Identical at `a304c0e` (r21), `11e6757` (r22) and
`dc74fef` (r26) — reachable the whole time, not introduced by any recent round.

### Correction 1 — the admitting gate is the PRIMARY path's, not the second-ink one

The audit named the second-ink background-size gate. **Measured: disabling that gate does not
change F35 at all.** The colour is emitted as **primary components** (`component_count: 16,
multi_colour_of: none`) — it never travels the second-ink path, so that gate never sees it. The
admitting gate is the **primary path's `isLargeBackgroundRegion`**, which used
`meanArea / regionArea > 0.02` — a **mean per blob**, the **F14 anti-correlation** ("the mean
falls as N grows") appearing in the primary path.

So F35 is **not** the fifth second-ink instance. It is the **same root cause** ("a per-piece
quantity where a total was meant") in a **different subsystem** — which strengthens the audit's
structural point even though its specific attribution was wrong.

### Correction 2 — switching the mean to the total would trade a false positive for a false negative

The audit's fix #1 was "move the background-size gate to the deferred pass on the total". Applied
to `isLargeBackgroundRegion`, that means replacing the mean by the total fraction. **Measured,
that regresses real text**:

| case | total % of region | mean-based | **total-based** |
|---|---|---|---|
| faint text, 5 lines @18px | 1.41% | keep | keep |
| **faint text, 15 lines @18px** | **4.29%** | keep | **FILTER (regression)** |
| **faint text, 28 lines @16px** | **6.31%** | keep | **FILTER (regression)** |
| **faint text, 28 lines @20px** | **9.30%** | keep | **FILTER (regression)** |

A large run of real faint text has a **total** above the region fraction. That is exactly why the
original code chose the mean ("real faint text is ~1000× smaller per blob"). The mean is a
**proxy for solidity** — and its failure mode is that it is also anti-correlated with count.

### The measured fix — total **and** solidity, with the mean test retained

The faithful separator is **solidity**: a panel/region blob is a **solid rectangle** (`fill_ratio`
≈ 1.0); glyph strokes are not (measured **0.37–0.6**). Measured across F35 and 13 real fixtures:

| class | total % | mean fill_ratio |
|---|---|---|
| F35 decoration (16/36 solid rects) | 2.06–2.10% | **1.00** |
| real glyph runs (acceptance, dropcap, text-heavy, dense-text, tiled, …) | ≤ 0.58% | 0.05–0.62 |
| faint text worst case (28 lines @16px) | 5.84% | 0.55 |

The gate becomes:

```js
lowContrast &&
(meanIsRegionSized                                  // the ORIGINAL F7 backstop (textured page, n=1, 33%)
 || (totalIsRegionSized && mean_fill_ratio >= 0.9)) // F35: split decoration
```

Both clauses are **load-bearing** (non-vacuity): reverting to the mean-only form re-admits F35;
dropping the mean clause filters F32/F34's solid on-line fills; lowering the solidity threshold
filters them too. `isLargeBackgroundRegion` is unchanged for the F7 textured page (a single
33%-of-region **non-solid** blob) because the **mean clause is retained**.

### The two directions, and the count-invariance test

The per-component error now demonstrably produces errors in **both** directions:

```
per-component quantity where a TOTAL was meant
  ├─ false negative: a real fill SPLIT below a floor      F29, F30, F31, F32, F34
  └─ false positive: a decoration SPLIT below a background gate   F35
```

That is the signature of a **design error, not a bug** — five instances, two directions, six
gates. The audit's recommendation — a single total-based pass rather than gate-by-gate patching,
plus a **count-invariance** standing test — is **adopted**:

- **COUNT-INVARIANCE is now a standing acceptance test**: for a fixed ink total, the verdict must
  not change with the piece count (1/2/4/8/16 for real ink → reported; 1/4/16/36 for decoration →
  filtered). That single test **would have caught all six**.
- All remaining second-ink gates were already total-based (floor, AA qualifier). The
  **background-size** inline gate (`count2 / scanArea`) is now **documented as latent** — it is
  not reachable on any fixture and is the conservative direction, but it is the same shape.

### Acceptance evidence

| case | before | after |
|---|---|---|
| F35 split decoration (n=16, n=36) | `#2e2a24@1.24` reported, `all_meet_aa:false` | **filtered**, `all_meet_aa:true` |
| F7 textured page (n=1, non-solid) | background region | **still a background region** |
| F32/F34 solid on-line fills | reported | reported |
| count-invariance (real ink 1→16) | — | reported in **every** case |
| `npm test` | 126 | **128** (F35 + standing count-invariance) |
| non-vacuity | 112 guards | **116** (+4 round-26) |
| live MCP (scratch 11498) | — | §22: every split decoration filtered |

### What this audit has NOT proven

- Whether the **background-size** inline gate is reachable in a real screenshot (no fixture
  exercises it; named as latent).
- That the solidity threshold (0.9) is universal — F35's pieces are `fill_ratio 1.0` and real
  glyph runs 0.05–0.62, so the gap is wide, but a synthetic solid **glyph** (a filled block
  character) could sit above 0.9; none is in the standing set.
- Whether **other** subsystems outside the second-ink path carry the same per-piece shape; only
  `isLargeBackgroundRegion` was audited and fixed here.
- The audit's own framing that this is the fifth **second-ink** instance — corrected above; it is
  the same root cause in the **primary** path.

## 5ac. Twenty-seventh audit: the verification round — the standing test half-covered its own claim

This was the **verification round** the audit asked for after adopting its stopping criteria
(§5ab). Result: the F35 fix is **correct**, both clauses are **load-bearing**, the subsystem is
in the right place — and the **standing count-invariance test did not cover the path its comment
claimed**. That is the same family as the F16/F17/F19/F26 findings: **a claim no test verifies**.

### F35 verified fixed, and the two clauses are independent

| pieces | total | verdict |
|---|---|---|
| 1 | 40,000px | filtered |
| 4 | 40,000px | filtered |
| 16 | 59,536px | filtered |
| 36 | 57,600px | filtered |

Reconstructed from the source and re-derived by **perturbation, not by reading**:

| perturbation | result |
|---|---|
| revert to the pre-F35 mean-only rule | **126/128** — `COUNT-INVARIANCE` **and** `F35` fail |
| `LARGE_REGION_SOLID_FILL 0.9 → 0.2` | fails (filters solid on-line ink) |
| drop the mean clause (total+solid only) | fails (F7 textured-page backstop) |

So the **mean clause protects the F7 backstop** and the **total+solid clause protects F35** — the
two are genuinely independent, which is why the OR is the right shape. The round-26 attribution
correction also holds: this is the **primary-path** `isLargeBackgroundRegion`.

### The gap — the count-invariance test's part (a) never entered the second-ink path

The comment claimed the test *"would have caught F29, F30, F31, F32, F34 and F35."* Measured by
re-introducing each defect and running **this test**:

| defect re-introduced | does `COUNT-INVARIANCE` fail? |
|---|---|
| F34 — per-component AA qualifier | **no** (old construction) — only `F34: …` failed |
| F32 — AA window rejecting all blends | **no** (old construction) |
| F35 — mean-only region rule | **yes** |

**Why.** Part (a) drew each piece as a **stroke element and a fill element separately**, so the
fill became its **own** component — a **primary** colour with **`extras = 0`**:

```
n= 1: reported=YES multi_colour_of=PRIMARY | components=1  extras=0
n= 4: reported=YES multi_colour_of=PRIMARY | components=4  extras=0
n=16: reported=YES multi_colour_of=PRIMARY | components=16 extras=0
```

The second-ink path is never entered, so part (a) exercised the **primary** path's size handling
(which is why it caught F35's class) but could not see F29/F30/F32/F34.

### The remedy — measured, then applied

Putting the fill and its outline in **ONE element** (`<rect fill=… stroke=…>` or a stroked
`<text>`) makes the fill a genuine `multi_colour_of` extra. Calibrated at a **fixed total of
2000px**:

| n | extras | fill total | max piece |
|---|---|---|---|
| 1 | 1 | 1681px | 1681 |
| 2 | 2 | 1568px | 784 |
| 4 | 4 | 1296px | 324 |
| 8 | 8 | 1152px | 144 |
| 16 | 16 | 784px | 49 |

Every count is a genuine **second-ink** case, and the pieces **cross the per-component qualifier**
(1681 → 49). With that construction the sweep **reacts to the F34 defect**: re-introducing the
per-component AA qualifier makes n=4/8/16 vanish (`second-ink: … n=4` fails), while the current
code reports all five.

### The corrected, narrowed claim (now backed by measurement)

Part (a) is now this second-ink construction; part (b) keeps the **primary** path (a bare filled
rectangle) explicitly labelled; part (c) keeps the decoration sweep. The comment now states the
**measured** coverage:

```
F32 (reject any blend)            -> caught (second-ink, n=1)
F34 (per-component AA qualifier)  -> caught (second-ink, n=4/8/16)
F35 (mean-only region rule)       -> caught (decoration, n=16/36)
F29 / F30 / F31                   -> NOT caught here; each has its own test
```

The last line was **measured**, not assumed: re-introducing the F29 (per-component floor), F30
(floor 224) and F31 (structure gate removed) defects leaves this test **green**. Claiming they
were covered would have been the very defect class this round is about.

### Acceptance evidence

| case | before | after |
|---|---|---|
| F35 (n=1/4/16/36) | filtered | filtered |
| count-invariance vs F34 defect | **not caught** | **caught** (`n=4`) |
| count-invariance vs F32 defect | **not caught** | **caught** (`n=1`) |
| count-invariance vs F35 defect | caught | caught |
| count-invariance vs F29/F30/F31 defect | not caught | **not caught — stated** |
| `npm test` | 128 | 128 |
| non-vacuity | 116 guards | **118** (+2 coverage cases) |

### The stopping criteria, honoured

This round found **one** item, and it is a **test-coverage/scope** gap — the same family as the
stale anchor and vacuous-guard findings, not a new engine defect class. Per the criteria adopted
in §5ab, **the loop is closed here** unless a **new mechanism** appears (multi-plateau ×
solidity, image fills, shadows) — not another instance of the per-piece error.

### What this audit has NOT proven

- That the calibrated second-ink sweep transfers to other fonts, weights or stroke widths; it was
  calibrated at one construction (DejaVu Sans bold, 3px stroke, fixed total 2000px).
- That F29/F30/F31's own tests are individually sufficient — only that this standing test does not
  cover them, which is now stated.
- That no other subsystem hides an unverified scope claim; only this test's comment was audited.

## 5ad. Twenty-eighth audit: closing verification — one stale item corrected

The closing verification round: the auditor independently reproduced the count-invariance
**six-of-six** coverage claim (including the three **negative** claims), re-ran the
solidity × multi-plateau interaction (no finding), and confirmed the deploy current and the
standing regression set unchanged. I re-derived all of it from the tree and agree, with **one
correction** to the round's own summary.

### Verified independently

| check | result |
|---|---|
| `npm test` | **128/128** |
| non-vacuity harnesses | **27/27**, 118 guards |
| `lib/measure.js` vs HEAD | unchanged (empty diff) |
| 11402 functional probe | F34 16-glyph **reported**; F35 split decoration **filtered** |
| count-invariance coverage, six defects re-introduced | F32/F34/F35 **caught**; F29/F30/F31 **not caught** — exactly as the comment claims |

The last row is the important one: I re-introduced each of the six historical defects and ran
**only** the standing test, confirming all **six** claims (three positive, three negative).

### The correction — the "300px single-glyph abstention" is stale

The round-28 summary listed, as a live reopen candidate: *"the pre-existing 300px single-glyph
abstention (recorded in round 22 as identical at HEAD, still open, and still hiding a failing
fill)."* **Measured, that is not true at HEAD**, and the round-22 phrasing it quotes was itself
imprecise about disclosure. A `W` at 300px with a 3px stroke:

| revision | verdict | `#464646` disclosed? |
|---|---|---|
| round 21 (`a304c0e`) | `all_meet_aa: null` (abstained) | yes (plateaus + note) |
| round 23 (`c91554c`) | **`all_meet_aa: false`** (correct FAIL) | yes |
| HEAD (`a6cc6d2`) | **`all_meet_aa: false`** | yes |

So **round 23 incidentally fixed the 300px case** — it now reports a correct failure. A
`fontSize ≥ ~700` glyph still abstains — **but** with `#464646` disclosed in `plateaus`
(28.8%) and the scope note *"No text was found there; that is not a claim that such text passes
contrast."* So even the surviving abstention **is not silent**: the disclosure invariant holds.

A sweep of **108** large-glyph cases (sizes 120–700, strokes 0/2/3/6, `W`/`OO`/`II`) found
**no case** where the verdict reads clean while a failing fill goes undisclosed. The two
`II@300` cases that looked clean (`all_meet_aa: true`) **do name `#464646` at 1.88:1 in
`mask_reconciliation`** — disclosed, not hidden.

**Disposition:** the item is **reclassified from "open defect" to "behaviour, disclosed"**. It is
therefore **not** a reason to reopen. The remaining reopen candidates are unchanged: three-or-more
ink colours in one component, gradient/image fills, and shadows/glows.

### What this correction is (and is not)

It is the **documentation-of-scope** family again — a recorded claim ("still open … still hiding
a failing fill") that a measurement contradicts. It is **not** an engine defect: no construct
hides a failing fill at HEAD. Correcting it rather than inheriting it is the same discipline the
round-27 gap required.

### What this round has NOT proven

- Only the solidity × multi-plateau interaction was probed as a new mechanism; the other
  candidates (≥3 ink colours, image fills, shadows) remain **untested**.
- The abstention at `fontSize ≥ ~700` is **not silent**, but I did not establish whether a
  downstream consumer *acts* on `plateaus`/notes; the API carries the disclosure, which is the
  contract this project defends.
- Frequency of any construct remains unmeasured — reachability plus a control-backed verdict
  error, not prevalence, throughout.

## 5ae. Twenty-ninth audit: F36 — a soft shadow is reported as failing text

Round 28 closed with an explicit reopening criterion: a **genuinely new mechanism**, not another
instance of the per-piece class. This round reopened on exactly that, and the mechanism is real —
but the audit's *prescribed* fix had to be verified against controls before it was adopted, which
is what this section records.

### The finding (reproduced, one property different)

A soft drop shadow under a card — pure decoration, no text — was reported as a colour that
**fails** AA, and it is the only failing colour, so it set `worst` and `all_meet_aa: false`:

| fixture (1000×700) | `all_meet_aa` | failing |
|---|---|---|
| card, **no** shadow | `true` | 0 |
| card, **+ soft shadow** (`σ=14`) | **`false`** | **1 — `#0c0b09@1.35`** |
| card, **+ tight shadow** (`σ=4`) | **`false`** | **1 — `#0a0a08@1.36`** |
| shadow alone, no card | `false` (single-plateau residual, below) | 1 — `#0a0a08@1.04` |

`#0c0b09` / `#0a0a08` are the blurred shadow (a page↔card blend). The only difference between rows
1 and 2 is the shadow.

### The mechanism (traced, then corrected)

On a two-plateau page (page + card) the shadow is emitted as a **second-ink extra** of the shadow
component. Direct `extractInkComponents` measurement:

```
parent  #0c0b09  px=40860  fill_ratio=0.2214  box=728x468  hollow=true  struct=true
extras  #12110e … #0f0d0b (10 of them)  box=728x468  hollow=false struct=false   <-- hard-coded
```

The parent is a large **HOLLOW ring** (fill 0.2214) — decoration, which the primary path would
drop via `isDecorative` (`cl.hollow === cl.boxes.length`). But the emitted extra hard-coded
`looks_like_hollow_rectangle/straight_segment/structure: false` (round 25), so for the extra
`cl.hollow === 0` and `isDecorative` was **false**. The extra bypassed the decorative gate purely
because the construction site *asserted* non-structural.

This is the audit's **F36**: *an extra is by construction a sub-colour of the parent component it
was carved out of — it shares the parent's box and `fill_ratio` — so it cannot be LESS structural
than its parent.* The hard-coded `false`s are a **construction-site default**, not a per-component
quantity, so the per-piece rule is not the one violated here.

### The fix (Fix 1) and why it is faithful, not tuned

Copy the parent's own structural flags onto the extra:

```js
looks_like_hollow_rectangle: parent.looks_like_hollow_rectangle,
looks_like_straight_segment: parent.looks_like_straight_segment,
looks_like_structure: parent.looks_like_structure,
```

The discriminator is the **parent's own box geometry**, measured:

| extra | parent | parent `fill_ratio` | parent hollow/struct |
|---|---|---|---|
| shadow `#0c0b09` | `#0c0b09` (primary 40860px, 728×468) | **0.2214** | **true** |
| F28 `#464646` | `#e8dfd0` (stroke) | 0.5463 | false |
| F32 `#312f2c` (180px) | `#ffffff` (stroke) | 0.5463 | false |
| F34 `#312f2c` (24px) | `#ffffff` (stroke) | 0.7304 | false |

A real outlined-text fill's parent (its stroke) is **not** hollow (0.55–0.73); the shadow's parent
is (0.2214). No threshold is introduced — the fix copies an existing, independently-computed flag.
The shadow routes into the **existing** decorative gate and is **disclosed** (`excluded`, reason
*"decorative: thin hollow rectangle geometry (border/rule), not text"*, geometry `all_hollow: true`),
never silently dropped. `skipped` is empty.

`isLargeBackgroundRegion` **cannot** be the fix, and the audit is right about why: `solid` needs
`mean_fill_ratio ≥ 0.9`, but the shadow is a hollow ring (`0.221`). Retuning `LARGE_REGION_SOLID_FILL`
downward would classify real textured fills as regions (F7's backstop depends on that clause).

### Measured no-regression (a stable control digest, before vs after)

A 25-case digest (shadow triad + every F28–F35 control + the real regression fixtures + the
negative direction) diffed byte-for-byte before and after the changes. **Fix 1 alone** changed
**exactly three lines**:

| case | before | after |
|---|---|---|
| shadow soft `σ=14` | `false`, `#0c0b09@1.35` reported | **`true`**, `#0c0b09` **disclosed** |
| shadow tight `σ=4` | `false`, `#0a0a08@1.36` reported | **`true`**, `#0a0a08` **disclosed** |
| hollow **border ring** | `false`, `#2a2824@1.2` reported | **`null`**, `#2a2824` **disclosed** |

The third line is a bonus correction in the **same direction**: `#2a2824` is the AA fringe of the
already-excluded border stroke `#3a3733` — reporting a border's fringe as failing text was itself a
false positive of the class. Every other case — F28, F32, F34, F35 (n=1/4/16/36), F7 textured page,
dense small cards, dense flat, decorative bars, the contrast fixture, plain low-contrast text, a
solid region block — is **byte-identical**.

### F37 — the single-plateau residual, fixed too (its own mechanism)

The audit stated *"single-plateau pages are immune"* (§3). **Measured, that is not complete.** A
shadow plus text on a flat page with **no card** makes **one** component whose extremal colour is
the **text** (`#e8dfd0`), so the shadow tone becomes its **extra** and was reported as failing
text — in **GLOBAL mode** (`#151413@1.04`, pre-existing at HEAD, verified by stashing the patch).
Local mode was **already clean** at the pre-round-29 revisions (`a6cc6d2`, `c700845`) — reproduced
in a worktree at `a6cc6d2` in round 30. (An earlier version of this text, and commit `a316f23`,
said "in **both** modes"; that was wrong and is corrected here.)

| fixture | default (global) | local |
|---|---|---|
| shadow + text, no card, `σ=14` | **`false`**, `#151413@1.04` | `true` |
| shadow + text, no card, `σ=4, 8, 20, 30` | `true` | `true` |
| shadow + text, no card, `fs 34/80` | **`false`** | `true` |

This is a **different mechanism** from F36: the parent is not hollow — it is **near-solid and
region-spanning** (`box 728×468 = 48.7%` of the region, `fill_ratio 0.996`, ink 41% of the region,
`plat=true`).

**The existing gate already states the rule.** `MULTICOLOUR_PARENT_MAX_BOX_FRACTION` carries the
comment *"A GLYPH component cannot SPAN the region: if it does, the 'second colour' is field
shading, not text"* — the exact F37 principle. Its value was **0.5**, documented as sitting "in the
measured gap", but that placed it at the gap's **text-facing edge**: F37's parent is **0.4867**, so
it slipped under. Measured, real second-ink parents are **≤ 0.0386** of the region across every
outlined-text fixture (F28/F32/F34, sizes 24–600px, 1–16 glyphs) and the count-invariance sweep,
while decoration parents are ≥ 0.4867. The threshold is now **0.2** — inside the gap with ~5× margin
on the text side and ~2.4× on the decoration side. No new gate was added; the existing one was
placed where its own comment said it should be.

**The two fixes are independently necessary** (each measured alone):

| config | small hollow ring (200×150) | F37 single-plateau shadow |
|---|---|---|
| Fix 1 (copy flags) + threshold 0.2 | clean | clean |
| **Fix 1 only** (threshold 0.5) | clean | **reports `#151413@1.04`** |
| **threshold only** (no Fix 1) | **reports `#2a2824@1.2`** | clean |

The small ring is the discriminator: it is small enough to pass the box gate, so **only** Fix 1 can
filter its fringe. This is why the F36 test uses a **small** ring — it makes Fix 1 non-vacuous.

### What the audit's account did not have

1. **The single-plateau case is a second, distinct defect (F37), and it is fixed** — not "recorded".
   The audit's §3 called single-plateau pages immune; measured, they are not.
2. **The proposed Fix 1 was verified, not assumed** — against the discriminator (parent holowness)
   and a 25-case control digest before adoption. Two overlapping fixes were also ruled out by
   measuring each in isolation (the small-ring probe).

### Verification

| check | result |
|---|---|
| `npm test` | **130/130** (128 + the F36 and F37 acceptance tests) |
| non-vacuity harnesses | **28/28**, **124 guards** (118 + round-29's 6) |
| control digest before vs after | 5 lines changed, all improvements; 20 identical |
| `verify/nonvacuity-round29.mjs` | 4 perturbation guards + 2 construction-site invariants, all **NON-VACUOUS** |
| COUNT-INVARIANCE coverage of F36/F37 | **not caught** (measured) — recorded in the standing test's comment |
| live 11402 (pre-deploy) | F34 reported, F35 filtered (deployed build); F36/F37 verified on scratch |

### What this round has NOT proven

- Only the **shadow/glow** candidate was probed as a new mechanism. The others (≥3 ink colours in
  one component, gradient/image fills) remain **untested**.
- The F37 threshold (0.2) is chosen from a measured gap (text ≤ 3.9%, decoration ≥ 48.7%) with a
  ~5× text-side and ~2.4× decoration-side margin; a single-ink colour whose parent is a
  *mid-sized* panel (5–48% of the region) would still emit extras — unmeasured, and not observed.
- Frequency remains unmeasured — reachability plus a control-backed verdict error, not prevalence.

## 5af. Thirtieth audit: the verdict field contradicted the tool's own cross-check (F38)

F36/F37 were verified by the auditor (independently), and the `0.5 → 0.2` threshold change
**withstood** an attack sweep (real outlined-text parents measured ≤ 0.0627 across sizes 100–420px,
so 0.2 keeps ~3.2× margin). This round also carried **a correction against me** and a **new
mechanism**.

### The correction (a measured claim that stopped being true)

The F37 test comment and commit `a316f23` claimed the residual held *"in **both** background
modes."* Reproduced in a **worktree at `a6cc6d2`** (pre-round-29 code): **global** `all=false`
`#151413@1.04`, **local** `all=true` (clean) — so **local was already clean**, and the claim was
false. Corrected in the test comment, `CHANGELOG.md`, and §5ae. This is the same failure mode the
loop has fought all along: a measured claim kept after the measurement stopped supporting it. (My
own round-29 probe had printed local-clean; I still wrote "both modes." The lesson is to write the
claim from the run in front of me, not from the narrative around it.)

### The finding (F38, reproduced and traced)

A large outlined glyph's failing fill leaves the **global** verdict at ≥240px, while the per-tile
(**local**) model still finds it — so the response read `all_meet_aa: true` and, in the same object,
`model_disagreement` naming `#312f2c at 1.33:1`:

| font size | global `all_meet_aa` | global `colours` | `model_disagreement` |
|---|---|---|---|
| 200 / 220 / 230 | `false` | `#312f2c@1.33` present | `null` |
| **240** | **`true`** | `#ffffff` only | **names `#312f2c@1.33` (25,788px)** |
| 300 / 400 / 500 | **`true`** | `#ffffff` only | names it |

The raw census at 240px is `#312f2c` = **25,788px**; the fill fails AA at every size. The
transition is a **step** between 230 and 240 — non-monotonic except in component size.

**Mechanism (traced, beyond the auditor's account).** The drop happens **inside
`extractInkComponents`**, and by **two** gates that apply the same 2%-of-region test:

1. the candidate-loop **region-size extras gate** (`count2/scanArea > LARGE_REGION_AREA_FRACTION
   (0.02) && contrastRatio < 1.5`) — the *per-component* count crosses 2% at 240px (21,039px =
   3.0%) but not at 230px (1.92%);
2. `isLargeBackgroundRegion`'s **per-blob mean** clause (mean ≥ 2% of the region).

Measured: with gate (1) disabled, the fill is emitted as **two** components (mean ~2.09% ≥ 2%) and
gate (2) then filters it — which is why disabling (1) alone does **not** recover it. **No constant
is retuned**: gate (2) is F7's textured-page backstop (`LARGE_REGION_AREA_FRACTION = 0.02`).

### The fix (the class, not the cliff)

The project's own invariant, already in the response, is the answer: *"no response may read
`all_meet_aa: true` with no caveat while a text run in scope fails contrast and an available mode
returns it."* The caveat existed — but as a **note**, while `all_meet_aa` is a **field**. A field
that says `true` while the tool's own cross-check names a failing colour is a contradiction.

So the fix is at the **verdict**, not the extraction: when the cross-check finds a failing colour
the global model missed, the verdict **abstains** — `all_meet_aa: null` with a new three-valued
`verdict: "unverified"` (and `"clean"` / `"failing"` otherwise). `all_meet_aa` follows `verdict`
(`clean → true`, `failing → false`, `unverified → null`). The failing colour is already named in
`model_disagreement.local_failing_colours`, so nothing is hidden; and no colour is synthesised into
`colours`, so the independent gates the older guards exercise stay observable (a first attempt that
**adopted** the colour made two guards vacuous — the same over-broad signal as round 29's F37).

**This changes F6/F7 too, deliberately and consistently.** The shallow-gradient and textured-page
responses already told the caller to *"treat the clean verdict as UNVERIFIED"* — so their field now
says the same. That is the doctrine: **a field that disagrees with its own warning is the bug.**
Those two tests are updated to the honest contract (`all_meet_aa: null`, `verdict: "unverified"`).

### Verification

| check | result |
|---|---|
| `npm test` | **131/131** |
| non-vacuity harnesses | **29/29**, **128 guards** |
| `verify/nonvacuity-round30.mjs` | 2 perturbation guards + 2 construction-site invariants, all **NON-VACUOUS** |
| size band (200–500) | invariant holds: no `all_meet_aa:true` with a disagreement |
| 220px control | `false`, `#312f2c@1.33` in `colours`, no disagreement |
| clean large-glyph control | `true`, `verdict: "clean"`, no disagreement |

### What this round has NOT proven

- The precise expression in the extraction path that makes the fill cross the region fraction at
  240px was **located to two gates** but not re-derived from first principles; the fix does not
  depend on which fires first (it acts on the verdict).
- The F37 mode correction relied on a worktree at `a6cc6d2`; I did not re-run `c700845` separately
  (its `lib`/`index.js` are byte-identical to `a6cc6d2`, verified in round 29).
- Untested reopen candidates are unchanged: **≥3 ink colours in one component**, **gradient/image
  fills**.

## 5ah. Thirty-first audit: the F38 fix's own contradiction, and a witness that was the background

F38 was verified fixed (band sweep holds; a false-negative attack — turning a `failing` into
`unverified` — **failed**, because the abstention is gated on `allMeetAA === true`). The drift was
confirmed to be exactly **F6 + F7**. But the fix had carried three mechanical gaps, and left one
real decision.

### G1 — the abstention note contradicted the response's own `adequate` field

`background_fit.adequate` is `explained_fraction >= 0.5` (`lib/measure.js`), but the note branched
its wording on `GOOD_FIT_FRACTION` (**0.8**). At the top of the size band the two disagree, so the
500px response said `adequate: true` **and**, in the same object, that the background "varies ...
not to be trusted" — the exact note-vs-field contradiction F38 exists to remove, reintroduced.
**Fixed** by testing the premise with the predicate the response actually **publishes**
(`backgroundFit.adequate`), so the two can never disagree. No behaviour change; the wording is now
*"even though the single global background is an ADEQUATE model here"*.

### G2 — a local witness that IS the background could force the abstention

At 400/500px the local witness list included `#1a1814@1:1 (20,428px) vs #1a1814` — the page colour
itself (distance 0). A local "witness" within the platform's colour-merge distance of the
background it was measured against is the local model's **known over-report** (the note the project
ships warns of it), not text. **Fixed**: such witnesses are filtered before they can abstain. This
is **necessary but not sufficient** for F7 (see below); it removes only the indefensible `1:1` case.

### G4 — `verdict` was `undefined` on the abstention early-returns

Both abstention early-returns set `all_meet_aa: null` but not `verdict`, so a caller following the
"prefer `verdict`" advice got `undefined` (the doc comment recommends it). Both now carry
`verdict: "unverified"` **and** `wcag_aa: null`, consistent with the main path. Asserted in a test.

### G5 / F7 — a decision, not a constant (NOT fixed this round)

The honest discriminator I earlier proposed (`explained_fraction >= 0.8`) is **falsified**: F38's
500px case sits at **0.776**, inside its own acceptance band, so it would return `true` for the very
case the fix exists to stop. And **F7's contract genuinely changed**: its witnesses
(`#15130f@1.27`, 35,586px; `#1f1d19@1.15`) are **page-texture tones, not text** — measured from the
fixture (`buildTexturedPageCardsFixture` draws a noisy `#1a1814` page with only `#e8dfd0` KPI text),
and `isLargeBackgroundRegion` does **not** catch them (a fragmented texture, 421 components, mean
84px, near-background distance 37). Classifying them needs a fragment/mean rule — a real change that
**must not** be folded into a mechanical round. **Recorded as open**; F7 stays `unverified`
(conservative) until its own measured round. F6's witness (`#8c8c8c`, the fixture's declared
`darkText`, 8 components, mean 415px, distance 142) **is** genuine text, so **F6's abstention is
defensible**.

### Correction to the record

Both **F6** and **F7** now return `all_meet_aa: null` / `verdict: "unverified"` (round 30), where
they were previously recorded as `all_meet_aa: true`. Stated explicitly here.

### Verification

| check | result |
|---|---|
| `npm test` | **132/132** |
| non-vacuity harnesses | **30/30**, **132 guards** |
| `verify/nonvacuity-round31.mjs` | 3 perturbation guards + 1 construction-site invariant, all **NON-VACUOUS** |
| live `verify-background-live.mjs` on 11402 | **no red checks** (the round-5 F6 check was updated to the new contract) |

## 5ai. Thirty-second audit: the witness filter deleted the worst text (F39)

Round 31's G2 filter kept a local witness only when
`rgbDistance(witness, background) > PLATEAU_MERGE_DIST` (12). `rgbDistance` is **Euclidean**, so
12 is only ~**6.9 per channel**, and **low-contrast text is by construction the closest to its
background** (contrast 1.03–1.14 spans distance ~5–21). So the filter deleted the **most** failing
text and the verdict read `clean` — the **opposite** direction from F38, produced by F38's own
follow-up. Reproduced (fs=300, fill shifted k/channel from the page):

| k | fill | euclid | round-30 | round-31 (G2) | **round-32** |
|---|---|---|---|---|---|
| 3 | `#1d1b17` | 5.2 | unverified | **clean** | **unverified** |
| 4 | `#1e1c18` | 6.9 | unverified | **clean** | **unverified** |
| 5 | `#1f1d19` | 8.7 | unverified | **clean** | **unverified** |
| 6 | `#201e1a` | 10.4 | unverified | **clean** | **unverified** |
| 7 | `#211f1b` | 12.1 | unverified | unverified | unverified |
| 10 | `#24221e` | 17.3 | unverified | **clean** | clean (cause b) |
| 16 | `#2a2824` | 27.7 | unverified | **clean** | clean (cause b) |
| 24 | `#32302c` | 41.6 | unverified | unverified | unverified |
| 40 | `#42403c` | 69.3 | failing | failing | failing |

### The fix — separate the DECISION from the NAMING

The two quantities were collapsed and the wider one became the decision. They are now distinct:

- **decisive** — what may force an ABSTENTION: any failing colour **not identical** to the
  background it was measured against (distance **0**). An identity witness is the local model's
  documented over-report, never text.
- **disclosable** — what is safe to **name** in the note: the decisive set minus near-background
  colours (within `PLATEAU_MERGE_DIST`), falling back to `decisive` when empty.

The distance is now used **only for what is named**; the decision is the identity test alone. This
restores k=3–8 while preserving G2's visible intent (the 500px identity witness no longer forces an
abstention).

### Cause (b) — OPEN, upstream

At k=10–16 **both** models lose the fill; the local model's only failing colour is the page
`#1a1814@1:1` (distance 0). With no non-background evidence the verdict stays `clean` — **evidence-
based but wrong**. Widening or narrowing this filter cannot fix it: the loss is upstream in the
global mask/threshold path (rounds 30/31 ruled out the 2%-of-region extras gate, the parent-box
constant, the adaptive threshold, and the witness filter). Recorded as an open finding; the k=16
case is asserted in the F39 test as the identity-test discriminator (it must stay `clean`), with the
open nature stated in the comment.

### Why neither the F38 test nor the round-31 guard saw it

- The **F38 test** sweeps **size** at a fixed `#312f2c` (distance **24** from the page) — always
  above the filter's 12. The boundary is invisible to it.
- The **round-31 guard** perturbed the filter's *code text* (deleting it lets the identity witness
  force an abstention). That property is real, but a guard that perturbs a mechanism is **not a test
  of its width**. The new **F39** test sweeps the **fill colour** at a fixed large size — now the
  standing test for this mechanism — and the guard asserts the *narrower* decision property.

### Record corrections (round 32)

- F7's witness numbers differ between the two reports (`30,760px / 390 comps / mean 79px` vs
  `35,586px / 421 comps / mean 84px`). Same conclusion (fragmented near-background texture tones),
  different counts — the exact figure is not load-bearing and is left to F7's own round.
- The round-31 note's witness distances (14, 24) used a **chessboard** metric; the platform's
  `rgbDistance` is **Euclidean** (37.1 for `#15130f`). The constant `PLATEAU_MERGE_DIST` must be
  compared in Euclidean terms, which is what this round used.

### Verification

| check | result |
|---|---|
| `npm test` | **133/133** |
| non-vacuity harnesses | **30/30**, **134 guards** |
| `verify/nonvacuity-round31.mjs` | 4 perturbation guards + 1 construction-site invariant, all **NON-VACUOUS** |
| F39 colour sweep (fs=300, k=3–8) | every low-contrast fill `unverified`, none `clean` |

## 5aj. Thirty-third audit: the tested path was not the shipped path (F40)

F39 was verified fixed on the deployed build, and the round-31 guard was checked to have been
**corrected, not weakened** (its single wide-filter case became two, asserting the rule's *width*
and the identity test's *existence* separately). This round's finding is that the **verification
apparatus ran a different configuration from the service**.

### The two-default split

| entry point | clustering tolerance |
|---|---|
| `contrastInRegion` (library; every test, guard, harness) | `16` |
| `measureImage` (`lib/analyze.js`; what users call) | `tolerance = **24**` |
| tool schema (`index.js`) | documented as *"Default: 24"* |

Bisected: adding `tolerance: 24` to a direct library call is the *only* option that reproduces the
divergence. **Pre-existing** (identical from round 21 to HEAD). Effect on the dropcap fixture:
`#262522@1.62` and `#1d1b17@1.82` are **17.4 apart** — inside 24, outside 16 — so at 24 they merged
and the **worst failing colour disappeared from every channel** (`colours`, `excluded`, `skipped`,
`suspected_noise`, `background_regions`), leaving `worst = #444443@1.82`. Four of twelve fixture
families differ, **in both directions** — so "it errs safe" is false, and a caller cannot compensate.

### Fix (recs 1–3)

1. **One default.** `DEFAULT_CLUSTER_TOLERANCE = 16` is now a named export in `lib/measure.js`; the
   library's fallback uses it, and `measureImage` passes `tolerance = undefined` so it **defers** to
   the same constant. The schema text is corrected ("Default: 16… shared with the contrast engine").
2. **Surfaced.** The response now carries `cluster_tolerance` (the effective value), removed from
   ambiguity with `background_fit.tolerance` (a **different** quantity that scores the background
   model, not colour merging).
3. **Tested through the real entry point.** The F40 test runs the dropcap **and** the standing set
   (outlined, dense small cards, split background) through **both** `contrastInRegion` and
   `measureImage`, asserting identical `worst`/`failing_count`/`verdict`. This is the durable fix:
   without it, service-only behaviour is structurally invisible — the shape that hid F40 (and F32).

### Cause (b) — now disclosed (rec 4)

At k=16 both models fail to see the fill; the local model's only witness is the background identity
(`#1a1814@1:1`). Measured through the deployed tool, this was a **completely silent `clean` pass**
(`notes: []`, `model_disagreement: null`) over a real 1.205:1 glyph. The response now **discloses**
it: *"Contrast here could not be measured independently: the local model enumerated N failing
colour(s), but every one is IDENTICAL to the background…"*. The verdict stays `clean` (no
non-background evidence), but it is no longer silent about the limitation. The upstream cause remains
open.

### Verification

| check | result |
|---|---|
| `npm test` | **134/134** |
| non-vacuity harnesses | **31/31**, **140 guards** |
| `verify/nonvacuity-round33.mjs` | 4 perturbation guards + 2 construction-site invariants, all **NON-VACUOUS** |
| library vs service, 5 fixtures | **identical** `worst`/`failing_count` |

## 5ak. Thirty-third audit (continued): the response cap shrank a measurement to a bare envelope (F41)

Unifying the clustering tolerance (F40) exposed a **pre-existing** truncation defect. The
photographic fixture's contrast response is **13,969 chars pretty-printed** at the new default
(12,432 at the old 24) and the client cap is **12,000**, measured on the **pretty** form.
`truncateJsonForClient` then shortened strings, dropped array items, and — when it still did not
fit — fell back to:

```json
{ "success": true, "_truncation": { … "only the envelope is included." } }
```

That is the worst degradation the project has: a **`success: true` envelope with the VERDICT
REMOVED**. A caller finds no `measurements`, and cannot tell an unmeasured result from a broken one.
Measured live, it crashed the standing harness at section 2 (`d.measurements.contrast` of
`undefined`).

### Two fixes

1. **Compact-first.** The cap protects the client's context, not indentation; 2-space pretty is
   30-45% larger than compact. Measured, the photographic payload is 13,969 pretty but **9,660
   compact** — inside the cap, with **every colour and the full disclosure block intact**. The
   function now tries the compact form of the **untouched** value first, so a payload that fits is
   returned complete rather than degraded.
2. **Verdict skeleton + honest envelope.** When compact does not fit, the fallback keeps the
   **verdict skeleton** (verdict, `all_meet_aa`, worst/best, counts, `cluster_tolerance`, the
   disclosure block) with the bulky per-colour arrays emptied, and `_truncation` records exactly
   what was dropped. If even the skeleton overflows, the envelope now reports **`success: false`** —
   it never claims a successful measurement with the answer absent.

### Verification

| check | result |
|---|---|
| `npm test` | **136/136** |
| non-vacuity harnesses | **31/31**, **146 guards** |
| `verify/nonvacuity-round33.mjs` | 7 perturbation guards + 2 construction-site invariants, all **NON-VACUOUS** |
| live harness on a scratch build | `exit=0`, **0 red** checks (section 2 now passes) |

## 5al. Thirty-fourth audit: the verdict survives every cap, and the failing list is characterised (F42)

This round verified F40/F41 on the deployed build, **falsified the auditor's own round-33 attack on
the tolerance value** (measured: at `tolerance: 24` the `outlined` fixture reported `#7c7974@4.09`,
which sits on the fill→stroke line at t=1/3 with **zero residual** — an AA blend reported as failing
text, so 16 correctly removed a FALSE POSITIVE and is the better value, not merely the tested one),
and closed the guard-bug class (**0 of 32 harnesses** had stale patterns; the auditor's two
candidates were their own extraction error). Two fixes remained.

### Rec 1 — a verdict tier, so the verdict survives a small cap

The verdict skeleton carries the full `notes` block (~1,400) plus `worst`/`best` (~920), so it needs
~1.3k+ chars and a smaller cap fell through to the bare envelope — the verdict was **lost**. A
**verdict tier** now sits between them: the scalars (verdict, counts, compact worst/best,
`cluster_tolerance`) with the prose dropped. Both degraded tiers are serialized **compact** (size is
the binding constraint at that point) and the tier's `_truncation` drops the per-action `actions`
list for a one-line summary. Measured thresholds for a representative payload:

| cap | tier | verdict present |
|---|---|---|
| ≥800 | verdict skeleton | ✅ |
| 400–700 | verdict tier | ✅ |
| ≤300 | honest envelope (`success: false`) | ✗ (correctly) |

Before the tier, the verdict was lost below ~1,200; now it holds to 400.

### Rec 2 — the failing list now says when its colours are shades of a MASKED colour

On the dropcap the declared text `#464646` is read as a **2.4%** background plateau and masked, so it
appears in no content channel, while the colours reported as failing (`#262522`, `#444443`,
`#1d1b17`) are **anti-aliasing shades of it** — measured on the correct line (`background→masked`,
the fixture has **no stroke**): t = 0.279 / 0.95 / 0.064, residual ≤ 0.62, with the declared text at
t=1. The AA fold runs on the **survivors** and cannot reach a masked parent, so the note
("blends … are not distinct text colours") contradicted the failing list. A note now states it:

> *N of the reported failing colour(s) are ANTI-ALIASING shades of a MASKED plateau colour (edge
> pixels of a panel/plateau fill, not a distinct ink): … treat them as the edge of the masked colour,
> not as separate text.*

The masked set is taken from `maskReconciliation.unmasked_failing_colours`, **not** `plateauFills`
(measured: the dropcap's `#464646` is dropped by the multi-plateau mask, so `plateauFills` is empty
for it). The disclosure is **added to**, never replaces, the existing mask-reconciliation note.

### On the auditor's §6.2 (`failing_count` non-monotonic in tolerance)

Confirmed (dropcap: 5, 2, 3, 3, 2, 2 at t=4…32), and it is expected: a wider cluster tolerance
**merges** colours, so the count can fall as tolerance rises, while finer tolerances resolve more
edge shades, so it can rise. It is not a converging quantity — the honest reading is that
`failing_count` counts *reported clusters*, not independent text runs. Stated here rather than
papered over; a fix would be a naming/semantics change, not a threshold move.

### Verification

| check | result |
|---|---|
| `npm test` | **137/137** |
| non-vacuity harnesses | **32/32**, **149 guards** |
| `verify/nonvacuity-round34.mjs` | 3 perturbation guards, all **NON-VACUOUS** |

## 9. New module map

| File | Responsibility |
|------|----------------|
| `lib/color.js` | WCAG 2.x maths, colour parsing, RGB distance |
| `lib/measure.js` | Pixel measurement, histograms, component labelling, crop containment |
| `lib/fixtures.js` | Acceptance fixture + self-asserted ground truth |
| `lib/vision.js` | Schema-constrained streaming Ollama client, residency, timeouts |
| `lib/prompts.js` | Claim schema, grounding prompts, quantitative detection |
| `lib/ocr.js` | Tesseract with word-level boxes |
| `lib/crossvalidate.js` | VL-vs-OCR reconciliation and fabrication flagging |
| `lib/legibility.js` | Legibility floor, scaling reports, tiling, provenance |
| `lib/analyze.js` | Orchestration: `measure_image`, `analyze_image_structured` |
