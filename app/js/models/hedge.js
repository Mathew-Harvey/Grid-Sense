// No-regret combination of the expert bank.
//
// Multiplicative weights: every round each expert takes a loss, its weight
// decays as exp(-eta * loss), and the mixture's cumulative loss provably stays
// within O(sqrt(T ln N)) of the best single expert in hindsight. Nothing has to
// be known in advance about which expert is good, which is exactly the position
// here — the best expert for a wind farm in a winter westerly is not the best
// one for the same farm in a summer sea breeze.
//
// The textbook version has one property that is wrong for a system meant to run
// across seasons: an expert that has a bad fortnight is driven to a weight of
// 1e-40 and can never come back, because a weight that small contributes
// nothing to the mixture no matter how good it becomes. Every weight is
// therefore floored, which costs a negligible amount of accuracy and buys the
// ability to recover.

const EFFECTIVE_HORIZON = 5000;

/**
 * The standard tuning for multiplicative weights, balancing how fast the
 * mixture can move against how far it overshoots on noise.
 *
 * T here is an effective horizon, not the length of the run. This combiner
 * never stops; an eta that decayed with the true round count would have the
 * weights frozen solid by the second month, which defeats the purpose.
 *
 * @param {number} n number of experts
 * @param {number} [rounds]
 */
export function defaultEta(n, rounds = EFFECTIVE_HORIZON) {
  return Math.sqrt((8 * Math.log(n)) / rounds);
}

function pick(byName, name) {
  const v = byName[name];
  // A silently missing expert would fold NaN through its weight, and NaN never
  // washes back out.
  if (v === undefined) throw new Error(`Hedge: no prediction supplied for expert "${name}"`);
  return v;
}

/** Exponentiated-gradient combiner over a fixed set of named experts. */
export class Hedge {
  /**
   * @param {{names: string[], eta?: number, weightFloor?: number}} opts
   */
  constructor({ names, eta, weightFloor = 1e-4 }) {
    this.names = [...names];
    // Settable at runtime: the UI exposes it, and a station whose regime shifts
    // hourly wants a livelier mixture than a baseload unit.
    this.eta = eta ?? defaultEta(this.names.length);
    // n floors have to fit inside a unit budget with room to spare. Beyond that
    // the pinned weights alone exceed one, _renormalise() has a negative
    // remainder to share out, and the surviving experts take negative weights —
    // which produces a forecast outside [0, capacity] and no error anywhere.
    if (!(weightFloor >= 0) || weightFloor * this.names.length >= 1) {
      throw new Error(`Hedge: weightFloor ${weightFloor} is too large for ${this.names.length} experts`);
    }
    this.weightFloor = weightFloor;
    this.w = new Float64Array(this.names.length).fill(1 / this.names.length);
    // Reused: update() runs once per station per horizon per dispatch interval.
    this._loss = new Float64Array(this.names.length);
  }

  /** Current mixture weights by expert name, copied so the UI cannot mutate them. */
  weights() {
    const out = {};
    for (let i = 0; i < this.names.length; i++) out[this.names[i]] = this.w[i];
    return out;
  }

  /**
   * Weighted mean point forecast.
   *
   * @param {Object<string, number>} predictions MW by expert name
   */
  combine(predictions) {
    let y = 0;
    for (let i = 0; i < this.names.length; i++) y += this.w[i] * pick(predictions, this.names[i]);
    return y;
  }

  /**
   * Weighted quantiles, one array in per expert at shared probability levels.
   *
   * Averaging the quantiles rather than mixing the distributions is deliberate.
   * The mixture of several sharp, differently-centred predictive distributions
   * is a wide multi-modal thing whose 90% interval is far wider than any
   * expert's, which reads as honest uncertainty but is really just disagreement
   * about the median. Averaging quantile by quantile keeps the spread of a
   * typical expert and moves the centre, which is what the disagreement
   * actually implies.
   *
   * @param {Object<string, number[]>} quantilesByExpert
   * @returns {number[]}
   */
  combineQuantiles(quantilesByExpert) {
    const width = pick(quantilesByExpert, this.names[0]).length;
    const out = new Array(width).fill(0);
    for (let i = 0; i < this.names.length; i++) {
      const q = pick(quantilesByExpert, this.names[i]);
      for (let j = 0; j < width; j++) out[j] += this.w[i] * q[j];
    }
    return out;
  }

  /**
   * Score the round and move the weights.
   *
   * @param {Object<string, number>} predictions MW by expert name
   * @param {number} actual MW
   * @param {number} capacityMw station nameplate
   */
  update(predictions, actual, capacityMw) {
    // Every loss here is an error over nameplate. Without a nameplate, or
    // without an actual, there is no round to score: the division yields NaN,
    // every weight becomes NaN, and NaN never washes back out, so the mixture
    // is dead for the rest of the run. 271 of the 700 stations in the registry
    // carry a null capacity, so this is ordinary input, not an exotic one.
    if (!(capacityMw > 0) || !Number.isFinite(actual)) return;

    const n = this.names.length;
    const loss = this._loss;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      // Absolute error as a fraction of nameplate. Normalising by capacity is
      // what lets one eta serve a 50 MW solar farm and a 2640 MW coal station:
      // left in MW, the same relative error moves the big station's weights
      // fifty times harder and they thrash. The clamp keeps losses inside the
      // [0,1] range the regret bound assumes.
      const e = Math.abs(pick(predictions, this.names[i]) - actual) / capacityMw;
      // An expert that returned something non-finite has not made a forecast.
      // Charging it the maximum loss retires it toward the floor, where it can
      // still recover; letting the NaN through would take the whole mixture.
      const l = Number.isFinite(e) ? Math.min(1, e) : 1;
      loss[i] = l;
      if (l < best) best = l;
    }

    for (let i = 0; i < n; i++) {
      // Shifting by the round's best loss cancels in the renormalisation and
      // keeps the exponential clear of underflow when eta is turned up.
      this.w[i] *= Math.exp(-this.eta * (loss[i] - best));
    }
    this._renormalise();
  }

  /**
   * Pin anything below the floor at exactly the floor and scale the rest to
   * fill what is left. Flooring and then dividing by the total would leave the
   * pinned weights just under the floor and let them creep down over months,
   * which is the slow version of the annihilation the floor exists to prevent.
   */
  _renormalise() {
    const w = this.w;
    const n = w.length;
    const floor = this.weightFloor;
    const pinned = new Array(n).fill(false);

    for (;;) {
      let free = 0;
      let budget = 1;
      for (let i = 0; i < n; i++) {
        if (pinned[i]) budget -= floor;
        else free += w[i];
      }
      // Every weight underflowing at once means the mixture has no information
      // left; a uniform restart is the only sane state to be in.
      if (free <= 0) {
        w.fill(1 / n);
        return;
      }
      const scale = budget / free;
      let settled = true;
      for (let i = 0; i < n; i++) {
        if (!pinned[i] && w[i] * scale < floor) {
          pinned[i] = true;
          settled = false;
        }
      }
      if (settled) {
        for (let i = 0; i < n; i++) w[i] = pinned[i] ? floor : w[i] * scale;
        return;
      }
    }
  }
}
