// Live ingest: the loop that keeps the deployed instance current between builds.
//
// The backfill answers "what happened", and until now that was the whole system
// — the data froze at the last completed trading day and only a redeploy moved
// it. This is the other half: a tick that pulls the newest published interval
// from each feed and lays it down where the browser can pick it up.
//
// Three decisions shape the file layout, and all three are about what a browser
// polling every minute can afford.
//
// One interval per file. A day file is 30 MB; appending a live interval to it
// means rewriting 30 MB every five minutes, and a client that wants the newest
// interval has to download the whole day to find it. Interval files are written
// once and never touched again, so a client fetches exactly what it lacks.
//
// A manifest, written last. The browser polls one small file to learn what
// exists. Writing it after the interval files it names means a client can never
// read a manifest that promises a file which is not there yet — the failure
// would be a 404 on a path the server itself had just advertised.
//
// A retention sweep. Interval files accumulate at 288 a day per feed against an
// ephemeral disk that also holds the backfill. The live window is a handover
// window, not an archive: the backfill owns history, and anything older than
// the retention horizon has either been ingested by every live client or is
// past being useful to a client that has just arrived.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollScada } from './fetch-nem.js';
import { catchUpFromCurrent } from './backfill-wem.js';
import { parsePriceTable, listDispatchIsFiles } from './fetch-price.js';
import { foldDay } from './backfill-flows.js';
import { fetchBuffer, unzipSingle } from './fetch-util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = path.join(HERE, '..', 'data', 'live');
const REGISTRY = path.join(HERE, 'registry.json');

const DISPATCHIS_DIR = 'https://nemweb.com.au/Reports/Current/DispatchIS_Reports/';

const HOUR_MS = 3_600_000;

// Western Australia is not a five-minute feed and cannot be polled like one, so
// it is checked hourly rather than every minute. See FLAGS F18.
const WEM_CHECK_MS = HOUR_MS;

// Dispatch publishes every five minutes, at an offset that drifts by a minute
// or two. Polling every minute finds each interval within about sixty seconds
// of publication and costs one directory listing per feed per minute.
export const POLL_MS = 60_000;

// How much live history stays on disk. Long enough that a client which sleeps
// through a few intervals — a backgrounded tab, a laptop lid — resumes by
// fetching what it missed rather than reloading the page.
export const RETENTION_HOURS = 6;

// Feeds that publish every five minutes and are laid down as interval files.
// Western Australia is tracked in the manifest too, but it is a daily ingest
// into the backfill directory rather than a live interval stream.
export const FEEDS = ['nem', 'market'];

/**
 * Write via a temporary file and rename.
 *
 * The server serves this directory while the poller writes to it, and rename is
 * atomic within a filesystem — so a reader sees either the previous file or the
 * complete new one, never a half-written JSON body that throws in the browser's
 * parser as a syntax error with no useful origin.
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

async function writeInterval(feed, at, payload) {
  const dir = path.join(LIVE_DIR, feed);
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, `${at}.json`), JSON.stringify(payload));
}

/** Interval timestamps currently on disk for a feed, oldest first. */
async function intervalsOnDisk(feed) {
  try {
    const names = await fs.readdir(path.join(LIVE_DIR, feed));
    return names
      .filter((n) => n.endsWith('.json') && !n.endsWith('.tmp'))
      .map((n) => Number(n.slice(0, -'.json'.length)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// The since-marks survive a restart so a redeploy or a crash does not re-emit
// intervals the clients already hold. They are small and advisory: losing them
// costs one duplicated interval, which the client drops by timestamp anyway.
async function readState() {
  try {
    return JSON.parse(await fs.readFile(path.join(LIVE_DIR, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.mkdir(LIVE_DIR, { recursive: true });
  await writeAtomic(path.join(LIVE_DIR, 'state.json'), JSON.stringify(state));
}

/** Group per-station observations into one payload per interval. */
function byInterval(observations) {
  const groups = new Map();
  for (const o of observations) {
    let list = groups.get(o.observed_at);
    if (!list) groups.set(o.observed_at, (list = []));
    list.push(o);
  }
  return groups;
}

/**
 * NEM: the five-minute SCADA feed, which carries output and nothing else.
 *
 * There is no availability and no semi-dispatch cap in this feed — those arrive
 * next day in Next_Day_Dispatch — so `capped` is null here for the same reason
 * it is null for Western Australia: an unknown mask must never read as "not
 * curtailed". Live intervals therefore inform the forecast and the display, and
 * are excluded from anything that fits against explicitly uncurtailed data.
 */
async function pollNem(registry, since) {
  const result = await pollScada(registry, since ?? null);
  const groups = byInterval(result.observations);
  for (const [at, observations] of groups) {
    await writeInterval('nem', at, { at, source: 'dispatch_scada', observations });
  }
  return { since: result.latest ?? since ?? null, written: groups.size };
}

/**
 * Western Australia: a daily catch-up, because there is nothing faster to poll.
 *
 * Measured on 7 August 2026 at 17:53 AWST, ten hours into the open trading day:
 * `facilityScada/current/` held the day that closed at 07:55 that morning, and
 * `previous/` was a further day behind. The WEM publishes complete trading days,
 * not intervals — so this notices a completed day as soon as it is offered and
 * writes it into the same `data/wem-dispatch/` the backfill fills, where the
 * existing loaders already look. Recorded as FLAGS F18.
 *
 * Checked hourly. A minute-by-minute poll of a once-a-day file is 1,440
 * requests to learn something that changes once.
 */
async function pollWemDaily(state, now) {
  const due = state.wem?.checked_at == null || now - state.wem.checked_at >= WEM_CHECK_MS;
  if (!due) return { skipped: true };
  const { offered, ingested } = await catchUpFromCurrent();
  return { offered, ingested, checked_at: now };
}

/**
 * Prices, regional demand and interconnector flow — all three from one file.
 *
 * DispatchIS carries DISPATCHPRICE, DISPATCH.REGIONSUM and
 * DISPATCH.INTERCONNECTORRES together, so fetching it once and deriving all
 * three is one request rather than three of the same file.
 *
 * No SWIS demand here, and none is possible: Western Australia's operational
 * demand is published as a daily file, and today's returns 404 until the
 * trading day completes. The map's SWIS floor therefore stays at its last
 * backfilled value while the NEM regions move, which the interface says rather
 * than leaving the reader to infer from a floor that never changes.
 */
async function pollMarket(since) {
  const files = await listDispatchIsFiles();
  if (!files.length) throw new Error(`No DispatchIS files listed at ${DISPATCHIS_DIR}`);

  const fresh = since ? files.filter((f) => f > since) : files.slice(-1);
  if (!fresh.length) return { since, written: 0 };

  let written = 0;
  for (const stamp of fresh) {
    const text = unzipSingle(await fetchBuffer(DISPATCHIS_DIR + stamp));

    const prices = {};
    for (const row of parsePriceTable(text)) prices[row.region] = row;

    // foldDay handles the intervention rule — a republished interval replaces
    // the market run rather than adding to it — so a live file goes through the
    // same reduction as an archived one rather than a second implementation.
    for (const cell of foldDay([text])) {
      await writeInterval('market', cell.at, {
        at: cell.at,
        source: stamp,
        prices,
        demand: cell.demand,
        flow: cell.flow,
      });
      written++;
    }
  }
  return { since: fresh.at(-1), written };
}

/** Drop interval files past the retention horizon. */
export async function sweep(now = Date.now(), retentionHours = RETENTION_HOURS) {
  const cutoff = now - retentionHours * HOUR_MS;
  let removed = 0;
  for (const feed of FEEDS) {
    for (const at of await intervalsOnDisk(feed)) {
      if (at >= cutoff) continue;
      await fs.rm(path.join(LIVE_DIR, feed, `${at}.json`), { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * One pass over every feed.
 *
 * Each feed is isolated: NEMWeb being unreachable must not stop Western
 * Australia from updating, and neither must stop the manifest from being
 * written — a client needs to be told a feed is stale, which it cannot be if
 * the failure prevents the file that would say so.
 *
 * @param {{stations: object[]}} registry
 * @param {object} [opts]
 * @param {number} [opts.now] injected clock, for tests
 * @param {number} [opts.retentionHours]
 * @returns {Promise<object>} the manifest as written
 */
export async function tick(registry, { now = Date.now(), retentionHours = RETENTION_HOURS } = {}) {
  await fs.mkdir(LIVE_DIR, { recursive: true });
  const state = await readState();

  const pollers = {
    nem: () => pollNem(registry, state.nem?.since),
    market: () => pollMarket(state.market?.since),
  };

  const feeds = {};
  for (const feed of FEEDS) {
    const prev = state[feed] ?? {};
    try {
      const { since, written } = await pollers[feed]();
      state[feed] = { since, last_ok: now };
      feeds[feed] = { written, last_ok: now, error: null };
    } catch (err) {
      // The since-mark is deliberately kept: a failed poll must not be mistaken
      // for a cold start, which would re-emit everything on the next success.
      state[feed] = { since: prev.since ?? null, last_ok: prev.last_ok ?? null };
      feeds[feed] = { written: 0, last_ok: prev.last_ok ?? null, error: String(err.message) };
    }
  }

  // Western Australia, on its own cadence and reported in its own terms — a
  // trading day, not an interval. Its failures are isolated like the others.
  const prevWem = state.wem ?? {};
  let wem;
  try {
    const r = await pollWemDaily(state, now);
    state.wem = r.skipped ? prevWem : { checked_at: r.checked_at, last_day: r.offered?.at(-1) ?? prevWem.last_day ?? null };
    wem = {
      cadence: 'daily',
      checked_at: state.wem.checked_at ?? null,
      last_day: state.wem.last_day ?? null,
      ingested: r.skipped ? [] : r.ingested.map((d) => d.iso),
      error: null,
    };
  } catch (err) {
    state.wem = prevWem;
    wem = {
      cadence: 'daily',
      checked_at: prevWem.checked_at ?? null,
      last_day: prevWem.last_day ?? null,
      ingested: [],
      error: String(err.message),
    };
  }

  await sweep(now, retentionHours);
  await writeState(state);

  const manifest = {
    generated_at: now,
    poll_ms: POLL_MS,
    retention_hours: retentionHours,
    feeds: {},
  };
  for (const feed of FEEDS) {
    const intervals = await intervalsOnDisk(feed);
    manifest.feeds[feed] = { ...feeds[feed], cadence: 'interval', latest_at: intervals.at(-1) ?? null, intervals };
  }
  manifest.feeds.wem = wem;

  // Last, so nothing it names is missing from disk.
  await writeAtomic(path.join(LIVE_DIR, 'index.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * Run ticks forever. Returns a stop function.
 *
 * setTimeout rather than setInterval: a slow tick — a big WEM day file over a
 * poor link — would otherwise queue the next one behind it and the loop would
 * run continuously rather than every minute. Unref'd so a poller cannot be the
 * reason a process refuses to exit.
 */
export function start({ intervalMs = POLL_MS, registry = null, onTick = null } = {}) {
  let timer = null;
  let stopped = false;

  const loop = async () => {
    timer = null;
    if (stopped) return;
    try {
      const reg = registry ?? JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
      const manifest = await tick(reg);
      onTick?.(manifest);
    } catch (err) {
      // A throw here is the loop's own failure, not a feed's — tick() absorbs
      // those. Logged and retried; stopping would leave the instance silently
      // frozen, which is the state this whole file exists to end.
      console.error(`live: tick failed: ${err.message}`);
    }
    if (!stopped) {
      timer = setTimeout(loop, intervalMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(loop, 0);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes('--once');
  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));

  const report = (m) => {
    const parts = FEEDS.map((f) => {
      const feed = m.feeds[f];
      const age = feed.latest_at ? `${Math.round((m.generated_at - feed.latest_at) / 60000)} min old` : 'nothing';
      return `${f}: +${feed.written} (${age})${feed.error ? ` ERROR ${feed.error}` : ''}`;
    });
    const wem = m.feeds.wem;
    parts.push(`wem: ${wem.last_day ?? 'nothing'} daily${wem.ingested.length ? ` (+${wem.ingested.join(',')})` : ''}` +
      `${wem.error ? ` ERROR ${wem.error}` : ''}`);
    console.log(`${new Date(m.generated_at).toISOString()}  ${parts.join('  ')}`);
  };

  if (once) {
    report(await tick(registry));
  } else {
    console.log(`live: polling every ${POLL_MS / 1000}s, keeping ${RETENTION_HOURS}h`);
    start({ registry, onTick: report });
    // Nothing else holds this process open, and the timers are unref'd.
    setInterval(() => {}, 1 << 30);
  }
}
