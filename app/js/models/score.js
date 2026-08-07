// Scoring for probabilistic power forecasts.
//
// Every metric here is a proper scoring rule, which is the whole point: a proper
// rule is minimised only when the forecaster reports what it actually believes.
// The tempting hand-rolled alternatives — "percent of intervals within 10 MW",
// "how often were we inside the band" — all pay a forecaster to misstate its own
// uncertainty, and a model tuned against them learns to look confident rather
// than to be right.
//
// One convention runs through the file: CRPS is in MW, the same unit as the
// forecast, and a deterministic forecast's CRPS is exactly its absolute error.
// That identity is what lets CRPS, MAE and the skill score sit in one table
// without a units footnote.

/**
 * Pinball (quantile) loss — the asymmetric penalty that makes a quantile
 * forecast honest.
 *
 * Under-forecasting the 90th percentile is cheap and over-forecasting it is
 * dear, in exactly the 9:1 ratio that makes the loss minimal at the true 90th
 * percentile of the outcome distribution.
 *
 * @param {number} quantileLevel tau in (0,1)
 * @param {number} predicted the forecast value of that quantile
 * @param {number} actual the observed outcome
 * @returns {number}
 */
export function pinballLoss(quantileLevel, predicted, actual) {
  return actual >= predicted
    ? quantileLevel * (actual - predicted)
    : (1 - quantileLevel) * (predicted - actual);
}

/**
 * CRPS of a quantile forecast, approximated on the levels supplied.
 *
 * The factor of two is not decoration. CRPS is twice the integral of the pinball
 * loss over tau, so dropping it scores a deterministic forecast at half its
 * absolute error — CRPS and MAE stop being comparable, and any skill score taken
 * against a MAE-flavoured baseline is quietly out by 2x. With the factor in
 * place this agrees exactly with crpsFromSamples when the levels are the sample
 * midpoints (i-0.5)/n.
 *
 * The integral is taken as the plain mean over whatever levels arrive, so the
 * levels have to be a fair sample of (0,1) — symmetric about 0.5 at the very
 * least, or the CRPS-equals-absolute-error identity that lets this sit in a
 * table beside MAE stops holding. Sample midpoints are the levels to use.
 *
 * @param {{q: number, v: number}[]} quantiles sorted ascending by q
 * @param {number} actual
 * @returns {number} MW
 */
export function crps(quantiles, actual) {
  let sum = 0;
  for (const { q, v } of quantiles) sum += pinballLoss(q, v, actual);
  return 2 * sum / quantiles.length;
}

/**
 * Empirical CRPS of an ensemble, via the energy form
 * mean|X - y| - 0.5 * mean|X - X'|.
 *
 * The second term is a double sum over every pair of members, which is O(n^2)
 * written literally and gets called once per station per interval in the replay
 * loop. Sorting first collapses it: for ascending x, the sum of all pairwise
 * gaps is a single pass, because member k sits above k others and below the
 * rest.
 *
 * @param {ArrayLike<number>} samples ensemble members, any order
 * @param {number} actual
 * @returns {number} MW
 */
export function crpsFromSamples(samples, actual) {
  const n = samples.length;
  const x = Float64Array.from(samples).sort();

  let absError = 0;
  let pairGaps = 0;
  for (let i = 0; i < n; i++) {
    absError += Math.abs(x[i] - actual);
    pairGaps += x[i] * (2 * i - n + 1);
  }

  return absError / n - pairGaps / (n * n);
}

/**
 * Skill against a baseline: 1 - model/baseline.
 *
 * This is the headline number for the whole system. Above zero the model beats
 * persistence, zero ties it, below zero it is worse than doing nothing at all —
 * which is a result worth publishing rather than hiding.
 *
 * @param {number} crpsModel
 * @param {number} crpsBaseline
 * @returns {number}
 */
export function skillScore(crpsModel, crpsBaseline) {
  // A perfect baseline leaves no room to demonstrate skill, and the ratio is
  // undefined; claiming any number there would be an artefact of the divide.
  if (crpsBaseline === 0) return 0;
  return 1 - crpsModel / crpsBaseline;
}

/**
 * Every paired metric in this file walks `pred` and indexes `actual` alongside
 * it. Hand it a shorter `actual` and the tail reads `undefined`, which makes the
 * whole score NaN — but hand it a *longer* one and nothing complains at all: the
 * extra observations are simply dropped and the number that comes back looks
 * entirely reasonable. A ragged pair is a wiring mistake, and it has to be loud.
 */
function requirePaired(pred, actual, name) {
  if (pred.length !== actual.length) {
    throw new RangeError(`${name}: ${pred.length} predictions against ${actual.length} actuals`);
  }
  if (pred.length === 0) throw new RangeError(`${name}: nothing to score`);
}

/**
 * Mean absolute error over paired arrays.
 *
 * @param {ArrayLike<number>} pred
 * @param {ArrayLike<number>} actual
 * @returns {number} MW
 */
export function mae(pred, actual) {
  requirePaired(pred, actual, 'mae');
  let sum = 0;
  for (let i = 0; i < pred.length; i++) sum += Math.abs(pred[i] - actual[i]);
  return sum / pred.length;
}

/**
 * Root mean squared error over paired arrays.
 *
 * @param {ArrayLike<number>} pred
 * @param {ArrayLike<number>} actual
 * @returns {number} MW
 */
export function rmse(pred, actual) {
  requirePaired(pred, actual, 'rmse');
  let sum = 0;
  for (let i = 0; i < pred.length; i++) {
    const d = pred[i] - actual[i];
    sum += d * d;
  }
  return Math.sqrt(sum / pred.length);
}

/**
 * Express an error in MW as a percentage of registered capacity, so a 700 MW
 * coal unit and a 40 MW solar farm can be put on the same axis.
 *
 * @param {number} errorMw
 * @param {number} capacityMw
 * @returns {number} percent
 */
export function pctOfCapacity(errorMw, capacityMw) {
  // Most of the station registry carries a null capacity — aggregated loads and
  // registrations with no plant behind them. Dividing by that yields Infinity,
  // which in a chart quietly rescales the axis until every honest bar is flat.
  // A station with no capacity cannot be put on a percent-of-capacity axis at
  // all, so refuse rather than emit a number that means nothing.
  if (!Number.isFinite(capacityMw) || capacityMw <= 0) {
    throw new TypeError(`pctOfCapacity needs a positive capacityMw, got ${capacityMw}`);
  }
  return 100 * errorMw / capacityMw;
}

/**
 * Probability integral transform: where the outcome fell in the predictive CDF.
 *
 * The quantile list gives the CDF at a handful of knots; between them the CDF is
 * taken as linear in value, which is the same assumption already implicit in
 * drawing the fan chart. The tail shape beyond the outermost knot is genuinely
 * not information the forecast contained, so an outcome out there is placed at
 * the middle of the tail it landed in — all that is known is which tail.
 *
 * Pinning to the outermost knot's level instead is the trap, and it is not a
 * small one. On a decile fan the 10% of outcomes below the 0.1 quantile all take
 * the value 0.1, which falls in the *second* histogram bin: the first bin comes
 * out empty and the second doubled, and a perfectly calibrated forecast is
 * rejected at a p-value with 200 zeros after the point. The midpoint keeps the
 * mass inside the tail region it belongs to.
 *
 * What it cannot do is resolve within that region — bins finer than the
 * outermost quantile gap will show a spike there that is an artefact of the
 * grid, not of calibration. Issue quantiles that reach further into the tails
 * than the histogram bins if that matters.
 *
 * @param {{q: number, v: number}[]} quantiles sorted ascending by q
 * @param {number} actual
 * @returns {number} in [0,1]
 */
export function pitValue(quantiles, actual) {
  const last = quantiles.length - 1;
  if (actual <= quantiles[0].v) return quantiles[0].q / 2;
  if (actual >= quantiles[last].v) return (1 + quantiles[last].q) / 2;

  for (let i = 1; i <= last; i++) {
    const lo = quantiles[i - 1];
    const hi = quantiles[i];
    if (actual <= hi.v) {
      const span = hi.v - lo.v;
      // Equal knot values mean the forecast put an atom of probability there;
      // the outcome has cleared the whole atom, so it sits at the upper level.
      return span === 0 ? hi.q : lo.q + (hi.q - lo.q) * (actual - lo.v) / span;
    }
  }
  return (1 + quantiles[last].q) / 2;
}

/**
 * Uniformity test on a batch of PIT values — the single most informative
 * calibration diagnostic available.
 *
 * A flat histogram means the stated uncertainty matches the realised
 * uncertainty. A U-shape means outcomes keep landing in the tails: the forecast
 * is overconfident, its bands too narrow. A central hump means the opposite,
 * bands too wide to be useful. A slope means bias.
 *
 * @param {ArrayLike<number>} pitValues
 * @param {number} [bins=10]
 * @returns {{counts: number[], chiSquared: number, pValue: number, uniform: boolean}}
 */
export function pitHistogram(pitValues, bins = 10) {
  if (pitValues.length === 0) throw new RangeError('pitHistogram: no PIT values to test');

  const counts = new Array(bins).fill(0);
  for (let i = 0; i < pitValues.length; i++) {
    // Clamping both ends, not just the top. A PIT value below zero indexes
    // counts[-1], which JavaScript accepts as a plain property: the value
    // vanishes from the histogram while still counting towards the expected
    // frequency below, so the chi-squared statistic inflates and a perfectly
    // calibrated forecast gets rejected for a reason nothing on screen explains.
    const bin = Math.floor(pitValues[i] * bins);
    counts[bin < 0 ? 0 : (bin > bins - 1 ? bins - 1 : bin)]++;
  }

  return { counts, ...pitUniformity(counts) };
}

/**
 * The same uniformity test, for a histogram that has already been binned.
 *
 * The replay worker bins as it scores, because shipping every PIT value across
 * the worker boundary each frame is a hundred thousand numbers to draw ten
 * bars. It therefore has counts and never has the values, and passing those
 * counts to a function that expects values is silent: every count is a whole
 * number well above 1, so binning them into [0,1] drops all ten into the top
 * bin and draws a confident, permanent, entirely fictional histogram.
 *
 * @param {ArrayLike<number>} counts one bin per element
 * @returns {{chiSquared: number, pValue: number, uniform: boolean}}
 */
export function pitUniformity(counts) {
  const bins = counts.length;
  if (bins === 0) throw new RangeError('pitUniformity: no bins');
  let total = 0;
  for (let i = 0; i < bins; i++) total += counts[i];
  if (total === 0) throw new RangeError('pitUniformity: histogram is empty');

  const expected = total / bins;
  let chiSquared = 0;
  for (let i = 0; i < bins; i++) {
    const d = counts[i] - expected;
    chiSquared += d * d / expected;
  }

  const pValue = regularisedGammaQ((bins - 1) / 2, chiSquared / 2);
  return { chiSquared, pValue, uniform: pValue > 0.05 };
}

/**
 * Fraction of outcomes that fell inside their issued interval.
 *
 * @param {{lo: number, hi: number}[]} intervals
 * @param {ArrayLike<number>} actuals
 * @returns {number} in [0,1]
 */
export function coverage(intervals, actuals) {
  requirePaired(intervals, actuals, 'coverage');
  let inside = 0;
  for (let i = 0; i < intervals.length; i++) {
    if (actuals[i] >= intervals[i].lo && actuals[i] <= intervals[i].hi) inside++;
  }
  return inside / intervals.length;
}

/**
 * Mean of the last `window` values pushed.
 *
 * Sits inside the replay loop at several hundred intervals a second, so it keeps
 * a running sum over a preallocated ring rather than reducing an array: no
 * allocation, no growth, constant work per update.
 */
export class RollingScore {
  constructor(window) {
    // A zero-length ring makes the modulo return NaN and every mean after it,
    // with nothing thrown along the way.
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`RollingScore window must be a positive integer, got ${window}`);
    }
    this.buf = new Float64Array(window);
    this.head = 0;
    this.n = 0;
    this.sum = 0;
  }

  push(value) {
    if (this.n === this.buf.length) this.sum -= this.buf[this.head];
    else this.n++;

    this.buf[this.head] = value;
    this.sum += value;
    this.head = (this.head + 1) % this.buf.length;

    // Add-then-subtract accumulates rounding error without bound over a replay
    // of millions of intervals, and the drift is invisible — the number just
    // slowly stops being the mean. Re-adding the ring once per lap costs one
    // pass per `window` pushes and caps the error at a single lap's worth.
    if (this.head === 0) {
      let s = 0;
      for (let i = 0; i < this.n; i++) s += this.buf[i];
      this.sum = s;
    }
  }

  mean() {
    return this.n === 0 ? 0 : this.sum / this.n;
  }

  count() {
    return this.n;
  }
}

// --- Chi-squared tail probability -------------------------------------------
//
// Q(x; k) = regularised upper incomplete gamma Q(k/2, x/2). Written out here
// because the alternative is a stats dependency for one function, and because a
// lookup table of critical values would give a pass/fail where the p-value
// itself is the thing worth showing the user.

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  let series = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) series += LANCZOS[i] / (x + i);
  const t = x + 6.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(series);
}

function regularisedGammaQ(a, x) {
  if (x <= 0) return 1;
  // The series converges quickly below the peak of the integrand and the
  // continued fraction above it; each is hopeless on the other's side.
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaFraction(a, x);
}

function gammaSeries(a, x) {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < 300; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaFraction(a, x) {
  // Lentz's method: evaluate the continued fraction forwards, rescaling so a
  // zero denominator cannot stall it.
  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }

  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

// ---------------------------------------------------------------------------
// Calibration diagnostics
// ---------------------------------------------------------------------------
//
// These are statistics, not chart code, and they live here for a reason that
// cost a real defect: while they sat in the chart module they could not be
// imported without uPlot, so no test in this suite could reach them, and the
// station view fed the histogram counts to a function expecting values for as
// long as the panel existed.

// Below this every histogram wobbles, and calling a 5% bump "overconfident"
// trains the reader to ignore the caption.
const FLAT_TOLERANCE = 0.15;

/**
 * PIT counts as bars: bin centres against relative frequency, scaled so that a
 * perfectly calibrated forecast sits at exactly 1.
 *
 * Scaled that way because the reference line is then the same height whatever
 * the bin count and however many intervals have been scored, so the chart does
 * not change shape as the replay runs.
 *
 * @param {number[]} counts
 * @returns {{x: number[], y: number[], total: number}}
 */
export function pitBars(counts) {
  const bins = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const x = [];
  const y = [];
  for (let i = 0; i < bins; i++) {
    x.push((i + 0.5) / bins);
    y.push(total === 0 ? 0 : (counts[i] / total) * bins);
  }
  return { x, y, total };
}

/**
 * Which of the four shapes a PIT histogram has, and what that means.
 *
 * Slope is tested before curvature. A forecast that is simply biased high puts
 * most of its mass in the low bins, which lifts one tail and can read as half a
 * U; calling that overconfident would send the reader to widen a band when the
 * fault is in the centre of it.
 *
 * @param {number[]} counts
 * @returns {{shape: string, caption: string}}
 */
export function classifyPitShape(counts) {
  const bins = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { shape: 'empty', caption: 'No scored intervals yet.' };
  }

  const share = counts.map((c) => c / total);
  const expected = 1 / bins;
  const edge = Math.max(1, Math.round(bins * 0.2));

  let tails = 0;
  for (let i = 0; i < edge; i++) tails += share[i] + share[bins - 1 - i];
  const tailExcess = tails / (2 * edge * expected) - 1;

  const midFrom = Math.floor((bins - edge) / 2);
  let centre = 0;
  for (let i = midFrom; i < midFrom + edge; i++) centre += share[i];
  const centreExcess = centre / (edge * expected) - 1;

  // Mass either side of the middle, as a fraction of the whole: +1 would be
  // every outcome in the top bin, -1 every outcome in the bottom one.
  let slope = 0;
  const mid = (bins - 1) / 2;
  let arm = 0;
  for (let i = 0; i < bins; i++) {
    slope += share[i] * (i - mid);
    arm += expected * Math.abs(i - mid);
  }
  slope /= arm;

  const curvature = Math.max(Math.abs(tailExcess), Math.abs(centreExcess));
  if (Math.max(curvature, Math.abs(slope)) < FLAT_TOLERANCE) {
    return {
      shape: 'calibrated',
      caption: 'Flat — the stated uncertainty matches the realised uncertainty.',
    };
  }
  // One edge bin holding most of the mass is its own diagnosis, and "sloped"
  // understates it badly: nearly every outcome landed beyond one end of the
  // predicted spread, which is the check failing outright.
  if (Math.max(share[0], share[bins - 1]) > 0.5) {
    return share[bins - 1] >= share[0]
      ? { shape: 'pinned-high', caption: 'Piled at the top — the truth keeps landing above the whole band. The check is failing.' }
      : { shape: 'pinned-low', caption: 'Piled at the bottom — the truth keeps landing below the whole band. The check is failing.' };
  }
  if (Math.abs(slope) > curvature) {
    return slope > 0
      ? { shape: 'biased-low', caption: 'Sloped — outcomes sit above the middle of the band, so the forecast runs low.' }
      : { shape: 'biased-high', caption: 'Sloped — outcomes sit below the middle of the band, so the forecast runs high.' };
  }
  if (tailExcess > centreExcess) {
    return {
      shape: 'overconfident',
      caption: 'U-shaped — outcomes keep landing in the tails, so the bands are too narrow.',
    };
  }
  return {
    shape: 'underconfident',
    caption: 'Central hump — outcomes cluster mid-band, so the bands are wider than they need to be.',
  };
}

/**
 * Empirical coverage of the central intervals a set of PIT values implies.
 *
 * Taken from the PIT rather than from the issued bands because it then covers
 * every level at once, including ones the model never issued a band for.
 *
 * @param {ArrayLike<number>} pitValues
 * @param {number[]} [levels] nominal central coverages in (0,1)
 * @returns {{nominal: number[], empirical: number[]}}
 */
/**
 * The same diagram from a binned histogram, for the replay worker.
 *
 * Each bin contributes its whole count to a nominal level when the bin lies
 * inside that level's central interval, so nothing has to be expanded back
 * into individual values — the previous approach pushed one array entry per
 * scored interval, tens of thousands of them, on every animation frame.
 *
 * Resolution is the bin width: a central interval whose edge falls inside a
 * bin counts that bin's share by overlap rather than all-or-nothing, which is
 * the honest reading of a histogram that no longer knows where inside each bin
 * its values sat.
 *
 * @param {ArrayLike<number>} counts one per bin, spanning [0,1]
 * @param {number[]} [levels]
 * @returns {{nominal: number[], empirical: number[]}}
 */
export function reliabilityFromCounts(counts, levels = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const bins = counts.length;
  let total = 0;
  for (let i = 0; i < bins; i++) total += counts[i];

  const empirical = levels.map((c) => {
    if (total === 0) return 0;
    const lo = (1 - c) / 2;
    const hi = (1 + c) / 2;
    let inside = 0;
    for (let b = 0; b < bins; b++) {
      const binLo = b / bins;
      const binHi = (b + 1) / bins;
      const overlap = Math.min(hi, binHi) - Math.max(lo, binLo);
      if (overlap > 0) inside += counts[b] * (overlap / (binHi - binLo));
    }
    return inside / total;
  });
  return { nominal: levels.slice(), empirical };
}

export function reliabilityFromPit(pitValues, levels = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const empirical = levels.map((c) => {
    const lo = (1 - c) / 2;
    const hi = (1 + c) / 2;
    let inside = 0;
    for (let i = 0; i < pitValues.length; i++) {
      if (pitValues[i] >= lo && pitValues[i] <= hi) inside++;
    }
    return pitValues.length === 0 ? 0 : inside / pitValues.length;
  });
  return { nominal: levels.slice(), empirical };
}
