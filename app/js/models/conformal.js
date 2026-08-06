// Adaptive conformal inference for power forecast intervals.
//
// Forecast errors on a power station are not Gaussian and are nowhere near
// homoscedastic. A solar farm at midnight has literally zero error; the same
// farm at noon under broken cumulus has error comparable to its entire
// nameplate. A fixed sigma fitted over a month splits the difference and is
// wrong at both ends — absurdly wide at night, far too narrow in the afternoon.
//
// Conformal prediction sidesteps the distributional assumption entirely: size
// the band from the empirical quantile of recent absolute errors, whatever shape
// they happen to have. The adaptive part closes the loop, nudging the working
// miscoverage level whenever the realised hit rate drifts from target, which is
// what keeps coverage honest when the error distribution itself moves — a front
// coming through, a unit derating, a season turning.

// Bounds on the working miscoverage level. Zero already means the widest error
// on record and one already means a zero-width band, so nothing beyond either
// end changes the interval — it only leaves alpha a long walk back before the
// loop can respond again. Clamping any tighter is the real trap: a cap of 0.5
// stops the band ever tightening below the median retained error, so whenever
// the window is still full of errors from a wilder period the model over-covers
// and the feedback has no authority left to pull it back.
const ALPHA_MIN = 0;
const ALPHA_MAX = 1;

function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

export class AdaptiveConformal {
  /**
   * @param {object} opts
   * @param {number} [opts.targetCoverage=0.9] nominal coverage, e.g. 0.9 for an 80/90 fan band
   * @param {number} [opts.gamma=0.005] adaptation step; larger tracks faster and jitters more
   * @param {number} [opts.window=2000] absolute errors retained (2000 five-minute intervals is ~7 days)
   * @param {number} opts.capacityMw registered capacity, the hard physical ceiling on output
   */
  constructor({ targetCoverage = 0.9, gamma = 0.005, window = 2000, capacityMw }) {
    this.targetCoverage = targetCoverage;
    this.gamma = gamma;
    this.capacityMw = capacityMw;
    this.alpha = 1 - targetCoverage;

    this.errors = new Float64Array(window);
    this.sorted = new Float64Array(window);
    this.head = 0;
    this.n = 0;
    this.stale = true;

    this.hits = 0;
    this.updates = 0;
  }

  /**
   * The prediction interval to issue for this point forecast.
   *
   * Clipped to what the plant can physically do. An interval running from -30 MW
   * to 120 MW on a 100 MW farm is not a wide confidence interval, it is a bug:
   * it asserts probability mass on outcomes that cannot occur, and it inflates
   * measured coverage for free.
   *
   * @param {number} pointForecast MW
   * @returns {{lo: number, hi: number}}
   */
  interval(pointForecast) {
    const halfWidth = this.errorQuantile(1 - this.alpha);
    return {
      lo: clamp(pointForecast - halfWidth, 0, this.capacityMw),
      hi: clamp(pointForecast + halfWidth, 0, this.capacityMw),
    };
  }

  /**
   * Record the outcome for a point forecast whose interval has already been
   * issued, and adapt.
   *
   * @param {number} pointForecast MW
   * @param {number} actual MW
   */
  update(pointForecast, actual) {
    const { lo, hi } = this.interval(pointForecast);
    const hit = actual >= lo && actual <= hi ? 1 : 0;
    this.hits += hit;
    this.updates++;

    // The feedback runs the opposite way to first instinct. A hit raises alpha,
    // which lowers the working quantile level and tightens the next band; a miss
    // drops alpha and widens it. The two step sizes, (1 - c) after a hit and c
    // after a miss, cancel in expectation exactly when the long-run hit rate is
    // c, so target coverage is the fixed point of the loop rather than something
    // the error quantile has to get right on its own.
    this.alpha = clamp(
      this.alpha + this.gamma * (hit - this.targetCoverage),
      ALPHA_MIN,
      ALPHA_MAX,
    );

    if (this.n < this.errors.length) this.n++;
    this.errors[this.head] = Math.abs(actual - pointForecast);
    this.head = (this.head + 1) % this.errors.length;
    this.stale = true;
  }

  /**
   * The predictive distribution as quantiles, for feeding CRPS.
   *
   * Symmetric about the point forecast, because absolute errors are all the
   * window retains; the asymmetry that matters — a farm near zero or near
   * nameplate cannot err far in one direction — comes back through the clip.
   *
   * @param {number} pointForecast MW
   * @param {number[]} levels quantile levels in (0,1)
   * @returns {{q: number, v: number}[]}
   */
  quantiles(pointForecast, levels) {
    // Apply the adaptive correction at every level, not just at target, so the
    // pair of quantiles bracketing the target band reproduce interval() exactly
    // instead of drifting away from the band actually shown to the user.
    const shift = (1 - this.alpha) - this.targetCoverage;

    return levels.map((q) => {
      const twoSided = clamp(Math.abs(2 * q - 1) + shift, 0, 1);
      const halfWidth = this.errorQuantile(twoSided);
      const v = q >= 0.5 ? pointForecast + halfWidth : pointForecast - halfWidth;
      return { q, v: clamp(v, 0, this.capacityMw) };
    });
  }

  /**
   * Realised hit rate over every update so far. The number to check before
   * believing any band this class issues.
   *
   * @returns {number} in [0,1]
   */
  coverage() {
    return this.updates === 0 ? 0 : this.hits / this.updates;
  }

  /**
   * Empirical quantile of the retained absolute errors.
   *
   * @param {number} level in [0,1]
   * @returns {number} MW
   */
  errorQuantile(level) {
    // With no history the only defensible statement is the full physical range;
    // a zero-width band would spend the first updates guaranteed to miss and
    // drag alpha to its floor before any real error had been seen.
    if (this.n === 0) return this.capacityMw;

    if (this.stale) {
      this.sorted.set(this.errors);
      // Unused ring slots hold zero, which would sort in among the real errors
      // and pull every quantile down during warm-up. Infinity parks them past
      // the end instead, where no index below n can reach them.
      if (this.n < this.sorted.length) this.sorted.fill(Infinity, this.n);
      this.sorted.sort();
      this.stale = false;
    }

    // The (n+1) rank is the conformal correction: with few errors in hand it
    // rounds up to the largest one rather than pretending the sample resolves a
    // tail it cannot.
    const rank = clamp(Math.ceil((this.n + 1) * level) - 1, 0, this.n - 1);
    return this.sorted[rank];
  }
}
