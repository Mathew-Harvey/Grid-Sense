// What the browser's cache is allowed to let it skip.
//
// This exists because of a bug with no server-side symptom at all. Western
// Australian dispatch was deployed, served, and confirmed at 200 with 1.4 MB
// per day — and the dashboard still said "No Western Australian dispatch under
// /data/wem-dispatch/", because the WA ingest skipped any day already in
// IndexedDB from the eastern feed. Every returning visitor had every day
// cached, so the WA fetch never ran once, and no amount of redeploying could
// change it. The two feeds need two coverage records; asserting that is the
// only way the sharing cannot come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedCoverage } from '../app/js/dataload.js';

const DAYS = ['2026-08-04', '2026-08-05', '2026-08-06'];
const manifest = (extra) => ({ version: 4, stationCount: 92, days: DAYS, ...extra });

test('a manifest written before WA existed covers no WA days', () => {
  const { days, wemDays } = cachedCoverage(manifest(), 92);
  assert.equal(days.size, 3, 'eastern days stay cached — they were genuinely stored');
  assert.equal(wemDays.size, 0, 'WA must re-fetch: nothing recorded it as stored');
});

test('WA coverage is read from its own key, not from the day list', () => {
  const { days, wemDays } = cachedCoverage(manifest({ wem_days: ['2026-08-05'] }), 92);
  assert.deepEqual([...days], DAYS);
  assert.deepEqual([...wemDays], ['2026-08-05']);
  // The day both sets share must not imply the two it does not.
  for (const iso of ['2026-08-04', '2026-08-06']) {
    assert.ok(days.has(iso) && !wemDays.has(iso), `${iso} is cached for the NEM and pending for WA`);
  }
});

test('a stale version or a changed fleet invalidates both feeds together', () => {
  const full = manifest({ wem_days: DAYS });
  for (const [label, cached, count] of [
    ['older cache version', { ...full, version: 3 }, 92],
    ['fleet grew', full, 93],
    ['no cache at all', null, 92],
  ]) {
    const { days, wemDays } = cachedCoverage(cached, count);
    assert.equal(days.size, 0, `${label}: eastern days must re-ingest`);
    assert.equal(wemDays.size, 0, `${label}: WA days must re-ingest`);
  }
});
