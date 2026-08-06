// Scoring rules and adaptive conformal intervals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pinballLoss, crps, crpsFromSamples, skillScore,
  mae, rmse, pctOfCapacity, pitValue, pitHistogram, coverage, RollingScore,
} from '../app/js/models/score.js';
import { AdaptiveConformal } from '../app/js/models/conformal.js';

// Deterministic PRNG so a calibration test that is statistical by nature still
// gives the same verdict on every machine and every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acklam's rational approximation to the inverse standard normal CDF. Used to
// build predicted quantiles AND to draw outcomes, so the PIT test is exact by
// construction: both sides go through the same monotone map, and any error in
// the approximation cancels rather than leaking into the histogram.
const ACK_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
  1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const ACK_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
  6.680131188771972e+01, -1.328068155288572e+01];
const ACK_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
  -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const ACK_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
  3.754408661907416e+00];

function invNormal(p) {
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((ACK_C[0] * q + ACK_C[1]) * q + ACK_C[2]) * q + ACK_C[3]) * q + ACK_C[4]) * q + ACK_C[5])
      / ((((ACK_D[0] * q + ACK_D[1]) * q + ACK_D[2]) * q + ACK_D[3]) * q + 1);
  }
  if (p > 1 - 0.02425) return -invNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((ACK_A[0] * r + ACK_A[1]) * r + ACK_A[2]) * r + ACK_A[3]) * r + ACK_A[4]) * r + ACK_A[5]) * q
    / (((((ACK_B[0] * r + ACK_B[1]) * r + ACK_B[2]) * r + ACK_B[3]) * r + ACK_B[4]) * r + 1);
}

function normalQuantiles(mu, sigma, levels) {
  return levels.map((q) => ({ q, v: mu + sigma * invNormal(q) }));
}

// --- 1. Conformal coverage under heteroscedastic, non-Gaussian noise ---------

// The error scale swings tenfold on a cycle half again as long as the error
// window, so the retained history is always stale — too wide for one half of the
// run, too narrow for the other. No single fixed band width can hold nominal
// coverage here; only the alpha feedback can.
function heteroscedasticRun(targetCoverage, seed) {
  const capacityMw = 1000;
  const model = new AdaptiveConformal({ targetCoverage, capacityMw });
  const rand = mulberry32(seed);
  const intervals = [];
  const actuals = [];
  const scales = [];

  for (let t = 0; t < 5000; t++) {
    const pointForecast = 500;
    const scale = 2 + 18 * (1 + Math.sin(2 * Math.PI * t / 3000)) / 2;

    // Laplace noise: heavier-tailed than Gaussian, so a band sized from a fitted
    // standard deviation would under-cover even with the scale held still.
    const u = rand() - 0.5;
    const actual = pointForecast - scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));

    intervals.push(model.interval(pointForecast));
    actuals.push(actual);
    scales.push(scale);
    model.update(pointForecast, actual);
  }

  return { model, intervals, actuals, scales };
}

// The first band is the cold-start one, capacity wide by design. Anything that
// compares band widths has to start past it or it is only ever measuring the
// clip, and would read the same against a model that never adapted at all.
const WARM = 100;

test('conformal coverage holds at 90% through a tenfold swing in error scale', () => {
  const { model, intervals, actuals } = heteroscedasticRun(0.9, 12345);

  assert.equal(model.updates, 5000);
  assert.ok(
    Math.abs(model.coverage() - 0.9) <= 0.02,
    `coverage ${model.coverage().toFixed(4)} more than 2pp from 0.90`,
  );

  // The class's own tally and the scoring-module function must agree, or one of
  // them is measuring something other than the band that was issued.
  assert.equal(coverage(intervals, actuals), model.coverage());
});

test('conformal coverage holds at 80% through a tenfold swing in error scale', () => {
  const { model } = heteroscedasticRun(0.8, 987);
  assert.ok(
    Math.abs(model.coverage() - 0.8) <= 0.02,
    `coverage ${model.coverage().toFixed(4)} more than 2pp from 0.80`,
  );
});

test('a fixed-width band sized on the same history cannot hold coverage per phase', () => {
  // The premise of the whole class, stated as the thing it actually claims:
  // conditional coverage in the quiet phase and the wild phase pull apart unless
  // the band moves. Comparing band widths would not show this — the widths move
  // for a model with alpha frozen too, because the error window alone tracks the
  // scale. Only per-phase coverage separates the two.
  const { intervals, actuals, scales } = heteroscedasticRun(0.9, 12345);

  const widths = intervals.slice(WARM).map((iv) => iv.hi - iv.lo).sort((a, b) => a - b);
  const fixedHalfWidth = widths[widths.length >> 1] / 2;

  const phaseCoverage = (wild, inside) => {
    let n = 0;
    let hit = 0;
    for (let t = WARM; t < scales.length; t++) {
      if ((scales[t] > 11) !== wild) continue;
      n++;
      if (inside(t)) hit++;
    }
    return hit / n;
  };

  const adaptiveIn = (t) => actuals[t] >= intervals[t].lo && actuals[t] <= intervals[t].hi;
  const fixedIn = (t) => Math.abs(actuals[t] - 500) <= fixedHalfWidth;

  const adaptiveGap = Math.abs(phaseCoverage(false, adaptiveIn) - phaseCoverage(true, adaptiveIn));
  const fixedGap = Math.abs(phaseCoverage(false, fixedIn) - phaseCoverage(true, fixedIn));

  assert.ok(fixedGap > 0.08, `fixed band phase gap only ${fixedGap.toFixed(4)}`);
  assert.ok(adaptiveGap < 0.05, `adaptive band phase gap ${adaptiveGap.toFixed(4)}`);
  assert.ok(fixedGap > 3 * adaptiveGap, `fixed ${fixedGap.toFixed(4)} vs adaptive ${adaptiveGap.toFixed(4)}`);
});

test('the reported quantiles are a distribution centred on the point forecast', () => {
  const { model } = heteroscedasticRun(0.9, 12345);
  const pointForecast = 500;

  // A displaced median is invisible in a coverage check and poisons every CRPS
  // taken from these quantiles, so it is asserted exactly rather than loosely.
  assert.equal(model.quantiles(pointForecast, [0.5])[0].v, pointForecast);

  const levels = [0.01, 0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95, 0.99];
  const qs = model.quantiles(pointForecast, levels);
  for (let i = 1; i < qs.length; i++) {
    assert.ok(qs[i].v >= qs[i - 1].v, `quantiles cross between ${qs[i - 1].q} and ${qs[i].q}`);
  }

  // The pair bracketing the target has to be the band the user was shown, or the
  // fan chart and the score are describing two different forecasts.
  const iv = model.interval(pointForecast);
  const pair = model.quantiles(pointForecast, [0.05, 0.95]);
  assert.ok(Math.abs(pair[0].v - iv.lo) < 1e-12);
  assert.ok(Math.abs(pair[1].v - iv.hi) < 1e-12);
});

test('a station with no registered capacity is refused, not silently unbounded', () => {
  // Most of the registry carries capacity_mw: null. clamp(x, 0, null) returns
  // null without complaint, so an unchecked capacity produces null bounds and a
  // band that covers nothing.
  assert.throws(() => new AdaptiveConformal({ capacityMw: null }), TypeError);
  assert.throws(() => new AdaptiveConformal({}), TypeError);
  assert.throws(() => new AdaptiveConformal({ capacityMw: 0 }), TypeError);
  assert.throws(() => new AdaptiveConformal({ capacityMw: 100, targetCoverage: 1 }), RangeError);
  assert.throws(() => new AdaptiveConformal({ capacityMw: 100, window: 0 }), RangeError);
  assert.throws(() => pctOfCapacity(5, 0), TypeError);
  assert.throws(() => pctOfCapacity(5, null), TypeError);
});

// --- 2. Capacity clip -------------------------------------------------------

test('no interval or quantile bound ever leaves [0, capacity]', () => {
  const capacityMw = 100;
  const model = new AdaptiveConformal({ capacityMw, window: 200 });
  const rand = mulberry32(7);
  const levels = [0.1, 0.25, 0.5, 0.75, 0.9];

  for (let t = 0; t < 3000; t++) {
    // Alternate the two ends of the range: a farm at first light forecast near
    // zero, and the same farm at noon forecast at nameplate, both carrying
    // errors far larger than the headroom on the near side.
    const pointForecast = t % 2 === 0 ? 1.5 : 98.5;
    const iv = model.interval(pointForecast);

    assert.ok(iv.lo >= 0, `lo ${iv.lo} below zero at t=${t}`);
    assert.ok(iv.hi <= capacityMw, `hi ${iv.hi} above capacity at t=${t}`);
    assert.ok(iv.lo <= iv.hi);

    for (const { v } of model.quantiles(pointForecast, levels)) {
      assert.ok(v >= 0 && v <= capacityMw, `quantile ${v} outside [0,100] at t=${t}`);
    }

    const actual = clamp01(pointForecast + (rand() - 0.5) * 160, capacityMw);
    model.update(pointForecast, actual);
  }

  // The clip must not be masking a band that never widened.
  assert.ok(model.errorQuantile(0.9) > 10);
});

function clamp01(x, cap) {
  return x < 0 ? 0 : (x > cap ? cap : x);
}

// --- 3. CRPS sanity ---------------------------------------------------------

const SYMMETRIC_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

test('pinball loss is asymmetric in the direction the quantile level implies', () => {
  assert.ok(Math.abs(pinballLoss(0.9, 100, 110) - 9) < 1e-12);
  assert.ok(Math.abs(pinballLoss(0.9, 100, 90) - 1) < 1e-12);
  assert.equal(pinballLoss(0.5, 100, 110), pinballLoss(0.5, 100, 90));
});

test('a perfect forecast scores zero CRPS', () => {
  const perfect = SYMMETRIC_LEVELS.map((q) => ({ q, v: 42 }));
  assert.equal(crps(perfect, 42), 0);
  assert.equal(crpsFromSamples([42, 42, 42, 42], 42), 0);
});

test('a wider centred distribution scores worse than a tight centred one', () => {
  const tight = normalQuantiles(50, 1, SYMMETRIC_LEVELS);
  const wide = normalQuantiles(50, 5, SYMMETRIC_LEVELS);
  assert.ok(crps(tight, 50) < crps(wide, 50));

  const rand = mulberry32(3);
  const tightSamples = Array.from({ length: 500 }, () => 50 + 1 * invNormal(rand()));
  const wideSamples = Array.from({ length: 500 }, () => 50 + 5 * invNormal(rand()));
  assert.ok(crpsFromSamples(tightSamples, 50) < crpsFromSamples(wideSamples, 50));
});

test('CRPS of a point forecast equals its absolute error', () => {
  for (const actual of [0, 12.5, 60, 137.25]) {
    const point = SYMMETRIC_LEVELS.map((q) => ({ q, v: 60 }));
    assert.ok(Math.abs(crps(point, actual) - Math.abs(actual - 60)) < 1e-12);
    assert.ok(Math.abs(crpsFromSamples([60, 60, 60], actual) - Math.abs(actual - 60)) < 1e-12);
  }

  // And across a series, the mean CRPS of a point forecast is its MAE.
  const pred = [10, 20, 30, 40];
  const actuals = [12, 17, 30, 55];
  const meanCrps = pred.reduce(
    (s, v, i) => s + crps(SYMMETRIC_LEVELS.map((q) => ({ q, v })), actuals[i]), 0,
  ) / pred.length;
  assert.ok(Math.abs(meanCrps - mae(pred, actuals)) < 1e-12);
});

test('the quantile and ensemble forms of CRPS agree on the same distribution', () => {
  // Sample midpoints (i-0.5)/n are the levels at which the two definitions are
  // the same estimator; disagreement here would mean a missing factor somewhere.
  const samples = [3, 9, 11, 14, 20];
  const n = samples.length;
  const asQuantiles = samples.map((v, i) => ({ q: (i + 0.5) / n, v }));
  for (const actual of [1, 10, 13, 25]) {
    assert.ok(Math.abs(crps(asQuantiles, actual) - crpsFromSamples(samples, actual)) < 1e-12);
  }
});

// --- 4. Skill score ---------------------------------------------------------

test('skill score is zero against an identical baseline and 0.5 at half its CRPS', () => {
  assert.equal(skillScore(4.2, 4.2), 0);
  assert.equal(skillScore(2, 4), 0.5);
  assert.equal(skillScore(8, 4), -1);
  assert.equal(skillScore(0, 0), 0);
});

// --- 5. PIT calibration diagnostic ------------------------------------------

// Levels chosen to include every decile, so the histogram bin edges land exactly
// on knots of the predicted CDF and the test measures calibration rather than
// interpolation error.
const PIT_LEVELS = Array.from({ length: 49 }, (_, i) => (i + 1) * 0.02);

function pitRun(seed, spreadFactor) {
  const rand = mulberry32(seed);
  const values = [];
  for (let t = 0; t < 5000; t++) {
    // Predicted spread varies with a solar-like diurnal driver, so the test also
    // covers the heteroscedastic case rather than one fixed sigma.
    const mu = 40 + 30 * Math.sin(2 * Math.PI * t / 288);
    const sigma = 2 + 8 * Math.abs(Math.sin(2 * Math.PI * t / 288));
    const predicted = normalQuantiles(mu, sigma, PIT_LEVELS);
    const actual = mu + spreadFactor * sigma * invNormal(rand());
    values.push(pitValue(predicted, actual));
  }
  return pitHistogram(values);
}

test('PIT is flat when outcomes come from exactly the predicted distribution', () => {
  const h = pitRun(2024, 1);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 5000);
  assert.ok(h.pValue > 0.05, `p=${h.pValue.toFixed(4)} rejected a correctly calibrated forecast`);
  assert.equal(h.uniform, true);
});

test('PIT rejects uniformity for an overconfident forecast', () => {
  const h = pitRun(2024, 3);
  assert.ok(h.pValue < 0.05, `p=${h.pValue.toFixed(4)} failed to detect a 3x too-narrow band`);
  assert.equal(h.uniform, false);
  // U-shaped, not humped: the mass piles into the outer bins.
  assert.ok(h.counts[0] + h.counts[9] > 2 * (h.counts[4] + h.counts[5]));
});

test('PIT rejects uniformity for an underconfident forecast', () => {
  const h = pitRun(2024, 0.33);
  assert.ok(h.pValue < 0.05, `p=${h.pValue.toFixed(4)} failed to detect a 3x too-wide band`);
  assert.ok(h.counts[4] + h.counts[5] > 2 * (h.counts[0] + h.counts[9]));
});

test('pitValue interpolates within the band and lands mid-tail outside it', () => {
  const q = [{ q: 0.1, v: 10 }, { q: 0.5, v: 20 }, { q: 0.9, v: 30 }];
  assert.equal(pitValue(q, 20), 0.5);
  assert.ok(Math.abs(pitValue(q, 15) - 0.3) < 1e-12);
  // Below the 0.1 knot the outcome is somewhere in [0, 0.1) and nothing narrows
  // it further; the knot's own level 0.1 is the one value it definitely is not.
  assert.equal(pitValue(q, 5), 0.05);
  assert.equal(pitValue(q, 99), 0.95);
});

test('PIT stays flat when a calibrated forecast is issued on a coarse decile grid', () => {
  // The grid a fan chart actually uses. Pinning tail outcomes to the outermost
  // knot empties the first histogram bin and doubles the second, which rejects a
  // perfect forecast outright — the failure mode this guards is not subtle.
  const deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const rand = mulberry32(2024);
  const values = [];
  for (let t = 0; t < 5000; t++) {
    values.push(pitValue(normalQuantiles(0, 1, deciles), invNormal(rand())));
  }
  const h = pitHistogram(values);
  assert.ok(Math.min(...h.counts) > 0, `empty bin: ${h.counts.join(' ')}`);
  assert.ok(h.pValue > 0.05, `p=${h.pValue.toExponential(2)} rejected a calibrated decile forecast`);
});

test('the chi-squared p-value matches published critical values', () => {
  // chi-squared with 9 df: 16.919 is the 0.05 point, 21.666 the 0.01 point.
  assert.ok(Math.abs(pitHistogramAt(16.919, 9) - 0.05) < 1e-3);
  assert.ok(Math.abs(pitHistogramAt(21.666, 9) - 0.01) < 1e-3);
  assert.ok(Math.abs(pitHistogramAt(0, 9) - 1) < 1e-12);
});

// Drives the survival function through the only door it has: a histogram whose
// counts produce the wanted chi-squared statistic.
function pitHistogramAt(chiSquared, df) {
  const bins = df + 1;
  const n = 10000;
  const expected = n / bins;
  // Put the whole deviation in one bin: d^2/E + d^2/(E*(bins-1)) = chiSquared.
  const d = Math.sqrt(chiSquared * expected / (1 + 1 / (bins - 1)));
  const values = [];
  const push = (bin, count) => {
    for (let i = 0; i < count; i++) values.push((bin + 0.5) / bins);
  };
  push(0, Math.round(expected + d));
  for (let b = 1; b < bins; b++) push(b, Math.round(expected - d / (bins - 1)));
  const h = pitHistogram(values, bins);
  return h.pValue;
}

// --- RollingScore -----------------------------------------------------------

test('RollingScore means only the last window values', () => {
  const r = new RollingScore(4);
  assert.equal(r.count(), 0);
  assert.equal(r.mean(), 0);

  for (const v of [1, 2, 3]) r.push(v);
  assert.equal(r.count(), 3);
  assert.equal(r.mean(), 2);

  for (const v of [4, 5, 6]) r.push(v);
  assert.equal(r.count(), 4);
  assert.equal(r.mean(), (3 + 4 + 5 + 6) / 4);
});

test('RollingScore stays exact over many laps of the ring', () => {
  // Deliberately not a whole number of laps. Stopping on a lap boundary lands
  // on the once-per-lap recompute, so the running sum — the thing that runs on
  // 99 pushes in 100 and the thing that can drift — is never read at all.
  const pushes = 200037;
  const r = new RollingScore(100);
  for (let i = 0; i < pushes; i++) r.push(i % 7);
  assert.notEqual(r.head, 0, 'test must stop mid-lap to exercise the running sum');

  let expected = 0;
  for (let i = pushes - 100; i < pushes; i++) expected += i % 7;
  assert.ok(Math.abs(r.mean() - expected / 100) < 1e-12);

  // Values that do not sum exactly in binary, so the running path has something
  // to lose if the periodic re-add is not doing its job.
  const f = new RollingScore(64);
  for (let i = 0; i < 500000; i++) f.push(0.1 * (i % 13) + 1e7);
  let want = 0;
  for (let i = 500000 - 64; i < 500000; i++) want += 0.1 * (i % 13) + 1e7;
  assert.ok(Math.abs(f.mean() - want / 64) < 1e-6, `drifted to ${f.mean()}`);
});

test('paired scores refuse a ragged pair rather than scoring the overlap', () => {
  // A longer actuals array is the dangerous one: no NaN, no throw, just a
  // plausible number computed from part of the data.
  assert.throws(() => mae([1, 2, 3], [1, 2]), RangeError);
  assert.throws(() => rmse([1, 2], [1, 2, 3]), RangeError);
  assert.throws(() => coverage([{ lo: 0, hi: 1 }], [0.5, 0.5]), RangeError);
  assert.throws(() => mae([], []), RangeError);
  assert.throws(() => pitHistogram([]), RangeError);
});

test('pitHistogram bins every value it is given', () => {
  // An out-of-range value used to land on counts[-1], vanishing from the
  // histogram while still counting towards the expected frequency.
  const h = pitHistogram([-0.2, 0.05, 0.5, 1.4, 0.95]);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 5);
  assert.equal(h.counts[0], 2);
  assert.equal(h.counts[9], 2);
});

// --- MAE / RMSE -------------------------------------------------------------

test('mae, rmse and capacity scaling', () => {
  const pred = [10, 20, 30];
  const actual = [12, 20, 26];
  assert.equal(mae(pred, actual), 2);
  assert.ok(Math.abs(rmse(pred, actual) - Math.sqrt((4 + 0 + 16) / 3)) < 1e-12);
  assert.equal(pctOfCapacity(mae(pred, actual), 100), 2);
  // RMSE penalises the one large miss harder than MAE does.
  assert.ok(rmse(pred, actual) > mae(pred, actual));
});

test('coverage counts outcomes on the boundary as inside', () => {
  const intervals = [{ lo: 0, hi: 10 }, { lo: 0, hi: 10 }, { lo: 5, hi: 6 }, { lo: 0, hi: 1 }];
  assert.equal(coverage(intervals, [10, 0, 5.5, 2]), 0.75);
});
