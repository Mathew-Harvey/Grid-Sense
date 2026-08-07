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
test/        node:test suites — 183 tests
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

# One-off data build (order matters: dispatch before weather before correlate)
node harvester/backfill.js --backfill 21        # NEM dispatch, ~3 min
node harvester/backfill-weather.js --days 90    # ERA5 weather, ~1 min, ~400 of Open-Meteo's 10k daily calls
node harvester/backfill-price.js --days 21      # regional prices, ~3 min
node harvester/correlate-run.js --days 21       # fitted power curves + weather lags, ~2 min
node harvester/build-wem-codes.js               # join WA facilities to stations, ~10 s
node harvester/backfill-wem.js --days 21        # Western Australian dispatch, ~10 s
node harvester/backfill-flows.js --days 21      # regional demand + interconnector flow, ~1 min

# Optional: the walk-forward backtest that fills the initial skill matrix.
# The dashboard trains live in a worker either way; this just pre-computes.
# About 3 minutes at 20 days.
node harvester/backtest.js --days 20

npm run serve                                   # http://localhost:8080
```

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
| Build command | `npm install && node harvester/backfill.js --backfill 21 && node harvester/backfill-weather.js --days 90 && node harvester/backfill-price.js --days 21 && node harvester/correlate-run.js --days 21 && node harvester/backtest.js --days 21` |
| Start command | `node harvester/serve.js` |
| Health check path | `/` |
| Instance | Starter is enough — see memory note |
| Environment variable | `NODE_OPTIONS` = `--max-old-space-size=1536` |

The server honours `PORT`, which Render sets automatically. The final
`backtest.js` step pre-computes the skill matrix so the dashboard shows scores
from first paint rather than after the replay warms up; dropping it saves
about four minutes of build and costs exactly that.

Three things worth knowing before the first deploy:

- **Memory.** The backfill parses AEMO daily files that decompress to ~120 MB
  of text, which is what the `NODE_OPTIONS` value above is for. Render runs
  builds on their own infrastructure rather than the instance you pay for, so
  this is not a reason to size up: a Starter instance (0.5 CPU, 512 MB) built
  the full 21-day pipeline and serves it. The running server only reads one
  file per request, so it is undemanding; the build is the expensive half and
  it does not run on the instance.
- **Ephemeral disk.** Render rebuilds `data/` on every deploy — that is by
  design here (fresh data each deploy, ~650 MB for 21 days). The build takes
  roughly 15 minutes, most of it fetching from NEMWeb.
- **Data currency.** The backfill fetches up to the most recent completed
  trading day at build time, and that is what the dashboard trains on — it
  does not poll live feeds. To refresh the data, redeploy: a daily
  [deploy hook](https://render.com/docs/deploy-hooks) hit by a scheduler is
  the intended pattern.

### The static site (optional)

The app itself is ~1 MB of hand-written JS and CSS, so it can be served as a
Render Static Site with the web service as its data plane. This buys CDN
delivery for the app shell; the data still comes from the web service, which
sends `Access-Control-Allow-Origin: *` on every route for exactly this
arrangement. It is a nicety, not a requirement — the web service alone serves
everything.

| Setting | Value |
|---|---|
| Service type | Static Site |
| Build command | `npm install && mkdir -p app/vendor/uplot/dist && cp node_modules/uplot/dist/uPlot.esm.js node_modules/uplot/dist/uPlot.min.css app/vendor/uplot/dist/` |
| Publish directory | `app` |

Then tell the app where the harvester lives: in `app/index.html`, uncomment
the one line in the head and set it to the web service's URL —

```html
window.GRIDSENSE_API_BASE = 'https://<your-web-service>.onrender.com';
```

The build command exists because the page loads uPlot from `/vendor/`, which
the web service maps to `node_modules` but a static publish must carry as
files.

### The Postgres database (skip it)

Nothing in GridSense connects to a database. The data layer is flat JSON files
on the server's disk, rebuilt each deploy, plus IndexedDB inside the browser —
there is no `DATABASE_URL` to set, and a provisioned Postgres instance would
sit idle at full price. If a need appears later (say, keeping harvested
history across deploys instead of re-fetching it), that is a design change to
the harvester, not a configuration step.

## The numbers behind it

Every iteration loop, metric and exit condition is logged in `LOOPS.md`, and
everything found wrong, ambiguous or unverifiable during the build — including
three places the original specification contradicted the live data — is in
`FLAGS.md`. Decisions and their reasons are in `DECISIONS.md`.

Headline results from the 90-day walk-forward backtest: median renewable skill
at the 1-hour horizon of 0.30 against persistence, all 44 wind and solar
stations positive at every horizon, and conformal coverage within ±3 pp of
nominal from five minutes out to six hours (the 24-hour band runs ~5 pp
under-covered — see FLAGS F11). Regional generation totals reconcile with
AEMO's published figures to within 3% across consecutive intervals.

## Licensing and attribution

- Dispatch data © AEMO, published for information only, not intended for
  commercial use.
- Station coordinates, capacities and fuel technology from
  [Open Electricity](https://openelectricity.org.au) (CC BY-NC 4.0).
- Weather from [Open-Meteo](https://open-meteo.com) (CC BY 4.0,
  non-commercial tier).

Not a trading tool, not multi-user, not commercial, and not a replacement for
AEMO's forecasts.
