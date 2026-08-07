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
import {
  pitHistogram, pitUniformity, pitBars, classifyPitShape,
  reliabilityFromPit, reliabilityFromCounts,
} from '../models/score.js';

// Re-exported so a caller that already has the chart module does not need a
// second import for the statistics behind it.
export { pitBars, classifyPitShape, reliabilityFromPit, reliabilityFromCounts };

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
      if (pitValues.length === 0) return this.updateCounts([]);
      return this.updateCounts(pitHistogram(pitValues, bins).counts);
    },
    /**
     * The same chart from an already-binned histogram.
     *
     * The replay worker bins as it scores and ships ten numbers per frame
     * rather than a hundred thousand, so this is the entry point it needs.
     * Handing those counts to update() instead is silent and catastrophic:
     * every count is well above 1, so re-binning them into [0,1] piles all ten
     * into the top bar and the panel reports a confident, unchanging verdict
     * about a distribution it never saw.
     *
     * @param {ArrayLike<number>} counts one per bin
     */
    updateCounts(counts) {
      let total = 0;
      for (let i = 0; i < counts.length; i++) total += counts[i];
      if (total === 0) {
        caption = classifyPitShape([]).caption;
        plot.setData([[], []]);
        top = 1.6;
        return { shape: 'empty', caption, pValue: NaN, n: 0 };
      }
      const bars = pitBars(counts);
      const verdict = classifyPitShape(counts);
      caption = verdict.caption;
      top = Math.max(1.6, Math.max(...bars.y) * 1.12);
      plot.setData([bars.x, bars.y]);
      return { ...verdict, pValue: pitUniformity(counts).pValue, n: bars.total };
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
