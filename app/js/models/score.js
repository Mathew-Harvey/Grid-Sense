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
 * Mean absolute error over paired arrays.
 *
 * @param {ArrayLike<number>} pred
 * @param {ArrayLike<number>} actual
 * @returns {number} MW
 */
export function mae(pred, actual) {
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
  return 100 * errorMw / capacityMw;
}

/**
 * Probability integral transform: where the outcome fell in the predictive CDF.
 *
 * The quantile list gives the CDF at a handful of knots; between them the CDF is
 * taken as linear in value, which is the same assumption already implicit in
 * drawing the fan chart. Outside the outermost knots the value is pinned to that
 * knot's level — the tail shape beyond the widest quantile issued is simply not
 * information the forecast contained.
 *
 * @param {{q: number, v: number}[]} quantiles sorted ascending by q
 * @param {number} actual
 * @returns {number} in [0,1]
 */
export function pitValue(quantiles, actual) {
  const last = quantiles.length - 1;
  if (actual <= quantiles[0].v) return quantiles[0].q;
  if (actual >= quantiles[last].v) return quantiles[last].q;

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
  return quantiles[last].q;
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
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < pitValues.length; i++) {
    counts[Math.min(bins - 1, Math.floor(pitValues[i] * bins))]++;
  }

  const expected = pitValues.length / bins;
  let chiSquared = 0;
  for (const c of counts) {
    const d = c - expected;
    chiSquared += d * d / expected;
  }

  const pValue = regularisedGammaQ((bins - 1) / 2, chiSquared / 2);
  return { counts, chiSquared, pValue, uniform: pValue > 0.05 };
}

/**
 * Fraction of outcomes that fell inside their issued interval.
 *
 * @param {{lo: number, hi: number}[]} intervals
 * @param {ArrayLike<number>} actuals
 * @returns {number} in [0,1]
 */
export function coverage(intervals, actuals) {
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
