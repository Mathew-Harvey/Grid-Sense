// Every observation in GridSense, from either market, is produced here. Below
// this file there is a NEM path and a WEM path; above it there is one schema
// and one set of quality rules.
//
// Two traps live here and nowhere else.
//
// The unit trap. WEM's facilityScada reports energy per interval, not power,
// and both readings look plausible: a 340 MW coal unit reading 27 sits quietly
// at 8% of capacity all day, every day, and nothing about the number itself
// says which it is. So the unit travels with the value from its source and is
// converted once, by name, in toMW. Nothing infers a unit from a magnitude.
//
// The instant trap. AEMO stamps a dispatch interval with its END time, but the
// fields inside one row are not all measured at that instant. SCADAVALUE and
// INITIALMW are snapshots taken as the interval opened, five minutes before the
// stamp; TOTALCLEARED, AVAILABILITY and UIGF are targets for its close. Filing
// them under one timestamp shifts actual output a whole interval against
// everything it gets compared with — on regional reconciliation that single
// mistake is worth two to three times the total error. So one UNIT_SOLUTION row
// contributes to two observations, five minutes apart, and the actual output at
// instant T arrives from the row stamped T + 5min.

import { parseAemoTimestamp } from './parse-aemo.js';

const INTERVAL_MS = 5 * 60_000;

// Telemetry above this multiple of registered capacity is not a record output,
// it is a broken sensor or a mis-mapped unit.
const CAPACITY_TOLERANCE = 1.15;

// A unit idling on house load reads a fraction of a MW, so "online" needs a
// floor above zero rather than a test against it. The test is on magnitude: a
// battery drawing 60 MW to charge is unambiguously running, and a signed test
// would report the whole station as offline for every charging interval —
// exactly the half of a battery's duty cycle that a charge/discharge model
// needs to see.
const ONLINE_MW = 1;

export const UNIT = { MW: 'MW', MWH_PER_INTERVAL: 'MWh_per_interval' };

/**
 * The one conversion into MW. Callers state the unit their source publishes;
 * they never guess it from the value.
 *
 * @param {number|null} value
 * @param {string} unit one of UNIT
 * @param {number} intervalMinutes length of the interval an energy figure covers
 * @returns {number|null} MW
 */
export function toMW(value, unit, intervalMinutes) {
  if (value == null) return null;
  if (unit === UNIT.MW) return value;
  if (unit === UNIT.MWH_PER_INTERVAL) {
    // Scaling up before dividing keeps whole-MWh readings on exact MW: 16.2 * 12
    // lands on 194.39999999999998, 16.2 * 60 / 5 lands on 194.4.
    return (value * 60) / intervalMinutes;
  }
  throw new Error(`Unknown unit ${JSON.stringify(unit)}: a source must declare its unit, it cannot be inferred.`);
}

/** Sums of float telemetry accumulate noise; kW resolution is well past what SCADA carries. */
const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

const ISO_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a WEMDE timestamp, which must carry its UTC offset.
 *
 * This is the time equivalent of the unit trap, and it fails the same silent
 * way. `Date.parse("2026-08-05T08:00:00")` — an ISO date-time with no offset —
 * is defined to mean *host local time*, so the same file yields 00:00Z on a
 * Perth box, 08:00Z here and 12:00Z on a US-east box. Nothing throws and no row
 * is dropped; every observation simply lands on the wrong instant, and the
 * weather alignment downstream then correlates output against the wrong hour of
 * sun. An offset is present on every row AEMO publishes today, so demand it
 * rather than inherit whatever the host clock happens to be set to.
 *
 * @param {string} s ISO-8601 with an explicit offset, e.g. 2026-08-05T08:00:00+08:00
 * @returns {number} UTC epoch ms
 */
export function parseWemTimestamp(s) {
  if (typeof s !== 'string' || !ISO_OFFSET.test(s.trim())) {
    throw new Error(
      `WEM timestamp ${JSON.stringify(s)} carries no UTC offset. ` +
      `A timestamp without a declared offset cannot be read, only guessed at from the host timezone.`
    );
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Unparseable WEM timestamp ${JSON.stringify(s)}`);
  return t;
}

function duidIndex(registry) {
  const index = new Map();
  for (const s of registry.stations) {
    for (const d of s.duids) {
      index.set(d.duid, { station: s, dispatchType: d.dispatch_type, scheduleType: d.schedule_type });
    }
  }
  return index;
}

/**
 * AEMO reports a load DUID's consumption as a positive number, so a battery
 * charging leg or a pump station only nets correctly if the load is subtracted.
 * A DUID registered BIDIRECTIONAL already carries the sign itself: negative is
 * charging.
 */
function signed(mw, dispatchType) {
  if (mw == null) return null;
  return dispatchType === 'LOAD' ? -mw : mw;
}

/**
 * A battery registered with generator DUIDs alone gives no way to tell a
 * charging interval from a sign error, because both look like a negative
 * generator. Nothing downstream can recover that, so the station is marked
 * rather than netted on a guess.
 */
function signAmbiguous(station) {
  if (!station.fueltech?.startsWith('battery')) return false;
  return station.duids.length > 0 && station.duids.every((d) => d.dispatch_type === 'GENERATOR');
}

function bucketFor(buckets, station, observedAt) {
  const key = `${station.station_id}|${observedAt}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      station,
      observedAt,
      output: null,
      cleared: null,
      available: null,
      uigf: null,
      clearedSemi: null,
      capped: null,
      online: 0,
      actualUnits: new Set(),
      targetUnits: new Set(),
    };
    buckets.set(key, b);
  }
  return b;
}

/**
 * A station's expected unit set is the units that reported anywhere in this
 * batch, not the units on its registration. Registration lists auxiliary and
 * retired DUIDs that never dispatch — 446 of the registry's 1,012 NEM DUIDs
 * appear in no interval of a full day — so measuring against it would mark
 * two stations in five permanently partial and make the flag meaningless.
 */
function noteUnit(expected, station, unit) {
  let set = expected.get(station.station_id);
  if (!set) expected.set(station.station_id, (set = new Set()));
  set.add(unit);
}

/**
 * The only ramp bound that is genuinely impossible rather than merely unusual:
 * a station cannot traverse more than its whole operating range inside one
 * five-minute interval. A unit tripping is a real full-to-zero move in seconds,
 * so any tighter bound flags hundreds of legitimate intervals a day. A battery
 * runs from full charge to full discharge, so its range is twice its capacity.
 */
function impossibleRamp(station, output, prev) {
  if (prev == null || output == null || !station.capacity_mw) return false;
  const range = station.fueltech?.startsWith('battery') ? 2 * station.capacity_mw : station.capacity_mw;
  return Math.abs(output - prev) > range;
}

/**
 * Turn accumulated buckets into canonical observations, applying the quality
 * rules. Quality is only ever set here — a caller that could set it by hand
 * would eventually set it to whatever made its own numbers look better.
 */
function assemble(buckets, expected) {
  const byStation = new Map();
  for (const b of buckets.values()) {
    let list = byStation.get(b.station.station_id);
    if (!list) byStation.set(b.station.station_id, (list = []));
    list.push(b);
  }

  const observations = [];
  const counts = { observations: 0, ok: 0, partial: 0, suspect: 0 };

  for (const [stationId, list] of byStation) {
    list.sort((a, b) => a.observedAt - b.observedAt);
    const expectedUnits = expected.get(stationId)?.size ?? 0;
    const station = list[0].station;
    const ambiguous = signAmbiguous(station);
    let prev = null;

    for (const b of list) {
      // A station is only short of units on a side that reported at all: at the
      // edges of a batch one side is legitimately absent altogether.
      const short =
        (b.actualUnits.size > 0 && b.actualUnits.size < expectedUnits) ||
        (b.targetUnits.size > 0 && b.targetUnits.size < expectedUnits);

      const overCapacity =
        b.output != null && station.capacity_mw > 0 &&
        Math.abs(b.output) > CAPACITY_TOLERANCE * station.capacity_mw;

      const ramped =
        prev != null && prev.observedAt === b.observedAt - INTERVAL_MS &&
        impossibleRamp(station, b.output, prev.output);

      const quality = (ambiguous || overCapacity || ramped) ? 'suspect' : (short ? 'partial' : 'ok');
      counts[quality]++;
      counts.observations++;

      observations.push({
        station_id: station.station_id,
        station_name: station.station_name,
        network: station.network,
        region: station.region,
        fueltech: station.fueltech,
        lat: station.lat,
        lon: station.lon,
        capacity_mw: station.capacity_mw,
        observed_at: b.observedAt,
        output_mw: round3(b.output),
        available_mw: round3(b.available),
        cleared_mw: round3(b.cleared),
        uigf_mw: round3(b.uigf),
        curtailed_mw: b.uigf == null ? null : round3(Math.max(0, b.uigf - (b.clearedSemi ?? 0))),
        capped: b.capped,
        unit_count: station.unit_count,
        // Zero units online is a real reading; no units reporting is not, and
        // the two must not collapse into the same number.
        units_online: b.actualUnits.size > 0 ? b.online : null,
        quality,
      });

      prev = b;
    }
  }

  observations.sort((a, b) => a.observed_at - b.observed_at || (a.station_id < b.station_id ? -1 : 1));
  return { observations, counts };
}

function withUnknown(result, unknown) {
  return {
    observations: result.observations,
    unknown_units: [...unknown].sort(),
    counts: { ...result.counts, unknown_units: unknown.size },
  };
}

/**
 * Normalise DISPATCH.UNIT_SCADA rows, aggregating DUIDs to their station.
 *
 * This is the only unit-level feed published in real time, so it carries actual
 * output and nothing else. capped is left null rather than false: AEMO does not
 * publish the semi-dispatch cap until the next day, and recording false would
 * assert an interval was uncurtailed when that is simply not yet known.
 *
 * @param {object[]} rows parsed UNIT_SCADA rows
 * @param {{stations: object[]}} registry
 * @returns {{observations: object[], unknown_units: string[], counts: object}}
 */
export function normaliseNemScada(rows, registry) {
  const index = duidIndex(registry);
  const buckets = new Map();
  const expected = new Map();
  const unknown = new Set();

  for (const r of rows) {
    const meta = index.get(r.DUID);
    if (!meta) { unknown.add(r.DUID); continue; }

    const t = parseAemoTimestamp(r.SETTLEMENTDATE);
    if (t == null) continue;

    noteUnit(expected, meta.station, r.DUID);
    const b = bucketFor(buckets, meta.station, t - INTERVAL_MS);
    const mw = signed(r.SCADAVALUE, meta.dispatchType);
    b.actualUnits.add(r.DUID);
    if (mw != null) {
      b.output = (b.output ?? 0) + mw;
      if (Math.abs(mw) > ONLINE_MW) b.online++;
    }
  }

  return withUnknown(assemble(buckets, expected), unknown);
}

/**
 * Normalise DISPATCH.UNIT_SOLUTION rows, the next-day table that carries the
 * fields the real-time feeds withhold.
 *
 * UIGF is read only from SEMI-SCHEDULED DUIDs. Scheduled plant reports UIGF as
 * 0 rather than null, so taking it everywhere would report a 660 MW coal unit
 * as 660 MW curtailed against a forecast of nothing.
 *
 * @param {object[]} rows parsed UNIT_SOLUTION rows
 * @param {{stations: object[]}} registry
 * @returns {{observations: object[], unknown_units: string[], counts: object}}
 */
export function normaliseNemUnitSolution(rows, registry) {
  const index = duidIndex(registry);
  const buckets = new Map();
  const expected = new Map();
  const unknown = new Set();

  for (const r of rows) {
    const meta = index.get(r.DUID);
    if (!meta) { unknown.add(r.DUID); continue; }

    const t = parseAemoTimestamp(r.SETTLEMENTDATE);
    if (t == null) continue;
    noteUnit(expected, meta.station, r.DUID);

    const actual = bucketFor(buckets, meta.station, t - INTERVAL_MS);
    const mw = signed(r.INITIALMW, meta.dispatchType);
    actual.actualUnits.add(r.DUID);
    if (mw != null) {
      actual.output = (actual.output ?? 0) + mw;
      if (Math.abs(mw) > ONLINE_MW) actual.online++;
    }

    const target = bucketFor(buckets, meta.station, t);
    target.targetUnits.add(r.DUID);
    const cleared = signed(r.TOTALCLEARED, meta.dispatchType);
    if (cleared != null) target.cleared = (target.cleared ?? 0) + cleared;
    // A load leg's availability is charging capability, not generation, so it
    // cannot be added to the station's ability to produce.
    if (r.AVAILABILITY != null && meta.dispatchType !== 'LOAD') {
      target.available = (target.available ?? 0) + r.AVAILABILITY;
    }
    target.capped = (target.capped ?? false) || r.SEMIDISPATCHCAP === 1;
    if (meta.scheduleType === 'SEMI-SCHEDULED') {
      if (r.UIGF != null) target.uigf = (target.uigf ?? 0) + r.UIGF;
      // Curtailment is forecast minus target for the semi-scheduled units
      // alone; a wind farm sharing a station with a gas unit would otherwise
      // have the gas unit's target subtracted from its wind forecast.
      if (cleared != null) target.clearedSemi = (target.clearedSemi ?? 0) + cleared;
    }
  }

  return withUnknown(assemble(buckets, expected), unknown);
}

// WEM facility codes are a station code plus a unit suffix — COLLIE_G1,
// PINJAR_GT10, KWINANA_ESR1 — so the longest matching station code wins:
// KWINANA_ESR1 is the Kwinana battery, not a fifth unit of Kwinana coal.
const STORAGE_FACILITY = /_(ESR|BESS)\d*$/;

function matchesStation(code, stationId) {
  if (code === stationId) return true;
  if (!code.startsWith(stationId)) return false;
  const next = code[stationId.length];
  return next === '_' || (next >= '0' && next <= '9');
}

function facilityIndex(registry) {
  const stations = registry.stations
    .filter((s) => s.network === 'WEM')
    .sort((a, b) => b.station_id.length - a.station_id.length);

  return (code) => {
    for (const s of stations) {
      if (!matchesStation(code, s.station_id)) continue;
      // Storage facilities share a prefix with the thermal station beside them
      // — the Collie BESS units sit at Collie Power Station — and folding a
      // battery's charge and discharge into a coal unit's output would corrupt
      // both. Better reported as unmatched than silently attributed.
      if (STORAGE_FACILITY.test(code) && !s.fueltech?.startsWith('battery')) continue;
      return s;
    }
    return null;
  };
}

/**
 * Normalise a WEMDE facilityScada trading-day file.
 *
 * quantity is MWh per five-minute interval, not MW — verified against
 * registered capacity, see FLAGS.md F2 — and dispatchInterval must carry an
 * explicit offset, which is checked rather than assumed so no host timezone can
 * reinterpret the instant.
 * WEM publishes no dispatch target, forecast or cap, so those fields stay null;
 * the facility series is already signed net, positive out and negative in.
 *
 * @param {object} json parsed SCADA_YYYY-MM-DD.json
 * @param {{stations: object[]}} registry
 * @returns {{observations: object[], unknown_units: string[], counts: object}}
 */
export function normaliseWem(json, registry) {
  const findStation = facilityIndex(registry);
  const buckets = new Map();
  const expected = new Map();
  const unknown = new Set();

  for (const r of json.data.facilityScadaDispatchIntervals) {
    const station = findStation(r.code);
    if (!station) { unknown.add(r.code); continue; }

    // WEMDE stamps an interval with its start: a trading day runs 08:00 to
    // 07:55, which only closes if 08:00 is the first interval's opening.
    const t = parseWemTimestamp(r.dispatchInterval);

    noteUnit(expected, station, r.code);
    const b = bucketFor(buckets, station, t);
    const mw = toMW(r.quantity, UNIT.MWH_PER_INTERVAL, 5);
    b.actualUnits.add(r.code);
    if (mw != null) {
      b.output = (b.output ?? 0) + mw;
      if (Math.abs(mw) > ONLINE_MW) b.online++;
    }
  }

  return withUnknown(assemble(buckets, expected), unknown);
}
