// One station in full: what it produced, what it could have produced, what the
// market let it produce, and how well the physics explains any of it.
//
// The curtailment shading is the point of this view. A wind farm whose output
// stops tracking the wind is either curtailed, in outage, or the pipeline is
// broken, and those three look identical on an output trace alone.

import { fueltechColour, FUELTECH_CODE } from '../charts/base.js';

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

export function mount(root, ctx) {
  const el = (id) => root.querySelector(`#${id}`);
  const select = el('station-select');
  const optional = {};

  const lazy = async (key, path, factory, hostId, label) => {
    try {
      optional[key] = factory(await import(path));
    } catch (err) {
      optional[key] = null;
      const host = el(hostId);
      if (host) host.innerHTML = `<p class="state-msg"><strong>${label} unavailable</strong>${err.message}</p>`;
    }
  };

  lazy('curve', '../charts/powercurve.js', (m) => m.createPowerCurve(el('power-curve')), 'power-curve', 'Power curve');
  lazy('lag', '../charts/lagheatmap.js', (m) => m.createLagHeatmap(el('lag-heatmap')), 'lag-heatmap', 'Lag heatmap');
  lazy('pit', '../charts/calibration.js', (m) => ({
    hist: m.createPitHistogram(el('pit-histogram')),
    rel: m.createReliabilityDiagram(el('reliability')),
    reliabilityFromPit: m.reliabilityFromPit,
  }), 'pit-histogram', 'Calibration');

  let selected = null;

  select.addEventListener('change', () => {
    selected = select.value;
    ctx.onStationChange?.(selected);
  });

  function fillOptions(stations) {
    if (select.options.length === stations.length) return;
    select.innerHTML = stations.map((s) =>
      `<option value="${s.station_id}">${s.station_name} · ${FUELTECH_CODE[s.fueltech] ?? s.fueltech} · ${Math.round(s.capacity_mw)} MW</option>`).join('');
    selected = select.value;
  }

  return {
    update(state) {
      const stations = state.stationRows ?? [];
      if (stations.length) fillOptions(stations);
      const row = stations.find((s) => s.station_id === selected) ?? stations[0];
      if (!row) return;

      const detail = state.stationDetail?.[row.station_id];
      const corr = ctx.correlationById?.get(row.station_id);

      el('station-meta').textContent =
        `${row.region} · ${FUELTECH_CODE[row.fueltech] ?? row.fueltech} · ${Math.round(row.capacity_mw)} MW` +
        (corr ? ` · ${pct(corr.masked_fraction)} of intervals masked` : '');

      // A station with no admissible data after masking is a real finding, not
      // an empty chart. Saying "curtailed whenever it produces" is the honest
      // reading; a wall of 0.000 correlations is not.
      if (corr?.target_constant) {
        el('curve-note').textContent = 'Curtailed in every interval it produces — no uncontaminated data to fit.';
      } else if (corr?.curve?.converged) {
        el('curve-note').textContent = `RMSE ${fmt(corr.curve.rmse)} MW`;
        optional.curve?.update({
          x: detail?.curveX ?? [], y: detail?.curveY ?? [], masked: detail?.curveMasked ?? [],
          curve: corr.curve, capacityMw: row.capacity_mw,
        });
      } else {
        el('curve-note').textContent = 'Curve fit did not converge.';
      }

      if (corr?.variables) optional.lag?.update(corr.variables);

      if (state.frame?.pit) {
        const counts = Array.from(state.frame.pit);
        optional.pit?.hist.update(counts);
        // The reliability diagram derives coverage from individual PIT values,
        // and the worker only ships the histogram — a hundred thousand raw
        // values per frame is exactly the payload the frame budget cannot
        // afford. Expanding each bin back to its midpoint reconstructs the
        // distribution at bin resolution, which is all the diagram plots anyway.
        const values = [];
        for (let b = 0; b < counts.length; b++) {
          const mid = (b + 0.5) / counts.length;
          for (let k = 0; k < counts[b]; k++) values.push(mid);
        }
        if (values.length && optional.pit?.reliabilityFromPit) {
          optional.pit.rel.update(optional.pit.reliabilityFromPit(values));
        }
      }

      const analogue = detail?.analogue;
      el('analogue-panel').innerHTML = analogue
        ? `<strong>Closest analogue</strong>Current conditions most resemble ${analogue.when}, when this station went on to produce ${fmt(analogue.outcomeMw)} MW.`
        : '<strong>No analogue yet</strong>The analogue expert needs a few days of history before it can match today against it.';
    },
    resize() {
      // A chart built while its panel was hidden measured zero and sized itself
      // from a fallback. Re-measuring is cheap and idempotent; tracking which
      // ones were hidden at construction is not.
      for (const entry of Object.values(optional)) {
        if (!entry) continue;
        const charts = entry.plot ? [entry] : Object.values(entry).filter((c) => c && c.plot);
        for (const c of charts) {
          const box = c?.plot?.root?.parentElement?.getBoundingClientRect?.();
          if (box && box.width > 0 && box.height > 0) {
            c.plot.setSize({ width: box.width, height: box.height });
          }
        }
      }
    },
    destroy() {
      optional.curve?.destroy();
      optional.lag?.destroy();
      optional.pit?.hist.destroy();
      optional.pit?.rel.destroy();
    },
  };
}
