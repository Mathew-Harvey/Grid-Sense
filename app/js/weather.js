// Open-Meteo client, and the physics the models actually want out of it.
//
// Open-Meteo sends Access-Control-Allow-Origin:*, so the browser talks to it
// directly — no key, no proxy, 10,000 calls a day on the non-commercial tier.
//
// Two rules govern everything below.
//
// Batch. Every station goes into ONE request as comma-separated coordinate
// lists; the service takes up to a thousand locations and answers with an array
// in request order. A loop over stations is sixty round trips for the same data
// and the same quota.
//
// Derive. Raw variables underperform badly here and it is not a modelling
// nicety: turbine output goes as the CUBE of wind speed below rated, so a
// linear fit on raw m/s underestimates at both ends and overestimates through
// the middle. Measured irradiance conflates "it is night, or winter, or the sun
// is low" with "there is cloud", which is the only part a forecast can add
// information about. The clear-sky index separates them and is the single most
// valuable solar feature in the set.

const DEG = Math.PI / 180;
const HALF_HOUR_MS = 30 * 60_000;

// The ERA5 archive lives on its own host — api.open-meteo.com/v1/archive is a
// 404, verified rather than assumed.
const ENDPOINTS = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
};

const SOLAR_VARIABLES = [
  'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation',
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'temperature_2m',
];

// 100 m is roughly hub height on a modern turbine; the 10 m field is here only
// so the pair gives the shear exponent, and pressure and temperature only so
// they give air density. A turbine harvests mass flow, not wind speed.
const WIND_VARIABLES = [
  'wind_speed_100m', 'wind_speed_10m', 'wind_direction_100m',
  'temperature_2m', 'surface_pressure',
];

// Weather barely moves a dispatchable plant: hot, humid air costs a few percent
// of condenser and inlet-air capacity and that is the whole of the signal.
// Requesting more would only give the fit more ways to learn noise.
const THERMAL_VARIABLES = ['temperature_2m', 'relative_humidity_2m'];

/**
 * What to ask the weather service for, per fueltech.
 *
 * Storage and pumps are empty because they are dispatched against price, not
 * weather; feeding them weather features would fit a relationship that is not
 * there and then report its residual as forecast skill.
 *
 * @type {Object<string, string[]>}
 */
export const VARIABLES_BY_FUELTECH = {
  coal_black: THERMAL_VARIABLES,
  coal_brown: THERMAL_VARIABLES,
  gas_ccgt: THERMAL_VARIABLES,
  gas_ocgt: THERMAL_VARIABLES,
  gas_steam: THERMAL_VARIABLES,
  gas_recip: THERMAL_VARIABLES,
  distillate: THERMAL_VARIABLES,
  hydro: THERMAL_VARIABLES,
  bioenergy: THERMAL_VARIABLES,
  wind: WIND_VARIABLES,
  solar_utility: SOLAR_VARIABLES,
  battery_charging: [],
  battery_discharging: [],
  pumps: [],
};

// Radiation is reported as the mean over the hour PRECEDING the stamp — the
// same interval-ending convention AEMO uses — while temperature, wind, pressure
// and cloud are instantaneous at the stamp. Checked against Sydney either side
// of the June solstice: taken as instantaneous, peak irradiance lands half an
// hour after solar noon and there is still 37 W/m^2 an hour after sunset. Taken
// as a preceding-hour mean and attributed to the middle of that hour, both fall
// into place. Ignoring this puts a systematic half-hour lag into every solar
// model, in the direction that looks plausible.
const HOUR_MEAN_VARIABLES = new Set([
  'shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation',
]);

const DAY_MS = 86_400_000;

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Quota cost of one request, in API calls.
 *
 * A request counts as more than one call once it passes 10 variables or two
 * weeks, fractionally and multiplicatively, per location: the published worked
 * example is 15 variables over 2 weeks = 1.5 calls and the same 15 variables
 * over 4 weeks = 3.0. A 90-day 12-variable backfill across 60 stations is
 * therefore around 460 calls, not one — worth knowing before firing rather
 * than after being rate limited.
 *
 * @param {{locations: number, variables: number, days: number}} request
 * @returns {number}
 */
export function estimateCallCost({ locations, variables, days }) {
  return locations * Math.max(1, variables / 10) * Math.max(1, days / 14);
}

/**
 * Build the batched Open-Meteo request URL.
 *
 * @param {object} request
 * @param {{station_id: string, lat: number, lon: number}[]} request.stations
 * @param {number} request.start UTC epoch ms
 * @param {number} request.end UTC epoch ms
 * @param {string[]} request.variables hourly variable names
 * @param {'forecast'|'archive'} [request.endpoint='forecast']
 * @returns {string}
 */
export function buildWeatherUrl({ stations, start, end, variables, endpoint = 'forecast' }) {
  const url = new URL(ENDPOINTS[endpoint]);
  const p = url.searchParams;

  // Four decimal places is ~10 m, far finer than any reanalysis grid cell, and
  // keeps a 60-station query well inside sane URL length.
  p.set('latitude', stations.map((s) => s.lat.toFixed(4)).join(','));
  p.set('longitude', stations.map((s) => s.lon.toFixed(4)).join(','));
  p.set('hourly', variables.join(','));
  p.set('start_date', utcDate(start));
  p.set('end_date', utcDate(end));

  // Timezone is set explicitly even though GMT is the default, because a
  // default is not a contract and a silent switch to local time would shift
  // every series by ten hours without changing a line of our code.
  p.set('timezone', 'GMT');

  // Epoch seconds, so no date string is ever parsed and no offset arithmetic
  // can be got wrong.
  p.set('timeformat', 'unixtime');

  // Wind defaults to km/h. Cubed for wind power that is a factor of 46 too
  // large, which looks like a plausible model, not like a unit error.
  p.set('wind_speed_unit', 'ms');

  return url.toString();
}

function unpackLocation(location, station) {
  const stamps = location.hourly.time;
  const variables = {};

  for (const [name, series] of Object.entries(location.hourly)) {
    if (name === 'time') continue;
    const shift = HOUR_MEAN_VARIABLES.has(name) ? -HALF_HOUR_MS : 0;

    // Gaps are dropped rather than carried as NaN: a missing hour bridged by
    // the interpolator is a small error in one hour, while a NaN spreads
    // through the cubic into its neighbours and then into every feature built
    // from them.
    const times = new Float64Array(stamps.length);
    const values = new Float64Array(stamps.length);
    let n = 0;
    for (let i = 0; i < stamps.length; i++) {
      if (series[i] === null) continue;
      times[n] = stamps[i] * 1000 + shift;
      values[n] = series[i];
      n++;
    }
    variables[name] = { times: times.subarray(0, n), values: values.subarray(0, n) };
  }

  return {
    station_id: station.station_id,
    lat: location.latitude,
    lon: location.longitude,
    variables,
  };
}

/**
 * Fetch hourly weather for every station in one request.
 *
 * Each returned variable carries its own instants, because they are not all
 * measured at the same moment within an hour — see HOUR_MEAN_VARIABLES.
 *
 * @param {object} request
 * @param {{station_id: string, lat: number, lon: number}[]} request.stations
 * @param {number} request.start UTC epoch ms
 * @param {number} request.end UTC epoch ms
 * @param {string[]} request.variables hourly variable names
 * @param {'forecast'|'archive'} [request.endpoint='forecast']
 * @returns {Promise<{station_id: string, lat: number, lon: number,
 *   variables: Object<string, {times: Float64Array, values: Float64Array}>}[]>}
 */
export async function fetchWeather({ stations, start, end, variables, endpoint = 'forecast' }) {
  const days = Math.max(1, Math.round((end - start) / DAY_MS));
  const cost = estimateCallCost({ locations: stations.length, variables: variables.length, days });
  console.log(
    `Open-Meteo ${endpoint}: ${stations.length} locations x ${variables.length} variables x ` +
    `${days} days in 1 request, costing about ${cost.toFixed(1)} of 10,000 daily calls`
  );

  const response = await fetch(buildWeatherUrl({ stations, start, end, variables, endpoint }));
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`Open-Meteo ${response.status}: ${body.reason ?? response.statusText}`);
  }

  // A single location comes back as a bare object, several as an array.
  const locations = Array.isArray(body) ? body : [body];
  return locations.map((location, i) => unpackLocation(location, stations[i]));
}

/**
 * Air density from the ideal gas law, kg/m^3.
 *
 * Note the pressure unit: weather services report surface pressure in hPa, and
 * feeding those straight in gives 0.012 kg/m^3, a hundredfold error that then
 * hides inside a fitted coefficient instead of announcing itself.
 *
 * @param {number} pressurePa
 * @param {number} tempC
 * @returns {number}
 */
export function airDensity(pressurePa, tempC) {
  return pressurePa / (287.05 * (tempC + 273.15));
}

/**
 * Wind power density at hub height, W/m^2.
 *
 * The cube is the whole point. A 20% error in forecast wind speed is a 73%
 * error in available power, and a hot low-pressure day carries several percent
 * less mass through the rotor than a cold high-pressure one at identical speed.
 *
 * @param {number} density kg/m^3
 * @param {number} speed100m m/s
 * @returns {number}
 */
export function windPower(density, speed100m) {
  return 0.5 * density * speed100m ** 3;
}

/**
 * Wind shear exponent between 10 m and 100 m.
 *
 * Roughly 1/7 in neutral conditions; much higher under a stable nocturnal
 * boundary layer, when the hub sees far more wind than the surface does. It
 * tells the model how much to trust the surface field.
 *
 * @param {number} v100 m/s
 * @param {number} v10 m/s
 * @returns {number}
 */
export function windShear(v100, v10) {
  // A dead calm carries no shear information, and log(v/0) would put an
  // infinity into the feature vector.
  if (!(v100 > 0) || !(v10 > 0)) return 0;
  return Math.log(v100 / v10) / Math.log(10);
}

/**
 * Solar zenith angle in degrees, by NOAA's low-precision algorithm.
 *
 * Accurate to well under a degree, which is far more than a 5-minute power
 * forecast can use. The part that matters is the true solar time: the sun does
 * not keep clock time, and the equation of time swings it by up to a quarter of
 * an hour over the year. Using clock time instead would make the modelled sun
 * lead the real one in February and lag it in November — a seasonal error that
 * a fit will quietly absorb into a bias term.
 *
 * @param {number} lat degrees north
 * @param {number} lon degrees east
 * @param {number} epochMs UTC epoch ms
 * @returns {number} degrees from vertical
 */
export function solarZenith(lat, lon, epochMs) {
  const d = new Date(epochMs);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((epochMs - yearStart) / DAY_MS) + 1;
  const minutesUtc = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;

  const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (minutesUtc / 60 - 12) / 24);

  const eqTime = 229.18 * (0.000075
    + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));

  const decl = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  // Four minutes of solar time per degree of longitude.
  const solarMinutes = minutesUtc + eqTime + 4 * lon;
  const hourAngle = (((solarMinutes / 4 - 180) % 360) + 540) % 360 - 180;

  const cosZ = Math.sin(lat * DEG) * Math.sin(decl)
    + Math.cos(lat * DEG) * Math.cos(decl) * Math.cos(hourAngle * DEG);

  return Math.acos(Math.min(1, Math.max(-1, cosZ))) / DEG;
}

function haurwitz(cosZ) {
  if (cosZ <= 0) return 0;
  return 1098 * cosZ * Math.exp(-0.059 / cosZ);
}

/**
 * Clear-sky global horizontal irradiance, W/m^2, by the Haurwitz model.
 *
 * A closed-form function of the zenith angle alone — no aerosol, altitude or
 * water-vapour terms, and none are wanted. This is a reference level, not a
 * prediction: what the index built from it needs is the diurnal and seasonal
 * shape, and a few percent of standing bias divides straight back out of the
 * ratio.
 *
 * @param {number} lat degrees north
 * @param {number} lon degrees east
 * @param {number} epochMs UTC epoch ms
 * @returns {number}
 */
export function clearSkyGhi(lat, lon, epochMs) {
  return haurwitz(Math.cos(solarZenith(lat, lon, epochMs) * DEG));
}

// Below this the sun is within a few degrees of the horizon, the ratio is the
// quotient of two small uncertain numbers, and any value it returns is noise
// amplified by division.
const CLEAR_SKY_FLOOR = 20;

/**
 * Clear-sky index: measured irradiance as a fraction of the clear-sky
 * reference.
 *
 * This is what separates cloud from geometry. Raw GHI conflates them — 300 W/m^2
 * is a brilliant winter morning and a filthy summer afternoon — so a model fed
 * raw GHI spends its capacity relearning the solar geometry it could have been
 * handed exactly.
 *
 * Not clipped at 1: cloud-edge enhancement genuinely pushes measured irradiance
 * above clear sky, and a farm really does produce more at those moments.
 *
 * @param {number} ghi W/m^2
 * @param {number} clearSky W/m^2 from clearSkyGhi
 * @returns {number}
 */
export function clearSkyIndex(ghi, clearSky) {
  if (!(clearSky > CLEAR_SKY_FLOOR)) return 0;
  return ghi / clearSky;
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The weather feature vector for one station at one instant.
 *
 * Every feature is scaled to roughly unit magnitude, because the learned
 * experts share one regularisation strength and one distance metric across all
 * of them: wind power density in W/m^2 arrives three orders of magnitude larger
 * than a cloud fraction, and unscaled it would swamp everything else.
 *
 * @param {string} fueltech controlled vocabulary
 * @param {Object<string, number>} weatherAtTime raw variables, provider names
 * @param {number} lat degrees north
 * @param {number} lon degrees east
 * @param {number} t UTC epoch ms
 * @returns {{names: string[], values: Float64Array}}
 */
export function buildFeatureVector(fueltech, weatherAtTime, lat, lon, t) {
  const w = weatherAtTime;

  if (fueltech === 'solar_utility') {
    const zenith = solarZenith(lat, lon, t);
    const cosZ = Math.max(0, Math.cos(zenith * DEG));
    const clearSky = haurwitz(cosZ);
    const ghi = finite(w.shortwave_radiation);

    const names = [
      'clear_sky_index', 'clear_sky_ghi', 'cos_zenith', 'beam_normal',
      'diffuse_fraction', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
      'temp_derate',
    ];
    const values = Float64Array.of(
      clearSkyIndex(ghi, clearSky),
      clearSky / 1000,
      cosZ,
      // Single-axis trackers, which is most utility solar here, follow the beam
      // rather than the horizontal plane, so DNI is not redundant with GHI.
      finite(w.direct_normal_irradiance) / 1000,
      ghi > CLEAR_SKY_FLOOR ? finite(w.diffuse_radiation) / ghi : 0,
      finite(w.cloud_cover_low) / 100,
      finite(w.cloud_cover_mid) / 100,
      finite(w.cloud_cover_high) / 100,
      // Panels lose roughly 0.4% of their output per degree above 25 C, so the
      // hottest hour of a clear day is not the best one.
      (finite(w.temperature_2m, 25) - 25) / 25,
    );
    return { names, values };
  }

  if (fueltech === 'wind') {
    const v100 = finite(w.wind_speed_100m);
    const v10 = finite(w.wind_speed_10m);
    const rho = airDensity(finite(w.surface_pressure, 1013) * 100, finite(w.temperature_2m, 15));
    const dir = finite(w.wind_direction_100m) * DEG;

    const names = [
      'wind_power', 'wind_speed_100m', 'wind_shear',
      'wind_dir_sin', 'wind_dir_cos', 'air_density',
    ];
    const values = Float64Array.of(
      windPower(rho, v100) / 1000,
      v100 / 15,
      windShear(v100, v10),
      // Direction has to go in as a sine and cosine pair. Fed as degrees, 359
      // and 1 sit at opposite ends of the range despite being one degree apart,
      // and the fit reads that discontinuity as a real feature. The pair also
      // lets it learn the farm's wake geometry, which is genuinely directional.
      Math.sin(dir),
      Math.cos(dir),
      rho / 1.225,
    );
    return { names, values };
  }

  // Storage and pumps follow price, not weather. An empty vector says so
  // honestly; a populated one would let the fit chase coincidences.
  if (VARIABLES_BY_FUELTECH[fueltech]?.length === 0) {
    return { names: [], values: new Float64Array(0) };
  }

  const temp = finite(w.temperature_2m, 20);
  return {
    names: ['temperature_2m', 'relative_humidity_2m', 'cooling_degrees'],
    values: Float64Array.of(
      (temp - 20) / 20,
      finite(w.relative_humidity_2m, 50) / 100,
      // Derating is a threshold effect, not a linear one: nothing happens until
      // the condenser or the compressor inlet starts running out of margin.
      Math.max(0, temp - 30) / 20,
    ),
  };
}
