// One station in full: what it produced, what it could have produced, what the
// market let it produce, and how well the physics explains any of it.
//
// The curtailment shading is the point of this view. A wind farm whose output
// stops tracking the wind is either curtailed, in outage, or the pipeline is
// broken, and those three look identical on an output trace alone.

import { uPlot, COLOURS, fueltechColour, FUELTECH_CODE, baseOpts, autoResize } from '../charts/base.js';
import { getStationDay, unpackDay } from '../store.js';

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/**
 * The station history chart: actual against UIGF against dispatch target, with
 * curtailed spans shaded behind them.
 *
 * Drawn from IndexedDB rather than the replay frame. The history is settled
 * fact that does not change as the replay runs, so it is read once per station
 * selection instead of being shipped across the worker boundary sixty times a
 * second for no reason.
 */
function createStationSeries(el) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 320), height: Math.max(height, 200) });

  // Spans where the semi-dispatch cap bound, painted behind the series. An
  // extra line series would compete with the data; a tinted background reads as
  // "the market was in charge here" without claiming to be a measurement.
  const capped = { spans: [] };
  const cappedPlugin = {
    hooks: {
      draw: (u) => {
        if (!capped.spans.length) return;
        const { ctx } = u;
        ctx.save();
        ctx.fillStyle = COLOURS.curtailed;
        ctx.globalAlpha = 0.12;
        for (const [a, b] of capped.spans) {
          const x0 = u.valToPos(a, 'x', true);
          const x1 = u.valToPos(b, 'x', true);
          ctx.fillRect(x0, u.bbox.top, Math.max(x1 - x0, 1), u.bbox.height);
        }
        ctx.restore();
      },
    },
  };

  const plot = new uPlot({
    ...base,
    series: [
      {},
      { label: 'actual', stroke: COLOURS.text, width: 1.6, spanGaps: false },
      { label: 'could have (UIGF)', stroke: COLOURS.dim, width: 1.1, dash: [5, 3], spanGaps: false },
      { label: 'dispatch target', stroke: COLOURS.predicted, width: 0.9, spanGaps: false },
    ],
    scales: { y: { range: (u, min, max) => [0, Math.max(max, 1) * 1.05] } },
    axes: [
      {
        ...base.axes[0],
        // Three weeks on one axis puts every default tick at the same time of
        // day, so a time-only label prints "10:00" twenty-one times in a row.
        // Once the visible span crosses two days the date is the information.
        values: (u, splits) => {
          const spanDays = (u.scales.x.max - u.scales.x.min) / 86_400;
          return splits.map((sec) => {
            const d = new Date(sec * 1000 + 10 * 3600_000);
            if (spanDays <= 2) {
              return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
            }
            const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
            return `${d.getUTCDate()} ${mon}`;
          });
        },
      },
      { ...base.axes[1], values: (u, splits) => splits.map((v) => `${v.toFixed(0)}`) },
    ],
    plugins: [cappedPlugin],
  }, [[], [], [], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    setColour(ft) { plot.series[1].stroke = () => fueltechColour(ft); },
    update({ t, actual, uigf, cleared, cappedSpans }) {
      capped.spans = cappedSpans;
      plot.setData([t, actual, uigf, cleared]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}

/** History for one station, unpacked and shaped for the chart. */
async function loadHistory(stationId, days) {
  const t = [];
  const actual = [];
  const uigf = [];
  const cleared = [];
  const spans = [];
  let spanStart = null;

  for (const day of days) {
    const packed = await getStationDay(stationId, day.ms).catch(() => null);
    if (!packed) continue;
    for (const o of unpackDay(packed)) {
      const sec = o.observed_at / 1000;
      t.push(sec);
      actual.push(Number.isFinite(o.output_mw) ? o.output_mw : null);
      uigf.push(Number.isFinite(o.uigf_mw) ? o.uigf_mw : null);
      cleared.push(Number.isFinite(o.cleared_mw) ? o.cleared_mw : null);
      if (o.capped) {
        if (spanStart === null) spanStart = sec;
      } else if (spanStart !== null) {
        spans.push([spanStart, sec]);
        spanStart = null;
      }
    }
  }
  if (spanStart !== null && t.length) spans.push([spanStart, t[t.length - 1]]);
  return { t, actual, uigf, cleared, cappedSpans: spans };
}

export function mount(root, ctx) {
  const el = (id) => root.querySelector(`#${id}`);
  const select = el('station-select');
  const optional = {};

  const series = createStationSeries(el('station-series'));

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
  let drawnStation = null;   // history is static, so draw it once per selection
  let loadToken = 0;

  async function drawHistory(row) {
    if (drawnStation === row.station_id || !ctx.days?.length) return;
    drawnStation = row.station_id;
    const token = ++loadToken;
    const history = await loadHistory(row.station_id, ctx.days);
    // The user may have changed station while IndexedDB was reading; drawing a
    // stale result would put one station's output under another's name.
    if (token !== loadToken) return;
    series.setColour(row.fueltech);
    series.update(history);
  }

  select.addEventListener('change', () => {
    selected = select.value;
    ctx.onStationChange?.(selected);
  });

  function fillOptions(stations) {
    if (select.options.length === stations.length) return;
    select.innerHTML = stations.map((s) =>
      `<option value="${s.station_id}">${s.station_name} · ${FUELTECH_CODE[s.fueltech] ?? s.fueltech} · ${Math.round(s.capacity_mw)} MW</option>`).join('');
    // Default to the largest wind farm rather than the largest station
    // outright: the biggest stations are coal, and coal is the one fuel this
    // system says up front it cannot predict from weather.
    const wind = stations.find((s) => s.fueltech === 'wind');
    selected = wind?.station_id ?? select.value;
    select.value = selected;
  }

  return {
    update(state) {
      const stations = state.stationRows ?? [];
      if (stations.length) fillOptions(stations);
      const row = stations.find((s) => s.station_id === selected) ?? stations[0];
      if (!row) return;

      drawHistory(row);

      const corr = ctx.correlationById?.get(row.station_id);

      el('station-meta').textContent =
        `${row.region} · ${FUELTECH_CODE[row.fueltech] ?? row.fueltech} · ${Math.round(row.capacity_mw)} MW` +
        (corr ? ` · ${pct(corr.masked_fraction)} of intervals masked` : '');

      // The power-curve panel only claims what the fit can honestly claim. A
      // coal station drawn against a wind-speed axis is not an empty chart, it
      // is a wrong one — the negative temperature correlation on thermal plant
      // is winter demand, not weather driving generation.
      const curveHost = el('power-curve');
      const isWind = row.fueltech === 'wind';
      const isSolar = row.fueltech === 'solar_utility';
      if (corr?.target_constant) {
        el('curve-note').textContent = '';
        curveHost.innerHTML = '<p class="state-msg"><strong>No admissible data</strong>' +
          'This station is curtailed in every interval it produces, so masking leaves nothing to fit.</p>';
      } else if (isWind && corr?.curve?.converged && optional.curve) {
        el('curve-note').textContent = `fitted on masked history · RMSE ${fmt(corr.curve.rmse)} MW`;
        optional.curve.update({ x: [], y: [], masked: [], curve: corr.curve, capacityMw: row.capacity_mw });
      } else if (isSolar && corr?.curve?.converged) {
        el('curve-note').textContent = '';
        curveHost.innerHTML = '<p class="state-msg"><strong>Solar fit</strong>' +
          `Output tracks the clear-sky index with gain ${fmt(corr.curve.gain, 2)} and a temperature ` +
          `coefficient of ${fmt(corr.curve.tempCoeff, 3)} per °C, RMSE ${fmt(corr.curve.rmse)} MW. ` +
          'The relationship is two-dimensional (index and irradiance together), so it is reported rather than drawn.</p>';
      } else if (!isWind && !isSolar) {
        el('curve-note').textContent = '';
        curveHost.innerHTML = '<p class="state-msg"><strong>Not weather-driven</strong>' +
          'Weather does not set this station’s output, so no power curve is fitted. ' +
          'Any correlation with temperature here is demand moving dispatch, not weather moving the plant.</p>';
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

      const analogue = state.stationDetail?.[row.station_id]?.analogue;
      el('analogue-panel').innerHTML = analogue
        ? `<strong>Closest analogue</strong>Current conditions most resemble ${analogue.when}, when this station went on to produce ${fmt(analogue.outcomeMw)} MW.`
        : '<strong>No analogue yet</strong>The analogue expert matches live conditions against history; its picks surface here once the replay hands over to live data.';
    },
    resize() {
      // A chart built while its panel was hidden measured zero and sized itself
      // from a fallback. Re-measuring is cheap and idempotent; tracking which
      // ones were hidden at construction is not.
      for (const entry of [series, ...Object.values(optional)]) {
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
      series.destroy();
      optional.curve?.destroy();
      optional.lag?.destroy();
      optional.pit?.hist.destroy();
      optional.pit?.rel.destroy();
    },
  };
}
