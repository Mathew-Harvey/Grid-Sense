// WEM ingest. One JSON file per trading day, appended to as the day runs, so
// every poll re-downloads the whole day and the intervals already ingested are
// dropped before normalising rather than emitted again.
//
// The trading day runs 08:00 to 07:55 AWST, which is why current/ can briefly
// hold two files: the day that just closed and the one that has just opened.
// Both are read on every poll so the rollover does not swallow the tail of the
// closing day.
//
// quantity is MWh per five-minute interval; the conversion to MW happens in
// normalise.js and nowhere else.

import { fetchBuffer, listNemwebDir } from './fetch-util.js';
import { normaliseWem } from './normalise.js';

const WEM_DIR = 'https://data.wa.aemo.com.au/public/market-data/wemde/facilityScada/current/';

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
 * Fetch every published trading day and normalise the intervals newer than the
 * last one seen.
 *
 * @param {{stations: object[]}} registry
 * @param {number|null} since UTC epoch ms of the newest interval already held
 */
export async function pollWem(registry, since = null) {
  const days = await listWemDays();
  const intervals = [];
  for (const day of days) {
    for (const r of (await fetchDay(day)).data.facilityScadaDispatchIntervals) {
      // The offset is explicit in the timestamp, so this needs no timezone rule.
      if (since == null || Date.parse(r.dispatchInterval) > since) intervals.push(r);
    }
  }
  return {
    days,
    ...normaliseWem({ data: { facilityScadaDispatchIntervals: intervals } }, registry),
  };
}
