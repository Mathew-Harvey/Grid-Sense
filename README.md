# GridSense

A single-page dashboard that answers one question, continuously and honestly:
**given the weather, how much power should each Australian power station be
producing right now and over the next 24 hours, how confident are we, and is
that confidence justified?**

It ingests AEMO's 5-minute dispatch feeds and Open-Meteo weather, fits physical
power curves per station, trains an ensemble of six hand-written forecasting
experts under a no-regret combiner, calibrates its uncertainty bands with
adaptive conformal inference, and replays 21 days of history so you can watch
the model go from useless to competent in front of you. Prices, revenue and
curtailment cost sit on top of the physical forecasts, on the same time axis.

**The skill score, in two sentences.** Skill is `1 − CRPS(model) /
CRPS(persistence)`: how much better the forecast is than assuming nothing
changes. Above zero beats that baseline, zero ties it, below zero means the
model is worse than doing nothing.

Forecasts are experimental and are not AEMO forecasts. AEMO's own AWEFS/ASEFS
forecasts see turbine-level telemetry this system does not.

## Layout

```
harvester/   Node data layer: fetch, parse, normalise, reconcile, backfill, serve
app/         the dashboard: plain JS + uPlot, no framework, no build step
data/        harvester output (gitignored, rebuilt by the backfill commands)
test/        node:test suites — 210 tests
tools/       screenshot harness for the visual iteration loop
```

A fourth tab, **How this works**, explains the whole system from nothing for a
reader with no background — why the grid must balance instantly, why wind is
forecastable and coal is not, what curtailment is, why "nothing will change" is
the forecast to beat, what an uncertainty range promises, and why six simple
forecasters beat one clever one — each with a small animation of the idea.

The dashboard opens in **Plain English** mode: every panel is retitled and
captioned for a reader who has never thought about electricity markets, domain
terms explain themselves on tap, a story line says what is happening in one
sentence, and the two flagship charts carry a "How to read this" overlay that
labels their live pixels. The **Expert** toggle in the masthead restores the
original instrument, and the browser remembers the choice.

A **Map** tab puts it in geography: every station as a column at its real
coordinates rising with output, each state's floor lit by its measured demand,
and interconnector flows as arcs travelling the way the power actually went.

Runtime dependencies: `fflate`, `uplot` and `three`. `three` was added for the
map and is loaded only by that view.

## Running locally

Node 22 or newer.

```bash
npm install
npm run build:data                              # the whole pipeline, ~15 min
npm run serve                                   # http://localhost:8080
```

`build:data` is these steps, and can be run one at a time if you want to stop
partway:

```bash
node harvester/backfill.js --backfill 21        # NEM dispatch, ~3 min
node harvester/build-wem-codes.js               # join WA facilities to stations, ~10 s
node harvester/backfill-wem.js --days 21        # Western Australian dispatch, ~10 s
node harvester/backfill-weather.js --days 90    # ERA5 weather, ~1 min, ~400 of Open-Meteo's 10k daily calls
node harvester/backfill-weather.js --forecast   # forward weather, 3 days ahead, ~113 calls
node harvester/backfill-price.js --days 21      # regional prices, ~3 min
node harvester/backfill-flows.js --days 21      # regional demand + interconnector flow, ~1 min
node harvester/correlate-run.js --days 21       # fitted power curves + weather lags, ~2 min
node harvester/backtest.js --days 21            # walk-forward skill matrix, ~3 min
```

The order is a dependency order, not a preference: every step reads what the
steps above it wrote, and running one early does not fail — it quietly produces
less. `correlate-run.js` before `backfill-wem.js` writes a correlations file
with no Western Australian curves in it and exits zero. `test/build-order.test.js`
asserts the order against what each script reads, so this cannot drift again.

Only `backtest.js` is optional: the dashboard trains live in a worker either
way, and the backtest just pre-computes the matrix so scores are there from
first paint. Dropping it saves about three minutes and costs exactly that.

Cold start in the browser takes about 10 seconds against a local harvester: the
app loads the backfill into IndexedDB, then the replay trainer walks it forward
in a Web Worker while the page stays interactive.

`--backfill 21` matches the app's default window. Up to 90 days works; each
dispatch day is roughly 30 MB of JSON on disk.

## Deploying on Render

One component is required: a **Web Service** running the harvester. It builds
the data at deploy time and then serves the app, the data directory and the
proxy route, all from one origin. A **Static Site** for the app is an optional
second component. A **Postgres database is not used — skip it** (details
below).

The included `render.yaml` blueprint describes the web service; point Render
at the repo and it will pick it up, or create the service by hand.

### The web service (required)

| Setting | Value |
|---|---|
| Service type | Web Service |
| Runtime | Node |
| Build command | `npm install && npm run build:data` |
| Start command | `node harvester/serve.js` |
| Health check path | `/` |
| Instance | Starter is enough — see memory note |
| Environment variable | `NODE_OPTIONS` = `--max-old-space-size=1536` |

The build command deliberately names no pipeline steps. A service created by
hand keeps the build command it was given and never re-reads `render.yaml`, so
spelling the steps out in the dashboard means every stage added later has to be
pasted in again — and the stage nobody remembers shows up as one panel quietly
404ing while the rest of the dashboard looks fine. `npm run build:data` in
`package.json` holds the real list, so the dashboard setting is correct once
and stays correct.

**If your service predates this and has the long build command stored, replace
it with `npm install && npm run build:data` once.** Symptoms of the old one:
no Western Australian row in the Regions table, and an empty Map tab, because
`data/wem-dispatch/` and `data/flows/` were never built.

The server honours `PORT`, which Render sets automatically.

Three things worth knowing before the first deploy:

- **Memory.** The backfill parses AEMO daily files that decompress to ~120 MB
  of text, which is what the `NODE_OPTIONS` value above is for. Render runs
  builds on their own infrastructure rather than the instance you pay for, so
  this is not a reason to size up: a Starter instance (0.5 CPU, 512 MB) built
  the full 21-day pipeline and serves it. The running server only reads one
  file per request, so serving is undemanding. Live ingest is not free, though,
  and it does run on the instance: the WA solution feed parses 30 MB every five
  minutes and the next-day settle parses 122 MB once a day. Both have their own
  switch below if a Starter instance turns out to be too small for them.
- **Ephemeral disk.** Render rebuilds `data/` on every deploy — that is by
  design here (fresh data each deploy, ~650 MB for 21 days). The build takes
  roughly 15 minutes, most of it fetching from NEMWeb.
- **Data currency.** The build establishes the history; the live poller keeps
  it current from there (below). A redeploy is still the way to widen the
  training window or pick up new code — a daily
  [deploy hook](https://render.com/docs/deploy-hooks) hit by a scheduler works
  — but the dashboard no longer freezes at the last built day between deploys.

### Live ingest

`serve.js` runs a poller in the same process, because it writes to the same
ephemeral disk the server reads from; a second Render component would get its
own copy of that disk and update the wrong one. Set `GRIDSENSE_LIVE=0` to turn
it off.

| Feed | Cadence | What it carries |
|---|---|---|
| NEM dispatch | every 5 min | station output, from `Dispatch_SCADA` |
| Market | every 5 min | regional prices, regional demand, interconnector flow, from one `DispatchIS` file |
| WA dispatch | every 5 min | station output **and the curtailment cap**, from the WEM's `ReferenceDispatchSolution` |
| Forward weather | every 3 hours | Open-Meteo forecast, 3 days ahead, ~113 of 10,000 daily calls |
| Completed NEM days | hourly check | `Next_Day_Dispatch`, which settles provisional intervals |
| Completed WA days | hourly check | the `facilityScada` trading-day file |

Live intervals land as one small file each under `data/live/`, listed by a
manifest that is written **after** them so it can never name a file that is not
there. The browser polls the manifest each minute and fetches only what it
lacks. Files older than 36 hours are swept.

Two settings exist because two feeds cost real money to run:

| Variable | Effect |
|---|---|
| `GRIDSENSE_LIVE=0` | no live ingest at all |
| `GRIDSENSE_WA_LIVE=0` | WA falls back to the daily file. Saves ~8.6 GB/day of downloads and a 30 MB parse every 5 min |
| `GRIDSENSE_NEXTDAY=0` | no next-day settling. Saves a 122 MB CSV parse once a day, at the cost below |

**Provisional intervals.** The NEM's 5-minute feed carries output and no
semi-dispatch cap — that arrives next day — so a live NEM interval's curtailment
is unknown, and an unknown mask must never read as "not curtailed". Live NEM
readings therefore drive the display, the scoring and the persistence chain, and
are withheld from expert fitting until `Next_Day_Dispatch` rewrites the day with
the real availability and the real cap. With `GRIDSENSE_NEXTDAY=0` they stay
provisional until a redeploy runs the backfill.

Western Australia is the exception, and the reverse of what you would expect:
its dispatch solution publishes `dispatchCaps`, so a live WA interval carries a
**measured** curtailment mask and is fitted on like any backfilled one. WA's
history has no mask; its present does. See FLAGS F18, which recorded the
opposite and was wrong.

## The numbers behind it

Every iteration loop, metric and exit condition is logged in `LOOPS.md`, and
everything found wrong, ambiguous or unverifiable during the build — including
three places the original specification contradicted the live data — is in
`FLAGS.md`. Decisions and their reasons are in `DECISIONS.md`.

Headline results from the 88-day walk-forward backtest over 92 stations, 37 of
them Western Australian: median renewable skill at the 1-hour horizon of 0.288
against persistence, and 57 of 59 wind and solar stations positive at every
horizon. The two exceptions are both 5 MW WA wind farms, negative only at the
short horizons — at that size a farm is one or two turbines, and its
minute-to-minute output is turbine noise that persistence tracks better than
weather can.

Measured on its own, the NEM fleet sits at 0.297 and the WA fleet at 0.258. WA
scores lower for a structural reason rather than a modelling one: the WEM
publishes no available-energy figure and no semi-dispatch cap, so those
stations are forecast against actual output with an unknown curtailment mask,
where the NEM fleet is forecast against a published availability with curtailed
intervals excluded.

Conformal coverage is within 0.2 pp of nominal from five minutes to one hour,
3.1 pp under at six hours and 5.9 pp under at 24 hours — see FLAGS F11, which
stays open. Regional generation totals reconcile with AEMO's published figures
to within 3% across consecutive intervals.

## Licensing and attribution

- Dispatch data © AEMO, published for information only, not intended for
  commercial use.
- Station coordinates, capacities and fuel technology from
  [Open Electricity](https://openelectricity.org.au) (CC BY-NC 4.0).
- Weather from [Open-Meteo](https://open-meteo.com) (CC BY 4.0,
  non-commercial tier).

Not a trading tool, not multi-user, not commercial, and not a replacement for
AEMO's forecasts.
