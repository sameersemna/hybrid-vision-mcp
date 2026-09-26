# Changelog

## Thirteenth-audit follow-up: `shape` was not a discriminator — 2026-09-26

The twelfth audit removed the disclosure *gate* but kept a `shape` label
(`"panel-shaped"` / `"text-sized"`) and claimed precision was "recovered by wording".
**That claim does not hold.** `shape` came from `isPanelShapedDroppedColour` =
`mean / regionArea >= 0.02`, i.e. `pixel_count / component_count / area` — the **same
`mean = total / N` construction** the twelfth audit (F14) showed is anti-correlated
with the evidence, one layer up. See `ACCURACY.md` §5o.

Measured (live 11402): 9 decorative chart bars (11% of the region) and a 164-glyph
failing text run are **both** labelled `text-sized`. Holding the total failing area
constant and only changing the piece count flips the label between 4 and 6 pieces with
nothing else on screen changing.

### Fixed

- **F15 — `shape` and `isPanelShapedDroppedColour` are REMOVED.** The audit's first
  fix (base `shape` on the largest connected component) was measured and **does not
  separate** the pair (largest/AREA 0.0185 decoration vs 0.0174 text), so it was **not**
  adopted. No replacement threshold was substituted: a bar chart and a glyph run are
  the same kind of object (replicated elements, no dominant blob), so any new scalar
  would invert in turn.
- **The tool no longer implies it classifies.** Each disclosure carries the raw,
  evidence only — `component_count`, `mean_component_area`, `plateau_share`,
  `largest_component_share`, `detected_plateau`, `pixel_count`, `contrast_ratio`,
  `measured_against` — so a caller judges. The note text says explicitly that the tool
  does not classify decoration vs text.

> **AMENDED (fourteenth audit F16).** This entry said `plateau_share` "is the
> fragmentation-invariant field that orders the pair (0.099 decoration vs 0.049").
> **That is false.** `plateau_share` is the plateau's COVERAGE, and coverage is not
> kind: a DENSE glyph run covers MORE than a bar chart — measured **0.1561 (real
> dense text) vs 0.0986 (bars)**. The round-13 pair happened to order that way by
> coincidence, and following the stated meaning inverts the reading. It is
> fragmentation-invariant (a real, useful property) but it separates large from
> small, not decoration from text. See `ACCURACY.md` §5p.

### Amended

- `ACCURACY.md` §5n's sentence "precision is recovered by wording" is **downgraded** —
  it asserted a classifying capability `shape` did not have. The F14 content and the
  "irreducibly ambiguous" retraction stand unchanged.

### Behaviour change (documented, not silent)

`mask_reconciliation[].unmasked_failing_colours[].shape` is **removed** from the JSON.
A consumer reading `shape` must switch to the raw fields listed above.

## Twelfth-audit follow-up: the disclosure gate was ANTI-CORRELATED with the evidence — 2026-09-26

The eleventh audit's residual was described as "irreducibly ambiguous". **That framing
was wrong**: the residual has a **direction**. Adding failing text of the *same
colour* made the warning **disappear**, so the seam was not a boundary but an
inversion — more evidence of a problem made the tool less likely to report it.

Reproducer (audit F14): a 300px solid failing `II` heading (1.88:1) is DISCLOSED; the
same heading **plus six 28px body lines in the same colour** is SILENT, because the
mean collapses from 1.78% to 0.03% while the largest blob is unchanged (1.74%). A
sweep of the small-glyph size shows the mean is flat-or-falling (0.0009 / 0.0005 /
0.0006 / 0.0009), so **no amount of extra text can satisfy a mean floor**. See
`ACCURACY.md` §5n.

### Fixed

- **F14 — the size gate is REMOVED, not re-tuned.** `isDisclosableDroppedColour` now
  returns `true` unconditionally: any failing colour the mask removed is disclosed.
  Three attempts to keep a size gate each opened a silent seam (F12 mean-vs-single-blob,
  F13 union, F14 anti-correlation), so the only stable formulation is the one true by
  construction — "the trigger *is* the mask's own evidence", with no second opinion.
- **Precision is recovered by WORDING, not suppression.** Each disclosure entry now
  carries `detected_plateau` and `plateau_share` (and keeps `largest_component_share`,
  `shape`, `measured_against`), read from the `plateaus` array already computed — so a
  caller can tell decoration from text without the tool hiding anything.

### Deliberate behaviour change (not silent)

`mask_reconciliation` now **fires on decorative dashboards** (the ninth-audit F11
case): the un-masked pass re-reads a tiled bar colour as failing text. This reverses
the ninth audit's precision choice. The trade is explicit — the disclosure is
advisory and names its own uncertainty, whereas the F14 omission was silent. Filter on
`detected_plateau` to ignore decoration. Documented in `README.md` and §5n.

## Eleventh-audit follow-up: the round-10 "structural guarantee" was FALSE — 2026-09-26

Round 10 claimed the disclosure gate could never be stricter than the mask
"because it reuses the mask's own constant `PLATEAU_MIN_BLOB_SHARE`". **That claim
is retracted.** Sharing a *name* is not the same as being a superset, and the two
constants measure different quantities: `PLATEAU_MIN_SHARE` (0.02) is a **single
blob's** share, while the round-10 gate compared a **mean** across blobs. Since
`mean = total / N`, the mean falls below the floor as `N` grows, so a colour masked
by one ≥ 2% blob that also has many small companions was **masked and never
disclosed** — a large drop-cap `I` beside small glyphs of the same failing colour
(F13(a)), or an inset panel beside ten small fragments (F13(b)). A false guarantee
is worse than a known gap, because it tells the next reviewer to stop looking.
See `ACCURACY.md` §5l (retracted) and §5m.

### Fixed

- **F13 — the gate is now the UNION of the mask's two acceptance tests.** A dropped
  failing colour is disclosed if **either** its largest blob holds ≥ 2% of the
  region (`PLATEAU_MIN_SHARE`, the mask's path-A test — **true by construction**
  for a dominant-blob mask, which is what makes F13 structural) **or** its mean blob
  clears the per-blob floor (`PLATEAU_MIN_BLOB_SHARE`, path B). Shape still only
  chooses the wording.
- **Each disclosure now says why the mask reached it.** Entries carry
  `largest_component_share` and `detected_plateau`, so a caller can see that the
  colour was itself read as a plateau (the drop-cap/panel case) rather than merely
  dropped as an anti-aliasing remnant.

### Residual gap — named, not hidden

A colour reached by a **path-B** mask that mixes ≥ 2 solid blobs with smaller
sub-floor blobs can still be masked and undisclosed. That signature is a chart /
icon grid (the F11 decoration, which must stay quiet), but it is irreducibly
ambiguous: a headline of two huge glyphs plus many small failing ones has the same
shape. The reconciliation is therefore a **heuristic with a documented seam**, not
a proof, and is described as such in `README.md`. Clause 1 (path A) *is* true by
construction; the union closes the F13 seam and this is the only gap that remains.

## Tenth-audit follow-up: the disclosure gate was narrower than the masking floor — 2026-09-26

Round 9's disclosure gate required a dropped colour's blob to be >= 2% of the region,
but the tiling mask accepts blobs >= 0.4%. Colours between the two were masked AND
never disclosed — a silent false negative whose presence depended only on crop size.
See `ACCURACY.md` §5l.

> **SUPERSEDED / RETRACTED (eleventh audit).** The fix below reused the *name*
> `PLATEAU_MIN_BLOB_SHARE` but compared a **mean**, so it did **not** yield the
> superset claimed. The guarantee asserted here was false; see the eleventh-audit
> entry above.

### Fixed

- **F12 — the disclosure gate now shares the mask's own constant**
  (`PLATEAU_MIN_BLOB_SHARE`), instead of a second, stricter threshold. Because a
  masked region's blobs clear that floor by construction, the trigger can no longer
  be stricter than the mask, so nothing can be masked without also being eligible for
  disclosure. The invariant is now structural rather than a coincidence of two
  numbers. **[RETRACTED — see above.]**
- **Wording labelled by shape.** Each `mask_reconciliation` entry now carries
  `shape: "panel-shaped" | "text-sized"`, so shape decides *how* to describe what
  was removed, not whether to mention it.

### Measured and REJECTED alternatives (recorded so they are not retried)

Five candidate discriminators were measured against the full fixture population and
failed before the shared-constant gate was chosen:

- a **component-count ceiling** — a 17-`I` headline exceeded it and went silent;
- **blob aspect** — decorative icon grids and swatch rows are square (aspect 1.0),
  overlapping glyphs;
- **size variance (CV)** — real varied text (`"Illi"`) measured 0.44, inside the
  decoration range;
- **plateau `detection` type** — F12's colour is `tiled`, exactly like the decorative
  bars;
- **removal mechanism** — F11 and F12 are removed by the same path.

The mean works because a chart's bars vary in height (mean 0.0036, below the 0.004
floor) while a text run of one size clears it (the band measures 0.005-0.018).

### Added

- `buildBandGlyphFixture()` in `test-support/fixtures.mjs`; 4 tests in
  `test/background.test.js` (now 56).
- `verify/nonvacuity-round10.mjs` (3 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-10 (F12) checks.

### Deliberately NOT changed

- The WCAG formula, the adequacy floor, the `>=2-plateau` gate, both plateau paths,
  the ring-shape test, the dominance floor, and the reconciliation mechanism.
- **Known decorative false positive (§3, measured and declined):** a small solid
  decorative accent block is still reported as failing text, because it is
  indistinguishable from real solid text at the same size (3000px vs 3052px, both
  fill 1.000). See `ACCURACY.md` §5k.

---

## Ninth-audit follow-up: the reconciliation fired on decoration — 2026-09-26

Round 8's `mask_reconciliation` worked, but fired on decorative chart bars and told
the caller a CORRECT verdict was unverified. A disclosure that cries wolf is worth
less than one that is quiet and correct. See `ACCURACY.md` §5j (and §5k for a
deliberate non-fix).

### Fixed

- **F11 — `mask_reconciliation` is now gated on the dropped colour being
  PANEL-SHAPED.** It fires only when a dropped failing colour's blobs are
  individually >= 2% of the region — the shape that is genuinely ambiguous ("one
  large region: a panel, or very large text?"). Measured: decorative bars 0.004,
  decorative icons 0.012, decorative stripes 0.010, ordinary text far less; the
  ambiguous case 0.256.
- **Wording softened.** The note now says the removed region could be a panel or
  very large text and asks for a `region` re-measure, rather than declaring the
  verdict "unverified".

### Note on the gate direction

The intuitive gate ("text-shaped: few components AND SMALL mean area") was measured
and is **wrong** — it excludes the very case the disclosure exists for, because the
ambiguous region is a *large* blob. The gate is therefore large-not-small. Recorded
so it is not "corrected" back later.

### Added

- `isPanelShapedDroppedColour()` in `lib/measure.js` (shares
  `LARGE_REGION_AREA_FRACTION` with the background-region backstop);
  `mean_component_area` on `mask_reconciliation` entries.
- `buildDecorativeBarsFixture()`, `buildDroppedPanelFixture()`,
  `buildAccentBlockFixture()` in `test-support/fixtures.mjs`; 5 tests in
  `test/background.test.js` (now 52).
- `verify/nonvacuity-round9.mjs` (3 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-9 (F11) checks.

### Explicitly NOT fixed (§3, measured)

A small **solid decorative accent block** is still reported as a failing text
colour. It is **indistinguishable from real solid text**: the accent blob is
3000px / fill 1.000, while a bold "I" at 150px is 3052px / fill 1.000. Any rule
that suppressed the accent would also suppress real solid text — a false negative,
which is the class this effort exists to eliminate. Documented in `ACCURACY.md`
§5k rather than "fixed" by trading a conservative false positive for a silent one.

### Deliberately NOT changed

- The WCAG formula, the adequacy floor, the `>=2-plateau` gate, both plateau paths,
  the ring-shape test, the dominance floor, and the reconciliation mechanism itself
  (silencing it would reintroduce a silent false negative for the solid-block class).

---

## Eighth-audit follow-up: an inset content-dense panel hid a failing text colour — 2026-09-26

The third invariant (round 7) leaked through the `panelShape` gate round 7 added:
a card that fails contrast was not reported and the result read `all_meet_aa: true`.
See `ACCURACY.md` §5i.

### Fixed

- **F10 — the panel shape test now measures hole SHAPE, not fill.** Round 7 used
  `touchesBorder || fill >= 0.85`. Dense content perforates a card, dropping its
  fill below 0.85, so the card stopped being a plateau; its fill then became ink
  and its representative colour resolved against the light bars (11.74:1, passing),
  absorbing the real text (`#666460`, 2.47:1) so it vanished from every channel.
  The test is now based on the **largest enclosed aperture as a fraction of the
  bbox**: a glyph RING has one large aperture (measured 0.253-0.257), a perforated
  panel has many small ones (measured 0.008), every other panel <= 0.033. This
  separates "is a ring" from "is perforated", which a single fill threshold
  conflates.
- **A repeated glyph pair now reports the REAL text colour, not an AA remnant.**
  The dominance floor was raised from 0.5 to 0.6 (measured: glyph pairs 0.50-0.505,
  every real panel >= 0.78). Not required for the verdict, but for the reported
  colour.

### Added

- **Mask reconciliation** (`mask_reconciliation`): when plateau masking occurred,
  the region is re-enumerated with NO mask and any failing colour the masked run
  dropped is disclosed in `mask_reconciliation` and in `notes`. This is the
  guarantee that closes the third invariant for shapes the geometry cannot resolve
  (a solid glyph block / a single ring large enough to touch the border). It is
  disclosure, not refusal — the refusal variant would regress F5, because the
  two-panel's dark page legitimately appears as ink in the un-masked run.
- `buildDensePanelFixture()`, `buildSolidGlyphFixture()` in
  `test-support/fixtures.mjs`; 6 tests in `test/background.test.js` (now 47).
- `verify/nonvacuity-round8.mjs` (3 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-8 (F10) checks.

### Deliberately NOT changed

- The WCAG formula, the adequacy floor (0.5), the `>=2-plateau` gate, the tiling
  path, `background_regions`, and the outermost-colour exemption (`touchesBorder`),
  which is now *required*: a page frame's largest "hole" is the card inside it
  (measured 0.669), so it must qualify by touching the border.
- The §1 acceptance path (one flat background, no masking -> no reconciliation).
- **Known residual (disclosed, not hidden):** a SINGLE huge glyph ring large enough
  to touch the region border, and a run of SOLID glyph blocks that merge into one
  blob, remain geometrically ambiguous. Both now carry `mask_reconciliation` and
  neither can report `all_meet_aa: true` while dropping a failing colour.

---

## Seventh-audit follow-up: a text colour accepted as a plateau and masked — 2026-09-26

Round 5 removed the *silent pass*, round 6 the *spurious fail*. This round removes
the third edge: a text colour being reclassified as background and then going
unreported. See `ACCURACY.md` §5h.

### Fixed

- **F8 — a large hollow glyph can no longer be accepted as a plateau.** Two huge
  *identical* glyphs ("OO" at 300px) gave the text colour a dominance of exactly
  0.5 — the single-blob threshold — while its blobs are inset rings with fill
  0.556. The text colour became "background": with anti-aliasing the real colour
  vanished behind AA remnants, and hard-edged the region returned
  `measurable: false` with a note asserting *"No text was found there"* about a
  region that is entirely text.

### Changed (semantics)

- The **dominant-blob** plateau path now requires an inset blob to be near-solid:
  `blob touches the region border OR blob fill >= 0.85`. The **outermost** colour
  is the background with panels/glyphs cut out of it, so its fill is legitimately
  low (measured 0.20-0.75) and it still qualifies by touching the border. An
  inset *hollow* blob is a glyph ring, not a panel (measured: rings 0.56, real
  inset panels 0.96-0.99). This is a shape test, not a threshold tune. New
  `plateaus[].detection` value `"dominant-blob"` is unchanged; the reason is
  reflected in the record's `fill`/`touchesBorder` behaviour rather than a new key.
- `plateaus_without_text` can no longer assert "no text" for a plateau that the
  text colour actually occupies — it follows from the above.

### Correction to the audit's attribution

The finding was attributed to the tiling path recommended in round 6. Measurement
shows the colour was accepted by the **pre-existing dominant-blob path**
(`detection: "dominant-blob"`, `dominance: 0.5`), not by tiling: the ring's fill
(0.556) is below the tiling path's solidity floor (0.85), so tiling never fired.
F8 is a round-4 boundary weakness, not a round-6 regression.

### Added

- `buildHugeGlyphFixture({ hardEdge })` in `test-support/fixtures.mjs` (with a
  true posterisation path, so the hard-edged rendering is reproducible); 5 tests
  in `test/background.test.js` (now 41).
- `verify/nonvacuity-round7.mjs` (3 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-7 (F8) checks.

### The third invariant

Alongside "a clean verdict is never silent" and "a failure is never attributed to
a background region", the server now enforces: **a text colour is never
reclassified as a background region and then unreported**.

### Deliberately NOT changed

- The WCAG formula, the adequacy floor (0.5), the `>=2-plateau` gate, the tiling
  path, and `background_regions`.
- The §1 acceptance path: one flat background with a low fill still qualifies
  because it spans the region (touches the border).

---

## Sixth-audit follow-up: tiled layouts reported the page background as failing text — 2026-09-26

Round 5 removed the *silent pass*. This round removes the *spurious fail*: on a
4x3 grid of identical cards the page background was asserted to be a failing text
colour, on an image where every text colour passes. See `ACCURACY.md` §5g.

### Fixed

- **F7 — a repeated card fill is now recognised as a panel.** `detectPlateaus`
  gained a second, structural path: a colour is a plateau if it forms several
  large, near-solid, similarly-sized blobs (a tiled layout), not only if one
  blob holds most of the colour. A card grid previously gave dominance ~0.08,
  so the card fill was rejected, multi-plateau never engaged, and the page
  background became one enormous "ink" component reported as failing text.
- **F7 — card borders are no longer reported as failing text.** A component that
  is long and thin in one axis (>=60px long, <=4px across) is a rule, divider or
  border, not a glyph. The previous hollow-rectangle test required a 2-D box and
  missed these. (Found by the new tiling path exposing the dense dashboard's
  borders.)
- **F7 — a large background region cannot become a "failing colour".** A
  near-background cluster whose blobs are individually huge is classified as
  `background_regions` and disclosed, for layouts the plateau model cannot reach
  (e.g. a textured page background). Measured margin: real text <=0.10% of the
  region per blob, a page background 37.7%.

### Added

- `plateaus[].detection` (`"dominant-blob"` | `"tiled"`),
  `plateaus[].solid_component_count`, `plateaus[].size_cv`.
- `background_regions[]` result key with `foreground`, `pixel_count`,
  `component_count`, `mean_component_area`, `area_fraction`, `reason`.
- Exported `isLargeBackgroundRegion()`.
- `buildTiledCardsFixture()`, `buildTiledCardsLightFixture()`,
  `buildTexturedPageCardsFixture()` in `test-support/fixtures.mjs`; 6 tests in
  `test/background.test.js` (now 36).
- `verify/nonvacuity-round6.mjs` (4 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-6 (F7) checks.

### The second invariant

Alongside "a clean verdict must never be silent", the server now enforces: no
response may report `all_meet_aa: false` naming a colour that is a background
region rather than text.

### Deliberately NOT changed

- The WCAG formula, the adequacy floor (0.5), and the `>=2-plateau` gate.
- The §1 acceptance path: with one plateau and no tiled panel the result is
  bit-for-bit unchanged.
- **Known residual (disclosed, not hidden):** a page background that is *textured*
  (so it fails the plateau flatness test) *and* fragmented by panels into many
  blobs (so the region backstop cannot see one large blob) is not caught.

---

## Fifth-audit follow-up: the gradient residual is disclosed in the response — 2026-09-25

The fourth round disclosed a residual in `CHANGELOG.md` (a noise-free gradient can
band, and a global background can miss a tone on it). The fifth audit's objection
was narrow and correct: **the response did not carry that caveat**, so a caller saw
`all_meet_aa: true` with `notes: []` over a text run that fails. See
`ACCURACY.md` §5f.

### Fixed

- **F6 — a clean verdict is never silent about a weak premise.** A single-colour
  fit below `GOOD_FIT_FRACTION` (0.8) now always produces a `notes` entry naming
  the gradient possibility and the `background_mode: "local"` remedy — even when
  the 0.5 adequacy floor calls it adequate. Measured case: a shallow gradient at
  `explained_fraction 0.542` previously returned `notes: []`.
- **F6 — a clean global verdict is arbitrated against the per-tile model.** When
  the global result is about to be `all_meet_aa: true`, the same region is
  re-measured with the local model and any failing tone it finds is disclosed in a
  new `model_disagreement` block and in `notes`. This closes the invariant: no
  response may read `all_meet_aa: true` with empty `notes` while a text run in
  scope fails contrast and an available mode returns it.
- **§3 — `background_fit` no longer contradicts its own note.** In multi-plateau
  mode it previously said the value was meaningless while still reporting
  `adequate: true`. It now reports `applicable: false`, `adequate: null` (falsy)
  and `not_applicable_reason`.

### Changed (documented semantics)

- `background_fit` gains `applicable` (boolean). In a multi-plateau region
  `adequate` is now **`null`** rather than `true` — a caller testing
  `if (background_fit.adequate)` now correctly gets "not fine" instead of a
  contradiction. The raw `explained_fraction` is still reported.
- New `notes` may appear on regions with a fit between 0.5 and 0.8 that previously
  produced no note. This is deliberate: a 50–80% fit is not a good background
  model, and the response says so.

### Added

- `model_disagreement` result key: `{ global_all_meet_aa, local_all_meet_aa,
  local_failing_count, local_failing_colours[], note }`. Only present when the
  global verdict is a clean pass and the per-tile model disagrees.
- `GOOD_FIT_FRACTION` constant (0.8) in `lib/measure.js`.
- `buildShallowGradientFixture()`, `buildSteepGradientFixture()`,
  `buildCardsFlatFixture()`, `buildTextHeavyFlatFixture()` in
  `test-support/fixtures.mjs`; 6 tests in `test/background.test.js` (now 30).
- `verify/nonvacuity-round5.mjs` (3 non-vacuous cases).
- `verify/verify-background-live.mjs` now also prints the round-5 (F6) checks,
  including that the caveat reaches the `analyze_image_structured` prose.

### Considered and REJECTED on measurement (recorded so it is not retried)

- **Raising the adequacy floor.** Fit on legitimate flat UIs was measured at
  0.904 (text-heavy page) and 0.619 (card grid). Any floor that catches a 0.542
  gradient would also flag a perfectly flat page. Floor left at 0.5.
- **A tile-modal spatial-spread gate.** Measured 17.3 on the shallow gradient vs
  325.6 on a two-panel layout — it does not separate a gradient from a panel, so
  it cannot be a lone gate.
- **Presenting `local` as the remedy for every disagreement.** On a dense flat
  dashboard the two models disagree because local *over-reports* (the known §5c
  behaviour), so `model_disagreement` is a detector whose wording states that
  local is not generally more accurate.

### Deliberately NOT changed

- The adequacy floor (0.5), the WCAG formula, and the ≥2-plateau gate.
- The §1 acceptance path: with one plateau and a clean fit the result is unchanged
  (no marginal note, no `model_disagreement`).

---

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
