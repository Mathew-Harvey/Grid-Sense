// Two tests that guard claims the dashboard makes visually.
//
// The first proves the aggregate band has to be calibrated on the aggregate
// residual: forecast errors across neighbouring farms are wrong about the same
// weather front at the same moment, so summing per-station intervals in
// quadrature — as if the errors were independent — understates the fleet's
// uncertainty badly. The chart draws that naive band as a ghost behind the real
// one, and this is the test that keeps the ghost honestly narrower.
//
// The second documents the signature of a leak. Walk-forward discipline is
// structural, not checked at runtime, so the way a leak announces itself is a
// skill score too good to be true. This test builds one deliberately and
// asserts the score crosses the implausibility line, so the line is known to
// catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveConformal } from '../app/js/models/conformal.js';
import { skillScore } from '../app/js/models/score.js';

// Deterministic uniform in [0,1): tests about coverage percentages cannot be
// allowed to flake on a seed.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Sum of uniforms, centred: close enough to Gaussian for coverage arithmetic,
// with none of Box-Muller's tail surprises under a weak generator.
const gauss = (rnd) => (rnd() + rnd() + rnd() + rnd() - 2) * Math.sqrt(3);

test('the aggregate band must be calibrated on the aggregate residual, not summed in quadrature', () => {
  const STATIONS = 10;
  const CAPACITY = 1000;
  const POINT = 500;
  const SIGMA = 50;
  const SHARED = 0.8;      // the weather front every farm is wrong about together
  const OWN = 0.2;
  const N = 6000;
  const WARMUP = 1500;
  const rnd = lcg(20260807);

  const perStation = Array.from({ length: STATIONS }, () =>
    new AdaptiveConformal({ targetCoverage: 0.9, gamma: 0.005, window: 2000, capacityMw: CAPACITY }));
  const aggregate = new AdaptiveConformal({ targetCoverage: 0.9, gamma: 0.005, window: 2000, capacityMw: STATIONS * CAPACITY });

  let naiveHits = 0;
  let directHits = 0;
  let scored = 0;

  for (let t = 0; t < N; t++) {
    const front = gauss(rnd);
    let fleetActual = 0;
    let quadrature = 0;

    for (let i = 0; i < STATIONS; i++) {
      const actual = POINT + SIGMA * (SHARED * front + OWN * gauss(rnd));
      fleetActual += actual;
      const band = perStation[i].interval(POINT);
      quadrature += (band.hi - band.lo) ** 2 / 4;
      perStation[i].update(POINT, actual, 1, band);
    }

    const fleetPoint = STATIONS * POINT;
    const naiveHalf = Math.sqrt(quadrature);
    const direct = aggregate.interval(fleetPoint);

    if (t >= WARMUP) {
      scored++;
      if (Math.abs(fleetActual - fleetPoint) <= naiveHalf) naiveHits++;
      if (fleetActual >= direct.lo && fleetActual <= direct.hi) directHits++;
    }
    aggregate.update(fleetPoint, fleetActual, 1, direct);
  }

  const naiveCoverage = naiveHits / scored;
  const directCoverage = directHits / scored;

  // Ten farms at 0.8 shared loading: the fleet error is ~8 station-sigmas wide
  // while the quadrature band budgets for ~2.6, so the naive band should miss
  // roughly half the time. Nominal is 90.
  assert.ok(directCoverage > 0.87 && directCoverage < 0.93,
    `direct aggregate calibration should sit at nominal, got ${(directCoverage * 100).toFixed(1)}%`);
  assert.ok(naiveCoverage < 0.75,
    `quadrature over correlated errors should undercover badly, got ${(naiveCoverage * 100).toFixed(1)}%`);
});

test('a leaked future value drives skill implausibly high, so the implausibility line catches it', () => {
  const N = 4000;
  const HORIZON = 12;
  const rnd = lcg(42);

  // Persistent but noisy, like a wind trace: hard enough that honest features
  // cannot score anywhere near perfect at a one-hour horizon.
  const y = [500];
  for (let t = 1; t < N + HORIZON; t++) {
    y.push(Math.max(0, 0.97 * y[t - 1] + 15 * gauss(rnd) + 15));
  }

  // The same recursive least squares both times; the only difference is what
  // the feature vector is allowed to see.
  function walkForward(featuresAt) {
    const dim = featuresAt(HORIZON).length;
    let w = new Array(dim).fill(0);
    let maeModel = 0;
    let maePersistence = 0;
    let n = 0;
    for (let t = HORIZON; t < N; t++) {
      const x = featuresAt(t);
      const pred = x.reduce((a, v, i) => a + v * w[i], 0);
      // Target and features share the same centring, or the intercept becomes
      // the buried direction instead and the learner spends the whole run
      // crawling toward the mean. Persistence is unaffected: its error is a
      // difference of two outcomes, and the centring cancels.
      const truth = y[t + HORIZON] - 500;
      if (t > 500) {
        maeModel += Math.abs(pred - truth);
        maePersistence += Math.abs((y[t] - 500) - truth);
        n++;
      }
      const err = truth - pred;
      // Normalised LMS: the step is scale-free, so convergence cannot depend on
      // the megawatt magnitude of the features. A leak has to show up because
      // it is a leak, not stay hidden because the learning rate was timid.
      const norm = x.reduce((a, v) => a + v * v, 0) + 1;
      w = w.map((wi, i) => wi + (0.5 * err * x[i]) / norm);
    }
    return skillScore(maeModel / n, maePersistence / n);
  }

  // Features are centred anomalies, as any real pipeline feeds them. Raw
  // levels near 500 with variation near 40 bury the informative direction
  // under the common mean, and a learner crawling along that spread would hide
  // the leak behind slow convergence rather than expose it.
  const honest = walkForward((t) => [1, y[t] - 500, y[t - 1] - 500]);
  // The leak: the outcome itself, smuggled in as a feature. This is what
  // z-scoring against a full-series mean or reading weather past the issue
  // time amounts to, in its purest form.
  const leaked = walkForward((t) => [1, y[t] - 500, y[t + HORIZON] - 500]);

  const IMPLAUSIBLE = 0.9;
  assert.ok(honest < IMPLAUSIBLE,
    `honest features must stay below the implausibility line, got ${honest.toFixed(3)}`);
  assert.ok(leaked > IMPLAUSIBLE,
    `a leaked outcome must cross the implausibility line, got ${leaked.toFixed(3)}`);
});
