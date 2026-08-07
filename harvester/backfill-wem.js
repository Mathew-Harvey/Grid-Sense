// Western Australia's backfill.
//
// FLAGS F4 recorded that WEM had no usable history, on the basis that
// `facilityScada/previous/` was empty. It is not, and was not: that directory
// holds one zip per trading day from 29 September 2023 — 1,041 of them at the
// time of writing, nearly three years — while `current/` holds only the day in
// progress, which is what the original check must have looked at. The error
// cost Western Australia its place in the dashboard, so this file exists and
// F4 is corrected rather than quietly amended.
//
// Two differences from the NEM backfill matter, and both are stated in the
// output rather than hidden:
//
//   Units. `quantity` is MWh over the five-minute interval, not average MW,
//   post-reform as well as pre (F2). Conversion happens once, in a named
//   function, and never by inferring from magnitude.
//
//   Curtailment. The WEM SCADA feed publishes no equivalent of UIGF or the
//   semi-dispatch cap, so there is no way to know whether a WA farm was held
//   back. The NEM pipeline masks curtailed intervals out of every fit; for WA
//   that mask is unavailable, not false, and the rows carry `mask: 'none'` so
//   nothing downstream can mistake silence for permission.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBuffer, unzipSingle } from './fetch-util.js';
import { matchWemFacilities, wemQuantityToMw, wemIntervalMs } from './wem-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', 'data', 'wem-dispatch');
const ARCHIVE = 'https://data.wa.aemo.com.au/public/market-data/wemde/facilityScada/previous/';
const LIVE = 'https://data.wa.aemo.com.au/public/market-data/wemde/facilityScada/current/';

const INTERVALS_PER_DAY = 288;

/** The trading days the archive currently offers, newest last. */
export async function listArchiveDays() {
  const html = new TextDecoder().decode(await fetchBuffer(ARCHIVE));
  const days = new Map();
  for (const m of html.matchAll(/FacilityScada_(\d{4})(\d{2})(\d{2})\.zip/g)) {
    days.set(`${m[1]}-${m[2]}-${m[3]}`, m[0]);
  }
  return days;
}

/** Facility rows for one day, from either the archive zip or the live JSON. */
export async function fetchDay(iso, fileName) {
  const buf = await fetchBuffer(fileName ? ARCHIVE + fileName : `${LIVE}SCADA_${iso}.json`);
  // unzipSingle already returns text; the live route is raw JSON bytes.
  const text = fileName ? unzipSingle(buf) : new TextDecoder().decode(buf);
  const parsed = JSON.parse(text);
  const rows = parsed?.data?.facilityScadaDispatchIntervals;
  if (!Array.isArray(rows)) {
    throw new Error(`${iso}: no facilityScadaDispatchIntervals in payload`);
  }
  return rows;
}

/**
 * Fold facility rows into per-station interval observations.
 *
 * A station's output is the sum over its facilities, exactly as the NEM side
 * sums over a station's DUIDs.
 */
export function foldDay(rows, facilityToStation, capacityOf = new Map()) {
  const byStation = new Map();
  let unknown = 0;

  for (const r of rows) {
    const stationId = facilityToStation.get(r.code);
    if (stationId === undefined) { unknown++; continue; }
    if (!Number.isFinite(r.quantity)) continue;

    const ms = wemIntervalMs(r.dispatchInterval);
    let intervals = byStation.get(stationId);
    if (!intervals) byStation.set(stationId, (intervals = new Map()));
    const acc = intervals.get(ms) ?? { mw: 0, facilities: 0 };
    acc.mw += wemQuantityToMw(r.quantity);
    acc.facilities++;
    intervals.set(ms, acc);
  }

  const out = [];
  for (const [stationId, intervals] of byStation) {
    const cap = capacityOf.get(stationId);
    for (const [ms, acc] of intervals) {
      const mw = Math.round(acc.mw * 1000) / 1000;
      // The same rule the NEM side applies: output above nameplate is telemetry
      // to distrust, or a registered capacity that has not kept up with an
      // expansion. Either way it is not a record production run, and marking it
      // suspect keeps it out of every fit rather than letting it set the scale.
      const suspect = Number.isFinite(cap) && cap > 0 && mw > 1.15 * cap;
      out.push({
        station_id: stationId,
        settlement_ms: ms,
        // Rounded at the same precision the NEM rows carry; the source has
        // eight decimal places of a megawatt-hour, which is noise.
        mw,
        facilities: acc.facilities,
        quality: suspect ? 'suspect' : 'ok',
      });
    }
  }
  out.sort((a, b) => a.settlement_ms - b.settlement_ms);
  return { rows: out, unknown };
}

export async function run({ days = 21, force = false } = {}) {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  const swis = registry.stations.filter((s) => s.region === 'SWIS');
  if (swis.length === 0) throw new Error('registry has no SWIS stations; run build-registry first');

  const facilityToStation = new Map();
  const capacityOf = new Map();
  for (const s of swis) {
    capacityOf.set(s.station_id, s.capacity_mw);
    for (const code of s.wem_facilities ?? []) facilityToStation.set(code, s.station_id);
  }
  if (facilityToStation.size === 0) {
    throw new Error('no wem_facilities on any SWIS station; run build-wem-codes.js first');
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const archive = await listArchiveDays();
  const wanted = [...archive.keys()].sort().slice(-days);
  console.log(`WEM backfill: ${wanted.length} days (${wanted[0]} .. ${wanted.at(-1)})`);
  console.log(`Mapping ${facilityToStation.size} facilities onto ${swis.length} SWIS stations`);

  let fetched = 0, skipped = 0, failed = 0, short = 0;
  for (const iso of wanted) {
    const outPath = path.join(DATA_DIR, `${iso}.json`);
    if (!force) {
      try { await fs.access(outPath); skipped++; continue; } catch { /* not cached */ }
    }
    try {
      const t0 = Date.now();
      const { rows, unknown } = foldDay(await fetchDay(iso, archive.get(iso)), facilityToStation, capacityOf);
      await fs.writeFile(outPath, JSON.stringify({ day: iso, mask: 'none', rows }));
      fetched++;
      const intervals = new Set(rows.map((r) => r.settlement_ms)).size;
      if (intervals !== INTERVALS_PER_DAY) short++;
      console.log(
        `  ${iso}  ${String(rows.length).padStart(6)} rows  ${String(intervals).padStart(3)} intervals` +
        `  ${unknown ? `${unknown} unmapped` : ''}  ${Date.now() - t0} ms`,
      );
    } catch (err) {
      failed++;
      console.log(`  ${iso}  FAILED: ${err.message}`);
    }
  }

  console.log(`\n${fetched} fetched, ${skipped} cached, ${failed} failed, ${short} incomplete days`);
  return { fetched, skipped, failed, short };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) || 21 : 21;
  await run({ days, force: process.argv.includes('--force') });
}
