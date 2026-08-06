// Cold start: the harvester's static output into IndexedDB, with the progress
// visible the whole way.
//
// A day of NEM dispatch is a 30 MB JSON file holding every DUID in the market at
// 5-minute resolution. Three weeks of it is most of a gigabyte over the wire and
// several million objects through the parser, so the shape of this module is
// dictated by two things: never hold more than one day in memory at once, and
// yield to the event loop between days so the progress the user is watching is
// actually painted rather than queued behind a locked main thread.
//
// Every fetch here is allowed to fail. The harvester writes its routes
// independently and at different times — prices arrived after weather, weather
// stops days before dispatch does — so a missing route is an ordinary state of
// the world, not an error. Each one is recorded as a note the interface can
// state plainly, and loading continues.

import { observedAt } from './align.js';
import {
  airDensity, windPower, windShear, clearSkyGhi, clearSkyIndex, solarZenith,
} from './weather.js';
import {
  packDay, putStationDay, putWeatherDay, setMeta, getMeta,
} from './store.js';

const DATA = './data';
const MS_PER_DAY = 86_400_000;

/** Three weeks is past the seven-day conformal window with room for a warm-up,
 *  and it is what fits in the five-minute cold-start budget. */
export const DEFAULT_DAYS = 21;

// Bumped when the packing or the derived weather features change, so a stale
// IndexedDB is rebuilt rather than read with the wrong columns in it.
const CACHE_VERSION = 3;

const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMsOf = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** Let the browser paint. Without this the whole load is one frame and the
 *  progress the user was promised appears only once it is finished. */
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function exists(url) {
  // HEAD rather than GET: the probe that finds the newest published day must not
  // pull 30 MB to answer a yes/no question.
  const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  return res.ok;
}

/**
 * The most recent published dispatch day.
 *
 * There is no directory listing to read, so the newest day is found by walking
 * back from today. The harvester runs daily and the file lands early the next
 * morning, so the answer is nearly always zero or one day back; the wider reach
 * covers a harvester that has been down over a weekend.
 */
async function newestDay(todayMs) {
  for (let back = 0; back < 10; back++) {
    const iso = isoDay(todayMs - back * MS_PER_DAY);
    if (await exists(`${DATA}/nem-dispatch/${iso}.json`)) return iso;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Fold one day of unit-level dispatch into per-station interval observations.
 *
 * Station output is the sum over its generating units of INITIALMW, which is a
 * snapshot of the interval's *start* — five minutes before the timestamp on the
 * row that carries it. Everything else in the row describes the interval's end.
 * observedAt() holds that convention in one place; getting it wrong runs the
 * actual series one interval late against every weather feature it is compared
 * with, and nothing anywhere looks broken.
 */
function foldDispatchDay(rows, duidToStation) {
  const byStation = new Map();

  for (const r of rows) {
    // The re-run of an intervened interval is published alongside the original.
    // Taking both counts the same megawatt twice.
    if (r.INTERVENTION === 1) continue;
    const stationId = duidToStation.get(r.DUID);
    if (stationId === undefined) continue;

    let station = byStation.get(stationId);
    if (!station) {
      station = { intervals: new Map(), duids: new Set() };
      byStation.set(stationId, station);
    }
    station.duids.add(r.DUID);

    let acc = station.intervals.get(r.settlement_ms);
    if (!acc) {
      acc = { output: 0, cleared: 0, available: 0, uigf: 0, anyUigf: false, seen: 0, online: 0, capped: false };
      station.intervals.set(r.settlement_ms, acc);
    }
    acc.seen++;
    acc.output += r.INITIALMW ?? 0;
    acc.cleared += r.TOTALCLEARED ?? 0;
    acc.available += r.AVAILABILITY ?? 0;
    if (r.UIGF !== null && r.UIGF !== undefined) { acc.uigf += r.UIGF; acc.anyUigf = true; }
    if (r.SEMIDISPATCHCAP === 1) acc.capped = true;
    if ((r.INITIALMW ?? 0) > 0) acc.online++;
  }

  return byStation;
}

function observationsFor(station, unitCount, capacityMw) {
  const out = [];
  for (const [settlementMs, a] of station.intervals) {
    // Output above nameplate is telemetry to distrust, not a record production
    // run. The 15% allowance covers the genuine over-rating a well-sited farm
    // achieves on a cold dense day.
    const suspect = Number.isFinite(capacityMw) && capacityMw > 0 && a.output > 1.15 * capacityMw;
    out.push({
      observed_at: observedAt(settlementMs, 'INITIALMW'),
      output_mw: a.output,
      available_mw: a.available,
      cleared_mw: a.cleared,
      uigf_mw: a.anyUigf ? a.uigf : null,
      // What the plant would have made minus what it was allowed to make. Only
      // a capped interval spills: below the cap the two differ by ordinary
      // forecast error, and calling that curtailment would shade most of a
      // clear afternoon red.
      curtailed_mw: a.capped && a.anyUigf ? Math.max(0, a.uigf - a.output) : 0,
      capped: a.capped,
      quality: suspect ? 'suspect' : a.seen < unitCount ? 'partial' : 'ok',
      units_online: a.online,
    });
  }
  out.sort((a, b) => a.observed_at - b.observed_at);
  return out;
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

// Derived at ingest rather than in the replay loop. Clear-sky irradiance is a
// solar-position calculation per station per hour; done inside the replay it
// would be recomputed for every interval of every pass over the same day.
function deriveWeatherRows(raw, station) {
  const names = Object.keys(raw.variables);
  if (names.length === 0) return [];
  const times = raw.variables[names[0]].times;

  return times.map((t, i) => {
    const row = { observed_at: t };
    for (const n of names) row[n] = raw.variables[n].values[i];

    if (Number.isFinite(row.surface_pressure) && Number.isFinite(row.temperature_2m)) {
      const rho = airDensity(row.surface_pressure * 100, row.temperature_2m);
      row.air_density = rho;
      if (Number.isFinite(row.wind_speed_100m)) row.wind_power = windPower(rho, row.wind_speed_100m);
    }
    if (Number.isFinite(row.wind_speed_100m) && Number.isFinite(row.wind_speed_10m)) {
      row.wind_shear = windShear(row.wind_speed_100m, row.wind_speed_10m);
    }
    if (Number.isFinite(row.shortwave_radiation)) {
      const cs = clearSkyGhi(station.lat, station.lon, t);
      row.clear_sky_ghi = cs;
      row.clear_sky_index = clearSkyIndex(row.shortwave_radiation, cs);
      row.solar_zenith = solarZenith(station.lat, station.lon, t);
    }
    return row;
  }).sort((a, b) => a.observed_at - b.observed_at);
}

/** One station-day of hourly weather, column-wise so the replay can read it
 *  without rebuilding an object per hour. */
function packWeather(rows, lanes) {
  const t = new Float64Array(rows.length);
  const values = lanes.map(() => new Float32Array(rows.length));
  for (let i = 0; i < rows.length; i++) {
    t[i] = rows[i].observed_at;
    for (let k = 0; k < lanes.length; k++) {
      const v = rows[i][lanes[k]];
      values[k][i] = Number.isFinite(v) ? v : NaN;
    }
  }
  return { t, lanes, values, n: rows.length };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * Regional reference price over the loaded window.
 *
 * Held in memory rather than IndexedDB: five regions at 5-minute resolution over
 * three weeks is 30,000 numbers, which is smaller than the cost of storing it.
 */
async function loadPrices(days, notes) {
  const byRegion = new Map();
  let summary = null;
  let loaded = 0;

  try {
    summary = await fetchJson(`${DATA}/prices/summary.json`);
  } catch {
    // A summary is a convenience, not a prerequisite.
  }

  for (const day of days) {
    let file;
    try {
      file = await fetchJson(`${DATA}/prices/${day.iso}.json`);
    } catch {
      continue;
    }
    loaded++;
    for (const row of file.intervals ?? file.rows ?? []) {
      // The re-run of an intervened interval carries the same settlement stamp
      // as the original; both in the same series draws the price twice.
      if (row.intervention === 1 || row.INTERVENTION === 1) continue;
      const region = row.region ?? row.REGIONID;
      const rrp = row.rrp ?? row.RRP;
      const at = row.observed_at ?? row.settlement_ms;
      if (region === undefined || !Number.isFinite(rrp) || !Number.isFinite(at)) continue;
      let series = byRegion.get(region);
      if (!series) { series = []; byRegion.set(region, series); }
      series.push([at, rrp]);
    }
  }

  if (loaded === 0) {
    notes.push({
      source: 'prices',
      message: `No regional prices published under ${DATA}/prices/ yet. Revenue and the price ribbon stay blank until the price harvester has run.`,
    });
    return null;
  }
  if (loaded < days.length) {
    notes.push({
      source: 'prices',
      message: `Prices cover ${loaded} of the ${days.length} loaded days. The rest of the window has dispatch but no price.`,
    });
  }

  const out = new Map();
  for (const [region, series] of byRegion) {
    series.sort((a, b) => a[0] - b[0]);
    const t = new Float64Array(series.length);
    const rrp = new Float32Array(series.length);
    for (let i = 0; i < series.length; i++) { t[i] = series[i][0]; rrp[i] = series[i][1]; }
    out.set(region, { t, rrp });
  }
  return { summary, byRegion: out };
}

// ---------------------------------------------------------------------------
// The load itself
// ---------------------------------------------------------------------------

/**
 * Fetch everything the dashboard needs and write the bulk of it to IndexedDB.
 *
 * @param {object} [opts]
 * @param {number} [opts.days] dispatch days to ingest, newest first
 * @param {boolean} [opts.force] re-ingest even if the cache already covers it
 * @param {(p: {phase: string, label: string, done: number, total: number}) => void} [opts.onProgress]
 * @returns {Promise<object>} the loaded context, including any degradations
 */
export async function loadAll({ days = DEFAULT_DAYS, force = false, onProgress = () => {} } = {}) {
  const notes = [];
  const startedAt = Date.now();
  const report = (phase, label, done, total) => onProgress({ phase, label, done, total });

  report('registry', 'Reading the station registry', 0, 1);
  const registry = await fetchJson(`${DATA}/registry.json`);

  // The modelled fleet: located, with a registered capacity, because every
  // learned expert and every conformal band divides by nameplate.
  const stations = registry.stations
    .filter((s) => s.modelled && s.located && s.capacity_mw > 0)
    .sort((a, b) => b.capacity_mw - a.capacity_mw);
  const byId = new Map(stations.map((s) => [s.station_id, s]));

  const duidToStation = new Map();
  for (const s of stations) {
    for (const d of s.duids) {
      // A load DUID is the pump or the charger, not the generator. Summed into
      // station output it cancels part of what the plant is actually sending out.
      if (d.dispatch_type === 'LOAD') continue;
      duidToStation.set(d.duid, s.station_id);
    }
  }
  report('registry', `${stations.length} modelled stations`, 1, 1);

  const [backtest, correlations] = await Promise.all([
    fetchJson(`${DATA}/backtest.json`).catch(() => {
      notes.push({
        source: 'backtest',
        message: `No ${DATA}/backtest.json. Skill scores stay blank until the walk-forward backtest has run.`,
      });
      return null;
    }),
    fetchJson(`${DATA}/correlations.json`).catch(() => {
      notes.push({
        source: 'correlations',
        message: `No ${DATA}/correlations.json. Fitted curves and weather lags stay blank until the correlation pass has run.`,
      });
      return null;
    }),
  ]);

  const curves = new Map(
    (correlations ?? []).filter((c) => c.curve?.converged).map((c) => [c.station_id, c.curve]),
  );
  const correlationById = new Map((correlations ?? []).map((c) => [c.station_id, c]));

  // ---- which days -------------------------------------------------------
  report('dispatch', 'Finding the most recent published day', 0, 1);
  const newest = await newestDay(Date.now());
  if (!newest) {
    notes.push({
      source: 'dispatch',
      message: `No dispatch day found under ${DATA}/nem-dispatch/ in the last ten days. Run the harvester backfill.`,
    });
    return finish({ registry, stations, byId, backtest, correlations, correlationById, curves, days: [], weatherDays: new Set(), prices: null, notes, startedAt });
  }

  const newestMs = dayMsOf(newest);
  const wanted = [];
  for (let i = days - 1; i >= 0; i--) {
    const ms = newestMs - i * MS_PER_DAY;
    wanted.push({ iso: isoDay(ms), ms });
  }

  const cached = force ? null : await getMeta('manifest');
  const haveDays = new Set(
    cached && cached.version === CACHE_VERSION && cached.stationCount === stations.length
      ? cached.days
      : [],
  );

  // ---- dispatch ---------------------------------------------------------
  const loadedDays = [];
  let ingested = 0;
  for (let i = 0; i < wanted.length; i++) {
    const day = wanted[i];
    report('dispatch', `Dispatch ${day.iso}`, i, wanted.length);

    if (haveDays.has(day.iso)) { loadedDays.push(day); continue; }

    let file;
    try {
      file = await fetchJson(`${DATA}/nem-dispatch/${day.iso}.json`);
    } catch {
      notes.push({ source: 'dispatch', message: `No dispatch file for ${day.iso}. That day is a gap in the replay.` });
      continue;
    }

    const folded = foldDispatchDay(file.rows, duidToStation);
    for (const [stationId, station] of folded) {
      const meta = byId.get(stationId);
      const observations = observationsFor(station, station.duids.size, meta.capacity_mw);
      if (observations.length === 0) continue;
      await putStationDay(stationId, day.ms, packDay(observations));
    }
    loadedDays.push(day);
    ingested++;
    // Releases the parsed day before the next 30 MB arrives, and lets the
    // progress bar the user is watching actually paint.
    await yieldToPaint();
  }
  report('dispatch', `${loadedDays.length} days of dispatch`, wanted.length, wanted.length);

  // ---- weather ----------------------------------------------------------
  const weatherDays = new Set();
  const wantedIso = new Set(loadedDays.map((d) => d.iso));
  const needWeather = ingested > 0 || !cached || cached.version !== CACHE_VERSION;
  let missingWeather = 0;

  for (let i = 0; i < stations.length; i++) {
    const station = stations[i];
    report('weather', `Weather ${station.station_name}`, i, stations.length);
    if (!needWeather) break;

    let raw;
    try {
      raw = await fetchJson(`${DATA}/weather/${safeFileName(station.station_id)}.json`);
    } catch {
      missingWeather++;
      continue;
    }

    const rows = deriveWeatherRows(raw, station);
    const lanes = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'observed_at') : [];
    const perDay = new Map();
    for (const row of rows) {
      const iso = isoDay(row.observed_at);
      if (!wantedIso.has(iso)) continue;
      let bucket = perDay.get(iso);
      if (!bucket) { bucket = []; perDay.set(iso, bucket); }
      bucket.push(row);
    }
    for (const [iso, bucket] of perDay) {
      await putWeatherDay(station.station_id, dayMsOf(iso), packWeather(bucket, lanes));
      weatherDays.add(iso);
    }
    if (i % 8 === 7) await yieldToPaint();
  }

  if (missingWeather > 0) {
    notes.push({
      source: 'weather',
      message: `${missingWeather} of ${stations.length} stations have no weather archive. Their physical and analogue experts run on output alone.`,
    });
  }
  const uncovered = loadedDays.filter((d) => !weatherDays.has(d.iso));
  if (needWeather && uncovered.length > 0) {
    notes.push({
      source: 'weather',
      message: `Weather stops at ${[...weatherDays].sort().at(-1) ?? 'no day'}, ${uncovered.length} days short of dispatch. The replay runs those days on persistence and climatology alone.`,
    });
  }
  report('weather', 'Weather stored', stations.length, stations.length);

  // ---- prices -----------------------------------------------------------
  report('prices', 'Regional prices', 0, 1);
  const prices = await loadPrices(loadedDays, notes);
  report('prices', 'Regional prices', 1, 1);

  await setMeta('manifest', {
    version: CACHE_VERSION,
    stationCount: stations.length,
    days: loadedDays.map((d) => d.iso),
    completed_at: Date.now(),
  });

  return finish({
    registry, stations, byId, backtest, correlations, correlationById, curves,
    days: loadedDays, weatherDays, prices, notes, startedAt,
  });
}

function finish(ctx) {
  return { ...ctx, finishedAt: Date.now(), elapsedMs: Date.now() - ctx.startedAt };
}

/** What the previous session left behind, so the first paint has something in
 *  it before a single byte is fetched. */
export async function cachedManifest() {
  const manifest = await getMeta('manifest');
  return manifest && manifest.version === CACHE_VERSION ? manifest : null;
}
