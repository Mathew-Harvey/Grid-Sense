// Thirty-day price backfill, and the one place the headline price statistics
// are computed.
//
// The DispatchIS archive is a daily zip of 288 inner zips, one per dispatch
// interval, each a whole DispatchIS report of which only DISPATCH.PRICE is
// wanted. A day is 5.6 MB compressed and roughly 25 MB of nested archives once
// opened, so it is fetched, unwrapped, reduced to 1,440 price rows and released,
// all in memory. Written out whole, thirty days would be several gigabytes of
// constraint equations and interconnector results nothing here reads.
//
// The archive day boundary follows the interval-ending convention: the file for
// the 5th holds the intervals stamped 00:05 on the 5th through 00:00 on the 6th.
// Those 288 stamps are one trading day and are stored as one, so a short count
// is a genuine gap rather than an artefact of regrouping by calendar date.
//
// summary.json exists because the mean price, the negative-price count and the
// spike count are quoted in several places in the interface, and figures that
// are recomputed in each of them drift apart. They are computed once, here, from
// the day files on disk, so the summary can always be re-derived from the data
// it claims to describe.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBuffer, unzipSingle, unzipAll } from './fetch-util.js';
import { parsePriceTable } from './fetch-price.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRICES_DIR = path.join(HERE, '..', 'data', 'prices');
const ARCHIVE_DIR = 'https://nemweb.com.au/Reports/ARCHIVE/DispatchIS_Reports/';

const INTERVALS_PER_DAY = 288;
const INTERVAL_HOURS = 5 / 60;

// The threshold the market itself treats as a high-price event, and the level
// above which a battery's whole day of arbitrage is usually made.
const SPIKE_THRESHOLD = 300;

/** Map each archived trading day to its filename. */
export async function listArchiveDays() {
  const res = await fetch(ARCHIVE_DIR, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${ARCHIVE_DIR}`);
  const html = await res.text();

  const byDay = new Map();
  for (const name of new Set(html.match(/PUBLIC_DISPATCHIS_\d{8}\.zip/gi) || [])) {
    const d = /(\d{8})/.exec(name)[1];
    byDay.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, name);
  }
  return new Map([...byDay].sort());
}

/**
 * Fetch one archived day and reduce it to its price rows.
 *
 * @param {string} fileName as it appears in the archive listing
 * @returns {Promise<object[]>} 1,440 rows on a complete day, ascending
 */
export async function fetchArchiveDay(fileName) {
  const outer = await fetchBuffer(ARCHIVE_DIR + fileName);

  const intervals = [];
  for (const [innerName, inner] of unzipAll(outer)) {
    try {
      intervals.push(...parsePriceTable(unzipSingle(inner)));
    } catch (err) {
      // Which of the 288 failed is the whole diagnosis; without it the message
      // says only that some interval somewhere in the day would not parse.
      throw new Error(`${innerName}: ${err.message}`);
    }
  }

  intervals.sort((a, b) => a.settlement_ms - b.settlement_ms || (a.region < b.region ? -1 : 1));
  return intervals;
}

/**
 * Percentile of an ascending array by linear interpolation between the two
 * nearest order statistics — the definition R's type 7 and NumPy's default use.
 *
 * Pinned rather than left to a nearest-rank convenience because p5 and p95 are
 * the width of the price distribution the interface draws, and two definitions
 * disagree by a whole interval's worth of price at the tails, which is exactly
 * where this distribution does its interesting work.
 */
function percentile(ascending, p) {
  if (!ascending.length) return null;
  const rank = (ascending.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return ascending[lo];
  return ascending[lo] + (rank - lo) * (ascending[hi] - ascending[lo]);
}

/**
 * The headline RRP statistics per region.
 *
 * Nothing is filtered. Administered, suspended and intervened intervals are real
 * prices that real generators were paid, and dropping them would quietly flatter
 * every distribution in the interface.
 *
 * @param {object[]} intervals price rows as written by the backfill
 * @returns {Object<string, object>} keyed by REGIONID
 */
export function summarisePrices(intervals) {
  const byRegion = new Map();
  for (const row of intervals) {
    let prices = byRegion.get(row.region);
    if (!prices) byRegion.set(row.region, prices = []);
    prices.push(row.rrp);
  }

  const regions = {};
  for (const region of [...byRegion.keys()].sort()) {
    const prices = byRegion.get(region);
    const ascending = [...prices].sort((a, b) => a - b);
    const negative = prices.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);

    regions[region] = {
      count: prices.length,
      mean: prices.reduce((s, v) => s + v, 0) / prices.length,
      median: percentile(ascending, 0.5),
      p5: percentile(ascending, 0.05),
      p95: percentile(ascending, 0.95),
      min: ascending[0],
      max: ascending[ascending.length - 1],
      negative_intervals: negative,
      above_300_intervals: prices.reduce((n, v) => n + (v > SPIKE_THRESHOLD ? 1 : 0), 0),
      negative_hours: negative * INTERVAL_HOURS,
    };
  }
  return regions;
}

async function readDayFiles(dir) {
  const names = (await fs.readdir(dir))
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort();

  const intervals = [];
  for (const name of names) {
    const day = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    intervals.push(...day.intervals);
  }
  return { days: names.map((n) => n.slice(0, -5)), intervals };
}

/**
 * Recompute summary.json from every day file present.
 *
 * @param {string} [dir] directory holding the day files
 */
export async function writeSummary(dir = PRICES_DIR) {
  const { days, intervals } = await readDayFiles(dir);
  const summary = {
    from: days[0] ?? null,
    to: days.at(-1) ?? null,
    days: days.length,
    intervals: intervals.length,
    spike_threshold: SPIKE_THRESHOLD,
    regions: summarisePrices(intervals),
  };
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));
  return summary;
}

/**
 * Pull the most recent archived days and rewrite the summary.
 *
 * @param {{days?: number, force?: boolean}} [opts]
 */
export async function backfillPrices({ days = 30, force = false } = {}) {
  await fs.mkdir(PRICES_DIR, { recursive: true });

  const byDay = await listArchiveDays();
  const wanted = [...byDay.keys()].slice(-days);
  if (!wanted.length) throw new Error(`No archived days listed at ${ARCHIVE_DIR}`);

  console.log(`Backfilling prices for ${wanted.length} days (${wanted[0]} .. ${wanted.at(-1)})`);

  let fetched = 0, skipped = 0, failed = 0, short = 0;
  for (const day of wanted) {
    const outPath = path.join(PRICES_DIR, `${day}.json`);
    if (!force) {
      try { await fs.access(outPath); skipped++; continue; } catch { /* not cached */ }
    }

    try {
      const t0 = Date.now();
      const intervals = await fetchArchiveDay(byDay.get(day));
      await fs.writeFile(outPath, JSON.stringify({ day, intervals }));
      fetched++;

      const stamps = new Set(intervals.map((r) => r.settlement_ms)).size;
      const apc = intervals.reduce((n, r) => n + (r.apc_flag ? 1 : 0), 0);
      const intervened = intervals.reduce((n, r) => n + (r.intervention ? 1 : 0), 0);
      const band = intervals.reduce((n, r) => n + (r.out_of_band ? 1 : 0), 0);
      console.log(
        `  ${day}  ${String(intervals.length).padStart(5)} rows  ` +
        `${String(stamps).padStart(3)} intervals  ${Date.now() - t0} ms`,
      );
      if (stamps !== INTERVALS_PER_DAY) {
        short++;
        console.log(`    incomplete: ${stamps}/${INTERVALS_PER_DAY} intervals`);
      }
      if (apc) console.log(`    ${apc} rows under an administered price cap`);
      if (intervened) console.log(`    ${intervened} rows from an intervention re-run`);
      if (band) console.log(`    ${band} rows outside the market price band`);
    } catch (err) {
      failed++;
      console.log(`  ${day}  FAILED: ${err.message}`);
    }
  }

  const summary = await writeSummary();
  console.log(`\n${fetched} fetched, ${skipped} already cached, ${failed} failed, ${short} incomplete`);
  console.log(`\nRRP $/MWh over ${summary.days} days (${summary.from} .. ${summary.to})`);
  console.log('  region   count     mean   median       p5      p95      min       max   neg   >$300   neg hrs');
  for (const [region, s] of Object.entries(summary.regions)) {
    console.log(
      `  ${region.padEnd(6)} ${String(s.count).padStart(7)} ` +
      `${s.mean.toFixed(2).padStart(8)} ${s.median.toFixed(2).padStart(8)} ` +
      `${s.p5.toFixed(2).padStart(8)} ${s.p95.toFixed(2).padStart(8)} ` +
      `${s.min.toFixed(2).padStart(8)} ${s.max.toFixed(2).padStart(9)} ` +
      `${String(s.negative_intervals).padStart(5)} ${String(s.above_300_intervals).padStart(7)} ` +
      `${s.negative_hours.toFixed(2).padStart(9)}`,
    );
  }

  return { fetched, skipped, failed, short, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  await backfillPrices({
    days: i >= 0 ? Number(process.argv[i + 1]) || 30 : 30,
    force: process.argv.includes('--force'),
  });
}
