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
const DAY_MS = 86_400_000;

// ERA5 lags real time. Anything inside this window has to come from the
// forecast endpoint instead, which serves recent past as well as future.
const ARCHIVE_LAG_DAYS = 6;

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) || 90 : 90;
  const r = await backfillWeather({ days });
  console.log(`\n${r.written} station weather files written`);
}
