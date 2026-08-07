// Ninety days of reanalysis weather for every station we intend to model.
//
// Stations are grouped by the variable set their fueltech actually needs — a
// coal station wants two variables, a wind farm five, a solar farm six — so
// each group is one batched request rather than one request per station. Asking
// for irradiance at a coal plant costs quota and answers nothing.
//
// The archive endpoint is ERA5 reanalysis, which trails real time by about five
// days. The gap between the end of reanalysis and now is filled from the
// forecast endpoint, which also serves the past several days.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWeather, VARIABLES_BY_FUELTECH, estimateCallCost } from '../app/js/weather.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', 'data', 'weather');
const FORECAST_DIR = path.join(HERE, '..', 'data', 'weather-forecast');
const DAY_MS = 86_400_000;

// ERA5 lags real time. Anything inside this window has to come from the
// forecast endpoint instead, which serves recent past as well as future.
const ARCHIVE_LAG_DAYS = 6;

// How far ahead forward weather reaches. The longest scored horizon is 24
// hours; three days leaves room for the forecast to be a day stale and still
// cover it, at a quota cost small enough to refresh hourly.
const FORECAST_AHEAD_DAYS = 3;

/** Group stations by the exact variable list their fueltech needs. */
function groupByVariables(stations) {
  const groups = new Map();
  for (const s of stations) {
    const variables = VARIABLES_BY_FUELTECH[s.fueltech] ?? [];
    if (!variables.length) continue;      // batteries and pumps are not weather-driven
    const key = variables.join(',');
    if (!groups.has(key)) groups.set(key, { variables, stations: [] });
    groups.get(key).stations.push(s);
  }
  return [...groups.values()];
}

/**
 * Open-Meteo caps how much one request may carry, and a 90-day 6-variable pull
 * across 30 stations is past it. Chunk by station count and fetch sequentially:
 * the quota cost is identical either way since it is per location, and a
 * rejected oversized request costs a retry.
 */
const CHUNK = 12;

// AEMO identifiers are not filesystem-safe: Gladstone registers as "G/STONE"
// and Wallerawang as "W/HOE#1". Encoding rather than stripping keeps the
// mapping reversible, so a file still names exactly one station.
export const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');

export async function backfillWeather({ days = 90, endMs = Date.now() } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  const stations = registry.stations.filter((s) => s.modelled && s.located);
  await fs.mkdir(DATA_DIR, { recursive: true });

  const start = endMs - days * DAY_MS;
  const archiveEnd = endMs - ARCHIVE_LAG_DAYS * DAY_MS;

  const groups = groupByVariables(stations);
  const totalCost = groups.reduce(
    (sum, g) => sum + estimateCallCost({ locations: g.stations.length, variables: g.variables.length, days }),
    0,
  );
  console.log(
    `Weather backfill: ${stations.length} stations in ${groups.length} variable groups, ` +
    `${days} days, about ${totalCost.toFixed(0)} of 10,000 daily calls`,
  );

  let written = 0;
  for (const group of groups) {
    for (let i = 0; i < group.stations.length; i += CHUNK) {
      const chunk = group.stations.slice(i, i + CHUNK);
      const results = await fetchWeather({
        stations: chunk,
        start,
        end: archiveEnd,
        variables: group.variables,
        endpoint: 'archive',
      });

      for (const r of results) {
        // Typed arrays do not survive JSON, so each variable is stored as plain
        // arrays and rebuilt on load. The app reads these once into IndexedDB.
        const out = { station_id: r.station_id, lat: r.lat, lon: r.lon, variables: {} };
        for (const [name, series] of Object.entries(r.variables)) {
          out.variables[name] = { times: Array.from(series.times), values: Array.from(series.values) };
        }
        await fs.writeFile(path.join(DATA_DIR, `${safeFileName(r.station_id)}.json`), JSON.stringify(out));
        written++;
      }
      console.log(`  ${written}/${stations.length} stations written`);
    }
  }

  return { stations: stations.length, written, groups: groups.length };
}

/**
 * Forward weather: the recent past and the next few days, from the forecast
 * endpoint.
 *
 * Until this existed the system had no future weather at all. `backfillWeather`
 * only ever calls the archive endpoint and deliberately stops about six days
 * short of now, because ERA5 reanalysis is not published any closer — so every
 * expert that forecasts from weather had nothing beyond the last observed hour
 * to forecast from, and at the horizons where the skill actually comes from
 * they would all have collapsed toward persistence.
 *
 * Written beside the archive rather than merged into it. The two disagree where
 * they overlap — reanalysis is the better answer for a past hour, a fresh
 * forecast the better answer for a future one — and keeping them in separate
 * files makes which is which a property of the filename rather than something
 * that has to be recorded per data point. It also means a refresh is a whole
 * file overwritten, so a half-finished run cannot leave a series spliced from
 * two different model runs.
 *
 * @param {object} [opts]
 * @param {number} [opts.now] injected clock, for tests
 * @returns {Promise<{stations: number, written: number, from: number, to: number}>}
 */
export async function refreshForecast({ now = Date.now() } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  const stations = registry.stations.filter((s) => s.modelled && s.located);
  await fs.mkdir(FORECAST_DIR, { recursive: true });

  // Reaches back past where the archive ends so the two always overlap. A join
  // made at exactly the archive's last hour would open a gap the moment ERA5
  // slipped a day, and a gap in the middle of a weather series is worse than
  // either source alone — the interpolator bridges it silently.
  const start = now - (ARCHIVE_LAG_DAYS + 1) * DAY_MS;
  const end = now + FORECAST_AHEAD_DAYS * DAY_MS;
  const days = Math.ceil((end - start) / DAY_MS);

  const groups = groupByVariables(stations);
  let written = 0;
  for (const group of groups) {
    for (let i = 0; i < group.stations.length; i += CHUNK) {
      const chunk = group.stations.slice(i, i + CHUNK);
      const results = await fetchWeather({
        stations: chunk, start, end, variables: group.variables, endpoint: 'forecast',
      });
      for (const r of results) {
        const out = { station_id: r.station_id, lat: r.lat, lon: r.lon, issued_at: now, variables: {} };
        for (const [name, series] of Object.entries(r.variables)) {
          out.variables[name] = { times: Array.from(series.times), values: Array.from(series.values) };
        }
        const file = path.join(FORECAST_DIR, `${safeFileName(r.station_id)}.json`);
        // Same rename-into-place rule the live poller uses: the server may be
        // answering a request for this file while it is being rewritten.
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(out));
        await fs.rename(tmp, file);
        written++;
      }
    }
  }
  return { stations: stations.length, written, from: start, to: end, days };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--forecast')) {
    const r = await refreshForecast();
    console.log(`${r.written} forecast files written, ` +
      `${new Date(r.from).toISOString().slice(0, 13)}Z .. ${new Date(r.to).toISOString().slice(0, 13)}Z`);
  } else {
    const i = process.argv.indexOf('--days');
    const days = i >= 0 ? Number(process.argv[i + 1]) || 90 : 90;
    const r = await backfillWeather({ days });
    console.log(`\n${r.written} station weather files written`);
  }
}
