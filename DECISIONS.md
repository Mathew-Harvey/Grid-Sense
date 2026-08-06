# DECISIONS

Every OPEN choice from the spec, and every deviation from a SHOULD, one line
each with the reason.

## Scope (spec §1 non-goals, recorded so scope does not creep)

- Not a trading tool. No revenue, no bidding, no price forecasting; price is an input feature only.
- Not a replacement for AEMO's AWEFS/ASEFS, which see turbine-level telemetry we do not.
- Not multi-user. Single browser, IndexedDB, no accounts, no server-side persistence.
- Not commercial. Licensing per §12.

## OPEN choices

| # | Choice | Decision | Why |
|---|---|---|---|
| 1 | §4.1 station registry source | **Option 3** — hand-curated top stations, checked in as `harvester/registry.json` with `source` + `retrieved_at` per record | Open Electricity API key is waitlisted and has not arrived (§15.1). Loader is isolated behind `registry.js` so option 1 is a one-file swap. |
| 2 | §15.2 backfill depth | **90 days, NEM** | `Next_Day_Dispatch` current directory holds ~13 months of daily files, so 90 days is available without touching the monthly archive bundles. |
| 3 | §15.3 WEM scope | **Post-reform only, live-only, no replay** | No WEM history exists to backfill (see FLAGS F4). |
| 4 | §15.4 station count | **60 stations by capacity** | Spec's stated ceiling; revisited against Loop E. |
| 5 | §3.1 `idb` dependency | **Dropped** | The raw IndexedDB API is tolerable behind one small `store.js` wrapper; spec explicitly permits dropping it. Keeps runtime deps at three. |

## Deviations from SHOULD

| Spec | Deviation | Justification |
|---|---|---|
| §5.1 poll every 60s | Poll every 60s for `Dispatch_SCADA`; `Next_Day_Dispatch` polled hourly between 03:00–06:00 NEM | Next-day files land once daily ~04:10; polling them every 60s is pure waste. |

## Corrections to the spec (detail in FLAGS.md)

| Flag | Spec said | Reality |
|---|---|---|
| F1 | `END OF REPORT,n` is a data-row count | It is the total line count (C+I+D) |
| F2 | The MWh-per-interval trap is pre-reform WEM only | Post-reform WEMDE `quantity` is MWh per interval too |
| F3 | `DispatchIS_Reports` carries `DISPATCHLOAD` every 5 min | It carries no unit-level table; UIGF/SEMIDISPATCHCAP are next-day only |
