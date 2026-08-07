// The training monitor: watch the thing learn, and check that it is learning
// rather than merely moving.
//
// The rolling-CRPS panel is the one that earns its place. It draws each expert
// alongside the combination, so you can see the ensemble beating its own best
// member — which is the entire claim the combiner makes, and the only place on
// the page where that claim is falsifiable.

import { FUELTECH_CODE } from '../charts/base.js';

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function mount(root, ctx) {
  const el = (id) => root.querySelector(`#${id}`);

  const transport = el('replay-transport');
  transport.innerHTML = `
    <div class="transport">
      <button type="button" id="replay-play" aria-label="Play replay">Play</button>
      <button type="button" id="replay-pause" aria-label="Pause replay">Pause</button>
      <label for="replay-rate">Speed</label>
      <input type="range" id="replay-rate" min="50" max="2000" step="50" value="500"
             aria-label="Replay speed in intervals per second">
      <output id="replay-rate-out">500/s</output>
      <label for="replay-scrub">Position</label>
      <input type="range" id="replay-scrub" min="0" max="100" value="0" aria-label="Replay position">
      <output id="replay-position">—</output>
    </div>`;

  el('replay-play').addEventListener('click', () => ctx.control('play'));
  el('replay-pause').addEventListener('click', () => ctx.control('pause'));
  el('replay-rate').addEventListener('input', (e) => {
    el('replay-rate-out').textContent = `${e.target.value}/s`;
    ctx.control('rate', { rate: Number(e.target.value) });
  });
  el('replay-scrub').addEventListener('change', (e) => {
    const steps = ctx.state.steps ?? 0;
    ctx.control('seek', { index: Math.round((Number(e.target.value) / 100) * steps) });
  });

  let sortKey = '1h';
  let sortDir = -1;

  return {
    update(state) {
      const s = state.stats ?? {};
      const cursor = s.cursor ?? 0;
      const steps = s.steps ?? 0;

      el('replay-note').textContent = steps
        ? `${cursor.toLocaleString()} of ${steps.toLocaleString()} intervals · ${Math.round(s.ratePerSecond ?? 0)}/s · ${Math.round(s.scoredIntervals ?? 0).toLocaleString()} scored · ${Math.round(s.curtailedIntervals ?? 0).toLocaleString()} curtailed and excluded`
        : 'Replay has not started.';
      el('replay-position').textContent = steps ? `${((cursor / steps) * 100).toFixed(0)}%` : '—';
      const scrub = el('replay-scrub');
      if (document.activeElement !== scrub && steps) scrub.value = String((cursor / steps) * 100);

      const rows = state.stationRows ?? [];
      const horizons = (ctx.horizons ?? []).map((h) => h.label);

      const thead = el('skill-matrix').querySelector('thead');
      thead.innerHTML = `<tr><th>Station</th><th>Fuel</th><th>MW</th>` +
        horizons.map((h) => `<th><button type="button" data-h="${h}" class="sort">${h}</button></th>`).join('') + '</tr>';
      thead.querySelectorAll('button.sort').forEach((b) => b.addEventListener('click', () => {
        const h = b.dataset.h;
        sortDir = sortKey === h ? -sortDir : -1;
        sortKey = h;
        ctx.requestRender?.();
      }));

      const skillOf = (r, h) => r.horizons?.find((x) => x.horizon === h)?.skill;
      const sorted = [...rows].sort((a, b) => {
        const av = skillOf(a, sortKey), bv = skillOf(b, sortKey);
        if (!Number.isFinite(av)) return 1;
        if (!Number.isFinite(bv)) return -1;
        return sortDir * (av - bv);
      });

      el('skill-matrix').querySelector('tbody').innerHTML = sorted.map((r) => `
        <tr><td>${r.station_name}</td><td>${FUELTECH_CODE[r.fueltech] ?? r.fueltech}</td><td>${Math.round(r.capacity_mw)}</td>` +
        horizons.map((h) => {
          const v = skillOf(r, h);
          return `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${fmt(v)}</td>`;
        }).join('') + '</tr>').join('')
        || '<tr><td colspan="8">No station has been scored yet.</td></tr>';

      const f = state.frame;
      if (f?.expertCrps && ctx.expertNames?.length) {
        const n = ctx.expertNames.length;
        const last = f.expertCrps.slice(-n);
        const combined = f.crpsModel?.[f.crpsModel.length - 1];
        const best = Math.min(...last.filter(Number.isFinite));
        el('expert-crps').innerHTML =
          `<table><thead><tr><th>Expert</th><th>Rolling CRPS</th></tr></thead><tbody>` +
          ctx.expertNames.map((nm, i) =>
            `<tr><td>${nm}</td><td>${fmt(last[i], 2)}</td></tr>`).join('') +
          `<tr><td><strong>combined</strong></td><td><strong>${fmt(combined, 2)}</strong></td></tr>` +
          `</tbody></table>` +
          (Number.isFinite(combined) && Number.isFinite(best)
            ? `<p class="state-msg">${combined <= best
              ? 'The combination is at or ahead of its best single expert.'
              : 'The combination is behind its best single expert — the mixture has not converged.'}</p>`
            : '');
      }

      const cov = el('coverage-chart');
      cov.innerHTML = (ctx.horizons ?? []).map((h) => {
        const c90 = s[`fleet.${h.label}.cov90`];
        const c80 = s[`fleet.${h.label}.cov80`];
        const off90 = Number.isFinite(c90) ? Math.abs(c90 * 100 - 90) : NaN;
        return `<div class="cov-row"><span>${h.label}</span>` +
          `<span class="${off90 > 3 ? 'warn' : ''}">${Number.isFinite(c90) ? (c90 * 100).toFixed(1) : '—'}% / 90</span>` +
          `<span>${Number.isFinite(c80) ? (c80 * 100).toFixed(1) : '—'}% / 80</span></div>`;
      }).join('');
    },
    // Every panel in this view is a table, so there is nothing to re-measure.
    resize() {},
    destroy() {},
  };
}
