// Signals, recommendations and the evidence they are obliged to carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNAL, CONFIDENCE, deriveConfidence, stationSignal, regionSignal, rankSignals,
} from '../app/js/signals.js';

// Fixtures are shaped exactly like the real records: station from the registry
// plus its fitted curve, skill from one row of data/backtest.json horizons[],
// price from DISPATCH.PRICE. data/ is not checked in, so the numbers are copied
// rather than loaded — a test that needs a harvest to run is a test that stops
// being run.
const BASE = {
  station: {
    station_id: 'MACARTH',
    station_name: 'MACARTHUR WIND FARM',
    fueltech: 'wind',
    region: 'VIC1',
    capacity_mw: 420,
    curve: { rmse: 48.4 },
  },
  forecast: { mw: 300, reference_mw: 200, horizon: '1h', generated_at: 1_786_000_000_000 },
  band: { lo: 270, hi: 330, coverage: 0.9 },
  priceForecast: { rrp: 90 },
  skill: {
    horizon: '1h',
    skill: 0.31,
    n: 5244,
    weights: {
      persistence: 0.05, climatology: 0.0001, physical: 0.2,
      ridge: 0.07, analogue: 0.0001, ramp: 0.6798,
    },
  },
  curtailmentRisk: { masked_fraction: 0.05, curtailed_producing_fraction: 0.05 },
};

// Cloned per call, so a test that mutates its own fixture — one of them does,
// deliberately — cannot reach the next test through a shared reference.
function inputs(over = {}) {
  const base = structuredClone(BASE);
  return {
    station: { ...base.station, ...over.station },
    forecast: { ...base.forecast, ...over.forecast },
    band: { ...base.band, ...over.band },
    priceForecast: { ...base.priceForecast, ...over.priceForecast },
    skill: { ...base.skill, ...over.skill },
    curtailmentRisk: { ...base.curtailmentRisk, ...over.curtailmentRisk },
  };
}

const REQUIRED_EVIDENCE = [
  'forecast_mw', 'band_lo', 'band_hi', 'band_coverage', 'price_assumption',
  'skill_score', 'skill_horizon', 'expert_weights', 'masked_fraction',
  'curve_rmse', 'n_intervals_scored', 'generated_at',
];

// The keys above that are plain quantities. skill_horizon is a label,
// expert_weights is a vector, and curve_rmse is null exactly when no curve was
// fitted; each is checked on its own terms below.
const NUMERIC_EVIDENCE = [
  'forecast_mw', 'band_lo', 'band_hi', 'band_coverage', 'price_assumption',
  'skill_score', 'masked_fraction', 'n_intervals_scored', 'generated_at',
];

const HOURS = { '5min': 1 / 12, '30min': 0.5, '1h': 1, '6h': 6, '24h': 24 };
const RANK = { low: 0, medium: 1, high: 2 };

function assertEvidenceComplete(sig, { curveFitted }) {
  for (const key of REQUIRED_EVIDENCE) {
    assert.ok(
      Object.hasOwn(sig.evidence, key),
      `${sig.id} ${sig.horizon}: evidence is missing ${key}`,
    );
  }
  for (const key of NUMERIC_EVIDENCE) {
    const value = sig.evidence[key];
    assert.equal(typeof value, 'number', `${sig.id}: ${key} should be a number, got ${value}`);
    assert.ok(Number.isFinite(value), `${sig.id}: ${key} is not finite: ${value}`);
  }

  assert.equal(typeof sig.evidence.skill_horizon, 'string');
  assert.equal(sig.evidence.skill_horizon, sig.horizon);

  const weights = Object.values(sig.evidence.expert_weights);
  assert.ok(weights.length > 0, 'expert weights must name at least one expert');
  for (const w of weights) assert.ok(Number.isFinite(w), `expert weight not finite: ${w}`);
  assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'expert weights must sum to 1');

  if (curveFitted) {
    assert.ok(Number.isFinite(sig.evidence.curve_rmse), 'a fitted curve must report a finite rmse');
  } else {
    assert.equal(sig.evidence.curve_rmse, null, 'no fitted curve must report null, not a number');
  }

  // A stale signal has to be identifiable as stale, and the reader has to know
  // what the call applies to.
  assert.ok(Number.isFinite(sig.evidence.generated_at));
  assert.ok(sig.horizon in HOURS);

  // The strongest test of the contract: the headline number is reproducible from
  // the evidence alone, with nothing hidden behind it.
  const reproduced = (sig.evidence.forecast_mw - sig.evidence.reference_mw)
    * HOURS[sig.horizon] * sig.evidence.price_assumption;
  assert.ok(Math.abs(reproduced - sig.expected_dollars) < 1e-6);
}

test('the signal vocabulary is exactly watch, hold, opportunity and risk', () => {
  assert.deepEqual(Object.values(SIGNAL).sort(), ['hold', 'opportunity', 'risk', 'watch']);
  // The point of the vocabulary is that it does not claim to be trading advice.
  for (const word of Object.values(SIGNAL)) {
    assert.ok(!['buy', 'sell', 'short', 'long'].includes(word));
  }
});

test('negative skill can never yield opportunity or risk, at any price', () => {
  const prices = [-1000, -300, -47.5, 0, 47.5, 300, 5000, 17500];
  const deltas = [-400, -120, -10, 0, 10, 120, 400];
  for (const skill of [-0.557, -0.2, -0.001, 0]) {
    for (const rrp of prices) {
      for (const delta of deltas) {
        const sig = stationSignal(inputs({
          skill: { skill },
          priceForecast: { rrp },
          // Band placed clear of the reference so nothing but the skill rule can
          // be what holds the signal back.
          forecast: { mw: 200 + delta, reference_mw: 200 },
          band: { lo: 200 + delta - 5, hi: 200 + delta + 5 },
        }));
        assert.equal(
          sig.signal, SIGNAL.WATCH,
          `skill ${skill} at $${rrp} with ${delta} MW gave ${sig.signal}`,
        );
      }
    }
  }
});

test('a station that cannot beat persistence still reports why, with evidence', () => {
  const sig = stationSignal(inputs({ skill: { skill: -0.4 } }));
  assert.equal(sig.signal, SIGNAL.WATCH);
  assert.match(sig.rationale, /does not forecast it any better than assuming output stays/);
  assertEvidenceComplete(sig, { curveFitted: true });
});

test('widening the conformal band monotonically lowers confidence', () => {
  const capacity = BASE.station.capacity_mw;
  let previousScore = Infinity;
  let previousRank = Infinity;
  for (let width = 0; width <= capacity; width += 5) {
    const { score, label } = deriveConfidence({
      skill: 0.45,
      bandWidthMw: width,
      forecastMw: 400,
      capacityMw: capacity,
      maskedFraction: 0.02,
    });
    assert.ok(score < previousScore, `score rose at width ${width}: ${score} >= ${previousScore}`);
    assert.ok(RANK[label] <= previousRank, `label rose at width ${width}: ${label}`);
    previousScore = score;
    previousRank = RANK[label];
  }

  // And the same through the public entry point, where the band is widened
  // symmetrically about an unchanged forecast so nothing else moves.
  previousRank = Infinity;
  for (let halfWidth = 5; halfWidth <= 260; halfWidth += 5) {
    const sig = stationSignal(inputs({ band: { lo: 300 - halfWidth, hi: 300 + halfWidth } }));
    assert.ok(RANK[sig.confidence] <= previousRank, `confidence rose at +/-${halfWidth} MW`);
    previousRank = RANK[sig.confidence];
  }
  assert.equal(previousRank, RANK.low);
});

test('a band wider than the forecast caps confidence at low', () => {
  const sharp = stationSignal(inputs({
    skill: { skill: 0.62 },
    band: { lo: 290, hi: 310 },
    curtailmentRisk: { masked_fraction: 0 },
  }));
  assert.equal(sharp.confidence, CONFIDENCE.HIGH);

  // Same forecast, same skill, same record — a band 301 MW wide around a 300 MW
  // forecast says output could be almost anything.
  const wide = stationSignal(inputs({
    skill: { skill: 0.62 },
    band: { lo: 150, hi: 451 },
    curtailmentRisk: { masked_fraction: 0 },
  }));
  assert.equal(wide.evidence.band_hi - wide.evidence.band_lo > wide.evidence.forecast_mw, true);
  assert.equal(wide.confidence, CONFIDENCE.LOW);

  // The cap is on the label, not on the underlying derivation.
  const { score } = deriveConfidence({
    skill: 0.62, bandWidthMw: 301, forecastMw: 300, capacityMw: 420, maskedFraction: 0,
  });
  assert.ok(score > 0);
});

test('confidence falls when recent intervals were masked, skill and band unchanged', () => {
  const ranks = [0, 0.25, 0.6, 1].map((masked) => RANK[stationSignal(inputs({
    skill: { skill: 0.6 },
    band: { lo: 280, hi: 320 },
    curtailmentRisk: { masked_fraction: masked },
  })).confidence]);
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] <= ranks[i - 1]);
  assert.equal(ranks[0], RANK.high);
  assert.equal(ranks[3], RANK.low);
});

test('every returned signal carries a complete evidence object', () => {
  const cases = [
    ['opportunity', inputs()],
    ['risk', inputs({ forecast: { mw: 80 }, band: { lo: 60, hi: 100 } })],
    ['hold', inputs({ forecast: { mw: 205 }, band: { lo: 180, hi: 230 } })],
    ['watch', inputs({ skill: { skill: -0.1 } })],
    ['negative price', inputs({ priceForecast: { rrp: -55 } })],
    ['curtailed', inputs({ curtailmentRisk: { curtailed_producing_fraction: 0.9 } })],
    ['24h horizon', inputs({ forecast: { horizon: '24h' }, skill: { horizon: '24h' } })],
    ['5min horizon', inputs({ forecast: { horizon: '5min' }, skill: { horizon: '5min' } })],
  ];
  for (const [label, given] of cases) {
    const sig = stationSignal(given);
    assert.ok(Object.values(SIGNAL).includes(sig.signal), `${label}: ${sig.signal} is not vocabulary`);
    assert.ok(Object.values(CONFIDENCE).includes(sig.confidence), `${label}: ${sig.confidence}`);
    assert.equal(typeof sig.rationale, 'string');
    assert.ok(sig.rationale.length > 20 && sig.rationale.endsWith('.'), `${label}: ${sig.rationale}`);
    assertEvidenceComplete(sig, { curveFitted: true });
  }

  // A thermal station has no weather-to-power curve to fit, and the evidence
  // says so rather than inventing a fit quality.
  const coal = stationSignal(inputs({
    station: {
      station_id: 'ERARING', station_name: 'ERARING POWER STATION', fueltech: 'coal_black',
      region: 'NSW1', capacity_mw: 2880, curve: null,
    },
    forecast: { mw: 2100, reference_mw: 1900 },
    band: { lo: 1980, hi: 2220 },
    skill: { skill: 0.218, n: 5244 },
  }));
  assertEvidenceComplete(coal, { curveFitted: false });

  const wind = stationSignal(inputs({
    station: {
      station_id: 'SAPHWF1', station_name: 'SAPPHIRE WIND FARM',
      region: 'NSW1', capacity_mw: 270,
    },
  }));
  assertEvidenceComplete(regionSignal([coal, wind], { region: 'NSW1', rrp: 90 }), { curveFitted: true });
  // A region of nothing but thermal plant has no curve to report either.
  assertEvidenceComplete(regionSignal([coal], { region: 'NSW1', rrp: 90 }), { curveFitted: false });
});

test('a heavily curtailed station is flagged constrained and says so', () => {
  const constrained = stationSignal(inputs({
    curtailmentRisk: { masked_fraction: 0.61, curtailed_producing_fraction: 0.78 },
  }));
  assert.equal(constrained.constrained, true);
  assert.match(constrained.rationale, /constrained/);
  assert.match(constrained.rationale, /78% of its recent producing intervals/);
  assert.match(constrained.rationale, /market, not the weather/);
  assert.equal(constrained.evidence.curtailed_producing_fraction, 0.78);

  // Half is not more than half.
  const borderline = stationSignal(inputs({
    curtailmentRisk: { curtailed_producing_fraction: 0.5 },
  }));
  assert.equal(borderline.constrained, false);
  assert.ok(!borderline.rationale.includes('constrained'));

  // Tailem Bend 2's solar farm: curtailed in every interval it produces, so the
  // recent record teaches nothing and the signal must not sound confident.
  const tb2 = stationSignal(inputs({
    station: { station_id: 'TB2HYB', station_name: 'TAILEM BEND 2', region: 'SA1', capacity_mw: 155 },
    curtailmentRisk: { masked_fraction: 1, curtailed_producing_fraction: 1 },
  }));
  assert.equal(tb2.constrained, true);
  assert.equal(tb2.confidence, CONFIDENCE.LOW);
  assert.match(tb2.rationale, /100% of its recent producing intervals/);
});

test('rankSignals orders by dollar impact, not percentage', () => {
  const big = stationSignal(inputs({
    station: { station_id: 'BIG', station_name: 'BIG WIND FARM', capacity_mw: 500 },
    // A 2% move on 500 MW.
    forecast: { mw: 260, reference_mw: 250, horizon: '6h' },
    band: { lo: 255, hi: 265 },
    skill: { horizon: '6h' },
  }));
  const small = stationSignal(inputs({
    station: { station_id: 'SMALL', station_name: 'SMALL WIND FARM', capacity_mw: 20 },
    // A 20% move on 20 MW.
    forecast: { mw: 12, reference_mw: 10, horizon: '6h' },
    band: { lo: 11, hi: 13 },
    skill: { horizon: '6h' },
  }));
  assert.equal(Math.round(big.expected_dollars), 10 * 6 * 90);
  assert.equal(Math.round(small.expected_dollars), 2 * 6 * 90);

  const ranked = rankSignals([small, big]);
  assert.deepEqual(ranked.map((s) => s.id), ['BIG', 'SMALL']);
  assert.deepEqual(rankSignals([big, small]).map((s) => s.id), ['BIG', 'SMALL']);
  assert.deepEqual(rankSignals([small, big], 1).map((s) => s.id), ['BIG']);
  // Ranking is by materiality, so a large loss outranks a small gain.
  const loss = stationSignal(inputs({
    station: { station_id: 'FALLING' },
    forecast: { mw: 150, reference_mw: 250, horizon: '6h' },
    band: { lo: 140, hi: 160 },
    skill: { horizon: '6h' },
  }));
  assert.deepEqual(rankSignals([small, big, loss]).map((s) => s.id), ['FALLING', 'BIG', 'SMALL']);
  // The input array is left alone.
  const original = [small, big];
  rankSignals(original);
  assert.deepEqual(original.map((s) => s.id), ['SMALL', 'BIG']);
});

test('identical inputs always produce an identical signal', () => {
  const given = inputs();
  const first = stationSignal(given);
  // Two unrelated calls in between, in case anything is accumulating.
  stationSignal(inputs({ skill: { skill: 0.9 }, priceForecast: { rrp: -300 } }));
  stationSignal(inputs({ forecast: { mw: 0 }, band: { lo: 0, hi: 40 } }));
  const second = stationSignal(given);
  const third = stationSignal(structuredClone(given));
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(JSON.stringify(third), JSON.stringify(first));

  // The evidence is a copy, so rerunning the backtest cannot rewrite the
  // reasoning behind a signal that has already been issued.
  const issuedWeight = given.skill.weights.ramp;
  given.skill.weights.ramp = 0.999;
  assert.equal(first.evidence.expert_weights.ramp, issuedWeight);
});

test('the direction of a call follows the money, not the megawatts', () => {
  const rising = stationSignal(inputs({ forecast: { mw: 300, reference_mw: 200 } }));
  assert.equal(rising.signal, SIGNAL.OPPORTUNITY);
  assert.match(rising.rationale, /100 MW more over the next hour/);
  assert.match(rising.rationale, /worth about \$9,000 at the assumed \$90\/MWh/);

  // Generating more into a negative price is a risk, not an opportunity.
  const intoNegative = stationSignal(inputs({
    forecast: { mw: 300, reference_mw: 200 }, priceForecast: { rrp: -120 },
  }));
  assert.equal(intoNegative.signal, SIGNAL.RISK);
  assert.match(intoNegative.rationale, /costing about \$12,000 at the assumed -\$120\/MWh/);

  const falling = stationSignal(inputs({
    forecast: { mw: 100, reference_mw: 250 }, band: { lo: 80, hi: 120 },
  }));
  assert.equal(falling.signal, SIGNAL.RISK);
  assert.match(falling.rationale, /150 MW less over the next hour/);
});

test('a move inside the band is a hold, however large the price', () => {
  for (const rrp of [-1000, 90, 17500]) {
    const sig = stationSignal(inputs({
      forecast: { mw: 300, reference_mw: 260 },
      band: { lo: 240, hi: 360 },
      priceForecast: { rrp },
    }));
    assert.equal(sig.signal, SIGNAL.HOLD, `at $${rrp}`);
    // The reason has to be the band, not a claim that 40 MW is small.
    assert.match(sig.rationale, /own 90% uncertainty range cannot tell apart from the 260 MW/);
  }
  // Distinguishable from persistence, but not worth anyone's attention. That is
  // a different statement and says so.
  const trivial = stationSignal(inputs({
    forecast: { mw: 210, reference_mw: 200 }, band: { lo: 208, hi: 212 }, priceForecast: { rrp: 5 },
  }));
  assert.equal(trivial.signal, SIGNAL.HOLD);
  // Small prices keep their cents, so a $0.40 interval does not read as "$0/MWh".
  assert.match(trivial.rationale, /worth about \$50 at the assumed \$5\.00\/MWh and not enough to act on/);
});

test('regionSignal aggregates its stations and keeps the same shape', () => {
  const a = stationSignal(inputs({
    station: { station_id: 'A', capacity_mw: 400 },
    forecast: { mw: 300, reference_mw: 200, generated_at: 1_786_000_000_000 },
    band: { lo: 280, hi: 320, coverage: 0.9 },
    skill: { skill: 0.4, n: 5244 },
    curtailmentRisk: { masked_fraction: 0.1, curtailed_producing_fraction: 0.1 },
  }));
  const b = stationSignal(inputs({
    station: { station_id: 'B', capacity_mw: 100 },
    forecast: { mw: 50, reference_mw: 40, generated_at: 1_785_999_700_000 },
    band: { lo: 40, hi: 60, coverage: 0.82 },
    skill: { skill: 0.2, n: 3000 },
    curtailmentRisk: { masked_fraction: 0.5, curtailed_producing_fraction: 0.5 },
  }));
  const region = regionSignal([a, b], { region: 'VIC1', rrp: 120 });

  assert.equal(region.scope, 'region');
  assert.equal(region.horizon, '1h');
  assert.equal(region.evidence.forecast_mw, 350);
  assert.equal(region.evidence.reference_mw, 240);
  assert.equal(region.evidence.band_lo, 320);
  assert.equal(region.evidence.band_hi, 380);
  assert.equal(region.evidence.capacity_mw, 500);
  // The weakest guarantee, the least-scored member and the oldest stamp.
  assert.equal(region.evidence.band_coverage, 0.82);
  assert.equal(region.evidence.n_intervals_scored, 3000);
  assert.equal(region.evidence.generated_at, 1_785_999_700_000);
  // Capacity weighted: 0.4 * 0.8 + 0.2 * 0.2.
  assert.ok(Math.abs(region.evidence.skill_score - 0.36) < 1e-12);
  assert.ok(Math.abs(region.evidence.masked_fraction - 0.18) < 1e-12);
  assert.equal(region.expected_dollars, 110 * 120);
  assert.equal(region.signal, SIGNAL.OPPORTUNITY);
  assert.match(region.rationale, /^The VIC1 fleet is forecast to generate 110 MW more/);
  assertEvidenceComplete(region, { curveFitted: true });

  // Aggregating anything meaningless is refused rather than guessed at.
  assert.throws(() => regionSignal([], { region: 'VIC1', rrp: 90 }), /at least one/);
  assert.throws(() => regionSignal([a, b], { region: 'NSW1', rrp: 90 }), /is in VIC1, not NSW1/);
  const sixHour = stationSignal(inputs({
    station: { station_id: 'C' }, forecast: { horizon: '6h' }, skill: { horizon: '6h' },
  }));
  assert.throws(() => regionSignal([a, sixHour], { region: 'VIC1', rrp: 90 }), /mixed horizons/);
});

test('a region whose skill is negative can only watch, and says which region', () => {
  const weak = ['A', 'B'].map((id) => stationSignal(inputs({
    station: { station_id: id, capacity_mw: 200, region: 'SA1' },
    skill: { skill: -0.1 },
  })));
  const region = regionSignal(weak, { region: 'SA1', rrp: 300 });
  assert.equal(region.signal, SIGNAL.WATCH);
  assert.match(region.rationale, /^The SA1 fleet is not being called/);
  assertEvidenceComplete(region, { curveFitted: true });
});

test('a region is constrained when most of its capacity is', () => {
  const capped = stationSignal(inputs({
    station: { station_id: 'CAPPED', capacity_mw: 400 },
    curtailmentRisk: { masked_fraction: 0.7, curtailed_producing_fraction: 0.9 },
  }));
  const free = stationSignal(inputs({ station: { station_id: 'FREE', capacity_mw: 100 } }));
  const region = regionSignal([capped, free], { region: 'VIC1', rrp: 90 });
  assert.equal(region.constrained, true);
  assert.match(region.rationale, /most of that capacity is constrained/);

  assert.equal(regionSignal([free, free], { region: 'VIC1', rrp: 90 }).constrained, false);
});

test('inputs that cannot support a signal are refused, not papered over', () => {
  assert.throws(() => stationSignal(inputs({ forecast: { generated_at: undefined } })),
    /forecast.generated_at must be a finite number/);
  assert.throws(() => stationSignal(inputs({ station: { capacity_mw: null } })),
    /station.capacity_mw must be a finite number/);
  assert.throws(() => stationSignal(inputs({ skill: { skill: NaN } })),
    /skill.skill must be a finite number/);
  assert.throws(() => stationSignal(inputs({ priceForecast: { rrp: undefined } })),
    /priceForecast.rrp must be a finite number/);
  // Quoting one horizon's skill beside another's forecast is the wrong number,
  // not merely weaker evidence.
  assert.throws(() => stationSignal(inputs({ forecast: { horizon: '6h' } })),
    /skill horizon 1h does not match forecast horizon 6h/);
});
