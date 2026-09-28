# Changelog

## Thirty-second audit: the witness filter deleted the worst text (F39) — 2026-09-28

Round 31's G2 filter kept a witness only when `rgbDistance > PLATEAU_MERGE_DIST` (12). `rgbDistance`
is **Euclidean** (12 ≈ 6.9/channel) and low-contrast text is closest to its background, so the
filter deleted the **most** failing text and read `clean` — the opposite direction from F38,
produced by F38's follow-up. See `ACCURACY.md` §5ai.

### Fix — separate the decision from the naming

The two quantities were collapsed. Now:

- **decisive** (may force an abstention) = any failing colour **not identical** to the background it
  was measured against (distance **0**);
- **disclosable** (may be named) = decisive minus near-background colours (within
  `PLATEAU_MERGE_DIST`), falling back to decisive when empty.

The distance is used only for what is named. Restores k=3–8 (distance 5.2–13.9) to `unverified`
while preserving G2's intent.

### Cause (b) — recorded open

At k=10–16 **both** models lose the fill (the local model's only failing colour is the page
`#1a1814@1:1`), so `clean` is evidence-based but wrong. Upstream of this filter; its own round.

### Guards and tests

- New **F39** test sweeps the **fill colour** at fs=300 (the F38 test only sweeps size at
  `#312f2c`, distance 24 — the boundary was invisible to it).
- The round-31 G2 guard is rewritten to assert the **narrower** decision property (perturbing a
  mechanism is not a test of its width).

### Verification

- `npm test` **133/133**; non-vacuity **30/30** (**134 guards**); round-31 guard all **NON-VACUOUS**.

## Thirty-first audit: the F38 fix's own contradiction, and a background witness — 2026-09-28

F38 verified fixed (band sweep holds; the false-negative attack — turning a `failing` into
`unverified` — **failed**). Three mechanical gaps fixed; one decision recorded. See `ACCURACY.md`
§5ah.

### G1 — the F38 fix reintroduced the contradiction it removed

`background_fit.adequate` is `frac >= 0.5`, but the abstention note branched its wording on
`GOOD_FIT_FRACTION` (**0.8**). At 500px (0.776) the response said `adequate: true` **and** that the
background "varies... not to be trusted" — a note contradicting a field in the same object. **Fixed**:
the note now tests the predicate the response publishes (`backgroundFit.adequate`).

### G2 — a local witness that IS the background

At 400/500px the local witness list included `#1a1814@1:1 vs #1a1814` — the page colour. **Fixed**:
witnesses within the platform's merge distance of the background they were measured against are
filtered (the local model's known over-report).

### G4 — `verdict` was `undefined` on the abstention paths

Both abstention early-returns now carry `verdict: "unverified"` and `wcag_aa: null`, so the
recommended field is never `undefined`.

### G5 / F7 — recorded, not fixed

The proposed `explained_fraction >= 0.8` discriminator is **falsified** (500px sits at 0.776, inside
its own band). F7's witnesses are **page-texture tones, not text** (measured from the fixture), but
`isLargeBackgroundRegion` does not catch them (fragmented texture); classifying them is a real change
that deserves its own round. F7 stays `unverified` (conservative). F6's witness is genuine text, so
F6's abstention is defensible. Both F6 and F7 are now `null`/`unverified` where previously `true`.

### Verification

- `npm test` **132/132**; non-vacuity **30/30** (**132 guards**); `verify/nonvacuity-round31.mjs` all
  **NON-VACUOUS**; **no red checks** in the live harness on 11402.

## Thirtieth audit: the verdict field contradicted the tool's own cross-check (F38) — 2026-09-28

F36/F37 verified by the auditor (independently), and the `0.5 → 0.2` threshold survived an attack
sweep. This round carried a **correction against me** and a **new mechanism**. See `ACCURACY.md`
§5ag.

### Corrected — the F37 claim said "in BOTH background modes", and that was false

Reproduced in a **worktree at `a6cc6d2`**: **global** `all=false` `#151413@1.04`; **local**
`all=true` (clean) — local was already clean. The F37 test comment `ACCURACY.md` §5ae and commit
`a316f23` said "in BOTH background modes"; corrected to **global mode**. A measured claim surviving
after the measurement stopped supporting it — the exact failure mode this loop fights.

### Finding (F38)

A large outlined glyph's failing fill (`#312f2c`, 1.33:1, 25,788px) leaves the **global** verdict at
**≥240px** while `model_disagreement` names it — so the response read `all_meet_aa: true` **and**, in
the same object, named the failing colour:

| font size | global | `model_disagreement` |
|---|---|---|
| 200/220/230 | `false`, fill present | `null` |
| **240+** | **`true`**, `#ffffff` only | **names `#312f2c@1.33`** |

### Mechanism (traced)

The drop is inside `extractInkComponents`, via **two** gates applying the same 2%-of-region test:
the candidate-loop **region-size extras gate** (per-component count crosses 2% at 240px), then
`isLargeBackgroundRegion`'s per-blob mean. **No constant retuned** (that gate is F7's backstop).

### Fix — the class, not the cliff

When the cross-check finds a failing colour the global model missed, the verdict **abstains**:
`all_meet_aa: null` with a new three-valued **`verdict: "clean" | "failing" | "unverified"`**
(`all_meet_aa` follows it). The colour is already named in
`model_disagreement.local_failing_colours`; none is synthesised, so older guards stay observable.
This also changes **F6/F7** to `null`/`unverified` — their own note already said *"treat the clean
verdict as UNVERIFIED"*, so the field now agrees with the warning (a field that disagrees with its
own warning is the bug).

### Verification

- `npm test` **131/131**; non-vacuity **29/29** (**128 guards**); `verify/nonvacuity-round30.mjs`
  all **NON-VACUOUS**.
- Size band 200–500: no `all_meet_aa: true` co-exists with a disagreement; 220px still reports a
  real failure; a genuinely clean large glyph stays `true`/`clean`.

## Twenty-ninth audit: F36 — a soft shadow reported as failing text (new mechanism) — 2026-09-28

Round 28 closed with a reopening criterion: a **genuinely new mechanism**, not another instance of
the per-piece class. This round reopens on exactly that. See `ACCURACY.md` §5ae.

### Finding (reproduced, one property different)

A soft drop shadow under a card — pure decoration — was the only failing colour, so it set `worst`
and `all_meet_aa: false`:

| fixture | `all_meet_aa` | failing |
|---|---|---|
| card, no shadow | `true` | 0 |
| card + soft shadow (`σ=14`) | **`false`** | **`#0c0b09@1.35`** |
| card + tight shadow (`σ=4`) | **`false`** | **`#0a0a08@1.36`** |

### Mechanism (traced)

On a two-plateau page the shadow is a **second-ink extra** of the shadow component. That parent is
a large **HOLLOW** ring (`fill_ratio 0.2214`, box 728×468), which the primary path drops as
decoration — but the emitted extra **hard-coded** `looks_like_hollow_rectangle/straight_segment/
structure: false` (round 25), so `cl.hollow === 0` for the colour and it bypassed the decorative
gate. An extra shares the parent's box and `fill_ratio`, so it cannot be less structural than its
parent.

### Fix (one construction site, faithful not tuned)

The extra now **copies the parent's structural flags**. The discriminator is the parent's own box
geometry, measured: the shadow's parent is hollow (`0.2214`); a real outlined-text fill's parent
(its stroke) is not (`0.55–0.73`). The shadow routes into the **existing** decorative gate and is
**disclosed** in `excluded`, never silently dropped.

### Measured no-regression

A 25-case control digest (shadow triad + every F28–F35 control + the real regression fixtures + the
negative direction) diffed before vs after changed **exactly five lines**, all improvements: the two
shadows (now `true`, disclosed), a **hollow border ring** (its AA fringe toward the page was also
wrongly reported — now disclosed), and the two F37 single-plateau rows. Every F28–F35 control, F7
textured page, dense small cards, dense flat, decorative bars, the contrast fixture, plain
low-contrast text, and a solid region block are **byte-identical** (20 of 25 rows).

### F37 — a second, distinct mechanism (fixed too)

The audit stated single-plateau pages are **immune**. Measured, they are not: a shadow + text on a
flat page with no card makes **one** component whose extremal colour is the **text**, so the shadow
tone becomes its **extra** and was reported as failing text (`#151413@1.04`, in **global** mode at
HEAD — an earlier version of this text said "in both modes", which was wrong; local mode was already
clean at `a6cc6d2`/`c700845`, corrected in round 30. See `ACCURACY.md` §5ae).
pre-existing at HEAD). Its parent is not hollow — it is **near-solid and region-spanning** (box 48.7%
of the region, fill 0.996). The **existing** parent-box gate already carries this rule in its
comment (*"a GLYPH component cannot SPAN the region"*), but its threshold `0.5` sat at the gap's
text-facing edge and the parent (0.4867) slipped under. Measured, real second-ink parents are
**≤ 3.9%** of the region while decoration parents are **≥ 48.7%**; the threshold is now **0.2**,
inside the gap. The two fixes are **independently necessary** (each measured alone: Fix 1 alone
leaves F37; the threshold alone leaves a small hollow border's fringe reported).

### Verification

- `npm test` **130/130**; non-vacuity **28/28** (**124 guards**); `verify/nonvacuity-round29.mjs`
  all **NON-VACUOUS** (4 perturbation + 2 construction-site invariants).
- COUNT-INVARIANCE does **not** catch F36/F37 (measured) — recorded in the standing test's comment;
  each has its own test.
- `git grep REVERTED` clean; 11402 current pre-deploy (F34 reported, F35 filtered).

### Still untested (reopen candidates unchanged)

≥3 ink colours in one component; gradient/image fills. (Shadows/glows are now the F36/F37 case.)

## Twenty-eighth-audit closing verification: one stale item corrected — 2026-09-27

The closing verification round. The auditor independently reproduced the count-invariance
**six-of-six** coverage claim (including the three **negative** claims), re-ran the
solidity × multi-plateau interaction (no finding), and confirmed the deploy current and the
standing regression set unchanged. **All re-derived from the tree and agreed**, with **one
correction**. See `ACCURACY.md` §5ad.

### Corrected — the "300px single-glyph abstention" is stale, and not silent

The round summary listed it as a live reopen candidate (*"still open, and still hiding a failing
fill"*). **Measured at HEAD, it is not**, and the round-22 phrasing it quotes was imprecise:

| revision | `W`@300 +3px stroke |
|---|---|
| round 21 (`a304c0e`) | `all_meet_aa: null` (abstained) |
| round 23 (`c91554c`) | **`all_meet_aa: false`** (correct FAIL) |
| HEAD (`a6cc6d2`) | **`all_meet_aa: false`** |

So **round 23 incidentally fixed the 300px case**. A glyph at `fontSize ≥ ~700` still abstains,
**but discloses `#464646`** in `plateaus` (28.8%) plus a scope note — it is **not silent**. A
sweep of **108** large-glyph cases found **no** clean verdict that hides a failing fill; the two
`II@300` cases that looked clean **name `#464646` in `mask_reconciliation`**.

Disposition: reclassified from **open defect** to **behaviour, disclosed** — **not** a reason to
reopen.

### Verified independently this round

- `npm test` **128/128**; non-vacuity **27/27** (118 guards); `lib/measure.js` unchanged (empty
  diff); 11402 functional probe: F34 reported, F35 filtered.
- Count-invariance coverage re-measured defect-by-defect: F32/F34/F35 caught, F29/F30/F31 not —
  exactly as the comment claims.

### The loop stays closed

Per the agreed criteria, this round found **nothing new**: the one item was a
documentation-of-scope correction, not an engine defect. Reopen only for a **new mechanism** —
three-or-more ink colours in one component, gradient/image fills, or shadows/glows.

## Twenty-seventh-audit verification round: the standing test half-covered its claim — 2026-09-27

The verification round requested after adopting the stopping criteria. **F35 is verified fixed**
and both clauses are load-bearing (re-derived by perturbation, not by reading). One item was
found, and it is the **same family** as the F16/F19/F26 findings: a claim no test verifies. See
`ACCURACY.md` §5ac.

### Fixed — the count-invariance test now covers the path its comment claims

The `COUNT-INVARIANCE` comment claimed it *"would have caught F29, F30, F31, F32, F34 and F35."*
Measured by re-introducing each defect and running **that test**: it caught only **F35**.

**Why:** part (a) drew the stroke and fill as **separate elements**, so the fill became its own
component — a **primary** colour with **`extras = 0`** — and the second-ink path was never
entered. It therefore tested the primary path's size handling.

**Remedy (calibrated):** put the fill and its outline in **ONE element** (`<rect fill stroke>`),
fixed total 2000px, 1..16 pieces — measured as genuine second-ink at every count (extras
1/2/4/8/16, max piece **1681 → 49**, spanning the per-component qualifier). With that
construction the sweep **catches F34** (n=4/8/16 vanish under the per-component AA qualifier) and
**F32** (n=1 under the reject-any-blend rule). Part (b) keeps the primary path, explicitly
labelled.

### The claim is now measured, and narrowed

```
F32 (reject any blend)            -> caught (second-ink, n=1)
F34 (per-component AA qualifier)  -> caught (second-ink, n=4/8/16)
F35 (mean-only region rule)       -> caught (decoration, n=16/36)
F29 / F30 / F31                   -> NOT caught here; each has its own test
```

The last line was **measured** — re-introducing F29/F30/F31 leaves this test green. Asserting
they were covered would have been the very defect class this round is about.

### F35 verification (four perturbation results)

| perturbation | result |
|---|---|
| pre-F35 mean-only rule | 126/128 — `COUNT-INVARIANCE` **and** `F35` fail |
| `LARGE_REGION_SOLID_FILL 0.9 → 0.2` | fails (filters solid on-line ink) |
| mean clause dropped (total+solid only) | fails (F7 textured-page backstop) |
| restore | 128/128 |

The **mean clause protects the F7 backstop**; the **total+solid clause protects F35** — genuinely
independent, which is why the OR is the right shape.

### Acceptance evidence

- `npm test`: **128** (unchanged count; the standing test now covers more).
- non-vacuity: **118** guards (+2 coverage cases proving the new part (a) reacts to F34/F35).
- Deploy: `lib/measure.js` unchanged from HEAD; 11402 already runs round 26.

### The loop is closed

This round found **one** item, a **test-coverage/scope** gap — not a new engine defect class. Per
the criteria adopted in §5ab, reopen only for a **new mechanism** (multi-plateau × solidity, image
fills, shadows), not another instance of the per-piece error.

## Twenty-sixth-audit follow-up: the per-component error, in the other direction (F35) — 2026-09-27

The audit reported **F35** — a decoration whose **total** is region-sized but which is split into
small pieces — and diagnosed it as the fifth second-ink gate. **The reproduction stands; the
attribution and the proposed fix were both wrong**, and both corrections are measured. See
`ACCURACY.md` §5ab.

### F35 — a split background-sized decoration was reported as failing text

A `#2e2a24` decoration (contrast **1.24**) whose **total** is **2.06–2.10%** of the region but
split into 16–36 solid pieces was reported as failing text. **Pre-existing since round 21**
(identical at `a304c0e`, `11e6757`, `dc74fef`).

### Two corrections to the audit's diagnosis

- **The gate is the PRIMARY path's, not the second-ink one.** The colour is emitted as **primary
  components** (`component_count: 16, multi_colour_of: none`); disabling the second-ink
  background-size gate changes nothing. The admitting gate is **`isLargeBackgroundRegion`**
  (`meanArea / regionArea > 0.02`) — the **F14 anti-correlation** in the primary path. So F35 is
  the same **root cause** in a **different subsystem**, not a fifth second-ink instance.
- **The proposed mean→total swap would regress real text.** Measured: 15 lines of faint text =
  **4.29%** of the region, 28 lines = **6.31%**, 28 lines @20px = **9.30%** — all above the 2%
  fraction, so a total-only gate would **filter real faint text**. That is why the mean was
  originally chosen.

### The measured fix — total **and** solidity, with the mean test retained

```js
lowContrast && (meanIsRegionSized                                   // original F7 backstop
  || (totalIsRegionSized && mean_fill_ratio >= 0.9))                // F35 split decoration
```

Solidity is the faithful separator: F35's pieces are solid rectangles (`fill_ratio 1.00`), real
glyph runs are 0.05–0.62. Both clauses are **load-bearing** (non-vacuity): the mean-only form
re-admits F35; dropping the mean clause filters F32/F34's solid on-line fills; lowering the
solidity threshold filters them too. The F7 textured page (a single 33%-of-region **non-solid**
blob) still fires because the **mean clause is retained**.

### The two directions, and the standing test the audit asked for

```
per-component quantity where a TOTAL was meant
  ├─ false negative: a real fill SPLIT below a floor          F29, F30, F31, F32, F34
  └─ false positive: a decoration SPLIT below a background gate   F35
```

Adopted: a **COUNT-INVARIANCE** standing acceptance test (fixed total, varying piece count — real
ink 1/2/4/8/16 → reported; decoration 1/4/16/36 → filtered). That single test would have caught
**all six**. The second-ink **background-size** inline gate is documented as **latent** (same
shape, not reachable on any fixture, conservative direction).

### Acceptance evidence

- `npm test`: **128** (was 126); F35 + standing count-invariance.
- non-vacuity: **116** guards (was 112); `verify/nonvacuity-round26.mjs`.
- live MCP (scratch 11498): §22 — every split decoration filtered; F7/F32/F34 unchanged.

## Twenty-fifth-audit follow-up: the per-piece error, fourth appearance (F34) — 2026-09-27

Round 24 added a **size qualifier** to the AA test to fix F32 — but used `count2`, the count
**within one component**. That is **F29's exact error, one guard over**: a real on-line fill
split across glyphs has every piece under the qualifier and is discarded wholesale, in no
channel. The **fourth consecutive round** a second-ink-path gate used a per-piece quantity where
a total was meant. See `ACCURACY.md` §5aa.

### Fixed

- **F34 — the AA size qualifier is now a per-colour TOTAL.** `ABCDEFGHIJKLMNOP` @24px splits its
  on-line fill into 16 pieces of 30–127px (true total **610px**); at the per-component qualifier
  every piece was rejected and the fill appeared in **no channel** (`all_meet_aa:true`). The
  blend flag is now recorded on the candidate, its pixels accumulated into `extraBlendTotals` per
  colour, and the qualifier applied in the **deferred pass** where the total is known. Result:
  the fill is **reported px=569**, and the glyph-count sweep {2,4,8,16} is **count-invariant**.

### Why the reject cannot be inline

Measured: at the moment each component is visited the running total may still be below the
threshold, so an inline running-total does not work. The qualifier must run **after** the whole
scan — the same ordering constraint the pixel floor already satisfies.

### `MULTICOLOUR_AA_MIN_PIXELS` re-derived under the total quantity

Now justified against a measured gap of **on-line totals**: fringes ≤ **164** (huge-glyph shades
50–164, F32 stroke shades 130–154) vs real on-line fills ≥ **569** (F34 @24px). **500** sits in
the gap; the grid over {200, 300, 500, 800, 1200} is green.

### The structural rule, and the four appearances

| round | gate | per-piece quantity | fix |
|---|---|---|---|
| 22 | pixel floor (F29) | per component | total across the scan |
| 23 | floor alignment (F30) | a second scalar (224) | the primary floor (8) |
| 23 | accumulation grain (F31) | per-component totals | per-total across the scan |
| 24/25 | **AA qualifier (F34)** | per component | on-line total (deferred) |

Adopted rule, written into the code: **in the second-ink path, no gate may use a per-component
quantity without stating why the total is wrong.** The other inline gates were audited —
plateau-adjacency is a **colour** test (order-independent, safe); background-size uses
`count2 / scanArea` and is the **same shape**, named as a latent risk (not a live defect; no
fixture exercises it, and it errs toward under-rejecting background).

### Acceptance evidence

- `npm test`: **126** (was 125); F34 asserts the split fill is reported and the glyph-count sweep
  is monotonic.
- non-vacuity: **112** guards (was 108); `verify/nonvacuity-round25.mjs`; round-24 anchor repointed.
- live MCP (scratch 11498): §21 — 16 glyphs reported, count-invariant.
- Controls unchanged: F31 dense small cards, F32 matched pair, F28 outlined, tiled, dense-flat,
  photo, acceptance fixture.

## Twenty-fourth-audit follow-up: the third axis of divergence (F32) — 2026-09-27

Round 23 aligned the second-ink path with the primary path on **size** and **accumulation
grain**, but widened the AA test to the full segment `{0, 1}`, which **discarded real ink that
lies on the reference→stroke line** (F32) — the **third** consecutive round the second-ink path
diverged from the primary path, each divergence producing a false pass. See `ACCURACY.md` §5z.

### Fixed

- **F32 — a fill on the reference→stroke line was discarded.** A `#312f2c` fill (true
  **17,291px**, 6.6× the **2,617px** white stroke, contrast **1.33 FAIL**) was **reported** on
  the primary path but **absent from every channel** on the second-ink path at round 23 (the
  `t`-sweep 0.05–0.20 was reported at round 22, absent at round 23). The AA test now rejects a
  blend **only when it is SMALL**: `if (blend && count2 < MULTICOLOUR_AA_MIN_PIXELS) continue;`
  (`MULTICOLOUR_AA_MIN_PIXELS = 500`). A fringe is a thin halo; real ink is large.

### The audit's proposed fix did not work — measured

The audit proposed a **residual-only** criterion. **Rejected by measurement**: the `#312f2c`
fill sits at **t=0.10, residual 0.4** — geometrically **identical to a fringe**. No colour-space
test can keep an on-line fill while rejecting an on-line fringe. The discriminator is
structure/size, which is what the size qualifier uses.

### F33 — recorded, not fixed (and pre-existing)

- **Pre-existing**, not a round-23 regression: the F33 table is **identical at rounds 21/22/23**
  (verified by `git checkout`). Its census does **not** reproduce — the true fill at A@{10,14,16}px
  is **0px**, not 7–11px; the fill is not even a candidate component at those sizes.
- **Must not be closed by unifying the floor to 8**: measured, that re-admits the dense-flat card
  strokes (`#355540@2.26`, 14,292px) and fails 4 tests. The mean-area scalar stays, with its
  measured basis. F33 is a **named, pre-existing** limitation.

### Alternatives measured and rejected

| candidate | outcome |
|---|---|
| residual-only AA | would reject the F32 fill too (residual 0.4) |
| largest-component floor | breaks F28-reversed (stroke fragments) |
| "fragmented AND weak" (primary constants) | fails F28/F29/F31 |
| mean-area floor 8/12/16 | 4/3/1 failures; **20** is the first green value |

### The three axes of divergence

| round | axis | divergence | defect |
|---|---|---|---|
| 23 | size | own floor (224 vs 8) | F30 |
| 23 | accumulation grain | per-component vs per-total | F29 |
| 24 | **colour proximity** | own AA rule | **F32** |

The second-ink path must not carry its own criterion for a quantity the primary path decides.

### Acceptance evidence

- `npm test`: **125** (was 123); F32 is a `t`-sweep of on-line fills, each paired with the
  primary path; F33 asserts the dense-flat control stays clean.
- non-vacuity: **108** guards (was 104); `verify/nonvacuity-round24.mjs`.
- live MCP (scratch 11498): §20 — every on-line fill reported.
- Controls unchanged: F31 dense small cards, F28 outlined, tiled cards, dense-flat, acceptance
  fixture (worst `#1e1c18@1.04`).

## Twenty-third-audit follow-up: the second-ink path had its own scalar (F30, F31) — 2026-09-27

Round 22 fixed F29 by aggregating the pixel floor across components, but kept a **separate,
28× larger scalar** (224) for the second-ink path. That scalar was the whole problem, on both
sides at once: it **hid** failing ink (F30) and its companion per-total behaviour **admitted**
accumulated decoration (F31). See `ACCURACY.md` §5y.

### Fixed

- **F30 — the second-ink floor was 28× the tool's own primary floor.** The primary path
  reports every ink colour above `minColourPixels = 8`; the second-ink path required 224. So the
  SAME ~210px of failing `#464646` was **reported** as a plain 16px run and **hidden** as a
  30px outlined fill — same colour, opposite verdicts (the F13/F14 seam in its original form).
  The floor is now the **same quantity** (`DEFAULT_MIN_COLOUR_PIXELS = 8`) for both paths.
- **F31 — the per-total floor admitted accumulated card/text AA fringes.** `dense_small_cards`
  flipped from `all_meet_aa:true` (round 21) to `false` (round 22) with a new failing
  `#443f38@1.4` (reported 1226px, 227 components; true 663px). Mechanism: a card↔text
  anti-aliasing blend at **t=0.12**. Fixed by the colour-aware gates below.

### The gates (all measured; the two new ones are both load-bearing)

- **AA window widened to the full `(0, 1)` segment** for the second-ink test. Rejects by
  **residual**: fringes sit **on** the ref→extremal line (residual ≤ 0.5), real ink does not
  (`#464646` residual **7.4**). The general merge path keeps its conservative `(0.25, 0.98)`.
  Reverting it fails **4** tests.
- **Mean-area structural gate = 20** (the primary path's own doctrine, but a *different
  quantity* than `MIN_TEXT_MEAN_AREA = 100` — a fragmented run's mean falls as text is added,
  F14). Measured gap: decoration ≤ 12, real ink ≥ 22. Removing it fails **5** tests.
- Plateau-adjacency and parent-box gates kept (load-bearing).

### The answer to the audit's CI question

The suite did **not** assert `all_meet_aa` for the auditor's fixture because the in-process
`buildDensePanelFixture` is a **different family** (`#666460@2.47`, a real failure) — so the F31
regression was invisible to CI **by construction**. Fixed by adding
**`buildDenseSmallCardsFixture`**, which reproduces F31 in-process (on the round-22 code it
returns `all_meet_aa:false` with `#534d45@1.75`; on this code it is clean).

### Acceptance evidence

- `npm test`: **123** (was 121); F30 is an invariance pair (plain 16px vs outlined 30px must
  agree), F31 asserts the dashboard stays clean and the fringe colour never appears.
- Recall **11/11**: AB/ABC/ABCDE at 20–30px all report `#464646@1.88`.
- non-vacuity: **104** guards (was 99); `verify/nonvacuity-round23.mjs`; rounds 21/22 anchors
  repointed to the unified floor.
- live MCP (scratch 11498): §19 — F30 paths agree, F31 fixed.
- Controls unchanged: tiled cards, dense flat, acceptance fixture (worst `#1e1c18@1.04`).

## Twenty-second-audit follow-up: F28's own gate reappears one scalar lower (F29) — 2026-09-27

The round-21 fix (§5w) was **correct in direction and incomplete in aggregation**: it applied
a pixel floor **per component** where the quantity that matters is the colour's **total** —
the F13/F14 construction. See `ACCURACY.md` §5x.

### Fixed

- **F29 — small outlined text lost its fill as it split across components.**
  `MULTICOLOUR_MIN_PIXELS` was applied to a single component's count, so as a glyph shrank its
  fill split (measured: 48px outlined "AB" fill = 400 + 485 = **885px**, both pieces under 512)
  and no piece cleared the floor — the failing fill appeared in **no channel** and
  `all_meet_aa: true` was returned. The floor is now applied to the colour's **total across the
  whole scan** (`extraTotals`), decided once per colour, then emitted in each component that
  holds it. Fragmentation-invariant.
- **The floor moved with the granularity: 512 → 224, MEASURED.** Aggregation removes
  ordinary-text AA fringes entirely (0 candidate extras at every plain-text size 10–96px), so
  the constraint that set 512 is gone. The binding constraint is structural card shades. Floor
  sweep (full-suite failures): 0→31, 128→4, 200→2, **224→0**. 224 is just above the measured
  false positives (card edge shade 204px) and just below the smallest defect case (32px fill
  252px). This is a different quantity, not a re-tuned 512.
- **Plateau-adjacency gate ADDED (load-bearing).** Skip an extra within `PLATEAU_MERGE_DIST` of
  a detected plateau. Turning the floor into a total let dense-flat border tones sum past it
  (measured `#232931` → 2560px); without the gate the F7 verdict fails. Measured separation:
  dense-flat card extras 4.1–9.5 from a plateau, the outlined fill 80.9 away.
- **Structure gate REMOVED (measured redundant).** Needed at a per-component floor in round 21;
  at the 224px **total** floor it is not — the floor already rejects the tiled card edge
  (204px). Verified: removing it kept 121/121, so it is not carried.

### Measured and rejected

- **Floor 0 + AA-blend test alone** — disturbs the flat cases (tiled grid, huge glyph,
  flat/local identity). The AA test alone is not sufficient. Recorded, not recommended.
- **Lowering the AA blend `minT` to reach 28px** — catches the dense-flat shades but not the
  tiled card-shade **continuum** (`#413c35@1.34`, `#e6e6e6@1.25`), so no clean gate exists.

### The honest boundary

The fix reaches every case where the defect **applies** (the fill is the larger ink). Measured,
the fill dominates the stroke down to **32px**; at **28px the fill (158px) is smaller than the
stroke (216px)**, so the larger ink **is** reported and hiding the smaller one is a
reporting-floor question, not F28 absorption. The test sweeps 32–180px and asserts the boundary.

### Acceptance evidence

- `npm test`: **121** (was 120); F29 test asserts the defect window, the aggregation
  non-vacuity case ("ABC" 30px, pieces 221 + 68), the 28px boundary, and the tiled control.
- non-vacuity: **99** guards (was 95); `verify/nonvacuity-round22.mjs` perturbs aggregation, the
  emission, the plateau-adjacency gate, and the parent-box gate; round-21 anchors were
  repointed to the round-22 two-pass code.
- live MCP (scratch 11498): §18 — every size 32–72px reports the failing fill, aggregation
  WORKS on the split case, the 28px boundary is honest.
- Controls stay clean: tiled card grid, dense-flat page, acceptance fixture (worst `#1e1c18@1.04`).

### Named, not fixed

**F30** — large display glyphs (300–700px) return `all_meet_aa: null` via
`abstained: "contrast ratio of text"`, hiding a failing fill. Verified **identical at HEAD**
(pre-existing, out of scope here), named so it is not lost.

## Twenty-first-audit follow-up: back to the engine (F27, F28) — 2026-09-27

Round 20's disposition was to **stop extending the documentation guard** and spend the next
round on the **measurement engine**. The guard is untouched (frozen, recall `18/19`). Both
defects below share one shape: the engine **had** the evidence that its model was wrong, and
**still published a verdict**. See `ACCURACY.md` §5w.

### Fixed

- **F27 — a text-free gradient was reported as FAILING text.** A `#101010`→`#606060` gradient
  with no text reported `all_meet_aa:false, failing:1`, the "failing colour" being `#606060`
  at 2.98:1 across **659,000px (94% of the region)** — the ramp's own far end. A single global
  background explains only **8.3%** of the region (`adequate:false`), so the ramp end cleared
  the ink threshold; but `all_meet_aa`/`failing_count` were computed **before** `background_fit`
  existed and the `!adequate` branch only added a note. Now, when the global verdict is a
  **failure** and the model is **inadequate** (not multi-plateau, not explicit background),
  the region is re-run with the per-tile model: if it finds **no text** the engine **abstains**
  (`measurable:false`, `all_meet_aa:null`); if it **does** find text the global verdict is kept
  (F5 contract) and the local failing colours are disclosed in `model_disagreement`. This is the
  **mirror of the F6 clean-pass guard**. Scoped to `adequate:false` (only the three gradients).
- **F28 — outlined text: the darker of two colours was discarded and a failure hidden.** Fill
  `#464646` (**1.88:1 — FAILS**) + 3px stroke `#e8dfd0` (13.42 pass) reported
  `#e8dfd0@13.42 px=22725, all_meet_aa:true`. Independent census: true stroke **2,617px**,
  true fill **17,269px (6.6× larger, FAILING)** — in **no channel**. The component colour was
  its **extremal pixel** (the stroke) and `pixel_count` was the whole component. Each additional
  colour that clears the gates is now emitted as its **own entry** with `multi_colour_of`; the
  parent's count is reduced by what was broken out, so the two **sum to the component** and the
  larger ink has the larger count.

### Measured gates (and two candidates rejected)

| gate | value | measurement |
|---|---|---|
| absolute pixel floor | 512 | true ink 2,561–20,706px; AA fragments 68–158px |
| not an AA blend | — | a fringe blends toward the extremal colour |
| not background-sized + low-contrast | >2% area **and** <1.5 ratio | dense-flat tones 124k–185kpx at 18–27% |
| parent box ≤ 50% of region | 0.5 | photo/dense-flat parent = 1.000; real glyph = 0.028 |

- **A *share* floor (≥0.2) was tried and REJECTED:** a share is anti-correlated with size
  (the F14/F15/F20 trap) and it **failed the reversed direction** (light fill + dark stroke).
- **A structure gate was measured REDUNDANT and removed:** border edge shades are 68–313px,
  below the 512px floor; removing it kept **120/120**.

### Both directions in one test

A fix that always kept the extremal colour passes dark-fill and **fails** light-fill; both live
in ONE acceptance test, plus a fill-only control.

### Acceptance evidence

- `npm test`: **120** (was 118); F27 and F28 tests added.
- non-vacuity: **95** guards (was 90); `verify/nonvacuity-round21.mjs` perturbs the F27 abstain
  branch, the F27 local-measurable guard, the F28 emission, the F28 pixel floor, and the F28
  parent-box gate — all five fail their tests when perturbed, then restore byte-identically.
- live MCP (scratch 11498): §17 reports F27 fixed and F28 fixed **both directions**.
- The flat acceptance fixture is **unchanged** (5 colours, worst `#1e1c18@1.04`).

### Open, stated not implied

The photographic fixture shows a **deeper limitation**: a drifting gradient links its tones into
**one region-spanning blob**, so the pink **text** tone sits inside a blob whose box is the whole
region. Surfacing it under a single global background is **unproven**; the per-tile model
resolves it. The parent-box gate exists precisely to reject such blobs.

## Twentieth-audit follow-up: the disposition was declared, not recorded — 2026-09-27

Round 19's disposition promised the phrase guard's recall would be **a measured number** —
written in **four places** (`prose-guard.mjs` header, `ACCURACY.md` §5q/§5t, `README.md`)
and **measured nowhere**. The only figure in the repo was the **stale** round-15 `1/9`. That
is the **F16 defect one layer up**: a scope claim about the guard that no test could fail.
See `ACCURACY.md` §5v.

### Fixed

- **F26 — the recall is now measured, printed, and enforced.** The fixture set moved to
  `test-support/prose-recall-fixtures.mjs` (deliberately **not** scanned — it contains the
  live claims as fixtures). The test prints
  `measured recall on the fixture set: 18/19` and **asserts the ratio ≥ 18/19**, so a
  regression **fails the build** instead of quietly changing the story the docs tell.
- **F26 — a doc-consistency assertion.** A test requires `README.md`, `ACCURACY.md`, and the
  guard header to **quote the same figure** the guard measures, and requires the stale `1/9`
  to be **labelled historical**. This is the invariance pair moved from the guard to its own
  description.
- **"Not a barrier" corrected.** Measured: the rule is **assert-only** (22 assertions, no
  advisory path) and injecting a claim into `README.md` gives **`fail 2`** — so it **is** a
  barrier. The wording now says the lint **fails the build**; what we no longer rely on is its
  **completeness**.

### Scope note (stated, not implied)

**18/19 is a regression score over the known escape cases, not an estimate of recall over
unseen prose.**

### Audit hypotheses retired by measurement

The audit predicted the `GLUE` list would produce escapes (`is said to order`); all twelve
are **correctly flagged**, because glue is consulted only *after* a negation is found. That is
the second audit hypothesis falsified by measurement (round 17's "negation after the verb"
was the first).

## Nineteenth-audit follow-up: the no-sentence-end marker and the retraction FPs — 2026-09-27

**Seventh round of one class** — and the last. Two defects fixed cheaply; the guard is now
**FROZEN as a best-effort lint** and the positive disclaimer assertion is the **primary
gate**. See `ACCURACY.md` §5u.

### Fixed

- **F24 — a marker with no sentence end waived the entire remainder.** `end >= 0 ? slice :
  ""` meant a marker whose cell had no sentence-ending period waived everything after it —
  **strictly easier** than round 18's case, needing no punctuation anywhere. A marker now
  waives a complete lead clause ending in `[.!?]`, **else** a leading quoted span, **else**
  nothing.
- **F25 — legitimate retractions were false positives, and they were latent in the repo.**
  `is not able to distinguish`, `cannot be said to separate`, `should not be used to order`
  were **flagged although they retract** — punishing anyone who writes the disclaimer. A
  `GLUE` list (content words that **carry** retraction) restores them; modal negations
  (`should not`, `must not`, …) added to `NEG_STRONG`.
- **POLARITY:** `fail|fails` is **deliberately excluded** from `GLUE` — `never fails to
  order` is a double negative that **asserts** the claim. It is a permanent must-flag fixture.

### Measured design

| design | escapes | false positives | real-doc flags |
|---|---|---|---|
| round-18 | 2–3 | 5 | 0 |
| marker=**strict** (negative control) | 0 | 5 | **5** |
| marker=quote alone | 0 | 5 | 0 |
| **glue(no `fail`) + quote-span** | **0** | **0** | **0** |

`marker=strict` shows the marker list is load-bearing (it re-flags the `[REMOVED CLAIM]`
history); the adopted design needs no exemption.

### Disposition — stop extending this guard

Seven rounds, **one new escape class per fix**. The positive assertion is now the primary,
paraphrase-proof gate and a named test; the phrase rule is a best-effort lint whose recall is
a measured number; the invariance pair remains the acceptance test. Effort should return to
the **measurement engine** (F1–F14), where the defects were findable by fixture ground truth.

## Eighteenth-audit follow-up: governed negation and the span-scoped marker — 2026-09-27

**Sixth round of one class.** Each round narrowed the *scope* of an exclusion (line → clause
→ 25 chars → ≤6 chars → governed) and left its *kind*: a proximity/vocabulary test on
author-controlled prose. A new phrasing escaped every round. This round closes the two
latest openings **and changes the goal**: the positive disclaimer assertion is now the
primary check, the phrase guard is a best-effort lint with a measured recall, and the
**invariance pair** is a named acceptance test. See `ACCURACY.md` §5t.

### Fixed

- **F22 — the strong negation must GOVERN the verb.** `NEG_STRONG` was matched against a
  25-char window, so `never fails to order` (in a quoted example) waived a claim that
  *asserts* the classification (also `without blinking`, `no longer
  ambiguous`). Now the last strong negation before the verb must have only **function
  words** between it and the verb. `without \w+ing` is **removed** (widest offender).
- **F23 — a marker waives only the SPAN it precedes** (to the first sentence end), not the
  whole cell, so an unrelated claim later in the cell no longer escapes.

### Accepted cost (documented, asserted)

Governing trades escapes for false positives: legitimate retractions with a **content word**
between the negation and the verb (`is not able to distinguish`, `cannot be said to
separate`, `should not be used to order`) are now **flagged although they retract**.
Measured on the fair union: escapes **3 → 0**, false positives **1 → 5**. Adopted because
escapes are **silent** while false positives are **loud**; the five are asserted in the test
suite so the trade cannot silently reverse.

### Withdrawal

The seventeenth audit's **idiom-list recommendation is withdrawn by the audit itself**
(`idiom-affects=0` across 20,813 clauses — dead code, matching my round-17 measurement).

### Also

- `test-support/prose-guard.mjs` is now in **both** doc-scan file lists.
- The period-splitting regression the audit met in its own F23 candidate (`lib/measure.js`)
  is guarded by `\w\.\w` protection plus a test.

## Seventeenth-audit follow-up: the adjacency window and the cell-scoped marker — 2026-09-27

Round 16 scoped the negation to a 25-char window before the verb, but that window contained
words that are **not negations in ordinary use** (`no`, `instead`), so natural phrasing
waived a claim; and a structural marker in one table cell waived a claim in **another** cell.

- **F20** — the negation is now **two-tier**: strong negations keep the 25-char window;
  ambiguous `not`/`no` count **only immediately before the verb** (≤6 chars). The audit's
  proposed **idiom list was implemented, measured (0 of 20,526 clauses), and REMOVED** as
  dead code.
- **F21** — `flagsClassificationClaim` splits on `|` **first** and evaluates each cell, so a
  marker waives only its own cell; plus a two-directional assertion that every marker-bearing
  line is un-flagged.
- End-to-end: appending an `no doubt`-style or `instead`-adverb phrasing of the claim to
  `README.md` now **fails** the suite (was 110/0).

## Sixteenth-audit follow-up: the waiver token and the field-anchor gap — 2026-09-26

Round 15 fixed the named P6/P7 cases by adding two **free-text waiver tokens**
(`[PARAPHRASE]`, "not a claim of this document") so the escape table could quote
paraphrases. Because a token is matched against the **clause**, any claim sharing a clause
with it was waived — the **P6/P7 defect, reintroduced by the patch written to remove it**,
**fourth round running**. The audit proved it end-to-end: appending
a classification claim + the token to `README.md` **passed**
the suite. Separately (F19), the field anchor listed **5** names while the entry emits
**9** keys, so a claim naming an unlisted (or future) field escaped by construction. See
`ACCURACY.md` §5r.

### Fixed

- **F18 — waiver by STRUCTURE, not by keyword.** `STRUCTURAL_MARKER` matches only at the
  **start of a line** (allowing table cells and markdown markers before it), so a trailing
  token no longer waives. The two free-text tokens are **deleted**.
- **F18 — the negation is scoped to the token it negates (measured).** A claim is waived
  only when a negation is within ~25 chars **before the verb** (`does not **order**`), not
  "somewhere in the clause". This closes the E1–E6 class (`amended`/`removed`/`invert`/
  `coincidence` no longer waive). Measured before adopting: 16/17 paraphrases caught, **0**
  false positives on the real docs (the old clause-anywhere rule caught 9/17).
- **F19 — the field anchor covers every emitted key**, and a test asserts it against a
  **live** entry, so adding a field without extending the anchor fails the guard.
- **Single source of truth.** The rule moved to `test-support/prose-guard.mjs`, imported by
  the test **and** the live script, so it cannot drift between them.

### Stale anchors repaired

Renaming the guard test left `verify/nonvacuity-round14.mjs` and `-round15.mjs` with
`--test-name-pattern` values that matched nothing, so **zero** tests ran and their guards
passed **vacuously**. Both repointed. (Same silent-stale-anchor trap noted since round 9.)

### Known miss (unchanged)

**P4** still escapes (its comma splits the field from the verb). Recorded, not hidden.

## Fifteenth-audit follow-up: the prose guard's scope claim exceeded its rule — 2026-09-26

Round 14 called the prose guard "durable" and said the claim "cannot silently return".
**That overstates a regex.** Re-running the round-14 rule against nine paraphrases of the
same false claim caught **1 of 9** (verb/object list gaps, a 60-char distance limit, and —
the sharper half — a **line-scoped exculpatory waiver** that excused a genuine claim on
any stray word such as `not decoration` or `large from small`). This is the **third round
running** where an anti-defect mechanism reproduced the defect it was built to stop. See
`ACCURACY.md` §5q.

### Fixed

- **F17 — the guard is now clause-scoped and field-anchored.** A line is flagged only if a
  clause (split on `[;,:]`, **never `.`** — file paths and decimals contain periods)
  contains a field name **and** a classification verb **and** a decoration/text object,
  with no negation in the *same* clause. Measured: **9/10** paraphrases caught, **0** false
  positives on the real docs (the widened verb/object lists otherwise produced **26** false
  positives without the field anchor).
- **F17 — a positive assertion (fix #4).** Because no regex achieves recall and precision
  together, the guard is paired with a structural check: the explicit disclaimer must be
  present in `lib/measure.js`, `README.md`, and `ACCURACY.md`. Paraphrase-proof.
- **F17 — the claim is narrowed.** The test is now named *"catches the LITERAL regression
  (not 'any claim, ever')"*; the "cannot silently return" sentences are corrected in
  `ACCURACY.md` §5p and here.
- `index.js` (tool-schema prose that reaches callers) is now scanned — future-proofing; it
  currently contains no classification prose.

### Known miss (recorded, not hidden)

Paraphrase **P4** escapes because its comma splits the field from the verb. Catching it
would need cross-clause proximity, which reintroduces the false positives the field-anchor
prevents. So the honest claim is **"the literal regression is caught"**, not "the claim
cannot return".

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
