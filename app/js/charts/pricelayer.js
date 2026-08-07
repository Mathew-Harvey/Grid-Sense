// Price as context under the conviction band, and cumulative revenue beside it.
//
// The spot price runs from -$1,000 to +$17,500/MWh. On a linear axis that range
// renders every ordinary trading day as a flat line at the bottom, so the axis
// is symmetric-log: linear through zero, logarithmic outside it. That keeps a
// $90 afternoon legible in the same frame as a $15,000 spike without pretending
// the two are the same distance apart.
//
// Price is deliberately quieter than the band above it. The band is what the
// page is about; price is the thing that gives it consequence.

import { uPlot, COLOURS, baseOpts, nowRulePlugin, autoResize } from './base.js';

// Below this, prices are treated as linear. Chosen because the market's own
// interesting structure lives above it and nothing meaningful happens between
// -$1 and $1.
const LINEAR_THRESHOLD = 10;

/**
 * Symmetric log: signed, continuous through zero, and monotonic.
 *
 * Plain log cannot represent a negative price at all, and negative prices are
 * the single most informative thing this series carries — they are the market
 * paying generators to stop.
 */
export function symlog(v, threshold = LINEAR_THRESHOLD) {
  const a = Math.abs(v);
  if (a <= threshold) return v / threshold;
  return Math.sign(v) * (1 + Math.log10(a / threshold));
}

export function symlogInverse(y, threshold = LINEAR_THRESHOLD) {
  const a = Math.abs(y);
  if (a <= 1) return y * threshold;
  return Math.sign(y) * threshold * 10 ** (a - 1);
}

/** Tick values that read as money rather than as transformed units. */
export function priceTicks(min, max) {
  const candidates = [-1000, -100, -10, 0, 10, 100, 300, 1000, 5000, 17500];
  return candidates.filter((v) => v >= min && v <= max);
}

export const formatPrice = (v) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}$${(Math.abs(v) / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;

export function createPriceOverlay(el, { getNowSec, negativeColour } = {}) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 320), height: Math.max(height, 90) });

  // Drawn as two series over one dataset: the whole trace in a quiet neutral,
  // and the negative part again in the alert colour on top. A single series
  // cannot change colour partway along, and negative prices are exactly the part
  // that must not be quiet.
  const opts = {
    ...base,
    series: [
      {},
      { label: 'RRP', stroke: COLOURS.dim, width: 1.1, spanGaps: false },
      { label: 'negative', stroke: negativeColour ?? COLOURS.curtailed, width: 2, spanGaps: false },
    ],
    scales: { y: { range: (u, min, max) => [Math.min(min, -0.2), Math.max(max, 1.2)] } },
    axes: [
      base.axes[0],
      {
        ...base.axes[1],
        // Splits are in transformed space, so both the positions and the labels
        // are generated from real prices rather than from the transform.
        splits: (u, ax, min, max) => priceTicks(symlogInverse(min), symlogInverse(max)).map((v) => symlog(v)),
        values: (u, splits) => splits.map((s) => formatPrice(symlogInverse(s))),
      },
    ],
    plugins: [
      nowRulePlugin(getNowSec ?? (() => null)),
      {
        // A rule at zero, because "is this price negative" is the first question
        // anyone asks of this chart and it should not require reading an axis.
        hooks: {
          draw: (u) => {
            const y = u.valToPos(symlog(0), 'y', true);
            const { ctx } = u;
            ctx.save();
            ctx.strokeStyle = COLOURS.rule;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(u.bbox.left, y);
            ctx.lineTo(u.bbox.left + u.bbox.width, y);
            ctx.stroke();
            ctx.restore();
          },
        },
      },
    ],
  };

  const plot = new uPlot(opts, [[], [], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /** @param {number[]} t seconds @param {number[]} rrp dollars per MWh */
    update(t, rrp) {
      const all = new Array(rrp.length);
      const neg = new Array(rrp.length);
      for (let i = 0; i < rrp.length; i++) {
        const v = rrp[i];
        all[i] = Number.isFinite(v) ? symlog(v) : null;
        neg[i] = Number.isFinite(v) && v < 0 ? symlog(v) : null;
      }
      plot.setData([t, all, neg]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}

/**
 * Cumulative revenue as a thin ribbon on the same time axis.
 *
 * Cumulative rather than per-interval because the question is "how did the day
 * go", and a per-interval revenue trace is just the price trace multiplied by
 * generation — it says nothing the two charts above it do not already say.
 */
export function createRevenueRibbon(el) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 320), height: Math.max(height, 50) });

  const plot = new uPlot({
    ...base,
    series: [
      {},
      { label: 'cumulative revenue', stroke: COLOURS.dim, width: 1.2, fill: 'rgba(140,160,171,0.18)' },
    ],
    axes: [
      { ...base.axes[0], show: false },
      {
        ...base.axes[1],
        size: 52,
        values: (u, splits) => splits.map((v) => (
          Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1000).toFixed(0)}k`
        )),
      },
    ],
  }, [[], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /** @param {number[]} t seconds @param {number[]} perInterval dollars per interval */
    update(t, perInterval) {
      const cumulative = new Array(perInterval.length);
      let running = 0;
      for (let i = 0; i < perInterval.length; i++) {
        // A negative price makes running total fall, and that is the point: a
        // ribbon that only ever climbs would hide the hours that cost money.
        if (Number.isFinite(perInterval[i])) running += perInterval[i];
        cumulative[i] = running;
      }
      plot.setData([t, cumulative]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}
