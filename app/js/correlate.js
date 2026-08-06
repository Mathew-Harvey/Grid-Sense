// How hard does each station's output actually track the weather, and how far
// behind?
//
// One rule governs the whole file: an interval is only looked at if
// `capped === false` and `quality === 'ok'`. A semi-scheduled farm under a
// constraint is producing what the market told it to, not what the air handed
// it, so correlating its output against wind speed measures the constraint.
// Every number downstream — the fitted curve, the expert weights, the skill
// score — inherits that contamination and nothing about it looks wrong.
//
// The strict `=== false` matters. Curtailment is only known once the next-day
// unit-solution file lands, so a live interval carries an unknown mask, and an
// unknown mask must not be read as "not curtailed".
//
// Timestamps are already resolved to the true instant of each value by the time
// an observation reaches here, so nothing in this file shifts them. If ingest
// ever gets that wrong, the lag curve says so out loud: a wind farm whose peak
// cross-correlation sits at exactly one step is not showing you a weather
// signal, it is showing you a mis-stamped interval.

const MS_PER_STEP = 300_000;
const MINUTES_PER_STEP = 5;

// Plus or minus six hours. Enough to watch a front cross the site and still
// resolve the half-hour lags that actually turn up in the data.
const DEFAULT_MAX_LAG_STEPS = 72;

// How much the lag profile must vary between its best and worst lag before the
// best one counts as a real peak. Well above floating-point noise (~1e-15) and
// well below any correlation structure a real front produces.
const PEAK_MIN_PROMINENCE = 1e-4;

// Weather arrives hourly and dispatch is five-minutely. Holding each reading
// flat until the next one puts a 60-minute staircase into the series, and the
// lag curve then reports the staircase rather than the weather.
const MAX_WEATHER_GAP_MS = 2 * 3600_000;

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * Pearson correlation of x[i] against y[i + shift], over the overlap only.
 *
 * Two passes rather than the sum-of-squares shortcut. A coal unit sits at
 * 700 +/- 2 MW, where E[x^2] - E[x]^2 cancels away five significant figures and
 * can return a negative variance; the mean-first form does not care.
 *
 * Pairs where either side is non-finite are skipped rather than treated as
 * zero — masked intervals are holes in the series, and a hole is not an
 * observation of no wind.
 */
function pearsonShifted(x, y, shift) {
  const lo = Math.max(0, -shift);
  const hi = Math.min(x.length, y.length - shift);

  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = lo; i < hi; i++) {
    const a = x[i];
    const b = y[i + shift];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    n++;
    sx += a;
    sy += b;
  }
  if (n < 3) return 0;

  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = lo; i < hi; i++) {
    const a = x[i];
    const b = y[i + shift];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const dx = a - mx;
    const dy = b - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  // A becalmed night gives a constant series, and a constant has no direction to
  // correlate with. Zero is the answer; NaN would poison every mean taken over
  // the station panel afterwards.
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/**
 * Pearson correlation coefficient.
 *
 * Fast and universally understood, and the wrong headline for wind: a power
 * curve is S-shaped, so a farm can track the wind perfectly and still show
 * r = 0.85. Report it next to Spearman, never instead of it.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @returns {number} r in [-1, 1], 0 when either side is constant
 */
export function pearson(x, y) {
  return pearsonShifted(x, y, 0);
}

/**
 * Ranks with ties averaged over the positions they jointly occupy.
 *
 * Breaking ties by array order would invent an ordering the data does not
 * contain, and this data is full of genuine ties: every station reads exactly
 * zero all night, and a curtailed fleet holds identical values for hours.
 */
function averageRanks(v) {
  const order = Array.from(v, (_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Float64Array(v.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && v[order[j + 1]] === v[order[i]]) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]] = shared;
    i = j + 1;
  }
  return r;
}

/**
 * Spearman rank correlation.
 *
 * The headline number for wind. It measures whether output rises with the wind
 * at all, not whether it does so in a straight line, so it is not penalised for
 * the curvature that is the whole shape of a turbine's response.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @returns {number} rho in [-1, 1], 0 when either side is constant
 */
export function spearman(x, y) {
  // Ranked over the complete pairs only. Ranking each series in full and then
  // dropping the holes leaves two rank vectors drawn from different populations.
  const xs = [];
  const ys = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    xs.push(x[i]);
    ys.push(y[i]);
  }
  if (xs.length < 3) return 0;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/**
 * Correlation of weather at t against output at t + k, for k across +/- maxLagSteps.
 *
 * A positive peak lag means the weather leads: the front reaches the anemometer
 * before it reaches the turbines, or the reanalysis grid cell sits upwind of the
 * site. Read against a map it is a physically real number, and it is the single
 * most interesting thing this module produces.
 *
 * The peak is taken on absolute correlation, because a variable can lead with
 * either sign — temperature against solar output runs negative.
 *
 * Not every profile has a peak worth reporting. Against a smooth monotone
 * driver every lag correlates almost identically — a straight ramp gives 1.0 at
 * all 145 lags with a spread of 3e-15 — and the argmax is then chosen by
 * floating-point noise. Annotating that on a chart presents rounding error as a
 * physical travel time, so a profile flatter than PEAK_MIN_PROMINENCE reports
 * no peak at all rather than an arbitrary one.
 *
 * @param {ArrayLike<number>} weather on a contiguous 5-minute grid, holes as NaN
 * @param {ArrayLike<number>} output same grid, same length
 * @param {number} [maxLagSteps=72]
 * @returns {{lags: number[], values: number[], peakLag: number|null, prominence: number}}
 */
export function laggedCrossCorrelation(weather, output, maxLagSteps = DEFAULT_MAX_LAG_STEPS) {
  const lags = [];
  const values = [];
  let peakLag = 0;
  let peak = -1;
  let lo = Infinity;

  for (let k = -maxLagSteps; k <= maxLagSteps; k++) {
    const r = pearsonShifted(weather, output, k);
    lags.push(k);
    values.push(r);
    const a = Math.abs(r);
    if (Number.isFinite(a)) {
      if (a > peak) { peak = a; peakLag = k; }
      if (a < lo) lo = a;
    }
  }

  const prominence = Number.isFinite(peak) && Number.isFinite(lo) ? peak - lo : 0;

  // An argmax sitting on the edge of the search window is not a peak, it is the
  // correlation still climbing when the window ran out. Thermal stations do this
  // constantly: their output tracks demand, demand tracks the season, and the
  // profile drifts monotonically across the whole six hours to land on exactly
  // +/-360 minutes. Reporting that as a travel time would be nonsense — no
  // weather signal reaches a turbine six hours later — so an edge result is
  // reported as no peak.
  const onEdge = Math.abs(peakLag) === maxLagSteps;
  const identifiable = prominence >= PEAK_MIN_PROMINENCE && !onEdge;

  return {
    lags,
    values,
    peakLag: identifiable ? peakLag : null,
    prominence,
  };
}

/**
 * Mutual information between two series, binned estimator, in bits.
 *
 * Both correlations are blind to a fold in the relationship, and a wind farm has
 * one: above cut-out the machine feathers and produces nothing, so 30 m/s and
 * 0 m/s look identical from the output side. MI sees it — it asks only how much
 * knowing the wind narrows the output, not which direction it moves.
 *
 * The plug-in estimator is biased upward, and the bias grows with the bin count
 * and shrinks with sample size. So MI is comparable between variables measured
 * over the same intervals and is not comparable against another station's.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {number} [bins=20]
 * @returns {number} bits
 */
export function mutualInformation(x, y, bins = 20) {
  const xs = [];
  const ys = [];
  const len = Math.min(x.length, y.length);
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    xs.push(x[i]);
    ys.push(y[i]);
  }
  const n = xs.length;
  if (n < 3) return 0;

  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  if (xHi === xLo || yHi === yLo) return 0;

  const joint = new Float64Array(bins * bins);
  const px = new Float64Array(bins);
  const py = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    const bx = Math.min(bins - 1, Math.floor(((xs[i] - xLo) / (xHi - xLo)) * bins));
    const by = Math.min(bins - 1, Math.floor(((ys[i] - yLo) / (yHi - yLo)) * bins));
    joint[bx * bins + by]++;
    px[bx]++;
    py[by]++;
  }

  let mi = 0;
  for (let bx = 0; bx < bins; bx++) {
    if (px[bx] === 0) continue;
    for (let by = 0; by < bins; by++) {
      const c = joint[bx * bins + by];
      if (c === 0) continue;
      mi += (c / n) * Math.log2((c * n) / (px[bx] * py[by]));
    }
  }
  return mi;
}

// ---------------------------------------------------------------------------
// Nelder-Mead
// ---------------------------------------------------------------------------

const NM_MAX_ITER = 800;
const NM_TOL = 1e-10;

/**
 * Downhill simplex. Derivative-free, which suits a loss that is deliberately
 * non-smooth: the robust penalty has a kink at every point where a residual
 * crosses the outlier threshold, and a gradient method spends its time there.
 */
function nelderMead(cost, start, steps) {
  const n = start.length;
  let simplex = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i] += steps[i];
    simplex.push(p);
  }
  let f = simplex.map(cost);
  let converged = false;

  for (let iter = 0; iter < NM_MAX_ITER; iter++) {
    const order = Array.from(f, (_, i) => i).sort((a, b) => f[a] - f[b]);
    simplex = order.map((i) => simplex[i]);
    f = order.map((i) => f[i]);

    if (Math.abs(f[n] - f[0]) <= NM_TOL * (Math.abs(f[0]) + NM_TOL)) {
      converged = true;
      break;
    }

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < n; d++) centroid[d] += simplex[i][d] / n;
    }
    const along = (coeff) => centroid.map((c, d) => c + coeff * (c - simplex[n][d]));

    const xr = along(1);
    const fr = cost(xr);

    if (fr < f[0]) {
      const xe = along(2);
      const fe = cost(xe);
      simplex[n] = fe < fr ? xe : xr;
      f[n] = Math.min(fe, fr);
      continue;
    }
    if (fr < f[n - 1]) {
      simplex[n] = xr;
      f[n] = fr;
      continue;
    }

    const xc = along(fr < f[n] ? 0.5 : -0.5);
    const fc = cost(xc);
    if (fc < Math.min(fr, f[n])) {
      simplex[n] = xc;
      f[n] = fc;
      continue;
    }

    for (let i = 1; i <= n; i++) {
      simplex[i] = simplex[i].map((v, d) => simplex[0][d] + 0.5 * (v - simplex[0][d]));
      f[i] = cost(simplex[i]);
    }
  }

  let best = 0;
  for (let i = 1; i <= n; i++) if (f[i] < f[best]) best = i;
  return { x: simplex[best], f: f[best], converged };
}

/**
 * Two runs, the second rebuilt around the first's answer.
 *
 * A simplex that has flattened against a narrow valley stops making progress
 * long before it has found the floor of it, and reports convergence anyway.
 * Rebuilding it at full size from the best point is the standard cure and costs
 * one more run.
 */
function nelderMeadRestart(cost, start, steps) {
  const first = nelderMead(cost, start, steps);
  const second = nelderMead(cost, first.x, steps);
  return second.f <= first.f ? second : first;
}

// ---------------------------------------------------------------------------
// Wind power curve
// ---------------------------------------------------------------------------

// Below this there is nothing to fit: k and v50 are only identifiable if the
// station has been seen both idle and at rated.
const MIN_CURVE_POINTS = 100;

// Turbulence puts several percent of nameplate of genuine scatter on a
// five-minute point, so the quadratic region has to be wide enough to hold it.
// Past that a tripped unit or a telemetry spike gets bounded influence instead
// of squared influence.
const HUBER_DELTA = 0.08;

const CUTOUT_MIN_POINTS = 8;

// Parameters are carried as a fraction of nameplate so one set of bounds serves
// a 40 MW farm and a 1300 MW one.
const PARAM_BOUNDS = [
  [-0.05, 0.20],  // yMin: a farm with house load reads slightly negative when idle
  [0.20, 1.15],   // yMax: registered capacity is a nominal figure, not a ceiling
  [0.10, 3.00],   // k: steepness
  [1.0, 30.0],    // v50
];

function logisticFraction(p, v) {
  return p[0] + (p[1] - p[0]) / (1 + Math.exp(-p[2] * (v - p[3])));
}

function huber(residual) {
  const a = Math.abs(residual);
  return a <= HUBER_DELTA ? 0.5 * residual * residual : HUBER_DELTA * (a - 0.5 * HUBER_DELTA);
}

/**
 * Where the machine feathers.
 *
 * Found as the split in the high-wind data that best separates "still at rated"
 * below from "shut down" above, rather than by looking for zeros: a station has
 * plenty of zeros for reasons that are not cut-out, and all of them sit at low
 * wind. Returns null when the site simply never blew that hard, which is the
 * common case and is not a failure.
 */
function detectCutOut(speeds, outputs, ratedOutput) {
  const atRated = [];
  for (let i = 0; i < speeds.length; i++) {
    if (outputs[i] >= 0.9 * ratedOutput) atRated.push(speeds[i]);
  }
  if (atRated.length < CUTOUT_MIN_POINTS) return null;
  atRated.sort((a, b) => a - b);

  // Anchor above the ramp, so a low-wind zero can never be mistaken for a
  // feathered turbine.
  const anchor = atRated[Math.floor(atRated.length / 2)];
  const high = [];
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i] > anchor) high.push({ v: speeds[i], y: outputs[i] });
  }
  if (high.length < 2 * CUTOUT_MIN_POINTS) return null;
  high.sort((a, b) => a.v - b.v);

  const producing = 0.5 * ratedOutput;
  const feathered = 0.05 * ratedOutput;
  const featheredAbove = new Int32Array(high.length + 1);
  for (let i = high.length - 1; i >= 0; i--) {
    featheredAbove[i] = featheredAbove[i + 1] + (high[i].y <= feathered ? 1 : 0);
  }

  let bestScore = -1;
  let bestSplit = -1;
  let producingBelow = 0;
  for (let i = 1; i < high.length; i++) {
    producingBelow += high[i - 1].y >= producing ? 1 : 0;
    const score = producingBelow + featheredAbove[i];
    if (score > bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  // A handful of shut-down points is an outage, not a cut-out; and a split that
  // leaves a third of the high-wind data on the wrong side is not a split.
  if (high.length - bestSplit < CUTOUT_MIN_POINTS) return null;
  if (bestScore / high.length < 0.9) return null;
  return (high[bestSplit - 1].v + high[bestSplit].v) / 2;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Fit a four-parameter logistic power curve and read the turbine's own language
 * off it.
 *
 * Cut-in, rated speed, rated output and cut-out are worth more than any
 * correlation coefficient, because they can be laid straight against the
 * manufacturer's curve: a fitted rated output 15% under nameplate is a wake
 * loss or a unit that has not returned from outage, and no r value tells you
 * that.
 *
 * Cut-in and rated speed are read as the 1% and 99% points of the fitted curve,
 * which is the convention the nameplate figures follow.
 *
 * @param {ArrayLike<number>} speeds m/s at hub height
 * @param {ArrayLike<number>} outputs MW, from uncapped intervals only
 * @param {number} capacityMw registered capacity
 * @returns {{converged: boolean, reason?: string, cutIn: number|null, rated: number|null,
 *            ratedOutput: number|null, cutOut: number|null, rmse: number|null,
 *            params: object|null, n: number, predict: ((v:number)=>number)|null}}
 *          On failure every field including `predict` is null, so a caller that
 *          skips the `converged` check fails loudly rather than on a silent
 *          default curve.
 */
export function fitWindCurve(speeds, outputs, capacityMw) {
  const v = [];
  const y = [];
  for (let i = 0; i < speeds.length; i++) {
    if (!Number.isFinite(speeds[i]) || !Number.isFinite(outputs[i])) continue;
    v.push(speeds[i]);
    y.push(outputs[i]);
  }

  const fail = (reason) => ({
    converged: false, reason,
    cutIn: null, rated: null, ratedOutput: null, cutOut: null,
    rmse: null, params: null, n: v.length, predict: null,
  });

  if (v.length < MIN_CURVE_POINTS) return fail('too few uncapped intervals to fit');

  const sortedY = [...y].sort((a, b) => a - b);
  const observedRated = quantile(sortedY, 0.98);
  // A station that never got above a fifth of nameplate, or never came off it,
  // has not shown the transition the curve is made of. Fitting anyway returns
  // four confident numbers describing a straight line.
  if (observedRated < 0.2 * capacityMw) return fail('station never approached rated output');
  if (quantile(sortedY, 0.05) > 0.5 * observedRated) return fail('station never came off rated output');

  const cutOut = detectCutOut(v, y, observedRated);

  // Feathered intervals are physically outside the curve, not points on it, and
  // leaving them in drags the plateau down by however often the wind blew hard.
  const fitV = [];
  const fitY = [];
  for (let i = 0; i < v.length; i++) {
    if (cutOut !== null && v[i] >= cutOut) continue;
    fitV.push(v[i]);
    fitY.push(y[i] / capacityMw);
  }
  if (fitV.length < MIN_CURVE_POINTS) return fail('too few uncapped intervals below cut-out');

  const midSpeeds = [];
  for (let i = 0; i < fitV.length; i++) {
    const f = fitY[i];
    if (f > 0.35 && f < 0.65) midSpeeds.push(fitV[i]);
  }
  midSpeeds.sort((a, b) => a - b);
  const v50Start = midSpeeds.length >= 5
    ? midSpeeds[Math.floor(midSpeeds.length / 2)]
    : quantile([...fitV].sort((a, b) => a - b), 0.5);

  const start = [0, observedRated / capacityMw, 0.6, v50Start];
  const stepSizes = [0.02, 0.08, 0.25, 1.5];

  const cost = (p) => {
    // Bounds are held by pulling the cost up outside them rather than by
    // rejecting the point: an infinite wall collapses the simplex against it.
    let penalty = 0;
    const q = new Array(4);
    for (let i = 0; i < 4; i++) {
      q[i] = Math.min(PARAM_BOUNDS[i][1], Math.max(PARAM_BOUNDS[i][0], p[i]));
      const d = p[i] - q[i];
      penalty += d * d;
    }
    let sum = 0;
    for (let i = 0; i < fitV.length; i++) sum += huber(fitY[i] - logisticFraction(q, fitV[i]));
    return sum / fitV.length + 1e3 * penalty;
  };

  const fit = nelderMeadRestart(cost, start, stepSizes);
  if (!fit.converged || !Number.isFinite(fit.f)) return fail('optimiser did not converge');

  const p = fit.x.map((value, i) =>
    Math.min(PARAM_BOUNDS[i][1], Math.max(PARAM_BOUNDS[i][0], value)));
  const params = { yMin: p[0], yMax: p[1], k: p[2], v50: p[3] };

  // Speed at which the logistic reaches a given fraction of its own span.
  const speedAt = (frac) => params.v50 + Math.log(frac / (1 - frac)) / params.k;

  const predict = (speed) => {
    if (!Number.isFinite(speed)) return 0;
    // Cut-out is a cliff, not a tail. A farm at full output is at zero within
    // minutes of the wind crossing it, and no sigmoid does that.
    if (cutOut !== null && speed >= cutOut) return 0;
    return Math.max(0, Math.min(capacityMw, capacityMw * logisticFraction(p, speed)));
  };

  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    const d = y[i] - predict(v[i]);
    sq += d * d;
  }

  return {
    converged: true,
    cutIn: speedAt(0.01),
    rated: speedAt(0.99),
    ratedOutput: params.yMax * capacityMw,
    cutOut,
    rmse: Math.sqrt(sq / v.length),
    params,
    n: v.length,
    predict,
  };
}

// ---------------------------------------------------------------------------
// Solar curve
// ---------------------------------------------------------------------------

const REFERENCE_IRRADIANCE = 1000;  // W/m^2, the condition a module is rated at
const CELL_RISE_PER_WM2 = 0.03;     // NOCT: roughly 30 degC above ambient at full sun

/**
 * Fit output against irradiance with a temperature derate.
 *
 * Solar needs no optimiser. The physical model is
 *
 *   y / capacity = gain * suns * (1 - tempCoeff * excessCellTemp)
 *
 * which is bilinear, so fitting `gain` and `gain * tempCoeff` as a pair of
 * linear coefficients solves it exactly in one 2x2 system. An iterative fit here
 * would be slower, less accurate, and able to fail.
 *
 * The clear-sky index and the clear-sky reference are kept apart rather than
 * multiplied out beforehand, because an index of 1 at 07:00 and at noon are
 * entirely different amounts of sunlight and only the product is irradiance.
 *
 * @param {ArrayLike<number>} clearSkyIndex measured GHI / clear-sky GHI
 * @param {ArrayLike<number>} ghi clear-sky GHI reference, W/m^2
 * @param {ArrayLike<number>} tempC ambient air temperature
 * @param {ArrayLike<number>} outputs MW, from uncapped intervals only
 * @param {number} capacityMw
 * @returns {{converged: boolean, reason?: string, gain: number|null, tempCoeff: number|null,
 *            rmse: number|null, n: number,
 *            predict: ((csi:number, ghi:number, tempC:number)=>number)|null}}
 */
export function fitSolarCurve(clearSkyIndex, ghi, tempC, outputs, capacityMw) {
  const suns = [];
  const excess = [];
  const frac = [];
  for (let i = 0; i < outputs.length; i++) {
    const csi = clearSkyIndex[i];
    const ref = ghi[i];
    const y = outputs[i];
    if (!Number.isFinite(csi) || !Number.isFinite(ref) || !Number.isFinite(y)) continue;
    // Night contributes nothing but a pile of (0, 0) points, which drag the
    // fitted gain towards the origin's slope rather than the array's.
    if (ref <= 0) continue;
    const irradiance = Math.max(0, csi) * ref;
    const cellC = (Number.isFinite(tempC[i]) ? tempC[i] : 25) + CELL_RISE_PER_WM2 * irradiance;
    suns.push(irradiance / REFERENCE_IRRADIANCE);
    excess.push(Math.max(0, cellC - 25));
    frac.push(y / capacityMw);
  }

  const fail = (reason) => ({
    converged: false, reason, gain: null, tempCoeff: null, rmse: null, n: suns.length, predict: null,
  });
  if (suns.length < MIN_CURVE_POINTS) return fail('too few uncapped daylight intervals to fit');

  // Design columns: a = suns, b = suns * excessCellTemp. Coefficients are
  // (gain, gain * tempCoeff), which is what makes the system linear.
  let aa = 0;
  let ab = 0;
  let bb = 0;
  let ay = 0;
  let by = 0;
  for (let i = 0; i < suns.length; i++) {
    const a = suns[i];
    const b = suns[i] * excess[i];
    aa += a * a;
    ab += a * b;
    bb += b * b;
    ay += a * frac[i];
    by += b * frac[i];
  }
  if (aa === 0) return fail('no irradiance in the fitted intervals');

  const det = aa * bb - ab * ab;
  let gain;
  let tempCoeff;
  // A site that never gets hot has no temperature column to speak of, and the
  // system is singular in that direction. Dropping the derate term is the honest
  // answer; solving it anyway invents a coefficient out of rounding error.
  if (Math.abs(det) < 1e-12 * aa * bb || bb === 0) {
    gain = ay / aa;
    tempCoeff = 0;
  } else {
    gain = (ay * bb - by * ab) / det;
    tempCoeff = gain === 0 ? 0 : ((by * aa - ay * ab) / det) / -gain;
  }

  const predict = (csi, ref, ambientC) => {
    if (!Number.isFinite(csi) || !Number.isFinite(ref) || ref <= 0) return 0;
    const irradiance = Math.max(0, csi) * ref;
    const cellC = (Number.isFinite(ambientC) ? ambientC : 25) + CELL_RISE_PER_WM2 * irradiance;
    const mw = capacityMw * gain * (irradiance / REFERENCE_IRRADIANCE)
      * (1 - tempCoeff * Math.max(0, cellC - 25));
    return Math.max(0, Math.min(capacityMw, mw));
  };

  let sq = 0;
  for (let i = 0; i < suns.length; i++) {
    const modelled = capacityMw * gain * suns[i] * (1 - tempCoeff * excess[i]);
    const d = frac[i] * capacityMw - Math.max(0, Math.min(capacityMw, modelled));
    sq += d * d;
  }

  return {
    converged: true,
    gain,
    tempCoeff,
    rmse: Math.sqrt(sq / suns.length),
    n: suns.length,
    predict,
  };
}

// ---------------------------------------------------------------------------
// Per-station bundle
// ---------------------------------------------------------------------------

const WEATHER_DRIVEN = new Set(['wind', 'solar_utility']);
const BATTERY = new Set(['battery_charging', 'battery_discharging']);

/**
 * Which series a station's weather relationship should be measured against.
 *
 * For wind and solar it is UIGF: the output AEMO's own forecast says the plant
 * could have produced, which is a weather quantity uncontaminated by whatever
 * the market did with it. Actual output is a dispatch decision for everything
 * else, and there is no cleaner alternative to offer.
 */
function chooseTarget(observations, fueltech) {
  if (!WEATHER_DRIVEN.has(fueltech)) return 'output_mw';
  // UIGF is published in the next-day unit solution, so intervals ingested live
  // do not have it yet. Falling back keeps the panel populated in live mode, and
  // the bundle reports which series it actually used.
  let withUigf = 0;
  for (const o of observations) if (Number.isFinite(o.uigf_mw)) withUigf++;
  return withUigf >= observations.length / 2 ? 'uigf_mw' : 'output_mw';
}

/**
 * Weather onto the dispatch grid by linear interpolation between readings.
 *
 * Interpolated rather than held, because a held hourly reading is a staircase
 * and the lag curve would report the staircase's period as a weather lead.
 */
function interpolateWeather(weather, variables, t0, steps) {
  const series = {};
  for (const name of variables) series[name] = new Float64Array(steps).fill(NaN);

  const w = [...weather].sort((a, b) => a.observed_at - b.observed_at);
  let j = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + i * MS_PER_STEP;
    while (j + 1 < w.length && w[j + 1].observed_at <= t) j++;
    const a = w[j];
    if (!a || t < a.observed_at) continue;

    const b = w[j + 1];
    if (!b) {
      if (t !== a.observed_at) continue;
      for (const name of variables) {
        if (Number.isFinite(a[name])) series[name][i] = a[name];
      }
      continue;
    }

    const span = b.observed_at - a.observed_at;
    if (span > MAX_WEATHER_GAP_MS) continue;
    const f = span === 0 ? 0 : (t - a.observed_at) / span;
    for (const name of variables) {
      const va = a[name];
      const vb = b[name];
      // null arithmetic coerces to zero in JavaScript, so a missing reading
      // would interpolate smoothly towards a dead calm that never happened.
      series[name][i] = Number.isFinite(va) && Number.isFinite(vb) ? va + f * (vb - va) : NaN;
    }
  }
  return series;
}

/**
 * Everything this module knows about one station, over one span of intervals.
 *
 * Correlations are taken on the masked series only, and the masked fraction is
 * carried out with them: a farm curtailed 40% of the time has a correlation
 * computed from 60% of its life, and the reader is entitled to know that before
 * trusting the number.
 *
 * @param {Array<object>} observations canonical station observations
 * @param {Array<object>} weather records with `observed_at` plus numeric variables
 * @param {string} fueltech controlled vocabulary
 * @returns {object} the result bundle
 */
export function correlateStation(observations, weather, fueltech) {
  const obs = [...observations].sort((a, b) => a.observed_at - b.observed_at);
  const first = obs[0] ?? {};

  const bundle = {
    station_id: first.station_id ?? null,
    station_name: first.station_name ?? null,
    fueltech,
    capacity_mw: first.capacity_mw ?? null,
    // A battery's state of charge and the arbitrage spread decide its output.
    // Correlating it against the weather is worth showing and worth never
    // training on, so the flag travels with the numbers.
    weather_modelled: !BATTERY.has(fueltech),
    target: null,
    n_total: obs.length,
    n_used: 0,
    masked_fraction: 0,
    capped_fraction: 0,
    variables: {},
    curve: null,
    // Set when masking leaves a target with no variation at all. Tailem Bend 2's
    // solar farm sits under a semi-dispatch cap in every single interval it
    // produces in, so removing curtailed intervals correctly leaves nothing but
    // night, and every correlation comes back 0.000. That is not "no
    // relationship", it is "no admissible data", and the two must not read the
    // same on a chart.
    target_constant: false,
  };
  if (obs.length === 0) return bundle;

  let capped = 0;
  const usable = [];
  for (const o of obs) {
    if (o.capped === true) capped++;
    if (o.capped === false && o.quality === 'ok') usable.push(o);
  }
  bundle.capped_fraction = capped / obs.length;
  bundle.n_used = usable.length;
  bundle.masked_fraction = 1 - usable.length / obs.length;
  if (usable.length === 0) return bundle;

  const target = chooseTarget(usable, fueltech);
  bundle.target = target;

  const t0 = obs[0].observed_at;
  const steps = Math.round((obs[obs.length - 1].observed_at - t0) / MS_PER_STEP) + 1;
  const output = new Float64Array(steps).fill(NaN);
  for (const o of usable) {
    const i = Math.round((o.observed_at - t0) / MS_PER_STEP);
    if (i >= 0 && i < steps && Number.isFinite(o[target])) output[i] = o[target];
  }

  let seenValue = null;
  for (let i = 0; i < steps; i++) {
    const v = output[i];
    if (!Number.isFinite(v)) continue;
    if (seenValue === null) seenValue = v;
    else if (v !== seenValue) { bundle.target_constant = false; seenValue = NaN; break; }
  }
  bundle.target_constant = seenValue !== null && !Number.isNaN(seenValue);

  if (!weather || weather.length === 0) return bundle;
  const variables = Object.keys(weather[0])
    .filter((k) => k !== 'observed_at' && Number.isFinite(weather[0][k]));
  const series = interpolateWeather(weather, variables, t0, steps);

  for (const name of variables) {
    const x = series[name];
    const lag = laggedCrossCorrelation(x, output);
    bundle.variables[name] = {
      pearson: pearson(x, output),
      spearman: spearman(x, output),
      mutual_information_bits: mutualInformation(x, output),
      peak_lag_steps: lag.peakLag,
      peak_lag_minutes: lag.peakLag === null ? null : lag.peakLag * MINUTES_PER_STEP,
      peak_lag_prominence: lag.prominence,
      lags: lag.lags,
      cross_correlation: lag.values,
    };
  }

  const capacity = bundle.capacity_mw;
  if (fueltech === 'wind' && capacity > 0) {
    const speeds = [];
    const values = [];
    for (let i = 0; i < steps; i++) {
      if (!Number.isFinite(output[i])) continue;
      speeds.push(series.wind_speed_100m ? series.wind_speed_100m[i] : NaN);
      values.push(output[i]);
    }
    bundle.curve = fitWindCurve(speeds, values, capacity);
  } else if (fueltech === 'solar_utility' && capacity > 0) {
    const csi = [];
    const ref = [];
    const temp = [];
    const values = [];
    for (let i = 0; i < steps; i++) {
      if (!Number.isFinite(output[i])) continue;
      csi.push(series.clear_sky_index ? series.clear_sky_index[i] : NaN);
      ref.push(series.clear_sky_ghi ? series.clear_sky_ghi[i] : NaN);
      temp.push(series.temperature_2m ? series.temperature_2m[i] : NaN);
      values.push(output[i]);
    }
    bundle.curve = fitSolarCurve(csi, ref, temp, values, capacity);
  }

  return bundle;
}
