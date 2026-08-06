// Turning a scored probabilistic forecast into something a person can act on.
//
// One rule governs this file: a signal carries the evidence that produced it, or
// it does not exist. Everything the decision reads sits in the returned evidence
// object, so any recommendation can be re-derived from what it shows. That is
// not presentation politeness — a recommendation whose reasoning cannot be
// inspected invites trust it has not earned, and this system's whole claim is
// that it reports its own quality honestly.
//
// Nothing here fetches, touches the DOM, or reads the clock. The time a signal
// was generated is an input, because a decision that reads Date.now() cannot be
// replayed and a stale signal must stay identifiable as stale.

/**
 * The controlled vocabulary a signal may take.
 *
 * Deliberately not buy/sell. This system forecasts generation from weather. It
 * holds no position, places no bid, sees no order book and has no view on where
 * the price goes next; the price it is handed is an assumption, not a forecast.
 * Naming an output "buy" would claim a competence it does not have, and anyone
 * who read it as trading advice would be right to feel misled. Watch, hold,
 * opportunity and risk describe only what the model can actually see: whether
 * output is heading materially away from where it is now, and whether the model
 * has earned the right to say so. Do not rename these.
 *
 * @type {Readonly<{WATCH: string, HOLD: string, OPPORTUNITY: string, RISK: string}>}
 */
export const SIGNAL = Object.freeze({
  WATCH: 'watch',
  HOLD: 'hold',
  OPPORTUNITY: 'opportunity',
  RISK: 'risk',
});

/**
 * Confidence vocabulary. Always derived, never supplied by a caller.
 *
 * @type {Readonly<{LOW: string, MEDIUM: string, HIGH: string}>}
 */
export const CONFIDENCE = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

// Skill at which sharpness and data completeness alone decide confidence.
// Halving persistence's CRPS is as good as this system needs to be: across the
// 275 scored station-horizons in the backtest the median skill is 0.28 and the
// 90th percentile 0.63, so full marks stay reachable without being routine.
const SKILL_SATURATION = 0.5;

const HIGH_CONFIDENCE = 0.6;
const MEDIUM_CONFIDENCE = 0.3;

// Below this a move may be real but is not worth interrupting anyone for. It is
// dollars over the whole horizon rather than a percentage, because a percentage
// bar makes small plants shout and large ones whisper.
const MATERIAL_DOLLARS = 1000;

// Past this share of recent producing intervals under a cap, the plant's output
// is a market outcome rather than a weather outcome.
const CONSTRAINED_FRACTION = 0.5;

const HORIZON_PATTERN = /^(\d+)(min|h)$/;

// Prose forms for the horizons the backtest scores. A non-specialist reads "the
// next hour"; "1h" is a column heading, not a sentence.
const HORIZON_PROSE = {
  '5min': 'the next five minutes',
  '30min': 'the next half hour',
  '1h': 'the next hour',
  '6h': 'the next six hours',
  '24h': 'the next day',
};

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number, got ${value}`);
  return value;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function horizonHours(horizon) {
  const match = HORIZON_PATTERN.exec(horizon);
  if (!match) throw new TypeError(`unrecognised horizon: ${horizon}`);
  return match[2] === 'h' ? Number(match[1]) : Number(match[1]) / 60;
}

function horizonProse(horizon) {
  return HORIZON_PROSE[horizon] ?? `the next ${horizon}`;
}

// Rounding below is for prose only and never feeds a decision.
function mwText(mw) {
  return Math.abs(mw) >= 10 ? String(Math.round(mw)) : mw.toFixed(1);
}

function dollarText(amount) {
  const magnitude = Math.abs(amount);
  const digits = magnitude >= 10 ? String(Math.round(magnitude)) : magnitude.toFixed(2);
  return `${amount < 0 ? '-$' : '$'}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function pctText(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Confidence, derived from what the model has actually demonstrated.
 *
 * Three independent ways to be untrustworthy: the model has not beaten
 * persistence at this horizon, the band it draws is too wide to say anything, or
 * the recent record it learned from was mostly masked out. They multiply rather
 * than average because any one of them alone is disqualifying — averaging lets a
 * healthy skill score hide a band as wide as the power station.
 *
 * @param {object} inputs
 * @param {number} inputs.skill realised skill score against persistence at this horizon
 * @param {number} inputs.bandWidthMw conformal band width, hi minus lo
 * @param {number} inputs.forecastMw the point forecast the band surrounds
 * @param {number} inputs.capacityMw registered capacity
 * @param {number} inputs.maskedFraction share of recent intervals excluded from learning
 * @returns {{score: number, label: string}} score in [0,1] and its CONFIDENCE label
 */
export function deriveConfidence({ skill, bandWidthMw, forecastMw, capacityMw, maskedFraction }) {
  finite(capacityMw, 'capacityMw');
  const skilled = clamp01(skill / SKILL_SATURATION);
  const sharp = 1 - clamp01(bandWidthMw / capacityMw);
  const complete = 1 - clamp01(maskedFraction);
  const score = skilled * sharp * complete;

  // A band wider than the forecast it surrounds is not a refinement of that
  // forecast, it is a statement that output could be almost anything. The smooth
  // sharpness term above is measured against capacity and would still call that
  // respectable on a large plant, so the cap is a separate hard rule.
  const uninformative = bandWidthMw > Math.abs(forecastMw);
  const label = uninformative || score < MEDIUM_CONFIDENCE
    ? CONFIDENCE.LOW
    : score >= HIGH_CONFIDENCE ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;
  return { score, label };
}

// Returns the signal and which rule produced it, because "hold" for want of
// skill, for want of a distinguishable move and for want of money are three
// different statements and only the first is about the model being poor.
function classify({ skillScore, referenceMw, bandLo, bandHi, expectedDollars }) {
  // A model that cannot beat assuming nothing changes has nothing to say about
  // what will change. No price makes that forecast actionable.
  if (skillScore <= 0) return { signal: SIGNAL.WATCH, reason: 'no_skill' };

  // If carrying on as it is sits inside the band, the forecast does not
  // distinguish the move from doing nothing at its own stated coverage.
  if (referenceMw >= bandLo && referenceMw <= bandHi) {
    return { signal: SIGNAL.HOLD, reason: 'inside_band' };
  }

  if (Math.abs(expectedDollars) < MATERIAL_DOLLARS) {
    return { signal: SIGNAL.HOLD, reason: 'immaterial' };
  }

  // Sign, not direction of output: generating more into a negative price is a
  // risk and generating less into one is an opportunity, which falls out of the
  // dollar figure without a separate rule.
  return { signal: expectedDollars > 0 ? SIGNAL.OPPORTUNITY : SIGNAL.RISK, reason: 'move' };
}

function rationaleFor({ subject, reason, evidence, deltaMw, expectedDollars, constrainedClause }) {
  const window = horizonProse(evidence.skill_horizon);
  let core;
  if (reason === 'no_skill') {
    core = `${subject} is not being called over ${window} because the model still does not forecast `
      + 'it any better than assuming output stays where it is';
  } else if (reason === 'inside_band') {
    // Naming the band rather than calling the gap small: on a fleet-sized
    // aggregate the gap can be hundreds of megawatts and still be inside it.
    core = `${subject} is forecast at ${mwText(evidence.forecast_mw)} MW over ${window}, which its `
      + `own ${pctText(evidence.band_coverage)} uncertainty range cannot tell apart from the `
      + `${mwText(evidence.reference_mw)} MW it is producing now`;
  } else if (reason === 'immaterial') {
    core = `${subject} is forecast to move ${mwText(Math.abs(deltaMw))} MW over ${window}, `
      + `worth about ${dollarText(Math.abs(expectedDollars))} at the assumed `
      + `${dollarText(evidence.price_assumption)}/MWh and not enough to act on`;
  } else {
    const direction = deltaMw > 0 ? 'more' : 'less';
    const worth = expectedDollars >= 0 ? 'worth about' : 'costing about';
    core = `${subject} is forecast to generate ${mwText(Math.abs(deltaMw))} MW ${direction} over `
      + `${window} than it is now, ${worth} ${dollarText(Math.abs(expectedDollars))} at the assumed `
      + `${dollarText(evidence.price_assumption)}/MWh`;
  }
  return `${core}${constrainedClause}.`;
}

// The single place a signal is decided. It reads the evidence object and nothing
// else, which is what makes the evidence contract structural rather than a
// promise: there is no input the decision could use that the reader cannot see.
function assemble({ scope, id, name, region, subject, constrained, constrainedClause, evidence }) {
  const horizon = evidence.skill_horizon;
  const deltaMw = evidence.forecast_mw - evidence.reference_mw;
  const expectedDollars = deltaMw * horizonHours(horizon) * evidence.price_assumption;
  const { label } = deriveConfidence({
    skill: evidence.skill_score,
    bandWidthMw: evidence.band_hi - evidence.band_lo,
    forecastMw: evidence.forecast_mw,
    capacityMw: evidence.capacity_mw,
    maskedFraction: evidence.masked_fraction,
  });
  const { signal, reason } = classify({
    skillScore: evidence.skill_score,
    referenceMw: evidence.reference_mw,
    bandLo: evidence.band_lo,
    bandHi: evidence.band_hi,
    expectedDollars,
  });
  return {
    scope,
    id,
    name,
    region,
    signal,
    confidence: label,
    horizon,
    rationale: rationaleFor({
      subject,
      reason,
      evidence,
      deltaMw,
      expectedDollars,
      constrainedClause: constrained ? constrainedClause : '',
    }),
    evidence,
    constrained,
    expected_dollars: expectedDollars,
  };
}

/**
 * A signal for one station at one horizon.
 *
 * `skill.horizon` must be the horizon being forecast. Quoting the five-minute
 * skill beside a six-hour forecast is not weaker evidence, it is the wrong
 * number, and it is exactly the sort of mismatch nothing downstream would catch.
 *
 * @param {object} inputs
 * @param {{station_id: string, station_name: ?string, region: string, capacity_mw: number,
 *          curve: ?{rmse: number}}} inputs.station registry record with its fitted
 *          physical curve, or a null curve for a station that has none
 * @param {{mw: number, reference_mw: number, horizon: string, generated_at: number}} inputs.forecast
 *          point forecast, the output it is measured against (persistence), and the
 *          UTC epoch millisecond stamp it was issued at
 * @param {{lo: number, hi: number, coverage: number}} inputs.band conformal interval and its
 *          realised coverage
 * @param {{rrp: number}} inputs.priceForecast assumed regional price in $/MWh, which may be negative
 * @param {{skill: number, horizon: string, n: number, weights: Object<string, number>}} inputs.skill
 *          the backtest row for this station at this horizon
 * @param {{masked_fraction: number, curtailed_producing_fraction: number}} inputs.curtailmentRisk
 *          share of recent intervals dropped from learning, and share of recent
 *          intervals with output that were under a semi-dispatch cap
 * @returns {{scope: string, id: string, name: ?string, region: string, signal: string,
 *            confidence: string, horizon: string, rationale: string, evidence: object,
 *            constrained: boolean, expected_dollars: number}}
 */
export function stationSignal({ station, forecast, band, priceForecast, skill, curtailmentRisk }) {
  if (skill.horizon !== forecast.horizon) {
    throw new TypeError(
      `skill horizon ${skill.horizon} does not match forecast horizon ${forecast.horizon}`,
    );
  }
  const curtailedFraction = finite(
    curtailmentRisk.curtailed_producing_fraction, 'curtailmentRisk.curtailed_producing_fraction',
  );
  const constrained = curtailedFraction > CONSTRAINED_FRACTION;

  const evidence = {
    forecast_mw: finite(forecast.mw, 'forecast.mw'),
    band_lo: finite(band.lo, 'band.lo'),
    band_hi: finite(band.hi, 'band.hi'),
    band_coverage: finite(band.coverage, 'band.coverage'),
    price_assumption: finite(priceForecast.rrp, 'priceForecast.rrp'),
    skill_score: finite(skill.skill, 'skill.skill'),
    skill_horizon: skill.horizon,
    // Copied, so that re-running the backtest cannot silently rewrite the
    // reasoning behind a signal that has already been issued.
    expert_weights: { ...skill.weights },
    masked_fraction: finite(curtailmentRisk.masked_fraction, 'curtailmentRisk.masked_fraction'),
    // Null where no curve was fitted at all — thermal and hydro plant have no
    // weather-to-power curve to fit. Reporting a number there would invent one.
    curve_rmse: station.curve ? finite(station.curve.rmse, 'station.curve.rmse') : null,
    n_intervals_scored: finite(skill.n, 'skill.n'),
    generated_at: finite(forecast.generated_at, 'forecast.generated_at'),
    reference_mw: finite(forecast.reference_mw, 'forecast.reference_mw'),
    capacity_mw: finite(station.capacity_mw, 'station.capacity_mw'),
    curtailed_producing_fraction: curtailedFraction,
  };

  return assemble({
    scope: 'station',
    id: station.station_id,
    name: station.station_name,
    region: station.region,
    subject: station.station_name || station.station_id,
    constrained,
    constrainedClause: '; it is constrained, capped in '
      + `${pctText(curtailedFraction)} of its recent producing intervals, so the market, `
      + 'not the weather, is setting its output',
    evidence,
  });
}

/**
 * One signal for a whole region, aggregated from its station signals.
 *
 * Band edges are summed rather than added in quadrature. Independence would give
 * a narrower and more flattering regional band, but regional forecast errors are
 * not independent — the same wind lull or cloud bank misses every farm in the
 * region at once — so summing is the honest combination.
 *
 * @param {object[]} stationSignals outputs of stationSignal, all at one horizon and one region
 * @param {{region: string, rrp: number}} regionPrice assumed regional price in $/MWh
 * @returns {object} the same shape stationSignal returns, with scope 'region'
 */
export function regionSignal(stationSignals, regionPrice) {
  if (!stationSignals.length) throw new TypeError('regionSignal needs at least one station signal');

  const horizon = stationSignals[0].horizon;
  for (const s of stationSignals) {
    if (s.horizon !== horizon) {
      throw new TypeError(`cannot aggregate mixed horizons: ${horizon} and ${s.horizon}`);
    }
    if (s.region !== regionPrice.region) {
      throw new TypeError(`station ${s.id} is in ${s.region}, not ${regionPrice.region}`);
    }
  }

  const capacityMw = stationSignals.reduce((a, s) => a + s.evidence.capacity_mw, 0);
  // Capacity-weighted, because a 500 MW farm's skill matters more to the
  // regional total than a 20 MW one's, and an unweighted mean would let the
  // smallest plant in the region set the tone.
  const weighted = (pick) => stationSignals
    .reduce((a, s) => a + pick(s.evidence) * s.evidence.capacity_mw, 0) / capacityMw;
  const sum = (pick) => stationSignals.reduce((a, s) => a + pick(s.evidence), 0);

  const expertWeights = {};
  for (const s of stationSignals) {
    for (const [name, w] of Object.entries(s.evidence.expert_weights)) {
      expertWeights[name] = (expertWeights[name] ?? 0) + (w * s.evidence.capacity_mw) / capacityMw;
    }
  }

  const curved = stationSignals.filter((s) => s.evidence.curve_rmse !== null);
  const constrainedCapacity = stationSignals
    .filter((s) => s.constrained)
    .reduce((a, s) => a + s.evidence.capacity_mw, 0);

  const evidence = {
    forecast_mw: sum((e) => e.forecast_mw),
    band_lo: sum((e) => e.band_lo),
    band_hi: sum((e) => e.band_hi),
    // The weakest guarantee in the set, since the aggregate cannot cover better
    // than its worst-calibrated member.
    band_coverage: Math.min(...stationSignals.map((s) => s.evidence.band_coverage)),
    price_assumption: finite(regionPrice.rrp, 'regionPrice.rrp'),
    skill_score: weighted((e) => e.skill_score),
    skill_horizon: horizon,
    expert_weights: expertWeights,
    masked_fraction: weighted((e) => e.masked_fraction),
    // A capacity-weighted mean of the constituent fits, not the error of the
    // regional sum: it says how well the fleet's curves fit, and null when no
    // station in the region has a curve at all.
    curve_rmse: curved.length
      ? curved.reduce((a, s) => a + s.evidence.curve_rmse * s.evidence.capacity_mw, 0)
        / curved.reduce((a, s) => a + s.evidence.capacity_mw, 0)
      : null,
    // The regional claim is only as well evidenced as its least-scored member.
    n_intervals_scored: Math.min(...stationSignals.map((s) => s.evidence.n_intervals_scored)),
    // An aggregate is as stale as its oldest input.
    generated_at: Math.min(...stationSignals.map((s) => s.evidence.generated_at)),
    reference_mw: sum((e) => e.reference_mw),
    capacity_mw: capacityMw,
    curtailed_producing_fraction: weighted((e) => e.curtailed_producing_fraction),
  };

  return assemble({
    scope: 'region',
    id: regionPrice.region,
    name: regionPrice.region,
    region: regionPrice.region,
    subject: `The ${regionPrice.region} fleet`,
    constrained: constrainedCapacity > CONSTRAINED_FRACTION * capacityMw,
    constrainedClause: '; most of that capacity is constrained, so the market, not the weather, '
      + 'is setting its output',
    evidence,
  });
}

/**
 * Order signals by how much money is at stake, largest first.
 *
 * By dollars rather than percentage on purpose: a 2% move on a 500 MW farm is
 * worth ten times a 20% move on a 20 MW one, and a percentage ranking puts the
 * small farm on top every time.
 *
 * @param {object[]} signals outputs of stationSignal or regionSignal
 * @param {number} [limit] how many to keep
 * @returns {object[]} a new array, most material first
 */
export function rankSignals(signals, limit = signals.length) {
  return [...signals]
    .sort((a, b) => Math.abs(b.expected_dollars) - Math.abs(a.expected_dollars))
    .slice(0, limit);
}
