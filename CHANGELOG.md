# Changelog

## Fourth-audit follow-up: multi-panel backgrounds (F5) — 2026-09-25

A fourth independent audit found the most serious defect of the whole effort: on
a **two-panel UI** the tool reported `all_meet_aa: true` while a sidebar string at
**1.64:1** was present and visible. See `ACCURACY.md` §5e.

### Fixed

- **F5 — a failing text colour is no longer hidden by a multi-panel layout.**
  With one background reference, the whole non-modal panel became a single
  "ink" component whose colour was the panel FILL; text inside it was absorbed
  and appeared in no channel. `measure_image` now detects large flat plateaus
  (panels) and, when there are two or more, treats every plateau as background
  and measures each text colour against the fill it actually sits on. The
  sidebar text is now reported at 1.64:1 with `all_meet_aa: false`, in both
  `global` and `local` modes.
- **F5 — the adequacy gate now covers multi-panel UIs.** A 30/70 layout has a
  modal fraction of ~0.69, so `adequate: frac >= 0.5` could never fault it. The
  region is now reported as `background_model: "multi-plateau"` with the
  individual `plateaus[]`, and disclosed in `notes`, regardless of the modal
  fraction.
- **§3.1 — `local_background` is actually delivered.** It was promised in a note
  but only existed on the internal `components[]`; every returned `colours[]`
  entry now carries `local_background` and `measured_against`.
- **§3.2 — the layout finding is structural.** A near-equal-tone sidebar variant
  is now correctly multi-plateau; the number of panels no longer depends on
  whether any text on them happens to be legible.

### Added

- `detectPlateaus()`, `nearestPlateau()` in `lib/measure.js`. A plateau must pass
  four measured tests (min region share, component dominance, flatness,
  connectivity); two of these were necessary and found by measurement — a thick
  glyph stroke is a large solid blob, and a smooth gradient's quantised bands are
  genuinely flat.
- Result keys: `background_model` (`"global"` | `"local"` | `"multi-plateau"`),
  `plateaus[]`, `plateaus_without_text[]`, `panel_fills[]`, and per-colour
  `measured_against` / `measured_against_plateau` / `local_background`.
- `buildTwoPanelFixture()` in `test-support/fixtures.mjs`; 7 tests in
  `test/background.test.js` (now 24).
- `verify/nonvacuity-round4.mjs` — 6 non-vacuous cases reverting each round-4
  guard.
- `verify/verify-background-live.mjs` now also prints the round-4 (F5) checks.

### Deliberately NOT changed

- **The WCAG formula** and all §1-§5e verified behaviour.
- **The single-plateau path** — with fewer than two plateaus the code takes the
  original branch, so the flat fixture and every earlier acceptance number are
  preserved by construction rather than by re-tuning.
- **`background_mode: "local"` remains opt-in**; multi-plateau detection is
  independent of it.
- **Known residual (disclosed, not hidden):** a *smooth*, noise-free gradient can
  produce flat quantised bands that pass the plateau tests. With realistic noise
  in every tested case `plateaus = 0` and the model falls back correctly; the
  flatness threshold (0.85) sits in the measured gap (gradient bands ≤ 0.18,
  real panels ≥ 0.99) but a synthetic gradient with zero noise can still band.

---

## Third-audit follow-up: mode consistency, local backgrounds, AA folding — 2026-09-25

A third independent audit re-verified the earlier work and found four residual
issues in the new `background_mode` code. See `ACCURACY.md` §5d.

### Fixed

- **F1 — `mode: "contrast"` and `mode: "all"` now agree.** With no `region`,
  `contrast` used to abstain while `all` silently measured the whole frame, so
  the same question got two answers depending only on `mode`, and the divergence
  was undocumented. Both modes now measure the whole frame and both disclose the
  full-frame scope in `notes`.
- **F2 — local mode no longer reports a single `background`.** On a gradient the
  modal colour could be a *text* tone (reproduced: `background: #5a5a5a` was the
  text fill). Under `background_mode: "local"`, `background` is now `null`.
- **F2 — noise is not asserted as failing text.** A weak, untext-like cluster
  (audit: 291px, 1 component, 1.06:1) is now classified as suspected noise and
  excluded from `worst`/`failing_count`/`all_meet_aa`, while still being returned
  in `suspected_noise` and named in `notes`. Real near-background text
  (`#1e1c18`, 1.04:1, 20 components) is never reclassified.
- **F4 — a genuine text run is no longer folded as anti-aliasing.** A mid-grey
  text line collinear between the background and a brighter run was being
  swallowed. The colour-only blend test is now gated by component geometry:
  real text is few, large components; AA halos are many, tiny ones.
- **F3 — `npm run verify:background` reaches the deployed service.** The script
  no longer hard-codes port `11499`; it probes `11402` first, then `11499`, and
  honours `PORT`. It prints the port used and, on failure, names the ports tried
  and the override.

### BREAKING (response shape)

- Under `background_mode: "local"`, `measurements.contrast.background` is now
  **`null`** (previously `{ hex, rgb }`). This is deliberate: local mode has no
  single background, and the previous value could be a text colour presented as
  a background. Per-colour `local_background` is unchanged. Global mode is
  unchanged.

### Added

- `measurements.contrast.suspected_noise[]` — clusters classified as residual
  background noise (with `component_count`, `mean_component_area`, `reason`).
- `merged_anti_aliasing[]` records now carry `component_count` and
  `mean_component_area`.
- Exported `looksLikeIndependentText()`, `isSuspectedNoiseCluster()`,
  `partitionSuspectedNoise()` in `lib/measure.js`.
- `buildGradientTextFixture()` / `buildFlatTextFixture()` in
  `test-support/fixtures.mjs`.
- 8 tests in `test/background.test.js` (now 17) covering the four findings.
- `verify/nonvacuity-round3.mjs` — reverts each new guard and confirms the
  matching test fails (5 non-vacuous cases).
- `verify/verify-background-live.mjs` now also exercises F1/F2/F4 over the real
  MCP transport; npm script `verify:background` unchanged.

### Deliberately NOT changed

- **The WCAG ratio formula** and all §1-§5c verified behaviour.
- **Default `background_mode: "global"`** — local mode is still opt-in.
- **`isAntiAliasingBlend`'s colour semantics** — so its existing unit tests keep
  their meaning; the new geometry check sits above it in `mergeAntiAliasing`.

### Corrected claim

The audit reported F4 as local-mode-only (flat+`global` correct). That does not
reproduce independently: two collinear text tones on a flat background fold in
**both** modes on the previous code. The defect was the colour-only guard, not
local mode. The audit's suggested spatial-overlap test was also measured and
found unworkable (0% overlap for genuine AA *and* the false fold); the working
discriminator is component geometry.

---

## Background modelling for photographic images — 2026-09-25 (follow-up)

Closes the last open item: the fixed ink threshold (`?? 4` RGB units from the
background) was tuned for flat UI screenshots and behaved poorly on photographic
or gradient images. See `ACCURACY.md` §5c.

### Investigated first (measurement, not assumption)

A threshold sweep plus a global-vs-local background comparison across noise
levels showed the original framing was incomplete. The real problem is not the
threshold *value*: it is that **one global background colour cannot model a
gradient or photo**. Measured:

- On a text-free noisy canvas, *raising* the threshold made things worse
  (237 -> 1408 spurious clusters as T went 8 -> 20), because a global reference
  is simply wrong for most of the image.
- With a per-tile median background and a noise-scaled threshold, a text-free
  photo yields **0** colour groups (vs one 175k-pixel "colour"), and known text
  colours are recovered.

### Added

- **`background_mode: "global" | "local"`** on `measure_image`. Default is
  `"global"` (unchanged behaviour). `"local"` uses a per-tile median background
  with a threshold of `max(ink_threshold, noise_factor * local_noise_sigma)`,
  where the noise scale is a MAD estimate (1.4826 x MAD) and tiles are
  bilinearly interpolated.
- **`tile_size`** (default 48) and **`noise_factor`** (default 4) to tune the
  local mode. `noise_factor` was chosen from a sweep: k=4 gave 0 spurious groups
  on text-free noise and full recovery of known text across noise levels 3-20.
- **`background_fit`** diagnostic on every contrast result, plus a `notes`
  warning when a single background explains <50% of the region. This closes the
  reporting gap: a caller is no longer told a contrast check was sound when its
  premise (one background colour) did not hold.
- `tileBackgroundField()` and `assessBackgroundFit()` in `lib/measure.js`.
- `test/background.test.js` (9 tests) and `verify/nonvacuity-background.mjs`
  (7 non-vacuous cases), plus `verify/verify-background-live.mjs`.
- `test-support/fixtures.mjs` — shared fixtures extracted so importing one test
  file from another no longer re-registers its cases (which double-counted the
  suite).
- npm scripts: `test:background`, `test:nonvacuity:background`,
  `verify:background`.

### Changed

- `extractInkComponents()` reports `background_mode`, `effective_ink_threshold`,
  `median_ink_threshold`, `noise_factor`, `tile_size`, and per-component
  `local_background`.
- `contrastInRegion()` / `enumerateRegionContrast()` expose the same fields plus
  `background_fit`.

### Deliberately NOT changed

- **The default remains the global background.** A local model was measured to
  *regress* dense flat UIs: a 48px tile straddling two flat panels is bimodal, so
  the local noise scale inflates (median effective threshold 21, max 86) and
  real text gets swallowed while panel fills become "ink". That is why local mode
  is opt-in, and the reason is documented and pinned by a test rather than left
  to rediscovery.
- **No change to the validated flat-fixture results.** Because a flat tile has
  zero MAD, the local threshold collapses to the floor and local mode is
  *byte-identical* to global on the fixture (asserted by test).

---

## Robustness fixes — 2026-09-25 (follow-up)

### Fixed

- **Structured responses could become unparseable when large.** A plain string
  slice at `MAX_RESPONSE_TEXT_CHARS` cut JSON mid-token. Observed live: 3 of 6
  structured runs exceeded the cap and a consumer could not `JSON.parse` the
  result, which defeated the purpose of the schema-constrained tools.
  Truncation is now JSON-aware: it shortens the largest string fields first,
  then trims the longest arrays, and always returns a valid JSON document. A
  `_truncation` block records what was done (`shortened_string` /
  `dropped_array_items`, with counts) so a consumer can tell an incomplete list
  from a complete one. Verified live: the two previously-failing responses now
  parse (11716 and 11610 chars, with `dropped 3 of 12` / `dropped 4 of 12`
  reported). Implemented in `lib/response.js` with unit tests in
  `test/response.test.js`.
- **Upload size limit was silently ineffective.** Two related defects:
  - `MAX_UPLOAD_SIZE_BYTES` was computed as
    `Number(env) * 1024 * 1024 || 20 * 1024 * 1024`. It only fell back to 20MB
    because `NaN` propagated through the multiplication, and a typo'd value was
    swallowed without a word.
  - The Express body limit was built from that byte count, producing
    `"20971520mb"` (~20TB) — so the body parser never rejected an oversized
    upload and buffered it in memory before the manual size check ran.

  The megabyte value is now parsed and validated before scaling (mirroring the
  existing `MAX_DOWNLOAD_SIZE_BYTES` idiom), a non-numeric value logs a warning
  and falls back to 20MB, and the Express limit is `"20mb"` as intended.

### Added

- `lib/response.js` — `truncateForClient` (prose) and `truncateJsonForClient`
  (valid-JSON guarantee), extracted so they are directly unit-testable.
- `test/response.test.js` — 7 tests, including the two shapes that previously
  produced unparseable output.
- `verify/verify-truncation-live.mjs` — re-runs the exact prompts that failed
  and asserts the payload parses.
- `verify/reproduce-fabrication.mjs` — attempts live reproduction of fabricated
  text and contested `unreadable` claims across models/prompts. **Result on this
  host: not reproduced** (see below).
- npm scripts: `test:response`, `verify:truncation`, `verify:fabrication`.

### Investigated, not resolved (reported honestly)

- **Live fabrication was not reproduced.** Across `llava:13b` and
  `minicpm-v:8b` × three fabrication-inducing prompts, no model produced text
  with `source === "unverified"`, and none produced an `unreadable` claim that
  OCR contradicted. With `format` enforced, the models returned `parsed: false`
  (zero claims) rather than inventing content — the schema constraint appears to
  be doing its job. The flagging mechanisms therefore remain verified
  **deterministically** (unit tests) rather than against a live hallucination.
  `verify/reproduce-fabrication.mjs` is committed so this can be re-checked with
  a more fabrication-prone model.
- In the same runs, OCR supplied strings the model omitted (its `text_items`
  were empty while `ocr_only` held the real labels) — behaviour the earlier
  cross-validation work already surfaces.

### Unchanged by design

- WCAG maths, `measure_image` determinism (still model-free), `fast_ocr_tesseract`
  output, `visual_diff` comparison logic, and all existing tool/argument/envelope
  names.

---

## Multi-colour contrast enumeration — 2026-09-25 (follow-up hardening)

Fixes the one substantive defect that survived the previous accuracy pass: region
contrast reported only the **most legible** colour, so an image containing large
text at 2.14:1 and 1.04:1 was summarised as `wcag_aa: true` — reading as "no
contrast problems". See `ACCURACY.md` §5b.

### Fixed

- **Contrast now enumerates every text colour** in the region and reports the
  **worst** case, not the best. `#484f58` (2.14:1) and `#1e1c18` (1.04:1) are no
  longer dropped from the result.
- **Near-background text is detected.** The enumeration uses an ink threshold
  (default 4) rather than the old 24-unit colour filter that discarded a 1.04:1
  string sitting ~7 RGB units from the background.
- **Anti-aliasing no longer leaks into results.** Shades are folded into the
  colour they blend towards, using a geometric test (mid-point blend fraction +
  near-zero collinearity residual). This also makes the output independent of the
  renderer: PIL- and librsvg-generated fixtures now agree.
- **Decorative chrome is separated from text** (thin hollow rectangles) and
  reported under `excluded` with an explicit note, instead of being silently
  omitted or mistaken for a low-contrast text colour.

### Changed

- **`wcag_aa` (at `measurements.contrast`) now aliases the worst case**
  (`all_meet_aa`): `true` only when *every* evaluated text colour passes AA.
  Previously it meant "the most legible colour passes", which could be `true` on
  an image full of failing text. `best.contrast_ratio` preserves the old number.
- `contrast_ratio`, `contrast_ratio_raw`, and `foreground` now refer to the
  **worst** case. New fields are additive: `worst`, `best`, `colours[]`,
  `failing_count`, `passing_count`, `evaluated_count`, `all_meet_aa`, `excluded[]`,
  `skipped[]`, `merged_anti_aliasing[]`.
- `measure_image` gained `ink_threshold`, `include_decorative`, and
  `decorative_colors`.
- `analyze_image_structured` (and the legacy `analyze_image` quantitative path)
  now surface the enumerated failing colours through `measurements.contrast`,
  and state them in `abstained[]`/notes so prose alone cannot read as "fine".

### Fixed (§3.5 consistency)

- **`text_items` is populated from OCR** instead of being empty while
  `cross_validation.ocr_only[]` was populated; entries carry `source: "ocr"` and
  `reported_by_model: false`, and `cross_validation` reports `text_items_count`
  and `text_items_sources` so the two cannot drift.
- **`unreadable[]` entries carry provenance** (`source: "model"`,
  `verified: false`) and are marked `contested` when OCR read corresponding text
  (`contest_type: "precise" | "blanket"`), with the contradicting OCR evidence in
  `contested_by` and a warning raised.

### Added

- `test/contrast.test.js` — the six acceptance tests plus anti-aliasing,
  renderer-independence, and §3.5 consistency tests.
- `verify/nonvacuity-contrast.mjs` — non-vacuity harness for the above (11 cases).
- `verify/make-fixture.py` — the brief's exact fixture generator.
- `verify/verify-contrast-live.mjs` — live end-to-end verification against the
  real PIL fixture.
- npm scripts: `test:contrast`, `test:nonvacuity:contrast`, `fixture:make`,
  `verify:contrast-live`.

### Unchanged by design

- **The WCAG ratio formula** — it was already correct and was not touched.
- **`measure_image` remains model-free.** Quantitative answers continue to work
  with Ollama entirely unavailable.
- **`fast_ocr_tesseract` output** and **`visual_diff` comparison logic** — not
  modified.
- Tool names, argument names, and the `success` / `mode` / `region` /
  `dimensions` / `measurements` / `provenance` / `disclaimer` envelope keys.

---

## Accuracy Hardening — 2026-09-25

An accuracy-hardening pass following a real incident: a downstream agent
received confident, specific, wrong answers from the vision tools and nearly
reported fabricated UI defects to a user, while one false negative masked a
genuine accessibility bug. See `ACCURACY.md` for full detail and evidence.

### Added

- **`measure_image` tool** — deterministic answers via pixel maths: WCAG
  contrast, dominant/background colours, box counts, region content. Never
  consults a model, so it works when Ollama is down.
- **`analyze_image_structured` tool** — schema-constrained, cross-validated
  analysis returning `claims[]` (each with `box`, `confidence`, `source`),
  `abstained[]`, `measurements`, `cross_validation`, and full `provenance`.
- **`lib/color.js`** — WCAG 2.x relative luminance, contrast ratio, compliance,
  colour parsing. Validated against the fixture's declared values.
- **`lib/measure.js`** — pixel histograms, foreground/background detection,
  connected-component box counting, non-background ratio, crop containment.
- **`lib/fixtures.js`** — acceptance fixture with self-asserted ground truth.
- **`lib/vision.js`** — schema-constrained streaming Ollama client with pinned
  sampling, residency inspection, and actionable timeouts.
- **`lib/prompts.js`** — claim JSON schema, grounding prompts, and
  `detectQuantitativeQuestion`.
- **`lib/ocr.js`** — Tesseract with word-level bounding boxes.
- **`lib/crossvalidate.js`** — VL-vs-OCR reconciliation; classifies text as
  `vl+ocr`, `vl`, or `unverified` (the fabrication signature).
- **`lib/legibility.js`** — legibility floor, scaling reports, `tileImage`,
  provenance assembly.
- **`lib/analyze.js`** — orchestration for the two new tools.
- **`test/accuracy.test.js`** — the ten acceptance tests (wired into `npm test`).
- **`test/tools.test.js`** — end-to-end coverage that spawns the server against a
  mock Ollama and calls every tool (catches wiring regressions the unit tests miss).
- **`verify/`** — reproducible verification scripts: fixture check, non-vacuity
  harness, real-model and timeout checks. Deliberately outside `test/` so
  `node --test` cannot auto-run the source-mutating non-vacuity harness.
- New npm scripts: `test:accuracy`, `test:fixture`, `test:nonvacuity`,
  `verify:real`, `verify:contrast`, `verify:timeout`.
- New environment variables (all optional, with defaults):
  `OLLAMA_KEEP_ALIVE`, `VISION_TEMPERATURE` (0), `VISION_SEED` (42),
  `VISION_NUM_PREDICT` (2048).

### Changed

- **Ollama requests are now constrained.** Every structured call sends a JSON
  schema in `format` with `temperature: 0`, an explicit `seed`, and a capped
  `num_predict`. Previously none of these were set.
- **Responses are streamed**, so model *loading* can be distinguished from
  *inferring* via time-to-first-token and Ollama's `load_duration`.
- **`analyze_image` no longer answers quantitative questions.** A measurable
  prompt is short-circuited to deterministic measurement with
  `model_consulted: false`.
- **`analyze_image_structured` short-circuits quantitative prompts** to
  measurement with no model call at all.
- **Legacy text tools append a `[provenance]` / `[warnings]` footer** naming the
  model, sampling options, time-to-first-token, dimensions sent, and
  downscaling status.
- **`detect_ui_elements` reports a `provenance` object** and applies the
  legibility report.
- **`visual_diff` attaches `ai_description_provenance`** to its optional AI
  description.
- **`check_vision_health` reports model residency** (which models hold memory
  and how much VRAM) plus installed vision models.
- **Timeout errors are rewritten.** They name the model, report residency,
  give a diagnosis, and list vision models actually installed on the host. The
  previous hardcoded `llava:7b` suggestion — a model not installed here — is
  gone.

### Fixed

- **Wiring regression caught and fixed during the work:**
  `browser_screenshot_analysis` referenced an undefined `pngBuf` after the
  provenance change. Found by the new all-tools integration test, which was
  verified to fail when the bug is reintroduced (`pngBuf is not defined`).
- **F3** — a supplied crop is physically applied before the model sees the
  image, so out-of-crop content cannot be reported; boxes are additionally
  checked for containment and flagged `outside_crop`.
- **F4** — contrast is computed (WCAG maths), not asserted. `BRAVO-TWO`
  measures 2.14:1 with `wcag_aa: false`.
- **F5** — a real cold-load timeout now fails in ~3s instead of blocking 180s,
  diagnosing residency contention instead of hiding it.

### Unchanged by design

- **`fast_ocr_tesseract`** — verified correct; not modified. It is now also used
  by the cross-validation layer in a read-only capacity.
- **`visual_diff`** — verified correct; its comparison logic is untouched.
- **The Ollama concurrency gate** — preserved intact (parallel vision inference
  has crashed this host); the new tools acquire the same slot.
- **Tool names, argument names, and existing JSON keys** — unchanged. All
  changes are additive.

### Notes

- F1 (fabricated glyphs) was **not reproduced** against the real model available
  here; the observed real-model failure was omission. The anti-fabrication
  mechanism is verified deterministically (cross-validation + non-vacuity
  harness) and is reported as such rather than overclaimed. See `ACCURACY.md` §8.
- On this host, Tesseract read the fixture's 1.04:1 string at ~90% confidence
  when rendered large and isolated on its own. Legibility therefore cannot be
  inferred from OCR success; contrast is measured directly instead. Recorded as
  an empirical finding.
