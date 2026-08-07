// Regional demand and interconnector flow — the two things the map is about.
//
// Neither is in `Next_Day_Dispatch`, which carries only unit-level tables. Both
// are in the five-minute `DispatchIS` files, and those are archived one day per
// zip: 288 nested zips inside each, which is why nothing else in this project
// touches them. For six interconnectors and five regions it is worth it, because
// there is no cheaper public source for either at dispatch resolution.
//
// What this makes honest: TOTALDEMAND is measured consumption per region, not
// generation summed up, and MWFLOW is the actual power crossing each
// interconnector with a sign. A map drawn from these is showing what happened
// rather than an inference from what was generated.
//
// Western Australia appears in neither, and never will: the SWIS has no
// interconnector to the eastern grid and its demand is published on its own
// feed. The map states that rather than leaving WA looking like a gap.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAemo, parseAemoTimestamp } from './parse-aemo.js';
import { fetchBuffer, unzipSingle, unzipAll } from './fetch-util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'data', 'flows');
const ARCHIVE = 'https://nemweb.com.au/Reports/Archive/DispatchIS_Reports/';
// Western Australia publishes its own operational demand, already in megawatts
// rather than the MWh-per-interval its SCADA feed uses. Merged into the same
// per-interval record so the map has one shape to read, never summed with the
// NEM's: they are separate grids and a combined "national demand" would be a
// number describing nothing.
const WEM_DEMAND = 'https://data.wa.aemo.com.au/public/market-data/wemde/operationalDemandWithdrawal/dailyFiles/';

/** Daily bundles the archive currently offers, newest last. */
export async function listArchiveDays() {
  const html = new TextDecoder().decode(await fetchBuffer(ARCHIVE));
  const days = new Map();
  for (const m of html.matchAll(/PUBLIC_DISPATCHIS_(\d{4})(\d{2})(\d{2})\.zip/g)) {
    days.set(`${m[1]}-${m[2]}-${m[3]}`, m[0]);
  }
  return days;
}

/**
 * Reduce one day's 288 dispatch files to per-interval demand and flow.
 *
 * An intervened interval is republished alongside the original run; the
 * intervention is the binding one, so it replaces rather than adds.
 */
export function foldDay(texts) {
  const byInterval = new Map();

  const WANTED = new Set(['DISPATCH.REGIONSUM', 'DISPATCH.INTERCONNECTORRES']);

  for (const text of texts) {
    const { tables } = parseAemo(text, { tables: WANTED });
    const rows = [
      ...(tables.get('DISPATCH.REGIONSUM')?.rows ?? []).map((r) => ({ r, isRegion: true })),
      ...(tables.get('DISPATCH.INTERCONNECTORRES')?.rows ?? []).map((r) => ({ r, isRegion: false })),
    ];
    for (const { r: row, isRegion } of rows) {
      const ms = parseAemoTimestamp(row.SETTLEMENTDATE, 10);
      let cell = byInterval.get(ms);
      if (!cell) byInterval.set(ms, (cell = { demand: {}, flow: {}, intervened: false }));

      const intervention = Number(row.INTERVENTION) === 1;
      if (cell.intervened && !intervention) continue;
      if (intervention && !cell.intervened) {
        cell.demand = {};
        cell.flow = {};
        cell.intervened = true;
      }

      if (isRegion) {
        const mw = Number(row.TOTALDEMAND);
        if (Number.isFinite(mw)) cell.demand[row.REGIONID] = Math.round(mw * 10) / 10;
      } else {
        const mw = Number(row.MWFLOW);
        if (Number.isFinite(mw)) cell.flow[row.INTERCONNECTORID] = Math.round(mw * 10) / 10;
      }
    }
  }

  return [...byInterval.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, c]) => ({ at: ms, demand: c.demand, flow: c.flow }));
}

export async function run({ days = 21, force = false } = {}) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const archive = await listArchiveDays();
  const wanted = [...archive.keys()].sort().slice(-days);
  console.log(`Flows backfill: ${wanted.length} days (${wanted[0]} .. ${wanted.at(-1)})`);

  let fetched = 0, skipped = 0, failed = 0;
  for (const iso of wanted) {
    const outPath = path.join(OUT_DIR, `${iso}.json`);
    if (!force) {
      try { await fs.access(outPath); skipped++; continue; } catch { /* not cached */ }
    }
    try {
      const t0 = Date.now();
      const outer = await fetchBuffer(ARCHIVE + archive.get(iso));
      // Each entry is itself a zip holding one dispatch run.
      const texts = unzipAll(outer).map(([, buf]) => unzipSingle(buf));
      const intervals = foldDay(texts);

      // Best effort: a missing WA day leaves the SWIS floor unlit rather than
      // failing the whole record.
      try {
        const wa = JSON.parse(new TextDecoder().decode(
          await fetchBuffer(`${WEM_DEMAND}OperationalDemandAndWithdrawal_${iso}.json`)));
        const byMs = new Map();
        for (const r of wa?.data?.data ?? []) {
          const ms = Date.parse(r.dispatchInterval);
          if (Number.isFinite(ms) && Number.isFinite(r.operationalDemand)) {
            byMs.set(ms, Math.round(r.operationalDemand * 10) / 10);
          }
        }
        for (const cell of intervals) {
          const mw = byMs.get(cell.at);
          if (mw !== undefined) cell.demand.SWIS = mw;
        }
      } catch { /* WA demand is optional */ }
      await fs.writeFile(outPath, JSON.stringify({ day: iso, intervals }));
      fetched++;
      const regions = new Set(intervals.flatMap((i) => Object.keys(i.demand))).size;
      const links = new Set(intervals.flatMap((i) => Object.keys(i.flow))).size;
      console.log(`  ${iso}  ${String(intervals.length).padStart(3)} intervals  ` +
        `${regions} regions  ${links} interconnectors  ${Date.now() - t0} ms`);
    } catch (err) {
      failed++;
      console.log(`  ${iso}  FAILED: ${err.message}`);
    }
  }

  console.log(`\n${fetched} fetched, ${skipped} cached, ${failed} failed`);
  return { fetched, skipped, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) || 21 : 21;
  await run({ days, force: process.argv.includes('--force') });
}
