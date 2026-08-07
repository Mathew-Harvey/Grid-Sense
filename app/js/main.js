// Boot, view switching, and the replay lifecycle.
//
// Everything expensive happens in the worker. This file's whole job is to keep
// the main thread free: it takes one message per animation frame, hands the
// typed arrays straight to the charts, and never touches the training loop.
//
// The page has to look competent before any data arrives, so the views mount
// against empty state first and fill in as it loads. A dashboard that shows a
// spinner for four minutes has failed even if it eventually renders.

import { loadAll, cachedManifest } from './dataload.js';
import * as aggregateView from './views/aggregate.js';
import * as stationView from './views/station.js';
import * as trainingView from './views/training.js';

const VIEWS = { aggregate: aggregateView, station: stationView, training: trainingView };

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
  onStationChange: null,
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
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) control('play');
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
        if (m.stats) state.stats = unpackStats(m.stats, statsLayout);
        if (m.type === 'handover') setStatus('Replay has reached the present. Switching to live updates.');
        scheduleRender();
        break;

      case 'empty':
        setStatus(m.message);
        break;

      case 'error':
        setStatus(`Replay stopped: ${m.message}`, true);
        break;
    }
  };

  worker.onerror = (e) => setStatus(`Replay worker failed: ${e.message}`, true);

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
    rate: 500,
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

  remountViews();

  const cached = await cachedManifest().catch(() => null);
  setStatus(cached
    ? `Reusing ${cached.stationCount} stations cached from a previous session.`
    : 'First run: fetching the backfill. This takes a couple of minutes.');

  let loaded;
  try {
    loaded = await loadAll({
      onProgress: ({ label, done, total }) =>
        setStatus(total > 1 ? `${label} — ${done} of ${total}` : label),
    });
  } catch (err) {
    setStatus(`Could not load data: ${err.message}. Is the harvester running on port 8080?`, true);
    return;
  }

  ctx.correlationById = loaded.correlationById ?? new Map();
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

  startWorker(loaded);
}

boot();
