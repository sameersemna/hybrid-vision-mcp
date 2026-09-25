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
