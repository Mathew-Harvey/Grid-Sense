// The default view: whole-of-market forecast against outcome.
//
// The conviction band is the centrepiece and everything else on this page is
// arranged so as not to compete with it. Price and revenue sit beneath it on the
// same time axis, because the question they answer — what is this worth — only
// makes sense once you have seen how much of the forecast to believe.

import { createConvictionBand, createExpertRibbon } from '../charts/conviction.js';
import { fueltechColour, FUELTECH_CODE } from '../charts/base.js';
import { intervalRevenue } from '../revenue.js';

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

      // The fleet cannot generate more than it is built to. Before the
      // aggregate conformal has calibrated, its upper band runs far past that,
      // and because the y-axis ranges over every series the whole chart then
      // scales to an impossible number — 17 GW of real generation ends up
      // squashed into the bottom eighth of the panel by a band edge that could
      // never happen. Clipping is what the interval always owed the reader; the
      // legibility is a consequence, not the reason.
      const ceiling = state.stats?.fleetCapacity > 0
        ? state.stats.fleetCapacity
        : Infinity;
      const pick = (lane, clip = false) => keep.map((i) => {
        const v = lane[i];
        if (!Number.isFinite(v)) return null;
        return clip ? Math.min(Math.max(v, 0), ceiling) : v;
      });

      band.update({
        t: keep.map((i) => f.t[i]),
        actual: pick(f.actual), forecast: pick(f.forecast),
        hi90: pick(f.hi90, true), lo90: pick(f.lo90, true),
        hi80: pick(f.hi80, true), lo80: pick(f.lo80, true),
        ghostHi: pick(f.ghostHi, true), ghostLo: pick(f.ghostLo, true),
      });

      // Weights exist only for scored history. The forward fan has no weights
      // yet — nothing has been scored at those instants — so indexing across the
      // whole series runs off the end of the array and turns the ribbon into a
      // wedge of NaN. The ribbon covers what has actually been learned from.
      const hist = Math.min(f.historyLength ?? 0, keep.length);
      if (f.weights && ctx.expertNames?.length && hist > 0) {
        const n = ctx.expertNames.length;
        const per = [];
        for (let e = 0; e < n; e++) {
          const lane = new Array(hist);
          for (let i = 0; i < hist; i++) {
            const v = f.weights[i * n + e];
            lane[i] = Number.isFinite(v) ? v : null;
          }
          per.push(lane);
        }
        ribbon.update(keep.slice(0, hist).map((i) => f.t[i]), per);
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

      // The fuel lanes cover scored history only, the same span as the weights.
      if (optional.fuelmix && f.byFuel && hist > 0) {
        const mix = {};
        for (const [ft, lane] of Object.entries(f.byFuel)) {
          mix[ft] = Array.from(lane.subarray(0, hist), (v) => (Number.isFinite(v) ? v : null));
        }
        optional.fuelmix.update(keep.slice(0, hist).map((i) => f.t[i]), mix);
        el('fuelmix-note').textContent = `${Object.keys(mix).length} fuels, modelled fleet only`;
      }

      if (optional.price && state.priceByMs?.size) {
        const times = keep.map((i) => f.t[i]);
        // Frame timestamps are seconds; the price index is keyed in
        // milliseconds, on the same five-minute grid.
        const rrp = times.map((sec) => {
          const v = state.priceByMs.get(sec * 1000);
          return Number.isFinite(v) ? v : null;
        });
        optional.price.overlay.update(times, rrp);

        // Revenue is the fleet's actual output valued at that price, over a
        // five-minute interval — not MW times price, which is twelve times too
        // large and still looks like money.
        const revenue = times.map((_, k) => {
          const mw = f.actual[keep[k]];
          const price = rrp[k];
          return Number.isFinite(mw) && Number.isFinite(price)
            ? intervalRevenue({ outputMw: mw, rrp: price })
            : 0;
        });
        optional.price.ribbon.update(times, revenue);
        el('conviction-note').textContent =
          `Price is the mean across ${state.priceRegions} NEM regions; revenue values the modelled fleet at it.`;
      } else if (optional.price) {
        el('conviction-note').textContent =
          'Price overlay is waiting on the price backfill — run harvester/backfill-price.js.';
      }

      // Actual and share only. The replay calibrates one aggregate band for the
      // whole fleet, so there is no per-region forecast or per-region skill to
      // report — and apportioning the fleet's score across regions would put a
      // number in the column that looks measured and is not.
      const regions = el('region-table').querySelector('tbody');
      const names = f.regions ?? [];
      const total = names.reduce((a, r) => a + (f.regionNow?.[r] || 0), 0);
      regions.innerHTML = names.map((r) => {
        const actual = f.regionNow?.[r];
        const share = total > 0 && Number.isFinite(actual) ? (100 * actual) / total : NaN;
        return `<tr><td>${r}</td><td>${gw(actual)}</td>` +
          `<td>${Number.isFinite(share) ? share.toFixed(1) + '%' : '—'}</td></tr>`;
      }).join('')
        || '<tr><td colspan="3">Regional totals appear once the replay has scored an interval.</td></tr>';

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
