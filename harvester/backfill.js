// Ninety-day NEM backfill. This is what makes the replay training possible, and
// without it "watch it learn" means staring at a static screen for a month.
//
// Source is Next_Day_Dispatch alone. Its UNIT_SOLUTION table carries actual
// output, dispatch target, availability, UIGF and the semi-dispatch cap flag
// together at 5-minute resolution, so one 8 MB file covers a whole day. The
// Dispatch_SCADA archive would need a 288-entry nested zip per day to reach the
// same actual-output series and would still be missing everything else.
//
// That substitution rests on INITIALMW being the same measurement as
// SCADAVALUE, which was checked rather than assumed: across the 479 DUIDs
// present in both sources for the interval stamped 2026-08-04 12:00, the mean
// absolute difference was 0.0000 MW.
//
// Each day is fetched, decompressed and filtered in memory. The uncompressed
// CSV is 122 MB and only the registry's DUIDs are wanted, so writing it to disk
// first would cost 11 GB across the backfill to no purpose.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAemo, parseAemoTimestamp } from './parse-aemo.js';
import { fetchBuffer, unzipSingle, listNemwebDir } from './fetch-util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', 'data');
const NEXT_DAY_DIR = 'https://nemweb.com.au/Reports/Current/Next_Day_Dispatch/';

// The columns actually used downstream. UNIT_SOLUTION v6 has 70 columns, almost
// all of them FCAS enablement figures irrelevant to a weather model, and
// carrying them would multiply the stored backfill for nothing.
const KEEP = [
  'SETTLEMENTDATE', 'DUID', 'INTERVENTION',
  'INITIALMW', 'TOTALCLEARED', 'AVAILABILITY', 'UIGF', 'SEMIDISPATCHCAP',
];

/**
 * Map the opaque filenames in the directory listing to the trading day they
 * cover. The trailing ID is an incrementing counter that cannot be predicted,
 * so the listing is the only way to find a given day's file.
 */
export async function listNextDayFiles() {
  const names = await listNemwebDir(NEXT_DAY_DIR, /PUBLIC_NEXT_DAY_DISPATCH_[0-9_]+\.zip/gi);
  const byDay = new Map();
  for (const name of names) {
    const m = /PUBLIC_NEXT_DAY_DISPATCH_(\d{8})_/.exec(name);
    if (!m) continue;
    const day = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
    // A day is occasionally republished; the highest ID is the current version.
    const prev = byDay.get(day);
    if (!prev || name > prev) byDay.set(day, name);
  }
  return byDay;
}

/**
 * Fetch one day and reduce it to the registry's DUIDs.
 *
 * INTERVENTION rows are the manual-intervention re-run of a dispatch interval.
 * Where both exist for one interval the intervention run is the binding one, so
 * taking rows indiscriminately silently double-counts every intervened interval.
 */
export async function fetchDay(fileName, duidSet) {
  const buf = await fetchBuffer(NEXT_DAY_DIR + fileName);
  const csv = unzipSingle(buf);
  const { tables } = parseAemo(csv, {
    validateCount: false,   // daily aggregate files carry no END OF REPORT footer
    tables: new Set(['DISPATCH.UNIT_SOLUTION']),
  });

  const table = tables.get('DISPATCH.UNIT_SOLUTION');
  if (!table) throw new Error(`No UNIT_SOLUTION table in ${fileName}`);

  const best = new Map();
  for (const r of table.rows) {
    if (!duidSet.has(r.DUID)) continue;
    const key = `${r.SETTLEMENTDATE}|${r.DUID}`;
    const prev = best.get(key);
    if (!prev || (r.INTERVENTION ?? 0) > (prev.INTERVENTION ?? 0)) best.set(key, r);
  }

  const rows = [];
  for (const r of best.values()) {
    const out = {};
    for (const c of KEEP) out[c] = r[c] ?? null;
    out.settlement_ms = parseAemoTimestamp(r.SETTLEMENTDATE);
    rows.push(out);
  }
  rows.sort((a, b) => a.settlement_ms - b.settlement_ms || (a.DUID < b.DUID ? -1 : 1));
  return rows;
}

export async function backfill({ days = 90, force = false } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  const duidSet = new Set(
    registry.stations.flatMap((s) => s.duids.map((d) => d.duid)),
  );
  const outDir = path.join(DATA_DIR, 'nem-dispatch');
  await fs.mkdir(outDir, { recursive: true });

  const byDay = await listNextDayFiles();
  const wanted = [...byDay.keys()].sort().slice(-days);

  console.log(`Backfilling ${wanted.length} days (${wanted[0]} .. ${wanted.at(-1)})`);
  console.log(`Filtering to ${duidSet.size} registered DUIDs across ${registry.stations.length} stations`);

  let fetched = 0, skipped = 0, failed = 0, totalRows = 0;
  for (const day of wanted) {
    const outPath = path.join(outDir, `${day}.json`);
    if (!force) {
      try { await fs.access(outPath); skipped++; continue; } catch { /* not cached */ }
    }
    try {
      const t0 = Date.now();
      const rows = await fetchDay(byDay.get(day), duidSet);
      await fs.writeFile(outPath, JSON.stringify({ day, rows }));
      totalRows += rows.length;
      fetched++;
      const intervals = new Set(rows.map((r) => r.settlement_ms)).size;
      console.log(
        `  ${day}  ${String(rows.length).padStart(7)} rows  ${String(intervals).padStart(3)} intervals  ${Date.now() - t0} ms`,
      );
      // 288 intervals is a complete day. Anything short is a real gap and the
      // dashboard has to show it rather than quietly interpolating over it.
      if (intervals !== 288) console.log(`    incomplete: ${intervals}/288 intervals`);
    } catch (err) {
      failed++;
      console.log(`  ${day}  FAILED: ${err.message}`);
    }
  }

  console.log(`\n${fetched} fetched, ${skipped} already cached, ${failed} failed, ${totalRows} rows written`);
  return { fetched, skipped, failed, totalRows, days: wanted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argIndex = process.argv.indexOf('--backfill');
  const days = argIndex >= 0 ? Number(process.argv[argIndex + 1]) || 90 : 90;
  await backfill({ days, force: process.argv.includes('--force') });
}
