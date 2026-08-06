// IndexedDB persistence.
//
// Ninety days at 5-minute resolution is 25,920 intervals per station. Across the
// modelled fleet that is well over a million observations, which is comfortable
// in IndexedDB only if it is stored column-wise as typed arrays. Stored as a
// million individual JS objects it is not: structured-clone cost and GC pressure
// both go up by more than an order of magnitude, and the replay loop then spends
// its time allocating rather than learning.
//
// So the unit of storage is one station-day: a small set of parallel typed
// arrays, written and read as a single record.

const DB_NAME = 'gridsense';
const DB_VERSION = 1;

// Timestamps are stored as minutes since epoch rather than milliseconds so they
// fit in Int32 (ms overflows Int32 in 1970 + 24 days). Everything above this
// layer works in epoch ms; the conversion is confined to pack/unpack.
const MS_PER_MIN = 60_000;

const SERIES = /** @type {const} */ ([
  ['output', Float32Array],
  ['available', Float32Array],
  ['cleared', Float32Array],
  ['uigf', Float32Array],
  ['curtailed', Float32Array],
]);

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Keyed by "stationId|dayIsoDate" so a day can be replaced wholesale when
      // the next-day file lands and backfills UIGF onto intervals that were
      // ingested live with actual output only.
      if (!db.objectStoreNames.contains('station_days')) {
        db.createObjectStore('station_days');
      }
      if (!db.objectStoreNames.contains('weather_days')) {
        db.createObjectStore('weather_days');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
const db = () => (dbPromise ??= open());

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const dayKey = (stationId, dayMs) =>
  `${stationId}|${new Date(dayMs).toISOString().slice(0, 10)}`;

/**
 * Pack canonical observations for one station-day into parallel typed arrays.
 * Flags that are one bit each (capped, quality) share a single Uint8 lane rather
 * than costing a byte apiece — at fleet scale that difference is real.
 */
export function packDay(observations) {
  const n = observations.length;
  const t = new Int32Array(n);
  const lanes = Object.fromEntries(SERIES.map(([name, T]) => [name, new T(n)]));
  const flags = new Uint8Array(n);
  const unitsOnline = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const o = observations[i];
    t[i] = Math.round(o.observed_at / MS_PER_MIN);
    for (const [name] of SERIES) {
      const v = o[`${name}_mw`];
      // NaN is the honest encoding for "not published", and it propagates
      // visibly through arithmetic instead of quietly reading as zero output.
      lanes[name][i] = v === null || v === undefined ? NaN : v;
    }
    flags[i] = (o.capped ? 1 : 0) | (o.quality === 'partial' ? 2 : 0) | (o.quality === 'suspect' ? 4 : 0);
    unitsOnline[i] = Math.min(255, o.units_online ?? 0);
  }

  return { t, ...lanes, flags, unitsOnline, n };
}

export function unpackDay(packed) {
  const { t, flags, unitsOnline, n } = packed;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      observed_at: t[i] * MS_PER_MIN,
      output_mw: packed.output[i],
      available_mw: packed.available[i],
      cleared_mw: packed.cleared[i],
      uigf_mw: packed.uigf[i],
      curtailed_mw: packed.curtailed[i],
      capped: (flags[i] & 1) !== 0,
      quality: flags[i] & 4 ? 'suspect' : flags[i] & 2 ? 'partial' : 'ok',
      units_online: unitsOnline[i],
    };
  }
  return out;
}

export const putStationDay = (stationId, dayMs, packed) =>
  tx('station_days', 'readwrite', (s) => s.put(packed, dayKey(stationId, dayMs)));

export const getStationDay = (stationId, dayMs) =>
  tx('station_days', 'readonly', (s) => s.get(dayKey(stationId, dayMs)));

export const putWeatherDay = (stationId, dayMs, packed) =>
  tx('weather_days', 'readwrite', (s) => s.put(packed, dayKey(stationId, dayMs)));

export const getWeatherDay = (stationId, dayMs) =>
  tx('weather_days', 'readonly', (s) => s.get(dayKey(stationId, dayMs)));

export const setMeta = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));
export const getMeta = (key) => tx('meta', 'readonly', (s) => s.get(key));

export const listStationDays = () => tx('station_days', 'readonly', (s) => s.getAllKeys());

/** Wipe everything. Cold start must reach a working app without manual steps. */
export async function clearAll() {
  for (const store of ['station_days', 'weather_days', 'meta']) {
    await tx(store, 'readwrite', (s) => s.clear());
  }
}
