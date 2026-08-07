// The live path: what the browser asks for, and what the harvester keeps.
//
// Live ingest fails quietly by nature. A feed that stops publishing looks
// exactly like a grid where nothing is changing, a manifest written before the
// files it names 404s on a path the server itself advertised, and an interval
// fetched twice is a duplicate reading nobody sees. None of that shows up in a
// screenshot, so it is asserted here instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLiveFeed, describeLive } from '../app/js/live.js';
import { mergeWeatherSources } from '../app/js/dataload.js';

const HOUR = 3_600_000;
const MIN5 = 300_000;

// --- a stub server, so the client can be tested without one ----------------

function stubFetch(files) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (!(url in files)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => files[url] };
  };
  return asked;
}

const manifestWith = (nem) => ({
  generated_at: 1_000_000,
  feeds: { nem: { cadence: 'interval', intervals: nem, latest_at: nem.at(-1) ?? null } },
});

const obs = (at, mw) => ({ station_id: 'ONE', observed_at: at, output_mw: mw, quality: 'ok' });

test('only intervals after the loaded backfill window are fetched', async () => {
  const files = {
    '/data/live/index.json': manifestWith([100, 200, 300]),
    '/data/live/nem/200.json': { at: 200, observations: [obs(200, 5)] },
    '/data/live/nem/300.json': { at: 300, observations: [obs(300, 6)] },
  };
  const asked = stubFetch(files);
  const batches = [];
  const feed = createLiveFeed({ base: '/data', since: 100, onIntervals: (b) => batches.push(b) });
  await feed.ready;
  feed.stop();

  assert.ok(!asked.includes('/data/live/nem/100.json'), 'the backfill already holds interval 100');
  assert.deepEqual(batches[0].observations.map((o) => o.observed_at), [200, 300]);
});

test('an interval already seen is never fetched twice', async () => {
  const files = {
    '/data/live/index.json': manifestWith([200]),
    '/data/live/nem/200.json': { at: 200, observations: [obs(200, 5)] },
  };
  const asked = stubFetch(files);
  const batches = [];
  const feed = createLiveFeed({ base: '/data', since: 0, onIntervals: (b) => batches.push(b) });
  await feed.ready;
  await feed.poll();
  feed.stop();

  assert.equal(asked.filter((u) => u === '/data/live/nem/200.json').length, 1);
  assert.equal(batches.length, 1, 'a poll with nothing new must not emit an empty batch');
});

test('intervals are emitted oldest first, whatever order the manifest lists', async () => {
  const files = {
    '/data/live/index.json': manifestWith([300, 100, 200]),
    '/data/live/nem/100.json': { at: 100, observations: [obs(100, 1)] },
    '/data/live/nem/200.json': { at: 200, observations: [obs(200, 2)] },
    '/data/live/nem/300.json': { at: 300, observations: [obs(300, 3)] },
  };
  stubFetch(files);
  const batches = [];
  const feed = createLiveFeed({ base: '/data', since: 0, onIntervals: (b) => batches.push(b) });
  await feed.ready;
  feed.stop();
  // Persistence is a chain; handing the worker an interval out of order would
  // have it compare a reading against one that has not happened yet.
  assert.deepEqual(batches[0].observations.map((o) => o.observed_at), [100, 200, 300]);
});

test('a file swept between manifest and fetch is skipped, not fatal', async () => {
  const files = {
    '/data/live/index.json': manifestWith([100, 200]),
    // 100 has been removed by the retention sweep since the manifest was written.
    '/data/live/nem/200.json': { at: 200, observations: [obs(200, 9)] },
  };
  stubFetch(files);
  const batches = [];
  const statuses = [];
  const feed = createLiveFeed({
    base: '/data', since: 0,
    onIntervals: (b) => batches.push(b),
    onStatus: (s) => statuses.push(s),
  });
  await feed.ready;
  feed.stop();

  assert.deepEqual(batches[0].observations.map((o) => o.observed_at), [200]);
  assert.equal(statuses.at(-1).ok, true, 'a swept file is expected, not a feed failure');
});

test('an unreachable manifest is reported rather than thrown', async () => {
  stubFetch({});
  const statuses = [];
  const feed = createLiveFeed({ base: '/data', onIntervals: () => {}, onStatus: (s) => statuses.push(s) });
  await feed.ready;
  feed.stop();
  assert.equal(statuses.at(-1).ok, false);
  assert.match(describeLive(statuses.at(-1)), /unreachable/);
});

test('the status line says a stopped feed has stopped', () => {
  const now = 2_000_000_000_000;
  const at = (mins) => ({ ok: true, manifest: { feeds: { nem: { latest_at: now - mins * 60_000 } } } });

  assert.match(describeLive(at(0), now), /just now/);
  assert.match(describeLive(at(6), now), /6 min ago/);
  assert.doesNotMatch(describeLive(at(6), now), /stopped/);
  // The failure this exists for: a feed that died an hour ago still reporting
  // its last good interval as though it were the current state of the grid.
  assert.match(describeLive(at(60), now), /stopped publishing/);
  assert.match(describeLive({ ok: true, manifest: { feeds: {} } }, now), /no dispatch published yet/);
});

// --- retention -------------------------------------------------------------

test('the sweep keeps the retention window and drops what is past it', async () => {
  const { sweep, FEEDS } = await import('../harvester/live.js');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'live');
  const now = Date.now();
  const kept = now - 1 * HOUR;
  const dropped = now - 9 * HOUR;

  const made = [];
  for (const feed of FEEDS) {
    await fs.mkdir(path.join(root, feed), { recursive: true });
    for (const at of [kept, dropped]) {
      const f = path.join(root, feed, `${at}.json`);
      await fs.writeFile(f, JSON.stringify({ at }));
      made.push(f);
    }
  }

  await sweep(now, 6);

  for (const feed of FEEDS) {
    await fs.access(path.join(root, feed, `${kept}.json`));
    await assert.rejects(fs.access(path.join(root, feed, `${dropped}.json`)));
  }
  for (const f of made) await fs.rm(f, { force: true });
});

// --- weather join ----------------------------------------------------------

const series = (times, values) => ({ times, values });

test('reanalysis wins where it overlaps the forecast, and the forecast extends past it', () => {
  const archive = { station_id: 'ONE', variables: { wind: series([0, HOUR], [3, 4]) } };
  const forecast = {
    station_id: 'ONE', issued_at: 5,
    variables: { wind: series([HOUR, 2 * HOUR, 3 * HOUR], [99, 6, 7]) },
  };
  const merged = mergeWeatherSources(archive, forecast);

  assert.deepEqual(merged.variables.wind.times, [0, HOUR, 2 * HOUR, 3 * HOUR]);
  // 99 is the forecast's answer for an hour the reanalysis has actually
  // observed. Reanalysis is a better answer to that question and must win.
  assert.deepEqual(merged.variables.wind.values, [3, 4, 6, 7]);
  assert.equal(merged.forecast_issued_at, 5);
});

test('either source alone is used as-is', () => {
  const only = { station_id: 'ONE', variables: { wind: series([0], [3]) } };
  assert.equal(mergeWeatherSources(only, null), only);
  assert.equal(mergeWeatherSources(null, only), only);
  assert.equal(mergeWeatherSources(null, null), null);
});

test('a variable present in only one source survives the join', () => {
  const archive = { station_id: 'ONE', variables: { wind: series([0], [3]) } };
  const forecast = { station_id: 'ONE', variables: { ghi: series([MIN5], [800]) } };
  const merged = mergeWeatherSources(archive, forecast);
  assert.deepEqual(Object.keys(merged.variables).sort(), ['ghi', 'wind']);
  assert.deepEqual(merged.variables.ghi.values, [800]);
});
