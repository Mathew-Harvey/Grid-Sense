// The boot screen: an animation of the thesis, and an honest progress report.
//
// The load is slow because it is large — three weeks of five-minute dispatch
// for every station in the country, into the browser, followed by a model
// fitted on the device. A spinner would say "the server is thinking", which is
// both untrue and the least interesting possible account of the wait.
//
// So the animation is the system's own claim, drawn: a wind trace runs across
// the top, and beneath it a row of bars follows that trace *late*. That lag is
// the whole premise — weather leads generation by a measurable delay, and
// finding it per station is what the correlation pass does. Someone who watches
// this for eight seconds has been told what the dashboard is for.
//
// Everything here is deliberately independent of the app: no uPlot, no three,
// no store, no data. It has to run while those are still being parsed.

const PHASES = [
  // Weights are wall-clock shares measured on a local load, not guesses at
  // importance. Dispatch is most of the wait because it is most of the bytes;
  // a bar that moved evenly across five phases would stall visibly on the one
  // that takes two thirds of the time.
  { key: 'registry', weight: 0.02 },
  { key: 'dispatch', weight: 0.60 },
  { key: 'weather', weight: 0.26 },
  { key: 'prices', weight: 0.04 },
  { key: 'train', weight: 0.08 },
];

const WIND = '#3fa89b';
const PREDICTED = '#a98bff';
const FAINT = '#233038';

/** Smooth pseudo-wind: a few incommensurable sines, so it never visibly loops. */
function windAt(x, t) {
  return (
    0.50 * Math.sin(x * 1.7 + t * 0.9)
    + 0.30 * Math.sin(x * 2.9 - t * 1.31)
    + 0.20 * Math.sin(x * 0.7 + t * 0.53)
  );
}

/**
 * Draw one frame of the wind-leads-generation animation.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} t seconds since start
 * @param {number} progress 0..1, drives how far the bars have "come alive"
 */
function drawFrame(ctx, t, progress) {
  const dpr = ctx.getTransform().a || 1;
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);

  const traceY = h * 0.22;
  const traceAmp = h * 0.15;
  const baseY = h * 0.96;
  const maxBar = h * 0.60;
  const bars = 30;
  const gap = w / bars;
  const barW = Math.max(2, gap * 0.5);

  // The lag, in the same x units the trace is drawn in. Two bars' worth is
  // enough to read as "later" without the two shapes looking unrelated.
  const LAG = 2.1;

  // Progress is a wavefront across the bars rather than a height multiplier.
  // Suppressing height to show progress made every bar a stub for the first
  // several seconds — the animation was least alive exactly when it had the
  // most waiting to justify. The shapes now move from the start and the fill
  // sweeps left to right, so the picture carries the progress instead of the
  // progress flattening the picture.
  const front = progress * bars;

  for (let i = 0; i < bars; i++) {
    const x = i * gap + gap / 2;
    const u = (i - LAG) / bars * 6;
    // Rectified because a farm cannot generate negative wind, and raised to a
    // power because output goes as roughly the cube of wind speed — the curve
    // this whole system fits. A linear bar would be a prettier lie.
    const v = Math.max(0, windAt(u, t) * 0.5 + 0.5);
    const height = Math.max(2, maxBar * Math.pow(v, 1.7));
    const top = baseY - height;
    const lit = Math.min(1, Math.max(0, front - i));

    // The unlit bar is the shape without the substance: outlined, not filled.
    ctx.fillStyle = FAINT;
    ctx.fillRect(x - barW / 2, top, barW, height);

    if (lit > 0) {
      const g = ctx.createLinearGradient(0, top, 0, baseY);
      g.addColorStop(0, PREDICTED);
      g.addColorStop(1, WIND);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.65 * lit;
      // The glow is why this reads as energy rather than as a bar chart, and
      // it is one shadow on thirty small rectangles — cheap enough for a phone.
      ctx.shadowColor = PREDICTED;
      ctx.shadowBlur = 12 * lit;
      ctx.fillStyle = g;
      ctx.fillRect(x - barW / 2, top, barW, height * lit);
      ctx.restore();
    }
  }

  // ---- the trace: weather, ahead of them ---------------------------------
  ctx.beginPath();
  for (let px = 0; px <= w; px += 2) {
    const u = px / w * 6;
    const y = traceY - windAt(u, t) * traceAmp;
    if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
  }
  ctx.strokeStyle = WIND;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = WIND;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // A travelling highlight, moving at the speed the lag implies, so the eye is
  // led from a gust to the bar it lands in rather than left to infer it.
  const headX = ((t * 0.14) % 1.2 - 0.1) * w;
  if (headX >= 0 && headX <= w) {
    const y = traceY - windAt(headX / w * 6, t) * traceAmp;
    ctx.beginPath();
    ctx.arc(headX, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = WIND;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(headX, y + 6);
    ctx.lineTo(headX + LAG * gap, baseY - maxBar * 0.5);
    ctx.strokeStyle = `${PREDICTED}55`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * Start the boot screen.
 *
 * @returns {{progress: (p: object) => void, done: () => void, fail: (msg: string) => void}}
 */
export function bootScreen() {
  const root = document.getElementById('boot');
  if (!root) return { progress() {}, done() {}, fail() {} };

  const fill = document.getElementById('boot-fill');
  const phaseLine = document.getElementById('boot-phase');
  const steps = [...document.querySelectorAll('#boot-steps li')];
  const canvas = document.getElementById('boot-canvas');
  const ctx = canvas?.getContext('2d');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = null;
  let shown = 0;
  const started = performance.now();

  if (ctx) {
    // Crisp on a phone, which is where this is most likely to be seen, and
    // where the wait it exists for is longest.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 640;
    const cssH = Math.round(cssW * 0.375);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    // Scaled once here so drawFrame is written in CSS pixels and is right at
    // any device pixel ratio. It reads the scale back off the transform rather
    // than closing over dpr, so the drawing stays a pure function of the
    // context it is handed.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (reduced) {
      drawFrame(ctx, 0.8, 0.6);
    } else {
      const loop = () => {
        drawFrame(ctx, (performance.now() - started) / 1000, shown);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
  }

  const weightBefore = (key) => {
    let sum = 0;
    for (const p of PHASES) { if (p.key === key) break; sum += p.weight; }
    return sum;
  };

  return {
    /**
     * @param {{phase?: string, label?: string, done?: number, total?: number}} p
     */
    progress(p) {
      const phase = PHASES.find((x) => x.key === p.phase);
      if (phase) {
        const within = p.total > 0 ? Math.min(1, (p.done ?? 0) / p.total) : 0;
        // Monotonic on purpose. Phases report their own counters and a later
        // one can start at zero; a bar that slid backwards would read as the
        // load having failed and restarted.
        shown = Math.max(shown, weightBefore(phase.key) + phase.weight * within);
        if (fill) fill.style.width = `${(shown * 100).toFixed(1)}%`;

        for (const li of steps) {
          const idx = PHASES.findIndex((x) => x.key === li.dataset.phase);
          const cur = PHASES.findIndex((x) => x.key === phase.key);
          li.dataset.state = idx < cur ? 'done' : idx === cur ? 'active' : '';
        }
      }
      if (phaseLine && p.label) {
        phaseLine.textContent = p.total > 1 ? `${p.label} — ${p.done} of ${p.total}` : p.label;
      }
    },

    done() {
      if (raf) cancelAnimationFrame(raf);
      for (const li of steps) li.dataset.state = 'done';
      if (fill) fill.style.width = '100%';
      root.classList.add('boot-done');
      // Removed after the fade rather than left in the tree: it covers the
      // whole viewport, and a transparent overlay that still catches clicks is
      // the kind of bug nobody thinks to look for.
      setTimeout(() => root.remove(), reduced ? 0 : 560);
    },

    fail(message) {
      if (raf) cancelAnimationFrame(raf);
      if (phaseLine) phaseLine.textContent = message;
      const why = document.getElementById('boot-why');
      // The screen stays up on failure. Fading to an empty dashboard would
      // hide the one sentence that says what went wrong.
      if (why) why.textContent = 'The dashboard needs the harvester to be reachable. Nothing below this screen would work without it.';
    },
  };
}
