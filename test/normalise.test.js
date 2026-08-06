// Normalisation: the unit conversion, the two instants inside one dispatch row,
// station aggregation, battery netting and the quality validators.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNIT, toMW, normaliseNemScada, normaliseNemUnitSolution, normaliseWem,
} from '../harvester/normalise.js';
import { pollWindow } from '../harvester/fetch-wem.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'harvester', 'registry.json'), 'utf8'),
);

/** NEM local time is AEST year round, so the UTC instant is always the stamp less ten hours. */
const aest = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 10 * 3600_000;

const station = (over) => ({
  station_id: 'TESTST',
  station_name: 'Test Station',
  network: 'NEM',
  region: 'NSW1',
  fueltech: 'wind',
  lat: -33,
  lon: 151,
  capacity_mw: 100,
  unit_count: 1,
  duids: [],
  semi_scheduled: false,
  battery_convention: null,
  modelled: true,
  ...over,
});

const unit = (duid, dispatchType = 'GENERATOR', scheduleType = 'SCHEDULED') =>
  ({ duid, dispatch_type: dispatchType, schedule_type: scheduleType, connection_point: 'CP' });

const scada = (duid, mw, stamp = '2026/08/06 14:35:00') =>
  ({ SETTLEMENTDATE: stamp, DUID: duid, SCADAVALUE: mw, LASTCHANGED: stamp });

// ---------------------------------------------------------------- unit trap

test('WEM unit conversion: 16.2 MWh over five minutes is 194.4 MW', () => {
  assert.equal(toMW(16.2, UNIT.MWH_PER_INTERVAL, 5), 194.4);
});

test('toMW is the identity for a source already publishing MW', () => {
  assert.equal(toMW(194.4, UNIT.MW, 5), 194.4);
  assert.equal(toMW(-0.019, UNIT.MW, 5), -0.019);
  assert.equal(toMW(null, UNIT.MW, 5), null);
});

test('an undeclared unit throws rather than being guessed from magnitude', () => {
  assert.throws(() => toMW(16.2, undefined, 5), /cannot be inferred/);
  assert.throws(() => toMW(16.2, 'megawatts', 5), /cannot be inferred/);
});

test('a WEM facility reading 16.2 MWh normalises to 194.4 MW', () => {
  const registry = {
    stations: [station({
      station_id: 'COLLIE', network: 'WEM', region: 'SWIS',
      fueltech: 'coal_black', capacity_mw: 340,
    })],
  };
  const { observations } = normaliseWem({
    data: {
      facilityScadaDispatchIntervals: [
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'COLLIE_G1', quantity: 16.2 },
      ],
    },
  }, registry);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].output_mw, 194.4);
  // AWST is UTC+8, and the offset is explicit in the source timestamp.
  assert.equal(observations[0].observed_at, Date.UTC(2026, 7, 5, 0, 0));
});

// -------------------------------------------------------- capacity validator

test('output above 1.15x capacity is suspect, still returned, and counted', () => {
  const registry = { stations: [station({ duids: [unit('T1')], capacity_mw: 100 })] };
  const { observations, counts } = normaliseNemScada([scada('T1', 200)], registry);

  assert.equal(observations.length, 1, 'a suspect reading is stored, not dropped');
  assert.equal(observations[0].output_mw, 200);
  assert.equal(observations[0].quality, 'suspect');
  assert.equal(counts.suspect, 1);
  assert.equal(counts.ok, 0);
});

test('output inside the tolerance band stays ok', () => {
  const registry = { stations: [station({ duids: [unit('T1')], capacity_mw: 100 })] };
  const { observations, counts } = normaliseNemScada([scada('T1', 110)], registry);
  assert.equal(observations[0].quality, 'ok');
  assert.equal(counts.ok, 1);
});

test('a jump larger than the whole operating range in one interval is suspect', () => {
  const registry = { stations: [station({ duids: [unit('T1')], capacity_mw: 100 })] };
  // Both readings are inside capacity; the move between them is not physical.
  const { observations } = normaliseNemScada([
    scada('T1', 95, '2026/08/06 14:35:00'),
    scada('T1', -95, '2026/08/06 14:40:00'),
  ], registry);

  assert.equal(observations.length, 2);
  assert.equal(observations[0].quality, 'ok');
  assert.equal(observations[1].quality, 'suspect');
});

// ---------------------------------------------------------- battery netting

test('a battery with split generation and load DUIDs nets at station level', () => {
  const registry = {
    stations: [station({
      station_id: 'SPLITBESS',
      fueltech: 'battery_discharging',
      capacity_mw: 100,
      unit_count: 2,
      battery_convention: 'split_load_generation_duids',
      duids: [
        unit('SPLITG1'),
        unit('SPLITL1', 'LOAD'),
      ],
    })],
  };

  const { observations } = normaliseNemScada([
    scada('SPLITG1', 50, '2026/08/06 14:35:00'),
    scada('SPLITL1', 0, '2026/08/06 14:35:00'),
    scada('SPLITG1', 0, '2026/08/06 14:40:00'),
    // A load DUID reports consumption as a positive number.
    scada('SPLITL1', 30, '2026/08/06 14:40:00'),
  ], registry);

  assert.equal(observations[0].output_mw, 50, 'discharging is positive');
  assert.equal(observations[1].output_mw, -30, 'charging is negative');
  assert.equal(observations.every((o) => o.quality === 'ok'), true);
});

test('a bidirectional single-DUID battery keeps the sign it publishes', () => {
  const registry = {
    stations: [station({
      station_id: 'HORNSDPR',
      fueltech: 'battery_discharging',
      capacity_mw: 150,
      unit_count: 1,
      battery_convention: 'bidirectional_single_duid',
      duids: [unit('HPR1', 'BIDIRECTIONAL')],
    })],
  };

  const { observations } = normaliseNemScada([
    scada('HPR1', 43.8, '2026/08/06 14:35:00'),
    scada('HPR1', -70.9, '2026/08/06 14:40:00'),
  ], registry);

  assert.equal(observations[0].output_mw, 43.8);
  assert.equal(observations[1].output_mw, -70.9);
  assert.equal(observations.every((o) => o.quality === 'ok'), true);
});

test('a battery registered with generator DUIDs alone is flagged, not guessed', () => {
  const registry = {
    stations: [station({
      station_id: 'AMBIGBESS',
      fueltech: 'battery_charging',
      capacity_mw: 100,
      unit_count: 2,
      battery_convention: 'ambiguous',
      duids: [unit('AMBIG1'), unit('AMBIG2')],
    })],
  };

  const { observations, counts } = normaliseNemScada([
    scada('AMBIG1', 20), scada('AMBIG2', -15),
  ], registry);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].quality, 'suspect');
  assert.equal(counts.suspect, 1);
});

// ------------------------------------------------------------ instant traps

test('a SCADA row stamped 14:35 is a snapshot of 14:30', () => {
  const registry = { stations: [station({ duids: [unit('T1')] })] };
  const { observations } = normaliseNemScada([scada('T1', 40)], registry);
  assert.equal(observations[0].observed_at, aest(2026, 8, 6, 14, 30));
});

test('actual and target in one UNIT_SOLUTION row are five minutes apart', () => {
  const registry = {
    stations: [station({ duids: [unit('WF1', 'GENERATOR', 'SEMI-SCHEDULED')], capacity_mw: 100 })],
  };
  const { observations } = normaliseNemUnitSolution([{
    SETTLEMENTDATE: '2026/08/06 14:35:00',
    DUID: 'WF1',
    INTERVENTION: 0,
    INITIALMW: 40,
    TOTALCLEARED: 45,
    AVAILABILITY: 60,
    UIGF: 60,
    SEMIDISPATCHCAP: 1,
  }], registry);

  assert.equal(observations.length, 2);
  const [actual, target] = observations;

  assert.equal(actual.observed_at, aest(2026, 8, 6, 14, 30));
  assert.equal(actual.output_mw, 40);
  assert.equal(actual.uigf_mw, null);

  assert.equal(target.observed_at, aest(2026, 8, 6, 14, 35));
  assert.equal(target.uigf_mw, 60);
  assert.equal(target.cleared_mw, 45);
  assert.equal(target.available_mw, 60);
  assert.equal(target.curtailed_mw, 15);
  assert.equal(target.capped, true);
  assert.equal(target.output_mw, null, 'the actual for 14:35 arrives in the row stamped 14:40');

  assert.equal(target.observed_at - actual.observed_at, 5 * 60_000);
});

test('consecutive UNIT_SOLUTION rows put actual and target on one instant', () => {
  const registry = {
    stations: [station({ duids: [unit('WF1', 'GENERATOR', 'SEMI-SCHEDULED')], capacity_mw: 100 })],
  };
  const rows = [
    { SETTLEMENTDATE: '2026/08/06 14:35:00', DUID: 'WF1',
      INITIALMW: 40, TOTALCLEARED: 45, AVAILABILITY: 60, UIGF: 60, SEMIDISPATCHCAP: 0 },
    { SETTLEMENTDATE: '2026/08/06 14:40:00', DUID: 'WF1',
      INITIALMW: 44, TOTALCLEARED: 50, AVAILABILITY: 62, UIGF: 62, SEMIDISPATCHCAP: 0 },
  ];
  const { observations } = normaliseNemUnitSolution(rows, registry);

  const at1435 = observations.find((o) => o.observed_at === aest(2026, 8, 6, 14, 35));
  assert.equal(at1435.output_mw, 44, 'actual at 14:35 is the 14:40 row INITIALMW');
  assert.equal(at1435.uigf_mw, 60, 'forecast for 14:35 is the 14:35 row UIGF');
});

test('UIGF is read from semi-scheduled units only', () => {
  const registry = {
    stations: [station({
      station_id: 'COALST', fueltech: 'coal_black', capacity_mw: 700, duids: [unit('C1')],
    })],
  };
  // Scheduled plant publishes UIGF as 0, not null: taking it would report the
  // whole unit as curtailed.
  const { observations } = normaliseNemUnitSolution([{
    SETTLEMENTDATE: '2026/08/06 14:35:00', DUID: 'C1',
    INITIALMW: 660, TOTALCLEARED: 665, AVAILABILITY: 690, UIGF: 0, SEMIDISPATCHCAP: 0,
  }], registry);

  const target = observations.find((o) => o.observed_at === aest(2026, 8, 6, 14, 35));
  assert.equal(target.uigf_mw, null);
  assert.equal(target.curtailed_mw, null);
  assert.equal(target.capped, false);
});

// ------------------------------------------------------- station aggregation

test('four DUIDs aggregate to the station, and only units above 1 MW are online', () => {
  const registry = {
    stations: [station({
      station_id: 'BIGCOAL', fueltech: 'coal_black', capacity_mw: 2000, unit_count: 4,
      duids: [unit('U1'), unit('U2'), unit('U3'), unit('U4')],
    })],
  };
  const { observations, counts } = normaliseNemScada([
    scada('U1', 660), scada('U2', 0.5), scada('U3', 500), scada('U4', 0),
  ], registry);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].output_mw, 1160.5);
  assert.equal(observations[0].units_online, 2);
  assert.equal(observations[0].unit_count, 4);
  assert.equal(observations[0].quality, 'ok');
  assert.equal(counts.observations, 1);
});

test('a unit missing from one interval makes that interval partial', () => {
  const registry = {
    stations: [station({
      station_id: 'TWOUNIT', capacity_mw: 200, unit_count: 2, duids: [unit('U1'), unit('U2')],
    })],
  };
  const { observations, counts } = normaliseNemScada([
    scada('U1', 80, '2026/08/06 14:35:00'),
    scada('U2', 70, '2026/08/06 14:35:00'),
    scada('U1', 85, '2026/08/06 14:40:00'),
  ], registry);

  assert.equal(observations[0].quality, 'ok');
  assert.equal(observations[1].quality, 'partial');
  assert.equal(observations[1].output_mw, 85);
  assert.equal(counts.partial, 1);
});

// ------------------------------------------------------------ unknown units

test('a DUID absent from the registry is reported, not fatal', () => {
  const registry = { stations: [station({ duids: [unit('T1')] })] };
  const { observations, unknown_units, counts } = normaliseNemScada([
    scada('T1', 40), scada('NOTREAL1', 12), scada('NOTREAL1', 12, '2026/08/06 14:40:00'),
  ], registry);

  assert.deepEqual(unknown_units, ['NOTREAL1']);
  assert.equal(counts.unknown_units, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].station_id, 'TESTST');
});

test('an unmatched WEM facility code is reported, not fatal', () => {
  const { observations, unknown_units } = normaliseWem({
    data: {
      facilityScadaDispatchIntervals: [
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'YANDIN_WF1', quantity: 10 },
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'NOT_A_FACILITY_G1', quantity: 5 },
      ],
    },
  }, REGISTRY);

  assert.deepEqual(unknown_units, ['NOT_A_FACILITY_G1']);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].station_id, 'YANDIN');
});

// ------------------------------------- WEM facility to station, real registry

test('a storage facility is not folded into the thermal station sharing its prefix', () => {
  const { observations, unknown_units } = normaliseWem({
    data: {
      facilityScadaDispatchIntervals: [
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'COLLIE_G1', quantity: 26.947 },
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'COLLIE_ESR1', quantity: -8 },
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'KWINANA_ESR1', quantity: 4 },
        { dispatchInterval: '2026-08-05T08:00:00+08:00', code: 'KWINANA_GT2', quantity: 5 },
      ],
    },
  }, REGISTRY);

  const byStation = new Map(observations.map((o) => [o.station_id, o]));
  assert.equal(byStation.get('COLLIE').output_mw, 323.364, 'the coal unit alone');
  assert.equal(byStation.get('KWINANA_ESR').output_mw, 48, 'the battery, not the coal station');
  assert.equal(byStation.get('KWINANA').output_mw, 60);
  // No battery station is registered at Collie, so the BESS is reported rather
  // than attributed to the coal unit.
  assert.deepEqual(unknown_units, ['COLLIE_ESR1']);
});

test('every WEM station in the registry keeps its own facilities separate', () => {
  const codes = ['MUJA_G7', 'MUJA_G8', 'PINJAR_GT1', 'PINJAR_GT10', 'ALBANY_WF1'];
  const { observations } = normaliseWem({
    data: {
      facilityScadaDispatchIntervals: codes.map((code) => ({
        dispatchInterval: '2026-08-05T08:00:00+08:00', code, quantity: 1,
      })),
    },
  }, REGISTRY);

  const byStation = new Map(observations.map((o) => [o.station_id, o]));
  assert.equal(byStation.get('MUJA').units_online, 2);
  assert.equal(byStation.get('MUJA').output_mw, 24);
  assert.equal(byStation.get('PINJAR').units_online, 2);
  assert.equal(byStation.get('ALBANY').units_online, 1);
});

// ----------------------------------------------------------- the offset trap

test('a WEM timestamp without an explicit offset is refused, not read as local time', () => {
  const rows = (dispatchInterval) => ({
    data: { facilityScadaDispatchIntervals: [{ dispatchInterval, code: 'COLLIE_G1', quantity: 16.2 }] },
  });
  // Date.parse would read these in the host timezone, putting the interval
  // anywhere from 00:00Z to 12:00Z depending on which machine ran the harvest.
  assert.throws(() => normaliseWem(rows('2026-08-05T08:00:00'), REGISTRY), /no UTC offset/);
  assert.throws(() => normaliseWem(rows('2026-08-05 08:00:00'), REGISTRY), /no UTC offset/);
  assert.throws(() => normaliseWem(rows(null), REGISTRY), /no UTC offset/);
});

test('the host timezone cannot move a WEM interval', () => {
  const previous = process.env.TZ;
  const build = (dispatchInterval) => ({
    data: { facilityScadaDispatchIntervals: [{ dispatchInterval, code: 'COLLIE_G1', quantity: 16.2 }] },
  });
  try {
    const drifted = new Set();
    const parsed = new Set();
    for (const tz of ['UTC', 'Australia/Perth', 'America/New_York']) {
      process.env.TZ = tz;
      // The hazard has to be shown to be live in this runtime, otherwise the
      // assertion below passes for the wrong reason on a host that ignores TZ.
      drifted.add(Date.parse('2026-08-05T08:00:00'));
      assert.throws(() => normaliseWem(build('2026-08-05T08:00:00'), REGISTRY), /no UTC offset/);
      parsed.add(normaliseWem(build('2026-08-05T08:00:00+08:00'), REGISTRY).observations[0].observed_at);
    }
    assert.equal(drifted.size, 3, 'an offset-less stamp really does move with the host clock');
    assert.equal(parsed.size, 1, 'a stamp carrying its offset does not');
    assert.equal([...parsed][0], Date.UTC(2026, 7, 5, 0, 0));
  } finally {
    process.env.TZ = previous;
  }
});

// --------------------------------------------------------- charging is online

test('a battery drawing power is online, not reported as a stopped station', () => {
  const registry = {
    stations: [station({
      station_id: 'SPLITBESS',
      fueltech: 'battery_discharging',
      capacity_mw: 100,
      unit_count: 2,
      duids: [unit('SPLITG1'), unit('SPLITL1', 'LOAD')],
    })],
  };
  const { observations } = normaliseNemScada([
    scada('SPLITG1', 0), scada('SPLITL1', 60),
  ], registry);

  assert.equal(observations[0].output_mw, -60, 'charging still nets negative');
  assert.equal(observations[0].units_online, 1, 'a unit consuming 60 MW is running');
});

test('a bidirectional battery charging counts as online', () => {
  const registry = {
    stations: [station({
      station_id: 'HORNSDPR', fueltech: 'battery_discharging', capacity_mw: 150,
      unit_count: 1, duids: [unit('HPR1', 'BIDIRECTIONAL')],
    })],
  };
  const { observations } = normaliseNemScada([scada('HPR1', -70.9)], registry);
  assert.equal(observations[0].output_mw, -70.9);
  assert.equal(observations[0].units_online, 1);
});

test('a unit idling below the floor is still not online, in either direction', () => {
  const registry = {
    stations: [station({
      station_id: 'SPLITBESS', fueltech: 'battery_discharging', capacity_mw: 100,
      unit_count: 2, duids: [unit('SPLITG1'), unit('SPLITL1', 'LOAD')],
    })],
  };
  const { observations } = normaliseNemScada([
    scada('SPLITG1', 0.4), scada('SPLITL1', 0.6),
  ], registry);
  assert.equal(observations[0].units_online, 0, 'house load is not generation');
});

// ------------------------------------------------- ramp check across a poll

const wemDay = (rows) => ({
  data: {
    facilityScadaDispatchIntervals: rows.map(([stamp, quantity]) => ({
      dispatchInterval: stamp, code: 'COLLIE_G1', quantity,
    })),
  },
});

const collie = {
  stations: [station({
    station_id: 'COLLIE', network: 'WEM', region: 'SWIS',
    fueltech: 'coal_black', capacity_mw: 340,
  })],
};

test('a poll keeps enough context for the ramp check to fire on its first interval', () => {
  // Two intervals five minutes apart, moving further than the whole operating
  // range. Only the second is new to this poll, so without retained context the
  // ramp has nothing to be measured against.
  const day = wemDay([
    ['2026-08-05T08:00:00+08:00', 27],
    ['2026-08-05T08:05:00+08:00', -27],
  ]);
  const { observations, counts } = pollWindow([day], collie, Date.UTC(2026, 7, 5, 0, 0));

  assert.equal(observations.length, 1, 'the already-ingested interval is not emitted again');
  assert.equal(observations[0].observed_at, Date.UTC(2026, 7, 5, 0, 5));
  assert.equal(observations[0].quality, 'suspect', 'the ramp off the previous interval is seen');
  assert.equal(counts.observations, 1, 'counts describe what is returned');
  assert.equal(counts.suspect, 1);
  assert.equal(counts.ok, 0);
});

test('a poll does not re-emit intervals it has already ingested', () => {
  const day = wemDay([
    ['2026-08-05T08:00:00+08:00', 20],
    ['2026-08-05T08:05:00+08:00', 21],
    ['2026-08-05T08:10:00+08:00', 22],
  ]);
  const { observations, counts } = pollWindow([day], collie, Date.UTC(2026, 7, 5, 0, 5));

  assert.deepEqual(observations.map((o) => o.observed_at), [Date.UTC(2026, 7, 5, 0, 10)]);
  assert.equal(counts.observations, 1);
  assert.equal(counts.ok, 1);
});

test('a cold poll takes the whole published day', () => {
  const day = wemDay([
    ['2026-08-05T08:00:00+08:00', 20],
    ['2026-08-05T08:05:00+08:00', 21],
  ]);
  const { observations, counts } = pollWindow([day], collie, null);
  assert.equal(observations.length, 2);
  assert.equal(counts.observations, 2);
});
