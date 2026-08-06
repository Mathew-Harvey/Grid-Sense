// What a station's output was actually worth, and what its curtailment cost.
//
// Two conversions carry nearly every mistake made in this subject.
//
// The first is energy. RRP is dollars per megawatt-HOUR and dispatch reports
// megaWATTS, so a five-minute interval settles on one twelfth of the power
// figure. MW multiplied by price comes out twelve times too large and still
// looks exactly like money, which is why it survives a reading. The conversion
// is written once, in intervalEnergyMwh, and every dollar figure below goes
// through it.
//
// The second is the sign of spilled energy. Curtailment at a positive price is
// revenue forgone; curtailment at a negative price is a loss avoided, and
// through a mild spring afternoon in South Australia the negative intervals are
// most of the spill. Summed together they cancel; reported as loss alone they
// invert the economics of the entire afternoon. lostRevenue and savedRevenue
// therefore stay apart and are never netted without both being shown.
//
// Nothing here clips a negative price or a negative revenue. The market floor
// is -$1,000/MWh and a semi-scheduled farm still running into it genuinely loses
// money; a max(0, ...) anywhere in this file would delete the most interesting
// thing in the record.
//
// Every return carries an `assumptions` object naming the price basis it used.
// A revenue figure with no stated basis cannot be audited, and two figures on
// different bases cannot be added together.

const MINUTES_PER_HOUR = 60;
const DEFAULT_INTERVAL_MINUTES = 5;

/** What an unqualified dollar figure from this module means. */
export const SPOT_ENERGY_BASIS =
  'dispatch spot RRP, energy only: no FCAS, no certificates, no network or '
  + 'market charges, and no PPA or hedge cover applied';

function finite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${what} must be a finite number, got ${value}`);
  }
  return value;
}

/**
 * Energy delivered by an average power held over an interval.
 *
 * The single place megawatts become megawatt-hours. Every dollar figure in this
 * module passes through here.
 *
 * @param {number} outputMw average power over the interval, signed
 * @param {number} [intervalMinutes=5] length of the dispatch interval
 * @returns {number} MWh
 */
export function intervalEnergyMwh(outputMw, intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  finite(outputMw, 'outputMw');
  // A zero or negative interval length silently produces zero or negated
  // energy, and the revenue built on it looks like an ordinary quiet day.
  if (!(intervalMinutes > 0)) {
    throw new RangeError(`intervalMinutes must be positive, got ${intervalMinutes}`);
  }
  // Multiplied before dividing, so the ratio rounds once rather than twice and
  // a day of intervals sums to the same figure as the day taken whole.
  return outputMw * intervalMinutes / MINUTES_PER_HOUR;
}

/**
 * Revenue earned by one interval of output at one price.
 *
 * @param {{outputMw: number, rrp: number, intervalMinutes?: number}} interval
 * @returns {number} dollars, negative when the price is negative
 */
export function intervalRevenue({ outputMw, rrp, intervalMinutes = DEFAULT_INTERVAL_MINUTES }) {
  return intervalEnergyMwh(outputMw, intervalMinutes) * finite(rrp, 'rrp');
}

/**
 * Dollars per MW of installed capacity — the normaliser that lets a 40 MW farm
 * and a 700 MW station sit on one axis.
 *
 * @param {number} revenue dollars
 * @param {number} capacityMw registered capacity
 * @returns {number} dollars per MW installed
 */
export function revenuePerMwCapacity(revenue, capacityMw) {
  // Most of the station registry carries a null capacity — aggregated loads and
  // registrations with no plant behind them. Divided by null this returns
  // Infinity, which in a chart quietly rescales the axis until every honest bar
  // is flat, and in a table reads as a spectacularly profitable station.
  if (!Number.isFinite(capacityMw) || capacityMw <= 0) {
    throw new TypeError(`revenuePerMwCapacity needs a positive capacityMw, got ${capacityMw}`);
  }
  return finite(revenue, 'revenue') / capacityMw;
}

// An intervened interval is published twice: the physical dispatch run and the
// pricing run AEMO actually settles on. Keeping both prices the interval twice;
// keeping the dispatch run values it at a price nobody was ever paid.
function settlementPrice(a, b, region, settlementMs) {
  if (a.intervention === 0 && b.intervention === 1) return a;
  if (b.intervention === 0 && a.intervention === 1) return b;
  throw new Error(
    `Two price rows for ${region} at ${settlementMs} and neither is marked as `
    + 'the pricing case; choosing either would be a guess and keeping both '
    + 'double counts the interval.'
  );
}

function indexPrices(prices, wantedRegion) {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new RangeError('No price rows supplied; nothing can be valued without them.');
  }

  const regions = new Set();
  for (const row of prices) regions.add(row.region);

  let region = wantedRegion;
  if (region === undefined || region === null) {
    // Regional prices diverge the moment an interconnector binds, and the
    // divergence is largest exactly when the money is largest. Picking a region
    // out of a mixed list would not be an approximation, it would be a guess.
    if (regions.size > 1) {
      throw new Error(
        `Prices for ${[...regions].sort().join(', ')} were supplied together and `
        + 'nothing says which region this station sits in; pass opts.region.'
      );
    }
    region = [...regions][0];
  }

  const byInterval = new Map();
  for (const row of prices) {
    if (row.region !== region) continue;
    const key = row.settlement_ms;
    if (!Number.isFinite(key)) {
      throw new TypeError(`Price row for ${region} has no usable settlement_ms: ${key}`);
    }
    const seen = byInterval.get(key);
    byInterval.set(key, seen === undefined ? row : settlementPrice(seen, row, region, key));
  }

  if (byInterval.size === 0) {
    throw new Error(
      `No price rows for region ${region}; the supplied prices cover `
      + `${[...regions].sort().join(', ')}.`
    );
  }

  return { region, byInterval };
}

// Prices key on the settlement stamp because that is the interval's identity.
// The output figure in a row stamped T was telemetered as T began, so its
// observed_at sits five minutes earlier; joining on that would pay every
// interval its predecessor's price. The offset is small enough that the totals
// still look plausible, which is exactly why it has to be refused outright.
function settlementOf(obs) {
  const ms = obs.settlement_ms;
  if (!Number.isFinite(ms)) {
    throw new TypeError(
      'Every observation needs settlement_ms to be priced. observed_at cannot '
      + 'stand in: for a start-of-interval snapshot it lands five minutes before '
      + 'the interval that settles it.'
    );
  }
  return ms;
}

/**
 * Value a station's output interval by interval against regional spot price.
 *
 * The number worth reading is meanCapturedPrice: revenue divided by energy, not
 * the mean of the RRPs. A wind farm generates hardest when the wind is up, which
 * is when every other wind farm in the region is also generating hardest and the
 * price is on the floor, so what it captures runs well below what the region
 * averaged. That gap is the whole economics of the fleet, and a mean RRP hides
 * it completely.
 *
 * Observations without a matching price are skipped rather than valued at zero,
 * and counted in the assumptions so the total can be audited for coverage.
 *
 * @param {{settlement_ms: number, output_mw: number}[]} observations
 * @param {{settlement_ms: number, region: string, rrp: number, apc_flag?: number}[]} prices
 * @param {{region?: string, intervalMinutes?: number, priceBasis?: string, stationId?: string}} [opts]
 * @returns {{total: number, energyMwh: number, byInterval: object[], negativeHours: number,
 *   revenueAtNegativePrices: number, meanRrp: number|null, meanCapturedPrice: number|null,
 *   region: string, stationId: string|null, assumptions: object}}
 */
export function stationRevenue(observations, prices, opts = {}) {
  const intervalMinutes = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const priceBasis = opts.priceBasis ?? SPOT_ENERGY_BASIS;
  const { region, byInterval: priceAt } = indexPrices(prices, opts.region);

  const byInterval = [];
  let rrpSum = 0;
  let negativeIntervals = 0;
  let unpriced = 0;
  let administered = 0;

  for (const obs of observations) {
    const settlementMs = settlementOf(obs);
    const price = priceAt.get(settlementMs);
    if (price === undefined) { unpriced++; continue; }

    const outputMw = finite(obs.output_mw, `output_mw at ${settlementMs}`);
    const rrp = finite(price.rrp, `rrp for ${region} at ${settlementMs}`);
    const energyMwh = intervalEnergyMwh(outputMw, intervalMinutes);

    rrpSum += rrp;
    if (rrp < 0) negativeIntervals++;
    if (price.apc_flag) administered++;

    byInterval.push({
      settlement_ms: settlementMs,
      outputMw,
      rrp,
      energyMwh,
      revenue: energyMwh * rrp,
      apcFlag: Boolean(price.apc_flag),
    });
  }

  // Totalled from the same array that is returned, so a caller who sums the
  // intervals by hand gets the headline figure back to the last bit rather than
  // to a tolerance.
  let total = 0;
  let energyMwh = 0;
  let revenueAtNegativePrices = 0;
  for (const row of byInterval) {
    total += row.revenue;
    energyMwh += row.energyMwh;
    if (row.rrp < 0) revenueAtNegativePrices += row.revenue;
  }

  return {
    total,
    energyMwh,
    byInterval,
    // Exposure to the negative price, whether or not the station was generating
    // through it: an hour of floor prices is a fact about the region.
    negativeHours: negativeIntervals * intervalMinutes / MINUTES_PER_HOUR,
    revenueAtNegativePrices,
    meanRrp: byInterval.length === 0 ? null : rrpSum / byInterval.length,
    // A station that sent out nothing has no captured price. Zero would read as
    // "captured $0/MWh", which is a claim about a trade that never happened.
    meanCapturedPrice: energyMwh === 0 ? null : total / energyMwh,
    region,
    stationId: opts.stationId ?? null,
    assumptions: {
      priceBasis,
      region,
      intervalMinutes,
      energyBasis: 'output_mw held flat across each interval',
      capturedPriceBasis: 'total revenue divided by total energy, not the mean RRP',
      intervalsPriced: byInterval.length,
      intervalsUnpriced: unpriced,
      administeredPriceIntervals: administered,
    },
  };
}

const CURTAILMENT_REASONS = ['negative_price', 'dispatch_cap', 'unknown_cap', 'unexplained'];

/**
 * What the energy a station was not allowed to produce was worth.
 *
 * Curtailed energy is the gap between what the plant could have made — UIGF,
 * AEMO's own unconstrained forecast for it — and what dispatch cleared. Whether
 * that gap is a loss depends entirely on the price: above zero the station gave
 * up revenue, below zero it was excused from paying to generate, and the second
 * case is not a smaller version of the first. Both are returned, gross, and the
 * netCost figure is the difference rather than the only number offered.
 *
 * Intervals whose curtailment mask is not yet known are attributed to
 * `unknown_cap` rather than assumed unconstrained, because the mask arrives with
 * the next-day unit solution and a live interval simply does not have it.
 *
 * @param {{settlement_ms: number, uigf_mw: number|null, cleared_mw: number, capped?: boolean}[]} observations
 * @param {{settlement_ms: number, region: string, rrp: number}[]} prices
 * @param {{region?: string, intervalMinutes?: number, priceBasis?: string}} [opts]
 * @returns {{curtailedMwh: number, lostMwh: number, lostRevenue: number, savedMwh: number,
 *   savedRevenue: number, netCost: number, byReason: object, assumptions: object}}
 */
export function curtailmentCost(observations, prices, opts = {}) {
  const intervalMinutes = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const priceBasis = opts.priceBasis ?? SPOT_ENERGY_BASIS;
  const { region, byInterval: priceAt } = indexPrices(prices, opts.region);

  const byReason = {};
  for (const reason of CURTAILMENT_REASONS) {
    byReason[reason] = { intervals: 0, mwh: 0, lostRevenue: 0, savedRevenue: 0 };
  }

  let curtailedMwh = 0;
  let lostMwh = 0;
  let lostRevenue = 0;
  let savedMwh = 0;
  let savedRevenue = 0;
  let unpriced = 0;
  let withoutUigf = 0;

  for (const obs of observations) {
    const settlementMs = settlementOf(obs);
    const price = priceAt.get(settlementMs);
    if (price === undefined) { unpriced++; continue; }

    // UIGF is published with the next-day unit solution, so a live interval has
    // no unconstrained forecast to subtract from. Treating a missing one as zero
    // would report the station's entire output as negative curtailment.
    if (obs.uigf_mw === null || obs.uigf_mw === undefined) { withoutUigf++; continue; }

    const uigf = finite(obs.uigf_mw, `uigf_mw at ${settlementMs}`);
    const cleared = finite(obs.cleared_mw, `cleared_mw at ${settlementMs}`);
    const spillMw = uigf - cleared;
    // Dispatch clearing at or above the unconstrained forecast is rounding or a
    // late forecast revision, not negative curtailment.
    if (spillMw <= 0) continue;

    const rrp = finite(price.rrp, `rrp for ${region} at ${settlementMs}`);
    const mwh = intervalEnergyMwh(spillMw, intervalMinutes);
    const value = mwh * rrp;
    const bucket = byReason[reasonFor(obs, rrp)];

    curtailedMwh += mwh;
    bucket.intervals++;
    bucket.mwh += mwh;

    if (rrp > 0) {
      lostMwh += mwh;
      lostRevenue += value;
      bucket.lostRevenue += value;
    } else if (rrp < 0) {
      savedMwh += mwh;
      savedRevenue -= value;
      bucket.savedRevenue -= value;
    }
    // Spill at exactly zero counts as curtailed energy and as neither loss nor
    // saving, which is what it was worth.
  }

  return {
    curtailedMwh,
    lostMwh,
    lostRevenue,
    savedMwh,
    savedRevenue,
    netCost: lostRevenue - savedRevenue,
    byReason,
    assumptions: {
      priceBasis,
      region,
      intervalMinutes,
      curtailmentBasis: 'UIGF minus cleared MW, floored at zero per interval',
      lossBasis: 'lost only where RRP > 0; spill at RRP < 0 is reported as savedRevenue',
      intervalsUnpriced: unpriced,
      intervalsWithoutUigf: withoutUigf,
    },
  };
}

// The strict === false matters. Curtailment is only known once the next-day unit
// solution lands, so a live interval carries an unknown mask, and an unknown mask
// is not the same claim as "not constrained".
function reasonFor(obs, rrp) {
  if (rrp < 0) return 'negative_price';
  if (obs.capped === true) return 'dispatch_cap';
  if (obs.capped === false) return 'unexplained';
  return 'unknown_cap';
}

function normalisePriceAssumption(priceAssumption) {
  if (typeof priceAssumption === 'number') {
    return {
      rrp: finite(priceAssumption, 'priceAssumption'),
      basis: `flat $${priceAssumption}/MWh across every forecast interval`,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }
  if (priceAssumption === null || typeof priceAssumption !== 'object') {
    throw new TypeError(
      'priceAssumption must be a price in $/MWh or {rrp, basis, intervalMinutes}; '
      + `got ${priceAssumption}`
    );
  }
  const rrp = finite(priceAssumption.rrp, 'priceAssumption.rrp');
  return {
    rrp,
    basis: priceAssumption.basis ?? `flat $${rrp}/MWh across every forecast interval`,
    intervalMinutes: priceAssumption.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
  };
}

function checkedQuantiles(forecastQuantiles) {
  if (!Array.isArray(forecastQuantiles) || forecastQuantiles.length === 0) {
    throw new RangeError('forecastRevenue needs at least one generation quantile');
  }
  const sorted = [...forecastQuantiles].sort((a, b) => a.q - b.q);
  for (let i = 0; i < sorted.length; i++) {
    const { q, v } = sorted[i];
    finite(q, 'quantile level');
    finite(v, `quantile value at q=${q}`);
    if (q <= 0 || q >= 1) throw new RangeError(`quantile level must lie in (0,1), got ${q}`);
    if (i === 0) continue;
    if (q === sorted[i - 1].q) throw new RangeError(`quantile level ${q} supplied twice`);
    // Crossed quantiles make the band's own p10 exceed its p90, and the revenue
    // map preserves the crossing, so a fan chart drawn from it folds over itself.
    if (v < sorted[i - 1].v) {
      throw new RangeError(
        `generation quantiles cross: q=${sorted[i - 1].q} gives ${sorted[i - 1].v} MW `
        + `but q=${q} gives ${v} MW`
      );
    }
  }
  return sorted;
}

// Mean of a distribution known only at quantile knots: each knot holds the mass
// nearer to it than to its neighbours, and the outer knots hold their tails
// whole. Beyond the outermost level the forecast genuinely says nothing about
// shape, and extrapolating one is how a tail invents money.
function quantileMean(quantiles) {
  const n = quantiles.length;
  if (n === 1) return quantiles[0].v;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const lower = i === 0 ? 0 : (quantiles[i - 1].q + quantiles[i].q) / 2;
    const upper = i === n - 1 ? 1 : (quantiles[i].q + quantiles[i + 1].q) / 2;
    mean += quantiles[i].v * (upper - lower);
  }
  return mean;
}

function quantileAt(quantiles, level) {
  const last = quantiles.length - 1;
  if (level <= quantiles[0].q) return quantiles[0].v;
  if (level >= quantiles[last].q) return quantiles[last].v;
  for (let i = 1; i <= last; i++) {
    const lo = quantiles[i - 1];
    const hi = quantiles[i];
    if (level <= hi.q) return lo.v + (hi.v - lo.v) * (level - lo.q) / (hi.q - lo.q);
  }
  return quantiles[last].v;
}

/**
 * Turn a generation forecast band into a revenue band at a stated price.
 *
 * The uncertainty carried here is the generation uncertainty and nothing else.
 * Taking the p90 of generation against the p90 of price is the tempting move and
 * it produces a number with no interpretation at all: two independent tails
 * multiplied together describe an outcome far rarer than 10%, and the band drawn
 * from it is wider than any belief anyone holds. The price is held fixed, the
 * generation quantiles are mapped through it, and the assumption is returned
 * alongside the answer so nobody has to guess which price was used.
 *
 * A negative price assumption reverses the map — the least generation becomes
 * the best outcome — so the revenue quantiles are relabelled rather than
 * multiplied in place. Without that, p10 and p90 swap and the band inverts.
 *
 * @param {{q: number, v: number}[]} forecastQuantiles generation in MW by level
 * @param {number|{rrp: number, basis?: string, intervalMinutes?: number}} priceAssumption $/MWh
 * @param {number} capacityMw registered capacity, used to bound the band
 * @returns {{expected: number, p10: number, p90: number, perMwCapacity: number, assumptions: object}}
 */
export function forecastRevenue(forecastQuantiles, priceAssumption, capacityMw) {
  if (!Number.isFinite(capacityMw) || capacityMw <= 0) {
    throw new TypeError(`forecastRevenue needs a positive capacityMw, got ${capacityMw}`);
  }

  const { rrp, basis, intervalMinutes } = normalisePriceAssumption(priceAssumption);
  const generation = checkedQuantiles(forecastQuantiles);

  // A band running past nameplate or below zero asserts probability on outcomes
  // the machine cannot produce, and it is revenue on that impossible part which
  // would flatter the expectation.
  const bounded = generation.map(({ q, v }) => ({ q, v: Math.min(Math.max(v, 0), capacityMw) }));

  const dollarsPerMw = intervalEnergyMwh(1, intervalMinutes) * rrp;
  const revenue = dollarsPerMw >= 0
    ? bounded.map(({ q, v }) => ({ q, v: v * dollarsPerMw }))
    : bounded.map(({ q, v }) => ({ q: 1 - q, v: v * dollarsPerMw })).sort((a, b) => a.q - b.q);

  const expected = quantileMean(revenue);

  return {
    expected,
    p10: quantileAt(revenue, 0.1),
    p90: quantileAt(revenue, 0.9),
    perMwCapacity: revenuePerMwCapacity(expected, capacityMw),
    assumptions: {
      priceBasis: basis,
      rrp,
      intervalMinutes,
      capacityMw,
      uncertainty: 'generation only; the price is held fixed across every quantile',
      generationQuantiles: bounded.length,
      expectationBasis: 'mass-weighted mean of the supplied quantiles, tails held flat',
    },
  };
}

/**
 * Unrealised gain or loss on an open position.
 *
 * The position is energy in MWh, not power in MW. A position quoted in MW has to
 * go through intervalEnergyMwh first, for the same reason revenue does.
 *
 * @param {number} positionMwh signed: positive is long, negative is short
 * @param {number} currentPrice $/MWh
 * @param {number} entryPrice $/MWh
 * @returns {number} dollars
 */
export function markToMarket(positionMwh, currentPrice, entryPrice) {
  finite(positionMwh, 'positionMwh');
  finite(currentPrice, 'currentPrice');
  finite(entryPrice, 'entryPrice');
  return positionMwh * (currentPrice - entryPrice);
}

/**
 * Roll station results up to their regions.
 *
 * Two of the station figures do not add. Captured price is a ratio, so a region's
 * is total revenue over total energy — averaging the stations' own captured
 * prices weights a 5 MW farm the same as a 500 MW one. Negative hours are a
 * property of the regional price rather than of any station, so summing them
 * counts the same afternoon once per station in the region; the widest exposure
 * any single station recorded is reported instead.
 *
 * @param {ReturnType<typeof stationRevenue>[]} stationResults
 * @returns {{byRegion: object, total: number, energyMwh: number, assumptions: object}}
 */
export function regionRevenue(stationResults) {
  const byRegion = {};
  const bases = new Set();

  for (const result of stationResults) {
    const region = result.region;
    if (typeof region !== 'string' || region === '') {
      throw new TypeError(
        `Station result for ${result.stationId ?? 'an unnamed station'} carries no region; `
        + 'it cannot be aggregated into one.'
      );
    }

    const basis = result.assumptions?.priceBasis;
    bases.add(basis);

    let agg = byRegion[region];
    if (agg === undefined) {
      agg = {
        region,
        stations: 0,
        total: 0,
        energyMwh: 0,
        revenueAtNegativePrices: 0,
        negativeHours: 0,
        meanCapturedPrice: null,
        assumptions: { priceBasis: basis, region },
      };
      byRegion[region] = agg;
    }

    // Adding spot revenue to contracted revenue produces a figure that describes
    // no station and cannot be audited back to a price.
    if (agg.assumptions.priceBasis !== basis) {
      throw new Error(
        `Stations in ${region} were valued on different price bases `
        + `(${agg.assumptions.priceBasis} and ${basis}); the two do not add up.`
      );
    }

    agg.stations++;
    agg.total += result.total;
    agg.energyMwh += result.energyMwh;
    agg.revenueAtNegativePrices += result.revenueAtNegativePrices;
    agg.negativeHours = Math.max(agg.negativeHours, result.negativeHours);
  }

  let total = 0;
  let energyMwh = 0;
  for (const agg of Object.values(byRegion)) {
    agg.meanCapturedPrice = agg.energyMwh === 0 ? null : agg.total / agg.energyMwh;
    total += agg.total;
    energyMwh += agg.energyMwh;
  }

  return {
    byRegion,
    total,
    energyMwh,
    assumptions: {
      priceBasis: [...bases].join('; '),
      stations: stationResults.length,
      regions: Object.keys(byRegion).sort(),
      capturedPriceBasis: 'energy-weighted across the region, not the mean of station captured prices',
      negativeHoursBasis: 'the widest exposure of any one station, since every station in a region sees the same price',
    },
  };
}
