// The walk-forward backtest that produces the skill scores.
//
// Everything here obeys one rule: at the moment a forecast is made, only data
// that existed at that moment may touch it. Experts are updated strictly after
// their prediction has been scored, feature scaling uses running statistics
// rather than whole-series ones, and the analogue library holds only the past.
// A leak does not throw — it produces a skill score that looks like a triumph,
// so the discipline has to be structural rather than checked afterwards.
//
// The horizon structure means a prediction made at t is not scored until
// t + h. Each horizon therefore carries its own queue of forecasts in flight,
// and an expert only learns from an interval once its outcome is genuinely in
// the past.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExperts } from '../app/js/models/experts.js';
import { Hedge } from '../app/js/models/hedge.js';
import { AdaptiveConformal } from '../app/js/models/conformal.js';
import { crps, skillScore, pitValue, pitHistogram } from '../app/js/models/score.js';
import { observedAt } from '../app/js/align.js';
import {
  airDensity, windPower, windShear, clearSkyGhi, clearSkyIndex, solarZenith,
} from '../app/js/weather.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const MS_PER_STEP = 300_000;
const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');

// The horizons the dashboard reports, in 5-minute steps.
export const HORIZONS = [
  { label: '5min', steps: 1 },
  { label: '30min', steps: 6 },
  { label: '1h', steps: 12 },
  { label: '6h', steps: 72 },
  { label: '24h', steps: 288 },
];

// A nine-point fan. Enough to shape CRPS and to fill a PIT histogram without
// the outermost gap swallowing a whole bin.
const QUANTILE_LEVELS = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];

const WEATHER_DRIVEN = new Set(['wind', 'solar_utility']);

// Hedge's regret bound is derived for losses in [0, 1], and sqrt(8 ln N / T) is
// the learning rate that follows from it. Our loss is an absolute error over
// nameplate, which in practice spans about [0, 0.2] — measured means are 0.033
// for solar at one hour and 0.095 for wind at a day. At the textbook rate each
// round multiplies a weight by roughly 0.997, so after five thousand rounds the
// mixture is still nearly uniform and the combination scores worse than its own
// best member. Dividing by the realised loss span restores the intended
// convergence without touching the bound it comes from.
const LOSS_SPAN = 0.2;
const ETA = Math.sqrt((8 * Math.log(6)) / 5000) / LOSS_SPAN;

// Adaptation rate for the conformal level. Raising it to chase the long-horizon
// coverage shortfall made things worse, not better — at 0.02 the six-hour band
// fell from 84.5% to 77.0% because the loop overshoots and then oscillates. The
// shortfall was never slow adaptation; it was that the band being scored had
// been recomputed from a moved alpha rather than being the band actually
// issued.
const GAMMA = 0.005;

/**
 * Station-level series for every station at once, keyed by station_id.
 *
 * One sweep over the interval buckets, dispatching each row to its station's
 * accumulator. Scanning every bucket once per station instead makes the prep
 * quadratic in fleet size, and profiling showed that prep — not the models —
 * dominating the whole backtest.
 */
function buildStationSeries(rowsByInterval, stations) {
  const duidToAcc = new Map();
  const accs = stations.map((station) => {
    const acc = {
      station,
      active: new Set(),
      out: [],
      output: 0, uigf: 0, cleared: 0, seen: 0, anyUigf: false, capped: false,
    };
    for (const d of station.duids) {
      if (d.dispatch_type !== 'LOAD') duidToAcc.set(d.duid, acc);
    }
    return acc;
  });

  // A registered DUID that never reports would otherwise mark every interval
  // 'partial', so completeness is judged against the DUIDs actually seen.
  for (const [, rows] of rowsByInterval) {
    for (const r of rows) {
      const acc = duidToAcc.get(r.DUID);
      if (acc) acc.active.add(r.DUID);
    }
  }

  const touched = [];
  for (const [settlementMs, rows] of rowsByInterval) {
    for (const r of rows) {
      const acc = duidToAcc.get(r.DUID);
      if (!acc) continue;
      if (acc.seen === 0) touched.push(acc);
      acc.seen++;
      acc.output += r.INITIALMW ?? 0;
      acc.cleared += r.TOTALCLEARED ?? 0;
      if (r.UIGF !== null && r.UIGF !== undefined) { acc.uigf += r.UIGF; acc.anyUigf = true; }
      if (r.SEMIDISPATCHCAP === 1) acc.capped = true;
    }
    for (const acc of touched) {
      const cap = acc.station.capacity_mw ?? Infinity;
      const suspect = Number.isFinite(cap) && acc.output > 1.15 * cap;
      acc.out.push({
        observed_at: observedAt(settlementMs, 'INITIALMW'),
        output_mw: acc.output,
        uigf_mw: acc.anyUigf ? acc.uigf : null,
        cleared_mw: acc.cleared,
        capped: acc.capped,
        quality: suspect ? 'suspect' : acc.seen < acc.active.size ? 'partial' : 'ok',
      });
      acc.output = 0; acc.uigf = 0; acc.cleared = 0; acc.seen = 0;
      acc.anyUigf = false; acc.capped = false;
    }
    touched.length = 0;
  }

  const series = new Map();
  for (const acc of accs) {
    acc.out.sort((a, b) => a.observed_at - b.observed_at);
    series.set(acc.station.station_id, acc.out);
  }
  return series;
}

/** Weather on the 5-minute grid, with derived features, keyed by grid index. */
async function loadWeatherGrid(station, t0, steps) {
  let raw;
  try {
    raw = JSON.parse(
      await fs.readFile(path.join(DATA, 'weather', `${safeFileName(station.station_id)}.json`), 'utf8'),
    );
  } catch { return null; }

  const names = Object.keys(raw.variables);
  const times = raw.variables[names[0]].times;

  const rows = times.map((t, i) => {
    const row = { observed_at: t };
    for (const n of names) row[n] = raw.variables[n].values[i];
    if (row.surface_pressure !== undefined && row.temperature_2m !== undefined) {
      const rho = airDensity(row.surface_pressure * 100, row.temperature_2m);
      row.air_density = rho;
      if (row.wind_speed_100m !== undefined) row.wind_power = windPower(rho, row.wind_speed_100m);
    }
    if (row.wind_speed_100m !== undefined && row.wind_speed_10m !== undefined) {
      row.wind_shear = windShear(row.wind_speed_100m, row.wind_speed_10m);
    }
    if (row.shortwave_radiation !== undefined) {
      const cs = clearSkyGhi(station.lat, station.lon, t);
      row.clear_sky_ghi = cs;
      row.clear_sky_index = clearSkyIndex(row.shortwave_radiation, cs);
      row.solar_zenith = solarZenith(station.lat, station.lon, t);
    }
    return row;
  }).sort((a, b) => a.observed_at - b.observed_at);

  // Linear between hourly readings. The forecast is issued against weather that
  // would genuinely be available for that instant, so nothing here reaches
  // beyond the reading either side of the target time.
  const grid = new Array(steps).fill(null);
  let j = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + i * MS_PER_STEP;
    while (j + 1 < rows.length && rows[j + 1].observed_at <= t) j++;
    const a = rows[j];
    const b = rows[j + 1];
    if (!a || t < a.observed_at) continue;
    if (!b) { grid[i] = a; continue; }
    const f = (t - a.observed_at) / (b.observed_at - a.observed_at);
    const row = {};
    for (const k of Object.keys(a)) {
      const av = a[k], bv = b[k];
      row[k] = Number.isFinite(av) && Number.isFinite(bv) ? av + f * (bv - av) : av;
    }
    grid[i] = row;
  }
  return grid;
}

/**
 * Walk one station forward through the backfill.
 *
 * Curtailed intervals are excluded from every learning path — expert updates,
 * Hedge weights and conformal calibration alike. A capped interval's error is
 * the market's instruction, not the model's mistake, and feeding it to the
 * calibrator inflates the band for as long as the error window is deep.
 */
export function backtestStation(station, series, weatherGrid, opts = {}) {
  const { warmupSteps = 288 * 7, curve = null } = opts;
  const capacity = station.capacity_mw;
  if (!Number.isFinite(capacity) || capacity <= 0) return null;

  const useUigf = WEATHER_DRIVEN.has(station.fueltech)
    && series.filter((o) => Number.isFinite(o.uigf_mw)).length >= series.length / 2;
  const targetField = useUigf ? 'uigf_mw' : 'output_mw';

  const experts = buildExperts({ fueltech: station.fueltech, curve });
  const names = experts.map((e) => e.name);

  const perHorizon = HORIZONS.map(() => ({
    hedge: new Hedge({ names, eta: ETA }),
    conformal: new AdaptiveConformal({ targetCoverage: 0.9, gamma: GAMMA, window: 2000, capacityMw: capacity }),
    conformal80: new AdaptiveConformal({ targetCoverage: 0.8, gamma: GAMMA, window: 2000, capacityMw: capacity }),
    queue: [],
    crpsModel: 0,
    crpsPersistence: 0,
    n: 0,
    hit90: 0,
    hit80: 0,
    pits: [],
    expertCrps: names.map(() => 0),
  }));

  const history = [];

  for (let i = 0; i < series.length; i++) {
    const o = series[i];
    const y = o[targetField];
    const usable = o.quality === 'ok' && o.capped === false && Number.isFinite(y);

    // ---- score anything whose outcome has now arrived -------------------
    for (let h = 0; h < HORIZONS.length; h++) {
      const slot = perHorizon[h];
      while (slot.queue.length && slot.queue[0].dueIndex <= i) {
        const issued = slot.queue.shift();
        if (issued.dueIndex !== i || !usable) continue;

        const modelCrps = crps(issued.quantiles, y);
        const baseCrps = Math.abs(issued.persistence - y);
        slot.crpsModel += modelCrps;
        slot.crpsPersistence += baseCrps;
        slot.n++;
        if (y >= issued.band90.lo && y <= issued.band90.hi) slot.hit90++;
        if (y >= issued.band80.lo && y <= issued.band80.hi) slot.hit80++;
        slot.pits.push(pitValue(issued.quantiles, y));
        for (let e = 0; e < names.length; e++) {
          slot.expertCrps[e] += Math.abs(issued.predictions[e] - y);
        }

        slot.hedge.update(issued.byName, y, capacity);
        slot.conformal.update(issued.point, y, issued.scale, issued.band90);
        slot.conformal80.update(issued.point, y, issued.scale, issued.band80);
      }
    }

    // ---- learn from this interval, then predict forward -----------------
    if (usable) {
      const state = stateAt(series, weatherGrid, i, station, targetField, history, 0);
      for (const e of experts) e.update(state, y);
      history.push(y);
      if (history.length > 2000) history.shift();
    }

    if (history.length < 12 || i < warmupSteps / 4) continue;

    for (let h = 0; h < HORIZONS.length; h++) {
      const steps = HORIZONS[h].steps;
      const dueIndex = i + steps;
      if (dueIndex >= series.length) continue;

      const state = stateAt(series, weatherGrid, i, station, targetField, history, steps);
      const predictions = experts.map((e) => e.predict(state, steps));
      if (predictions.some((p) => !Number.isFinite(p))) continue;
      const byName = {};
      for (let e = 0; e < names.length; e++) byName[names[e]] = predictions[e];

      const slot = perHorizon[h];
      const point = slot.hedge.combine(byName);

      // The conditional error scale. Forecast error on a generator tracks how
      // much it is generating: a solar farm at midnight cannot be wrong, and the
      // same farm under broken cloud at noon can be wrong by most of its
      // nameplate. One unconditional band has to cover both, so it is far too
      // wide for the 60% of intervals that are night — and a probabilistic
      // forecast that is exactly right all night still loses to persistence,
      // because the score charges for the width.
      //
      // The floor keeps the band from collapsing to nothing when the forecast
      // is zero but the plant might still produce.
      const scale = Math.max(point, 0.05 * capacity) / capacity;
      const quantiles = slot.conformal.quantiles(point, QUANTILE_LEVELS, scale);

      slot.queue.push({
        dueIndex,
        point,
        predictions,
        byName,
        quantiles,
        persistence: predictions[0],
        scale,
        band90: slot.conformal.interval(point, scale),
        band80: slot.conformal80.interval(point, scale),
      });
    }
  }

  return HORIZONS.map((hz, h) => {
    const s = perHorizon[h];
    if (s.n < 50) return { horizon: hz.label, n: s.n, skill: null };
    const pit = pitHistogram(s.pits, 10);
    return {
      horizon: hz.label,
      n: s.n,
      skill: skillScore(s.crpsModel / s.n, s.crpsPersistence / s.n),
      crps: s.crpsModel / s.n,
      crps_persistence: s.crpsPersistence / s.n,
      coverage90: s.hit90 / s.n,
      coverage80: s.hit80 / s.n,
      pit_p: pit.pValue,
      weights: s.hedge.weights(),
      expert_mae: s.expertCrps.map((v) => v / s.n),
    };
  });
}

/** The state vector an expert sees, built only from data available at index i. */
function stateAt(series, weatherGrid, i, station, targetField, history, horizonSteps) {
  const o = series[i];
  const nem = new Date(o.observed_at + 10 * 3600_000);
  // Weather at the target instant is a forecast in live operation and reanalysis
  // here; either way it is the weather the forecast is entitled to know about.
  const weather = weatherGrid ? weatherGrid[Math.min(i + horizonSteps, weatherGrid.length - 1)] : null;
  return {
    capacity_mw: station.capacity_mw,
    fueltech: station.fueltech,
    history,
    horizon_steps: horizonSteps,
    month: nem.getUTCMonth(),
    observed_at: o.observed_at,
    tod_minutes: nem.getUTCHours() * 60 + nem.getUTCMinutes(),
    weather,
  };
}

export async function run({ days = 60, stations: only = null } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  let stations = registry.stations.filter((s) => s.modelled && s.located && s.capacity_mw > 0);
  if (only) stations = stations.filter((s) => only.includes(s.station_id));

  // Curves fitted by the correlation pass, on masked data only. The Physical
  // expert is the one carrying the actual physics, and without these it falls
  // back to a generic curve that knows nothing about this particular site.
  let curves = new Map();
  try {
    const fitted = JSON.parse(await fs.readFile(path.join(DATA, 'correlations.json'), 'utf8'));
    curves = new Map(fitted.filter((f) => f.curve?.converged).map((f) => [f.station_id, f.curve]));
  } catch { /* first run, before any correlation pass */ }

  const files = (await fs.readdir(path.join(DATA, 'nem-dispatch'))).sort().slice(-days);
  const wanted = new Set(stations.flatMap((s) => s.duids.map((d) => d.duid)));

  const byInterval = new Map();
  for (const f of files) {
    const day = JSON.parse(await fs.readFile(path.join(DATA, 'nem-dispatch', f), 'utf8'));
    for (const r of day.rows) {
      if (!wanted.has(r.DUID)) continue;
      let b = byInterval.get(r.settlement_ms);
      if (!b) { b = []; byInterval.set(r.settlement_ms, b); }
      b.push(r);
    }
  }
  const ordered = [...byInterval.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`Backtest over ${files.length} days, ${ordered.length} intervals, ${stations.length} stations\n`);

  const seriesByStation = buildStationSeries(ordered, stations);

  const results = [];
  for (const station of stations) {
    const series = seriesByStation.get(station.station_id) ?? [];
    if (series.length < 2000) continue;
    const t0 = series[0].observed_at;
    const steps = Math.round((series.at(-1).observed_at - t0) / MS_PER_STEP) + 1;
    const weatherGrid = await loadWeatherGrid(station, t0, steps);
    const horizons = backtestStation(station, series, weatherGrid, { curve: curves.get(station.station_id) ?? null });
    if (!horizons) continue;
    results.push({
      station_id: station.station_id,
      station_name: station.station_name,
      fueltech: station.fueltech,
      capacity_mw: station.capacity_mw,
      region: station.region,
      horizons,
    });
    process.stdout.write('.');
  }
  console.log('\n');
  return results;
}

const median = (a) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) || 60 : 60;
  const results = await run({ days });
  await fs.writeFile(path.join(DATA, 'backtest.json'), JSON.stringify(results));

  const renewable = results.filter((r) => WEATHER_DRIVEN.has(r.fueltech));
  console.log('Skill against persistence, by fueltech and horizon');
  console.log('                 ' + HORIZONS.map((h) => h.label.padStart(9)).join(''));
  for (const ft of ['wind', 'solar_utility', 'coal_black', 'coal_brown', 'hydro']) {
    const group = results.filter((r) => r.fueltech === ft);
    if (!group.length) continue;
    const cells = HORIZONS.map((_, h) =>
      median(group.map((r) => r.horizons[h].skill)).toFixed(3).padStart(9));
    console.log(`  ${ft.padEnd(15)}${cells.join('')}   (${group.length} stations)`);
  }

  console.log('\nCoverage, renewables only (nominal 90 / 80)');
  console.log('                 ' + HORIZONS.map((h) => h.label.padStart(14)).join(''));
  const cov = HORIZONS.map((_, h) => {
    const c90 = median(renewable.map((r) => r.horizons[h].coverage90));
    const c80 = median(renewable.map((r) => r.horizons[h].coverage80));
    return `${(100 * c90).toFixed(1)} / ${(100 * c80).toFixed(1)}`.padStart(14);
  });
  console.log('  median        ' + cov.join(''));

  const h1 = HORIZONS.findIndex((h) => h.label === '1h');
  const med1h = median(renewable.map((r) => r.horizons[h1].skill));
  const allPositive = renewable.filter((r) => r.horizons.every((x) => x.skill === null || x.skill > 0));
  console.log(`\nLoop B: median renewable skill @1h = ${med1h.toFixed(3)} (need > 0.10)`);
  console.log(`        ${allPositive.length}/${renewable.length} renewable stations positive at every horizon ` +
    `= ${(100 * allPositive.length / renewable.length).toFixed(0)}% (need 80%)`);
  console.log('\nWritten to data/backtest.json');
}
