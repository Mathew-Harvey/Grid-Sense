// The default view: whole-of-market forecast against outcome.
//
// The conviction band is the centrepiece and everything else on this page is
// arranged so as not to compete with it. Price and revenue sit beneath it on the
// same time axis, because the question they answer — what is this worth — only
// makes sense once you have seen how much of the forecast to believe.

import { createConvictionBand, createExpertRibbon } from '../charts/conviction.js';
import { fueltechColour, FUELTECH_CODE } from '../charts/base.js';

const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const gw = (mw) => (Number.isFinite(mw) ? (mw / 1000).toFixed(2) : '—');

/** Skill is the one number a reader is asked to trust, so it says which way is
 *  good in words rather than relying on the sign being understood. */
function skillCaption(skill) {
  if (!Number.isFinite(skill)) return 'Waiting for the first scored interval.';
  if (skill > 0) return `Beating a no-change forecast by ${(skill * 100).toFixed(0)}%. Above zero is better than assuming nothing changes.`;
  if (skill === 0) return 'Level with a no-change forecast.';
  return `Worse than assuming nothing changes, by ${(Math.abs(skill) * 100).toFixed(0)}%.`;
}

export function mount(root, ctx) {
  const el = (id) => root.querySelector(`#${id}`);
  const nowSec = () => ctx.state.nowSec ?? null;

  const band = createConvictionBand(el('conviction-band'), { getNowSec: nowSec });
  const ribbon = createExpertRibbon(el('expert-ribbon'), ctx.expertNames ?? [], { getNowSec: nowSec });

  // Charts owned by other modules load lazily: a missing one has to degrade to
  // an empty state, not take the page down with it.
  const optional = {};
  const lazy = async (key, path, factory) => {
    try {
      const mod = await import(path);
      optional[key] = factory(mod);
    } catch (err) {
      optional[key] = null;
      const host = el(key === 'fuelmix' ? 'fuel-mix' : 'price-overlay');
      if (host) host.innerHTML = `<p class="state-msg"><strong>Chart unavailable</strong>${err.message}</p>`;
    }
  };

  lazy('fuelmix', '../charts/fuelmix.js', (m) => m.createFuelMix(el('fuel-mix')));
  lazy('price', '../charts/pricelayer.js', (m) => ({
    overlay: m.createPriceOverlay(el('price-overlay'), { getNowSec: nowSec }),
    ribbon: m.createRevenueRibbon(el('revenue-ribbon')),
  }));

  return {
    update(state) {
      const f = state.frame;
      if (!f) return;

      // The forward fan reserves a slot per horizon and only fills the ones it
      // has issued, so trailing timestamps can still be zero. A zero epoch is
      // 1970, and one of those in the x-array stretches the axis across
      // fifty-six years and squeezes the entire band into a smudge at the left
      // edge — the chart looks broken when only one number is.
      const keep = [];
      for (let i = 0; i < f.t.length; i++) if (f.t[i] > 0) keep.push(i);
      const pick = (lane) => keep.map((i) => {
        const v = lane[i];
        return Number.isFinite(v) ? v : null;
      });

      band.update({
        t: keep.map((i) => f.t[i]),
        actual: pick(f.actual), forecast: pick(f.forecast),
        hi90: pick(f.hi90), lo90: pick(f.lo90),
        hi80: pick(f.hi80), lo80: pick(f.lo80),
        ghostHi: pick(f.ghostHi), ghostLo: pick(f.ghostLo),
      });

      if (f.weights && ctx.expertNames?.length) {
        const n = ctx.expertNames.length;
        const per = [];
        for (let e = 0; e < n; e++) {
          const lane = new Array(keep.length);
          for (let i = 0; i < keep.length; i++) lane[i] = f.weights[keep[i] * n + e];
          per.push(lane);
        }
        ribbon.update(keep.map((i) => f.t[i]), per);
      }

      const s = state.stats ?? {};
      const skill = s['fleet.1h.skill'];
      const value = el('skill-value');
      value.textContent = Number.isFinite(skill) ? skill.toFixed(3) : '—';
      value.className = `skill-value ${skill > 0 ? 'pos' : skill < 0 ? 'neg' : ''}`;
      el('skill-caption').textContent = skillCaption(skill);

      const tbody = el('skill-by-horizon').querySelector('tbody');
      tbody.innerHTML = (ctx.horizons ?? []).map((h) => {
        const sk = s[`fleet.${h.label}.skill`];
        const cr = s[`fleet.${h.label}.crps`];
        const cv = s[`fleet.${h.label}.cov90`];
        return `<tr><td>${h.label}</td>` +
          `<td class="${sk > 0 ? 'pos' : sk < 0 ? 'neg' : ''}">${fmt(sk, 3)}</td>` +
          `<td>${fmt(cr, 1)}</td><td>${Number.isFinite(cv) ? (cv * 100).toFixed(1) + '%' : '—'}</td></tr>`;
      }).join('');

      if (state.fuelMix && optional.fuelmix) optional.fuelmix.update(f.t, state.fuelMix);

      if (optional.price && state.prices?.rrp) {
        optional.price.overlay.update(f.t, state.prices.rrp);
        if (state.prices.revenue) optional.price.ribbon.update(f.t, state.prices.revenue);
      }

      const regions = el('region-table').querySelector('tbody');
      regions.innerHTML = (state.regions ?? []).map((r) => `
        <tr><td>${r.region}</td><td>${gw(r.actual)}</td><td>${gw(r.forecast)}</td>
        <td class="${r.skill > 0 ? 'pos' : ''}">${fmt(r.skill, 3)}</td></tr>`).join('')
        || '<tr><td colspan="4">Regional totals appear once the replay has scored an interval.</td></tr>';

      el('quality-strip').innerHTML = (state.quality ?? []).map((q) =>
        `<div><dt>${q.label}</dt><dd class="${q.warn ? 'warn' : ''}">${q.value}</dd></div>`).join('');
    },
    resize() {
      // A chart built while its panel was hidden measured zero and sized itself
      // from a fallback. Re-measuring is cheap and idempotent; tracking which
      // ones were hidden at construction is not.
      for (const entry of [band, ribbon, ...Object.values(optional)]) {
        if (!entry) continue;
        const charts = entry.plot ? [entry] : Object.values(entry);
        for (const c of charts) {
          const box = c?.plot?.root?.parentElement?.getBoundingClientRect?.();
          if (box && box.width > 0 && box.height > 0) {
            c.plot.setSize({ width: box.width, height: box.height });
          }
        }
      }
    },
    destroy() {
      band.destroy(); ribbon.destroy();
      optional.fuelmix?.destroy();
      optional.price?.overlay.destroy();
      optional.price?.ribbon.destroy();
    },
  };
}
