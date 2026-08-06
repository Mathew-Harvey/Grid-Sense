// Putting dispatch data and weather on one honest time axis.
//
// AEMO stamps a 5-minute interval with the time it ENDS, but the fields inside
// a single row are not all measured at that instant:
//
//   SCADAVALUE, INITIALMW        the telemetered snapshot as the interval BEGAN
//   CLEAREDMW, UIGF, AVAILABILITY  the target and envelope for its END
//
// So the actual output in a row and the target it was chasing sit five minutes
// apart while sharing one timestamp. Read naively — every field taken as
// observed at T — the actual series runs one interval late against everything
// it is compared with.
//
// That failure is quiet, which is what makes it worth its own module. A
// 5-minute shift on a smooth signal barely dents a correlation coefficient, so
// nothing looks broken; the model simply learns a world where the weather
// arrives before the wind does, and every forecast inherits the offset.

const MINUTE_MS = 60_000;

/** Length of one dispatch interval, in ms. */
export const INTERVAL_MS = 5 * MINUTE_MS;

/**
 * Minutes to add to a row's settlement stamp to reach the instant each field
 * actually describes.
 *
 * The battery storage pair follows the same convention as the power pair, for
 * the same reason: INITIAL_ENERGY_STORAGE is the state of charge on entry,
 * ENERGY_STORAGE the state on exit.
 *
 * @type {Object<string, number>}
 */
export const OBSERVED_AT_SHIFT = {
  SCADAVALUE: -5,
  INITIALMW: -5,
  INITIAL_ENERGY_STORAGE: -5,
  CLEAREDMW: 0,
  TOTALCLEARED: 0,
  UIGF: 0,
  AVAILABILITY: 0,
  SEMIDISPATCHCAP: 0,
  ENERGY_STORAGE: 0,
};

/**
 * The instant a field of a settlement-stamped row refers to.
 *
 * Unknown fields throw rather than defaulting to no shift: a silent zero is the
 * exact bug this module exists to prevent, and a new AEMO column would inherit
 * it without a word.
 *
 * @param {number} settlementDateMs UTC epoch ms of SETTLEMENTDATE
 * @param {string} fieldName AEMO column name, any case
 * @returns {number} UTC epoch ms
 */
export function observedAt(settlementDateMs, fieldName) {
  const shift = OBSERVED_AT_SHIFT[fieldName.toUpperCase()];
  if (shift === undefined) {
    throw new Error(
      `No observed_at convention for AEMO field ${fieldName}. ` +
      `Decide whether it is a start-of-interval snapshot or an end-of-interval ` +
      `target and add it to OBSERVED_AT_SHIFT.`
    );
  }
  return settlementDateMs + shift * MINUTE_MS;
}

/**
 * Where one field observation truly sits in time.
 *
 * Takes the whole record so a caller can hand over a value with its stamp and
 * name together; only the stamp and the name decide the answer.
 *
 * @param {{settlementDateMs: number, field: string, value?: number}} observation
 * @returns {number} UTC epoch ms
 */
export function alignRow({ settlementDateMs, field }) {
  return observedAt(settlementDateMs, field);
}

// One-sided end slope, from the three-point difference formula, then shape
// limited so a curve that turns over at the very first sample cannot launch the
// end segment off in the wrong direction.
function endSlope(h0, h1, d0, d1) {
  const s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (s * d0 <= 0) return 0;
  if (d0 * d1 <= 0 && Math.abs(s) > 3 * Math.abs(d0)) return 3 * d0;
  return s;
}

/**
 * Interpolate an hourly weather series onto arbitrary (typically 5-minute)
 * instants, with monotone cubic Hermite — PCHIP.
 *
 * Linear interpolation is the tempting choice and it is wrong here: it leaves a
 * kink at every source sample, so a model fed hourly irradiance stepped down to
 * five minutes sees a sawtooth with a one-hour period and happily learns it as
 * a real diurnal harmonic. A natural cubic spline removes the kinks but
 * overshoots, which on irradiance means negative sun after dusk and on wind
 * means a farm generating above nameplate.
 *
 * PCHIP is the one that is safe on both counts. The Fritsch-Carlson limiter
 * sets the slope at each sample to a weighted harmonic mean of its neighbouring
 * secants, which is zero whenever they disagree in sign, so the fitted curve
 * can never invent an extremum the data does not contain.
 *
 * Outside the source range the nearest endpoint value is held rather than the
 * end cubic extrapolated, since a cubic run past its last sample is exactly the
 * overshoot this function exists to avoid.
 *
 * @param {ArrayLike<number>} sourceTimes ascending UTC epoch ms
 * @param {ArrayLike<number>} sourceValues same length as sourceTimes
 * @param {ArrayLike<number>} targetTimes UTC epoch ms to evaluate at
 * @returns {Float64Array}
 */
export function interpolateToGrid(sourceTimes, sourceValues, targetTimes) {
  const n = sourceTimes.length;
  const out = new Float64Array(targetTimes.length);

  if (n === 0) throw new Error('interpolateToGrid: no source samples to interpolate from');
  if (n === 1) {
    out.fill(sourceValues[0]);
    return out;
  }

  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = sourceTimes[i + 1] - sourceTimes[i];
    d[i] = (sourceValues[i + 1] - sourceValues[i]) / h[i];
  }

  const m = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    // Opposite-signed secants mean this sample is a local extremum. A non-zero
    // slope there is precisely what makes a spline overshoot.
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }

  if (n === 2) {
    m[0] = d[0];
    m[1] = d[0];
  } else {
    m[0] = endSlope(h[0], h[1], d[0], d[1]);
    m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }

  for (let k = 0; k < targetTimes.length; k++) {
    const t = targetTimes[k];
    if (t <= sourceTimes[0]) { out[k] = sourceValues[0]; continue; }
    if (t >= sourceTimes[n - 1]) { out[k] = sourceValues[n - 1]; continue; }

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sourceTimes[mid] <= t) lo = mid; else hi = mid;
    }

    const s = (t - sourceTimes[lo]) / h[lo];
    const s2 = s * s;
    const s3 = s2 * s;
    out[k] = sourceValues[lo] * (2 * s3 - 3 * s2 + 1)
      + h[lo] * m[lo] * (s3 - 2 * s2 + s)
      + sourceValues[lo + 1] * (-2 * s3 + 3 * s2)
      + h[lo] * m[lo + 1] * (s3 - s2);
  }

  return out;
}

/**
 * The 5-minute grid covering [startMs, endMs].
 *
 * Snapped to absolute 5-minute boundaries rather than started at startMs. Both
 * NEM and WEM sit a whole number of hours from UTC, so every real dispatch
 * interval lands on an exact multiple of five minutes in epoch terms; a grid
 * offset by even one minute would resample every station against instants that
 * do not exist and smear each interval into its neighbour.
 *
 * Float64Array, not Int32Array: epoch milliseconds passed the 32-bit signed
 * range in January 1970, and truncating them would place every timestamp in the
 * wrong decade.
 *
 * @param {number} startMs UTC epoch ms
 * @param {number} endMs UTC epoch ms
 * @returns {Float64Array}
 */
export function resample5min(startMs, endMs) {
  const first = Math.ceil(startMs / INTERVAL_MS) * INTERVAL_MS;
  const count = first > endMs ? 0 : Math.floor((endMs - first) / INTERVAL_MS) + 1;
  const grid = new Float64Array(count);
  for (let i = 0; i < count; i++) grid[i] = first + i * INTERVAL_MS;
  return grid;
}
