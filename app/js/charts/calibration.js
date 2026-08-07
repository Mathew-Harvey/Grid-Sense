// Is the stated uncertainty the realised uncertainty?
//
// Two views of the same question. The PIT histogram asks where outcomes fell
// inside the predictive distribution: flat means the band is honest, a U means
// outcomes keep landing in the tails the forecast said were unlikely, a central
// hump means the band is wider than it needs to be. The reliability diagram asks
// the same thing one level up — of everything issued as a 90% interval, did 90%
// of it contain the outcome.
//
// The shape is read off the counts rather than left to the reader, because
// "U-shaped" and "humped" are the two shapes people reliably confuse, and a
// histogram with a caption that says which one it is cannot be misread. The
// caption is computed every update: a hardcoded one is a lie the moment the
// model improves, and this model is being retrained in front of the reader.

import { uPlot, COLOURS, baseOpts, autoResize } from './base.js';
import { pitHistogram } from '../models/score.js';

// Below this every histogram wobbles, and calling a 5% bump "overconfident"
// trains the reader to ignore the caption.
const FLAT_TOLERANCE = 0.15;

/**
 * PIT counts as bars: bin centres against relative frequency, scaled so that a
 * perfectly calibrated forecast sits at exactly 1.
 *
 * Scaled that way because the reference line is then the same height whatever
 * the bin count and however many intervals have been scored, so the chart does
 * not change shape as the replay runs.
 *
 * @param {number[]} counts
 * @returns {{x: number[], y: number[], total: number}}
 */
export function pitBars(counts) {
  const bins = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const x = [];
  const y = [];
  for (let i = 0; i < bins; i++) {
    x.push((i + 0.5) / bins);
    y.push(total === 0 ? 0 : (counts[i] / total) * bins);
  }
  return { x, y, total };
}

/**
 * Which of the four shapes a PIT histogram has, and what that means.
 *
 * Slope is tested before curvature. A forecast that is simply biased high puts
 * most of its mass in the low bins, which lifts one tail and can read as half a
 * U; calling that overconfident would send the reader to widen a band when the
 * fault is in the centre of it.
 *
 * @param {number[]} counts
 * @returns {{shape: string, caption: string}}
 */
export function classifyPitShape(counts) {
  const bins = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { shape: 'empty', caption: 'No scored intervals yet.' };
  }

  const share = counts.map((c) => c / total);
  const expected = 1 / bins;
  const edge = Math.max(1, Math.round(bins * 0.2));

  let tails = 0;
  for (let i = 0; i < edge; i++) tails += share[i] + share[bins - 1 - i];
  const tailExcess = tails / (2 * edge * expected) - 1;

  const midFrom = Math.floor((bins - edge) / 2);
  let centre = 0;
  for (let i = midFrom; i < midFrom + edge; i++) centre += share[i];
  const centreExcess = centre / (edge * expected) - 1;

  // Mass either side of the middle, as a fraction of the whole: +1 would be
  // every outcome in the top bin, -1 every outcome in the bottom one.
  let slope = 0;
  const mid = (bins - 1) / 2;
  let arm = 0;
  for (let i = 0; i < bins; i++) {
    slope += share[i] * (i - mid);
    arm += expected * Math.abs(i - mid);
  }
  slope /= arm;

  const curvature = Math.max(Math.abs(tailExcess), Math.abs(centreExcess));
  if (Math.max(curvature, Math.abs(slope)) < FLAT_TOLERANCE) {
    return {
      shape: 'calibrated',
      caption: 'Flat — the stated uncertainty matches the realised uncertainty.',
    };
  }
  if (Math.abs(slope) > curvature) {
    return slope > 0
      ? { shape: 'biased-low', caption: 'Sloped — outcomes sit above the middle of the band, so the forecast runs low.' }
      : { shape: 'biased-high', caption: 'Sloped — outcomes sit below the middle of the band, so the forecast runs high.' };
  }
  if (tailExcess > centreExcess) {
    return {
      shape: 'overconfident',
      caption: 'U-shaped — outcomes keep landing in the tails, so the bands are too narrow.',
    };
  }
  return {
    shape: 'underconfident',
    caption: 'Central hump — outcomes cluster mid-band, so the bands are wider than they need to be.',
  };
}

/**
 * Empirical coverage of the central intervals a set of PIT values implies.
 *
 * Taken from the PIT rather than from the issued bands because it then covers
 * every level at once, including ones the model never issued a band for.
 *
 * @param {ArrayLike<number>} pitValues
 * @param {number[]} [levels] nominal central coverages in (0,1)
 * @returns {{nominal: number[], empirical: number[]}}
 */
export function reliabilityFromPit(pitValues, levels = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const empirical = levels.map((c) => {
    const lo = (1 - c) / 2;
    const hi = (1 + c) / 2;
    let inside = 0;
    for (let i = 0; i < pitValues.length; i++) {
      if (pitValues[i] >= lo && pitValues[i] <= hi) inside++;
    }
    return pitValues.length === 0 ? 0 : inside / pitValues.length;
  });
  return { nominal: levels.slice(), empirical };
}

function captionPlugin(read) {
  return {
    hooks: {
      draw: (u) => {
        const text = read();
        if (!text) return;
        const { ctx } = u;
        ctx.save();
        ctx.font = '11px "Barlow Semi Condensed", sans-serif';
        ctx.fillStyle = COLOURS.dim;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        // Inside the plot, top-left, where a PIT histogram is reliably empty —
        // its mass gathers at the bars. Below the axis the caption lands on the
        // tick labels and both become unreadable at phone widths.
        ctx.fillText(text, u.bbox.left + 4, u.bbox.top + 6);
        ctx.restore();
      },
    },
  };
}

/**
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {number} [opts.bins]
 * @returns {{plot: object, update: (pitValues: ArrayLike<number>) => object, destroy: () => void}}
 */
export function createPitHistogram(el, { bins = 10 } = {}) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 300), height: Math.max(height, 150) });

  let caption = '';
  let top = 1.6;

  const uniformPlugin = {
    hooks: {
      draw: (u) => {
        // The line every bar is being compared against. Without it a histogram
        // is a row of bars and "flat" has nothing to be flat relative to.
        const y = u.valToPos(1, 'y', true);
        const { ctx } = u;
        ctx.save();
        ctx.strokeStyle = COLOURS.predicted;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      },
    },
  };

  const opts = {
    ...base,
    scales: {
      x: { time: false, range: () => [0, 1] },
      y: { range: () => [0, top] },
    },
    series: [
      {},
      {
        label: 'PIT',
        stroke: COLOURS.text,
        fill: COLOURS.band,
        width: 1,
        paths: uPlot.paths.bars({ size: [0.86, Infinity], align: 0 }),
      },
    ],
    axes: [
      {
        ...base.axes[0],
        values: (u, splits) => splits.map((v) => v.toFixed(1)),
      },
      {
        ...base.axes[1],
        size: 34,
        values: (u, splits) => splits.map((v) => v.toFixed(1)),
      },
    ],
    plugins: [uniformPlugin, captionPlugin(() => caption)],
  };

  const plot = new uPlot(opts, [[], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /**
     * @param {ArrayLike<number>} pitValues one per scored interval
     * @returns {{shape: string, caption: string, pValue: number, n: number}} so the
     *          caller can put the same verdict in the panel header
     */
    update(pitValues) {
      if (pitValues.length === 0) {
        caption = classifyPitShape([]).caption;
        plot.setData([[], []]);
        return { shape: 'empty', caption, pValue: NaN, n: 0 };
      }
      const { counts, pValue } = pitHistogram(pitValues, bins);
      const bars = pitBars(counts);
      const verdict = classifyPitShape(counts);
      caption = verdict.caption;
      top = Math.max(1.6, Math.max(...bars.y) * 1.12);
      plot.setData([bars.x, bars.y]);
      return { ...verdict, pValue, n: bars.total };
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}

/**
 * Nominal against empirical coverage, with the line the model is trying to be.
 *
 * @param {HTMLElement} el
 * @returns {{plot: object, update: (d: object) => void, destroy: () => void}}
 */
export function createReliabilityDiagram(el) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 300), height: Math.max(height, 150) });

  const opts = {
    ...base,
    scales: {
      x: { time: false, range: () => [0.4, 1] },
      // Both axes share a range: a reliability diagram whose axes are scaled
      // differently puts the identity line at some angle other than 45 degrees,
      // and the whole point of the chart is deviation from that line.
      y: { range: () => [0.4, 1] },
    },
    series: [
      {},
      { label: 'perfect', stroke: COLOURS.faint, width: 1, dash: [4, 3] },
      {
        label: 'observed',
        stroke: COLOURS.predicted,
        width: 1.6,
        points: { show: true, size: 5, stroke: COLOURS.predicted, fill: COLOURS.surface },
      },
    ],
    axes: [
      {
        ...base.axes[0],
        label: 'nominal coverage',
        labelFont: '11px "Barlow Semi Condensed", sans-serif',
        labelSize: 20,
        values: (u, splits) => splits.map((v) => `${(v * 100).toFixed(0)}%`),
      },
      {
        ...base.axes[1],
        size: 40,
        values: (u, splits) => splits.map((v) => `${(v * 100).toFixed(0)}%`),
      },
    ],
    plugins: [],
  };

  const plot = new uPlot(opts, [[], [], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /**
     * @param {object} d
     * @param {number[]} d.nominal levels in (0,1), ascending
     * @param {number[]} d.empirical measured coverage at each level
     */
    update({ nominal, empirical }) {
      plot.setData([nominal, nominal, empirical]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}
