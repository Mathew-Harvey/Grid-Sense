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
