# FLAGS

Numbered register of things found wrong, ambiguous, or unverifiable during the
build. Nothing here was silently fixed and nothing known-wrong was silently
passed. Entries marked **[SPEC]** are corrections to the build specification
itself, established empirically against live data on 6 August 2026.

---

## F1 — [SPEC] `END OF REPORT` is a total line count, not a data row count

**Spec §2.1** says:

> validate against the `C,"END OF REPORT",n` row count. If the parsed row count
> does not match `n`, throw.

That reads as "count of `D` rows". It is not. `n` is the **total number of lines
in the file**, including the `C` header, every `I` schema row, and the
`C,"END OF REPORT"` line itself.

Measured across three different report types on live files:

| File | C rows | I rows | D rows | C+I+D | footer `n` |
|---|---|---|---|---|---|
| `PUBLIC_DISPATCHSCADA_202608062300` | 2 | 1 | 513 | **516** | **516** |
| `PUBLIC_DISPATCHIS_202608062305` | 2 | 6 | 987 | **995** | **995** |
| `PUBLIC_P5MIN_202608062305` | 2 | 5 | 11732 | **11739** | **11739** |

Implementing the spec's wording literally would throw on **every file ever
published**. The parser asserts `C + I + D === n` and reports both figures on
mismatch.

**Status:** resolved in code, flagged because it contradicts the spec. No
decision needed from Mat.

---

## F2 — [SPEC] Post-reform WEM SCADA is also MWh-per-interval, not MW

**Spec §2.4** confines the unit trap to pre-reform files:

> Pre-reform WEM `facility-scada` files (up to 30 September 2023) report
> **energy over the interval in MWh**, not instantaneous MW.

and **§2.5** then recommends ingesting post-reform only, which reads as though
choosing post-reform sidesteps the trap. **It does not.** The post-reform WEMDE
`facilityScada` JSON reports `quantity` in **MWh per 5-minute interval** as
well.

Established by comparing daily maxima against registered capacity
(`SCADA_2026-08-05.json`, 76 facilities, 288 intervals):

| Facility | max `quantity` | × 12 | Registered capacity | Match |
|---|---|---|---|---|
| `COLLIE_G1` | 26.947 | 323.4 MW | ~340 MW | ✓ |
| `NEWGEN_KWINANA_CCG1` | 27.937 | 335.2 MW | ~340 MW | ✓ |
| `BW1_BLUEWATERS_G2` | 17.969 | 215.6 MW | 217 MW | ✓ |
| `ALINTA_WGP_GT` | 16.405 | 196.9 MW | ~200 MW | ✓ |

Read as MW, Collie would sit at 27 MW of 340 MW all day, every unit, every day.
Read as MWh/interval the values land on nameplate. This is the OpenNEM Muja 7
bug exactly, in the dataset the spec said was safe.

Handled per §2.4's own instruction: an explicit `unit` field is carried through
ingest and converted at one named function (`toMW` in `harvester/normalise.js`).
The unit is set from the **source**, never inferred from magnitude.

**Status:** resolved in code. Flagged because it inverts a spec recommendation
and would have silently produced a national total roughly 12× too low for WEM.

---

## F3 — [SPEC] No public real-time source exists for UIGF, SEMIDISPATCHCAP, AVAILABILITY or CLEAREDMW

**Spec §5.1** states `DispatchIS_Reports/` provides, every 5 minutes:

> `DISPATCHLOAD` table: `AVAILABILITY`, `TOTALCLEARED`, `INITIALMW`, `SEMIDISPATCHCAP`

The public `DispatchIS_Reports` file contains **no unit-level table at all**.
Tables actually present:

```
DISPATCH,CASE_SOLUTION,2      DISPATCH,INTERCONNECTORRES,3
DISPATCH,CONSTRAINT,5         DISPATCH,PRICE,5
DISPATCH,INTERCONNECTION,1    DISPATCH,REGIONSUM,9
```

`P5_Reports` was checked as the other candidate and is also region-level only
(`CASESOLUTION`, `CONSTRAINTSOLUTION`, `INTERCONNECTORSOLN`, `LOCAL_PRICE`,
`REGIONSOLUTION`). AEMO withholds unit-level dispatch from the public real-time
feeds.

Unit-level data appears **next day** in `Next_Day_Dispatch`, whose
`DISPATCH,UNIT_SOLUTION,6` table does carry every field the spec wants:
`INITIALMW`, `TOTALCLEARED`, `AVAILABILITY`, `SEMIDISPATCHCAP`, `UIGF`,
plus `INITIAL_ENERGY_STORAGE` / `ENERGY_STORAGE` for batteries.

**Consequence for the design:**

| Mode | Available | Effect |
|---|---|---|
| Replay / backfill (the centrepiece) | Full fidelity — UIGF, SEMIDISPATCHCAP, curtailment, availability | Unaffected. Curtailment masking and UIGF training targets work exactly as §2.7 requires. |
| Live 5-minute mode | `Dispatch_SCADA` actual MW only | Curtailment cannot be masked in real time. Predictions still run from weather. |

The app resolves this by reconciling the previous day when `Next_Day_Dispatch`
lands (~04:10 NEM time): live intervals are backfilled with UIGF and the
curtailment mask retrospectively, and any interval whose mask is not yet known
is labelled as such in the data quality strip rather than assumed unmasked.

**Status:** worked around, and honestly surfaced in the UI. Flagged because it
is a real capability limit of the public data, not of this build, and it means
live-mode curtailment figures are always one day behind.

---

## F4 — RESOLVED, and it was my error: WEM has three years of history

**This entry was wrong, and Western Australia was left out of the dashboard
because of it.** It originally read "WEM has no usable history", on the basis
that `facilityScada/previous/` was empty.

That directory is not empty and, on the evidence, never was. It holds one zip
per trading day from **29 September 2023** — 1,041 files at the time of writing,
just under three years. What holds a single day is `facilityScada/current/`,
which is the day in progress; the original check must have read that one and
generalised. The conclusion drawn from it, that the replay could only ever be
NEM-only, then went unquestioned through every later pass.

The correction, measured rather than asserted:

| | |
|---|---|
| Archive span | 2023-09-29 to 2026-08-05, 1,041 daily files |
| Facilities in a day's feed | 76 |
| Joined to a registry station | 70, onto 48 stations |
| Registered capacity covered | 97.3% of the SWIS |
| Stations now modelled | 37 |

**The join had to be inferred.** Open Electricity names a WEM station by a short
code (`COLLIE`); AEMO's SCADA reports facilities (`COLLIE_G1`, `BW1_BLUEWATERS_G2`).
No crosswalk is published, so `wem-registry.js` matches a station whose code
appears as a run of *whole* underscore-delimited tokens inside the facility
code — narrow enough that it cannot join by coincidence, wide enough to survive
an owner prefix. Substring matching would have been easier and would have joined
unrelated plant.

Two faults the first join produced, both now fixed and both worth recording
because they are the shape of error this kind of inference makes:

- **Storage swept into its host.** Open Electricity has no entry for Collie's
  battery, so `COLLIE_BESS2` and three `COLLIE_ESR*` facilities folded into a
  318 MW coal station and made it a 907 MW one. Storage is excluded from a host
  that is not itself registered as storage, and the six exclusions are listed in
  `registry.json`.
- **A nameplate that has not kept up.** Greenough River reports 35 MW against a
  registered 10 MW. That is Open Electricity being stale, not a bad join, and it
  is caught by the same over-nameplate rule the NEM side uses: those intervals
  are marked `suspect` and stay out of every fit.

**What WA still cannot have.** The WEM feed publishes no available-energy figure
and no curtailment flag — no UIGF, no semi-dispatch cap. So WA stations are
forecast against actual output rather than available energy, and they get none
of the curtailment masking the eastern states get. That is stated in the data
quality strip rather than left for the reader to discover.

Units are the F2 trap: `quantity` is MWh over the interval, converted once in
`wemQuantityToMw`. Interval stamps are AWST with an explicit offset and refer to
the interval's end, but the value is an average over it, so `WEM_QUANTITY`
carries a −2.5 minute shift in `align.js` — the middle of the window it
describes, rather than either edge.

**Status:** resolved. WA is in the registry, the backfill, the replay and the
region table. The lesson is not about WEM: a limitation recorded once was
believed for the rest of the build without anyone re-checking the directory it
rested on.

---

## F5 — CORS verified: the harvester is required for NEM, not for WEM or weather

Phase 0 measurement (§3 required this be verified rather than assumed), with
`Origin: http://localhost:8080`:

| Host | `Access-Control-Allow-Origin` | Browser can fetch directly? |
|---|---|---|
| `nemweb.com.au` | **absent** | **No** — harvester required |
| `data.wa.aemo.com.au` | `*` | Yes |
| `api.open-meteo.com` | `*` | Yes |
| `visualisations.aemo.com.au` | `*` | Yes |

The spec's Section 3 assumption holds for the source that matters. The harvester
stays a runtime dependency for NEM. WEM and `ELEC_NEM_SUMMARY` are routed
through the harvester anyway for one schema and one cache, not because CORS
requires it.

**Status:** assumption confirmed. No decision needed.

---

## F6 — Tailem Bend 2's solar farm is curtailed in every interval it produces

`TB2HYB` (Tailem Bend 2 Hybrid, 155 MW) is the one modelled station with no
weather-modellable data at all. It is a semi-scheduled solar farm (`TB2SF1`)
co-located with a bidirectional battery (`TB2B1`).

Measured over 2026-08-03, 288 intervals:

| | intervals |
|---|---|
| `TB2SF1` under semi-dispatch cap | 122 |
| `TB2SF1` producing (`UIGF > 1`) | 117 |
| **capped *and* producing** | **117** |

Every interval in which the farm produces is curtailed. Masking curtailment —
which is correct and required — therefore removes 100% of its productive
intervals and leaves only night, so the target is constant at zero and every
correlation returns exactly 0.000.

That figure reads as "no relationship" when it means "no admissible data", so
`correlateStation` now sets `target_constant` and the station view reports the
distinction rather than showing a wall of zeroes.

**Status:** correctly handled, no code defect. Flagged because it is a real
finding about this station rather than about this build, and because a 100%
curtailed producing record is worth Mat's attention — it is either a genuine
network constraint at that connection point or something worth querying.

---

## F7 — Coal, hydro and gas correlate negatively with temperature, and that is demand, not weather

Median Spearman against `temperature_2m` over 30 days:

| Fueltech | Median Spearman | Stations |
|---|---|---|
| coal_black | **−0.369** | 7 |
| coal_brown | **−0.210** | 2 |
| hydro | **−0.217** | 2 |

The relationship is real but it is not weather driving generation. This is an
Australian winter: cold days raise demand, demand raises thermal dispatch, so
output rises as temperature falls. Read carelessly this looks like a usable
weather signal worth modelling, and it is not — it is a demand signal that would
invert with the season.

Thermal stations are therefore recorded and excluded from the forecast-skill
exit condition, exactly as intended. No action needed; noted so the negative
numbers are not later mistaken for a modelling opportunity.

---

## F8 — [SPEC] CRPS "reduces to the mean pinball loss" and "equals MAE for a point forecast" cannot both be true

The scoring brief asks for both, and they differ by exactly a factor of two:

```
CRPS(F, y) = 2 ∫₀¹ pinball_τ(F⁻¹(τ), y) dτ
```

Plain mean pinball therefore scores a deterministic forecast at **half** its
absolute error. Taken literally, CRPS and MAE stop being comparable quantities,
and every skill score taken against an MAE-flavoured persistence baseline comes
out 2× wrong in a way nothing on the dashboard would reveal.

`crps()` in `app/js/models/score.js` implements `2 × mean pinball`. Two
independent checks that the factor belongs there:

- a deterministic forecast now scores exactly its absolute error, and the mean
  over a series equals MAE;
- `crps()` on the sample midpoints `(i−0.5)/n` agrees with `crpsFromSamples()`
  — the energy form `mean|X−y| − ½·mean|X−X′|`, which contains no free constant
  — to 1e-12.

**Status:** resolved in code. Flagged because it silently rescales the headline
skill number, which is the one figure the whole build exists to produce.

---

## F9 — [SPEC] The stated adaptive-conformal update has the sign of the feedback backwards

The brief gives

```
alpha += gamma * (targetCoverage − hit)
```

with `alpha` as miscoverage and the band taken at level `1 − alpha`. That is
positive feedback: a **miss raises** alpha, which **lowers** the working level
and makes the next band **narrower**, which causes more misses. Alpha walks to
whichever clamp it reaches first and stays there, and coverage is then whatever
the clamp happens to give.

`AdaptiveConformal.update()` implements

```
alpha += gamma * (hit − targetCoverage)
```

Verified independently of the module, on synthetic heteroscedastic noise over
20,000 intervals, running both signs through the same harness:

| Nominal | `alpha += g(hit − target)` | `alpha += g(target − hit)` (as briefed) |
|---|---|---|
| 80% | **0.8130** | **0.9991** — alpha pinned at its lower clamp |
| 90% | **0.8990** | **0.5118** — alpha pinned at its upper clamp |

The briefed sign does not merely drift, it saturates, and which way it saturates
depends on the target. A 90% band built that way covers 51% of outcomes — the
precise failure the brief itself calls out as lying to the user, written into
the specification of the thing meant to prevent it.

which is the Gibbs–Candès adaptive conformal update written in hit form, and
whose only stationary point is `E[hit] = targetCoverage`. Measured over 80 seeds
of a 5000-interval run with the Laplace error scale swinging tenfold: worst
deviation 0.94 pp at 90% nominal and 1.30 pp at 80%.

A related trap sits next to it. An alpha clamp of `[0.001, 0.5]` looks harmless
and is not: a ceiling of 0.5 stops the band ever tightening below the *median*
retained error, so whenever the window still holds errors from a wilder period
the model over-covers and the loop has no authority left to pull it back. That
cap alone held 80% nominal coverage at 0.829. The range is `[0, 1]`, both ends
of which are already degenerate.

**Status:** resolved in code. Flagged because the wrong sign does not throw, does
not look wrong in a chart, and produces a band that is confidently the wrong
width.

---

## F10 — The dashboard does not run: the view layer is incomplete

**This is the largest outstanding gap and it blocks five acceptance criteria.**

`app/index.html` loads `./js/main.js`, and that file does not exist. Present and
tested: the design tokens, the layout CSS, the conviction band and expert
ribbon, the power curve, the lag heatmap, the calibration charts, the replay
worker and the data loader. Missing:

| File | Role |
|---|---|
| `app/js/main.js` | boot, view switching, clocks, worker lifecycle, live polling |
| `app/js/views/aggregate.js` | aggregate view |
| `app/js/views/station.js` | station detail view |
| `app/js/views/training.js` | training monitor |
| `app/js/charts/fuelmix.js` | fuel mix stack |
| `app/js/charts/pricelayer.js` | price overlay and revenue ribbon |

Everything below the view layer is finished and independently verified, so this
is assembly rather than design. Until it exists:

- **Loop D (visual iteration) cannot start.** Its metric is a critique of
  screenshots, and there is nothing to screenshot. The harness is built and
  verified against Chromium (`tools/screenshot.js`), so the loop can begin the
  moment the views land.
- **Loop E (performance) cannot start.** Its metric is main-thread frame time
  during replay, which needs a running page.
- Cold-start-to-working-dashboard is unverifiable for the same reason.

**Status:** honest gap, not a defect. Recorded rather than reported as done.

---

## F11 — Conformal coverage at the 24-hour horizon does not reach ±3pp

Loop C reaches nominal at 5min, 30min and 1h (90.0 / 90.0 / 89.8 against a 90%
target; 80.0 / 80.1 / 80.0 against 80%). It does not at the long horizons:

| Horizon | 90% band | 80% band |
|---|---|---|
| 6h | 86.6% (3.4pp short) | 77.7% (2.3pp, inside) |
| 24h | 83.8% (6.2pp short) | 75.3% (4.7pp short) |

Three passes were spent on it. Raising `gamma` made it **worse**, not better —
at 0.02 the six-hour band fell to 77.0%, so the loop overshoots rather than
under-adapts. The change that did help was scoring the band actually issued
rather than one recomputed from an alpha that had moved since, which brought 1h
from 88.7% to 89.8%.

The likely remaining cause is sample size rather than method: a 24-hour-ahead
error series is heavily autocorrelated, so ~5,500 updates over 20 days contain
far fewer independent outcomes than the short horizons do. The obvious next step
is to re-run over the full 90 days rather than 20 and re-measure before changing
any parameter.

**Resolution of the diagnostic (90-day re-measure).** Running the identical
configuration over the full 90 days — 25,920 intervals — moved 6h from 86.6% to
**87.2%** on the 90% band and 77.7% to **78.4%** on the 80% band, both inside
±3pp, confirming sample size as the cause there. 24h improved to 85.4% / 76.3%
but remains outside: a day-ahead error series is correlated across hundreds of
intervals, so 90 days holds only ~90 independent daily outcomes and the
adaptation loop is still information-starved at that horizon. The same run
strengthened the skill result to **100% of renewable stations positive at every
horizon** (44 of 44), with solar at 24h reaching +0.268.

**One further attempt (horizon-scaled error window).** The residual window at
24h was widened from 2000 intervals (~7 days) to 7200 (~25 days), on the theory
that a seven-day window keeps re-fitting the band to whichever synoptic regime
just happened and pays for every transition. Measured over the same 90 days:
the 90% band moved 85.4% → 85.8% and the 80% band 76.3% → 75.6% — a wash, well
inside the run-to-run noise of a slid data window, with both bands still ~4pp
short. Window size is not the binding constraint, which is consistent with the
diagnosis above; the change was reverted rather than kept unearned.

**Status:** open for the 24h horizon only, cause understood (independent-sample
starvation, not method), everything to 6h at nominal. One parameter attempt
measured and reverted; closing the gap likely needs a different band
construction at day-ahead range (e.g. climatological quantiles blended in), and
that is a modelling change for a measured loop, not a patch.

---

## F12 — RESOLVED: the conviction band was mispositioned by a missing stylesheet

**The app now runs**, loads 55 stations over 6,048 intervals in about 8 seconds,
and produces live skill scores. But the signature element does not draw
correctly, so Loop D cannot pass.

**Symptom.** The band chart shows a small cluster of data at the left edge and a
faint trace at the right, with a wide empty gap between them, rather than one
continuous history running up to a forward fan.

**What has been ruled out.** Both were checked directly rather than assumed:

- *Units.* `ring.t[k] = (state.t0 + i * MS_PER_STEP) / 1000` and
  `nowSec` use the same seconds base, so history and the now-rule agree.
- *Padding.* `size = ring.filled + forward` and every forward slot stamps its
  own `t`, so there are no zero timestamps. A defensive filter for `t > 0` was
  added in the view and changed nothing, which confirms it.
- *Axis auto-range.* Pinning the x-scale to the finite data extent also changed
  nothing, which is what says the gap is in the data rather than in the scale.

**Most likely cause, untested.** The history ring is filled from the *scored*
index, which trails the cursor by the horizon length, while the forward fan is
stamped at `cursor - 1 + steps`. At the 24-hour horizon those differ by up to
576 intervals, so the two halves of the series may genuinely be far apart in
time with nothing in between. If so the fix is to stamp both from one clock,
not to adjust the chart.

**Consequence.** Loop D fails rubric item 5 — the conviction band is not the
first thing the eye lands on, because there is nothing to land on. Loop E is
also still unmeasured.

**Actual cause, found by measuring the DOM rather than reading the code.** Every
hypothesis above was wrong, and each was wrong in a way that still fitted the
symptom — which is why measuring settled it and reasoning did not.

The frame payload was healthy throughout: 288 history points, zero bad
timestamps, a 47.9-hour span, sane magnitudes (actual peaking at 17,414 MW).
The plot instance was healthy too: 293 x-points, correct scales, correct size.
The chart was drawing correctly. It was drawing **in the wrong place**.

`#conviction-band` sat at y=222 with height 300. Its canvas sat at **y=455** —
233 px below its own wrapper, so `overflow: hidden` clipped all but the last
sliver. uPlot positions its canvas absolutely inside `.u-wrap`, and **its
stylesheet had never been linked**, so the canvas anchored to the wrong
ancestor. Every chart in the application was displaced by the same amount for
the same reason; the band was simply the one where it was obvious.

Linking `uPlot.min.css` put the canvas at y=222, exactly matching its host.

**Two real defects were found on the way and are worth keeping separately:**

- The aggregate band was never clipped to physically possible values, which the
  interval always owed the reader. Before the aggregate conformal calibrates its
  upper edge runs far past anything the fleet can generate. Clipping it also
  moved **24-hour skill from −0.109 to +0.128**, so this was a modelling defect
  wearing a visual costume.
- The expert ribbon indexed the weights array across the forward fan, where no
  weights exist because nothing has been scored at those instants yet. It ran
  off the end of the array and drew a wedge of NaN.

**Status:** resolved. The band now renders actual, forecast, the 80% and 90%
bands, the ghost band and the now-rule across 48 hours.

---

## F13 — The replay worker sustains 11–21 intervals/second, not 500

The main-thread half of the performance budget is met: over 1,200 consecutive
frames during replay, frame-to-frame p50 was 16.7 ms (the display's vsync
period — the main thread was idle), p95 19.1 ms, and zero long tasks were
observed. The page stays interactive throughout.

The worker half is not. Sustained training throughput:

| Replay position | Rate |
|---|---|
| ~900 intervals | 21/s |
| ~1,600 intervals | 15/s |
| ~2,500 intervals | 11/s |

The decay curve is the diagnosis: the analogue expert's library fills toward its
5,000-state cap, and every prediction linearly scans it. At steady state that is
55 stations × 5 horizons × 5,000 states ≈ **1.4 million distance evaluations per
dispatch interval**, which matches both the browser rate and the Node backtest
rate (~25/s over 20 days). The cost is arithmetic, not rendering or messaging.

Consequences, stated against the original bar:

- "Replay runs 90 days in under two minutes" required ≥216 intervals/s. At the
  measured rate, 90 days takes hours, which is why the shipped default window is
  21 days (~8 minutes of background training that the user can watch, scrub and
  pause, with the page fully responsive throughout).
- The 500/s transport setting is an offer the worker cannot honour. The
  transport reports the real measured rate beside it, so the gap is visible
  rather than implied away.

The remedy is known and bounded: either an indexed neighbour search (a
vantage-point tree over the 8-dimensional state vectors turns the scan into
O(log n)) or a smaller per-horizon library. Both change model behaviour, so
either belongs in a measured Loop B pass with before/after skill scores, not in
a performance patch. Not attempted here for exactly that reason.

**Re-measure after the flat-layout rewrite.** The analogue library was rewritten
from five thousand small objects to one flat `Float64Array` with a
zero-allocation, branch-free scan — behaviour-identical, verified by a
byte-identical 10-day backtest. The Node side moved: 2m00 → 1m39 over 10 days,
with the larger share of that coming from restructuring the backtest's data
preparation from a per-station scan of every interval bucket (quadratic in
fleet size, 37% of the profile) to one sweep (2.7%). The browser side did not:
sampled every ten seconds across a full 21-day replay at the maximum rate
setting, the worker held **9–12 intervals/s at steady state** with the library
at its 5,000-state cap — indistinguishable from the object-layout numbers in
the table above. The whole replay completes in about 11 minutes.

That null result sharpens the diagnosis: the cost is the volume of distance
arithmetic itself, not pointer-chasing or allocation, so no layout change will
close an order-of-magnitude gap. Only doing fewer evaluations can — the indexed
search or the smaller library, both still modelling-loop changes.

**Status:** open, re-measured, cause narrowed to arithmetic volume, remedy
unchanged. The main-thread exit condition of Loop E is met; the replay-speed
element of the definition of done is not, and the shipped 21-day default window
(a watchable ~11-minute background replay) is the honest accommodation.

---

## F14 — RESOLVED: the app's first fetch was served by a symlink that existed on one machine

The first cloud deploy built every piece of data correctly — 21 days of
dispatch, 90 days of weather, prices, fitted curves, the backtest — started the
server, reported healthy, and served a dead page:

```
Could not load data: /data/registry.json returned 404.
```

`data/registry.json` is the app's very first fetch and the gate on everything
after it: the station list, the DUID mapping, capacities, coordinates. No build
step has ever written it. `build-registry.js` writes the registry to
`harvester/registry.json`, where every harvester script reads it from, and the
backfill scripts each write only their own outputs into `data/`.

It worked in development because of this, made by hand in a terminal months
into the build and never recorded anywhere:

```
data/registry.json -> ../harvester/registry.json
```

Every local run, every screenshot pass, every Loop D iteration and the entire
Loop E performance measurement had been resolving that symlink. A fresh clone
never had it.

The failure is worth naming precisely, because "works locally" understates it:
the development environment had a file the repository could not produce, so
the thing being tested was never the thing that would ship. Nothing in the
suite could see it — 168 tests over parsing, models, alignment and calibration,
and not one of them asked the server for a URL.

**Fix.** The registry is source, not output, so it is served from where it
lives rather than copied into the output directory: `serve.js` aliases
`/data/registry.json` to `harvester/registry.json`. A copy would have been a
second source of truth that a deploy can forget to make, which is the bug
again with more steps. The hand-made symlink was deleted so development
resolves exactly what production does.

`test/serve.test.js` now starts the server and asks it for the routes the app
boots from, asserting the registry returns stations that survive the loader's
filter. That test fails against the previous commit.

**Status:** resolved. Root cause was an untracked local artefact masking a
missing build output; the class of bug (no test ever issued an HTTP request)
is closed by the new suite.

---

## F15 — The calibration panel was scoring its own histogram, and said so confidently

Reported by a reader, in the best possible words: **"this never changes, is it
broken."** It was.

The PIT histogram drew a single bar in the top bin, at exactly ten times the
uniform reference, for the entire replay. That reading — every outcome landing
above the whole predicted spread — is flatly incompatible with the 88–91%
interval coverage the same model reports on the same screen, which is what made
it a bug rather than a finding.

**Cause.** `createPitHistogram(...).update()` is documented to take raw PIT
values, one per scored interval, and bins them itself. The replay worker cannot
ship those — a hundred thousand values per frame to draw ten bars — so it bins
as it scores and ships the ten counts. The station view handed those counts to
`update()`. Every count is a whole number far above 1, so re-binning them into
[0,1] clamped all ten into the top bin. No error, no NaN, no empty state: a
confident, permanent, entirely fictional verdict, complete with an authoritative
caption diagnosing a distribution the panel had never seen.

The reliability diagram beside it was fed the same counts and did the *right*
thing with them — expanding each bin back into that many midpoint values — but
it allocated one array entry per scored interval, tens of thousands of them, on
every animation frame.

**Why no test caught it.** These are pure statistics, and they were living in
`app/js/charts/calibration.js`, which imports uPlot from `/vendor/...` — a
browser path that does not resolve in Node. Nothing in the suite could import
the module at all, so `classifyPitShape`, `reliabilityFromPit` and the whole
diagnostic had never been under test. The defect was not that a test was
missing; it was that no test was *possible*.

**Fix.** The statistics moved to `app/js/models/score.js`, where they have no
chart dependency and the suite can reach them. The chart gained an explicit
`updateCounts()` entry point for the binned case, `pitUniformity()` computes the
chi-squared from counts, and `reliabilityFromCounts()` apportions each bin by
overlap instead of expanding it. Four tests now hold the two entry points to
agreeing on the same sample — including one that asserts the exact degenerate
output the old path produced, so the failure mode stays documented.

**What the panel actually shows now**, verified in the browser and against an
offline probe over six days of real dispatch: roughly a third of outcomes in the
lowest bin, a broadly flat middle, and a modest lift at the top. The low-bin
spike is real and worth its own look — it is dominated by intervals where the
plant and the forecast are both at zero, so the outcome sits at or below the
lowest quantile, which all clamp to zero together. The verdict caption now moves
as the replay runs, which is the whole point of it.

**Status:** resolved. The untestable-by-construction class of defect is closed
for this module; other chart modules still hold logic behind the same import and
have not been audited.

---

## F16 — The map's coastline was gitignored, so it existed only on my machine

The map deployed with everything working except the map: stations, demand and
flow all fetched, and `/data/au-states.json` returned a 404 body. It renders
locally, which is exactly what made it worth writing down.

`.gitignore` carried `data/` with no leading slash. Git treats that as "any
directory named data, at any depth", so it silently covered `app/data/` —
where the simplified state boundaries live, because they are committed source
rather than harvester output. The file was never added, no deploy could serve
it, and nothing said so.

This is the second time a file the app boots from turned out to exist only in
development. F14 was the registry, present via a hand-made symlink. Both had
the same shape: the environment under test contained something the repository
could not produce, so local success said nothing about production.

**Fix.** The ignore is anchored (`/data/`), the geometry is tracked, and
`test/serve.test.js` now asserts that every committed file the app fetches at
boot appears in `git ls-files`. That test fails against the previous commit,
and it is written to be extended as more such files appear rather than to
check these two forever.

A second, unrelated cause of 404s on the same deploy: the Render service was
created by hand, so its build command is a stored string that a blueprint
update does not touch. Three new backfill steps existed in `render.yaml` and
not on the running service, which is why the WA and flow data were missing
while everything older worked. The README now says so at the point where
someone would hit it.

**Status:** resolved, with the class closed by a test rather than by care.

## F17 — a build step ordered before the step that produces its input

`build:data` initially ran `correlate-run.js` before `backfill-wem.js`, while
`correlate-run.js` reads `data/wem-dispatch/` for its Western Australian
observations. On the machine where the WA backfill had already been run by
hand the order was invisible; on a clean checkout it would have written a
correlations file with no WA curves in it and exited zero.

The absence had no symptom at build time because `loadWemObservations`
answered a missing directory with an empty map. It now warns, naming the
station count it is skipping and the script that should have run first, and
`test/build-order.test.js` asserts the pipeline order against what each step
reads rather than against the order that happens to be written down.

Found by checking a build command against its dependencies rather than
assuming the order that produced correct output locally was the correct order.

## F19 — a browser cache that could never learn Western Australia existed

The dashboard reported "No Western Australian dispatch under
/data/wem-dispatch/" against a server that was serving it — measured at HTTP
200, 1.38 MB for `2026-08-05.json`, at the moment the message was on screen.

The WA ingest skipped any day already present in IndexedDB. That set is written
by the eastern ingest, and a cached day says only that the eastern stations
were stored for it; SWIS stations arrive from a different feed under different
keys and, before WA was deployed, were not stored at all. So every returning
visitor had every day cached, the WA fetch never ran once, and no redeploy
could change it. The only escape was clearing site data, which nobody would
think to do while the panel was naming a server-side cause.

Two feeds now keep two coverage records. A manifest written before WA existed
carries no `wem_days` key, which reads as nothing covered, so affected browsers
repair themselves on the next load rather than behind a cache-version bump that
would re-fetch the whole 21-day dispatch window. `test/dataload-coverage.test.js`
asserts the two sets are independent.

The general shape is worth naming: a client-side cache that records coverage
for one feed and is read for another cannot be diagnosed from the server, and
the interface's own diagnostic pointed confidently at the wrong half of the
system.

## F18 — Western Australia publishes trading days, not intervals — WRONG

**Recorded, then disproved by looking harder. Kept in full, because the wrong
version is the more useful record.**

What was measured, and is still true: on 7 August 2026 at 17:53 AWST, nearly ten
hours into the open trading day, `facilityScada/current/` held exactly one file,
`SCADA_2026-08-06.json`, the day that closed at 07:55 that morning.
`facilityScada/previous/` was a further day behind, and WA operational demand
behaved the same way.

What was concluded, and is false: that Western Australia therefore has no
five-minute feed, and that the freshest WA data obtainable is ten to thirty-four
hours old. That generalised from one dataset to a whole market operator.
`data.wa.aemo.com.au/public/market-data/wemde/` publishes twelve datasets;
`facilityScada` is one of them.

What is actually there:
`wemde/dispatchSolution/dispatchData/current/ReferenceDispatchSolution_YYYYMMDDHHMM.json`,
one file every five minutes, published about three minutes after the interval it
describes. Measured 7 August 2026: the 18:35 AWST interval was on disk at 18:38.

It is also a better feed than the one the wrong conclusion was drawn from:

  `facilityScheduleDetails[].initialMw` is per-facility output at the interval's
  start — the same quantity, and the same alignment rule, as the NEM's INITIALMW.

  `dispatchCaps[]` names the facilities the engine is holding below their offer.
  That is Western Australia's semi-dispatch cap, and its supposed absence was the
  stated reason WA carried an unknown curtailment mask everywhere in this system.
  Measured on one interval: 48 stations, 12 of them capped.

So WA's position is the reverse of what was written here. Its *history* has no
curtailment mask, because `facilityScada` does not carry one. Its *present* does,
and a live WA interval is admitted to expert fitting where a live NEM interval —
whose semi-dispatch cap does not arrive until the next day — is not.

Two things this cost, worth naming rather than filing:

  F4 was corrected once already for exactly this shape of error: concluding a
  dataset does not exist from one directory that looked empty. F18 repeated it
  against a different directory of the same publisher. What did not transfer is
  that "I looked and it was not there" is a claim about looking.

  The 30 MB-per-interval download is real, and is the one genuine reason to
  prefer the daily feed. That is a deployment choice — `GRIDSENSE_WA_LIVE=0`
  keeps the daily catch-up and nothing else — not a fact about what AEMO
  publishes, and the two were conflated.

## F20 — a station whose weather could never be served

`safeFileName` percent-encodes AEMO identifiers because they are not
filesystem-safe: Gladstone registers as `G/STONE`, so its weather is written to
disk as `G%2FSTONE.json` and the app asks for exactly that path. The server
decoded the request path before resolving it, turning `%2F` back into a
directory separator and looking for `STONE.json` inside a directory named `G`.
There is no such directory, so the request 404ed.

Gladstone therefore ran its physical and analogue experts on output alone, for
the whole life of the project. Nothing looked broken: no panel was missing, no
error was raised, the station appeared in every table, and the only trace was a
404 in a console that carried several other 404s by design.

The server now tries the decoded path and the raw one. `test/serve.test.js`
asserts the encoded identifier resolves, and asserts separately that a path
still cannot climb out of its root — the fix widens what is reachable, which is
exactly the change that needs the traversal guard re-asserted rather than
assumed.

It is the only affected station today, and only because it is the only modelled
identifier containing a character `encodeURIComponent` escapes. The registry
holds others — `W/HOE#1` — that would have hit it the moment they were modelled.

## F21 — expected 404s were hiding real ones

The app discovered what the harvester had published by requesting files and
seeing which ones failed: the newest dispatch day was found by asking for
today's file, which by design does not exist yet. That worked, and it painted
the console red on every single load — enough 404s that F20 sat in plain sight
and was read as more of the same.

`serve.js` now answers `/data/index.json` with what each day-keyed directory
actually holds, and the app asks once instead of probing. A favicon is inlined
as a data URI so the browser never requests one. Measured after: a full load
makes zero failed requests, against a console that previously carried a dozen.

Recorded because the cost was diagnostic, not functional. Twice in one session a
real fault was mistaken for expected noise, and the fix is not "read the console
more carefully" — it is to leave nothing in it that does not matter.

## F22 — the bands are calibrated on weather nobody had at the time — OPEN

Conformal coverage is measured in the backtest against ERA5 reanalysis: the
weather as it is reconstructed afterwards, with every observation in hand. Live
forecasting past the last observed hour runs on Open-Meteo's forecast instead,
which is a worse input, and the error it carries is not in any residual the
conformal window has ever seen.

So the reported coverage — within 0.2 pp of nominal to one hour, 3.1 pp under at
six hours — is a statement about forecasting with hindsight weather. Live
coverage at the longer horizons will be worse than that by some amount, and the
band will be too narrow in exactly the direction that flatters the system.

**The amount is not known, and the obvious measurement does not produce it.**
Comparing `data/weather-forecast/` against `data/weather/` over the hours both
cover gives MAE 0.000 on all thirteen variables across 1,008 station-hours:
Open-Meteo's forecast endpoint serves the same reanalysis-derived values for
past hours that the archive endpoint does. The comparison measures the join, not
the forecast, and reporting its zero as "forecast weather is as good as
reanalysis" would be the most flattering possible misreading of it.

What would actually measure it: Open-Meteo's historical-forecast API, which
serves the forecast *as issued* at a given lead time, so a 24-hour-ahead
forecast can be scored against the reanalysis for the hour it predicted. Then
the residuals feeding AdaptiveConformal would carry weather error at horizon
rather than none, and the band would widen where it should.

Left open rather than patched with a guessed multiplier. A widening factor
chosen to make coverage look right would be indistinguishable from one chosen
because it was correct, and the whole point of the conformal layer is that its
width is earned.

## F23 — the build's heap limit was also the server's, and it was three times the box

The deployed service returned 502 on every request. The cause was not one bug
but a limit set for the wrong process, plus two things I had just added that
were only survivable under the wrong limit's assumptions.

`NODE_OPTIONS=--max-old-space-size=1536` is documented here as a Render *service*
variable, because the build needs that headroom to parse a 122 MB dispatch CSV.
Render applies service variables to the running instance as well. So on a 512 MB
plan V8 believed it had three times the memory that existed, never collected
under pressure, and grew until the container killed the process. Nothing in the
application log says why, because the process did not fail — it was killed, and
the log simply stops.

Three separate paths could then exhaust it, and all three are fixed:

  The server read whole files into Buffers. A dispatch day is 30 MB and the app
  asks for twenty-one on a cold load, so a few simultaneous visitors held
  hundreds of megabytes at once. Buffers live outside V8's heap, so the heap cap
  never bounded them — only the container did. Now streamed, one chunk at a time
  regardless of file size or concurrency.

  The WA five-minute solution feed parses a 30 MB JSON document, peaking near
  350 MB. The next-day settle parses 122 MB of CSV. Both were defaulted on.

  Neither could be streamed without a parser this project has no dependency
  budget for, so they are now gated on a declared `GRIDSENSE_MEMORY_MB` and are
  off below 1024. The startup log states which are on and how to enable them,
  because a feed silently disabled by a budget is the next thing to be
  mistaken for a bug.

The heap cap now lives on the start command, where a CLI flag takes precedence
over `NODE_OPTIONS`: the build keeps its headroom and the server is held to what
the instance actually has.

What made this expensive to see: every symptom was an absence. No stack trace,
no error, a log that ends mid-sentence, and a 502 from the proxy rather than the
application. The general lesson is that a memory limit intended for one phase of
a deploy will be inherited by every other phase unless it is scoped, and that a
Buffer is not covered by the flag most people reach for.
