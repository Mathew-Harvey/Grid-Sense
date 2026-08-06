import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Persistence, DiurnalClimatology, Physical, OnlineRidge, Analogue, RampAware,
  buildExperts, windFraction, solarFraction,
} from '../app/js/models/experts.js';
import { Hedge, defaultEta } from '../app/js/models/hedge.js';

// Seeded so a failure is a real failure and not an unlucky draw.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function state(over = {}) {
  return {
    capacity_mw: 100,
    fueltech: 'wind',
    observed_at: Date.UTC(2026, 2, 14, 4, 20),
    tod_minutes: 14 * 60 + 20,
    month: 3,
    history: [40, 41, 42],
    weather: { wind_speed_100m: 9, temperature_2m: 22, clear_sky_index: 0.8, clear_sky_ghi: 900 },
    forecast: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Hedge convergence
// ---------------------------------------------------------------------------

test('Hedge convergence: the best of five experts takes >0.8 of the weight within 1000 intervals', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const sigma = { a: 0.02, b: 0.10, c: 0.14, d: 0.18, e: 0.22 };  // fraction of capacity
  const hedge = new Hedge({ names });
  const r = rng(11);
  const cap = 120;

  for (let t = 0; t < 1000; t++) {
    const actual = 60 + 10 * gauss(r);
    const predictions = {};
    for (const n of names) predictions[n] = actual + cap * sigma[n] * gauss(r);
    hedge.update(predictions, actual, cap);
  }

  const w = hedge.weights();
  assert.ok(w.a > 0.8, `best expert weight ${w.a.toFixed(4)} should exceed 0.8`);
  const total = names.reduce((s, n) => s + w[n], 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `weights must sum to 1, got ${total}`);
});

// ---------------------------------------------------------------------------
// 2. Weight floor: survive a bad season, then recover
// ---------------------------------------------------------------------------

test('weight floor holds through 5000 bad intervals and the expert recovers when it turns good', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const floor = 1e-4;
  const hedge = new Hedge({ names, weightFloor: floor });
  const cap = 200;
  const actual = 100;

  const round = (badError) => {
    const predictions = { a: actual + cap * badError };
    for (const n of names.slice(1)) predictions[n] = actual + cap * 0.05;
    hedge.update(predictions, actual, cap);
  };

  for (let t = 0; t < 5000; t++) round(0.9);
  const beaten = hedge.weights().a;
  assert.ok(beaten >= floor, `weight ${beaten} fell below the floor ${floor}`);
  assert.ok(beaten < 1e-3, 'the bad expert should actually have been driven to the floor');

  // Now it becomes the best expert. Without the floor there is nothing left to
  // grow from and it could never come back.
  let recoveredAt = -1;
  for (let t = 0; t < 3000; t++) {
    const predictions = { a: actual + cap * 0.02 };
    for (const n of names.slice(1)) predictions[n] = actual + cap * 0.5;
    hedge.update(predictions, actual, cap);
    if (recoveredAt < 0 && hedge.weights().a > 0.5) recoveredAt = t;
  }
  assert.ok(recoveredAt >= 0, 'floored expert never recovered');
  assert.ok(recoveredAt < 2000, `recovery took ${recoveredAt} intervals`);
  assert.ok(hedge.weights().a > 0.9);
});

test('every weight is floored, not just the worst one', () => {
  const names = ['a', 'b', 'c'];
  const floor = 1e-3;
  const hedge = new Hedge({ names, weightFloor: floor, eta: 2 });
  for (let t = 0; t < 5000; t++) {
    hedge.update({ a: 0, b: 100, c: 100 }, 0, 100);
  }
  const w = hedge.weights();
  assert.ok(w.b >= floor && w.c >= floor);
  assert.ok(Math.abs(w.a + w.b + w.c - 1) < 1e-12);
});

// ---------------------------------------------------------------------------
// 3. Capacity normalisation
// ---------------------------------------------------------------------------

test('capacity normalisation: a 50 MW and a 2500 MW station with the same relative error track identically', () => {
  const names = ['a', 'b', 'c'];
  const small = new Hedge({ names });
  const large = new Hedge({ names });
  const smallCap = 50;
  const scale = 50;
  const largeCap = smallCap * scale;
  const r = rng(7);

  for (let t = 0; t < 2000; t++) {
    const actual = 20 + 5 * gauss(r);
    const p = { a: actual + 0.5 * gauss(r), b: actual + 3 * gauss(r), c: actual + 8 * gauss(r) };
    small.update(p, actual, smallCap);

    const big = {};
    for (const n of names) big[n] = p[n] * scale;
    large.update(big, actual * scale, largeCap);

    if (t % 250 === 0) {
      for (const n of names) {
        assert.ok(
          Math.abs(small.weights()[n] - large.weights()[n]) < 1e-12,
          `weights diverged at t=${t} for ${n}`,
        );
      }
    }
  }

  for (const n of names) {
    assert.ok(Math.abs(small.weights()[n] - large.weights()[n]) < 1e-12);
  }
  // Sanity: the run has to have actually separated the experts, or this proves
  // nothing.
  assert.ok(small.weights().a > 0.9);
});

test('defaultEta follows sqrt(8 ln N / T)', () => {
  assert.ok(Math.abs(defaultEta(6) - Math.sqrt((8 * Math.log(6)) / 5000)) < 1e-15);
});

test('combine and combineQuantiles use the current weights', () => {
  const hedge = new Hedge({ names: ['a', 'b'] });
  assert.equal(hedge.combine({ a: 10, b: 20 }), 15);
  assert.deepEqual(hedge.combineQuantiles({ a: [0, 10, 20], b: [10, 20, 30] }), [5, 15, 25]);
  assert.throws(() => hedge.combine({ a: 10 }), /no prediction supplied/);
});

// ---------------------------------------------------------------------------
// 4. Recursive least squares
// ---------------------------------------------------------------------------

// Thermal fueltech so the design vector is exactly [1, y(t), y(t-1), y(t-2)]
// and the recovered coefficients can be read against the truth directly.
function runArx(ridge, truth, steps, r, hist) {
  const cap = 100;
  for (let t = 0; t < steps; t++) {
    const f = [1, hist[2] / cap, hist[1] / cap, hist[0] / cap];
    const next = cap * (
      truth[0] + truth[1] * f[1] + truth[2] * f[2] + truth[3] * f[3] + 0.02 * gauss(r)
    );
    ridge.update(
      state({ fueltech: 'coal_black', capacity_mw: cap, history: [...hist] }),
      next,
    );
    hist.shift();
    hist.push(next);
  }
}

test('RLS recovers a known ARX relationship and tracks a mid-stream change in it', () => {
  const ridge = new OnlineRidge();
  const r = rng(3);
  const hist = [60, 62, 64];

  const truthA = [0.10, 0.60, 0.20, 0.05];
  runArx(ridge, truthA, 20000, r, hist);
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(ridge.w[i] - truthA[i]) < 0.05,
      `coefficient ${i}: ${ridge.w[i].toFixed(4)} vs truth ${truthA[i]}`,
    );
  }

  // The plant changes. A least-squares fit with no forgetting would average the
  // two regimes forever; the forgetting factor is what lets it move.
  const truthB = [0.35, 0.15, 0.05, 0.05];
  runArx(ridge, truthB, 20000, r, hist);
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(ridge.w[i] - truthB[i]) < 0.05,
      `after the change, coefficient ${i}: ${ridge.w[i].toFixed(4)} vs truth ${truthB[i]}`,
    );
  }

  // And the covariance has stayed finite through 40,000 updates.
  for (const v of ridge.P) assert.ok(Number.isFinite(v));
});

test('RLS keeps its covariance symmetric', () => {
  const ridge = new OnlineRidge();
  const r = rng(5);
  const hist = [10, 12, 14];
  runArx(ridge, [0.05, 0.5, 0.3, 0.1], 3000, r, hist);
  const m = ridge.m;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      assert.equal(ridge.P[i * m + j], ridge.P[j * m + i]);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Clipping
// ---------------------------------------------------------------------------

test('every expert clips its forecast to [0, capacity]', () => {
  const cap = 150;
  const check = (expert, s, h) => {
    const y = expert.predict(s, h);
    assert.ok(Number.isFinite(y), `${expert.name} returned ${y}`);
    assert.ok(y >= 0, `${expert.name} returned ${y}, below zero`);
    assert.ok(y <= cap, `${expert.name} returned ${y}, above capacity ${cap}`);
  };

  for (const fueltech of ['wind', 'solar_utility', 'coal_black']) {
    // Absurd inputs in both directions, plus a gale past cut-out and a missing
    // weather field.
    const extremes = [
      state({
        capacity_mw: cap, fueltech,
        history: [1e9, 1e9, 1e9],
        weather: { wind_speed_100m: 400, temperature_2m: 60, clear_sky_index: 6, clear_sky_ghi: 4000 },
      }),
      state({
        capacity_mw: cap, fueltech,
        history: [-800, -900, -1000],
        weather: { wind_speed_100m: -50, temperature_2m: -30, clear_sky_index: -2, clear_sky_ghi: 900 },
      }),
      state({ capacity_mw: cap, fueltech, history: [0, 0, 0], weather: {} }),
      state({ capacity_mw: cap, fueltech, history: [], weather: {} }),
    ];

    for (const s of extremes) {
      for (const expert of buildExperts({ fueltech })) {
        for (const h of [1, 12, 288]) check(expert, s, h);
      }
    }

    // Learned experts have to stay clipped after being taught nonsense too.
    const bank = buildExperts({ fueltech });
    const r = rng(21);
    for (let t = 0; t < 400; t++) {
      const s = state({
        capacity_mw: cap, fueltech,
        history: [900, 950, 1000],
        tod_minutes: (t * 5) % 1440,
        weather: { wind_speed_100m: 11, temperature_2m: 25, clear_sky_index: 0.9, clear_sky_ghi: 800 },
      });
      // Alternate between impossible highs and impossible lows so the fitted
      // weights are pushed off both ends.
      const taught = t % 2 === 0 ? 5000 : -5000 + 10 * gauss(r);
      for (const expert of bank) expert.update(s, taught);
    }
    for (const expert of bank) {
      for (const h of [1, 12, 288]) {
        check(expert, state({ capacity_mw: cap, fueltech, history: [900, 950, 1000] }), h);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 6. RampAware against Persistence
// ---------------------------------------------------------------------------

// Skip the first half hour so both experts have a full trend window.
const TREND_START = 6;

function meanSquaredError(expert, series, cap, h, fueltech = 'coal_black') {
  let sum = 0;
  let n = 0;
  for (let t = TREND_START; t + h < series.length; t++) {
    const s = state({
      capacity_mw: cap, fueltech,
      history: series.slice(0, t + 1),
      weather: {},
    });
    const e = expert.predict(s, h) - series[t + h];
    sum += e * e;
    n++;
  }
  return sum / n;
}

test('RampAware beats Persistence on a monotonic ramp', () => {
  const cap = 300;
  const series = [];
  for (let t = 0; t < 400; t++) series.push(20 + 0.5 * t);

  const ramp = meanSquaredError(new RampAware(), series, cap, 1);
  const persist = meanSquaredError(new Persistence(), series, cap, 1);
  assert.ok(ramp < persist, `ramp ${ramp} should beat persistence ${persist}`);
  assert.ok(ramp < persist * 0.05, 'on a clean ramp the win should be decisive');

  // And it must still help several intervals out, where the damping is biting.
  const ramp6 = meanSquaredError(new RampAware(), series, cap, 6);
  const persist6 = meanSquaredError(new Persistence(), series, cap, 6);
  assert.ok(ramp6 < persist6);
});

test('Persistence beats RampAware on white noise: the damping must stop it chasing', () => {
  // Capacity well clear of the series, so this measures the damping rather than
  // the clip quietly rescuing an over-extrapolated forecast.
  const cap = 100_000;
  const r = rng(99);
  const series = [];
  for (let t = 0; t < 20000; t++) series.push(150 + 8 * gauss(r));

  const ramp = meanSquaredError(new RampAware(), series, cap, 1);
  const persist = meanSquaredError(new Persistence(), series, cap, 1);
  assert.ok(persist < ramp, `persistence ${persist} should beat ramp ${ramp} on noise`);
  // Damped, the penalty is a modest tax rather than a rout.
  assert.ok(ramp < persist * 1.5, `ramp is chasing noise: ${ramp} vs ${persist}`);

  // The damping earns its keep further out, where undamped linear extrapolation
  // of a half-hour slope multiplies the noise by the horizon. Reading a trend
  // straight out to four hours costs roughly 60x persistence; damped it is a
  // few per cent.
  const ramp48 = meanSquaredError(new RampAware(), series, cap, 48);
  const persist48 = meanSquaredError(new Persistence(), series, cap, 48);
  assert.ok(ramp48 < persist48 * 1.5, `undamped at long range: ${ramp48} vs ${persist48}`);
});

// ---------------------------------------------------------------------------
// Expert behaviour that would be silently wrong otherwise
// ---------------------------------------------------------------------------

test('wind curve is zero below cut-in and above cut-out, and rises monotonically between', () => {
  assert.equal(windFraction(2.9), 0);
  assert.equal(windFraction(25.1), 0);
  assert.equal(windFraction(40), 0);
  let previous = -1;
  for (let v = 3; v <= 25; v += 0.5) {
    const f = windFraction(v);
    assert.ok(f > previous, `curve not monotonic at ${v} m/s`);
    assert.ok(f >= 0 && f <= 1);
    previous = f;
  }
  assert.ok(windFraction(14) > 0.8, 'should be near rated well before cut-out');
});

test('solar curve is linear in clear-sky index at a fixed instant and derates with heat', () => {
  const clearSky = 1000;   // W/m^2, so clear-sky index reads straight as GHI/1000

  // Gain 0.95 at 1000 W/m^2, cells running 0.03 degC per W/m^2 above ambient,
  // losing 0.4%/degC above 25.
  const at = (csi, tempC) => solarFraction(csi, clearSky, tempC);
  assert.ok(Math.abs(at(1.0, 25) - 0.95 * (1 - 0.004 * 30)) < 1e-12);
  assert.ok(Math.abs(at(0.5, 25) - 0.95 * 0.5 * (1 - 0.004 * 15)) < 1e-12);

  // Linear in the index before the derate; the derate itself grows with
  // irradiance, so doubling the index gives slightly less than double output.
  const ratio = at(1.0, 25) / at(0.5, 25);
  assert.ok(ratio > 1.8 && ratio < 2.0, `ratio ${ratio} should sit just under two`);

  assert.ok(at(1.0, 40) < at(1.0, 10), 'a hot day must cost output');
  assert.equal(solarFraction(0.9, 0, 25), 0, 'no clear-sky reference means night');
  assert.equal(solarFraction(null, clearSky, 25), 0, 'a missing index must not produce NaN');
});

test('Physical falls back to persistence for a fueltech with no weather curve', () => {
  const s = state({ fueltech: 'coal_black', history: [500, 510, 520], capacity_mw: 700 });
  assert.equal(new Physical({ fueltech: 'coal_black' }).predict(s, 12), 520);
});

test('DiurnalClimatology learns a diurnal shape and holds it a day ahead', () => {
  const clim = new DiurnalClimatology();
  const cap = 100;
  const shape = (tod) => Math.max(0, 100 * Math.sin((Math.PI * (tod - 360)) / 720));

  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < 288; i++) {
      const tod = i * 5;
      const s = state({ capacity_mw: cap, fueltech: 'solar_utility', tod_minutes: tod, month: 3, history: [0] });
      // horizon_steps 0 keeps the training bucket aligned with tod_minutes.
      s.horizon_steps = 0;
      clim.update(s, shape(tod));
    }
  }

  const midnight = state({ capacity_mw: cap, fueltech: 'solar_utility', tod_minutes: 0, month: 3, history: [50] });
  const noon = state({ capacity_mw: cap, fueltech: 'solar_utility', tod_minutes: 720, month: 3, history: [50] });
  assert.ok(clim.predict(midnight, 0) < 1);
  assert.ok(clim.predict(noon, 0) > 90);
  // A day ahead lands back on the same bucket, which is the whole reason this
  // expert earns its place at long horizons.
  assert.ok(Math.abs(clim.predict(noon, 288) - clim.predict(noon, 0)) < 1e-9);
});

test('Analogue returns the matched instants and keeps its library bounded', () => {
  const analogue = new Analogue();
  const cap = 100;
  const r = rng(31);
  const base = Date.UTC(2026, 2, 1);

  // Output is a deterministic function of wind speed, so a good analogue match
  // has to reproduce it.
  const outputFor = (v) => Math.min(cap, Math.max(0, 8 * (v - 3)));

  for (let t = 0; t < 8000; t++) {
    const v = 3 + 12 * r();
    const s = state({
      capacity_mw: cap, fueltech: 'wind',
      observed_at: base + t * 300_000,
      tod_minutes: (t * 5) % 1440,
      history: [outputFor(v)],
      weather: { wind_speed_100m: v, temperature_2m: 20, clear_sky_index: 0, clear_sky_ghi: 0 },
    });
    analogue.update(s, outputFor(v));
  }

  assert.equal(analogue.lib.length, 5000, 'library must be capped, not unbounded');
  // Eviction must take the oldest: 8000 states into a 5000 slot ring leaves
  // nothing earlier than the 3000th.
  const oldest = Math.min(...analogue.lib.map((rec) => rec.at));
  assert.equal(oldest, base + 3000 * 300_000);

  const query = state({
    capacity_mw: cap, fueltech: 'wind',
    tod_minutes: 600,
    history: [outputFor(9)],
    weather: { wind_speed_100m: 9, temperature_2m: 20, clear_sky_index: 0, clear_sky_ghi: 0 },
  });
  const y = analogue.predict(query, 1);
  assert.ok(Math.abs(y - outputFor(9)) < 8, `analogue predicted ${y}, expected near ${outputFor(9)}`);

  const matches = analogue.matches();
  assert.equal(matches.length, 25);
  for (const m of matches) {
    assert.ok(Number.isFinite(m.observed_at) && m.observed_at >= base);
    assert.ok(m.distance >= 0);
  }
  // Sorted nearest first, and the weights the UI shows are normalised.
  for (let i = 1; i < matches.length; i++) assert.ok(matches[i].distance >= matches[i - 1].distance);
  assert.ok(Math.abs(matches.reduce((s, m) => s + m.weight, 0) - 1) < 1e-12);

  // Cold start must not pretend to know anything.
  const cold = new Analogue();
  assert.equal(cold.predict(query, 1), outputFor(9));
  assert.deepEqual(cold.matches(), []);
});

test('the bank presents one interface and the hedge can drive it end to end', () => {
  const cap = 180;
  const bank = buildExperts({ fueltech: 'wind' });
  const hedge = new Hedge({ names: bank.map((e) => e.name) });
  const r = rng(77);
  let previous = state({ capacity_mw: cap, fueltech: 'wind', history: [90] });

  for (let t = 0; t < 2000; t++) {
    const v = 8 + 3 * gauss(r);
    const actual = Math.min(cap, Math.max(0, cap * windFraction(v)));
    const predictions = {};
    for (const e of bank) predictions[e.name] = e.predict(previous, 1);
    const combined = hedge.combine(predictions);
    assert.ok(combined >= 0 && combined <= cap);

    for (const e of bank) e.update(previous, actual);
    hedge.update(predictions, actual, cap);

    previous = state({
      capacity_mw: cap, fueltech: 'wind',
      observed_at: previous.observed_at + 300_000,
      tod_minutes: (previous.tod_minutes + 5) % 1440,
      history: [...previous.history.slice(-6), actual],
      weather: { wind_speed_100m: v, temperature_2m: 20, clear_sky_index: 0, clear_sky_ghi: 0 },
    });
  }

  const w = hedge.weights();
  assert.equal(Object.keys(w).length, 6);
  assert.ok(Math.abs(Object.values(w).reduce((s, x) => s + x, 0) - 1) < 1e-12);
  for (const v of Object.values(w)) assert.ok(v >= 1e-4);
});
