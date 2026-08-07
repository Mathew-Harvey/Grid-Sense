// Run the correlation engine over the backfill and print what it finds.
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
import { normaliseNemUnitSolution } from './normalise.js';
import { loadWemObservations } from './wem-observations.js';
import {
  airDensity, windPower, windShear, clearSkyGhi, clearSkyIndex, solarZenith,
} from '../app/js/weather.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');

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
  const rows = [];
  for (const f of files) {
    const day = JSON.parse(await fs.readFile(path.join(DATA, 'nem-dispatch', f), 'utf8'));
    for (const r of day.rows) if (wanted.has(r.DUID)) rows.push(r);
  }

  // Station aggregation, netting, the two instants inside one row and every
  // quality rule come from the ingest normaliser. A private copy here drifted
  // from it in three ways that all survived as plausible-looking numbers:
  // curtailment went unclamped and unrestricted to semi-scheduled units, so a
  // coal station publishing UIGF=0 scored its whole output as negative
  // curtailment; the capacity check tested the signed value, so no reading was
  // ever too negative; and load DUIDs were dropped instead of subtracted.
  const { observations, counts } = normaliseNemUnitSolution(rows, { stations });
  const byStation = new Map();
  for (const o of observations) {
    let list = byStation.get(o.station_id);
    if (!list) byStation.set(o.station_id, (list = []));
    list.push(o);
  }
  // Western Australia, from its own feed. Its curtailment mask is unknown
  // rather than false, and the correlation pass only looks at intervals it
  // knows to be uncurtailed — so WA is admitted explicitly, with the caveat
  // carried in the bundle and stated in the interface, rather than being
  // silently excluded from every fitted curve on the continent.
  const wem = await loadWemObservations(stations, days, { admitUnknownMask: true });
  let wemObservations = 0;
  for (const [stationId, list] of wem) {
    byStation.set(stationId, list);
    wemObservations += list.length;
  }

  console.log(
    `Loaded ${files.length} days, ${counts.observations} NEM observations ` +
    `(${counts.ok} ok, ${counts.partial} partial, ${counts.suspect} suspect)` +
    `, ${wemObservations} WA observations across ${wem.size} stations\n`,
  );

  const results = [];
  for (const station of stations) {
    const series = byStation.get(station.station_id) ?? [];
    if (series.length === 0) continue;
    const weather = await loadWeather(station);
    if (weather.length === 0) continue;

    const bundle = correlateStation(series, weather, station.fueltech);
    results.push({
      // WA has no published curtailment flag, so its fit saw every interval
      // including any the market had constrained. A reader comparing a WA curve
      // to an eastern one is entitled to know they were fitted under different
      // rules.
      curtailment_mask: station.region === 'SWIS' ? 'unpublished' : 'next-day',
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
