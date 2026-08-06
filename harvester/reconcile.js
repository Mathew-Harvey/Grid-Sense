// Reconciles our regional aggregates against AEMO's own published figures.
//
// This is the only thing that will tell you the registry is incomplete. A
// missing station throws no error and produces no warning — it just makes a
// regional total quietly low, and every downstream number inherits the gap
// while continuing to look entirely plausible.
//
// The comparison is against DISPATCHIS REGIONSUM rather than the live
// ELEC_NEM_SUMMARY endpoint, for two reasons found by measurement.
//
// First, timestamps. The summary endpoint serves the current interval while
// NEMWeb publishes a file a few minutes after that interval closes, so the
// newest SCADA file is reliably one interval behind the endpoint. Comparing
// them measures the ramp between two different moments, not our accuracy.
// REGIONSUM arrives on the same five-minute cycle as SCADA and carries the same
// SETTLEMENTDATE, so the intervals can be matched exactly.
//
// Second, the quantity. The endpoint's SCHEDULEDGENERATION is not the sum of
// scheduled unit output: for SA at one interval it read 1216.8 MW where
// REGIONSUM's DISPATCHABLEGENERATION read 1491.8 MW against our own sum of
// 1479 MW. DISPATCHABLEGENERATION is the figure that corresponds to summed
// scheduled SCADA.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAemo, parseAemoTimestamp } from './parse-aemo.js';
import { fetchBuffer, unzipSingle, listNemwebDir } from './fetch-util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCADA_DIR = 'https://nemweb.com.au/Reports/Current/Dispatch_SCADA/';
const DISPATCHIS_DIR = 'https://nemweb.com.au/Reports/Current/DispatchIS_Reports/';

/** Build DUID -> {region, scheduleType, dispatchType} from the registry. */
export async function duidIndex() {
  const registry = JSON.parse(await fs.readFile(path.join(HERE, 'registry.json'), 'utf8'));
  const index = new Map();
  for (const s of registry.stations) {
    if (s.network !== 'NEM') continue;
    for (const d of s.duids) {
      index.set(d.duid, {
        region: s.region,
        scheduleType: d.schedule_type,
        dispatchType: d.dispatch_type,
        stationId: s.station_id,
        fueltech: s.fueltech,
      });
    }
  }
  return index;
}

/** Interval stamp encoded in a NEMWeb filename, e.g. ..._202608062335_... */
const stampOf = (name) => /_(\d{12})_/.exec(name)?.[1] ?? null;

/** The stamp five minutes earlier. Stamps are NEM local time with no DST, so
 *  plain arithmetic on the parsed components is safe here. */
function previousStamp(stamp) {
  const [y, mo, d, h, mi] = [
    +stamp.slice(0, 4), +stamp.slice(4, 6), +stamp.slice(6, 8),
    +stamp.slice(8, 10), +stamp.slice(10, 12),
  ];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) - 5 * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}

export async function latestScada(stamp = null) {
  const names = await listNemwebDir(SCADA_DIR, /PUBLIC_DISPATCHSCADA_[0-9_]+\.zip/gi);
  const chosen = stamp ? names.find((n) => stampOf(n) === stamp) : names.at(-1);
  if (!chosen) throw new Error(`No Dispatch_SCADA file for interval ${stamp}`);
  const csv = unzipSingle(await fetchBuffer(SCADA_DIR + chosen));
  const { tables } = parseAemo(csv);
  const rows = tables.get('DISPATCH.UNIT_SCADA').rows;
  return { file: chosen, stamp: stampOf(chosen), rows, settlementMs: parseAemoTimestamp(rows[0].SETTLEMENTDATE) };
}

/**
 * Region-level totals for a given interval. Taking the newest DISPATCHIS file
 * and then requesting SCADA for that exact stamp is what keeps the two sides on
 * the same moment.
 */
export async function regionSum(stamp = null) {
  const names = await listNemwebDir(DISPATCHIS_DIR, /PUBLIC_DISPATCHIS_[0-9_]+\.zip/gi);
  const chosen = stamp ? names.find((n) => stampOf(n) === stamp) : names.at(-1);
  if (!chosen) throw new Error(`No DispatchIS file for interval ${stamp}`);
  const csv = unzipSingle(await fetchBuffer(DISPATCHIS_DIR + chosen));
  const { tables } = parseAemo(csv, { tables: new Set(['DISPATCH.REGIONSUM']) });
  // INTERVENTION=1 rows are the re-run of an intervened interval and would
  // double the region if taken alongside the base run.
  const rows = tables.get('DISPATCH.REGIONSUM').rows.filter((r) => (r.INTERVENTION ?? 0) === 0);
  return { file: chosen, stamp: stampOf(chosen), rows };
}

/**
 * Sum SCADA by region and schedule type.
 *
 * Loads are excluded: AEMO's generation figures count generation, so netting a
 * battery's charging leg into the total would understate it. Batteries
 * registered BIDIRECTIONAL report a signed value on one DUID, so only the
 * positive part counts as generation.
 */
export function aggregate(rows, index) {
  const totals = new Map();
  const unknown = [];
  for (const r of rows) {
    const meta = index.get(r.DUID);
    if (!meta) { unknown.push({ duid: r.DUID, mw: r.SCADAVALUE }); continue; }
    if (meta.dispatchType === 'LOAD') continue;
    const mw = meta.dispatchType === 'BIDIRECTIONAL'
      ? Math.max(0, r.SCADAVALUE ?? 0)
      : (r.SCADAVALUE ?? 0);

    const bucket = meta.scheduleType === 'SEMI-SCHEDULED' ? 'semi'
      : meta.scheduleType === 'SCHEDULED' ? 'scheduled'
        : 'non';
    const key = `${meta.region}|${bucket}`;
    totals.set(key, (totals.get(key) || 0) + mw);
  }
  return { totals, unknown };
}

export async function reconcile(stamp = null) {
  const index = await duidIndex();
  // Anchor on SCADA: DISPATCHIS publishes a little ahead of it, so the newest
  // DISPATCHIS interval regularly has no SCADA file yet.
  const scada = await latestScada(stamp);

  // Compare like with like across the five-minute offset. DISPATCHABLEGENERATION
  // is a target for the END of its interval, while a SCADA row stamped S is a
  // snapshot taken at S - 5min. So the actual output at the end of interval
  // S - 5min is the SCADA row stamped S, and REGIONSUM for S - 5min is what it
  // should be measured against.
  //
  // This is not a rounding detail. Averaged over 150 intervals of one day,
  // matching the stamps naively gives a mean regional error of 1.0-5.5%, and
  // shifting by the one interval gives 0.3-1.8% — the same numbers, two to
  // three times better, for no change other than reading the clock correctly.
  const region = await regionSum(previousStamp(scada.stamp));

  const { totals, unknown } = aggregate(scada.rows, index);

  const results = [];
  for (const row of region.rows) {
    const id = row.REGIONID;
    const oursSched = totals.get(`${id}|scheduled`) || 0;
    const oursSemi = totals.get(`${id}|semi`) || 0;
    const theirsSched = row.DISPATCHABLEGENERATION ?? 0;
    const theirsSemi = row.SEMISCHEDULE_CLEAREDMW ?? 0;
    const ours = oursSched + oursSemi;
    const theirs = theirsSched + theirsSemi;
    results.push({
      region: id,
      oursSched, theirsSched,
      oursSemi, theirsSemi,
      ours, theirs,
      diffPct: theirs === 0 ? 0 : (100 * (ours - theirs)) / theirs,
    });
  }

  return { results, unknown, stamp: region.stamp, scadaFile: scada.file, regionFile: region.file };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { results, unknown, stamp, scadaFile, regionFile } = await reconcile();
  console.log(`Interval ${stamp}\n  ${scadaFile}\n  ${regionFile}\n`);
  console.log('region   ours_sched  aemo_sched   ours_semi  aemo_semi     ours     aemo    diff%');
  for (const r of results) {
    console.log(
      `${r.region.padEnd(6)} ${r.oursSched.toFixed(0).padStart(11)} ${r.theirsSched.toFixed(0).padStart(11)}` +
      ` ${r.oursSemi.toFixed(0).padStart(11)} ${r.theirsSemi.toFixed(0).padStart(10)}` +
      ` ${r.ours.toFixed(0).padStart(8)} ${r.theirs.toFixed(0).padStart(8)} ${r.diffPct.toFixed(2).padStart(8)}`,
    );
  }
  const worst = results.reduce((a, b) => (Math.abs(b.diffPct) > Math.abs(a.diffPct) ? b : a));
  console.log(`\nWorst region: ${worst.region} at ${worst.diffPct.toFixed(2)}%`);

  if (unknown.length) {
    const producing = unknown.filter((u) => Math.abs(u.mw ?? 0) > 0.5);
    console.log(`\n${unknown.length} DUIDs not in registry (${producing.length} currently producing):`);
    for (const u of producing.sort((a, b) => Math.abs(b.mw) - Math.abs(a.mw)).slice(0, 25)) {
      console.log(`  ${u.duid.padEnd(14)} ${u.mw.toFixed(1).padStart(9)} MW`);
    }
    console.log(`  total unregistered output: ${producing.reduce((s, u) => s + Math.abs(u.mw), 0).toFixed(0)} MW`);
  }
}
