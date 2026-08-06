// The fitted power curve, drawn over every interval that went into it.
//
// The curve is the least interesting thing on this chart. What matters is the
// cloud of curtailed points sitting *below* it: intervals where the wind was
// blowing and the farm was told not to use it. Leave them in the fit and they
// drag the plateau down by however often the network was full, which is why the
// fit excludes them — and this is that argument made visually, because a
// masked_fraction of 0.31 in a table says nothing at all.
//
// So the masked points have to be findable. They carry a glyph as well as a
// hue: a cross against a dot. Red against grey is not a distinction every
// reader has, and it is not one any reader has on a projector.
//
// Thousands of five-minute intervals land here, so the scatter is painted onto
// the canvas in one pass. A uPlot series per point would be tens of thousands
// of series objects to draw a picture that is two fill styles.
//
// Only the wind fit produces a curve in one variable. The solar fit is a
// surface in irradiance *and* cell temperature, so for solar the scatter is
// drawn and no line is: a line through a surface would be a fourth parameter
// the fit never estimated.

import { uPlot, COLOURS, baseOpts, autoResize } from './base.js';

const CURVE_SAMPLES = 160;

// Enough separation that a cross reads as a cross at 390 px, small enough that
// several thousand of them still show density rather than a solid block.
const DOT = 1.2;
const CROSS = 2.2;

/**
 * The fitted wind curve, sampled across the observed speed range for drawing.
 *
 * Rebuilt from the parameters rather than called through the fit's own
 * `predict`, because a bundle that has been through `correlations.json` has lost
 * its closure — JSON carries the parameters and nothing else. The parameters are
 * the fit, so nothing is lost by evaluating them here.
 *
 * @param {object|null} curve a `fitWindCurve` result, live or deserialised
 * @param {number} capacityMw registered capacity the fit was scaled against
 * @param {number} xMin @param {number} xMax observed speed range, m/s
 * @param {number} [samples]
 * @returns {{x: number[], y: number[]}|null} null when there is no curve to draw
 */
export function sampleFittedCurve(curve, capacityMw, xMin, xMax, samples = CURVE_SAMPLES) {
  if (!curve || !curve.converged || !curve.params) return null;
  if (!Number.isFinite(capacityMw) || capacityMw <= 0) return null;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) return null;

  const { yMin, yMax, k, v50 } = curve.params;
  const cutOut = curve.cutOut;
  const x = [];
  const y = [];
  for (let i = 0; i < samples; i++) {
    const v = xMin + (xMax - xMin) * (i / (samples - 1));
    x.push(v);
    // Cut-out is a cliff, not a tail: a farm at full output is at zero within
    // minutes of the wind crossing it. Drawing the sigmoid through it would show
    // the machine producing in a gale that shut it down.
    if (Number.isFinite(cutOut) && v >= cutOut) {
      y.push(0);
      continue;
    }
    const frac = yMin + (yMax - yMin) / (1 + Math.exp(-k * (v - v50)));
    y.push(Math.max(0, Math.min(capacityMw, capacityMw * frac)));
  }
  return { x, y };
}

/**
 * The three speeds worth naming on a turbine's curve, as the fit found them.
 *
 * Cut-out is genuinely absent at most sites — the wind never blew that hard in
 * the window — and an absent cut-out is not a cut-out at zero, so it is left off
 * the chart rather than drawn at the origin.
 *
 * @param {object|null} curve
 * @returns {{x: number, label: string}[]}
 */
export function curveMarks(curve) {
  if (!curve || !curve.converged) return [];
  return [
    { x: curve.cutIn, label: 'cut-in' },
    { x: curve.rated, label: 'rated' },
    { x: curve.cutOut, label: 'cut-out' },
  ].filter((m) => Number.isFinite(m.x));
}

/**
 * Extent of the scatter, with the y axis anchored at zero.
 *
 * Anchored because a farm that never left the bottom of its curve would
 * otherwise fill the panel and look like one that ran at rated all winter.
 *
 * @param {ArrayLike<number>} x @param {ArrayLike<number>} y
 * @returns {{xMin: number, xMax: number, yMax: number}|null}
 */
export function scatterExtent(x, y) {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    if (x[i] < xMin) xMin = x[i];
    if (x[i] > xMax) xMax = x[i];
    if (y[i] > yMax) yMax = y[i];
  }
  if (!Number.isFinite(xMin) || xMax === xMin) return null;
  return { xMin, xMax, yMax: yMax > 0 ? yMax : 1 };
}

/**
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {string} [opts.xLabel] axis label including its unit
 * @returns {{plot: object, update: (d: object) => void, destroy: () => void}}
 */
export function createPowerCurve(el, { xLabel = 'wind speed at hub height (m/s)' } = {}) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 320), height: Math.max(height, 200) });

  // The scatter lives outside uPlot's data because it does not share the fitted
  // curve's x values, and uPlot gives every series one x array.
  const cloud = { x: [], y: [], masked: [] };
  let extent = null;
  let marks = [];

  const label = (u, x, text, tone) => {
    const { ctx } = u;
    ctx.fillStyle = tone;
    ctx.font = '10px "Barlow Semi Condensed", sans-serif';
    ctx.textBaseline = 'top';
    // Flipped rather than clipped near the right edge: a label that runs off the
    // canvas takes the thing it names with it.
    const flip = x > u.bbox.left + u.bbox.width - 46;
    ctx.textAlign = flip ? 'right' : 'left';
    ctx.fillText(text, x + (flip ? -4 : 4), u.bbox.top + 3);
  };

  const scatterPlugin = {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        // Uncapped underneath, capped over the top. Painted the other way round
        // the masked points vanish under the density of the ordinary ones, which
        // is the one thing this chart exists to show.
        ctx.fillStyle = COLOURS.dim;
        ctx.globalAlpha = 0.3;
        for (let i = 0; i < cloud.x.length; i++) {
          if (cloud.masked[i]) continue;
          if (!Number.isFinite(cloud.x[i]) || !Number.isFinite(cloud.y[i])) continue;
          const px = u.valToPos(cloud.x[i], 'x', true);
          const py = u.valToPos(cloud.y[i], 'y', true);
          ctx.fillRect(px - DOT, py - DOT, DOT * 2, DOT * 2);
        }

        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = COLOURS.curtailed;
        ctx.lineWidth = 1;
        // One path for every cross: several thousand separate strokes is the
        // difference between a chart that redraws on hover and one that stutters.
        ctx.beginPath();
        for (let i = 0; i < cloud.x.length; i++) {
          if (!cloud.masked[i]) continue;
          if (!Number.isFinite(cloud.x[i]) || !Number.isFinite(cloud.y[i])) continue;
          const px = u.valToPos(cloud.x[i], 'x', true);
          const py = u.valToPos(cloud.y[i], 'y', true);
          ctx.moveTo(px - CROSS, py - CROSS);
          ctx.lineTo(px + CROSS, py + CROSS);
          ctx.moveTo(px + CROSS, py - CROSS);
          ctx.lineTo(px - CROSS, py + CROSS);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        for (const mark of marks) {
          const px = u.valToPos(mark.x, 'x', true);
          if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
          ctx.strokeStyle = COLOURS.faint;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(px, u.bbox.top);
          ctx.lineTo(px, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.setLineDash([]);
          label(u, px, mark.label, COLOURS.dim);
        }

        ctx.restore();
      },
    },
  };

  const keyPlugin = {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        const x = u.bbox.left + 8;
        const y = u.bbox.top + u.bbox.height - 20;
        ctx.save();
        ctx.font = '10px "Barlow Semi Condensed", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        ctx.fillStyle = COLOURS.dim;
        ctx.fillRect(x - DOT, y - DOT, DOT * 2, DOT * 2);
        ctx.fillText('uncapped', x + 8, y);

        const x2 = x + 62;
        ctx.strokeStyle = COLOURS.curtailed;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x2 - CROSS, y + 8 - CROSS);
        ctx.lineTo(x2 + CROSS, y + 8 + CROSS);
        ctx.moveTo(x2 + CROSS, y + 8 - CROSS);
        ctx.lineTo(x2 - CROSS, y + 8 + CROSS);
        ctx.stroke();
        ctx.fillStyle = COLOURS.curtailed;
        ctx.fillText('curtailed', x + 8, y + 8);
        ctx.restore();
      },
    },
  };

  const opts = {
    ...base,
    scales: {
      // Speed, not time. uPlot treats the x scale as epoch seconds unless told
      // otherwise, and the tick labels come out as 1970.
      x: { time: false, range: () => (extent ? [extent.xMin, extent.xMax] : [0, 1]) },
      y: { range: () => (extent ? [0, extent.yMax * 1.05] : [0, 1]) },
    },
    series: [
      {},
      { label: 'fitted', stroke: COLOURS.predicted, width: 1.6, spanGaps: false },
    ],
    axes: [
      {
        ...base.axes[0],
        label: xLabel,
        labelFont: '11px "Barlow Semi Condensed", sans-serif',
        labelSize: 20,
        values: (u, splits) => splits.map((v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))),
      },
      {
        ...base.axes[1],
        values: (u, splits) => splits.map((v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} GW` : v.toFixed(0))),
      },
    ],
    plugins: [scatterPlugin, keyPlugin],
  };

  const plot = new uPlot(opts, [[], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /**
     * @param {object} d
     * @param {ArrayLike<number>} d.x driving variable, one per interval
     * @param {ArrayLike<number>} d.y output MW, same order
     * @param {ArrayLike<boolean>} d.masked true where the interval was capped
     * @param {object|null} [d.curve] the fit bundle
     * @param {number} [d.capacityMw]
     */
    update(d) {
      cloud.x = d.x;
      cloud.y = d.y;
      cloud.masked = d.masked ?? [];
      extent = scatterExtent(d.x, d.y);
      marks = curveMarks(d.curve);

      const fitted = extent
        ? sampleFittedCurve(d.curve, d.capacityMw, extent.xMin, extent.xMax)
        : null;
      plot.setData(fitted ? [fitted.x, fitted.y] : [[], []]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}
