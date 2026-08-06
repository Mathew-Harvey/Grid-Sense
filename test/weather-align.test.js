// Timestamp alignment, shape-preserving interpolation, solar geometry and
// request batching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVED_AT_SHIFT, INTERVAL_MS, alignRow, observedAt,
  interpolateToGrid, resample5min,
} from '../app/js/align.js';
import {
  VARIABLES_BY_FUELTECH, buildWeatherUrl, estimateCallCost, fetchWeather,
  airDensity, windPower, windShear,
  solarZenith, clearSkyGhi, clearSkyIndex, buildFeatureVector,
} from '../app/js/weather.js';

// --- 1. Timestamp alignment --------------------------------------------------

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const ROWS = 60;

// Output as a function of the true instant: a unit ramping up, holding at its
// cap, then ramping down.
//
// A single straight line will not do, however natural it looks for a ramp test.
// Two straight lines correlate at exactly 1.0 at every lag, so a lag test built
// on one passes and fails identically and proves nothing either way. The
// corners are what the correlation locks onto.
function output(tMs) {
  const k = (tMs - T0) / INTERVAL_MS;
  if (k < 12) return 20 + 8 * k;
  if (k < 30) return 116;
  return Math.max(20, 116 - 6 * (k - 30));
}

// Rows exactly as AEMO publishes them: one settlement stamp, two fields
// measured five minutes apart.
const rows = Array.from({ length: ROWS }, (_, i) => {
  const settlementDateMs = T0 + i * INTERVAL_MS;
  return {
    settlementDateMs,
    INITIALMW: output(settlementDateMs - INTERVAL_MS),
    TOTALCLEARED: output(settlementDateMs),
  };
});

function pearson(x, y) {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return num / Math.sqrt(dx * dy);
}

// Lag, in intervals, at which x[i + lag] best matches y[i].
function peakLag(x, y, maxLag = 4) {
  let best = 0;
  let bestR = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a = [];
    const b = [];
    for (let i = 0; i < y.length; i++) {
      if (i + lag < 0 || i + lag >= x.length) continue;
      a.push(x[i + lag]); b.push(y[i]);
    }
    const r = pearson(a, b);
    if (r > bestR) { bestR = r; best = lag; }
  }
  return best;
}

test('naive alignment invents a one-interval lag', () => {
  // Both fields taken at face value, stamped at T. This is the mistake, and it
  // has to be demonstrated or the next test proves nothing.
  const actual = rows.map((r) => r.INITIALMW);
  const cleared = rows.map((r) => r.TOTALCLEARED);

  assert.equal(peakLag(actual, cleared), 1);
  // And it is invisible in the correlation itself: still 0.996 at lag zero, so
  // nothing about the number looks wrong.
  assert.ok(pearson(actual, cleared) > 0.99);
});

test('aligned series show no spurious lag', () => {
  const actualAt = new Map();
  const clearedAt = new Map();
  for (const r of rows) {
    actualAt.set(alignRow({ settlementDateMs: r.settlementDateMs, field: 'INITIALMW', value: r.INITIALMW }), r.INITIALMW);
    clearedAt.set(observedAt(r.settlementDateMs, 'TOTALCLEARED'), r.TOTALCLEARED);
  }

  const instants = [...clearedAt.keys()].filter((t) => actualAt.has(t)).sort((a, b) => a - b);
  const actual = instants.map((t) => actualAt.get(t));
  const cleared = instants.map((t) => clearedAt.get(t));

  assert.ok(instants.length > 50);
  assert.equal(peakLag(actual, cleared), 0);

  // A plant that exactly tracks its target has actual equal to target at the
  // same instant. Anything else means the module put them in different places.
  for (let i = 0; i < actual.length; i++) assert.equal(actual[i], cleared[i]);
});

test('field shifts follow the interval-ending convention', () => {
  const T = Date.UTC(2026, 7, 1, 4, 5, 0);
  assert.equal(observedAt(T, 'SCADAVALUE'), T - INTERVAL_MS);
  assert.equal(observedAt(T, 'INITIALMW'), T - INTERVAL_MS);
  assert.equal(observedAt(T, 'CLEAREDMW'), T);
  assert.equal(observedAt(T, 'UIGF'), T);
  assert.equal(observedAt(T, 'AVAILABILITY'), T);
  assert.equal(observedAt(T, 'SEMIDISPATCHCAP'), T);
  assert.equal(observedAt(T, 'uigf'), T);

  assert.equal(OBSERVED_AT_SHIFT.SCADAVALUE, -5);
  assert.equal(OBSERVED_AT_SHIFT.UIGF, 0);

  // Silently assuming no shift for an unrecognised column is the whole bug.
  assert.throws(() => observedAt(T, 'MWH_READING'), /No observed_at convention/);
});

test('5-minute grid snaps to real interval boundaries', () => {
  const grid = resample5min(T0 + 61_000, T0 + 31 * 60_000);
  assert.equal(grid[0], T0 + 5 * 60_000);
  assert.equal(grid[grid.length - 1], T0 + 30 * 60_000);
  assert.equal(grid.length, 6);
  for (let i = 0; i < grid.length; i++) assert.equal(grid[i] % INTERVAL_MS, 0);

  // Epoch milliseconds do not survive 32 bits; a truncated grid would land in
  // 1970 without complaining.
  assert.ok(grid instanceof Float64Array);
  assert.ok(grid[0] > 2 ** 31);
});

// --- 2. PCHIP ----------------------------------------------------------------

const HOUR_MS = 3_600_000;

function hourly(values, startMs = T0) {
  return values.map((_, i) => startMs + i * HOUR_MS);
}

test('PCHIP reproduces the source samples exactly', () => {
  const v = [0, 5, 200, 640, 900, 905, 906, 400, 0];
  const t = hourly(v);
  const out = interpolateToGrid(t, v, t);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(out[i] - v[i]) < 1e-9);
});

test('PCHIP never overshoots a monotone series', () => {
  const v = [0, 5, 200, 640, 900, 905, 906];
  const t = hourly(v);
  const grid = resample5min(t[0], t[t.length - 1]);
  const out = interpolateToGrid(t, v, grid);

  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] >= out[i - 1] - 1e-9, `not monotone at ${i}: ${out[i - 1]} -> ${out[i]}`);
  }
  assert.ok(Math.min(...out) >= 0 - 1e-9);
  assert.ok(Math.max(...out) <= 906 + 1e-9);

  // And within each source bracket, not merely within the global range — the
  // wiggle a natural cubic spline puts in would still pass a global test.
  for (let k = 0; k < grid.length; k++) {
    let i = 0;
    while (i < t.length - 2 && t[i + 1] <= grid[k]) i++;
    const lo = Math.min(v[i], v[i + 1]);
    const hi = Math.max(v[i], v[i + 1]);
    assert.ok(out[k] >= lo - 1e-9 && out[k] <= hi + 1e-9);
  }
});

test('PCHIP stays non-negative across a sharp irradiance step', () => {
  // Fog burning off: near dark, then full sun within the hour.
  const v = [0, 0, 0, 900, 920, 930, 0, 0];
  const t = hourly(v);
  const out = interpolateToGrid(t, v, resample5min(t[0], t[t.length - 1]));

  assert.ok(Math.min(...out) >= 0, `undershot to ${Math.min(...out)} W/m^2`);
  assert.ok(Math.max(...out) <= 930, `overshot to ${Math.max(...out)} W/m^2`);
});

test('PCHIP is a cubic, not linear interpolation in disguise', () => {
  const v = [0, 100, 400, 800, 900];
  const t = hourly(v);
  const grid = resample5min(t[0], t[t.length - 1]);
  const out = interpolateToGrid(t, v, grid);

  let maxGap = 0;
  for (let k = 0; k < grid.length; k++) {
    let i = 0;
    while (i < t.length - 2 && t[i + 1] <= grid[k]) i++;
    const s = (grid[k] - t[i]) / HOUR_MS;
    maxGap = Math.max(maxGap, Math.abs(out[k] - (v[i] + s * (v[i + 1] - v[i]))));
  }
  assert.ok(maxGap > 5, `indistinguishable from linear (max gap ${maxGap})`);
});

test('PCHIP refuses input it would silently misread', () => {
  const t = hourly([0, 1, 2, 3]);

  // A short value array reads past its end as undefined, and the NaN that makes
  // spreads through the cubic into every neighbouring interval.
  assert.throws(() => interpolateToGrid(t, [0, 10, 20], [T0 + 1]), /3 values/);

  // Descending or duplicate stamps make the bracket search and the secants
  // meaningless, and the answer that comes back is plausible rather than wrong
  // looking: reversed hourly weather returns a flat line at its first sample.
  assert.throws(() => interpolateToGrid([...t].reverse(), [0, 10, 20, 30], [T0 + 1]),
    /strictly increase/);
  assert.throws(() => interpolateToGrid([T0, T0 + HOUR_MS, T0 + HOUR_MS], [0, 10, 20], [T0 + 1]),
    /strictly increase/);
});

// --- 3. Solar position -------------------------------------------------------

const SYDNEY = { lat: -33.8688, lon: 151.2093 };
const PERTH = { lat: -31.9523, lon: 115.8613 };

// An independent equation-of-time approximation, from a different derivation to
// the one under test, so agreement means something.
function equationOfTimeMinutes(dayOfYear) {
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

function dayOfYear(ms) {
  return Math.floor((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

// The instant of minimum zenith over a UTC day, to the minute.
function solarNoon(site, dayStartMs) {
  let best = dayStartMs;
  let bestZ = Infinity;
  for (let m = 0; m < 1440; m++) {
    const t = dayStartMs + m * 60_000;
    const z = solarZenith(site.lat, site.lon, t);
    if (z < bestZ) { bestZ = z; best = t; }
  }
  return { t: best, zenith: bestZ };
}

test('solar noon lands within a few minutes of truth', () => {
  const cases = [
    [SYDNEY, Date.UTC(2026, 5, 21)],
    [SYDNEY, Date.UTC(2026, 11, 21)],
    [PERTH, Date.UTC(2026, 2, 15)],
    [PERTH, Date.UTC(2026, 8, 15)],
  ];

  for (const [site, dayStart] of cases) {
    const { t } = solarNoon(site, dayStart);
    // True solar noon is 12:00 solar time: UTC noon, less four minutes per
    // degree east, less the equation of time.
    const expected = dayStart
      + (720 - 4 * site.lon - equationOfTimeMinutes(dayOfYear(dayStart))) * 60_000;
    const errMinutes = Math.abs(t - expected) / 60_000;
    assert.ok(errMinutes <= 3, `solar noon out by ${errMinutes.toFixed(1)} min at lon ${site.lon}`);
  }
});

test('the sun is below the horizon at local midnight', () => {
  for (const site of [SYDNEY, PERTH]) {
    for (const dayStart of [Date.UTC(2026, 5, 21), Date.UTC(2026, 11, 21)]) {
      const midnight = solarNoon(site, dayStart).t + 12 * HOUR_MS;
      assert.ok(solarZenith(site.lat, site.lon, midnight) > 90);
    }
  }
});

test('the midday sun is higher in December than in June down here', () => {
  for (const site of [SYDNEY, PERTH]) {
    const december = solarNoon(site, Date.UTC(2026, 11, 21)).zenith;
    const june = solarNoon(site, Date.UTC(2026, 5, 21)).zenith;
    assert.ok(december < june - 40, `December ${december} vs June ${june}`);

    // At solstice the noon zenith is |latitude - declination| and the
    // declination is 23.44 degrees, so both are checkable outright.
    assert.ok(Math.abs(december - Math.abs(site.lat + 23.44)) < 1);
    assert.ok(Math.abs(june - Math.abs(site.lat - 23.44)) < 1);
  }
});

// --- 4. Clear-sky index ------------------------------------------------------

test('clear-sky index separates cloud from geometry', () => {
  const dayStart = Date.UTC(2026, 11, 21);
  const noon = solarNoon(SYDNEY, dayStart).t;
  const midnight = noon + 12 * HOUR_MS;

  const csNoon = clearSkyGhi(SYDNEY.lat, SYDNEY.lon, noon);
  const csNight = clearSkyGhi(SYDNEY.lat, SYDNEY.lon, midnight);

  assert.ok(csNoon > 900 && csNoon < 1100, `midsummer clear-sky noon GHI ${csNoon}`);
  assert.equal(csNight, 0);

  // Night: a sensor offset must not divide by a vanishing reference and report
  // a spectacular clear-sky index at midnight.
  assert.equal(clearSkyIndex(4, csNight), 0);

  // Clear midday.
  const clear = clearSkyIndex(0.97 * csNoon, csNoon);
  assert.ok(clear > 0.9 && clear < 1.05, `clear-sky index ${clear}`);

  // Heavy overcast: the same 120 W/m^2 that would be a bright winter dawn.
  assert.ok(clearSkyIndex(120, csNoon) < 0.3);

  // Low sun, clear sky: raw GHI is small but the index knows the difference.
  const dawn = noon - 5.5 * HOUR_MS;
  const csDawn = clearSkyGhi(SYDNEY.lat, SYDNEY.lon, dawn);
  assert.ok(csDawn > 20 && csDawn < 400);
  assert.ok(clearSkyIndex(0.95 * csDawn, csDawn) > 0.9);

  // Twilight is the dangerous case, not midnight. Midnight gives a reference of
  // exactly zero, which any guard catches; a few minutes either side of sunrise
  // gives a reference of a few W/m^2, and a sensor sitting on a small offset
  // then divides its way to a clear-sky index of 1.2 in the dark. A guard that
  // only tests for zero passes every check above and still does this.
  const twilight = [];
  for (let m = -180; m <= 0; m++) {
    const cs = clearSkyGhi(SYDNEY.lat, SYDNEY.lon, dawn + m * 60_000);
    if (cs > 0 && cs < 20) twilight.push(cs);
  }
  assert.ok(twilight.length > 0, 'no sub-floor twilight instants found to test');
  for (const cs of twilight) {
    assert.equal(clearSkyIndex(4, cs), 0, `sensor offset survived a reference of ${cs} W/m^2`);
  }
});

// --- 5. Batching -------------------------------------------------------------

const STATIONS = Array.from({ length: 60 }, (_, i) => ({
  station_id: `ST${i}`,
  lat: -30 - i * 0.25,
  lon: 130 + i * 0.3,
}));

test('every station goes into one request', () => {
  const url = buildWeatherUrl({
    stations: STATIONS,
    start: Date.UTC(2026, 4, 8),
    end: Date.UTC(2026, 7, 6),
    variables: VARIABLES_BY_FUELTECH.wind,
    endpoint: 'archive',
  });

  const p = new URL(url).searchParams;
  assert.equal(p.get('latitude').split(',').length, 60);
  assert.equal(p.get('longitude').split(',').length, 60);
  assert.ok(p.get('latitude').startsWith('-30.0000,-30.2500,'));
  assert.equal(p.getAll('latitude').length, 1);

  // Timezone is never left to the default.
  assert.equal(p.get('timezone'), 'GMT');
  assert.equal(p.get('timeformat'), 'unixtime');
  // Wind arrives in km/h unless asked otherwise, and it is cubed downstream.
  assert.equal(p.get('wind_speed_unit'), 'ms');

  assert.equal(p.get('start_date'), '2026-05-08');
  assert.equal(p.get('end_date'), '2026-08-06');
  assert.ok(url.startsWith('https://archive-api.open-meteo.com/v1/archive?'));
  assert.ok(buildWeatherUrl({
    stations: STATIONS, start: Date.UTC(2026, 7, 6), end: Date.UTC(2026, 7, 8),
    variables: ['temperature_2m'],
  }).startsWith('https://api.open-meteo.com/v1/forecast?'));
});

// A recorded response shape, so the unpacking is exercised without a live call.
function stubFetch(body, requests) {
  return async (url) => {
    requests.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
}

test('responses unpack onto the instants each variable really describes', async () => {
  const stamp = Date.UTC(2026, 6, 10, 3, 0, 0) / 1000;
  const location = {
    latitude: -30.02, longitude: 130.03,
    hourly: {
      time: [stamp, stamp + 3600, stamp + 7200],
      shortwave_radiation: [0, 100, null],
      temperature_2m: [10, 12, 14],
    },
  };
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch([location, location], requests);

  try {
    const out = await fetchWeather({
      stations: STATIONS.slice(0, 2),
      start: Date.UTC(2026, 6, 10),
      end: Date.UTC(2026, 6, 10),
      variables: ['shortwave_radiation', 'temperature_2m'],
      endpoint: 'archive',
    });

    assert.equal(requests.length, 1, 'two stations must not mean two requests');
    assert.equal(out.length, 2);
    assert.equal(out[0].station_id, 'ST0');
    assert.equal(out[1].station_id, 'ST1');

    // Radiation is an average over the hour behind its stamp, so it belongs at
    // the middle of that hour. Everything else is instantaneous.
    const rad = out[0].variables.shortwave_radiation;
    const temp = out[0].variables.temperature_2m;
    assert.equal(rad.times[0], stamp * 1000 - 30 * 60_000);
    assert.equal(temp.times[0], stamp * 1000);

    // A gap is dropped so the interpolator bridges it; carried through as NaN
    // it would spread into every neighbouring interval.
    assert.equal(rad.values.length, 2);
    assert.equal(temp.values.length, 3);

    // One location comes back as a bare object rather than an array.
    globalThis.fetch = stubFetch(location, requests);
    const single = await fetchWeather({
      stations: STATIONS.slice(0, 1),
      start: Date.UTC(2026, 6, 10),
      end: Date.UTC(2026, 6, 10),
      variables: ['temperature_2m'],
    });
    assert.equal(single.length, 1);

    globalThis.fetch = async () => ({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ error: true, reason: 'Data corrupted at path' }),
    });
    await assert.rejects(
      () => fetchWeather({
        stations: STATIONS.slice(0, 1), start: Date.UTC(2026, 6, 10),
        end: Date.UTC(2026, 6, 10), variables: ['temperature_2m'],
      }),
      /Data corrupted at path/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('the quota cost of a backfill is not one call', () => {
  const perLocation = estimateCallCost({ locations: 1, variables: 12, days: 90 });
  assert.ok(perLocation > 6 && perLocation < 9, `${perLocation} calls per location`);
  assert.equal(
    estimateCallCost({ locations: 60, variables: 12, days: 90 }),
    60 * perLocation,
  );
  // Small requests still cost exactly one.
  assert.equal(estimateCallCost({ locations: 1, variables: 5, days: 3 }), 1);

  // The two factors are independent and they multiply. Counting days alone
  // still lands inside the range checked above, so it has to be pinned
  // separately or the variable factor is untested.
  assert.equal(estimateCallCost({ locations: 1, variables: 20, days: 3 }), 2);
  assert.equal(estimateCallCost({ locations: 1, variables: 10, days: 28 }), 2);
  assert.equal(estimateCallCost({ locations: 1, variables: 20, days: 28 }), 4);
  // Which is what makes the 12-variable 90-day figure 7.71 and not 6.43.
  assert.ok(Math.abs(perLocation - (12 / 10) * (90 / 14)) < 1e-9);
});

// --- Derived features --------------------------------------------------------

test('derived wind and density features are physical', () => {
  const rho = airDensity(101_325, 15);
  assert.ok(Math.abs(rho - 1.225) < 0.005, `ISA density came out ${rho}`);
  // Hot and low pressure carries measurably less mass through the rotor.
  assert.ok(airDensity(99_000, 35) < rho - 0.08);

  // Cubic, not linear: double the wind for eight times the power.
  assert.ok(Math.abs(windPower(1.225, 20) / windPower(1.225, 10) - 8) < 1e-9);
  assert.ok(Math.abs(windPower(1.225, 10) - 612.5) < 0.1);

  // The 1/7 power law is the neutral case.
  assert.ok(Math.abs(windShear(10 * 10 ** (1 / 7), 10) - 1 / 7) < 1e-9);
  assert.equal(windShear(5, 0), 0);
});

test('feature vectors carry names and only weather that matters', () => {
  const t = Date.UTC(2026, 11, 21, 2, 0, 0);
  const weather = {
    shortwave_radiation: 800, direct_normal_irradiance: 850, diffuse_radiation: 120,
    cloud_cover: 10, cloud_cover_low: 5, cloud_cover_mid: 5, cloud_cover_high: 0,
    temperature_2m: 32, relative_humidity_2m: 40,
    wind_speed_100m: 12, wind_speed_10m: 8, wind_direction_100m: 350,
    surface_pressure: 1008,
  };

  for (const fueltech of Object.keys(VARIABLES_BY_FUELTECH)) {
    const { names, values } = buildFeatureVector(fueltech, weather, SYDNEY.lat, SYDNEY.lon, t);
    assert.equal(names.length, values.length, fueltech);
    for (const v of values) assert.ok(Number.isFinite(v), `${fueltech} produced ${v}`);
    // Nothing may arrive orders of magnitude off the others; one shared
    // regulariser has to serve the whole vector.
    for (const v of values) assert.ok(Math.abs(v) < 10, `${fueltech} feature ${v} out of scale`);
  }

  const solar = buildFeatureVector('solar_utility', weather, SYDNEY.lat, SYDNEY.lon, t);
  assert.ok(solar.names.includes('clear_sky_index'));
  assert.ok(solar.values[solar.names.indexOf('clear_sky_index')] > 0.5);

  const wind = buildFeatureVector('wind', weather, SYDNEY.lat, SYDNEY.lon, t);
  const sin = wind.values[wind.names.indexOf('wind_dir_sin')];
  const cos = wind.values[wind.names.indexOf('wind_dir_cos')];
  assert.ok(Math.abs(sin * sin + cos * cos - 1) < 1e-9);
  // 350 and 10 degrees are twenty degrees apart, and the encoding must say so.
  const near = buildFeatureVector('wind', { ...weather, wind_direction_100m: 10 },
    SYDNEY.lat, SYDNEY.lon, t);
  const dsin = near.values[near.names.indexOf('wind_dir_sin')] - sin;
  const dcos = near.values[near.names.indexOf('wind_dir_cos')] - cos;
  assert.ok(Math.hypot(dsin, dcos) < 0.4);

  // Storage is dispatched on price. It gets nothing.
  assert.equal(buildFeatureVector('battery_charging', weather, SYDNEY.lat, SYDNEY.lon, t).names.length, 0);
  assert.equal(buildFeatureVector('pumps', weather, SYDNEY.lat, SYDNEY.lon, t).names.length, 0);

  // Missing variables must land on a neutral value, never NaN: one NaN feature
  // poisons a learned expert's state permanently.
  const empty = buildFeatureVector('wind', {}, SYDNEY.lat, SYDNEY.lon, t);
  for (const v of empty.values) assert.ok(Number.isFinite(v));

  // The provider reports surface pressure in hPa and the density formula wants
  // Pa. Skipped, the density lands at 0.012 kg/m^3 — still finite, still small,
  // so every assertion above passes while every wind farm loses a factor of a
  // hundred into a fitted coefficient.
  const density = wind.values[wind.names.indexOf('air_density')];
  assert.ok(density > 0.85 && density < 1.15, `air density feature ${density}`);

  // A fueltech outside the vocabulary must not quietly collect the thermal
  // features. The registry carries a null fueltech for unclassified stations.
  assert.throws(() => buildFeatureVector(null, weather, SYDNEY.lat, SYDNEY.lon, t),
    /No feature vector defined/);
  assert.throws(() => buildFeatureVector('solar_rooftop', weather, SYDNEY.lat, SYDNEY.lon, t),
    /No feature vector defined/);
  assert.throws(() => buildFeatureVector('toString', weather, SYDNEY.lat, SYDNEY.lon, t),
    /No feature vector defined/);
});

test('features stay in one scale through a gale and through the night', () => {
  // The fixture above runs at 12 m/s, which proves nothing about scale: power
  // goes as the cube, so the feature grows eightfold for every doubling and the
  // interesting end of the range is the one no other test visits. 25 m/s is the
  // cut-out speed, above which a turbine produces nothing and there is no
  // output left to predict, so that is where the scale has to still hold.
  const t = Date.UTC(2026, 11, 21, 2, 0, 0);
  for (const v100 of [0, 5, 12, 20, 25]) {
    const { names, values } = buildFeatureVector('wind', {
      wind_speed_100m: v100, wind_speed_10m: v100 * 0.75,
      wind_direction_100m: 270, surface_pressure: 1008, temperature_2m: 20,
    }, SYDNEY.lat, SYDNEY.lon, t);
    for (let i = 0; i < values.length; i++) {
      assert.ok(Number.isFinite(values[i]), `${names[i]} is ${values[i]} at ${v100} m/s`);
      assert.ok(Math.abs(values[i]) < 10,
        `${names[i]} reached ${values[i].toFixed(1)} at ${v100} m/s, off the scale of the rest`);
    }
  }

  // Still cubic where it matters: eight times the power for double the wind.
  const at = (v) => buildFeatureVector('wind', { wind_speed_100m: v, wind_speed_10m: v * 0.75,
    wind_direction_100m: 270, surface_pressure: 1008, temperature_2m: 20 },
  SYDNEY.lat, SYDNEY.lon, t).values[0];
  assert.ok(Math.abs(at(16) / at(8) - 8) < 1e-9);

  // Night, with a sensor reading a small offset rather than a clean zero. Both
  // the clear-sky index and the diffuse fraction divide by something that has
  // gone to zero, and either one arriving as NaN or Infinity would be carried
  // into an expert's state and never leave it.
  const midnight = Date.UTC(2026, 11, 21, 15, 0, 0);
  for (const ghi of [0, 2]) {
    const { names, values } = buildFeatureVector('solar_utility', {
      shortwave_radiation: ghi, diffuse_radiation: ghi, direct_normal_irradiance: 0,
      cloud_cover_low: 0, cloud_cover_mid: 0, cloud_cover_high: 0, temperature_2m: 14,
    }, SYDNEY.lat, SYDNEY.lon, midnight);
    for (let i = 0; i < values.length; i++) {
      assert.ok(Number.isFinite(values[i]), `${names[i]} is ${values[i]} at night with GHI ${ghi}`);
    }
    assert.equal(values[names.indexOf('clear_sky_index')], 0);
    assert.equal(values[names.indexOf('diffuse_fraction')], 0);
  }
});

test('the fueltech vocabulary is covered exactly', () => {
  const vocabulary = [
    'coal_black', 'coal_brown', 'gas_ccgt', 'gas_ocgt', 'gas_steam', 'gas_recip',
    'distillate', 'hydro', 'wind', 'solar_utility', 'battery_charging',
    'battery_discharging', 'bioenergy', 'pumps',
  ];
  assert.deepEqual(Object.keys(VARIABLES_BY_FUELTECH).sort(), [...vocabulary].sort());
  assert.ok(VARIABLES_BY_FUELTECH.wind.includes('wind_speed_100m'));
  assert.ok(VARIABLES_BY_FUELTECH.solar_utility.includes('shortwave_radiation'));
  // Curtailment aside, a coal station has no business being handed irradiance.
  assert.ok(!VARIABLES_BY_FUELTECH.coal_black.includes('shortwave_radiation'));
});
