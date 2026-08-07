// The browser half of live ingest: watch the harvester's manifest, fetch the
// intervals this page has not seen, hand them upward.
//
// Deliberately dumb about what the data means. It knows which interval
// timestamps it has fetched and nothing else — no model state, no replay
// cursor, no idea what a station is. Everything it emits goes to the worker,
// which is the only thing that decides what an interval does to the forecast.
//
// The manifest is the contract. It lists the interval files that exist, and it
// is written after them, so a timestamp it names is a file that can be
// fetched. Nothing here guesses a filename from a clock.

const MINUTE = 60_000;

/** Feeds that arrive as one file per five-minute interval. */
const INTERVAL_FEEDS = ['nem', 'market'];

/**
 * Watch the live manifest and emit new intervals.
 *
 * @param {object} opts
 * @param {string} opts.base data root, e.g. '/data'
 * @param {(batch: {observations: object[], market: object[], latest: number}) => void} opts.onIntervals
 * @param {(status: object) => void} [opts.onStatus] called every poll, including failures
 * @param {number} [opts.pollMs]
 * @param {number} [opts.since] ignore intervals at or before this instant — the
 *        end of what the backfill already loaded, so a page that starts fresh
 *        does not re-ingest six hours the replay is about to walk anyway
 * @returns {{stop: () => void, poll: () => Promise<void>}}
 */
export function createLiveFeed({ base, onIntervals, onStatus = null, pollMs = MINUTE, since = 0 }) {
  const seen = new Map(INTERVAL_FEEDS.map((f) => [f, new Set()]));
  let timer = null;
  let stopped = false;
  let inFlight = false;

  const fetchJson = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  };

  async function poll() {
    // A slow poll must not stack behind the next tick: on a poor connection the
    // requests would pile up until the browser started cancelling them, and the
    // symptom would look like an intermittent feed rather than a busy one.
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const manifest = await fetchJson(`${base}/live/index.json`);

      const observations = [];
      const market = [];
      let latest = 0;

      for (const feed of INTERVAL_FEEDS) {
        const entry = manifest.feeds?.[feed];
        if (!entry?.intervals) continue;
        const already = seen.get(feed);
        // Oldest first, so the worker receives intervals in the order they
        // happened and the persistence chain is never asked to run backwards.
        const fresh = entry.intervals.filter((at) => at > since && !already.has(at)).sort((a, b) => a - b);

        for (const at of fresh) {
          let cell;
          try {
            cell = await fetchJson(`${base}/live/${feed}/${at}.json`);
          } catch {
            // The retention sweep can remove a file between the manifest being
            // written and this fetch. Not an error: it is older than the window
            // and is not marked seen, so it simply never arrives.
            continue;
          }
          already.add(at);
          latest = Math.max(latest, at);
          if (feed === 'nem') observations.push(...(cell.observations ?? []));
          else market.push(cell);
        }

        // Forget what the harvester has already swept, so the set cannot grow
        // without bound on a tab left open for days.
        const live = new Set(entry.intervals);
        for (const at of already) if (!live.has(at)) already.delete(at);
      }

      if (observations.length || market.length) onIntervals({ observations, market, latest });
      onStatus?.({ ok: true, manifest, added: observations.length, at: Date.now() });
    } catch (err) {
      onStatus?.({ ok: false, error: String(err.message), at: Date.now() });
    } finally {
      inFlight = false;
    }
  }

  const loop = async () => {
    timer = null;
    await poll();
    if (!stopped) timer = setTimeout(loop, pollMs);
  };
  // Run the first poll now rather than on a timer. There is no reason to make
  // the page wait a tick for data that already exists, and `ready` gives a
  // caller — a test, most usefully — something to await instead of a delay.
  const ready = loop();

  return {
    ready,
    poll,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * One sentence describing the state of the feed, for the status line.
 *
 * Written to be readable when things are wrong, which is when it matters: a
 * feed that has stopped says how long ago it stopped, rather than continuing to
 * report the last good number as though it were current.
 */
export function describeLive(status, now = Date.now()) {
  if (!status) return 'Live feed starting.';
  if (!status.ok) return `Live feed unreachable: ${status.error}`;

  const nem = status.manifest?.feeds?.nem;
  if (!nem?.latest_at) return 'Live feed connected, no dispatch published yet.';

  const mins = Math.round((now - nem.latest_at) / MINUTE);
  const age = mins <= 1 ? 'just now' : `${mins} min ago`;
  const stale = mins > 15 ? ' — the feed has stopped publishing' : '';
  return `Live: most recent dispatch interval ${age}${stale}.`;
}
