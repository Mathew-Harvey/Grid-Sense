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

test('a server that cannot be reached is reported rather than thrown', async () => {
  // A transport failure, not a 404: the connection itself did not happen. That
  // is the case "unreachable" is the honest word for.
  globalThis.fetch = async () => { throw new Error('network down'); };
  const statuses = [];
  const feed = createLiveFeed({ base: '/data', onIntervals: () => {}, onStatus: (s) => statuses.push(s) });
  await feed.ready;
  feed.stop();
  assert.equal(statuses.at(-1).ok, false);
  assert.notEqual(statuses.at(-1).absent, true);
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

// --- Western Australia's live dispatch solution ----------------------------

const { foldSolution, bindingRun } = await import('../harvester/fetch-wem-live.js');

const maps = {
  facilityToStation: new Map([['ALPHA_WF1', 'ALPHA'], ['ALPHA_WF2', 'ALPHA'], ['BETA_PV1', 'BETA']]),
  capacityOf: new Map([['ALPHA', 100], ['BETA', 40]]),
};

const solution = (interval, details, caps = []) => ({
  data: {
    primaryDispatchInterval: interval,
    solutionData: [
      { dispatchInterval: interval, facilityScheduleDetails: details, dispatchCaps: caps },
      // A forward projection the engine solved alongside it. Not a measurement.
      { dispatchInterval: '2026-08-07T18:40:00+08:00', facilityScheduleDetails: [{ facilityCode: 'ALPHA_WF1', initialMw: 999 }] },
    ],
  },
});

test('only the binding interval is read, never the forward projections', () => {
  const body = solution('2026-08-07T18:35:00+08:00', [{ facilityCode: 'ALPHA_WF1', initialMw: 10 }]);
  assert.equal(bindingRun(body).dispatchInterval, '2026-08-07T18:35:00+08:00');
  const r = foldSolution(body, maps);
  // 999 is the engine's forecast for an interval that has not happened. Storing
  // it would score the model against AEMO's projection rather than the grid.
  assert.equal(r.observations.find((o) => o.station_id === 'ALPHA').output_mw, 10);
});

test('a station is the sum of its facilities, and unknown facilities are dropped', () => {
  const body = solution('2026-08-07T18:35:00+08:00', [
    { facilityCode: 'ALPHA_WF1', initialMw: 10 },
    { facilityCode: 'ALPHA_WF2', initialMw: 15.5 },
    { facilityCode: 'NOT_IN_REGISTRY', initialMw: 900 },
  ]);
  const r = foldSolution(body, maps);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].output_mw, 25.5);
  assert.equal(r.observations[0].units_online, 2);
});

test('a dispatch cap marks the station curtailed, and its absence marks it not', () => {
  const body = solution('2026-08-07T18:35:00+08:00', [
    { facilityCode: 'ALPHA_WF1', initialMw: 10 },
    { facilityCode: 'BETA_PV1', initialMw: 5 },
  ], [{ facilityCode: 'BETA_PV1', dispatchCap: 5 }]);
  const r = foldSolution(body, maps);
  const by = new Map(r.observations.map((o) => [o.station_id, o]));

  // The distinction the whole WA curtailment story turns on: false is a
  // measurement that the station was not held back, and must never be produced
  // by a feed that simply does not say. This feed does say.
  assert.equal(by.get('ALPHA').capped, false);
  assert.equal(by.get('BETA').capped, true);
});

test('initialMw is aligned as interval-start, like the NEM field it mirrors', () => {
  const body = solution('2026-08-07T18:35:00+08:00', [{ facilityCode: 'ALPHA_WF1', initialMw: 10 }]);
  const r = foldSolution(body, maps);
  // 18:35 AWST is 10:35 UTC; initialMw describes the interval's start, so the
  // observation belongs at 10:30 UTC. Getting this wrong runs WA one interval
  // late against every weather feature it is compared with.
  assert.equal(new Date(r.at).toISOString(), '2026-08-07T10:30:00.000Z');
  assert.equal(r.settlement_ms, Date.parse('2026-08-07T10:35:00.000Z'));
});

test('a solution with no runs is null rather than a throw', () => {
  assert.equal(bindingRun({ data: { solutionData: [] } }), null);
  assert.equal(foldSolution({ data: { solutionData: [] } }, maps), null);
});

test('a manifest that is not there yet is reported as absent, not as a failure', async () => {
  stubFetch({});
  const statuses = [];
  const feed = createLiveFeed({ base: '/data', onIntervals: () => {}, onStatus: (s) => statuses.push(s) });
  await feed.ready;
  feed.stop();
  assert.equal(statuses.at(-1).absent, true);
  // "Unreachable" claims the server was asked and could not answer. A 404 on a
  // deploy without live ingest means there is nothing to reach, which is a
  // different thing to tell someone.
  assert.doesNotMatch(describeLive(statuses.at(-1)), /unreachable/);
  assert.match(describeLive(statuses.at(-1)), /No live feed on this server/);
});

test('a harvester still catching up says so rather than reporting a stale interval', () => {
  const status = { ok: true, manifest: { starting: true, feeds: { nem: { latest_at: 1 } } } };
  assert.match(describeLive(status, 2_000_000_000_000), /catching up/);
});

// --- what a small instance is allowed to do --------------------------------

test('the heavy feeds are off by default and the budget says so', async () => {
  // Run in a child process: the flags are read once at module load, so a test
  // that set process.env would be asserting against whatever loaded first.
  const { execFileSync } = await import('node:child_process');
  const run = (env) => execFileSync(process.execPath, [
    '-e', "import('./harvester/live.js').then(m => console.log(m.describeBudget()))",
  ], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

  // 512 MB is the smallest Render plan, and the one that was killed. Neither
  // whole-file parse fits in it, so neither may be on without being asked for.
  const small = run({ GRIDSENSE_MEMORY_MB: '512' });
  assert.match(small, /WA 5-minute off/);
  assert.match(small, /next-day settle off/);
  assert.match(small, /raise GRIDSENSE_MEMORY_MB/, 'a disabled feed must say how to enable it');

  const large = run({ GRIDSENSE_MEMORY_MB: '2048' });
  assert.match(large, /WA 5-minute on/);
  assert.match(large, /next-day settle on/);

  // An explicit request beats the budget in both directions.
  assert.match(run({ GRIDSENSE_MEMORY_MB: '512', GRIDSENSE_WA_LIVE: '1' }), /WA 5-minute on/);
  assert.match(run({ GRIDSENSE_MEMORY_MB: '2048', GRIDSENSE_NEXTDAY: '0' }), /next-day settle off/);

  // Retention is disk rather than heap, but a full disk kills the service just
  // as dead, so it follows the same budget.
  assert.match(small, /keeping 12h/);
  assert.match(large, /keeping 36h/);
});
