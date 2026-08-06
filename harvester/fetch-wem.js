// WEM ingest. One JSON file per trading day, appended to as the day runs, so
// every poll re-downloads the whole day and the intervals already ingested are
// dropped rather than emitted again — after normalising, not before, so the
// quality checks that compare an interval against its predecessor still have
// one to look at.
//
// The trading day runs 08:00 to 07:55 AWST, which is why current/ can briefly
// hold two files: the day that just closed and the one that has just opened.
// Both are read on every poll so the rollover does not swallow the tail of the
// closing day.
//
// quantity is MWh per five-minute interval; the conversion to MW happens in
// normalise.js and nowhere else.

import { fetchBuffer, listNemwebDir } from './fetch-util.js';
import { normaliseWem, parseWemTimestamp } from './normalise.js';

const WEM_DIR = 'https://data.wa.aemo.com.au/public/market-data/wemde/facilityScada/current/';
const INTERVAL_MS = 5 * 60_000;

/** Trading days currently published, e.g. ['2026-08-05']. */
export async function listWemDays() {
  const files = await listNemwebDir(WEM_DIR, /SCADA_\d{4}-\d{2}-\d{2}\.json/gi);
  return files.map((f) => f.slice('SCADA_'.length, -'.json'.length));
}

async function fetchDay(day) {
  const buf = await fetchBuffer(`${WEM_DIR}SCADA_${day}.json`);
  return JSON.parse(buf.toString('utf8'));
}

/**
 * Fetch and normalise one WEM trading day.
 *
 * @param {string} day YYYY-MM-DD, the AWST date the trading day opens on
 * @param {{stations: object[]}} registry
 */
export async function fetchWemDay(day, registry) {
  return { day, ...normaliseWem(await fetchDay(day), registry) };
}

/**
 * Select the intervals a poll should normalise, and drop the context afterwards.
 *
 * One already-ingested interval is deliberately re-normalised as context and
 * then discarded. A steady-state poll finds a single new interval per facility,
 * and the ramp check needs the preceding value to compare against — handing
 * normalise a batch one interval deep leaves it nothing to compare, so the
 * validator would never fire on WEM at all while appearing to be in force.
 *
 * Counts are recomputed after the context is dropped so they keep describing
 * exactly the observations handed back.
 *
 * Kept free of the network so the boundary behaviour is testable without one.
 *
 * @param {object[]} dayFiles parsed SCADA_YYYY-MM-DD.json payloads
 * @param {{stations: object[]}} registry
 * @param {number|null} since UTC epoch ms of the newest interval already held
 */
export function pollWindow(dayFiles, registry, since = null) {
  const intervals = [];
  for (const file of dayFiles) {
    for (const r of file.data.facilityScadaDispatchIntervals) {
      if (since == null || parseWemTimestamp(r.dispatchInterval) > since - INTERVAL_MS) {
        intervals.push(r);
      }
    }
  }

  const result = normaliseWem({ data: { facilityScadaDispatchIntervals: intervals } }, registry);
  if (since == null) return result;

  const observations = result.observations.filter((o) => o.observed_at > since);
  const counts = {
    observations: observations.length,
    ok: 0,
    partial: 0,
    suspect: 0,
    unknown_units: result.counts.unknown_units,
  };
  for (const o of observations) counts[o.quality]++;
  return { observations, unknown_units: result.unknown_units, counts };
}

/**
 * Fetch every published trading day and normalise the intervals newer than the
 * last one seen.
 *
 * @param {{stations: object[]}} registry
 * @param {number|null} since UTC epoch ms of the newest interval already held
 */
export async function pollWem(registry, since = null) {
  const days = await listWemDays();
  const dayFiles = [];
  for (const day of days) dayFiles.push(await fetchDay(day));
  return { days, ...pollWindow(dayFiles, registry, since) };
}
