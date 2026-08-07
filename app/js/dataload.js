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

// Same origin by default. A split deploy — the app as a static site, the
// harvester as a separate service — points this at the harvester's origin by
// setting window.GRIDSENSE_API_BASE before the app boots; the server sends
// open CORS for exactly that arrangement.
export const DATA = `${globalThis.GRIDSENSE_API_BASE ?? ''}/data`;
const MS_PER_DAY = 86_400_000;

/** Three weeks is past the seven-day conformal window with room for a warm-up,
 *  and it is what fits in the five-minute cold-start budget. */
export const DEFAULT_DAYS = 21;

// Bumped when the packing or the derived weather features change, so a stale
// IndexedDB is rebuilt rather than read with the wrong columns in it.
const CACHE_VERSION = 4;

// How far past the dispatch window forward weather is stored. Matches what
// harvester/backfill-weather.js --forecast fetches; the longest scored horizon
// is 24 hours, so this covers it with room for a stale refresh.
const FORECAST_DAYS_AHEAD = 3;

const safeFileName = (id) => encodeURIComponent(id).replace(/\*/g, '%2A');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMsOf = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Join the reanalysis archive to the forward forecast for one station.
 *
 * Where both cover an hour, the archive wins: ERA5 is a reanalysis of what
 * actually happened, and a forecast of the same hour is a worse answer to the
 * same question. Beyond the archive's end — about six days short of now, which
 * is as close as ERA5 is published — the forecast is the only answer there is,
 * and it is what the experts predict from at every horizon past the last
 * observation.
 *
 * @param {object|null} archive parsed data/weather/<id>.json
 * @param {object|null} forecast parsed data/weather-forecast/<id>.json
 * @returns {object|null} the same shape, or null if neither exists
 */
export function mergeWeatherSources(archive, forecast) {
  if (!archive) return forecast;
  if (!forecast) return archive;

  const variables = {};
  const names = new Set([...Object.keys(archive.variables), ...Object.keys(forecast.variables)]);
  for (const name of names) {
    const byTime = new Map();
    // Forecast first so the archive overwrites it on any shared hour.
    for (const src of [forecast.variables[name], archive.variables[name]]) {
      if (!src) continue;
      for (let i = 0; i < src.times.length; i++) byTime.set(src.times[i], src.values[i]);
    }
    const times = [...byTime.keys()].sort((a, b) => a - b);
    variables[name] = { times, values: times.map((t) => byTime.get(t)) };
  }
  return { ...archive, variables, forecast_issued_at: forecast.issued_at ?? null };
}

/**
 * What a stored manifest already covers, per feed.
 *
 * The two sets are deliberately independent, and that independence is the
 * substance of this function rather than an implementation detail. A cached day
 * means the eastern stations were stored for it; the SWIS stations come from a
 * different feed, under different keys, and may well not have been. Reading one
 * set for both meant a browser that loaded the site before Western Australia
 * was deployed skipped the WA fetch on every cached day for good — reporting
 * "no Western Australian dispatch" at a server that was serving it, with no way
 * out but clearing site data. See FLAGS F19.
 *
 * A manifest written before WA existed has no `wem_days`, which reads as
 * nothing covered, so those browsers repair themselves on the next load instead
 * of needing the whole 21-day dispatch window re-fetched behind a version bump.
 *
 * @param {object|null} cached the stored manifest, or null to ignore the cache
 * @param {number} stationCount modelled stations now, to detect a changed fleet
 * @returns {{days: Set<string>, wemDays: Set<string>}}
 */
export function cachedCoverage(cached, stationCount) {
  const usable = Boolean(cached)
    && cached.version === CACHE_VERSION
    && cached.stationCount === stationCount;
  return {
    days: new Set(usable ? cached.days ?? [] : []),
    wemDays: new Set(usable ? cached.wem_days ?? [] : []),
  };
}

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
 * What the harvester has actually published, per day-keyed directory.
 *
 * Asked for once, instead of discovering it by requesting files and watching
 * which ones 404. The probing worked, but it painted the console red on every
 * single load — the newest day is found by asking for a file that is not there
 * yet, by design — and a console that is always red is one nobody reads, in
 * which the 404 that does matter is invisible. That cost real diagnosis time.
 *
 * A server too old to serve the index answers 404 and the probes come back, so
 * this is an optimisation rather than a requirement.
 */
async function dataIndex() {
  const index = await fetchJson(`${DATA}/index.json`).catch(() => null);
  if (!index) return null;
  const sets = {};
  for (const [dir, days] of Object.entries(index)) sets[dir] = new Set(days);
  return { index, sets };
}

/**
 * The most recent published dispatch day.
 *
 * Taken from the index when the server offers one. The fallback walks back from
 * today, which is what this did before the index existed: the harvester runs
 * daily and the file lands early the next morning, so the answer is nearly
 * always zero or one day back, and the wider reach covers a harvester that has
 * been down over a weekend.
 */
async function newestDay(todayMs, available) {
  const published = available?.index?.['nem-dispatch'];
  if (published?.length) {
    // Not simply the last entry: a directory can hold a day further ahead than
    // the clock if the machine's date is off, and the replay must not start
    // from a day that has not happened.
    const today = isoDay(todayMs);
    const usable = published.filter((iso) => iso <= today);
    if (usable.length) return usable.at(-1);
  }
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
async function loadPrices(days, notes, available) {
  const byRegion = new Map();
  let summary = null;
  let loaded = 0;

  try {
    summary = await fetchJson(`${DATA}/prices/summary.json`);
  } catch {
    // A summary is a convenience, not a prerequisite.
  }

  const published = available?.sets?.prices;
  for (const day of days) {
    // Skip what the index says is not there, rather than asking and being told.
    if (published && !published.has(day.iso)) continue;
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

  // WA stations carry no DUIDs — the eastern registration tables have no rows
  // for them — so they are keyed by station code from their own feed instead.
  const swisIds = new Set(stations.filter((s) => s.region === 'SWIS').map((s) => s.station_id));

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
  const available = await dataIndex();
  const newest = await newestDay(Date.now(), available);
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
  const { days: haveDays, wemDays: haveWemDays } = cachedCoverage(cached, stations.length);

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

  // ---- Western Australia -------------------------------------------------
  // A separate grid, a separate market and a separate feed, folded into the
  // same per-station store so the replay does not care which side of the
  // continent a station is on. Two things it cannot carry: WEM publishes no
  // available-energy figure and no curtailment flag, so `uigf_mw` is null and
  // the mask is genuinely unknown rather than false.
  const wemCovered = new Set(haveWemDays);
  let wemStations = 0;
  if (swisIds.size > 0) {
    for (let i = 0; i < wanted.length; i++) {
      const day = wanted[i];
      if (haveWemDays.has(day.iso)) continue;
      report('dispatch', `Western Australia ${day.iso}`, i, wanted.length);

      let file;
      try {
        file = await fetchJson(`${DATA}/wem-dispatch/${day.iso}.json`);
      } catch {
        continue;
      }

      const byStation = new Map();
      for (const r of file.rows) {
        if (!swisIds.has(r.station_id)) continue;
        let list = byStation.get(r.station_id);
        if (!list) byStation.set(r.station_id, (list = []));
        list.push({
          observed_at: observedAt(r.settlement_ms, 'WEM_QUANTITY'),
          output_mw: r.mw,
          available_mw: null,
          cleared_mw: null,
          uigf_mw: null,
          curtailed_mw: 0,
          capped: false,
          quality: r.quality ?? 'ok',
          units_online: r.facilities ?? 0,
        });
      }
      for (const [stationId, observations] of byStation) {
        observations.sort((a, b) => a.observed_at - b.observed_at);
        await putStationDay(stationId, day.ms, packDay(observations));
      }
      // Only a day that actually yielded stations counts as covered. A 404
      // recorded as covered would never be retried, so a day the harvester
      // publishes later would stay invisible to a browser that asked too early.
      if (byStation.size > 0) {
        wemCovered.add(day.iso);
        wemStations = Math.max(wemStations, byStation.size);
      }
      await yieldToPaint();
    }

    notes.push({
      source: 'wem',
      message: wemCovered.size > 0
        ? `Western Australia: ${wemStations || swisIds.size} stations over ${wemCovered.size} days. The WEM feed publishes no available-energy figure and no curtailment flag, so WA stations are scored without the curtailment mask the eastern states get.`
        : `No Western Australian dispatch under ${DATA}/wem-dispatch/. Run harvester/backfill-wem.js to include the SWIS.`,
    });
  }

  // ---- weather ----------------------------------------------------------
  const weatherDays = new Set();
  // Days the dispatch window covers, plus the days ahead of it. Forward weather
  // is stored for days that have no dispatch yet on purpose: that is precisely
  // the range the live extension forecasts into, and a weather grid that
  // stopped at the last observed interval would leave every expert with nothing
  // to predict from the moment the replay caught up with now.
  const wantedIso = new Set(loadedDays.map((d) => d.iso));
  const weatherIso = new Set(wantedIso);
  const futureDays = [];
  for (let d = 1; d <= FORECAST_DAYS_AHEAD; d++) {
    const ms = newestMs + d * MS_PER_DAY;
    const iso = isoDay(ms);
    weatherIso.add(iso);
    futureDays.push({ iso, ms });
  }
  const needWeather = ingested > 0 || !cached || cached.version !== CACHE_VERSION;
  let missingWeather = 0;
  let forecastStations = 0;

  for (let i = 0; i < stations.length; i++) {
    const station = stations[i];
    report('weather', `Weather ${station.station_name}`, i, stations.length);
    if (!needWeather) break;

    const name = safeFileName(station.station_id);
    const [archive, forecast] = await Promise.all([
      fetchJson(`${DATA}/weather/${name}.json`).catch(() => null),
      fetchJson(`${DATA}/weather-forecast/${name}.json`).catch(() => null),
    ]);
    const raw = mergeWeatherSources(archive, forecast);
    if (!raw) { missingWeather++; continue; }
    if (forecast) forecastStations++;

    const rows = deriveWeatherRows(raw, station);
    const lanes = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'observed_at') : [];
    const perDay = new Map();
    for (const row of rows) {
      const iso = isoDay(row.observed_at);
      if (!weatherIso.has(iso)) continue;
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
  if (needWeather) {
    notes.push({
      source: 'forecast',
      message: forecastStations > 0
        ? `Forward weather for ${forecastStations} stations, ${FORECAST_DAYS_AHEAD} days ahead. Beyond the reanalysis archive the experts predict from forecast weather, which is a forecast of a forecast and is the weaker half of the two.`
        : `No forward weather under ${DATA}/weather-forecast/. Without it the experts have nothing to predict from past the last observed hour. Run harvester/backfill-weather.js --forecast.`,
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

  const publishedFlows = available?.sets?.flows;
  // ---- regional demand and interconnector flow --------------------------
  // Small enough to hold in memory: five regions and six interconnectors at
  // five-minute resolution over three weeks is about 70,000 numbers.
  const flows = new Map();
  let flowDays = 0;
  for (const day of loadedDays) {
    // The index already says which days exist; asking for the rest only
    // paints the console red on a state the interface reports calmly.
    if (publishedFlows && !publishedFlows.has(day.iso)) continue;
    let file;
    try {
      file = await fetchJson(`${DATA}/flows/${day.iso}.json`);
    } catch {
      continue;
    }
    flowDays++;
    for (const row of file.intervals ?? []) {
      if (Number.isFinite(row.at)) flows.set(row.at, { demand: row.demand, flow: row.flow });
    }
  }
  if (flowDays === 0) {
    notes.push({
      source: 'flows',
      message: `No regional demand under ${DATA}/flows/. The map shows generation only until harvester/backfill-flows.js has run.`,
    });
  }

  // ---- prices -----------------------------------------------------------
  report('prices', 'Regional prices', 0, 1);
  const prices = await loadPrices(loadedDays, notes, available);
  report('prices', 'Regional prices', 1, 1);

  await setMeta('manifest', {
    version: CACHE_VERSION,
    stationCount: stations.length,
    days: loadedDays.map((d) => d.iso),
    wem_days: [...wemCovered].sort(),
    completed_at: Date.now(),
  });

  return finish({
    registry, stations, byId, backtest, correlations, correlationById, curves,
    days: loadedDays, forecastDays: futureDays, weatherDays, prices, flows, notes, startedAt,
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
