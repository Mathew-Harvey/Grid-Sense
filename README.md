# GridSense

A single-page dashboard that answers one question, continuously and honestly:
**given the weather, how much power should each Australian power station be
producing right now and over the next 24 hours, how confident are we, and is
that confidence justified?**

It ingests AEMO's 5-minute dispatch feeds and Open-Meteo weather, fits physical
power curves per station, trains an ensemble of six hand-written forecasting
experts under a no-regret combiner, calibrates its uncertainty bands with
adaptive conformal inference, and replays 90 days of history so you can watch
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
test/        node:test suites — 168 tests
tools/       screenshot harness for the visual iteration loop
```

Runtime dependencies: `fflate` and `uplot`. That is the whole list.

## Running locally

Node 22 or newer.

```bash
npm install

# One-off data build (order matters: dispatch before weather before correlate)
node harvester/backfill.js --backfill 21        # NEM dispatch, ~3 min
node harvester/backfill-weather.js --days 90    # ERA5 weather, ~1 min, ~400 of Open-Meteo's 10k daily calls
node harvester/backfill-price.js --days 21      # regional prices, ~3 min
node harvester/correlate-run.js --days 21       # fitted power curves + weather lags, ~2 min

# Optional, slow: the walk-forward backtest that fills the initial skill matrix.
# The dashboard trains live in a worker either way; this just pre-computes.
node harvester/backtest.js --days 20

npm run serve                                   # http://localhost:8080
```

Cold start in the browser takes about 10 seconds against a local harvester: the
app loads the backfill into IndexedDB, then the replay trainer walks it forward
in a Web Worker while the page stays interactive.

`--backfill 21` matches the app's default window. Up to 90 days works; each
dispatch day is roughly 30 MB of JSON on disk.

## Deploying on Render

The harvester doubles as the production server: it serves the app, the data
directory and the one CORS proxy route the browser cannot fetch itself. A
`render.yaml` blueprint is included, so either point Render at the repo and it
will pick the blueprint up, or create the service by hand:

| Setting | Value |
|---|---|
| Service type | Web Service |
| Runtime | Node |
| Build command | `npm install && node harvester/backfill.js --backfill 21 && node harvester/backfill-weather.js --days 90 && node harvester/backfill-price.js --days 21 && node harvester/correlate-run.js --days 21` |
| Start command | `node harvester/serve.js` |
| Health check path | `/` |
| Instance | **Standard (2 GB) or larger** — see memory note |

The server honours `PORT`, which Render sets automatically.

Three things worth knowing before the first deploy:

- **Memory.** The backfill parses AEMO daily files that decompress to ~120 MB
  of text, so the build needs headroom well past the 512 MB free tier.
  Standard (2 GB) builds cleanly. Alternatively run the backfill locally and
  commit a data snapshot, then drop the backfill from the build command.
- **Ephemeral disk.** Render rebuilds `data/` on every deploy — that is by
  design here (fresh data each deploy, ~650 MB for 21 days). The build takes
  roughly 10 minutes, most of it fetching from NEMWeb.
- **Data currency.** The backfill fetches up to the most recent completed
  trading day at build time. Redeploy (or schedule a deploy hook) to refresh;
  the app also polls AEMO's live 5-minute feeds through the server's proxy
  route while it is open.

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
