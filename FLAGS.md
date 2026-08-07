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

## F4 — WEM has no usable history: 90-day replay is NEM-only

`facilityScada/previous/` is **empty** (0 files). `facilityScada/current/`
holds a single trading day (`SCADA_2026-08-05.json`, 08:00–07:55 AWST,
288 intervals, 76 facilities).

There is therefore no 90-day WEM backfill available from this source, so the
replay-training centrepiece is **NEM-only**. WEM is ingested live and gets the
correlation and live-forecast views, but cannot participate in the 90-day
replay.

Taken under **§15.3**, which explicitly permits this: "A working NEM-only
dashboard beats a half-working national one." Recorded rather than silently
shipped smaller, per §15.

**Status:** accepted limitation, surfaced in the UI. No decision needed unless
Mat wants WEM history sourced elsewhere (the MMSDM-equivalent WEM archive would
need separate investigation).

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

**Status:** open for the 24h horizon only, cause understood (independent-sample
starvation, not method), everything to 6h at nominal.

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

**Status:** open, measured, cause identified, remedy scoped. The main-thread
exit condition of Loop E is met; the replay-speed element of the definition of
done is not.
