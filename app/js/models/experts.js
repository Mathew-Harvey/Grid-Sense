// The expert bank: six independent forecasters behind one interface, so the
// combiner never has to know which is which.
//
//   predict(state, horizonSteps) -> MW
//   update(state, actual)        -> void
//
// `state` describes one station at one instant:
//
//   { capacity_mw, fueltech, observed_at, tod_minutes, month,
//     history,        // MW, newest last; history.at(-1) is y(t)
//     weather,        // weather features at observed_at
//     forecast,       // forecast[h-1] is the outlook for t+h
//     horizon_steps } // see below
//
// update() pairs a state with whatever eventuated `state.horizon_steps`
// intervals after it, defaulting to one. Run a separate bank per horizon: the
// learned experts fit whichever horizon they are fed, and mixing horizons into
// one instance averages two different mappings into something that serves
// neither.
//
// Every learned expert holds its state normalised by capacity. Without that no
// single forgetting factor, covariance scale or distance metric can serve both
// a 50 MW solar farm and a 2640 MW coal station.
//
// Weather features carry the names the forecast provider uses:
//   wind_speed_100m   m/s at roughly hub height
//   temperature_2m    degC
//   clear_sky_index   measured GHI / clear-sky GHI, dimensionless
//   clear_sky_ghi     W/m^2, the clear-sky reference itself

const MINUTES_PER_STEP = 5;

/**
 * Constrain a forecast to what the machine can physically do.
 *
 * The NaN case is not paranoia: one non-finite prediction reaching the combiner
 * drives that expert's weight to NaN and it never recovers for the rest of the
 * run, so a missing feature has to land on zero here rather than propagate.
 */
function clip(mw, capacityMw) {
  if (!Number.isFinite(mw)) return 0;
  if (mw < 0) return 0;
  return mw > capacityMw ? capacityMw : mw;
}

/** Minutes past local midnight at t+h, wrapping over the day boundary. */
function todAt(state, h) {
  return (((state.tod_minutes + h * MINUTES_PER_STEP) % 1440) + 1440) % 1440;
}

/**
 * The weather outlook for t+h. Where the forecast does not reach that far the
 * current observation is the honest substitute — it is what a forecast decays
 * to anyway.
 */
function outlook(state, h) {
  return (state.forecast && state.forecast[h - 1]) || state.weather || {};
}

// ---------------------------------------------------------------------------
// 1. Persistence
// ---------------------------------------------------------------------------

/**
 * y_hat(t+h) = y(t). The baseline every other expert is scored against, and at
 * five minutes it is very hard to beat.
 */
export class Persistence {
  constructor() {
    this.name = 'persistence';
  }

  predict(state) {
    return clip(state.history.at(-1), state.capacity_mw);
  }

  update() {}
}

// ---------------------------------------------------------------------------
// 2. Diurnal climatology
// ---------------------------------------------------------------------------

const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = 1440 / BUCKET_MINUTES;

// A true 1/n running mean freezes once n is large, and a station's mean output
// genuinely moves — turbines get retrofitted, panels get cleaned, a unit comes
// back from outage. Flooring the learning rate keeps the cell alive.
const MIN_LEARNING_RATE = 1 / 500;

function accumulate(map, key, value) {
  const cell = map.get(key);
  if (!cell) {
    map.set(key, { n: 1, mean: value });
    return;
  }
  cell.n++;
  cell.mean += Math.max(1 / cell.n, MIN_LEARNING_RATE) * (value - cell.mean);
}

/**
 * Mean output for this station at this time of day and month, learned online.
 * Hopeless at five minutes and genuinely competitive at 24 hours for solar,
 * where the sun's schedule carries most of the signal.
 *
 * Kept as running means per cell rather than a stored history, so memory is
 * 12 x 48 numbers regardless of how long the replay runs.
 */
export class DiurnalClimatology {
  constructor() {
    this.name = 'climatology';
    this.cells = new Map();    // month*48 + bucket
    this.buckets = new Map();  // bucket, month-agnostic backstop
  }

  predict(state, h) {
    // The month is taken from the state rather than from t+h. A day-ahead
    // horizon crosses a month boundary on one day in thirty, and adjacent
    // months' climatologies are close enough that chasing it is not worth the
    // calendar arithmetic.
    const bucket = Math.floor(todAt(state, h) / BUCKET_MINUTES);
    const cell = this.cells.get(state.month * BUCKETS_PER_DAY + bucket) || this.buckets.get(bucket);
    // Before a cell has ever been visited, the station's own last reading beats
    // any average this expert could offer.
    if (!cell) return clip(state.history.at(-1), state.capacity_mw);
    return clip(cell.mean, state.capacity_mw);
  }

  update(state, actual) {
    const h = state.horizon_steps ?? 1;
    const bucket = Math.floor(todAt(state, h) / BUCKET_MINUTES);
    accumulate(this.cells, state.month * BUCKETS_PER_DAY + bucket, actual);
    accumulate(this.buckets, bucket, actual);
  }
}

// ---------------------------------------------------------------------------
// 3. Physical curve
// ---------------------------------------------------------------------------

// Both curves are expressed as a fraction of nameplate, which is what makes a
// fitted shape comparable — and reusable — across stations of different sizes.
export const DEFAULT_WIND_CURVE = { yMin: 0, yMax: 0.98, k: 0.62, v50: 9.5 };
export const DEFAULT_SOLAR_CURVE = { gain: 0.95, offset: 0 };

const CUT_IN_MS = 3;
const CUT_OUT_MS = 25;

const REFERENCE_IRRADIANCE = 1000;  // W/m^2, the condition a module is rated at
const DERATE_PER_DEGC = 0.004;      // silicon loses about 0.4%/degC above 25
const CELL_RISE_PER_WM2 = 0.03;     // NOCT: roughly 30 degC above ambient at full sun

/**
 * Four-parameter logistic wind power curve, in fraction of nameplate.
 *
 * @param {number} speed m/s at hub height
 * @param {{yMin:number,yMax:number,k:number,v50:number}} [p]
 */
export function windFraction(speed, p = DEFAULT_WIND_CURVE) {
  if (!Number.isFinite(speed)) return 0;
  // Cut-in and cut-out are hard discontinuities, not gentle tails: below cut-in
  // there is not enough energy in the air to turn the rotor at all, and at
  // cut-out the machine feathers and stops to protect itself. A farm at full
  // output drops to zero within minutes when a front pushes it past cut-out,
  // and no smooth sigmoid reproduces that.
  if (speed < CUT_IN_MS || speed > CUT_OUT_MS) return 0;
  return p.yMin + (p.yMax - p.yMin) / (1 + Math.exp(-p.k * (speed - p.v50)));
}

/**
 * Solar PV output as a fraction of nameplate.
 *
 * Linear in clear-sky index at a fixed instant, which is the useful statement:
 * the clear-sky reference is a deterministic function of time and site, so all
 * the weather uncertainty sits in the index while the geometry sits in the
 * reference. A clear-sky index of 1 at 07:00 and at 12:00 are entirely
 * different amounts of sunlight, and multiplying the two back together is what
 * keeps that straight.
 *
 * @param {number} csi clear-sky index (measured GHI / clear-sky GHI)
 * @param {number} clearSkyGhi W/m^2
 * @param {number} tempC ambient air temperature
 * @param {{gain:number,offset:number}} [p]
 */
export function solarFraction(csi, clearSkyGhi, tempC, p = DEFAULT_SOLAR_CURVE) {
  if (!Number.isFinite(csi) || !Number.isFinite(clearSkyGhi) || clearSkyGhi <= 0) return 0;
  const ghi = Math.max(0, csi) * clearSkyGhi;
  const cellC = (Number.isFinite(tempC) ? tempC : 25) + CELL_RISE_PER_WM2 * ghi;
  const derate = 1 - DERATE_PER_DEGC * Math.max(0, cellC - 25);
  return Math.max(0, (p.gain * ghi / REFERENCE_IRRADIANCE + p.offset) * derate);
}

/**
 * Feeds the forecast weather through the fitted curve for this station's
 * fueltech. Should dominate for solar, where the physics is almost the whole
 * story.
 */
export class Physical {
  constructor({ fueltech, params = null } = {}) {
    this.name = 'physical';
    this.fueltech = fueltech;
    this.params = params;
  }

  /** Install curve parameters once a fit exists; until then the default runs. */
  setParams(params) {
    this.params = params;
  }

  predict(state, h) {
    const cap = state.capacity_mw;
    const w = outlook(state, h);

    if (this.fueltech === 'wind') {
      return clip(cap * windFraction(w.wind_speed_100m, this.params || DEFAULT_WIND_CURVE), cap);
    }
    if (this.fueltech === 'solar_utility') {
      const f = solarFraction(
        w.clear_sky_index, w.clear_sky_ghi, w.temperature_2m,
        this.params || DEFAULT_SOLAR_CURVE,
      );
      return clip(cap * f, cap);
    }
    // A thermal or hydro station's output is a dispatch decision, not a weather
    // outcome. There is no curve to evaluate, so hold the last reading and let
    // the combiner discount this expert to the floor, which is the correct
    // answer rather than a failure.
    return clip(state.history.at(-1), cap);
  }

  // The curve is fitted offline over uncapped intervals only, because
  // curtailment severs the weather relationship the fit is trying to measure.
  update() {}
}

// ---------------------------------------------------------------------------
// 4. Online ridge / recursive least squares
// ---------------------------------------------------------------------------

const RLS_LAMBDA = 0.999;   // ~1000-sample memory, about three and a half days
const RLS_DELTA = 10;       // initial covariance: diffuse enough to move quickly
const RLS_MAX_TRACE = 1e6;

function lag(history, back, cap) {
  const v = history[Math.max(0, history.length - 1 - back)];
  return Number.isFinite(v) ? v / cap : 0;
}

/**
 * Design vector. Lagged output makes this an ARX model, which is what gives it
 * persistence's short-horizon strength; the weather terms are what let it beat
 * persistence further out.
 *
 * Fueltechs with no weather relationship get lags only. A feature that is
 * always zero is never excited, and an unexcited direction of the covariance
 * grows by 1/lambda every single step until it overflows.
 */
function features(state, h) {
  const cap = state.capacity_mw;
  const hist = state.history;
  const x = [1, lag(hist, 0, cap), lag(hist, 1, cap), lag(hist, 2, cap)];
  const w = outlook(state, h);

  if (state.fueltech === 'wind') {
    // Held inside the turbine's operating range before the cube: a stray
    // negative or 400 m/s from a bad forecast record would otherwise arrive as
    // a huge feature and shove the fitted weights somewhere they take days to
    // come back from.
    const raw = Number.isFinite(w.wind_speed_100m) ? w.wind_speed_100m : 0;
    const v = Math.min(Math.max(raw, 0), CUT_OUT_MS) / 15;
    // Power available in moving air goes as v^3. Handing the regression the
    // cube saves it trying to bend a straight line into that shape.
    x.push(v, v * v * v);
  } else if (state.fueltech === 'solar_utility') {
    const ghi = (Math.max(0, w.clear_sky_index || 0) * (w.clear_sky_ghi || 0)) / REFERENCE_IRRADIANCE;
    x.push(ghi, ghi * Math.max(0, (w.temperature_2m ?? 25) - 25) / 25);
  }
  return x;
}

/**
 * Recursive least squares with a forgetting factor: an ARX model that re-fits
 * itself every interval and quietly discards what the plant used to do.
 */
export class OnlineRidge {
  constructor({ lambda = RLS_LAMBDA } = {}) {
    this.name = 'ridge';
    this.lambda = lambda;
    this.w = null;
    this.P = null;
  }

  _init(m) {
    this.w = new Float64Array(m);
    this.P = new Float64Array(m * m);
    for (let i = 0; i < m; i++) this.P[i * m + i] = RLS_DELTA;
    this.m = m;
  }

  predict(state, h) {
    const x = features(state, h);
    if (!this.w) this._init(x.length);
    let y = 0;
    for (let i = 0; i < x.length; i++) y += this.w[i] * x[i];
    return clip(y * state.capacity_mw, state.capacity_mw);
  }

  update(state, actual) {
    const x = features(state, state.horizon_steps ?? 1);
    const m = x.length;
    if (!this.w) this._init(m);
    const P = this.P;

    const Px = new Float64Array(m);
    let xPx = 0;
    let yhat = 0;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += P[i * m + j] * x[j];
      Px[i] = s;
      xPx += x[i] * s;
      yhat += this.w[i] * x[i];
    }
    const denom = this.lambda + xPx;
    const err = actual / state.capacity_mw - yhat;

    for (let i = 0; i < m; i++) this.w[i] += (Px[i] / denom) * err;

    // P <- (P - Px Px' / denom) / lambda, written symmetrically. The two
    // triangles drift apart in floating point, and an asymmetric covariance is
    // exactly how RLS goes unstable after a few hundred thousand updates.
    for (let i = 0; i < m; i++) {
      for (let j = i; j < m; j++) {
        const v = (P[i * m + j] - (Px[i] * Px[j]) / denom) / this.lambda;
        P[i * m + j] = v;
        P[j * m + i] = v;
      }
    }

    // Forgetting inflates the covariance whenever the input stops exciting some
    // direction — a wind farm becalmed for a day, a solar farm overnight.
    // Bounding the trace turns an eventual blow-up into slightly slower
    // adaptation, which is the trade worth making.
    let trace = 0;
    for (let i = 0; i < m; i++) trace += P[i * m + i];
    if (trace > RLS_MAX_TRACE) {
      const s = RLS_MAX_TRACE / trace;
      for (let i = 0; i < P.length; i++) P[i] *= s;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Analogue (k-nearest-neighbour over past conditions)
// ---------------------------------------------------------------------------

const ANALOGUE_K = 25;
// About seventeen days of five-minute intervals. The library is scanned once
// per station per horizon per interval, so this is a scan-cost ceiling as much
// as a memory one; beyond a few thousand states the extra analogues are near
// duplicates of ones already held.
const LIBRARY_SIZE = 5000;

/**
 * The conditions vector analogues are matched on. Time of day belongs in it
 * alongside the weather: a clear-sky index of 1 at 07:00 and at 12:00 are
 * completely different amounts of sunlight, and for wind it carries the sea
 * breeze and the nocturnal jet. Current output is in there too, because what
 * the plant is already doing is part of the situation being matched.
 */
function conditionsVector(state, h) {
  const w = outlook(state, h);
  const angle = (todAt(state, h) * Math.PI) / 720;
  return [
    (Number.isFinite(w.wind_speed_100m) ? w.wind_speed_100m : 0) / 15,
    Number.isFinite(w.clear_sky_index) ? w.clear_sky_index : 0,
    ((Number.isFinite(w.temperature_2m) ? w.temperature_2m : 20) - 20) / 20,
    Math.sin(angle),
    Math.cos(angle),
    (state.history.at(-1) ?? 0) / state.capacity_mw,
  ];
}

/**
 * k-nearest-neighbour over past conditions, returning the inverse-distance
 * weighted mean of what actually followed them.
 *
 * The matched instants are kept and exposed by matches(), because the whole
 * point of an analogue forecast is that it can be explained: "conditions now
 * most resemble 14 March 15:20".
 */
export class Analogue {
  constructor() {
    this.name = 'analogue';
    this.lib = [];
    this.next = 0;
    this._matches = [];
  }

  /** The historical instants behind the most recent predict(), for the UI. */
  matches() {
    return this._matches;
  }

  predict(state, h) {
    const cap = state.capacity_mw;
    if (this.lib.length < ANALOGUE_K) {
      this._matches = [];
      return clip(state.history.at(-1), cap);
    }

    const q = conditionsVector(state, h);
    // Partial selection into a 25-slot list rather than sorting the library:
    // this runs for every station at every horizon at every one of 25,920
    // intervals in a 90-day replay.
    const best = [];
    let worst = Infinity;
    for (const rec of this.lib) {
      let d2 = 0;
      for (let i = 0; i < q.length; i++) {
        const d = q[i] - rec.vec[i];
        d2 += d * d;
        if (d2 >= worst) break;
      }
      if (d2 >= worst) continue;
      let pos = best.length;
      while (pos > 0 && best[pos - 1].d2 > d2) pos--;
      best.splice(pos, 0, { d2, rec });
      if (best.length > ANALOGUE_K) best.pop();
      if (best.length === ANALOGUE_K) worst = best[ANALOGUE_K - 1].d2;
    }

    let wsum = 0;
    let ysum = 0;
    const matches = [];
    for (const b of best) {
      const distance = Math.sqrt(b.d2);
      // The epsilon stops an exact repeat of a past state — common overnight,
      // when everything is zero — from taking the entire weight.
      const weight = 1 / (distance + 1e-3);
      wsum += weight;
      ysum += weight * b.rec.y;
      matches.push({ observed_at: b.rec.at, distance, weight, output_mw: b.rec.y });
    }
    for (const m of matches) m.weight /= wsum;
    this._matches = matches;
    return clip(ysum / wsum, cap);
  }

  update(state, actual) {
    const record = {
      at: state.observed_at,
      vec: conditionsVector(state, state.horizon_steps ?? 1),
      y: actual,
    };
    // Ring buffer: overwriting the oldest slot keeps the library bounded through
    // a 90-day replay without shifting a 5000-element array every interval.
    if (this.lib.length < LIBRARY_SIZE) {
      this.lib.push(record);
    } else {
      this.lib[this.next] = record;
      this.next = (this.next + 1) % LIBRARY_SIZE;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Ramp-aware persistence
// ---------------------------------------------------------------------------

const TREND_WINDOW = 6;   // 30 minutes of five-minute dispatch
const RAMP_TAU = 12;      // a ramp holds for about an hour before something gives

/** Least-squares slope in MW per interval over the last half hour. */
function trend(history) {
  const n = Math.min(history.length, TREND_WINDOW);
  if (n < 2) return 0;
  const start = history.length - n;
  const mid = (n - 1) / 2;
  let sty = 0;
  let stt = 0;
  for (let i = 0; i < n; i++) {
    const v = history[start + i];
    if (!Number.isFinite(v)) return 0;
    sty += (i - mid) * v;
    stt += (i - mid) * (i - mid);
  }
  return sty / stt;
}

/**
 * Persistence plus a damped trend. Exists to catch the ramps persistence walks
 * straight past — a front crossing a wind farm, cloud clearing off a solar
 * farm, a unit coming up on load.
 */
export class RampAware {
  constructor() {
    this.name = 'ramp';
  }

  predict(state, h) {
    // Extrapolating a half-hour trend linearly is right for a few intervals,
    // absurd for a day, and worthless beyond that — so the displacement is
    // slope*h at short horizons, peaks about an hour out, and decays back to
    // nothing. Collapsing to plain persistence at long range is the honest
    // answer: the last thirty minutes say nothing about tomorrow afternoon,
    // and climatology is in the bank to cover that end. Undamped, this expert
    // would ride every wiggle in the last half hour out to the horizon and be
    // beaten by persistence on anything that is not a genuine ramp.
    const reach = h * Math.exp(-h / RAMP_TAU);
    return clip(state.history.at(-1) + trend(state.history) * reach, state.capacity_mw);
  }

  update() {}
}

/**
 * The standard bank for a station, in the order the UI ribbon shows them.
 *
 * @param {{fueltech: string, curve?: object}} station
 * @returns {Array<{name: string, predict: Function, update: Function}>}
 */
export function buildExperts({ fueltech, curve = null }) {
  return [
    new Persistence(),
    new DiurnalClimatology(),
    new Physical({ fueltech, params: curve }),
    new OnlineRidge(),
    new Analogue(),
    new RampAware(),
  ];
}
