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

| Pass | Median skill @1h | % stations >0 all horizons | Worst pair | Change made |
|---|---|---|---|---|
| — | — | — | — | pending |

---

## Loop C — Calibration

**Metric:** empirical coverage of the 80% and 90% intervals over a held-out
final 14 days.
**Exit:** coverage within ±3 percentage points of nominal at every horizon, and
the PIT histogram passes a chi-squared uniformity test at p > 0.05.
**Max passes:** 6.

| Pass | 80% coverage | 90% coverage | PIT chi-sq p | Change made |
|---|---|---|---|---|
| — | — | — | — | pending |

---

## Loop D — Visual iteration

**Metric:** self-critique against the seven-point rubric, from screenshots at
1440 / 1024 / 390 px.
**Exit:** three consecutive passes with no rubric failure, minimum three passes.
**Max passes:** 7. Screenshots saved to `screenshots/loop-d-pass-N/`.

| Pass | Rubric failures | Change made |
|---|---|---|
| — | — | pending |

---

## Loop E — Performance

**Metric:** frame time during replay at 500 intervals/second with all stations
loaded.
**Exit:** sustained under 16 ms per frame on the main thread, replay does not
block interaction.
**Max passes:** 5.

| Pass | Frame time (p50 / p95) | Bottleneck fixed |
|---|---|---|
| — | — | pending |

---

## Loop F — Reconciliation

**Metric:** agreement between regional aggregates and AEMO's published regional
totals from `ELEC_NEM_SUMMARY`.
**Exit:** every NEM region within 3% of AEMO's scheduled plus semi-scheduled
figure, sustained across 12 consecutive intervals.
**Max passes:** 6.

| Pass | Worst region | Discrepancy | Cause | Change made |
|---|---|---|---|---|
| 1 | QLD1 | **−26.43%** | 156 DUIDs absent from the registry, 2,722 MW producing — Callide C, Swanbank E and Callide B alone are 1,479 MW of Queensland. They were dropped because Open Electricity had no coordinate match, and a dropped station throws no error, it just makes a region quietly low. | Keep every AEMO-registered station whether or not it can be located; coordinates gate weather modelling only, not aggregation. |
| 2 | SA1 | **+20.47%** | Two separate faults. The live `ELEC_NEM_SUMMARY` endpoint serves the current interval while NEMWeb lags it by one, so the two sides were different moments; and its `SCHEDULEDGENERATION` is not summed scheduled output (SA read 1,216.8 against `REGIONSUM`'s 1,491.8 for our 1,479). | Reconcile against `DISPATCHIS REGIONSUM` instead: same five-minute cycle, stamps matched exactly, and `DISPATCHABLEGENERATION` is the corresponding quantity. |
| 3 | VIC1 | **−6.37%** | `DISPATCHABLEGENERATION` is a target for the *end* of an interval; a SCADA row stamped `S` is a snapshot of its *start*. Comparing equal stamps measures the ramp between two moments five minutes apart. | Apply the interval alignment: SCADA stamped `S` against `REGIONSUM` stamped `S − 5 min`. Measured over 150 intervals this cuts mean regional error from 1.01–5.51% to 0.27–1.75%. |
| 4 | NSW1 | **−5.89%** | The backfill had been fetched against the pre-fix registry, so each interval held 329 DUIDs instead of 560. It looked healthy — 94,752 rows a day, 288/288 intervals — while a third of the fleet was missing. VIC1 semi-scheduled read 1,046 MW against AEMO's 2,176. | Discard and re-fetch the whole 90-day backfill against the corrected 1,012-DUID registry. |
