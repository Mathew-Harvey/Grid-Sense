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
// `tod_minutes` and `month` are NEM local, and NEM local is UTC+10 the whole
// year in every region — no daylight saving, ever. Derive them with
// nemDayParts() rather than from a Date's local accessors, which would shift
// every diurnal bucket by an hour for half the year on any machine set to
// Australian civil time and produce a climatology smeared across two buckets.
//
// `forecast[h-1]` must be a forecast for t+h *issued at or before t*. The
// weather harvester currently only holds observed archives, so the convenient
// thing to do in a replay — reading the archive at t+h and calling it the
// outlook — hands every weather-driven expert here the answer. The bank would
// then post a skill figure no operational system can reproduce, and nothing in
// this file can detect it. Persist the forecast that was actually issued, or
// degrade the archive to something a forecast could plausibly have said.
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
const NEM_OFFSET_MS = 10 * 3600_000;

/**
 * The NEM-local time-of-day and month a state should carry.
 *
 * @param {number} epochMs UTC epoch milliseconds
 * @returns {{tod_minutes: number, month: number}} month is 1-12
 */
export function nemDayParts(epochMs) {
  const d = new Date(epochMs + NEM_OFFSET_MS);
  return {
    tod_minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    month: d.getUTCMonth() + 1,
  };
}

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
  // An unknown nameplate offers no ceiling to clip against. Clamping at zero is
  // still right and is the whole of what can honestly be asserted.
  if (!(capacityMw > 0)) return mw;
  return mw > capacityMw ? capacityMw : mw;
}

/**
 * The nameplate to normalise by, or null when there is not a usable one.
 *
 * The registry carries `capacity_mw: null` for every station AEMO has not
 * published a registered capacity for — 271 of 700 today — and every learned
 * expert here divides by it. A null reaching that division writes NaN
 * into the fitted weights, the covariance and the analogue library, where it
 * stays for the rest of the run, and clip() then reports the wreckage as a
 * confident zero. So it has to be caught before the division, not after.
 */
function capacityOf(state) {
  const c = state.capacity_mw;
  return Number.isFinite(c) && c > 0 ? c : null;
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
    // A single NaN folded into a running mean stays in that cell forever.
    if (!Number.isFinite(actual)) return;
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
// tempCoeff is the fraction of output lost per degC of cell temperature above
// 25, which is the same quantity fitSolarCurve() estimates per station. There
// is deliberately no intercept: a panel in the dark makes nothing, and an
// offset term only ever buys a little training error at the cost of a
// physically impossible forecast at dawn.
export const DEFAULT_SOLAR_CURVE = { gain: 0.95, tempCoeff: 0.004 };

const CUT_IN_MS = 3;
const CUT_OUT_MS = 25;

const REFERENCE_IRRADIANCE = 1000;  // W/m^2, the condition a module is rated at
const CELL_RISE_PER_WM2 = 0.03;     // NOCT: roughly 30 degC above ambient at full sun

/**
 * Four-parameter logistic wind power curve, in fraction of nameplate.
 *
 * @param {number} speed m/s at hub height
 * @param {{yMin:number,yMax:number,k:number,v50:number,cutOut?:number}} [p]
 */
export function windFraction(speed, p = DEFAULT_WIND_CURVE) {
  if (!Number.isFinite(speed)) return 0;
  // Cut-in and cut-out are hard discontinuities, not gentle tails: below cut-in
  // there is not enough energy in the air to turn the rotor at all, and at
  // cut-out the machine feathers and stops to protect itself. A farm at full
  // output drops to zero within minutes when a front pushes it past cut-out,
  // and no smooth sigmoid reproduces that.
  const cutOut = Number.isFinite(p.cutOut) ? p.cutOut : CUT_OUT_MS;
  if (speed < CUT_IN_MS || speed > cutOut) return 0;
  const f = p.yMin + (p.yMax - p.yMin) / (1 + Math.exp(-p.k * (speed - p.v50)));
  // A malformed parameter set must not leak NaN into the combiner, where one
  // round of it takes an expert's weight out permanently.
  return Number.isFinite(f) ? f : 0;
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
 * @param {{gain:number,tempCoeff:number}} [p]
 */
export function solarFraction(csi, clearSkyGhi, tempC, p = DEFAULT_SOLAR_CURVE) {
  if (!Number.isFinite(csi) || !Number.isFinite(clearSkyGhi) || clearSkyGhi <= 0) return 0;
  const ghi = Math.max(0, csi) * clearSkyGhi;
  const cellC = (Number.isFinite(tempC) ? tempC : 25) + CELL_RISE_PER_WM2 * ghi;
  const tempCoeff = Number.isFinite(p.tempCoeff) ? p.tempCoeff : DEFAULT_SOLAR_CURVE.tempCoeff;
  const derate = 1 - tempCoeff * Math.max(0, cellC - 25);
  const f = (p.gain * ghi / REFERENCE_IRRADIANCE) * derate;
  return Number.isFinite(f) ? Math.max(0, f) : 0;
}

/**
 * Accept either bare curve parameters or a whole fit bundle from the offline
 * fitter, and refuse anything that would evaluate to NaN.
 *
 * fitWindCurve() nests its logistic under `.params` and fitSolarCurve() returns
 * `gain`/`tempCoeff` at the top level, so the two do not share a shape and
 * neither matches the bare parameter object these curves take. Handing either
 * one straight to windFraction()/solarFraction() reads undefined parameters,
 * produces NaN, and clip() turns that into a flat zero — a wind farm forecast
 * at nothing all season, with no error anywhere to notice. A failed fit is the
 * same trap by another route: it returns every field null while still looking
 * like a curve.
 *
 * @returns {object|null} null means "no usable fit", i.e. run the default
 */
function normaliseCurve(fueltech, curve) {
  if (!curve || typeof curve !== 'object') return null;
  if (curve.converged === false) return null;

  if (fueltech === 'wind') {
    const p = curve.params ?? curve;
    for (const k of ['yMin', 'yMax', 'k', 'v50']) if (!Number.isFinite(p[k])) return null;
    // The fitted cutIn is the 1% point of a logistic, which lands anywhere from
    // below zero to a couple of m/s and is not a cut-in speed; the fitted
    // cutOut is read off an observed collapse in output and is real, so only
    // that one is carried through.
    const cutOut = Number.isFinite(curve.cutOut) ? curve.cutOut : p.cutOut;
    return { yMin: p.yMin, yMax: p.yMax, k: p.k, v50: p.v50, cutOut };
  }

  if (fueltech === 'solar_utility') {
    const p = curve.params ?? curve;
    if (!Number.isFinite(p.gain)) return null;
    return {
      gain: p.gain,
      tempCoeff: Number.isFinite(p.tempCoeff) ? p.tempCoeff : DEFAULT_SOLAR_CURVE.tempCoeff,
    };
  }

  return null;
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
    this.params = normaliseCurve(fueltech, params);
  }

  /** Install curve parameters once a fit exists; until then the default runs. */
  setParams(params) {
    this.params = normaliseCurve(this.fueltech, params);
  }

  predict(state, h) {
    const cap = capacityOf(state);
    const w = outlook(state, h);

    // Both curves are fractions of nameplate, so without a nameplate there is
    // nothing to scale them by and this expert has nothing to say.
    if (cap !== null && this.fueltech === 'wind') {
      return clip(cap * windFraction(w.wind_speed_100m, this.params || DEFAULT_WIND_CURVE), cap);
    }
    if (cap !== null && this.fueltech === 'solar_utility') {
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
    return clip(state.history.at(-1), state.capacity_mw);
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
function features(state, h, cap, into) {
  const hist = state.history;
  const x = into;
  x.length = 0;
  x.push(1, lag(hist, 0, cap), lag(hist, 1, cap), lag(hist, 2, cap));
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
    // Scratch reused across calls. This runs once per station per horizon per
    // dispatch interval — of the order of ten million times in a 90-day replay
    // over sixty stations — and a fresh feature array and Px vector each time
    // is a garbage collector pause every few seconds for no gain.
    this._x = [];
    this._Px = null;
  }

  _init(m) {
    this.w = new Float64Array(m);
    this.P = new Float64Array(m * m);
    for (let i = 0; i < m; i++) this.P[i * m + i] = RLS_DELTA;
    this._Px = new Float64Array(m);
    this.m = m;
  }

  predict(state, h) {
    const cap = capacityOf(state);
    // Every coefficient is fitted against output over nameplate, so an unknown
    // nameplate leaves nothing to scale the answer back up by.
    if (cap === null) return clip(state.history.at(-1), state.capacity_mw);
    const x = features(state, h, cap, this._x);
    if (!this.w) this._init(x.length);
    let y = 0;
    for (let i = 0; i < x.length; i++) y += this.w[i] * x[i];
    return clip(y * cap, cap);
  }

  update(state, actual) {
    const cap = capacityOf(state);
    // Dividing by a null nameplate puts NaN into w and P, and RLS has no path
    // back out of that: every later update multiplies the NaN forward. Sitting
    // the round out costs one sample.
    if (cap === null || !Number.isFinite(actual)) return;
    const x = features(state, state.horizon_steps ?? 1, cap, this._x);
    const m = x.length;
    // The design vector's width is set by fueltech and never moves for a given
    // station. If it ever did, w, P and the Px scratch would be sized for the
    // old one and every index below would read across rows; starting the fit
    // again is the only coherent response.
    if (!this.w || m !== this.m) this._init(m);
    const P = this.P;

    const Px = this._Px;
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
    const err = actual / cap - yhat;

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
const CONDITIONS_DIM = 6;

/** Writes the conditions vector into out at offset, and allocates nothing:
 *  this runs hundreds of times per dispatch interval. */
function conditionsVectorInto(out, offset, state, h, cap) {
  const w = outlook(state, h);
  const angle = (todAt(state, h) * Math.PI) / 720;
  const last = state.history.at(-1);
  out[offset] = (Number.isFinite(w.wind_speed_100m) ? w.wind_speed_100m : 0) / 15;
  out[offset + 1] = Number.isFinite(w.clear_sky_index) ? w.clear_sky_index : 0;
  out[offset + 2] = ((Number.isFinite(w.temperature_2m) ? w.temperature_2m : 20) - 20) / 20;
  out[offset + 3] = Math.sin(angle);
  out[offset + 4] = Math.cos(angle);
  out[offset + 5] = (Number.isFinite(last) ? last : 0) / cap;
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
    // One flat buffer instead of five thousand small objects. The scan is the
    // hottest loop in the entire system — every station, every horizon, every
    // interval — and pointer-chasing per record costs more than the arithmetic.
    this.vecs = new Float64Array(LIBRARY_SIZE * CONDITIONS_DIM);
    this.ys = new Float64Array(LIBRARY_SIZE);
    this.ats = new Float64Array(LIBRARY_SIZE);
    this.n = 0;
    this.next = 0;
    this._q = new Float64Array(CONDITIONS_DIM);
    this._bestD2 = new Float64Array(ANALOGUE_K);
    this._bestIdx = new Int32Array(ANALOGUE_K);
    this._bestCount = 0;
  }

  /**
   * The historical instants behind the most recent predict(), for the UI.
   *
   * Materialised on demand rather than during predict: the objects are only
   * ever read for the one station a person is looking at, and building them
   * for the whole fleet at every interval is pure allocation churn.
   */
  matches() {
    const count = this._bestCount;
    if (count === 0) return [];
    const out = new Array(count);
    let wsum = 0;
    for (let i = 0; i < count; i++) {
      const distance = Math.sqrt(this._bestD2[i]);
      const weight = 1 / (distance + 1e-3);
      wsum += weight;
      const idx = this._bestIdx[i];
      out[i] = { observed_at: this.ats[idx], distance, weight, output_mw: this.ys[idx] };
    }
    for (const m of out) m.weight /= wsum;
    return out;
  }

  /**
   * Just the nearest neighbour from the most recent predict(). Cheap enough to
   * capture for the whole fleet every interval, where materialising the full
   * neighbourhood is not.
   */
  bestMatch() {
    if (this._bestCount === 0) return null;
    const idx = this._bestIdx[0];
    return {
      observed_at: this.ats[idx],
      output_mw: this.ys[idx],
      distance: Math.sqrt(this._bestD2[0]),
    };
  }

  predict(state, h) {
    const cap = capacityOf(state);
    // The last component of the conditions vector is output over nameplate; a
    // null nameplate makes the whole query NaN, every distance NaN, and the
    // weighted mean NaN, which clip() then serves as a confident zero.
    if (cap === null || this.n < ANALOGUE_K) {
      this._bestCount = 0;
      return clip(state.history.at(-1), state.capacity_mw);
    }

    conditionsVectorInto(this._q, 0, state, h, cap);
    const q0 = this._q[0], q1 = this._q[1], q2 = this._q[2];
    const q3 = this._q[3], q4 = this._q[4], q5 = this._q[5];
    const vecs = this.vecs;
    const bestD2 = this._bestD2;
    const bestIdx = this._bestIdx;
    let count = 0;
    let worst = Infinity;

    // Full six-component distance with no per-component branch: at this
    // dimension the early-exit test costs more than the multiplies it skips,
    // and a branch-free body is what lets the JIT keep the loop tight.
    for (let r = 0, o = 0; r < this.n; r++, o += CONDITIONS_DIM) {
      const d0 = q0 - vecs[o];
      const d1 = q1 - vecs[o + 1];
      const d2c = q2 - vecs[o + 2];
      const d3 = q3 - vecs[o + 3];
      const d4 = q4 - vecs[o + 4];
      const d5 = q5 - vecs[o + 5];
      const d2 = d0 * d0 + d1 * d1 + d2c * d2c + d3 * d3 + d4 * d4 + d5 * d5;
      if (d2 >= worst) continue;

      let pos = count < ANALOGUE_K ? count : ANALOGUE_K - 1;
      while (pos > 0 && bestD2[pos - 1] > d2) {
        bestD2[pos] = bestD2[pos - 1];
        bestIdx[pos] = bestIdx[pos - 1];
        pos--;
      }
      bestD2[pos] = d2;
      bestIdx[pos] = r;
      if (count < ANALOGUE_K) count++;
      if (count === ANALOGUE_K) worst = bestD2[ANALOGUE_K - 1];
    }
    this._bestCount = count;

    let wsum = 0;
    let ysum = 0;
    for (let i = 0; i < count; i++) {
      const weight = 1 / (Math.sqrt(bestD2[i]) + 1e-3);
      wsum += weight;
      ysum += weight * this.ys[bestIdx[i]];
    }
    return clip(ysum / wsum, cap);
  }

  update(state, actual) {
    const cap = capacityOf(state);
    // A NaN vector in the library is permanent: it never compares far enough
    // away to be rejected, so it wins a slot in every later neighbourhood.
    if (cap === null || !Number.isFinite(actual)) return;
    const slot = this.n < LIBRARY_SIZE ? this.n : this.next;
    conditionsVectorInto(this.vecs, slot * CONDITIONS_DIM, state, this.horizonForUpdate(state), cap);
    this.ys[slot] = actual;
    this.ats[slot] = state.observed_at;
    if (this.n < LIBRARY_SIZE) {
      this.n++;
    } else {
      this.next = (this.next + 1) % LIBRARY_SIZE;
    }
  }

  horizonForUpdate(state) {
    return state.horizon_steps ?? 1;
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
