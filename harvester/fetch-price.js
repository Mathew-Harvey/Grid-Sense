// Regional prices from DispatchIS.
//
// DispatchIS is the only public real-time file that carries the settled price.
// Its DISPATCH.PRICE table holds one row per region per 5-minute interval: the
// energy price (RRP) plus the ten FCAS service prices, all in $/MWh.
//
// Two properties of this table decide whether every revenue figure built on it
// is right or merely plausible.
//
// The first is the intervention re-run. When AEMO intervenes in a dispatch
// interval — a direction, a reserve contract — the interval is published twice,
// once as the market would have cleared it and once as it actually settled.
// Both rows carry the same settlement stamp and the same region, so a reader
// that takes the table as it comes gets two prices for one interval and averages
// them into a number that is wrong by an amount nobody can see.
//
// The second is alignment. A price belongs to the END of its interval, the same
// instant as TOTALCLEARED, and five minutes after the SCADAVALUE that shares its
// stamp. Multiply a price series against a dispatch series aligned by the other
// convention and every revenue figure shifts by one interval — still smooth,
// still the right order of magnitude, still completely wrong.
//
// RRP is signed and it is not bounded by anything reassuring: it goes to
// -$1,000/MWh when the grid is paying to shed generation and to $17,500/MWh when
// it is short. Nothing here clamps, floors or sanitises it. A negative price is
// the single most informative event in this market and a defensive Math.max
// would erase it.

import { parseAemo, parseAemoTimestamp } from './parse-aemo.js';
import { fetchBuffer, unzipSingle, listNemwebDir } from './fetch-util.js';
import { observedAt } from '../app/js/align.js';

const DISPATCHIS_DIR = 'https://nemweb.com.au/Reports/Current/DispatchIS_Reports/';

/**
 * The price columns carried forward, AEMO column to stored key.
 *
 * DISPATCH.PRICE v5 has 70 columns. Most are the ROP twins (the price before the
 * cap was applied), the per-service APC flags, and the CUMUL_PRE_AP_* running
 * totals AEMO uses to decide when the cumulative price threshold has been
 * breached. None of them are what a generator is paid, and carrying them would
 * multiply the stored backfill for nothing.
 *
 * Every value here is $/MWh. FCAS regulation and contingency prices are quoted
 * per MW of enablement rather than per MWh of energy, so they cannot be added to
 * RRP — they are carried so an FCAS revenue stack can be built beside the energy
 * one, never on top of it.
 *
 * @type {Object<string, string>}
 */
export const PRICE_FIELDS = {
  RRP: 'rrp',
  RAISE1SECRRP: 'raise_1sec_rrp',
  RAISE6SECRRP: 'raise_6sec_rrp',
  RAISE60SECRRP: 'raise_60sec_rrp',
  RAISE5MINRRP: 'raise_5min_rrp',
  RAISEREGRRP: 'raise_reg_rrp',
  LOWER1SECRRP: 'lower_1sec_rrp',
  LOWER6SECRRP: 'lower_6sec_rrp',
  LOWER60SECRRP: 'lower_60sec_rrp',
  LOWER5MINRRP: 'lower_5min_rrp',
  LOWERREGRRP: 'lower_reg_rrp',
};

/** Market price cap, $/MWh. */
export const MARKET_PRICE_CAP = 17_500;

/** Market price floor, $/MWh. */
export const MARKET_PRICE_FLOOR = -1000;

// A price is the clearing outcome for the interval that ENDS at its settlement
// stamp — the same convention as TOTALCLEARED, which is the series it will be
// multiplied by. Borrowing that field's shift rather than restating it keeps the
// two on one definition instead of two that merely agree today.
const PRICE_ALIGNMENT_FIELD = 'TOTALCLEARED';

/**
 * The instant a regional price refers to.
 *
 * @param {number} settlementMs UTC epoch ms of SETTLEMENTDATE
 * @returns {number} UTC epoch ms
 */
export function priceObservedAt(settlementMs) {
  return observedAt(settlementMs, PRICE_ALIGNMENT_FIELD);
}

/**
 * Where both runs of an intervened interval exist, keep the one that settled.
 *
 * INTERVENTION=1 is the re-run that bound; INTERVENTION=0 is the counterfactual
 * market run published alongside it. Keyed by interval and region, so the five
 * regions of an interval all survive and only the duplicate run is dropped.
 */
function bindingRuns(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = `${r.SETTLEMENTDATE}|${r.REGIONID}`;
    const prev = best.get(key);
    if (!prev || (r.INTERVENTION ?? 0) > (prev.INTERVENTION ?? 0)) best.set(key, r);
  }
  return [...best.values()];
}

function priceRow(r) {
  const settlementMs = parseAemoTimestamp(r.SETTLEMENTDATE);
  if (settlementMs === null) {
    throw new Error(`Unparseable price settlement stamp ${JSON.stringify(r.SETTLEMENTDATE)}`);
  }
  // A price row without a price is not a gap to be filled in later, it is a
  // corrupt file. Left as null it would multiply out to NaN somewhere far
  // downstream, where the cause is unrecoverable.
  if (!Number.isFinite(r.RRP)) {
    throw new Error(`No RRP for ${r.REGIONID} at ${r.SETTLEMENTDATE}: DISPATCH.PRICE row is incomplete`);
  }

  const row = {
    settlement_ms: settlementMs,
    observed_at: priceObservedAt(settlementMs),
    region: r.REGIONID,
    intervention: r.INTERVENTION ?? 0,
    apc_flag: r.APCFLAG ?? 0,
    market_suspended_flag: r.MARKETSUSPENDEDFLAG ?? 0,
    // A price outside the market band is carried at its published value and
    // marked, never corrected. It means either a genuine administered-pricing
    // event or that the indexed cap has moved past the figure assumed here, and
    // both are things to be looked at rather than smoothed away.
    out_of_band: r.RRP > MARKET_PRICE_CAP || r.RRP < MARKET_PRICE_FLOOR,
  };
  for (const [column, key] of Object.entries(PRICE_FIELDS)) row[key] = r[column] ?? null;
  return row;
}

/**
 * Parse the DISPATCH.PRICE table out of one DispatchIS report.
 *
 * @param {string} csvText full contents of an unzipped DispatchIS file
 * @returns {object[]} one row per region per interval, ascending by interval then region
 */
export function parsePriceTable(csvText) {
  const { tables } = parseAemo(csvText, { tables: new Set(['DISPATCH.PRICE']) });
  const table = tables.get('DISPATCH.PRICE');
  if (!table) throw new Error('No DISPATCH.PRICE table in DispatchIS report');

  const rows = bindingRuns(table.rows).map(priceRow);
  rows.sort((a, b) => a.settlement_ms - b.settlement_ms || (a.region < b.region ? -1 : 1));
  return rows;
}

/** Every DispatchIS file currently published, oldest first. */
export async function listDispatchIsFiles() {
  return listNemwebDir(DISPATCHIS_DIR, /PUBLIC_DISPATCHIS_[0-9_]+\.zip/gi);
}

/**
 * Regional prices for the newest published dispatch interval.
 *
 * The trailing publication ID in a DispatchIS filename increases monotonically,
 * so a lexical sort of the directory listing is a chronological one and the last
 * entry is the newest interval.
 *
 * @returns {Promise<{stamp: string, settlementMs: number, regions: Object<string, object>}>}
 *   stamp is the source filename, which is what tells a poller whether it has
 *   already seen this interval; settlementMs is the interval-ending instant.
 */
export async function fetchLatestPrices() {
  const files = await listDispatchIsFiles();
  if (!files.length) throw new Error(`No DispatchIS files listed at ${DISPATCHIS_DIR}`);

  const stamp = files.at(-1);
  const rows = parsePriceTable(unzipSingle(await fetchBuffer(DISPATCHIS_DIR + stamp)));
  if (!rows.length) throw new Error(`No price rows in ${stamp}`);

  // One live file is one dispatch interval. If that ever stops holding, the
  // per-region map below would silently keep whichever row happened to be last.
  const settlementMs = rows[0].settlement_ms;
  const spans = rows.find((r) => r.settlement_ms !== settlementMs);
  if (spans) {
    throw new Error(`${stamp} spans more than one interval: ${settlementMs} and ${spans.settlement_ms}`);
  }

  const regions = {};
  for (const row of rows) regions[row.region] = row;
  return { stamp, settlementMs, regions };
}
