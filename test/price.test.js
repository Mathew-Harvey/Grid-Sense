// The four ways a price layer goes wrong without looking wrong: the intervention
// re-run counted twice, the series aligned one interval off the dispatch it is
// multiplied by, a negative price defended away, and a price outside the market
// band accepted in silence. Everything downstream is revenue, so each of them
// produces a plausible number rather than a visible failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAemoTimestamp } from '../harvester/parse-aemo.js';
import { observedAt } from '../app/js/align.js';
import {
  PRICE_FIELDS,
  MARKET_PRICE_CAP,
  MARKET_PRICE_FLOOR,
  parsePriceTable,
  priceObservedAt,
} from '../harvester/fetch-price.js';
import { summarisePrices, writeSummary } from '../harvester/backfill-price.js';

// The real DISPATCH.PRICE v5 schema, copied from a live DispatchIS file. Using
// the published column list rather than a convenient subset is the point: the
// fields this code wants sit at positions 5, 8, 20 and 46 of seventy, and a
// trimmed fixture would prove nothing about reading them out of the real thing.
const PRICE_COLUMNS = ('SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP,EEP,ROP,'
  + 'APCFLAG,MARKETSUSPENDEDFLAG,LASTCHANGED,RAISE6SECRRP,RAISE6SECROP,RAISE6SECAPCFLAG,'
  + 'RAISE60SECRRP,RAISE60SECROP,RAISE60SECAPCFLAG,RAISE5MINRRP,RAISE5MINROP,RAISE5MINAPCFLAG,'
  + 'RAISEREGRRP,RAISEREGROP,RAISEREGAPCFLAG,LOWER6SECRRP,LOWER6SECROP,LOWER6SECAPCFLAG,'
  + 'LOWER60SECRRP,LOWER60SECROP,LOWER60SECAPCFLAG,LOWER5MINRRP,LOWER5MINROP,LOWER5MINAPCFLAG,'
  + 'LOWERREGRRP,LOWERREGROP,LOWERREGAPCFLAG,PRICE_STATUS,PRE_AP_ENERGY_PRICE,PRE_AP_RAISE6_PRICE,'
  + 'PRE_AP_RAISE60_PRICE,PRE_AP_RAISE5MIN_PRICE,PRE_AP_RAISEREG_PRICE,PRE_AP_LOWER6_PRICE,'
  + 'PRE_AP_LOWER60_PRICE,PRE_AP_LOWER5MIN_PRICE,PRE_AP_LOWERREG_PRICE,RAISE1SECRRP,RAISE1SECROP,'
  + 'RAISE1SECAPCFLAG,LOWER1SECRRP,LOWER1SECROP,LOWER1SECAPCFLAG,PRE_AP_RAISE1_PRICE,'
  + 'PRE_AP_LOWER1_PRICE,CUMUL_PRE_AP_ENERGY_PRICE,CUMUL_PRE_AP_RAISE6_PRICE,'
  + 'CUMUL_PRE_AP_RAISE60_PRICE,CUMUL_PRE_AP_RAISE5MIN_PRICE,CUMUL_PRE_AP_RAISEREG_PRICE,'
  + 'CUMUL_PRE_AP_LOWER6_PRICE,CUMUL_PRE_AP_LOWER60_PRICE,CUMUL_PRE_AP_LOWER5MIN_PRICE,'
  + 'CUMUL_PRE_AP_LOWERREG_PRICE,CUMUL_PRE_AP_RAISE1_PRICE,CUMUL_PRE_AP_LOWER1_PRICE,'
  + 'OCD_STATUS,MII_STATUS').split(',');

const DEFAULTS = {
  SETTLEMENTDATE: '2026/08/06 14:35:00',
  RUNNO: 1,
  REGIONID: 'NSW1',
  DISPATCHINTERVAL: 20260806176,
  INTERVENTION: 0,
  RRP: 100,
  LASTCHANGED: '2026/08/06 14:30:04',
  PRICE_STATUS: 'FIRM',
  OCD_STATUS: 'NOT_OCD',
  MII_STATUS: 'NOT_MII',
};

const QUOTED = new Set(['SETTLEMENTDATE', 'LASTCHANGED']);

function priceLine(overrides) {
  const row = { ...DEFAULTS, ...overrides };
  const fields = PRICE_COLUMNS.map((c) => {
    const v = row[c] ?? 0;
    return QUOTED.has(c) ? `"${v}"` : String(v);
  });
  return `D,DISPATCH,PRICE,5,${fields.join(',')}`;
}

// A whole DispatchIS report around the given price rows, footer included, since
// parseAemo refuses a file whose line count does not agree with its footer.
function report(rows) {
  const lines = [
    'C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,2026/08/06,14:35:12,0000000531300001,DISPATCHIS,0000000531300000',
    `I,DISPATCH,PRICE,5,${PRICE_COLUMNS.join(',')}`,
    ...rows.map(priceLine),
  ];
  return [...lines, `C,"END OF REPORT",${lines.length + 1}`].join('\n');
}

test('an intervention re-run supersedes the base run instead of doubling it', () => {
  // NSW1 was intervened: AEMO publishes what the market would have cleared at
  // and what it actually settled at. VIC1 has only the one run.
  const rows = parsePriceTable(report([
    { REGIONID: 'NSW1', INTERVENTION: 0, RRP: 95 },
    { REGIONID: 'NSW1', INTERVENTION: 1, RRP: 300 },
    { REGIONID: 'VIC1', INTERVENTION: 0, RRP: 88 },
  ]));

  assert.equal(rows.length, 2, 'one row per region per interval, not one per run');

  const nsw = rows.find((r) => r.region === 'NSW1');
  assert.equal(nsw.rrp, 300, 'the run that settled is the one that counts');
  assert.equal(nsw.intervention, 1);
  assert.ok(!rows.some((r) => r.rrp === 95), 'the superseded market run must not survive');

  assert.equal(rows.find((r) => r.region === 'VIC1').rrp, 88);

  // The failure this guards is arithmetic, not structural: taking both runs
  // leaves the row count looking healthy and the region total 95 too high.
  assert.equal(rows.reduce((s, r) => s + r.rrp, 0), 388);
});

test('a price is stamped for the end of its interval, like TOTALCLEARED and unlike SCADAVALUE', () => {
  const settlementMs = parseAemoTimestamp('2026/08/06 14:35:00');
  assert.equal(settlementMs, Date.UTC(2026, 7, 6, 4, 35, 0), 'NEM time is UTC+10, always');

  // The whole point: price and dispatch target describe the same instant, so
  // multiplying them needs no shift. Compared against observedAt rather than a
  // restated constant, so the two cannot drift apart later.
  assert.equal(priceObservedAt(settlementMs), observedAt(settlementMs, 'TOTALCLEARED'));
  assert.equal(priceObservedAt(settlementMs), settlementMs);

  // SCADAVALUE in a row stamped 14:35 was measured at 14:30. A price stamped
  // 14:35 sits five minutes after it, and reading the two as simultaneous is
  // what puts every revenue figure one interval out.
  assert.equal(
    priceObservedAt(settlementMs) - observedAt(settlementMs, 'SCADAVALUE'),
    5 * 60_000,
  );

  // And the row that actually gets written carries that alignment, rather than
  // leaving it to whoever reads the file to reapply.
  const [row] = parsePriceTable(report([{ RRP: 100 }]));
  assert.equal(row.settlement_ms, settlementMs);
  assert.equal(row.observed_at, observedAt(settlementMs, 'TOTALCLEARED'));
});

test('negative prices pass through untouched', () => {
  const rows = parsePriceTable(report([
    { REGIONID: 'SA1', RRP: MARKET_PRICE_FLOOR },
    { REGIONID: 'VIC1', RRP: -757.06643 },
    { REGIONID: 'QLD1', RRP: 0 },
  ]));

  const sa = rows.find((r) => r.region === 'SA1');
  assert.equal(sa.rrp, -1000, 'the floor is a real price, not a sentinel to clamp away');
  assert.equal(typeof sa.rrp, 'number');
  assert.notEqual(sa.rrp, 0);
  assert.equal(sa.out_of_band, false, 'at the floor is inside the band');

  assert.equal(rows.find((r) => r.region === 'VIC1').rrp, -757.06643, 'no rounding, no flooring');

  // Zero is the value a nullish-versus-falsy slip turns into null, and a null
  // price reads downstream as a missing interval rather than a free one.
  const qld = rows.find((r) => r.region === 'QLD1');
  assert.equal(qld.rrp, 0);
  assert.notEqual(qld.rrp, null);

  // Negative FCAS prices are ordinary too, so the same slip must not bite there.
  const fcas = parsePriceTable(report([{ RAISEREGRRP: -12.5, LOWERREGRRP: 0 }]))[0];
  assert.equal(fcas.raise_reg_rrp, -12.5);
  assert.equal(fcas.lower_reg_rrp, 0);
});

test('a price outside the market band is flagged and still carried at its published value', () => {
  const rows = parsePriceTable(report([
    { REGIONID: 'NSW1', RRP: MARKET_PRICE_CAP + 1 },
    { REGIONID: 'SA1', RRP: MARKET_PRICE_FLOOR - 500 },
    { REGIONID: 'VIC1', RRP: MARKET_PRICE_CAP },
    { REGIONID: 'QLD1', RRP: 250 },
  ]));

  const nsw = rows.find((r) => r.region === 'NSW1');
  assert.equal(nsw.out_of_band, true);
  assert.equal(nsw.rrp, MARKET_PRICE_CAP + 1, 'flagged, not clipped to the cap');

  const sa = rows.find((r) => r.region === 'SA1');
  assert.equal(sa.out_of_band, true);
  assert.equal(sa.rrp, -1500, 'flagged, not lifted to the floor');

  // The cap itself is a price AEMO publishes routinely; flagging it would bury
  // the genuine anomalies under every spike in the record.
  assert.equal(rows.find((r) => r.region === 'VIC1').out_of_band, false);
  assert.equal(rows.find((r) => r.region === 'QLD1').out_of_band, false);
});

test('a price row with no RRP fails loudly rather than becoming null', () => {
  const missing = report([{ RRP: '' }]);
  assert.throws(() => parsePriceTable(missing), /No RRP/);
});

test('every controlled price column reaches the row it is meant to', () => {
  const overrides = {};
  const expected = {};
  // Distinct values per column, so a mis-wired mapping cannot pass by accident.
  Object.keys(PRICE_FIELDS).forEach((column, i) => {
    overrides[column] = 10 + i;
    expected[PRICE_FIELDS[column]] = 10 + i;
  });

  const [row] = parsePriceTable(report([overrides]));
  for (const [key, value] of Object.entries(expected)) assert.equal(row[key], value, key);
});

test('summarised figures match an independent recompute, and are what gets written', async () => {
  // Hand-checkable: 8 prices, two negative, two above $300, floor and cap present.
  const prices = [-1000, -100, 0, 50, 100, 200, 400, 17500];
  const intervals = prices.map((rrp, i) => ({
    settlement_ms: Date.UTC(2026, 7, 6, 0, 0, 0) + i * 300_000,
    region: 'NSW1',
    rrp,
  }));

  const { NSW1 } = summarisePrices(intervals);

  assert.equal(NSW1.count, 8);
  assert.equal(NSW1.mean, 17150 / 8);
  assert.equal(NSW1.min, -1000);
  assert.equal(NSW1.max, 17500);

  // Linear interpolation between order statistics: rank = (n-1)p. Checked to a
  // tolerance because (n-1)p is not exact in binary — 7 × 0.95 comes out
  // 6.6499999… — and a percentile over prices spanning four orders of magnitude
  // has no business being asserted to the last bit.
  const nearly = (actual, expected, what) => assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: ${actual} is not ${expected}`,
  );
  nearly(NSW1.median, 75, 'median');   // rank 3.5, between 50 and 100
  nearly(NSW1.p5, -685, 'p5');         // rank 0.35, between -1000 and -100
  nearly(NSW1.p95, 11515, 'p95');      // rank 6.65, between 400 and 17500
  assert.equal(NSW1.negative_intervals, 2);
  assert.equal(NSW1.above_300_intervals, 2);
  assert.equal(NSW1.negative_hours, 2 * 5 / 60);

  // Two regions must not be pooled: an average across a five-region market is a
  // number no generator in it was ever paid.
  const mixed = summarisePrices([
    ...intervals,
    ...prices.map((rrp, i) => ({ settlement_ms: intervals[i].settlement_ms, region: 'SA1', rrp: rrp * 2 })),
  ]);
  assert.equal(mixed.NSW1.mean, NSW1.mean);
  assert.equal(mixed.SA1.mean, NSW1.mean * 2);

  // And what lands in summary.json is that same computation over the day files,
  // so the published figures can always be re-derived from the data they claim
  // to describe.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gridsense-prices-'));
  try {
    const half = intervals.length / 2;
    await fs.writeFile(path.join(dir, '2026-08-05.json'),
      JSON.stringify({ day: '2026-08-05', intervals: intervals.slice(0, half) }));
    await fs.writeFile(path.join(dir, '2026-08-06.json'),
      JSON.stringify({ day: '2026-08-06', intervals: intervals.slice(half) }));

    await writeSummary(dir);
    const written = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf8'));

    assert.equal(written.from, '2026-08-05');
    assert.equal(written.to, '2026-08-06');
    assert.equal(written.days, 2);
    assert.equal(written.intervals, 8);

    // Recomputed from the raw rows on disk, by the route the UI would have to
    // trust if it ever recomputed rather than reading the summary.
    const raw = [];
    for (const name of ['2026-08-05.json', '2026-08-06.json']) {
      raw.push(...JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')).intervals);
    }
    assert.deepEqual(written.regions, summarisePrices(raw));
    assert.deepEqual(written.regions.NSW1, NSW1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
