// Shared uPlot setup: the palette bridge, the tick grid, and the "now" rule.
//
// uPlot rather than a dashboard charting library because this renders 5-minute
// data across 90 days for dozens of series while the replay updates it live.
// That is hundreds of thousands of points; the canvas libraries built for
// dashboards drop frames at a tenth of this load.

// Served by the harvester at /vendor, which is where node_modules is exposed.
// A relative path out of app/ resolves to a URL the server does not route, and
// the failure is a silent 404 that leaves every chart blank with the page
// otherwise looking fine.
import uPlot from '/vendor/uplot/dist/uPlot.esm.js';

export { uPlot };

/** Fueltech colours are read from CSS rather than duplicated here, so the
 *  palette has exactly one definition. */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const fueltechColour = (ft) => css(`--ft-${ft}`) || css('--text-dim');

export const COLOURS = {
  get text() { return css('--text'); },
  get dim() { return css('--text-dim'); },
  get faint() { return css('--text-faint'); },
  get rule() { return css('--rule'); },
  get predicted() { return css('--state-predicted'); },
  get band() { return css('--state-band'); },
  get bandGhost() { return css('--state-band-ghost'); },
  get curtailed() { return css('--state-curtailed'); },
  get now() { return css('--state-now'); },
  get surface() { return css('--surface'); },
  get raised() { return css('--raised'); },
};

// Fueltech must never be carried by hue alone: teal wind against green battery
// is not a safe distinction. Every fueltech also gets a dash signature and a
// short code, used in charts and legends alike.
export const FUELTECH_DASH = {
  coal_black: [], coal_brown: [],
  gas_ccgt: [6, 3], gas_steam: [6, 3], gas_ocgt: [2, 3], gas_recip: [2, 3],
  distillate: [1, 3],
  hydro: [10, 4],
  wind: [], solar_utility: [],
  battery_discharging: [4, 2, 1, 2], battery_charging: [4, 2, 1, 2],
  bioenergy: [8, 2, 2, 2], pumps: [10, 4],
};

export const FUELTECH_CODE = {
  coal_black: 'CLB', coal_brown: 'CLN', gas_ccgt: 'CCG', gas_ocgt: 'OCG',
  gas_steam: 'GST', gas_recip: 'GRC', distillate: 'DST', hydro: 'HYD',
  wind: 'WND', solar_utility: 'SOL', battery_discharging: 'BAT+',
  battery_charging: 'BAT−', bioenergy: 'BIO', pumps: 'PMP',
};

/** NEM time for axis labels: UTC+10 always, no daylight saving in any region. */
export function nemTimeLabel(epochMs, withDate = false) {
  const d = new Date(epochMs + 10 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${day} ${mon} ${hh}:${mm}`;
}

/** Base axis and grid styling, shared so every chart reads as one instrument. */
export function baseOpts({ width, height, title }) {
  return {
    width,
    height,
    title,
    cursor: {
      y: false,
      points: { size: 5 },
      drag: { x: true, y: false },
    },
    legend: { show: false },
    axes: [
      {
        stroke: COLOURS.faint,
        grid: { stroke: COLOURS.rule, width: 1 },
        ticks: { stroke: COLOURS.rule, width: 1, size: 4 },
        font: '11px "Barlow Semi Condensed", sans-serif',
        values: (u, splits) => splits.map((s) => nemTimeLabel(s * 1000)),
      },
      {
        stroke: COLOURS.faint,
        grid: { stroke: COLOURS.rule, width: 1 },
        ticks: { show: false },
        font: '11px "Barlow Semi Condensed", sans-serif',
        size: 46,
      },
    ],
  };
}

/**
 * The "now" rule: one hard vertical line every time-axis chart shares, marking
 * the boundary between observed and forecast. It is the single most important
 * piece of orientation on the page — without it a fan chart is just a shape.
 */
export function nowRulePlugin(getNowSec) {
  return {
    hooks: {
      draw: (u) => {
        const now = getNowSec();
        if (now == null) return;
        const x = u.valToPos(now, 'x', true);
        if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
        const { ctx } = u;
        ctx.save();
        ctx.strokeStyle = COLOURS.now;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}

/** Resize a chart to its container, debounced to a rAF so a window drag does
 *  not queue one relayout per mousemove. */
export function autoResize(plot, el) {
  let queued = false;
  const ro = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) plot.setSize({ width, height });
    });
  });
  ro.observe(el);
  return () => ro.disconnect();
}

// Ordered from "assumes nothing changes" to "carries the physics", so the expert
// ribbon reads bottom-to-top as increasing model commitment. Deliberately a
// single ramp: hue is reserved for fueltech, and six competing colours here
// would claim a meaning these series do not have.
// Six experts stacked in one ribbon, so the six bands must be told apart at a
// glance — the previous ramp walked six near-identical slate greys and could
// not be. It stays inside the violet "computed number" family rather than
// borrowing fueltech hues, and separates on lightness and chroma together,
// which survives both a small ribbon and colour-vision deficiency.
export const EXPERT_RAMP = [
  '#241d3d', '#342a58', '#453873', '#57478f', '#6a57a8', '#7e69bd',
];
