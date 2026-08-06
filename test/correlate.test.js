import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pearson,
  spearman,
  laggedCrossCorrelation,
  mutualInformation,
  fitWindCurve,
  fitSolarCurve,
  correlateStation,
} from '../app/js/correlate.js';

const MS_PER_STEP = 300_000;
const T0 = Date.UTC(2026, 4, 1, 14, 0, 0);   // an interval boundary, AEST midnight

/** Deterministic uniform stream: a seeded run is reproducible on any host. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Roughly normal, from three uniforms. Enough for scatter around a curve. */
const jitter = (rnd, scale) => (rnd() + rnd() + rnd() - 1.5) * scale;

// A farm's aggregate power curve is not one turbine's. Machines are spread over
// tens of kilometres and never see the same wind at the same moment, so the
// sharp single-turbine knees at cut-in and rated come out rounded at farm level
// — which is why a logistic describes the aggregate well. Cut-out stays a cliff:
// when a front pushes the site past it the whole farm feathers together.
const CAPACITY = 200;
const TRUE_CUT_IN = 3.5;
const TRUE_RATED = 12.0;
const TRUE_CUT_OUT = 25.0;
const TRUE_K = (2 * Math.log(99)) / (TRUE_RATED - TRUE_CUT_IN);
const TRUE_V50 = (TRUE_RATED + TRUE_CUT_IN) / 2;

function trueWindCurve(v) {
  if (v >= TRUE_CUT_OUT) return 0;
  return CAPACITY / (1 + Math.exp(-TRUE_K * (v - TRUE_V50)));
}

/** Weibull-ish site wind speed, k = 2. */
const siteWind = (rnd, scale = 10.5) => scale * Math.sqrt(-Math.log(1 - rnd()));

/**
 * A synthetic wind farm with a known curve, curtailed when it is producing hard.
 *
 * Curtailment is deliberately not random across the wind distribution. Networks
 * constrain farms when the region is already full of wind, so the curtailed
 * intervals cluster in exactly the part of the curve that fixes rated output.
 */
function syntheticWindFarm(seed, { curtailProbability = 0, outlierRate = 0 } = {}) {
  const rnd = lcg(seed);
  const n = 4000;
  const observations = [];
  const weather = [];

  for (let i = 0; i < n; i++) {
    const at = T0 + i * MS_PER_STEP;
    const speed = siteWind(rnd);
    let available = trueWindCurve(speed) + jitter(rnd, 0.06 * CAPACITY);
    if (outlierRate && rnd() < outlierRate) available = rnd() < 0.5 ? 0 : CAPACITY;
    available = Math.max(0, Math.min(CAPACITY, available));

    const capped = available > 0.55 * CAPACITY && rnd() < curtailProbability;
    // Partial curtailment, which is what a semi-scheduled farm actually gets:
    // a target somewhere below what the air is offering, not a hard zero.
    const output = capped ? available * (0.2 + 0.4 * rnd()) : available;

    observations.push({
      station_id: 'TESTWF',
      station_name: 'Test Wind Farm',
      capacity_mw: CAPACITY,
      observed_at: at,
      output_mw: output,
      uigf_mw: available,
      capped,
      quality: 'ok',
    });
    weather.push({ observed_at: at, wind_speed_100m: speed, temperature_2m: 15 + jitter(rnd, 4) });
  }

  return { observations, weather };
}

test('curtailment mask: fitting curtailed intervals biases the curve, masking them recovers it', () => {
  const { observations, weather } = syntheticWindFarm(20260806, { curtailProbability: 0.55 });

  const cappedFraction = observations.filter((o) => o.capped).length / observations.length;
  assert.ok(cappedFraction > 0.27 && cappedFraction < 0.33,
    `expected roughly 30% curtailed, got ${(cappedFraction * 100).toFixed(1)}%`);

  // The controlled comparison: same station, same variable, same curve. The only
  // difference between the two fits is whether the curtailed intervals are in.
  const allSpeeds = weather.map((w) => w.wind_speed_100m);
  const allOutputs = observations.map((o) => o.output_mw);
  const keep = observations.map((o) => !o.capped);
  const maskedFit = fitWindCurve(
    allSpeeds.filter((_, i) => keep[i]),
    allOutputs.filter((_, i) => keep[i]),
    CAPACITY,
  );
  const unmaskedFit = fitWindCurve(allSpeeds, allOutputs, CAPACITY);

  assert.equal(maskedFit.converged, true);
  assert.equal(unmaskedFit.converged, true);

  // Masked: the true curve comes back.
  assert.ok(Math.abs(maskedFit.ratedOutput - CAPACITY) < 8,
    `masked rated output ${maskedFit.ratedOutput.toFixed(1)} MW should be near ${CAPACITY}`);
  assert.ok(Math.abs(maskedFit.rated - TRUE_RATED) < 0.6,
    `masked rated speed ${maskedFit.rated.toFixed(2)} m/s should be near ${TRUE_RATED}`);
  assert.ok(Math.abs(maskedFit.cutIn - TRUE_CUT_IN) < 0.6,
    `masked cut-in ${maskedFit.cutIn.toFixed(2)} m/s should be near ${TRUE_CUT_IN}`);
  assert.ok(Math.abs(maskedFit.cutOut - TRUE_CUT_OUT) < 0.8,
    `masked cut-out ${maskedFit.cutOut.toFixed(2)} m/s should be near ${TRUE_CUT_OUT}`);

  // Unmasked: measurably, and badly, wrong. A robust loss does not save it —
  // curtailment is not scattered noise, it is a systematic majority of the
  // high-wind intervals.
  assert.ok(unmaskedFit.ratedOutput < CAPACITY - 40,
    `unmasked rated output ${unmaskedFit.ratedOutput.toFixed(1)} MW should be biased well below ${CAPACITY}`);
  assert.ok(Math.abs(unmaskedFit.rated - TRUE_RATED) > 1,
    `unmasked rated speed ${unmaskedFit.rated.toFixed(2)} m/s should not recover ${TRUE_RATED}`);
  assert.ok(unmaskedFit.rmse > 4 * maskedFit.rmse,
    `unmasked rmse ${unmaskedFit.rmse.toFixed(1)} should be far worse than masked ${maskedFit.rmse.toFixed(1)}`);

  // And the mask is actually wired into the station bundle, not just available
  // to a caller who remembers to apply it.
  const bundle = correlateStation(observations, weather, 'wind');
  assert.equal(bundle.target, 'uigf_mw');
  assert.ok(Math.abs(bundle.masked_fraction - cappedFraction) < 1e-9);
  assert.ok(Math.abs(bundle.curve.ratedOutput - maskedFit.ratedOutput) < 1,
    'the bundle curve should be the masked fit');
});

test('spearman survives a monotone nonlinearity that pearson does not', () => {
  const rnd = lcg(7);
  const speed = [];
  const power = [];
  for (let i = 0; i < 2000; i++) {
    const v = 15 * rnd();
    speed.push(v);
    // Power in moving air goes as v^3, and there is none at all below cut-in.
    power.push(v < TRUE_CUT_IN ? 0 : v ** 3 - TRUE_CUT_IN ** 3);
  }

  const r = pearson(speed, power);
  const rho = spearman(speed, power);

  assert.ok(rho > 0.99, `spearman ${rho.toFixed(3)} should be near 1 on a monotone relationship`);
  assert.ok(r < 0.94, `pearson ${r.toFixed(3)} should be materially below 1 on a cubic`);
  assert.ok(rho - r > 0.05, `expected a material gap, got ${(rho - r).toFixed(3)}`);
});

test('mutual information sees a fold that both correlations miss', () => {
  const rnd = lcg(31);
  const speed = [];
  const power = [];
  for (let i = 0; i < 4000; i++) {
    const v = 30 * rnd();
    let p;
    if (v < 8) p = 0;                                  // below cut-in
    else if (v < 14) p = CAPACITY * (v - 8) / 6;       // ramp
    else if (v <= 22) p = CAPACITY;                    // rated
    else p = 0;                                        // feathered above cut-out
    speed.push(v);
    power.push(p);
  }

  const r = pearson(speed, power);
  const rho = spearman(speed, power);
  const bits = mutualInformation(speed, power);

  // A gale and a dead calm both read zero MW, so neither correlation finds a
  // direction. The relationship is still deterministic.
  assert.ok(Math.abs(r) < 0.25, `pearson ${r.toFixed(3)} should be near zero`);
  assert.ok(Math.abs(rho) < 0.25, `spearman ${rho.toFixed(3)} should be near zero`);
  assert.ok(bits > 0.5, `mutual information ${bits.toFixed(3)} bits should be clearly positive`);
});

test('lagged cross-correlation recovers an injected lag, in both directions', () => {
  const rnd = lcg(4242);
  const n = 3000;

  // A smooth, non-periodic series, so the peak is unambiguous. White noise would
  // give a correlation of zero at every non-zero lag and a spike at the shift;
  // smoothing makes the test look like weather instead.
  const raw = new Float64Array(n + 200);
  let level = 8;
  for (let i = 0; i < raw.length; i++) {
    level += jitter(rnd, 0.25);
    raw[i] = level;
  }

  const lagSteps = 18;   // 90 minutes
  const weather = new Float64Array(n);
  const trails = new Float64Array(n);
  const leads = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    weather[i] = raw[i + 100];
    trails[i] = raw[i + 100 - lagSteps] + jitter(rnd, 0.05);  // output follows weather
    leads[i] = raw[i + 100 + lagSteps] + jitter(rnd, 0.05);   // output runs ahead
  }

  const behind = laggedCrossCorrelation(weather, trails);
  const ahead = laggedCrossCorrelation(weather, leads);

  assert.equal(behind.peakLag, lagSteps);
  assert.equal(ahead.peakLag, -lagSteps);
  assert.equal(behind.lags.length, 145);
  assert.equal(behind.lags[0], -72);
  assert.equal(behind.lags[144], 72);
  assert.ok(behind.values[behind.lags.indexOf(lagSteps)] > 0.99);
});

test('wind curve fit recovers cut-in, rated and cut-out through noise and outliers', () => {
  const { observations, weather } = syntheticWindFarm(31337, { outlierRate: 0.03 });
  const speeds = weather.map((w) => w.wind_speed_100m);
  const outputs = observations.map((o) => o.output_mw);

  const fit = fitWindCurve(speeds, outputs, CAPACITY);
  assert.equal(fit.converged, true);

  // Tolerances stated: 0.35 m/s on the two knees, 0.5 m/s on cut-out, and 3% of
  // nameplate on rated output, against a 200 MW farm carrying 6% scatter plus 3%
  // gross outliers. Cut-in comes back consistently 0.15 m/s high because output
  // cannot go negative: clipping the scatter at zero lifts the low-wind tail and
  // takes the fitted knee with it. That bias is in the physics, not the fitter.
  assert.ok(Math.abs(fit.cutIn - TRUE_CUT_IN) < 0.35, `cut-in ${fit.cutIn.toFixed(2)}`);
  assert.ok(Math.abs(fit.rated - TRUE_RATED) < 0.35, `rated speed ${fit.rated.toFixed(2)}`);
  assert.ok(Math.abs(fit.cutOut - TRUE_CUT_OUT) < 0.5, `cut-out ${fit.cutOut.toFixed(2)}`);
  assert.ok(Math.abs(fit.ratedOutput - CAPACITY) < 0.03 * CAPACITY,
    `rated output ${fit.ratedOutput.toFixed(1)} MW`);

  for (const v of [2, 6, 9, 14, 20]) {
    assert.ok(Math.abs(fit.predict(v) - trueWindCurve(v)) < 0.06 * CAPACITY,
      `predict(${v}) = ${fit.predict(v).toFixed(1)} against ${trueWindCurve(v).toFixed(1)} MW`);
  }
  assert.equal(fit.predict(TRUE_CUT_OUT + 2), 0);
});

test('constant input gives zero correlation rather than NaN', () => {
  const flat = new Array(500).fill(42);
  const varying = Array.from({ length: 500 }, (_, i) => Math.sin(i / 9));

  assert.equal(pearson(flat, varying), 0);
  assert.equal(pearson(varying, flat), 0);
  assert.equal(pearson(flat, flat), 0);
  assert.equal(spearman(flat, varying), 0);
  assert.equal(spearman(varying, flat), 0);
  assert.equal(spearman(flat, flat), 0);
  assert.equal(mutualInformation(flat, varying), 0);

  const lag = laggedCrossCorrelation(flat, varying, 6);
  assert.ok(lag.values.every((v) => v === 0));
  assert.equal(lag.peakLag, null, 'a flat profile has no peak to report');
});

test('sparse and featureless data return a did-not-converge signal, not a curve', () => {
  const { observations, weather } = syntheticWindFarm(11, {});
  const speeds = weather.map((w) => w.wind_speed_100m).slice(0, 40);
  const outputs = observations.map((o) => o.output_mw).slice(0, 40);

  const sparse = fitWindCurve(speeds, outputs, CAPACITY);
  assert.equal(sparse.converged, false);
  assert.equal(sparse.predict, null);
  assert.match(sparse.reason, /too few/);

  const becalmed = fitWindCurve(new Array(600).fill(4), new Array(600).fill(0), CAPACITY);
  assert.equal(becalmed.converged, false);
  assert.equal(becalmed.ratedOutput, null);
});

test('solar curve recovers gain and temperature coefficient', () => {
  const rnd = lcg(808);
  const capacity = 120;
  const trueGain = 0.92;
  const trueTempCoeff = 0.0042;

  const csi = [];
  const ghi = [];
  const temp = [];
  const output = [];
  for (let i = 0; i < 3000; i++) {
    const minuteOfDay = (i * 5) % 1440;
    const solarAngle = Math.sin((Math.PI * (minuteOfDay - 360)) / 720);
    const clearSky = solarAngle > 0 ? 1000 * solarAngle : 0;
    if (clearSky <= 0) continue;
    const index = 0.25 + 0.75 * rnd();
    const ambient = 18 + 14 * solarAngle + jitter(rnd, 2);
    const irradiance = index * clearSky;
    const cellC = ambient + 0.03 * irradiance;
    const mw = capacity * trueGain * (irradiance / 1000)
      * (1 - trueTempCoeff * Math.max(0, cellC - 25));

    csi.push(index);
    ghi.push(clearSky);
    temp.push(ambient);
    output.push(Math.max(0, mw + jitter(rnd, 0.01 * capacity)));
  }

  const fit = fitSolarCurve(csi, ghi, temp, output, capacity);
  assert.equal(fit.converged, true);
  assert.ok(Math.abs(fit.gain - trueGain) < 0.02, `gain ${fit.gain.toFixed(4)}`);
  assert.ok(Math.abs(fit.tempCoeff - trueTempCoeff) < 0.0008, `tempCoeff ${fit.tempCoeff.toFixed(5)}`);
  assert.ok(fit.rmse < 0.02 * capacity, `rmse ${fit.rmse.toFixed(2)} MW`);
});

test('station bundle masks on quality as well as curtailment, and reports the fraction', () => {
  const { observations, weather } = syntheticWindFarm(5150, { curtailProbability: 0.4 });
  // Telemetry the ingest could not vouch for, plus intervals whose curtailment
  // state is not yet known because the next-day file has not landed.
  for (let i = 0; i < observations.length; i += 25) observations[i].quality = 'suspect';
  for (let i = 7; i < observations.length; i += 50) observations[i].capped = null;

  const bundle = correlateStation(observations, weather, 'wind');
  const usable = observations.filter((o) => o.capped === false && o.quality === 'ok').length;

  assert.equal(bundle.n_total, observations.length);
  assert.equal(bundle.n_used, usable);
  assert.ok(bundle.masked_fraction > bundle.capped_fraction,
    'quality and unknown-mask exclusions must count towards the masked fraction');
  assert.ok(bundle.weather_modelled);
  assert.ok(bundle.variables.wind_speed_100m.spearman > 0.9);
  assert.equal(bundle.variables.wind_speed_100m.peak_lag_steps, 0);
  assert.equal(bundle.variables.wind_speed_100m.peak_lag_minutes, 0);
  assert.equal(bundle.curve.converged, true);
});

test('batteries are correlated for display but flagged out of weather modelling', () => {
  const rnd = lcg(66);
  const observations = [];
  const weather = [];
  for (let i = 0; i < 600; i++) {
    const at = T0 + i * MS_PER_STEP;
    observations.push({
      station_id: 'TESTBESS',
      capacity_mw: 100,
      observed_at: at,
      output_mw: 100 * Math.sin(i / 30),
      uigf_mw: null,
      capped: false,
      quality: 'ok',
    });
    weather.push({ observed_at: at, wind_speed_100m: 6 + jitter(rnd, 2) });
  }

  const bundle = correlateStation(observations, weather, 'battery_discharging');
  assert.equal(bundle.weather_modelled, false);
  assert.equal(bundle.target, 'output_mw');
  assert.equal(bundle.curve, null);
  assert.ok(Number.isFinite(bundle.variables.wind_speed_100m.pearson));
});

test('hourly weather is interpolated onto the five-minute grid, not held flat', () => {
  // Weather on a perfectly straight ramp, so linear interpolation reconstructs
  // the five-minute series exactly and the correlation has to come out at 1.
  const rampAt = (step) => 4 + step * 0.002;
  const observations = [];
  const weather = [];
  for (let step = 0; step <= 288; step++) {
    const at = T0 + step * MS_PER_STEP;
    observations.push({
      station_id: 'TESTHYDRO',
      capacity_mw: 300,
      observed_at: at,
      output_mw: 40 * rampAt(step),
      capped: false,
      quality: 'ok',
    });
    if (step % 12 === 0) weather.push({ observed_at: at, temperature_2m: rampAt(step) });
  }

  const bundle = correlateStation(observations, weather, 'hydro');
  // The threshold has to be this tight to mean anything: holding each hourly
  // reading flat across its twelve intervals still correlates at 0.9991 here, so
  // any looser test passes on a staircase.
  assert.ok(bundle.variables.temperature_2m.pearson > 0.999999,
    `pearson ${bundle.variables.temperature_2m.pearson.toFixed(8)}`);
  // A straight line shifted is still a straight line, so it correlates at 1
  // against itself at every lag and the argmax is decided by rounding error.
  // Reporting no peak is the honest answer: a featureless series carries no
  // timing information to recover.
  assert.equal(bundle.variables.temperature_2m.peak_lag_steps, null);
  assert.equal(bundle.variables.temperature_2m.peak_lag_minutes, null);
  assert.ok(bundle.variables.temperature_2m.peak_lag_prominence < 1e-6);
  assert.equal(bundle.target, 'output_mw');
});

test('a variable survives a null in the first weather record', () => {
  // Providers return nulls at the edges of a backfill window. Deciding which
  // variables exist from record zero alone drops the whole series for that
  // variable, and nothing downstream reports a variable that was never there —
  // for solar that is clear_sky_index, the one it is judged on.
  const { observations, weather } = syntheticWindFarm(777, {});
  const complete = correlateStation(observations, weather, 'wind');
  assert.ok(complete.variables.temperature_2m, 'baseline must have the variable');

  weather[0] = { ...weather[0], temperature_2m: null };
  const withNull = correlateStation(observations, weather, 'wind');
  assert.ok(withNull.variables.temperature_2m,
    'one null reading must not delete the variable from the station');

  // And a key genuinely absent from the first record but present later.
  const { observations: o2, weather: w2 } = syntheticWindFarm(778, {});
  delete w2[0].temperature_2m;
  assert.ok(correlateStation(o2, w2, 'wind').variables.temperature_2m);
});

test('a station with no usable capacity gets no curve rather than an infinite one', () => {
  // Every parameter is a fraction of nameplate. A zero capacity used to divide
  // through and return gain = Infinity under converged: true, which reads as a
  // successful fit to anything that checks the flag.
  const { observations, weather } = syntheticWindFarm(4242, {});
  const speeds = weather.map((w) => w.wind_speed_100m);
  const outputs = observations.map((o) => o.output_mw);

  for (const cap of [0, -5, null, NaN]) {
    const wind = fitWindCurve(speeds, outputs, cap);
    assert.equal(wind.converged, false, `wind capacity ${cap}`);
    assert.equal(wind.predict, null);

    const solar = fitSolarCurve(
      new Array(400).fill(0.8), new Array(400).fill(800),
      new Array(400).fill(25), new Array(400).fill(50), cap,
    );
    assert.equal(solar.converged, false, `solar capacity ${cap}`);
    assert.equal(solar.gain, null);
    assert.equal(solar.predict, null);
  }
});

test('a target masked down to nothing reads as constant, not as zero relationship', () => {
  // Removing curtailed intervals correctly can leave a station with no
  // admissible data at all. "No relationship" and "nothing to measure" must not
  // present the same way on a chart.
  const { observations, weather } = syntheticWindFarm(2468, {});
  const blank = observations.map((o) => ({ ...o, output_mw: null, uigf_mw: null }));

  const bundle = correlateStation(blank, weather, 'hydro');
  assert.equal(bundle.n_used, blank.length, 'the intervals themselves are usable');
  assert.equal(bundle.target_constant, true);

  // The ordinary varying case must still read false.
  assert.equal(correlateStation(observations, weather, 'wind').target_constant, false);
});

test('a lag is reported only when the profile actually has a peak', () => {
  // Structure the driver so that shifting it genuinely degrades the match. That
  // is the condition under which a peak lag means anything physical.
  const n = 600;
  const driver = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    driver[i] = Math.sin(i / 17) + 0.6 * Math.sin(i / 5.5) + 0.3 * Math.sin(i / 2.3);
  }

  const LAG = 7;
  const late = new Float64Array(n).fill(NaN);
  for (let i = 0; i + LAG < n; i++) late[i + LAG] = driver[i];
  const found = laggedCrossCorrelation(driver, late, 24);
  assert.equal(found.peakLag, LAG, `peak lag ${found.peakLag}`);
  assert.ok(found.prominence > 0.1, `prominence ${found.prominence}`);

  // The other direction too, so a sign error cannot pass unnoticed.
  const early = new Float64Array(n).fill(NaN);
  for (let i = LAG; i < n; i++) early[i - LAG] = driver[i];
  assert.equal(laggedCrossCorrelation(driver, early, 24).peakLag, -LAG);

  // A straight ramp correlates at 1.0 against itself at every lag, so there is
  // no peak to find and none may be invented.
  const ramp = new Float64Array(n);
  for (let i = 0; i < n; i++) ramp[i] = 4 + i * 0.002;
  const flat = laggedCrossCorrelation(ramp, ramp, 24);
  assert.equal(flat.peakLag, null);
  assert.ok(flat.prominence < 1e-6, `prominence ${flat.prominence}`);
});
