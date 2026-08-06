// Correlation against weather, variable by variable, across six hours of lag.
//
// The interesting reading is never the peak value, it is where the peak sits. A
// front reaches the reanalysis grid cell before it reaches the turbines, so a
// wind farm's profile peaks a few steps out and that offset is a physically real
// travel time you can lay against a map. A peak at exactly one step is not
// weather at all — it is a mis-stamped interval, and this chart is where that
// shows up.
//
// Which is exactly why a peak that is not there must not be drawn. A thermal
// station's output tracks demand, demand tracks the season, and its lag profile
// is a flat line across the whole window: the argmax is then chosen by
// floating-point noise. `laggedCrossCorrelation` reports null for those, and an
// arrow at zero would claim the timing carries information it does not. Those
// rows say so in words instead.
//
// The scale diverges from the panel's own background: no correlation fades into
// the surface, so "nothing here" reads as absence rather than as a colour. The
// two ends are red and blue rather than red and green, which is the one
// diverging pair that survives the common colour-vision deficiencies.

import { uPlot, COLOURS, fueltechColour, baseOpts, autoResize } from './base.js';

const MINUTES_PER_STEP = 5;

// Anything at or below this is noise dressed as structure. The same threshold
// the correlation itself uses to decide a peak is identifiable.
const VISIBLE_R = 0.02;

const SHORT_LABELS = {
  temperature_2m: 'temp 2 m',
  relative_humidity_2m: 'humidity',
  surface_pressure: 'pressure',
  wind_speed_10m: 'wind 10 m',
  wind_speed_100m: 'wind 100 m',
  wind_direction_100m: 'wind dirn',
  wind_shear: 'shear',
  wind_power: 'wind power',
  air_density: 'air density',
  shortwave_radiation: 'GHI',
  direct_normal_irradiance: 'DNI',
  diffuse_radiation: 'diffuse',
  clear_sky_ghi: 'clear-sky GHI',
  clear_sky_index: 'clear-sky index',
  solar_zenith: 'zenith',
  cloud_cover: 'cloud',
  cloud_cover_low: 'cloud low',
  cloud_cover_mid: 'cloud mid',
  cloud_cover_high: 'cloud high',
};

/**
 * A weather variable's name, short enough to sit in a 60 px axis gutter.
 *
 * @param {string} name
 * @returns {string}
 */
export function shortVariableLabel(name) {
  return SHORT_LABELS[name] ?? name.replace(/_/g, ' ');
}

function parseHex(colour) {
  const hex = colour.trim().replace('#', '');
  const wide = hex.length >= 6;
  const at = (i) => parseInt(wide ? hex.slice(i * 2, i * 2 + 2) : hex[i].repeat(2), 16);
  return [at(0), at(1), at(2)];
}

/**
 * Blend two hex colours in sRGB.
 *
 * sRGB rather than a perceptual space because the two ends are already far apart
 * in hue; the only thing a perceptual blend would buy is a smoother midpoint,
 * and the midpoint here is the background.
 *
 * @param {string} from @param {string} to
 * @param {number} t 0 gives `from`, 1 gives `to`
 * @returns {string} `#rrggbb`
 */
export function mixHex(from, to, t) {
  const a = parseHex(from);
  const b = parseHex(to);
  const f = Math.max(0, Math.min(1, t));
  const channel = (i) => Math.round(a[i] + (b[i] - a[i]) * f).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * A diverging scale, centred on zero and normalised to the strongest cell in the
 * matrix.
 *
 * Normalised per station rather than fixed to +/-1: a thermal station's whole
 * profile lives inside +/-0.4, and against a fixed scale its structure is a
 * uniform dark rectangle.
 *
 * @param {{negative: string, neutral: string, positive: string, max: number}} ends
 * @returns {(r: number) => string}
 */
export function divergingScale({ negative, neutral, positive, max }) {
  const span = Number.isFinite(max) && max > 0 ? max : 1;
  return (r) => {
    if (!Number.isFinite(r)) return neutral;
    const t = Math.min(1, Math.abs(r) / span);
    return mixHex(neutral, r < 0 ? negative : positive, t);
  };
}

/**
 * How a row's peak lag should be stated.
 *
 * The sign convention is the one `laggedCrossCorrelation` uses: weather at t
 * against output at t + k, so a positive lag means the weather led.
 *
 * @param {{peak_lag_steps: number|null, peak_lag_minutes?: number|null}} variable
 * @returns {string}
 */
export function peakLagLabel(variable) {
  const steps = variable.peak_lag_steps;
  if (steps === null || steps === undefined) return 'no identifiable lag';
  const minutes = variable.peak_lag_minutes ?? steps * MINUTES_PER_STEP;
  if (minutes === 0) return 'peak at 0 min';
  return minutes > 0 ? `weather leads ${minutes} min` : `weather trails ${-minutes} min`;
}

/**
 * Rows for the matrix, strongest relationship first.
 *
 * Sorted because at 390 px only the top few rows are read at all, and a station
 * with nine weather variables has one or two that matter.
 *
 * @param {Record<string, object>} variables the `variables` map of a correlation bundle
 * @returns {{name: string, label: string, lags: number[], values: number[],
 *            peakLag: number|null, peakLabel: string, strength: number}[]}
 */
export function lagRows(variables) {
  const rows = [];
  for (const [name, v] of Object.entries(variables ?? {})) {
    const values = v.cross_correlation ?? [];
    let strength = 0;
    for (const r of values) {
      if (Number.isFinite(r) && Math.abs(r) > strength) strength = Math.abs(r);
    }
    rows.push({
      name,
      label: shortVariableLabel(name),
      lags: v.lags ?? [],
      values,
      peakLag: v.peak_lag_steps ?? null,
      peakLabel: peakLagLabel(v),
      strength,
    });
  }
  return rows.sort((a, b) => b.strength - a.strength);
}

/**
 * @param {HTMLElement} el
 * @returns {{plot: object, update: (variables: Record<string, object>) => void, destroy: () => void}}
 */
export function createLagHeatmap(el) {
  const { width, height } = el.getBoundingClientRect();
  const base = baseOpts({ width: Math.max(width, 320), height: Math.max(height, 160) });

  let rows = [];
  let lagRange = [-360, 360];

  const cellsPlugin = {
    hooks: {
      draw: (u) => {
        if (rows.length === 0) return;
        const { ctx } = u;
        const strongest = Math.max(...rows.map((r) => r.strength), VISIBLE_R);
        const colourFor = divergingScale({
          negative: COLOURS.curtailed,
          neutral: COLOURS.raised,
          positive: fueltechColour('hydro'),
          max: strongest,
        });
        const rowHeight = u.bbox.height / rows.length;

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        rows.forEach((row, i) => {
          const top = u.bbox.top + i * rowHeight;
          for (let c = 0; c < row.values.length; c++) {
            const minutes = row.lags[c] * MINUTES_PER_STEP;
            const half = MINUTES_PER_STEP / 2;
            const x0 = u.valToPos(minutes - half, 'x', true);
            const x1 = u.valToPos(minutes + half, 'x', true);
            ctx.fillStyle = colourFor(row.values[c]);
            // Cells are under two pixels wide at 390 px, so they are drawn a
            // whole pixel over to stop antialiasing leaving a comb of gaps.
            ctx.fillRect(x0, top, Math.max(1, x1 - x0 + 1), rowHeight);
          }
        });

        const zero = u.valToPos(0, 'x', true);
        ctx.strokeStyle = COLOURS.faint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(zero, u.bbox.top);
        ctx.lineTo(zero, u.bbox.top + u.bbox.height);
        ctx.stroke();

        ctx.font = '10px "Barlow Semi Condensed", sans-serif';
        ctx.textBaseline = 'middle';
        rows.forEach((row, i) => {
          const mid = u.bbox.top + (i + 0.5) * rowHeight;
          if (row.peakLag === null) {
            // Stated rather than marked. A flat profile means the timing carries
            // no information, and any glyph at all would imply it carries some.
            ctx.fillStyle = COLOURS.faint;
            ctx.textAlign = 'center';
            ctx.fillText(row.peakLabel, u.bbox.left + u.bbox.width / 2, mid);
            return;
          }
          const px = u.valToPos(row.peakLag * MINUTES_PER_STEP, 'x', true);
          ctx.strokeStyle = COLOURS.text;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, u.bbox.top + i * rowHeight + 1);
          ctx.lineTo(px, u.bbox.top + (i + 1) * rowHeight - 1);
          ctx.stroke();

          const flip = px > u.bbox.left + u.bbox.width * 0.6;
          ctx.fillStyle = COLOURS.text;
          ctx.textAlign = flip ? 'right' : 'left';
          ctx.fillText(row.peakLabel, px + (flip ? -4 : 4), mid);
        });

        ctx.restore();
      },
    },
  };

  const opts = {
    ...base,
    scales: {
      x: { time: false, range: () => lagRange },
      y: { range: () => [0, Math.max(rows.length, 1)] },
    },
    // One transparent series: uPlot needs a series to have a plot area at all,
    // and every mark on this chart is painted in the draw hook.
    series: [{}, { stroke: 'transparent', width: 0 }],
    cursor: { ...base.cursor, points: { show: false } },
    axes: [
      {
        ...base.axes[0],
        label: 'lag (minutes) — weather leads to the right',
        labelFont: '11px "Barlow Semi Condensed", sans-serif',
        labelSize: 20,
        values: (u, splits) => splits.map((v) => (v > 0 ? `+${v}` : `${v}`)),
      },
      {
        ...base.axes[1],
        size: 78,
        grid: { show: false },
        // Rows run top to bottom while the y scale runs bottom to top, so the
        // strongest variable is drawn first and labelled last.
        splits: () => rows.map((_, i) => rows.length - i - 0.5),
        values: (u, splits) => splits.map((s) => rows[rows.length - s - 0.5]?.label ?? ''),
      },
    ],
    plugins: [cellsPlugin],
  };

  const plot = new uPlot(opts, [[], []], el);
  const stopResize = autoResize(plot, el);

  return {
    plot,
    /** @param {Record<string, object>} variables the `variables` map of a correlation bundle */
    update(variables) {
      rows = lagRows(variables);
      const lags = rows[0]?.lags ?? [];
      if (lags.length > 0) {
        lagRange = [lags[0] * MINUTES_PER_STEP, lags[lags.length - 1] * MINUTES_PER_STEP];
      }
      plot.setData([lagRange, [0, 0]]);
    },
    destroy() { stopResize(); plot.destroy(); },
  };
}
