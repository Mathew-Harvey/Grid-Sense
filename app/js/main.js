// Boot, view switching, and the replay lifecycle.
//
// Everything expensive happens in the worker. This file's whole job is to keep
// the main thread free: it takes one message per animation frame, hands the
// typed arrays straight to the charts, and never touches the training loop.
//
// The page has to look competent before any data arrives, so the views mount
// against empty state first and fill in as it loads. A dashboard that shows a
// spinner for four minutes has failed even if it eventually renders.

import { loadAll, cachedManifest, DATA } from './dataload.js';
import { createLiveFeed, describeLive } from './live.js';
import { bootScreen } from './boot-screen.js';
import { initExplain, updateStory } from './explain.js';
import * as aggregateView from './views/aggregate.js';
import * as stationView from './views/station.js';
import * as trainingView from './views/training.js';
import * as learnView from './views/learn.js';
import * as mapView from './views/map.js';

const VIEWS = { aggregate: aggregateView, station: stationView, training: trainingView, learn: learnView, map: mapView };

const state = {
  frame: null,
  stats: {},
  stationRows: [],
  stationDetail: {},
  regions: [],
  fuelMix: null,
  prices: null,
  quality: [],
  nowSec: null,
  steps: 0,
};

const ctx = {
  state,
  expertNames: [],
  horizons: [],
  correlationById: new Map(),
  control,
  // Views call this after any interaction that changes what should be drawn.
  // Renders are otherwise driven by worker messages, and once the replay has
  // finished those stop arriving — without this, a dropdown change after the
  // end of the replay sat undrawn until the page was reloaded.
  requestRender: scheduleRender,
};

let worker = null;
let mounted = {};
let pendingFrame = null;
let rafHandle = 0;

// ---------------------------------------------------------------------------
// Clocks. NEM is UTC+10 and WEM is UTC+8, both fixed: neither market observes
// daylight saving, so these are plain offsets rather than zone lookups.
// ---------------------------------------------------------------------------

function tickClocks() {
  const now = Date.now();
  const at = (offsetHours) => {
    const d = new Date(now + offsetHours * 3600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  document.getElementById('clock-nem').textContent = at(10);
  document.getElementById('clock-wem').textContent = at(8);
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(name) {
  for (const button of document.querySelectorAll('.views button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === name));
  }
  for (const section of document.querySelectorAll('[data-view-panel]')) {
    section.hidden = section.id !== `view-${name}`;
  }
  mounted[name]?.update(state);
  // A chart built while its container was hidden measured zero and sized itself
  // from a fallback. Now that the panel has real dimensions, tell it again.
  requestAnimationFrame(() => mounted[name]?.resize?.());
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function control(kind, extra = {}) {
  worker?.postMessage({ type: kind, ...extra });
}

/** One repaint per animation frame, not one per interval. At 500 intervals a
 *  second the difference is the whole frame budget. */
function scheduleRender() {
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    const selected = document.querySelector('.views button[aria-selected="true"]')?.dataset.view ?? 'aggregate';
    mounted[selected]?.update(state);
    updateStory(state, ctx);
  });
}

function unpackStats(values, layout) {
  const out = {};
  for (let i = 0; i < layout.length; i++) out[layout[i]] = values[i];
  return out;
}

function startWorker(loaded) {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let statsLayout = [];

  worker.onmessage = (event) => {
    const m = event.data;
    switch (m.type) {
      case 'building':
        setStatus(`Preparing ${m.label} (${m.done + 1} of ${m.total})`);
        // The worker's build is the last stretch of the wait and the least
        // visible: the fetching has stopped, so without this the bar would sit
        // finished for several seconds while the page still showed nothing.
        ctx.splash?.progress({
          phase: 'train', label: `Fitting ${m.label}`, done: m.done + 1, total: m.total,
        });
        break;

      case 'ready':
        statsLayout = m.statsLayout;
        ctx.expertNames = m.expertNames;
        ctx.horizons = m.horizons;
        state.steps = m.steps;
        remountViews();
        setStatus(`${m.stations} stations over ${m.steps.toLocaleString()} intervals.`);
        // Reduced motion means the replay does not run itself. Someone who has
        // asked the system not to animate has not asked to be shown a static
        // screen either, so the transport is there and labelled.
        ctx.splash?.done();
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) control('play');
        // Started here, not when the load message was posted. The worker spends
        // the better part of a minute reading the backfill out of IndexedDB,
        // and a poll that lands during that window hands its intervals to a
        // replay that does not exist yet — the client has already marked them
        // fetched, so they are lost rather than retried, and the first minutes
        // of live data go missing every single load.
        startLiveFeed(loaded);
        break;

      case 'frame':
        state.frame = m;
        state.stats = unpackStats(m.stats, statsLayout);
        state.nowSec = m.nowSec;
        scheduleRender();
        break;

      case 'stations':
      case 'handover':
        state.stationRows = m.rows;
        // The map wants output by station id; every other view wants the rows.
        state.stationOutput = new Map(m.rows.map((r) => [r.station_id, r.output_mw]));
        if (m.stats) state.stats = unpackStats(m.stats, statsLayout);
        // The replay catching up with the present is not the end of anything
        // when the live feed is running: the next published interval extends
        // the timeline and the worker restarts itself. The status line says
        // which of the two situations this is.
        if (m.type === 'handover') {
          setStatus(live
            ? describeLive(liveStatus)
            : 'Replay has reached the end of the loaded window.');
        }
        scheduleRender();
        break;

      case 'live':
        // Nothing to render here — the extended timeline arrives as ordinary
        // frames. This only refreshes the sentence describing the feed.
        if (m.added > 0) setStatus(describeLive(liveStatus));
        break;

      case 'empty':
        setStatus(m.message);
        // 'ready' is not the only way out of the worker. Without this the boot
        // screen would sit over a dashboard that had finished loading and was
        // simply empty — a full-viewport overlay with nothing left to report.
        ctx.splash?.done();
        break;

      case 'error':
        setStatus(`Replay stopped: ${m.message}`, true);
        ctx.splash?.fail(`Replay stopped: ${m.message}`);
        break;
    }
  };

  worker.onerror = (e) => {
    setStatus(`Replay worker failed: ${e.message}`, true);
    ctx.splash?.fail(`Replay worker failed: ${e.message}`);
  };

  worker.postMessage({
    type: 'load',
    stations: loaded.stations.map((s) => ({
      station_id: s.station_id, station_name: s.station_name, region: s.region,
      fueltech: s.fueltech, capacity_mw: s.capacity_mw, lat: s.lat, lon: s.lon,
      curve: loaded.curves?.get?.(s.station_id) ?? null,
    })),
    // The worker keys IndexedDB by epoch, not by label, so it needs the whole
    // day record. Sending only the ISO string leaves it doing
    // new Date(undefined) and throwing "Invalid time value" from deep inside
    // the store, where the cause is nowhere near the symptom.
    days: loaded.days.map((d) => ({ iso: d.iso, ms: d.ms })),
    // Days ahead of the dispatch window carry forward weather and no dispatch.
    // The worker reads both from these lists; a day with no stored dispatch
    // contributes nothing to the timeline, which is what a future day should do
    // until live intervals arrive to fill it.
    weatherAhead: (loaded.forecastDays ?? []).map((d) => ({ iso: d.iso, ms: d.ms })),
    rate: 500,
  });
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------

let live = null;
let liveStatus = null;

/**
 * Watch the harvester's live manifest and forward new intervals to the worker.
 *
 * Started as soon as the replay is loaded rather than when it finishes. The
 * replay takes minutes to walk its window; intervals published during that walk
 * would otherwise be missed, and the feed would appear to start with a gap it
 * never explains.
 */
function startLiveFeed(loaded) {
  live?.stop();
  liveStatus = null;

  // Anything the backfill already holds is better than a live copy of it — the
  // backfill carries availability and the curtailment cap, a live interval
  // carries neither. So the feed only offers what falls after the loaded
  // window, and the worker refuses duplicates on top of that.
  const lastDay = loaded.days?.at(-1);
  const since = lastDay ? lastDay.ms + 86_400_000 - 1 : 0;

  live = createLiveFeed({
    base: DATA,
    since,
    onIntervals: ({ observations }) => {
      if (observations.length) worker?.postMessage({ type: 'live', observations });
    },
    onStatus: (status) => {
      liveStatus = status;
      // Only speak up when the feed has something to say the replay does not
      // already cover: while the replay is still walking history, its own
      // progress line is the more useful thing on screen.
      if (!status.ok || status.added > 0) setStatus(describeLive(status), !status.ok);
    },
  });
}

// ---------------------------------------------------------------------------
// Status and data quality
// ---------------------------------------------------------------------------

function setStatus(text, warn = false) {
  const note = document.getElementById('replay-note');
  if (note) note.textContent = text;
  const q = document.getElementById('quality-note');
  if (q) { q.textContent = text; q.classList.toggle('warn', warn); }
}

function qualityStrip(loaded) {
  const days = loaded.days?.length ?? 0;
  const stations = loaded.stations?.length ?? 0;
  const priced = loaded.prices ? Object.keys(loaded.prices).length : 0;
  return [
    { label: 'Days loaded', value: String(days) },
    { label: 'Stations modelled', value: String(stations) },
    { label: 'Price days', value: priced ? String(priced) : 'none', warn: priced === 0 },
    // Curtailment is only published next day, so a live interval's mask is
    // genuinely unknown rather than false. Saying so is the difference between
    // a caveat and a silent assumption.
    { label: 'Curtailment mask', value: 'next-day' },
    { label: 'Load time', value: `${((loaded.elapsedMs ?? 0) / 1000).toFixed(1)} s` },
  ].concat((loaded.notes ?? []).map((n) => ({
    // Notes arrive as either a string or a structured record. Interpolating an
    // object into a template renders "[object Object]", which tells the reader
    // there is a problem and nothing whatsoever about what it is.
    label: typeof n === 'object' && n?.label ? n.label : 'Note',
    value: typeof n === 'string' ? n : (n?.message ?? n?.detail ?? JSON.stringify(n)),
    warn: true,
  })));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function remountViews() {
  for (const v of Object.values(mounted)) v?.destroy?.();
  mounted = {
    aggregate: aggregateView.mount(document.getElementById('view-aggregate'), ctx),
    station: stationView.mount(document.getElementById('view-station'), ctx),
    training: trainingView.mount(document.getElementById('view-training'), ctx),
    learn: learnView.mount(document.getElementById('view-learn'), ctx),
    map: mapView.mount(document.getElementById('view-map'), ctx),
  };
  const selected = document.querySelector('.views button[aria-selected="true"]')?.dataset.view ?? 'aggregate';
  showView(selected);
}

async function boot() {
  tickClocks();
  setInterval(tickClocks, 30_000);

  for (const button of document.querySelectorAll('.views button')) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }

  initExplain();
  remountViews();

  // Named for what it is rather than `boot`, which is the function this runs in.
  const splash = bootScreen();

  const cached = await cachedManifest().catch(() => null);
  setStatus(cached
    ? `Reusing ${cached.stationCount} stations cached from a previous session.`
    : 'First run: fetching the backfill. This takes a couple of minutes.');
  if (cached) {
    splash.progress({ label: `Reusing ${cached.stationCount} stations held from a previous visit` });
  }

  let loaded;
  try {
    loaded = await loadAll({
      onProgress: (p) => {
        setStatus(p.total > 1 ? `${p.label} — ${p.done} of ${p.total}` : p.label);
        splash.progress(p);
      },
    });
  } catch (err) {
    const message = `Could not load data: ${err.message}. Is the harvester running on port 8080?`;
    setStatus(message, true);
    splash.fail(message);
    return;
  }

  ctx.correlationById = loaded.correlationById ?? new Map();
  // Regional demand and interconnector flow, indexed by interval so the map can
  // ask for the instant the replay is showing rather than tracking its own clock.
  if (loaded.flows?.size) {
    ctx.flowsAt = (ms) => loaded.flows.get(Math.round(ms / 300_000) * 300_000) ?? null;
  }
  ctx.days = loaded.days ?? [];
  state.quality = qualityStrip(loaded);
  state.prices = loaded.prices ?? null;

  // One price line for a whole-of-market chart, and the honest one is the plain
  // mean across regions rather than a generation-weighted figure: weighting
  // needs per-region generation on the same clock, and inventing that weighting
  // would put a number on the axis that looks derived and is guessed. The panel
  // says which it is.
  if (loaded.prices?.byRegion?.size) {
    const acc = new Map();
    for (const { t, rrp } of loaded.prices.byRegion.values()) {
      for (let i = 0; i < t.length; i++) {
        const key = t[i];
        const cell = acc.get(key);
        if (cell) { cell.sum += rrp[i]; cell.n++; } else acc.set(key, { sum: rrp[i], n: 1 });
      }
    }
    state.priceByMs = new Map([...acc].map(([k, v]) => [k, v.sum / v.n]));
    state.priceRegions = loaded.prices.byRegion.size;
  }
  scheduleRender();

  ctx.splash = splash;
  startWorker(loaded);
}

boot();
