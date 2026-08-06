// Generation by fuel, stacked over time.
//
// Ordered baseload upward, which is how the grid actually dispatches: coal sits
// on the bottom because it is there whatever happens, and the peaking plant sits
// on top because it is the part that moves. Sorting by magnitude instead would
// reshuffle the stack every time the wind picked up and destroy the one thing a
// stacked area is good at, which is showing you the shape of the day.

import { uPlot, COLOURS, fueltechColour, FUELTECH_DASH, FUELTECH_CODE, baseOpts, nowRulePlugin, autoResize } from './base.js';

// Bottom of the stack first. Anything not listed is appended in registry order
// rather than dropped, so a new fueltech shows up rather than silently vanishing
// from a total that still looks plausible.
export const STACK_ORDER = [
  'coal_black', 'coal_brown', 'gas_ccgt', 'gas_steam', 'bioenergy',
  'hydro', 'wind', 'solar_utility', 'gas_recip', 'gas_ocgt', 'distillate',
  'battery_discharging', 'pumps', 'battery_charging',
];

/** Fueltechs present in the data, in dispatch order. */
export function orderFueltechs(present) {
  const known = STACK_ORDER.filter((ft) => present.includes(ft));
  const unknown = present.filter((ft) => !STACK_ORDER.includes(ft));
  return [...known, ...unknown];
}

/**
 * Running totals for a stacked area.
 *
 * uPlot fills each series against the one below it, so the values handed over
 * have to be cumulative rather than individual. Doing it here rather than in the
 * caller keeps the "what did this fuel contribute" reading intact everywhere
 * else.
 */
export function stackSeries(seriesByFueltech, order) {
  const out = [];
  let running = null;
  for (const ft of order) {
    const v = seriesByFueltech[ft];
    if (!v) continue;
    running = running ? running.map((x, i) => x + (v[i] || 0)) : Array.from(v, (x) => x || 0);
    out.push({ fueltech: ft, cumulative: running.slice() });
  }
  return out;
}

export function createFuelMix(el) {
  const { width, height } = el.getBoundingClientRect();
  let plot = null;
  let stop = null;

  // The set of fuels running changes as the replay crosses a day boundary, and
  // uPlot fixes its series at construction, so the chart is rebuilt when the
  // shape changes rather than when the numbers do.
  function build(order) {
    if (plot) { stop(); plot.destroy(); }
    const base = baseOpts({ width: Math.max(el.clientWidth, 320), height: Math.max(el.clientHeight, 160) });
    plot = new uPlot({
      ...base,
      series: [
        {},
        ...order.map((ft) => ({
          label: FUELTECH_CODE[ft] ?? ft,
          stroke: fueltechColour(ft),
          // A hairline keeps thin contributions visible; without it a 20 MW band
          // inside a 30 GW stack disappears entirely.
          width: 0.5,
          fill: fueltechColour(ft),
          dash: FUELTECH_DASH[ft]?.length ? FUELTECH_DASH[ft] : undefined,
        })),
      ],
      bands: order.map((_, i) => ({ series: [i + 1, i] })).filter((b) => b.series[1] > 0),
      axes: [
        base.axes[0],
        {
          ...base.axes[1],
          values: (u, splits) => splits.map((v) => (v >= 1000 ? `${(v / 1000).toFixed(0)} GW` : `${v.toFixed(0)}`)),
        },
      ],
      scales: { y: { range: (u, min, max) => [0, max * 1.05] } },
    }, [[], ...order.map(() => [])], el);
    stop = autoResize(plot, el);
    return order;
  }

  let current = [];

  return {
    get plot() { return plot; },
    /** @param {number[]} t seconds @param {Object<string, number[]>} byFueltech */
    update(t, byFueltech) {
      const order = orderFueltechs(Object.keys(byFueltech));
      if (order.join() !== current.join()) current = build(order);
      const stacked = stackSeries(byFueltech, current);
      plot.setData([t, ...stacked.map((s) => s.cumulative)]);
    },
    /** Legend entries carrying the redundant code, so the chart survives being
     *  read without colour. */
    legend() {
      return current.map((ft) => ({ fueltech: ft, code: FUELTECH_CODE[ft] ?? ft, colour: fueltechColour(ft) }));
    },
    destroy() { if (plot) { stop(); plot.destroy(); } },
  };
}
