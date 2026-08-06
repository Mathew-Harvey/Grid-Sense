// Revenue, captured price and the economics of spilled energy.
//
// Every test here defends a number that would still look like money if it were
// wrong: twelve times too large, averaged instead of energy-weighted, or signed
// the wrong way round. None of them check that a function returned something.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intervalEnergyMwh, intervalRevenue, revenuePerMwCapacity,
  stationRevenue, curtailmentCost, forecastRevenue, markToMarket, regionRevenue,
  SPOT_ENERGY_BASIS,
} from '../app/js/revenue.js';

const STEP_MS = 300_000;
const T0 = Date.UTC(2026, 4, 8, 4, 5, 0);

function observations(outputs, extra = () => ({})) {
  return outputs.map((output_mw, i) => ({
    settlement_ms: T0 + i * STEP_MS,
    output_mw,
    ...extra(i),
  }));
}

function priceRows(rrps, region = 'SA1', extra = () => ({})) {
  return rrps.map((rrp, i) => ({
    settlement_ms: T0 + i * STEP_MS,
    observed_at: T0 + i * STEP_MS,
    region,
    rrp,
    apc_flag: 0,
    intervention: 0,
    ...extra(i),
  }));
}

// The conformal band's own levels, so the revenue band is tested on the shape it
// will actually be handed.
const BAND_LEVELS = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];

function symmetricBand(pointMw, halfWidthMw) {
  return BAND_LEVELS.map((q) => ({
    q,
    // Linear in level: enough to be a monotone band without pulling a normal
    // quantile function into a revenue test.
    v: pointMw + halfWidthMw * (2 * q - 1),
  }));
}

// --- 1. The MW-to-MWh conversion --------------------------------------------

test('a 5-minute interval settles on a twelfth of the power figure', () => {
  const revenue = intervalRevenue({ outputMw: 100, rrp: 100 });

  assert.ok(Math.abs(revenue - 2500 / 3) < 1e-9, `expected $833.33, got ${revenue}`);
  assert.notEqual(Math.round(revenue), 10_000);
  assert.equal(intervalEnergyMwh(100), 100 / 12);

  // A half-hour settlement interval is six times the energy of a five-minute one,
  // and the parameter has to actually reach the conversion for that to hold.
  assert.ok(Math.abs(intervalRevenue({ outputMw: 100, rrp: 100, intervalMinutes: 30 }) - 5000) < 1e-9);

  assert.throws(() => intervalEnergyMwh(100, 0), RangeError);
  assert.throws(() => intervalEnergyMwh(100, -5), RangeError);
  assert.throws(() => intervalRevenue({ outputMw: null, rrp: 100 }), TypeError);
});

// --- 2. Captured price against mean RRP -------------------------------------

test('a wind farm that blows when prices fall captures well under the mean RRP', () => {
  // One diurnal cycle in which output and price move exactly opposite: the farm
  // is at 95 MW when the region is paying $20 and at 5 MW when it is paying $100.
  const outputs = [];
  const rrps = [];
  for (let i = 0; i < 24; i++) {
    const swing = Math.sin(2 * Math.PI * i / 24);
    outputs.push(50 + 45 * swing);
    rrps.push(60 - 40 * swing);
  }

  const result = stationRevenue(observations(outputs), priceRows(rrps), { region: 'SA1' });

  assert.ok(Math.abs(result.meanRrp - 60) < 1e-9, `mean RRP ${result.meanRrp}`);
  assert.ok(Math.abs(result.meanCapturedPrice - 42) < 1e-9, `captured ${result.meanCapturedPrice}`);

  const gap = result.meanRrp - result.meanCapturedPrice;
  assert.ok(gap > 15, `captured price should sit well below the mean RRP, gap was ${gap}`);
  assert.ok(Math.abs(result.total - 4200) < 1e-9);
  assert.ok(Math.abs(result.energyMwh - 100) < 1e-9);

  // The same output at a flat price captures exactly that price, so the gap is a
  // property of the covariance and not an artefact of the weighting.
  const flat = stationRevenue(observations(outputs), priceRows(outputs.map(() => 60)), { region: 'SA1' });
  assert.ok(Math.abs(flat.meanCapturedPrice - 60) < 1e-9);
});

test('captured price is null rather than zero when nothing was sent out', () => {
  const result = stationRevenue(observations([0, 0, 0]), priceRows([50, 60, 70]), { region: 'SA1' });
  assert.equal(result.meanCapturedPrice, null);
  assert.equal(result.total, 0);
});

// --- 3. Curtailment at a negative price is money saved ----------------------

test('spill at a negative price is reported as saved, not lost', () => {
  const obs = observations([20, 20], () => ({ uigf_mw: 100, cleared_mw: 20, capped: true }));
  const result = curtailmentCost(obs, priceRows([-50, -50]), { region: 'SA1' });

  // 80 MW spilled twice is 13.333 MWh, and at -$50/MWh not producing it kept
  // $666.67 that would otherwise have been paid out.
  assert.ok(Math.abs(result.savedMwh - 160 / 12) < 1e-9);
  assert.ok(Math.abs(result.savedRevenue - 160 / 12 * 50) < 1e-9);
  assert.ok(result.savedRevenue > 0, 'saved revenue must be a positive saving');
  assert.equal(result.lostRevenue, 0);
  assert.equal(result.lostMwh, 0);
  assert.ok(result.netCost < 0, 'a wholly negative-price spill is a net gain');
  assert.equal(result.byReason.negative_price.intervals, 2);
  assert.equal(result.byReason.dispatch_cap.intervals, 0);
});

test('lost and saved curtailment are kept apart rather than netted', () => {
  const obs = observations([20, 20], () => ({ uigf_mw: 100, cleared_mw: 20, capped: true }));
  const result = curtailmentCost(obs, priceRows([100, -100]), { region: 'SA1' });

  const spillMwh = 80 / 12;
  assert.ok(Math.abs(result.lostRevenue - spillMwh * 100) < 1e-9);
  assert.ok(Math.abs(result.savedRevenue - spillMwh * 100) < 1e-9);
  assert.ok(Math.abs(result.netCost) < 1e-9, 'these two happen to cancel');
  assert.ok(result.curtailedMwh > 0, 'and the energy itself must still be visible');
  assert.equal(result.byReason.dispatch_cap.intervals, 1);
  assert.equal(result.byReason.negative_price.intervals, 1);
});

test('curtailment reasons separate a known cap from an unknown one', () => {
  const obs = [
    { settlement_ms: T0, uigf_mw: 100, cleared_mw: 40, capped: true },
    { settlement_ms: T0 + STEP_MS, uigf_mw: 100, cleared_mw: 40 },
    { settlement_ms: T0 + 2 * STEP_MS, uigf_mw: 100, cleared_mw: 40, capped: false },
    { settlement_ms: T0 + 3 * STEP_MS, uigf_mw: null, cleared_mw: 40, capped: true },
  ];
  const result = curtailmentCost(obs, priceRows([50, 50, 50, 50]), { region: 'SA1' });

  assert.equal(result.byReason.dispatch_cap.intervals, 1);
  assert.equal(result.byReason.unknown_cap.intervals, 1);
  assert.equal(result.byReason.unexplained.intervals, 1);
  assert.equal(result.assumptions.intervalsWithoutUigf, 1);
});

test('dispatch clearing above the unconstrained forecast is not negative curtailment', () => {
  const obs = observations([60], () => ({ uigf_mw: 50, cleared_mw: 60, capped: false }));
  const result = curtailmentCost(obs, priceRows([80]), { region: 'SA1' });
  assert.equal(result.curtailedMwh, 0);
  assert.equal(result.lostRevenue, 0);
  assert.equal(result.savedRevenue, 0);
});

// --- 4. The period equals the sum of its intervals ---------------------------

test('total revenue is the sum of its intervals, split any way', () => {
  const n = 864;
  const outputs = [];
  const rrps = [];
  for (let i = 0; i < n; i++) {
    outputs.push(137.437 + 62.31 * Math.sin(2 * Math.PI * i / 288));
    rrps.push(41.19 + 233.7 * Math.sin(2 * Math.PI * i / 97) - 60 * Math.cos(i / 11));
  }
  const obs = observations(outputs);
  const prices = priceRows(rrps);

  const whole = stationRevenue(obs, prices, { region: 'SA1' });
  assert.equal(whole.byInterval.length, n);
  assert.equal(new Set(whole.byInterval.map((r) => r.settlement_ms)).size, n);

  const summed = whole.byInterval.reduce((acc, r) => acc + r.revenue, 0);
  assert.equal(whole.total, summed);

  // Three consecutive slices have to add back to the whole. If any interval were
  // priced twice, or a boundary interval counted in both neighbours, this is
  // where it shows.
  const parts = [obs.slice(0, 288), obs.slice(288, 576), obs.slice(576)]
    .map((slice) => stationRevenue(slice, prices, { region: 'SA1' }));
  const partTotal = parts.reduce((acc, p) => acc + p.total, 0);
  const partEnergy = parts.reduce((acc, p) => acc + p.energyMwh, 0);

  assert.ok(Math.abs(partTotal - whole.total) < Math.abs(whole.total) * 1e-9,
    `${partTotal} against ${whole.total}`);
  assert.ok(Math.abs(partEnergy - whole.energyMwh) < Math.abs(whole.energyMwh) * 1e-9);
  assert.equal(parts.reduce((acc, p) => acc + p.byInterval.length, 0), n);
});

test('an interval with no price is skipped and counted, never valued at zero', () => {
  const obs = observations([100, 100, 100]);
  const result = stationRevenue(obs, priceRows([80, 80]), { region: 'SA1' });

  assert.equal(result.assumptions.intervalsPriced, 2);
  assert.equal(result.assumptions.intervalsUnpriced, 1);
  assert.ok(Math.abs(result.meanCapturedPrice - 80) < 1e-9,
    'an unpriced interval must not drag the captured price towards zero');
});

// --- 5. Negative prices are not clipped -------------------------------------

test('negative prices produce negative revenue all the way down', () => {
  assert.ok(Math.abs(intervalRevenue({ outputMw: 100, rrp: -1000 }) + 2500 / 3 * 10) < 1e-9);

  const rrps = [-45, -1000, -12, 30];
  const result = stationRevenue(observations([60, 60, 60, 60]), priceRows(rrps), { region: 'SA1' });

  assert.ok(result.total < 0, `a farm running through the floor loses money, got ${result.total}`);
  assert.ok(result.revenueAtNegativePrices < 0);
  assert.ok(Math.abs(result.negativeHours - 3 * 5 / 60) < 1e-12);
  assert.equal(result.byInterval.filter((r) => r.revenue < 0).length, 3);
  assert.equal(result.total, result.byInterval.reduce((a, r) => a + r.revenue, 0));
  assert.ok(result.meanCapturedPrice < 0);
});

// --- 6. The forecast revenue band -------------------------------------------

test('forecast revenue brackets its expectation and never inverts', () => {
  const bands = [
    symmetricBand(60, 25),
    symmetricBand(8, 30),
    symmetricBand(140, 4),
  ];
  const prices = [80, 0.5, -45, -900];

  for (const band of bands) {
    for (const rrp of prices) {
      const r = forecastRevenue(band, rrp, 150);
      assert.ok(r.p10 <= r.p90, `p10 ${r.p10} above p90 ${r.p90} at $${rrp}`);
      assert.ok(r.p10 <= r.expected + 1e-9 && r.expected <= r.p90 + 1e-9,
        `expected ${r.expected} outside [${r.p10}, ${r.p90}] at $${rrp}`);
      assert.equal(r.assumptions.rrp, rrp);
      assert.ok(typeof r.assumptions.priceBasis === 'string' && r.assumptions.priceBasis.length > 0);
    }
  }
});

test('a negative price assumption relabels the band rather than flipping it', () => {
  const band = symmetricBand(60, 25);
  const high = forecastRevenue(band, 100, 150);
  const low = forecastRevenue(band, -100, 150);

  // At $100 the p90 outcome is the windiest one; at -$100 the windiest outcome is
  // the worst that can happen, so the same generation quantile has to move to the
  // other end of the revenue band.
  assert.ok(Math.abs(high.p90 + low.p10) < 1e-9, `${high.p90} against ${low.p10}`);
  assert.ok(Math.abs(high.p10 + low.p90) < 1e-9);
  assert.ok(low.expected < 0);
  assert.ok(low.p10 < low.p90);
});

test('the forecast band is bounded by what the machine can physically do', () => {
  const overshooting = [
    { q: 0.1, v: -20 },
    { q: 0.5, v: 50 },
    { q: 0.9, v: 260 },
  ];
  const r = forecastRevenue(overshooting, 100, 100);

  // 100 MW for five minutes at $100/MWh is $833.33 and nothing above it exists.
  assert.ok(Math.abs(r.p90 - 2500 / 3) < 1e-9, `p90 ${r.p90}`);
  assert.equal(r.p10, 0);
});

test('crossed generation quantiles are refused rather than drawn folded over', () => {
  assert.throws(() => forecastRevenue([{ q: 0.1, v: 80 }, { q: 0.9, v: 20 }], 50, 100), RangeError);
  assert.throws(() => forecastRevenue([{ q: 0, v: 10 }, { q: 0.9, v: 20 }], 50, 100), RangeError);
  assert.throws(() => forecastRevenue([], 50, 100), RangeError);
});

// --- Capacity guard ---------------------------------------------------------

test('a null capacity throws instead of returning Infinity', () => {
  const band = symmetricBand(60, 25);

  assert.throws(() => forecastRevenue(band, 80, null), TypeError);
  assert.throws(() => forecastRevenue(band, 80, undefined), TypeError);
  assert.throws(() => forecastRevenue(band, 80, 0), TypeError);
  assert.throws(() => revenuePerMwCapacity(1000, null), TypeError);
  assert.throws(() => revenuePerMwCapacity(1000, 0), TypeError);

  assert.ok(Number.isFinite(forecastRevenue(band, 80, 150).perMwCapacity));
});

// --- Joining observations to prices -----------------------------------------

test('an observation without a settlement stamp cannot be priced', () => {
  const obs = [{ observed_at: T0 - STEP_MS, output_mw: 100 }];
  assert.throws(() => stationRevenue(obs, priceRows([80]), { region: 'SA1' }), TypeError);
});

test('mixed regions must be named, and the named one is the one used', () => {
  const prices = [...priceRows([20], 'SA1'), ...priceRows([200], 'QLD1')];
  const obs = observations([120]);

  assert.throws(() => stationRevenue(obs, prices), /which region/);

  const sa = stationRevenue(obs, prices, { region: 'SA1' });
  const qld = stationRevenue(obs, prices, { region: 'QLD1' });
  assert.ok(Math.abs(sa.total - 10 * 20) < 1e-9);
  assert.ok(Math.abs(qld.total - 10 * 200) < 1e-9);
  assert.equal(sa.assumptions.region, 'SA1');

  // A single-region price file needs no help identifying itself.
  assert.equal(stationRevenue(obs, priceRows([20], 'SA1')).region, 'SA1');
  assert.throws(() => stationRevenue(obs, prices, { region: 'VIC1' }), /No price rows for region VIC1/);
});

test('an intervened interval settles on the pricing case, not on both', () => {
  const dispatched = { ...priceRows([300])[0], intervention: 1 };
  const priced = { ...priceRows([90])[0], intervention: 0 };
  const obs = observations([120]);

  for (const order of [[dispatched, priced], [priced, dispatched]]) {
    const result = stationRevenue(obs, order, { region: 'SA1' });
    assert.equal(result.byInterval.length, 1);
    assert.ok(Math.abs(result.total - 10 * 90) < 1e-9);
  }

  assert.throws(() => stationRevenue(obs, [priced, { ...priced }], { region: 'SA1' }), /double counts/);
  assert.throws(() => stationRevenue(obs, [], { region: 'SA1' }), RangeError);
});

test('administered price intervals are counted so the total can be audited', () => {
  const prices = priceRows([600, 600], 'SA1', (i) => ({ apc_flag: i === 1 ? 1 : 0 }));
  const result = stationRevenue(observations([100, 100]), prices, { region: 'SA1' });
  assert.equal(result.assumptions.administeredPriceIntervals, 1);
  assert.equal(result.byInterval[1].apcFlag, true);
});

// --- Mark to market ---------------------------------------------------------

test('mark to market is signed by the direction of the position', () => {
  assert.equal(markToMarket(100, 90, 60), 3000);
  assert.equal(markToMarket(-100, 90, 60), -3000);
  assert.equal(markToMarket(100, 60, 60), 0);
  assert.equal(markToMarket(50, -30, 40), -3500);
  assert.throws(() => markToMarket(100, null, 60), TypeError);
});

// --- Regional roll-up -------------------------------------------------------

test('regional captured price is energy-weighted and negative hours are not summed', () => {
  const big = stationRevenue(
    observations([600, 600]),
    priceRows([100, 100], 'NSW1'),
    { region: 'NSW1', stationId: 'BIG' },
  );
  const small = stationRevenue(
    observations([10, 10]),
    priceRows([-40, -40], 'NSW1'),
    { region: 'NSW1', stationId: 'SMALL' },
  );
  const other = stationRevenue(
    observations([100, 100]),
    priceRows([50, 50], 'SA1'),
    { region: 'SA1', stationId: 'OTHER' },
  );

  const agg = regionRevenue([big, small, other]);
  const nsw = agg.byRegion.NSW1;

  assert.equal(nsw.stations, 2);
  assert.ok(Math.abs(nsw.total - (big.total + small.total)) < 1e-9);

  // The plain mean of $100 and -$40 is $30; energy-weighted it is $97.70,
  // because the 600 MW station carries sixty times the energy.
  const plainMean = (big.meanCapturedPrice + small.meanCapturedPrice) / 2;
  assert.ok(Math.abs(nsw.meanCapturedPrice - nsw.total / nsw.energyMwh) < 1e-12);
  assert.ok(nsw.meanCapturedPrice > 95, `energy-weighted capture was ${nsw.meanCapturedPrice}`);
  assert.ok(nsw.meanCapturedPrice - plainMean > 50);

  // Both stations saw the same two negative-price intervals, so the region was
  // exposed for ten minutes, not twenty.
  assert.ok(Math.abs(small.negativeHours - 2 * 5 / 60) < 1e-12);
  assert.ok(Math.abs(nsw.negativeHours - 2 * 5 / 60) < 1e-12);

  assert.deepEqual(agg.assumptions.regions, ['NSW1', 'SA1']);
  assert.ok(Math.abs(agg.total - (big.total + small.total + other.total)) < 1e-9);
});

test('stations valued on different price bases refuse to be added together', () => {
  const spot = stationRevenue(observations([100]), priceRows([50], 'VIC1'), { region: 'VIC1' });
  const contracted = stationRevenue(observations([100]), priceRows([50], 'VIC1'), {
    region: 'VIC1',
    priceBasis: 'contracted PPA strike price',
  });

  assert.equal(spot.assumptions.priceBasis, SPOT_ENERGY_BASIS);
  assert.throws(() => regionRevenue([spot, contracted]), /do not add up/);
  assert.throws(() => regionRevenue([{ ...spot, region: undefined }]), TypeError);
});

// --- The audit trail --------------------------------------------------------

test('every return names the price basis it used', () => {
  const obs = observations([100], () => ({ uigf_mw: 100, cleared_mw: 60, capped: true }));
  const prices = priceRows([70], 'TAS1');

  const returns = [
    stationRevenue(obs, prices, { region: 'TAS1' }),
    curtailmentCost(obs, prices, { region: 'TAS1' }),
    forecastRevenue(symmetricBand(60, 25), 70, 150),
    regionRevenue([stationRevenue(obs, prices, { region: 'TAS1' })]),
  ];

  for (const value of returns) {
    assert.ok(value.assumptions, 'no assumptions on a returned figure');
    assert.equal(typeof value.assumptions.priceBasis, 'string');
    assert.ok(value.assumptions.priceBasis.length > 0);
  }
});
