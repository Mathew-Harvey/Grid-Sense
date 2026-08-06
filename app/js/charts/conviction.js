// The conviction band.
//
// This is the one chart the page is built around. The forecast line matters
// less than the width of the band around it: that width is the model's live
// uncertainty, calibrated against its own recent errors, and watching it
// contract as the model learns is the whole argument the dashboard is making.
//
// Two bands are drawn. The solid one is calibrated directly on the aggregate
// residual. The faint one behind it is what you get by summing the station
// intervals in quadrature as though their errors were independent. They are not
// independent — neighbouring wind farms are all wrong about the same weather
// front at the same moment — so the naive band is visibly too narrow, and the
// gap between the two is the clearest statement of why that matters.

import { uPlot, COLOURS, baseOpts, nowRulePlugin, autoResize } from './base.js';

const SERIES = {
  ACTUAL: 1,
  FORECAST: 2,
  HI90: 3,
  LO90: 4,
  HI80: 5,
  LO80: 6,
  GHOST_HI: 7,
  GHOST_LO: 8,
};

export function createConvictionBand(el, { getNowSec, showGhost = true } = {}) {
  const { width, height } = el.getBoundingClientRect();

  const bandFill = (u, from, to, colour) => colour;

  const opts = {
    ...baseOpts({ width: Math.max(width, 320), height: Math.max(height, 200) }),
    series: [
      {},
      {
        label: 'Actual',
        stroke: COLOURS.text,
        width: 1.6,
        // Gaps are drawn as gaps. Joining across a missing interval invents data
        // exactly where the reader most needs to see there is none.
        spanGaps: false,
      },
      {
        label: 'Forecast',
        stroke: COLOURS.predicted,
        width: 1.4,
        dash: [5, 3],
        spanGaps: false,
      },
      { label: 'hi90', stroke: 'transparent', width: 0 },
      { label: 'lo90', stroke: 'transparent', width: 0 },
      { label: 'hi80', stroke: 'transparent', width: 0 },
      { label: 'lo80', stroke: 'transparent', width: 0 },
      { label: 'ghostHi', stroke: 'transparent', width: 0, show: showGhost },
      { label: 'ghostLo', stroke: 'transparent', width: 0, show: showGhost },
    ],
    bands: [
      // Drawn widest first so the 80% band reads as a denser core inside the
      // 90%, rather than the two competing.
      ...(showGhost
        ? [{ series: [SERIES.GHOST_HI, SERIES.GHOST_LO], fill: COLOURS.bandGhost }]
        : []),
      { series: [SERIES.HI90, SERIES.LO90], fill: COLOURS.band },
      { series: [SERIES.HI80, SERIES.LO80], fill: COLOURS.band },
    ],
    scales: {
      // Power cannot be negative in aggregate, and anchoring the axis at zero
      // stops a band that is merely narrow from looking like a band that is
      // wide, purely because the axis rescaled under it.
      y: { range: (u, min, max) => [0, max * 1.05] },
    },
    plugins: [nowRulePlugin(getNowSec)],
    axes: [
      ...baseOpts({ width, height }).axes.slice(0, 1),
      {
        ...baseOpts({ width, height }).axes[1],
        values: (u, splits) => splits.map((v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} GW` : `${v.toFixed(0)}`)),
      },
    ],
  };

  const empty = [[], [], [], [], [], [], [], [], []];
  const plot = new uPlot(opts, empty, el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /**
     * @param {object} d
     * @param {Float64Array|number[]} d.t        seconds since epoch
     * @param {number[]} d.actual
     * @param {number[]} d.forecast
     * @param {number[]} d.hi90 @param {number[]} d.lo90
     * @param {number[]} d.hi80 @param {number[]} d.lo80
     * @param {number[]} [d.ghostHi] @param {number[]} [d.ghostLo]
     */
    update(d) {
      plot.setData([
        d.t, d.actual, d.forecast,
        d.hi90, d.lo90, d.hi80, d.lo80,
        d.ghostHi ?? d.hi90, d.ghostLo ?? d.lo90,
      ]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}

/**
 * The expert-weight ribbon, drawn directly beneath the band on the same time
 * axis so the two read together: you can see the moment the physical model
 * takes over from persistence as the horizon extends, or the analogue expert
 * winning as a front arrives.
 *
 * Drawn as a stacked area to 100% — the question is always which expert is
 * carrying the forecast, never the absolute weight.
 */
export function createExpertRibbon(el, expertNames, { getNowSec } = {}) {
  const { width, height } = el.getBoundingClientRect();

  // Experts are ordered from "assumes nothing changes" to "carries the physics",
  // so the ribbon reads bottom-to-top as increasing model commitment.
  const RAMP = ['#3d4a52', '#4f6570', '#61818c', '#7ba0a6', '#9dbfb8', '#c6dcc9'];
  const colourFor = (i) => RAMP[i % RAMP.length];

  const opts = {
    ...baseOpts({ width: Math.max(width, 320), height: Math.max(height, 60) }),
    series: [
      {},
      ...expertNames.map((name, i) => ({
        label: name,
        stroke: 'transparent',
        width: 0,
        fill: colourFor(i),
      })),
    ],
    // Stacking is done by accumulating the series before they are handed over,
    // then filling each against the one below it.
    bands: expertNames.map((_, i) => ({
      series: [i + 1, i === 0 ? -1 : i],
      fill: colourFor(i),
    })).filter((b) => b.series[1] !== -1),
    scales: { y: { range: [0, 1] } },
    axes: [
      { ...baseOpts({ width, height }).axes[0], show: false },
      { ...baseOpts({ width, height }).axes[1], show: false },
    ],
    plugins: [nowRulePlugin(getNowSec)],
  };

  const plot = new uPlot(opts, [[], ...expertNames.map(() => [])], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /** @param {number[]} t @param {number[][]} weights one array per expert, each summing to 1 across experts */
    update(t, weights) {
      const stacked = [];
      let running = null;
      for (const w of weights) {
        running = running ? running.map((v, i) => v + w[i]) : w.slice();
        stacked.push(running.slice());
      }
      plot.setData([t, ...stacked]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}
