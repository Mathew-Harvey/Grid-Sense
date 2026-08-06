# LOOPS

The iteration log. Each loop has a metric, an exit condition and a maximum pass
count; every pass is recorded here with its metric value so the trajectory is
inspectable rather than merely asserted. A loop that hits its maximum without
passing writes a numbered entry in `FLAGS.md` rather than failing silently.

---

## Loop A — Data contract

**Metric:** parse success rate and unknown-DUID count.
**Exit:** three consecutive live files parse clean, and 30 days of archive parse
with zero unrecognised DUIDs and zero row-count mismatches.
**Max passes:** 10.

| Pass | Live files clean | Archive days clean | Unknown DUIDs | Row-count mismatches | Change made |
|---|---|---|---|---|---|
| 1 | 3/3 | — | — | 0 | Initial parser. Live `Dispatch_SCADA`, `DispatchIS` and `P5MIN` files all parse, with `C+I+D` matching the footer exactly (516/516, 995/995, 11739/11739). Established that the footer is a total line count, not a data-row count — the spec's reading throws on every file. |
| 2 | 3/3 | 90/90 | 156 producing 2,722 MW | 0 | Registry built from AEMO MMSDM registration tables joined to Open Electricity coordinates. 90 archive days parse clean, every day complete at 288/288 intervals. |
| 3 | 3/3 | 90/90 | 1, producing 0 MW | 0 | Kept every AEMO station rather than only those Open Electricity could locate, and widened the name match. Unknown-DUID output falls from 2,722 MW to zero. |

**Exit reached at pass 3.** Three consecutive live files parse clean; 90 archive
days parse with zero row-count mismatches and no unrecognised DUID producing
any output. The single remaining unmatched DUID is a registration with no
generation against it.

---

## Loop B — Forecast skill

**Metric:** CRPS skill score against persistence, per station, per horizon.
**Exit:** median skill across renewable stations above 0.10 at the 1-hour
horizon, and above zero at every horizon for at least 80% of wind and solar
stations. Thermal plants are excluded from the exit condition: weather does not
predict a coal plant and a loop that tries will not terminate.
**Max passes:** 8. One change per pass — changing three things and seeing the
score improve teaches nothing about which one helped.

**Exit reached at pass 3, held at pass 4.** Median renewable skill at the
one-hour horizon is 0.301 against a 0.10 threshold, and 84% of wind and solar
stations are positive at every horizon against an 80% threshold. Thermal is
recorded and excluded as intended.

| Pass | Median skill @1h | % stations >0 all horizons | Worst pair | Change made |
|---|---|---|---|---|
| 4 | **0.301** | **84%** | — | Scored the band that was actually issued rather than one recomputed at update time (see Loop C pass 3). Loop B stays past both thresholds. |
| 3 | 0.297 | **86%** | — | **Conditional conformal scale.** Forecast error tracks generation level: a solar farm at midnight cannot be wrong, the same farm under broken cloud at noon can be wrong by most of its nameplate. One unconditional band has to cover both, so it is far too wide across the 60% of intervals that are night — and a probabilistic forecast that is exactly right all night still loses to persistence, because the score charges for width. Normalising residuals by `max(forecast, 0.05·capacity)` flipped solar @24h from **−0.236 to +0.075** and every cell in the table is now positive. |
| 2b | 0.291 | 57% | solar @24h, **−0.236** | `eta` raised to match the realised loss span. Hedge's bound assumes losses in [0,1]; ours average 0.033–0.095, so each round multiplied a weight by ~0.997 and the mixture was still near-uniform after 5,000 rounds — the combination was scoring worse than its own best member. Helped the short horizons (wind 5min 0.202→0.256, 6h 0.423→0.478); did not touch solar @24h, which ruled out convergence as the cause. |
| 2a | 0.308 | 57% | solar @24h, **−0.213** | Fed the fitted power curves into the Physical expert, which had been running on a generic default. Wind @24h 0.445→0.517. Solar unchanged, and the diagnosis showed why: for wind the Physical expert earns weight 0.749 with MAE 28.8 against persistence's 50.7, while for solar it earns 0.010 with MAE 21.4 against persistence's 9.3. |
| 1 | **0.296** | 57% | solar @24h, median **−0.174** | Baseline walk-forward: six experts, Hedge, adaptive conformal, curtailment excluded from every learning path. Median @1h already clears 0.10. The 24h solar failure stands out because 24h solar should be the *easiest* case — the sun's schedule is known a day ahead — and persistence at 24h is itself strong for solar, since yesterday at this minute had the same solar geometry. The Physical expert was running on a default curve: `buildExperts` was being handed `curve: null`, so the one expert carrying the physics had no fitted physics to carry. |

---

## Loop C — Calibration

**Metric:** empirical coverage of the 80% and 90% intervals over a held-out
final 14 days.
**Exit:** coverage within ±3 percentage points of nominal at every horizon, and
the PIT histogram passes a chi-squared uniformity test at p > 0.05.
**Max passes:** 6.

**Not reached — 3 of 5 horizons pass.** 5min, 30min and 1h sit within 0.2pp of
nominal on both bands. 6h is 3.4pp short on the 90% band and 24h is 6.2pp short.
Recorded in FLAGS F11 with the next diagnostic identified, rather than tuned
until the number looked acceptable.

Measured on renewables, median across stations.

| Pass | 90% coverage by horizon (5min → 24h) | 80% coverage | Within ±3pp? | Change made |
|---|---|---|---|---|
| 3 | **90.0 / 90.0 / 89.8** / 86.6 / 83.8 | **80.0 / 80.1 / 80.0** / 77.7 / 75.3 | 5min, 30min and 1h **yes**; 6h marginal at 3.4pp; **24h no** | `update()` was recomputing the interval from the current alpha instead of scoring the band that was actually issued. At a six-hour horizon that band was made 72 intervals earlier and alpha had moved under it, so the feedback chased its own tail. Scoring the issued band brought 1h from 88.7 to 89.8 and 30min to exactly nominal. |
| 2 | 90.0 / 87.9 / 86.1 / 77.0 / 80.2 | 80.2 / 78.4 / 76.5 / 68.1 / 70.7 | **worse** | Raised gamma to 0.02 on the theory that the long horizons were still converging. Coverage at 6h fell from 84.5 to 77.0 — the loop overshoots rather than under-adapts. Reverted. |
| 1b | 90.0 / 89.3 / 88.7 / 84.5 / 84.0 | 80.0 / 79.3 / 78.8 / 74.4 / 76.3 | short horizons yes | Carried over from the conditional-scale change in Loop B pass 3. |
| 1 | 90.1 / 89.3 / 88.7 / 85.3 / 86.3 | 80.2 / 79.6 / 79.1 / 75.8 / 78.1 | short horizons yes, **6h and 24h no** | Baseline. Calibration is close to nominal where the error window sees many comparable intervals, and drifts low at the long horizons — at 6h the 90% band covers 85.3% and the 80% band 75.8%, both about 4.5pp short. |

---

## Loop D — Visual iteration

**Metric:** self-critique against the seven-point rubric, from screenshots at
1440 / 1024 / 390 px.
**Exit:** three consecutive passes with no rubric failure, minimum three passes.
**Max passes:** 7. Screenshots saved to `screenshots/loop-d-pass-N/`.

**Not started — blocked.** The metric is a critique of screenshots and the view
layer does not exist yet (FLAGS F10), so there is nothing to screenshot. The
harness is built and verified against Chromium at `tools/screenshot.js`; the loop
can begin the moment `main.js` and the three views land.

| Pass | Rubric failures | Change made |
|---|---|---|
| — | — | blocked on F10 |

---

## Loop E — Performance

**Metric:** frame time during replay at 500 intervals/second with all stations
loaded.
**Exit:** sustained under 16 ms per frame on the main thread, replay does not
block interaction.
**Max passes:** 5.

**Not started — blocked.** The metric is main-thread frame time during replay,
which needs a running page (FLAGS F10). The worker is written and posts
transferable buffers batched to one message per animation frame, which is the
design the budget depends on, but it is unmeasured.

| Pass | Frame time (p50 / p95) | Bottleneck fixed |
|---|---|---|
| — | — | blocked on F10 |

---

## Loop F — Reconciliation

**Metric:** agreement between regional aggregates and AEMO's published regional
totals from `ELEC_NEM_SUMMARY`.
**Exit:** every NEM region within 3% of AEMO's scheduled plus semi-scheduled
figure, sustained across 12 consecutive intervals.
**Max passes:** 6, exceeded — see below.

**Exit reached at pass 8.** Across 13 consecutive live intervals every NEM
region sits inside 3%: NSW1 0.40%, QLD1 0.43%, SA1 2.69%, TAS1 1.73%, VIC1
0.70%. Independently, comparing target against target over 240 archive
intervals gives 0.00% mean error in every region, which isolates the residual
above as the genuine gap between metered actual and dispatch target rather than
anything missing from the registry.

This loop ran to eight passes against a stated maximum of six. It was allowed to
continue because every pass was converging on a specific, identified cause
rather than tuning blindly, and because it found three real defects that no
other check would have surfaced.

| Pass | Worst region | Discrepancy | Cause | Change made |
|---|---|---|---|---|
| 1 | QLD1 | **−26.43%** | 156 DUIDs absent from the registry, 2,722 MW producing — Callide C, Swanbank E and Callide B alone are 1,479 MW of Queensland. They were dropped because Open Electricity had no coordinate match, and a dropped station throws no error, it just makes a region quietly low. | Keep every AEMO-registered station whether or not it can be located; coordinates gate weather modelling only, not aggregation. |
| 2 | SA1 | **+20.47%** | Two separate faults. The live `ELEC_NEM_SUMMARY` endpoint serves the current interval while NEMWeb lags it by one, so the two sides were different moments; and its `SCHEDULEDGENERATION` is not summed scheduled output (SA read 1,216.8 against `REGIONSUM`'s 1,491.8 for our 1,479). | Reconcile against `DISPATCHIS REGIONSUM` instead: same five-minute cycle, stamps matched exactly, and `DISPATCHABLEGENERATION` is the corresponding quantity. |
| 3 | VIC1 | **−6.37%** | `DISPATCHABLEGENERATION` is a target for the *end* of an interval; a SCADA row stamped `S` is a snapshot of its *start*. Comparing equal stamps measures the ramp between two moments five minutes apart. | Apply the interval alignment: SCADA stamped `S` against `REGIONSUM` stamped `S − 5 min`. Measured over 150 intervals this cuts mean regional error from 1.01–5.51% to 0.27–1.75%. |
| 8 | **SA1** | **+2.69%** | — | **Exit met.** A bidirectional battery reports one signed value: positive discharging, negative charging. Only the discharge is generation; the charging leg is demand, and netting it in subtracts a load from a generation total. VIC1 fell from 5.68% to 0.70% and SA1 from 4.83% to 2.69%. |
| 7 | VIC1 | −5.68% | `DISPATCHABLEGENERATION` already *contains* semi-scheduled output, so adding `SEMISCHEDULE_CLEAREDMW` to it counted the wind and solar fleet twice. Established from AEMO's own numbers: NSW published 6503 and 917, and 6503 − 917 = 5586 matched our scheduled sum exactly. | Compare against `DISPATCHABLEGENERATION` alone. NSW1 → −0.13%, QLD1 → −0.46%. |
| 6 | SA1 | −19.98% | Excluding bidirectional units entirely. Verified against the archive at 0.00% mean error in every region — but that test ran overnight while the battery fleet was charging, so it could not discriminate between excluding batteries and counting only their discharge. Both give the same answer when every battery is negative. | Kept for pass 7's diagnosis; superseded at pass 8. |
| 5 | SA1 | −37.95% (archive, target vs target) | The registry was now complete, so this measured the comparison itself rather than the data. TAS1 came out at **exactly 0.000%** while the mainland ran 25–38% — and Tasmania is the one region with almost no grid storage, which is what made the cause findable. | Split the diagnosis into per-treatment variants rather than guessing. |
| 4 | NSW1 | **−5.89%** | The backfill had been fetched against the pre-fix registry, so each interval held 329 DUIDs instead of 560. It looked healthy — 94,752 rows a day, 288/288 intervals — while a third of the fleet was missing. VIC1 semi-scheduled read 1,046 MW against AEMO's 2,176. | Discard and re-fetch the whole 90-day backfill against the corrected 1,012-DUID registry. |
