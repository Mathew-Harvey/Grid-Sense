// Small animated canvases for the ideas that a static picture cannot carry.
//
// Each scene is a pure function of a clock: given t in seconds it draws one
// frame, and nothing accumulates between frames. That makes them scrubbable,
// restartable and safe to stop dead when the panel scrolls out of view or the
// reader has asked for reduced motion — in which case they draw exactly one
// frame at a chosen moment and stay there, because the still has to teach the
// same thing the motion does.
//
// They are deliberately not the real charts. These are diagrams of an idea,
// drawn from made-up numbers chosen to be legible; the real numbers are three
// tabs away and are never as tidy. Any scene that could be mistaken for
// measured data says so on its face.

import { COLOURS, fueltechColour } from './base.js';

const TAU = Math.PI * 2;

/** Deterministic wiggle: the same shape every run, so a reader can point at it. */
function wave(t, seed) {
  return Math.sin(t * 0.9 + seed) * 0.5
    + Math.sin(t * 2.3 + seed * 1.7) * 0.28
    + Math.sin(t * 5.1 + seed * 0.4) * 0.12;
}

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 200);
  const h = Math.max(rect.height, 120);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function label(ctx, text, x, y, colour = COLOURS.dim, align = 'left') {
  ctx.fillStyle = colour;
  ctx.font = '11px "Barlow Semi Condensed", sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// ---------------------------------------------------------------------------
// 1. Supply has to match demand, continuously
// ---------------------------------------------------------------------------

/**
 * Two bars that must stay level, and a needle that shows what happens when they
 * do not. This is the reason the whole system exists: electricity is produced
 * and consumed in the same instant, so somebody has to know what is coming.
 */
export function sceneBalance(canvas, t) {
  const { ctx, w, h } = setup(canvas);
  const mid = h * 0.52;
  const barW = Math.min(70, w * 0.16);
  const demand = 0.62 + wave(t, 1.2) * 0.09;
  // Supply chases demand with a lag — the gap between them is the problem.
  const supply = 0.62 + wave(t - 0.55, 1.2) * 0.09;

  const drawBar = (x, value, colour, name) => {
    const barH = value * (h * 0.55);
    ctx.fillStyle = colour;
    ctx.fillRect(x - barW / 2, mid - barH, barW, barH);
    label(ctx, name, x, mid + 16, COLOURS.dim, 'center');
  };

  drawBar(w * 0.3, supply, fueltechColour('hydro'), 'made');
  drawBar(w * 0.55, demand, COLOURS.text, 'used');

  // The needle: how far out of balance, exaggerated so it reads.
  const gap = (supply - demand) * 9;
  const nx = w * 0.83;
  ctx.strokeStyle = COLOURS.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(nx, mid, 34, Math.PI, TAU);
  ctx.stroke();
  const angle = Math.PI + (0.5 + Math.max(-0.45, Math.min(0.45, gap))) * Math.PI;
  ctx.strokeStyle = Math.abs(gap) > 0.25 ? COLOURS.curtailed : fueltechColour('battery_discharging');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nx, mid);
  ctx.lineTo(nx + Math.cos(angle) * 30, mid + Math.sin(angle) * 30);
  ctx.stroke();
  label(ctx, Math.abs(gap) > 0.25 ? 'out of balance' : 'in balance', nx, mid + 16, COLOURS.dim, 'center');
}

// ---------------------------------------------------------------------------
// 2. The lazy forecast, and beating it
// ---------------------------------------------------------------------------

/**
 * A wandering line, a flat "it will stay where it is" guess, and the error
 * between them shaded in. Persistence is the thing every score here is measured
 * against, and it is much harder to beat than it looks.
 */
export function scenePersistence(canvas, t) {
  const { ctx, w, h } = setup(canvas);
  const pad = 14;
  const n = 90;
  const y = (v) => h - pad - v * (h - pad * 2);
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const at = (i) => 0.5 + wave(t * 0.5 + i * 0.09, 3.1) * 0.3;

  // The guess is made at "now" and held flat forward from there.
  const nowI = Math.floor(n * 0.45);
  const guess = at(nowI);

  ctx.fillStyle = 'rgba(208,86,63,0.18)';
  ctx.beginPath();
  ctx.moveTo(x(nowI), y(guess));
  for (let i = nowI; i < n; i++) ctx.lineTo(x(i), y(at(i)));
  ctx.lineTo(x(n - 1), y(guess));
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = COLOURS.text;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(at(i)));
  ctx.stroke();

  ctx.strokeStyle = COLOURS.predicted;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x(nowI), y(guess));
  ctx.lineTo(x(n - 1), y(guess));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = COLOURS.faint;
  ctx.beginPath();
  ctx.moveTo(x(nowI), pad);
  ctx.lineTo(x(nowI), h - pad);
  ctx.stroke();

  label(ctx, 'what really happened', pad + 2, pad + 4);
  label(ctx, '“it will stay here”', x(nowI) + 6, y(guess) - 12, COLOURS.predicted);
  label(ctx, 'the gap is the error', w - pad - 2, h - pad - 10, COLOURS.curtailed, 'right');
}

// ---------------------------------------------------------------------------
// 3. What a band promises
// ---------------------------------------------------------------------------

/**
 * Outcomes dropping into a band, with a running tally of how many landed
 * inside. The claim "9 times out of 10" is only meaningful as a count, so the
 * scene counts.
 */
export function sceneBand(canvas, t) {
  const { ctx, w, h } = setup(canvas);
  const pad = 16;
  const mid = h * 0.5;
  const half = h * 0.22;
  const n = 20;

  ctx.fillStyle = COLOURS.band;
  ctx.fillRect(pad, mid - half, w - pad * 2, half * 2);
  ctx.strokeStyle = COLOURS.predicted;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, mid);
  ctx.lineTo(w - pad, mid);
  ctx.stroke();
  ctx.setLineDash([]);

  // One outcome revealed every 0.45 s, looping.
  const shown = Math.floor((t % 12) / 0.45);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    // Every tenth outcome is deliberately outside: that is what 90% means.
    const out = i % 10 === 7;
    const off = out ? (i % 20 === 7 ? -1.35 : 1.35) : wave(i * 2.1, 0.7) * 0.75;
    const cx = pad + ((i + 0.5) / n) * (w - pad * 2);
    const cy = mid + off * half;
    if (i >= shown) continue;
    if (!out) inside++;
    ctx.fillStyle = out ? COLOURS.curtailed : COLOURS.text;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.2, 0, TAU);
    ctx.fill();
  }

  const seen = Math.min(shown, n);
  label(ctx, 'the model’s range', pad + 2, mid - half - 9, COLOURS.predicted);
  label(ctx, seen ? `${inside} of ${seen} landed inside` : 'watching…', w - pad - 2, h - 12, COLOURS.dim, 'right');
}

// ---------------------------------------------------------------------------
// 4. Six guessers, one answer
// ---------------------------------------------------------------------------

/**
 * Six weights that add to one, shifting as each guesser's recent luck changes.
 * The point is that nothing picks a winner: the mixture moves continuously, and
 * an expert that stops earning its place simply shrinks.
 */
export function sceneEnsemble(canvas, t) {
  const { ctx, w, h } = setup(canvas);
  const names = ['no change', 'time of day', 'physics', 'statistics', 'memory', 'ramps'];
  const raw = names.map((_, i) => 0.5 + wave(t * 0.35 + i * 1.9, i * 2.4) * 0.42);
  const clipped = raw.map((v) => Math.max(0.05, v));
  const total = clipped.reduce((a, b) => a + b, 0);
  const pad = 12;
  const rowH = (h - pad * 2) / names.length;

  names.forEach((name, i) => {
    const share = clipped[i] / total;
    const y = pad + i * rowH;
    const barW = share * (w - 150);
    ctx.fillStyle = `hsl(${262 - i * 4} 55% ${28 + i * 7}%)`;
    ctx.fillRect(120, y + 2, Math.max(barW, 2), rowH - 6);
    label(ctx, name, 112, y + rowH / 2, COLOURS.dim, 'right');
    label(ctx, `${Math.round(share * 100)}%`, 126 + Math.max(barW, 2), y + rowH / 2, COLOURS.faint);
  });
}

// ---------------------------------------------------------------------------
// 5. Curtailment
// ---------------------------------------------------------------------------

/**
 * The wind keeps rising; the output stops. The gap between what the weather
 * offered and what the plant was allowed to make is the single most
 * misread thing in this data — without it, a curtailed farm looks like a
 * broken forecast.
 */
export function sceneCurtailment(canvas, t) {
  const { ctx, w, h } = setup(canvas);
  const pad = 14;
  const n = 90;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v) => h - pad - v * (h - pad * 2);
  const could = (i) => 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.5 + i * 0.055 - 1.4));
  // The cap arrives partway through and holds.
  const capFrom = Math.floor(n * 0.42);
  const capAt = 0.52;
  const made = (i) => (i >= capFrom ? Math.min(could(i), capAt) : could(i));

  ctx.fillStyle = 'rgba(208,86,63,0.22)';
  ctx.beginPath();
  for (let i = capFrom; i < n; i++) ctx.lineTo(x(i), y(could(i)));
  for (let i = n - 1; i >= capFrom; i--) ctx.lineTo(x(i), y(made(i)));
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = `${fueltechColour('wind')}88`;
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(could(i)));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = fueltechColour('wind');
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(made(i)));
  ctx.stroke();

  label(ctx, 'what the wind offered', pad + 2, y(0.95), `${fueltechColour('wind')}cc`);
  label(ctx, 'what the grid allowed', pad + 2, y(capAt) + 14, fueltechColour('wind'));
  label(ctx, 'spilled', w - pad - 2, y(0.78), COLOURS.curtailed, 'right');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const SCENES = {
  balance: sceneBalance,
  persistence: scenePersistence,
  band: sceneBand,
  ensemble: sceneEnsemble,
  curtailment: sceneCurtailment,
};

/**
 * Drive every canvas carrying a data-scene attribute inside `root`.
 *
 * Only what is on screen animates — an IntersectionObserver stops the rest, so
 * a page of five canvases costs one canvas of work. Reduced motion draws a
 * single representative frame instead of moving, because the argument each
 * scene makes has to survive being still.
 *
 * @param {HTMLElement} root
 * @returns {{stop: () => void}}
 */
export function runScenes(root) {
  const canvases = [...root.querySelectorAll('canvas[data-scene]')];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = new Set();
  let frame = 0;
  let started = 0;

  const draw = (canvas, t) => {
    const fn = SCENES[canvas.dataset.scene];
    if (fn) fn(canvas, t);
  };

  if (still) {
    for (const c of canvases) draw(c, 6.5);
    const redraw = () => { for (const c of canvases) draw(c, 6.5); };
    addEventListener('resize', redraw);
    return { stop: () => removeEventListener('resize', redraw) };
  }

  // Every canvas gets one frame up front, and another the moment it becomes
  // visible. Without it a scene that has not yet been scrolled to is blank
  // while its caption describes what it shows, which reads as a broken chart
  // rather than as one waiting its turn.
  for (const c of canvases) draw(c, 6.5);

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { visible.add(e.target); draw(e.target, (performance.now() - started) / 1000); }
      else visible.delete(e.target);
    }
  }, { rootMargin: '80px' });
  for (const c of canvases) observer.observe(c);

  const tick = (now) => {
    if (!started) started = now;
    const t = (now - started) / 1000;
    for (const c of visible) draw(c, t);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    stop() {
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
