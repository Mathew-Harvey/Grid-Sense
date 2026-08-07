// The replay trainer.
//
// The dashboard's central claim is that the band around the forecast is earned
// rather than asserted, and the only way to show that is to make the model earn
// it in front of the reader: walk the backfill forward one dispatch interval at
// a time, issue a forecast from what existed at that instant, then reveal the
// outcome and let every expert, the Hedge weights and the conformal calibration
// move on it.
//
// It runs here rather than on the main thread because a single interval of a
// dozen stations across five horizons is several milliseconds of arithmetic, and
// the whole point is that the band is visibly breathing while it happens. A
// 16 ms frame budget spent learning is a frame not spent drawing.
//
// Two structural rules, both carried over from the offline backtest this
// mirrors. A forecast is scored only against data that arrived after it was
// issued, so each horizon carries its own queue of forecasts in flight. And a
// curtailed interval is excluded from every learning path — expert updates,
// Hedge weights, conformal calibration alike — because the gap between forecast
// and output when a plant is capped is the market's instruction, not the model's
// mistake.
//
// Results leave here as transferable typed arrays. Structured-cloning a fat
// object of a few hundred intervals every frame is, measurably, the thing that
// blows the budget this worker exists to protect.

import { buildExperts } from './models/experts.js';
import { Hedge } from './models/hedge.js';
import { AdaptiveConformal } from './models/conformal.js';
import { crps, skillScore, pitValue } from './models/score.js';
import { getStationDay, getWeatherDay } from './store.js';

const MS_PER_STEP = 300_000;

/** The horizons the dashboard reports, in 5-minute steps. */
const HORIZONS = [
  { label: '5min', steps: 1 },
  { label: '30min', steps: 6 },
  { label: '1h', steps: 12 },
  { label: '6h', steps: 72 },
  { label: '24h', steps: 288 },
];

// The horizon the conviction band draws in its history: recent enough that the
// forecast is still meaningful, far enough out that beating persistence means
// something.
const DISPLAY_HORIZON = 2;

const QUANTILE_LEVELS = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];
const WEATHER_DRIVEN = new Set(['wind', 'solar_utility']);

// Both constants are the offline backtest's, unchanged. A replay that tuned
// itself differently would produce skill scores that do not reconcile with the
// numbers already published in the skill matrix beside it.
const LOSS_SPAN = 0.2;
const ETA = Math.sqrt((8 * Math.log(6)) / 5000) / LOSS_SPAN;
const GAMMA = 0.005;

// One day of dispatch on screen at a time.
const WINDOW = 288;

// A rolling mean over this many scored intervals is what the training monitor
// draws; short enough to show the model reacting, long enough not to be noise.
const ROLL = 288;

const PIT_BINS = 10;

// ---------------------------------------------------------------------------
// Series assembly
// ---------------------------------------------------------------------------

/** Rebuild hourly weather rows from the column-wise records the loader wrote. */
function weatherRows(packed) {
  const rows = [];
  for (let i = 0; i < packed.n; i++) {
    const row = { observed_at: packed.t[i] };
    for (let k = 0; k < packed.lanes.length; k++) {
      const v = packed.values[k][i];
      if (Number.isFinite(v)) row[packed.lanes[k]] = v;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Weather on the 5-minute grid.
 *
 * Linear between hourly readings, and nothing here reaches past the reading
 * either side of the target instant — the forecast is only ever entitled to
 * weather that would genuinely have been available for the time it describes.
 */
function toWeatherGrid(rows, t0, steps) {
  const grid = new Array(steps).fill(null);
  if (rows.length === 0) return grid;
  let j = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + i * MS_PER_STEP;
    while (j + 1 < rows.length && rows[j + 1].observed_at <= t) j++;
    const a = rows[j];
    const b = rows[j + 1];
    if (!a || t < a.observed_at) continue;
    if (!b) { grid[i] = a; continue; }
    const f = (t - a.observed_at) / (b.observed_at - a.observed_at);
    const row = {};
    for (const k of Object.keys(a)) {
      const av = a[k];
      const bv = b[k];
      row[k] = Number.isFinite(av) && Number.isFinite(bv) ? av + f * (bv - av) : av;
    }
    grid[i] = row;
  }
  return grid;
}

async function readStationDays(stationId, days) {
  const out = [];
  for (const day of days) {
    const packed = await getStationDay(stationId, day.ms);
    if (packed) out.push(packed);
  }
  return out;
}

/**
 * The state vector an expert sees, built only from data available at index i.
 *
 * The weather it carries is the outlook for the instant being forecast. In live
 * operation that is a forecast; in a replay over an archive it is reanalysis,
 * which is a more generous input than an operational system would have. The
 * skill scores here are honest about the past and optimistic about the future,
 * and that distinction is worth keeping in mind when reading them.
 */
function stateAt(track, i, horizonSteps) {
  const observedAt = track.t0 + i * MS_PER_STEP;
  const nem = new Date(observedAt + 10 * 3600_000);
  const w = track.weather;
  return {
    capacity_mw: track.capacity,
    fueltech: track.fueltech,
    history: track.history,
    horizon_steps: horizonSteps,
    month: nem.getUTCMonth() + 1,
    observed_at: observedAt,
    tod_minutes: nem.getUTCHours() * 60 + nem.getUTCMinutes(),
    weather: w ? w[Math.min(i + horizonSteps, w.length - 1)] : null,
  };
}

function newSlot(names, capacity) {
  return {
    hedge: new Hedge({ names, eta: ETA }),
    conformal: new AdaptiveConformal({ targetCoverage: 0.9, gamma: GAMMA, window: 2000, capacityMw: capacity }),
    conformal80: new AdaptiveConformal({ targetCoverage: 0.8, gamma: GAMMA, window: 2000, capacityMw: capacity }),
    queue: [],
    crpsModel: 0,
    crpsPersistence: 0,
    n: 0,
    hit90: 0,
    hit80: 0,
    pit: new Float64Array(PIT_BINS),
    expertCrps: names.map(() => 0),
    lastIssued: null,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

let run = null;

/** Load every station's series and weather, and build the learners. */
async function build(message) {
  const { stations, days } = message;
  const perStation = [];

  for (let s = 0; s < stations.length; s++) {
    const meta = stations[s];
    post({ type: 'building', label: meta.station_name, done: s, total: stations.length });

    const packedDays = await readStationDays(meta.station_id, days);
    if (packedDays.length === 0) continue;

    // Stitch the day records into one series before gridding: the day boundary
    // is a filing convention, not a break in the plant's output.
    const samples = [];
    for (const p of packedDays) {
      for (let i = 0; i < p.n; i++) {
        samples.push({
          at: p.t[i] * 60_000,
          output: p.output[i],
          uigf: p.uigf[i],
          curtailed: p.curtailed[i],
          capped: (p.flags[i] & 1) !== 0,
          ok: (p.flags[i] & 6) === 0,
        });
      }
    }
    if (samples.length < 2) continue;
    samples.sort((a, b) => a.at - b.at);
    perStation.push({ meta, samples });
  }

  if (perStation.length === 0) {
    post({ type: 'empty', message: 'No dispatch is stored for the requested stations.' });
    return null;
  }

  const t0 = Math.min(...perStation.map((p) => p.samples[0].at));
  const tEnd = Math.max(...perStation.map((p) => p.samples.at(-1).at));
  const steps = Math.round((tEnd - t0) / MS_PER_STEP) + 1;

  const tracks = [];
  for (const { meta, samples } of perStation) {
    const target = new Float64Array(steps).fill(NaN);
    const output = new Float64Array(steps).fill(NaN);
    const curtailed = new Float64Array(steps);
    const usable = new Uint8Array(steps);

    // UIGF is the available-energy figure a semi-scheduled plant is measured
    // against, and it is the field the offline backtest forecasts for wind and
    // solar. Falling back to output where UIGF is largely absent keeps a station
    // in the replay rather than dropping it.
    let uigfCount = 0;
    for (const s of samples) if (Number.isFinite(s.uigf)) uigfCount++;
    const useUigf = WEATHER_DRIVEN.has(meta.fueltech) && uigfCount >= samples.length / 2;

    for (const s of samples) {
      const i = Math.round((s.at - t0) / MS_PER_STEP);
      if (i < 0 || i >= steps) continue;
      const y = useUigf ? s.uigf : s.output;
      target[i] = y;
      output[i] = s.output;
      curtailed[i] = Number.isFinite(s.curtailed) ? s.curtailed : 0;
      usable[i] = s.ok && !s.capped && Number.isFinite(y) ? 1 : 0;
    }

    const rows = [];
    for (const day of message.days) {
      const packed = await getWeatherDay(meta.station_id, day.ms);
      if (packed) rows.push(...weatherRows(packed));
    }
    rows.sort((a, b) => a.observed_at - b.observed_at);

    const experts = buildExperts({ fueltech: meta.fueltech, curve: meta.curve ?? null });
    const names = experts.map((e) => e.name);

    tracks.push({
      meta,
      capacity: meta.capacity_mw,
      fueltech: meta.fueltech,
      t0,
      target,
      output,
      curtailed,
      usable,
      weather: rows.length ? toWeatherGrid(rows, t0, steps) : null,
      hasWeather: rows.length > 0,
      experts,
      // Held by name because the analogue's whole justification is that its
      // pick can be shown: "conditions most resemble 14 March 15:20".
      analogueExpert: experts.find((e) => e.name === 'analogue') ?? null,
      analogue: null,
      names,
      history: [],
      slots: HORIZONS.map(() => newSlot(names, meta.capacity_mw)),
    });
  }

  const names = tracks[0].names;
  const fleetCapacity = tracks.reduce((a, t) => a + t.capacity, 0);

  // Fuel and region indices are resolved once, here, so the per-interval loop
  // does an array write rather than a string lookup. At 500 intervals a second
  // across the fleet that difference is the frame budget.
  const fueltechs = [...new Set(tracks.map((t) => t.fueltech))].sort();
  const regions = [...new Set(tracks.map((t) => t.meta.region))].sort();
  for (const t of tracks) {
    t.fuelIndex = fueltechs.indexOf(t.fueltech);
    t.regionIndex = regions.indexOf(t.meta.region);
  }

  return {
    tracks,
    names,
    t0,
    steps,
    fleetCapacity,
    fleet: {
      capacity: fleetCapacity,
      slots: HORIZONS.map(() => ({
        conformal: new AdaptiveConformal({ targetCoverage: 0.9, gamma: GAMMA, window: 2000, capacityMw: fleetCapacity }),
        conformal80: new AdaptiveConformal({ targetCoverage: 0.8, gamma: GAMMA, window: 2000, capacityMw: fleetCapacity }),
        queue: [],
        crpsModel: 0,
        crpsPersistence: 0,
        n: 0,
        hit90: 0,
        hit80: 0,
        lastIssued: null,
      })),
    },
    cursor: 0,
    scored: 0,
    curtailedIntervals: 0,
    ring: makeRing(names.length, fueltechs, regions),
    fuelScratch: new Float64Array(fueltechs.length),
    regionScratch: new Float64Array(regions.length),
    running: false,
    startedAt: 0,
    stepsDone: 0,
    rate: 500,
  };
}

/** The last day of everything the charts draw, kept as a ring so a frame is a
 *  copy of fixed size no matter how long the replay has been going. */
function makeRing(expertCount, fueltechs = [], regions = []) {
  const byFuel = {};
  for (const ft of fueltechs) byFuel[ft] = new Float32Array(WINDOW).fill(NaN);
  const byRegion = {};
  for (const r of regions) byRegion[r] = new Float32Array(WINDOW).fill(NaN);
  return {
    head: 0,
    filled: 0,
    expertCount,
    fueltechs: [...fueltechs],
    regions: [...regions],
    byFuel,
    byRegion,
    t: new Float64Array(WINDOW),
    actual: new Float32Array(WINDOW).fill(NaN),
    forecast: new Float32Array(WINDOW).fill(NaN),
    hi90: new Float32Array(WINDOW).fill(NaN),
    lo90: new Float32Array(WINDOW).fill(NaN),
    hi80: new Float32Array(WINDOW).fill(NaN),
    lo80: new Float32Array(WINDOW).fill(NaN),
    ghostHi: new Float32Array(WINDOW).fill(NaN),
    ghostLo: new Float32Array(WINDOW).fill(NaN),
    weights: new Float32Array(WINDOW * expertCount),
    expertCrps: new Float32Array(WINDOW * expertCount).fill(NaN),
    crpsModel: new Float32Array(WINDOW).fill(NaN),
    crpsBase: new Float32Array(WINDOW).fill(NaN),
    cov90: new Float32Array(WINDOW).fill(NaN),
    cov80: new Float32Array(WINDOW).fill(NaN),
  };
}

/**
 * Advance the replay by one dispatch interval.
 *
 * The order is the whole discipline of the thing: score what has come due,
 * learn from the interval now revealed, and only then predict forward. Any
 * other order lets the outcome touch the forecast that was meant to precede it,
 * and the result is a skill score that looks like a triumph.
 */
function step(state) {
  const i = state.cursor;
  const { tracks, fleet } = state;

  const fleetActual = { sum: 0, complete: true };
  let anyCurtailed = false;
  const fuelSum = state.fuelScratch;
  const regionSum = state.regionScratch;
  fuelSum.fill(0);
  regionSum.fill(0);

  for (const track of tracks) {
    const y = track.target[i];
    const usable = track.usable[i] === 1;
    if (!usable) fleetActual.complete = false;
    if (Number.isFinite(y)) {
      fleetActual.sum += y;
      // Same pass as the fleet total. Walking the fleet twice per interval is
      // exactly the kind of thing that quietly eats the frame budget at 500
      // intervals a second.
      fuelSum[track.fuelIndex] += y;
      regionSum[track.regionIndex] += y;
    }
    if (track.curtailed[i] > 0) anyCurtailed = true;

    for (let h = 0; h < HORIZONS.length; h++) {
      const slot = track.slots[h];
      while (slot.queue.length && slot.queue[0].dueIndex <= i) {
        const issued = slot.queue.shift();
        if (issued.dueIndex !== i || !usable) continue;

        slot.crpsModel += crps(issued.quantiles, y);
        slot.crpsPersistence += Math.abs(issued.persistence - y);
        slot.n++;
        if (y >= issued.band90.lo && y <= issued.band90.hi) slot.hit90++;
        if (y >= issued.band80.lo && y <= issued.band80.hi) slot.hit80++;
        const bin = Math.min(PIT_BINS - 1, Math.max(0, Math.floor(pitValue(issued.quantiles, y) * PIT_BINS)));
        slot.pit[bin]++;
        for (let e = 0; e < track.names.length; e++) {
          slot.expertCrps[e] += Math.abs(issued.predictions[e] - y);
        }

        slot.hedge.update(issued.byName, y, track.capacity);
        slot.conformal.update(issued.point, y, issued.scale, issued.band90);
        slot.conformal80.update(issued.point, y, issued.scale, issued.band80);
      }
    }

    if (usable) {
      const learnState = stateAt(track, i, 0);
      for (const e of track.experts) e.update(learnState, y);
      track.history.push(y);
      if (track.history.length > 2000) track.history.shift();
    }
  }

  if (anyCurtailed) state.curtailedIntervals++;

  // ---- the fleet aggregate ------------------------------------------------
  for (let h = 0; h < HORIZONS.length; h++) {
    const slot = fleet.slots[h];
    while (slot.queue.length && slot.queue[0].dueIndex <= i) {
      const issued = slot.queue.shift();
      // The aggregate is only scored on an interval where every constituent
      // station is clean. One capped farm makes the fleet total a dispatch
      // outcome rather than a forecast outcome, and calibrating on it widens
      // the band for a week.
      if (issued.dueIndex !== i || !fleetActual.complete) continue;
      const y = fleetActual.sum;
      slot.crpsModel += Math.abs(issued.point - y);
      slot.crpsPersistence += Math.abs(issued.persistence - y);
      slot.n++;
      if (y >= issued.band90.lo && y <= issued.band90.hi) slot.hit90++;
      if (y >= issued.band80.lo && y <= issued.band80.hi) slot.hit80++;
      slot.conformal.update(issued.point, y, issued.scale, issued.band90);
      slot.conformal80.update(issued.point, y, issued.scale, issued.band80);
      if (h === DISPLAY_HORIZON) slot.due = issued;
    }
  }

  // ---- predict forward ----------------------------------------------------
  for (let h = 0; h < HORIZONS.length; h++) {
    const steps = HORIZONS[h].steps;
    const dueIndex = i + steps;
    if (dueIndex >= state.steps) continue;

    let fleetPoint = 0;
    let fleetPersistence = 0;
    let quadrature = 0;
    let issuedCount = 0;

    for (const track of tracks) {
      if (track.history.length < 12) continue;
      const slot = track.slots[h];
      const predictState = stateAt(track, i, steps);
      const predictions = track.experts.map((e) => e.predict(predictState, steps));
      if (predictions.some((p) => !Number.isFinite(p))) continue;

      // The analogue's scratch state reflects the predict() that just ran, so
      // the display horizon's neighbourhood has to be read here, before the
      // next horizon's search overwrites it.
      if (h === DISPLAY_HORIZON && track.analogueExpert) {
        track.analogue = track.analogueExpert.bestMatch() ?? track.analogue;
      }

      const byName = {};
      for (let e = 0; e < track.names.length; e++) byName[track.names[e]] = predictions[e];
      const point = slot.hedge.combine(byName);

      // Forecast error tracks how much the plant is generating: a solar farm at
      // midnight cannot be wrong, the same farm under broken cloud at noon can
      // be wrong by most of its nameplate. Residuals are stored in units of this
      // scale so one band does not have to serve both. The floor keeps it from
      // collapsing when the forecast is zero but the plant might still produce.
      const scale = Math.max(point, 0.05 * track.capacity) / track.capacity;
      const band90 = slot.conformal.interval(point, scale);
      const band80 = slot.conformal80.interval(point, scale);

      slot.queue.push({
        dueIndex,
        point,
        predictions,
        byName,
        quantiles: slot.conformal.quantiles(point, QUANTILE_LEVELS, scale),
        persistence: predictions[0],
        scale,
        band90,
        band80,
      });
      slot.lastIssued = { dueIndex, point, band90, band80 };

      fleetPoint += point;
      fleetPersistence += predictions[0];
      const half = (band90.hi - band90.lo) / 2;
      quadrature += half * half;
      issuedCount++;
    }

    if (issuedCount !== tracks.length) continue;

    const slot = fleet.slots[h];
    const scale = Math.max(fleetPoint, 0.05 * fleet.capacity) / fleet.capacity;
    const band90 = slot.conformal.interval(fleetPoint, scale);
    const band80 = slot.conformal80.interval(fleetPoint, scale);
    // The naive band: the station intervals summed as though their errors were
    // independent. They are not — neighbouring wind farms are all wrong about
    // the same weather front at the same minute — so this comes out visibly too
    // narrow, and the gap between it and the calibrated band is the clearest
    // statement of why correlated error matters.
    const ghost = Math.sqrt(quadrature);

    slot.queue.push({
      dueIndex, point: fleetPoint, persistence: fleetPersistence, scale, band90, band80, ghost,
    });
    slot.lastIssued = { dueIndex, point: fleetPoint, band90, band80, ghost };
  }

  recordFrame(state, i, fleetActual);
  state.cursor++;
  state.stepsDone++;
}

/** Write this interval into the display ring. */
function recordFrame(state, i, fleetActual) {
  const ring = state.ring;
  const k = ring.head;
  ring.t[k] = (state.t0 + i * MS_PER_STEP) / 1000;
  ring.actual[k] = fleetActual.sum;
  // step() filled these for this interval; they are read here rather than
  // passed, because the scratch buffers are reused every interval and copying
  // them into an argument would allocate once per interval for nothing.
  const fuel = state.fuelScratch;
  const region = state.regionScratch;
  for (let f = 0; f < ring.fueltechs.length; f++) ring.byFuel[ring.fueltechs[f]][k] = fuel[f];
  for (let r = 0; r < ring.regions.length; r++) ring.byRegion[ring.regions[r]][k] = region[r];

  const display = state.fleet.slots[DISPLAY_HORIZON];
  const due = display.due;
  if (due && due.dueIndex === i) {
    ring.forecast[k] = due.point;
    ring.hi90[k] = due.band90.hi;
    ring.lo90[k] = due.band90.lo;
    ring.hi80[k] = due.band80.hi;
    ring.lo80[k] = due.band80.lo;
    ring.ghostHi[k] = due.point + due.ghost;
    ring.ghostLo[k] = Math.max(0, due.point - due.ghost);
    display.due = null;
  } else {
    ring.forecast[k] = NaN;
    ring.hi90[k] = NaN;
    ring.lo90[k] = NaN;
    ring.hi80[k] = NaN;
    ring.lo80[k] = NaN;
    ring.ghostHi[k] = NaN;
    ring.ghostLo[k] = NaN;
  }

  // Capacity-weighted mean of the station weights: what the fleet's forecast is
  // actually leaning on, not what the average station is.
  const n = ring.expertCount;
  const base = k * n;
  for (let e = 0; e < n; e++) ring.weights[base + e] = 0;
  let totalCapacity = 0;
  for (const track of state.tracks) {
    const w = track.slots[DISPLAY_HORIZON].hedge.w;
    for (let e = 0; e < n; e++) ring.weights[base + e] += w[e] * track.capacity;
    totalCapacity += track.capacity;
  }
  if (totalCapacity > 0) for (let e = 0; e < n; e++) ring.weights[base + e] /= totalCapacity;

  // Fleet-mean expert error and the scored series, both as running means over
  // everything seen so far at the display horizon.
  let scored = 0;
  let crpsModel = 0;
  let crpsBase = 0;
  let hit90 = 0;
  let hit80 = 0;
  const expertSum = new Float64Array(n);
  for (const track of state.tracks) {
    const slot = track.slots[DISPLAY_HORIZON];
    if (slot.n === 0) continue;
    scored += slot.n;
    crpsModel += slot.crpsModel;
    crpsBase += slot.crpsPersistence;
    hit90 += slot.hit90;
    hit80 += slot.hit80;
    for (let e = 0; e < n; e++) expertSum[e] += slot.expertCrps[e];
  }
  for (let e = 0; e < n; e++) ring.expertCrps[base + e] = scored ? expertSum[e] / scored : NaN;
  ring.crpsModel[k] = scored ? crpsModel / scored : NaN;
  ring.crpsBase[k] = scored ? crpsBase / scored : NaN;
  ring.cov90[k] = scored ? hit90 / scored : NaN;
  ring.cov80[k] = scored ? hit80 / scored : NaN;
  state.scored = scored;

  ring.head = (ring.head + 1) % WINDOW;
  if (ring.filled < WINDOW) ring.filled++;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const STATS = [
  'cursor', 'steps', 'ratePerSecond', 'scoredIntervals', 'curtailedIntervals',
  'fleetCapacity', 'stationCount', 'weatherStations',
];
// Six figures per horizon, for the station bank and again for the fleet.
const PER_HORIZON = ['n', 'skill', 'crps', 'crpsBase', 'cov90', 'cov80'];

function statsFor(state) {
  const out = new Float64Array(STATS.length + HORIZONS.length * PER_HORIZON.length * 2);
  const rate = state.stepsDone > 0 && state.startedAt
    ? state.stepsDone / ((performance.now() - state.startedAt) / 1000)
    : 0;
  out[0] = state.cursor;
  out[1] = state.steps;
  out[2] = rate;
  out[3] = state.scored;
  out[4] = state.curtailedIntervals;
  out[5] = state.fleetCapacity;
  out[6] = state.tracks.length;
  out[7] = state.tracks.filter((t) => t.hasWeather).length;

  let at = STATS.length;
  for (let h = 0; h < HORIZONS.length; h++) {
    let n = 0, model = 0, base = 0, hit90 = 0, hit80 = 0;
    for (const track of state.tracks) {
      const slot = track.slots[h];
      n += slot.n; model += slot.crpsModel; base += slot.crpsPersistence;
      hit90 += slot.hit90; hit80 += slot.hit80;
    }
    out[at++] = n;
    out[at++] = n ? skillScore(model / n, base / n) : NaN;
    out[at++] = n ? model / n : NaN;
    out[at++] = n ? base / n : NaN;
    out[at++] = n ? hit90 / n : NaN;
    out[at++] = n ? hit80 / n : NaN;
  }
  for (let h = 0; h < HORIZONS.length; h++) {
    const s = state.fleet.slots[h];
    out[at++] = s.n;
    out[at++] = s.n ? skillScore(s.crpsModel / s.n, s.crpsPersistence / s.n) : NaN;
    out[at++] = s.n ? s.crpsModel / s.n : NaN;
    out[at++] = s.n ? s.crpsPersistence / s.n : NaN;
    out[at++] = s.n ? s.hit90 / s.n : NaN;
    out[at++] = s.n ? s.hit80 / s.n : NaN;
  }
  return out;
}

/** Unroll the ring into ascending order and append the fan the model is issuing
 *  right now, so the chart has both what happened and what is being claimed. */
function frame(state) {
  const ring = state.ring;
  const forward = HORIZONS.length;
  const size = ring.filled + forward;
  const start = (ring.head - ring.filled + WINDOW) % WINDOW;

  const t = new Float64Array(size);
  const lanes = {};
  for (const name of ['actual', 'forecast', 'hi90', 'lo90', 'hi80', 'lo80', 'ghostHi', 'ghostLo']) {
    lanes[name] = new Float32Array(size).fill(NaN);
  }
  const n = ring.expertCount;
  const weights = new Float32Array(ring.filled * n);
  const expertCrps = new Float32Array(ring.filled * n);
  const crpsModel = new Float32Array(ring.filled);
  const crpsBase = new Float32Array(ring.filled);
  const cov90 = new Float32Array(ring.filled);
  const cov80 = new Float32Array(ring.filled);

  for (let k = 0; k < ring.filled; k++) {
    const src = (start + k) % WINDOW;
    t[k] = ring.t[src];
    for (const name of Object.keys(lanes)) lanes[name][k] = ring[name][src];
    for (let e = 0; e < n; e++) {
      weights[k * n + e] = ring.weights[src * n + e];
      expertCrps[k * n + e] = ring.expertCrps[src * n + e];
    }
    crpsModel[k] = ring.crpsModel[src];
    crpsBase[k] = ring.crpsBase[src];
    cov90[k] = ring.cov90[src];
    cov80[k] = ring.cov80[src];
  }

  for (let h = 0; h < forward; h++) {
    const k = ring.filled + h;
    const issued = state.fleet.slots[h].lastIssued;
    t[k] = (state.t0 + (state.cursor - 1 + HORIZONS[h].steps) * MS_PER_STEP) / 1000;
    if (!issued) continue;
    lanes.forecast[k] = issued.point;
    lanes.hi90[k] = issued.band90.hi;
    lanes.lo90[k] = issued.band90.lo;
    lanes.hi80[k] = issued.band80.hi;
    lanes.lo80[k] = issued.band80.lo;
    lanes.ghostHi[k] = issued.point + issued.ghost;
    lanes.ghostLo[k] = Math.max(0, issued.point - issued.ghost);
  }

  const pit = new Float64Array(PIT_BINS);
  for (const track of state.tracks) {
    const slot = track.slots[DISPLAY_HORIZON];
    for (let b = 0; b < PIT_BINS; b++) pit[b] += slot.pit[b];
  }

  const byFuel = {};
  for (const ft of ring.fueltechs) {
    const lane = new Float32Array(ring.filled);
    for (let k = 0; k < ring.filled; k++) lane[k] = ring.byFuel[ft][(start + k) % WINDOW];
    byFuel[ft] = lane;
  }
  const regionNow = {};
  for (const r of ring.regions) {
    const src = (ring.head - 1 + WINDOW) % WINDOW;
    regionNow[r] = ring.byRegion[r][src];
  }

  const payload = {
    type: 'frame',
    byFuel,
    regionNow,
    regions: ring.regions,
    nowSec: (state.t0 + (state.cursor - 1) * MS_PER_STEP) / 1000,
    historyLength: ring.filled,
    expertCount: n,
    t,
    ...lanes,
    weights,
    expertCrps,
    crpsModel,
    crpsBase,
    cov90,
    cov80,
    pit,
    stats: statsFor(state),
  };

  const transfer = [t.buffer, weights.buffer, expertCrps.buffer, crpsModel.buffer,
    crpsBase.buffer, cov90.buffer, cov80.buffer, pit.buffer, payload.stats.buffer,
    ...Object.values(lanes).map((v) => v.buffer),
    ...Object.values(byFuel).map((v) => v.buffer)];
  post(payload, transfer);
}

/** Per-station skill, for the leaderboard. Small and slow-moving, so it goes as
 *  an ordinary object once a second rather than in every frame. */
function stationRows(state) {
  return state.tracks.map((track) => ({
    station_id: track.meta.station_id,
    station_name: track.meta.station_name,
    fueltech: track.fueltech,
    region: track.meta.region,
    capacity_mw: track.capacity,
    has_weather: track.hasWeather,
    analogue: track.analogue,
    horizons: HORIZONS.map((hz, h) => {
      const slot = track.slots[h];
      if (slot.n === 0) return { horizon: hz.label, n: 0, skill: null };
      return {
        horizon: hz.label,
        n: slot.n,
        skill: skillScore(slot.crpsModel / slot.n, slot.crpsPersistence / slot.n),
        crps: slot.crpsModel / slot.n,
        coverage90: slot.hit90 / slot.n,
        coverage80: slot.hit80 / slot.n,
        weights: slot.hedge.weights(),
        expert_mae: slot.expertCrps.map((v) => v / slot.n),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// A frame's worth of arithmetic, and no more. The replay must never hold the
// worker long enough that a pause or a seek waits on it.
const TICK_BUDGET_MS = 12;

let timer = null;
let lastRows = 0;

function tick() {
  timer = null;
  if (!run || !run.running) return;

  const deadline = performance.now() + TICK_BUDGET_MS;
  // At the requested rate, this is how many intervals belong to one frame.
  const quota = Math.max(1, Math.round(run.rate / 60));
  let done = 0;
  while (done < quota && run.cursor < run.steps && performance.now() < deadline) {
    step(run);
    done++;
  }

  frame(run);
  const now = performance.now();
  if (now - lastRows > 1000) {
    lastRows = now;
    post({ type: 'stations', rows: stationRows(run) });
  }

  if (run.cursor >= run.steps) {
    run.running = false;
    post({ type: 'handover', rows: stationRows(run), stats: statsFor(run) }, [/* stats is copied here deliberately */]);
    return;
  }
  timer = setTimeout(tick, 1000 / 60);
}

function start() {
  if (!run || run.running || run.cursor >= run.steps) return;
  run.running = true;
  run.startedAt = performance.now();
  run.stepsDone = 0;
  if (!timer) timer = setTimeout(tick, 0);
}

function pause() {
  if (!run) return;
  run.running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

/**
 * Move the replay to an absolute interval.
 *
 * Every learner here is path-dependent — that is the point of it — so there is
 * no such thing as rewinding one. Going backwards means starting again and
 * re-running to the target, which is honest and, at a few thousand intervals a
 * second with no rendering in the way, quick enough to feel like scrubbing.
 */
async function seek(index) {
  if (!run) return;
  pause();
  const target = Math.max(0, Math.min(run.steps - 1, Math.round(index)));
  if (target < run.cursor) {
    const rebuilt = await build(run.source);
    if (!rebuilt) return;
    run = { ...rebuilt, source: run.source, rate: run.rate };
  }
  while (run.cursor < target) {
    const deadline = performance.now() + TICK_BUDGET_MS;
    while (run.cursor < target && performance.now() < deadline) step(run);
    post({ type: 'seeking', done: run.cursor, total: target });
    await new Promise((r) => setTimeout(r, 0));
  }
  frame(run);
  post({ type: 'stations', rows: stationRows(run) });
}

function post(message, transfer) {
  self.postMessage(message, transfer && transfer.length ? transfer : undefined);
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'load': {
        pause();
        const built = await build(message);
        if (!built) return;
        run = built;
        run.source = message;
        run.rate = message.rate ?? 500;
        post({
          type: 'ready',
          steps: run.steps,
          t0: run.t0,
          stations: run.tracks.length,
          expertNames: run.names,
          horizons: HORIZONS,
          displayHorizon: DISPLAY_HORIZON,
          statsLayout: [
            ...STATS,
            ...HORIZONS.flatMap((h) => PER_HORIZON.map((k) => `station.${h.label}.${k}`)),
            ...HORIZONS.flatMap((h) => PER_HORIZON.map((k) => `fleet.${h.label}.${k}`)),
          ],
          windowSize: WINDOW,
          rollWindow: ROLL,
        });
        frame(run);
        break;
      }
      case 'play': start(); break;
      case 'pause': pause(); break;
      case 'rate': if (run) run.rate = Math.max(1, message.rate); break;
      case 'seek': await seek(message.index); break;
      case 'stop': pause(); run = null; break;
      default: break;
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
