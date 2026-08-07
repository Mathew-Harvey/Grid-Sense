// Western Australia's five-minute feed.
//
// FLAGS F18 recorded that the WEM publishes trading days rather than intervals,
// on the basis that `facilityScada/current/` held only the day that had already
// closed. That is true of `facilityScada`, and it is not true of the WEM: the
// dispatch engine publishes `ReferenceDispatchSolution_YYYYMMDDHHMM.json` every
// five minutes, about three minutes after the interval it describes. F18 is
// corrected rather than quietly amended, for the same reason F4 was.
//
// Two things in it that the facilityScada feed does not carry:
//
//   initialMw per facility — output at the interval's start, exactly the
//   quantity the NEM's INITIALMW carries, so it aligns through the same rule.
//
//   dispatchCap per facility — a constrained facility's ceiling in MW. This is
//   Western Australia's semi-dispatch cap, and its absence was the stated
//   reason WA carried an unknown curtailment mask. Live WA no longer has to.
//
// The cost is the reason this is a separate module with its own switch. The
// file is about 30 MB, served uncompressed, and `current/` holds exactly one —
// there is no catching up on a missed interval. Polling it fully is roughly
// 8.6 GB a day of downloads and a 30 MB JSON.parse every five minutes, which is
// not free on a small instance. `GRIDSENSE_WA_LIVE=0` turns it off and leaves
// the daily catch-up, which costs one file a day.

import { fetchBuffer, listNemwebDir } from './fetch-util.js';
import { observedAt } from '../app/js/align.js';
import { wemQuantityToMw } from './wem-registry.js';

const DIR = 'https://data.wa.aemo.com.au/public/market-data/wemde/dispatchSolution/dispatchData/current/';

/** Live dispatch solutions currently published, oldest last. */
export async function listSolutions() {
  return listNemwebDir(DIR, /ReferenceDispatchSolution_\d{12}\.json/gi);
}

/**
 * The binding run for the interval a solution file describes.
 *
 * `solutionData` carries the current interval first and then the forward
 * projections the engine solved alongside it — twenty-three intervals that have
 * not happened. Only the first is a measurement; treating the rest as
 * observations would fill the store with AEMO's forecast and score the model
 * against it.
 */
export function bindingRun(body) {
  const runs = body?.data?.solutionData;
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const primary = body.data.primaryDispatchInterval;
  return runs.find((r) => r.dispatchInterval === primary) ?? runs[0];
}

/**
 * Fold one solution into per-station observations.
 *
 * @param {object} body the parsed solution file
 * @param {{facilityToStation: Map, capacityOf: Map}} maps from stationMaps()
 * @returns {{at: number, observations: object[]}|null}
 */
export function foldSolution(body, maps) {
  const run = bindingRun(body);
  if (!run) return null;

  const settlementMs = Date.parse(run.dispatchInterval);
  if (!Number.isFinite(settlementMs)) return null;

  const caps = new Map();
  for (const c of run.dispatchCaps ?? []) {
    if (Number.isFinite(c.dispatchCap)) caps.set(c.facilityCode, c.dispatchCap);
  }

  const byStation = new Map();
  for (const f of run.facilityScheduleDetails ?? []) {
    const stationId = maps.facilityToStation.get(f.facilityCode);
    if (!stationId || !Number.isFinite(f.initialMw)) continue;

    let cell = byStation.get(stationId);
    if (!cell) byStation.set(stationId, (cell = { mw: 0, facilities: 0, capped: false, capMw: 0 }));
    cell.mw += f.initialMw;
    cell.facilities++;
    // A facility appearing in dispatchCaps is one the engine is holding below
    // what it offered. That is the same event the NEM flags with
    // SEMIDISPATCHCAP, and it is what excludes an interval from every fit.
    const cap = caps.get(f.facilityCode);
    if (cap !== undefined) { cell.capped = true; cell.capMw += cap; }
  }

  const observations = [];
  for (const [stationId, cell] of byStation) {
    observations.push({
      station_id: stationId,
      // initialMw describes the interval's start, five minutes before the
      // timestamp on the row — the same convention as the NEM's INITIALMW, so
      // it goes through the same alignment rule rather than a second one.
      observed_at: observedAt(settlementMs, 'INITIALMW'),
      output_mw: Math.round(cell.mw * 1000) / 1000,
      uigf_mw: null,
      cleared_mw: null,
      available_mw: null,
      curtailed_mw: 0,
      capped: cell.capped,
      quality: 'ok',
      units_online: cell.facilities,
    });
  }
  return { at: observedAt(settlementMs, 'INITIALMW'), settlement_ms: settlementMs, observations };
}

/**
 * Fetch and fold every solution published since the one named.
 *
 * @param {{facilityToStation: Map, capacityOf: Map}} maps
 * @param {string|null} since filename returned by a previous poll
 */
export async function pollSolutions(maps, since = null) {
  const files = await listSolutions();
  // With no starting point, only the newest. There is no history to catch up
  // on here — the directory holds one file — and a cold start has the daily
  // facilityScada ingest behind it for everything older.
  const fresh = since ? files.filter((f) => f > since) : files.slice(-1);
  if (!fresh.length) return { latest: since, intervals: [] };

  const intervals = [];
  for (const name of fresh) {
    const body = JSON.parse(new TextDecoder().decode(await fetchBuffer(DIR + name)));
    const folded = foldSolution(body, maps);
    if (folded) intervals.push({ ...folded, source: name });
  }
  return { latest: fresh.at(-1), intervals };
}

// Re-exported so a caller converting facilityScada quantities and a caller
// reading dispatch-solution megawatts reach for the same named conversion
// rather than one of them inventing a factor of twelve.
export { wemQuantityToMw };
