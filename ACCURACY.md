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
| 15 | phrase guard | caught 1/9 paraphrases |
| 16 | free-text waiver token | trailing token waived any claim |
| 17 | verb-adjacent negation, structural marker | ordinary words in the window; marker waived the row |

Each fix narrowed the **scope** of an exclusion and left its **kind** alone — an
author-authored token whose presence suppresses reporting. As long as suppression is
triggered by text the author controls, a new phrasing will waive a claim. The **positive
disclaimer assertion** is the only element a paraphrase cannot defeat, so it is the primary
check and the phrase guard is a **best-effort lint with a measured, documented recall** —
not a barrier. The guard's own header now says exactly this.

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
