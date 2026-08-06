// Phase 4: run the correlation engine over the backfill and print what it finds.
//
// This exists to answer one question before any model is built — is there
// usable signal in this data at all? It needs no experts, no combiner and no
// calibration, and if the physical relationships do not show up here then
// nothing downstream is going to rescue them.
//
// Output goes to console and to data/correlations.json so the numbers can be
// read without a browser.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { correlateStation } from '../app/js/correlate.js';
import { observedAt } from '../app/js/align.js';
import {
  airDensity, windPower, windShear, clearSkyGhi, clearSkyIndex, solarZenith,
} from '../app/js/weather.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');

/**
 * Aggregate DUID-level dispatch rows to station level for one station.
 *
 * The two fields are stamped for different instants within the same row, so
 * they are emitted against the instants they actually describe rather than
 * against the row's settlement date.
 */
function toStationSeries(rowsByInterval, station) {
  const registered = new Set(
    station.duids.filter((d) => d.dispatch_type !== 'LOAD').map((d) => d.duid),
  );
  if (registered.size === 0) return [];

  // "Partial" has to mean units that normally report and did not, not units
  // that are merely still on the register. Thermal stations carry retired plant
  // in their registration — Callide A, Swanbank B, Torrens A all still resolve
  // to a live station — and counting those as absent marks every interval
  // partial, which then excludes the entire station from correlation. Coal came
  // back with no rows at all until the denominator was the units that actually
  // publish.
  const duids = new Set();
  for (const [, rows] of rowsByInterval) {
    for (const r of rows) if (registered.has(r.DUID)) duids.add(r.DUID);
  }
  if (duids.size === 0) return [];

  const out = [];
  for (const [settlementMs, rows] of rowsByInterval) {
    let output = 0;
    let uigf = 0;
    let cleared = 0;
    let available = 0;
    let capped = false;
    let seen = 0;
    let online = 0;
    let anyUigf = false;

    for (const r of rows) {
      if (!duids.has(r.DUID)) continue;
      seen++;
      const mw = r.INITIALMW ?? 0;
      output += mw;
      if (mw > 1) online++;
      cleared += r.TOTALCLEARED ?? 0;
      available += r.AVAILABILITY ?? 0;
      if (r.UIGF !== null && r.UIGF !== undefined) { uigf += r.UIGF; anyUigf = true; }
      if (r.SEMIDISPATCHCAP === 1) capped = true;
    }
    if (seen === 0) continue;

    // A value above 1.15x registered capacity is not a reading, it is a
    // pipeline fault, and it must not reach a curve fit.
    const cap = station.capacity_mw ?? Infinity;
    const suspect = Number.isFinite(cap) && output > 1.15 * cap;

    out.push({
      station_id: station.station_id,
      station_name: station.station_name,
      capacity_mw: station.capacity_mw,
      observed_at: observedAt(settlementMs, 'INITIALMW'),
      output_mw: output,
      uigf_mw: anyUigf ? uigf : null,
      cleared_mw: cleared,
      available_mw: available,
      curtailed_mw: anyUigf ? uigf - cleared : null,
      capped,
      quality: suspect ? 'suspect' : seen < duids.size ? 'partial' : 'ok',
      units_online: online,
    });
  }
  out.sort((a, b) => a.observed_at - b.observed_at);
  return out;
}

/** Weather series for one station, with the derived features attached. */
async function loadWeather(station) {
  let raw;
  try {
    raw = JSON.parse(
      await fs.readFile(path.join(DATA, 'weather', `${safeFileName(station.station_id)}.json`), 'utf8'),
    );
  } catch { return []; }

  const names = Object.keys(raw.variables);
  const times = raw.variables[names[0]].times;
  const at = (name, i) => raw.variables[name]?.values[i];

  return times.map((t, i) => {
    const row = { observed_at: t };
    for (const n of names) row[n] = at(n, i);

    // Raw variables badly underperform the derived ones, so the derived ones
    // are what the correlation actually sees.
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
      // The clear-sky reference is carried alongside the index, not just used
      // to derive it: the solar curve fit needs the absolute level to separate
      // a genuinely dim hour from a merely cloudy one.
      row.clear_sky_ghi = cs;
      row.clear_sky_index = clearSkyIndex(row.shortwave_radiation, cs);
      row.solar_zenith = solarZenith(station.lat, station.lon, t);
    }
    return row;
  });
}

export async function run({ days = 30, limit = null } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  let stations = registry.stations.filter((s) => s.modelled && s.located);
  if (limit) stations = stations.slice(0, limit);

  const files = (await fs.readdir(path.join(DATA, 'nem-dispatch'))).sort().slice(-days);
  const wanted = new Set(stations.flatMap((s) => s.duids.map((d) => d.duid)));

  // One pass over the dispatch files, keeping only what these stations need.
  const byInterval = new Map();
  for (const f of files) {
    const day = JSON.parse(await fs.readFile(path.join(DATA, 'nem-dispatch', f), 'utf8'));
    for (const r of day.rows) {
      if (!wanted.has(r.DUID)) continue;
      let bucket = byInterval.get(r.settlement_ms);
      if (!bucket) { bucket = []; byInterval.set(r.settlement_ms, bucket); }
      bucket.push(r);
    }
  }
  const ordered = [...byInterval.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`Loaded ${files.length} days, ${ordered.length} intervals\n`);

  const results = [];
  for (const station of stations) {
    const series = toStationSeries(ordered, station);
    if (series.length === 0) continue;
    const weather = await loadWeather(station);
    if (weather.length === 0) continue;

    const bundle = correlateStation(series, weather, station.fueltech);
    results.push({
      station_id: station.station_id,
      station_name: station.station_name,
      fueltech: station.fueltech,
      capacity_mw: station.capacity_mw,
      region: station.region,
      ...bundle,
    });
  }

  return results;
}

/** The variable that best characterises each fueltech, for the summary table. */
const HEADLINE = {
  wind: 'wind_speed_100m',
  solar_utility: 'clear_sky_index',
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) || 30 : 30;
  const results = await run({ days });

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)).padStart(n);

  for (const ft of ['wind', 'solar_utility', 'coal_black', 'coal_brown', 'hydro']) {
    const group = results.filter((r) => r.fueltech === ft);
    if (!group.length) continue;
    const key = HEADLINE[ft] ?? 'temperature_2m';
    console.log(`\n${ft}  (against ${key}, target ${group[0].target})`);
    console.log('  station         cap MW   pearson  spearman   MI bits  peak lag   masked   curve RMSE');
    group.sort((a, b) => (b.variables[key]?.spearman ?? -9) - (a.variables[key]?.spearman ?? -9));
    for (const r of group) {
      const v = r.variables[key];
      if (!v) continue;
      console.log(
        `  ${pad(r.station_id, 14)} ${num(r.capacity_mw, 6, 0)}  ${num(v.pearson, 8, 3)}  ${num(v.spearman, 8, 3)}` +
        `  ${num(v.mutual_information_bits, 8, 3)}  ${pad(v.peak_lag_minutes === null ? '   none' : `${v.peak_lag_minutes} min`, 9)}` +
        ` ${num(100 * r.masked_fraction, 6, 1)}%  ${r.curve?.converged ? num(r.curve.rmse, 8, 1) : '     n/a'}`,
      );
    }
    const spearmans = group.map((r) => r.variables[key]?.spearman).filter(Number.isFinite).sort((a, b) => a - b);
    if (spearmans.length) {
      console.log(`  median spearman ${spearmans[Math.floor(spearmans.length / 2)].toFixed(3)} across ${spearmans.length} stations`);
    }
  }

  await fs.writeFile(path.join(DATA, 'correlations.json'), JSON.stringify(results));
  console.log(`\nWritten to data/correlations.json`);
}
