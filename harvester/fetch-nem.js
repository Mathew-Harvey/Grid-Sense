// NEM ingest: poll Dispatch_SCADA for live output, pull a Next_Day_Dispatch
// file for everything the real-time feeds withhold.
//
// Filenames carry an opaque incrementing publication ID
// (PUBLIC_DISPATCHSCADA_202608062300_0000000531341929.zip) which cannot be
// derived from the interval, so a new file is found by listing the directory
// and comparing against the last one seen. The ID increases monotonically, so
// a lexical sort of the listing is a chronological sort.

import { parseAemo } from './parse-aemo.js';
import { fetchBuffer, unzipSingle, listNemwebDir } from './fetch-util.js';
import { listNextDayFiles } from './backfill.js';
import { normaliseNemScada, normaliseNemUnitSolution } from './normalise.js';

const SCADA_DIR = 'https://nemweb.com.au/Reports/Current/Dispatch_SCADA/';
const NEXT_DAY_DIR = 'https://nemweb.com.au/Reports/Current/Next_Day_Dispatch/';

/** Every Dispatch_SCADA file currently published, oldest first. */
export async function listScadaFiles() {
  return listNemwebDir(SCADA_DIR, /PUBLIC_DISPATCHSCADA_[0-9_]+\.zip/gi);
}

async function scadaRows(fileName) {
  const csv = unzipSingle(await fetchBuffer(SCADA_DIR + fileName));
  const { tables } = parseAemo(csv, { tables: new Set(['DISPATCH.UNIT_SCADA']) });
  const table = tables.get('DISPATCH.UNIT_SCADA');
  if (!table) throw new Error(`No UNIT_SCADA table in ${fileName}`);
  return table.rows;
}

/**
 * Fetch and normalise one Dispatch_SCADA file.
 *
 * @param {string} fileName as it appears in the directory listing
 * @param {{stations: object[]}} registry
 */
export async function fetchScada(fileName, registry) {
  return { file: fileName, ...normaliseNemScada(await scadaRows(fileName), registry) };
}

/**
 * Fetch every Dispatch_SCADA file published since the one named, newest last.
 *
 * All the new rows are normalised together so the ramp-rate check can see
 * across interval boundaries; normalising file by file would blind it to
 * exactly the sudden jumps it exists to catch.
 *
 * With no starting point only the newest file is taken. The directory holds
 * about two days of five-minute files and a cold start has no use for 500
 * intervals of history — that is what the Next_Day_Dispatch backfill is for.
 *
 * @param {{stations: object[]}} registry
 * @param {string|null} since filename returned by a previous poll
 */
export async function pollScada(registry, since = null) {
  const files = await listScadaFiles();
  const fresh = since ? files.filter((f) => f > since) : files.slice(-1);
  if (!fresh.length) return { files: [], latest: since, observations: [], unknown_units: [], counts: null };

  const rows = [];
  for (const f of fresh) rows.push(...await scadaRows(f));
  return { files: fresh, latest: fresh.at(-1), ...normaliseNemScada(rows, registry) };
}

/**
 * Fetch one Next_Day_Dispatch trading day and normalise its UNIT_SOLUTION
 * table.
 *
 * The file is 8 MB zipped and 122 MB as CSV against a small fixed disk
 * allowance, so it is decompressed, filtered to the registry's DUIDs and
 * discarded entirely in memory. The raw CSV never reaches disk.
 *
 * @param {string} day YYYY-MM-DD
 * @param {{stations: object[]}} registry
 */
export async function fetchNextDay(day, registry) {
  const byDay = await listNextDayFiles();
  const fileName = byDay.get(day);
  if (!fileName) throw new Error(`No Next_Day_Dispatch file published for ${day}`);

  const csv = unzipSingle(await fetchBuffer(NEXT_DAY_DIR + fileName));
  const { tables } = parseAemo(csv, {
    validateCount: false,   // daily aggregate files carry no END OF REPORT footer
    tables: new Set(['DISPATCH.UNIT_SOLUTION']),
  });
  const table = tables.get('DISPATCH.UNIT_SOLUTION');
  if (!table) throw new Error(`No UNIT_SOLUTION table in ${fileName}`);

  const duids = new Set(registry.stations.flatMap((s) => s.duids.map((d) => d.duid)));
  return { file: fileName, ...normaliseNemUnitSolution(bindingRuns(table.rows, duids), registry) };
}

/**
 * An intervened dispatch interval is published twice: the market run and the
 * intervention run that actually bound. Taking both doubles every intervened
 * interval, which looks like a plausible generation spike rather than an error.
 */
function bindingRuns(rows, duids) {
  const best = new Map();
  for (const r of rows) {
    if (!duids.has(r.DUID)) continue;
    const key = `${r.SETTLEMENTDATE}|${r.DUID}`;
    const prev = best.get(key);
    if (!prev || (r.INTERVENTION ?? 0) > (prev.INTERVENTION ?? 0)) best.set(key, r);
  }
  return [...best.values()];
}
