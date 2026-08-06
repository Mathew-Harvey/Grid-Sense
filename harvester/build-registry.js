// Builds harvester/registry.json: the DUID -> station -> lat/lon/fueltech/capacity
// mapping that everything else depends on.
//
// Spec §2.6 requires stations be resolved via a registry rather than string
// prefix matching, and the live data shows exactly why: BW01..BW04 are
// Bayswater, but BWTR1 — one character further along the same prefix — is
// Broadwater Power Station, a different station in a different fuel class.
// There is no naming rule to exploit: TARONG#1, STAN-1, CALL_B_1, MPP_1 and
// CPP_3 all separate their unit numbers differently.
//
// Two sources, joined, each carrying its own provenance per §4.1:
//
//   AEMO MMSDM (authoritative, no key)     DUID -> STATIONID, region,
//     PARTICIPANT_REGISTRATION.*           dispatch type, schedule type
//                                          STATIONID -> station name
//
//   Open Electricity facilities GeoJSON    station -> lat/lon, fueltech,
//     (CC BY-NC 4.0, attribution required) registered capacity
//
// AEMO has no coordinates and Open Electricity has no DUIDs, so neither source
// alone is sufficient. They join on AEMO STATIONID == Open Electricity
// station_code, which holds for the great majority of the fleet (BAYSW,
// ERARING, LOYYANGA, TARONG, STANWELL all match exactly); the remainder fall
// back to a normalised name match and anything still unresolved is reported
// rather than guessed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAemo, parseAemoTimestamp } from './parse-aemo.js';
import { fetchBuffer, unzipSingle } from './fetch-util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MMSDM_BASE =
  'https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM';
const OE_FACILITIES =
  'https://data.openelectricity.org.au/v3/geo/au_facilities.json';

// Spec §4 controlled vocabulary. Open Electricity's own fuel_tech strings are
// close but not identical, so they are mapped explicitly rather than passed
// through — an unmapped value must fail loudly, not leak a new category into
// the palette and the per-fueltech training targets.
const FUELTECH = {
  coal_black: 'coal_black',
  coal_brown: 'coal_brown',
  gas_ccgt: 'gas_ccgt',
  gas_ocgt: 'gas_ocgt',
  gas_steam: 'gas_steam',
  gas_recip: 'gas_recip',
  gas_wcmg: 'gas_recip',      // waste coal mine gas burns in reciprocating engines
  gas_lfg: 'gas_recip',
  distillate: 'distillate',
  hydro: 'hydro',
  wind: 'wind',
  solar_utility: 'solar_utility',
  solar_thermal: 'solar_utility',
  battery_charging: 'battery_charging',
  battery_discharging: 'battery_discharging',
  battery: 'battery_discharging',
  bioenergy: 'bioenergy',
  bioenergy_biomass: 'bioenergy',
  bioenergy_biogas: 'bioenergy',
  pumps: 'pumps',
};

/** Latest MMSDM month that actually exists — the archive lags the calendar. */
async function latestMmsdmMonth(now = new Date()) {
  for (let back = 1; back <= 6; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const url = `${MMSDM_BASE}/${y}/MMSDM_${y}_${m}/MMSDM_Historical_Data_SQLLoader/DATA/`;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) return { y, m };
    } catch { /* try the month before */ }
  }
  throw new Error('No MMSDM month directory reachable in the last 6 months');
}

async function mmsdmTable(y, m, table) {
  const url =
    `${MMSDM_BASE}/${y}/MMSDM_${y}_${m}/MMSDM_Historical_Data_SQLLoader/DATA/` +
    `PUBLIC_ARCHIVE%23${table}%23FILE01%23${y}${m}010000.zip`;
  const csv = unzipSingle(await fetchBuffer(url));
  // MMSDM archive files carry no END OF REPORT footer, so the count assertion
  // that guards the 5-minute feeds does not apply here.
  const { tables } = parseAemo(csv, { validateCount: false });
  const first = [...tables.values()][0];
  if (!first) throw new Error(`MMSDM table ${table} parsed to nothing`);
  return first.rows;
}

/**
 * DUDETAILSUMMARY is effective-dated: one row per DUID per registration period.
 * Take the record in force now, which is the one whose START_DATE is the latest
 * of those not in the future. Taking the last row in file order silently picks
 * up superseded registrations.
 */
function currentRegistrations(rows, nowMs) {
  const best = new Map();
  for (const r of rows) {
    const start = parseAemoTimestamp(r.START_DATE);
    const end = parseAemoTimestamp(r.END_DATE);
    if (start === null || start > nowMs) continue;
    if (end !== null && end <= nowMs) continue;
    const prev = best.get(r.DUID);
    if (!prev || start > prev._start) best.set(r.DUID, { ...r, _start: start });
  }
  // A DUID whose registration has lapsed entirely still needs resolving if it
  // appears in historical SCADA, so fall back to its most recent record.
  for (const r of rows) {
    if (best.has(r.DUID)) continue;
    const start = parseAemoTimestamp(r.START_DATE) ?? 0;
    const prev = best.get(r.DUID);
    if (!prev || start > prev._start) best.set(r.DUID, { ...r, _start: start });
  }
  return best;
}

const normaliseName = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/\bPOWER STATION\b|\bWIND FARM\b|\bSOLAR FARM\b|\bPOWER\b|\bSTATION\b/g, '')
    .replace(/[^A-Z0-9]/g, '');

export async function buildRegistry({ limit = 60, out = path.join(HERE, 'registry.json') } = {}) {
  const nowMs = Date.now();
  const { y, m } = await latestMmsdmMonth();
  const retrieved = new Date(nowMs).toISOString();

  const [duRows, stRows, oeRaw] = await Promise.all([
    mmsdmTable(y, m, 'DUDETAILSUMMARY'),
    mmsdmTable(y, m, 'STATION'),
    fetch(OE_FACILITIES).then((r) => {
      if (!r.ok) throw new Error(`Open Electricity facilities: HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  const regs = currentRegistrations(duRows, nowMs);
  const stationNames = new Map(stRows.map((r) => [r.STATIONID, r.STATIONNAME]));

  // Index Open Electricity by station_code and by normalised name.
  const oeFeatures = oeRaw.features || [];
  const oeByCode = new Map();
  const oeByName = new Map();
  for (const f of oeFeatures) {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const rec = {
      station_code: p.station_code,
      name: p.name,
      network: p.network,
      state: p.state,
      lon: coords[0],
      lat: coords[1],
      capacity_registered: p.capacity_registered,
      duid_data: p.duid_data || [],
    };
    if (p.station_code) oeByCode.set(String(p.station_code).toUpperCase(), rec);
    const nn = normaliseName(p.name);
    if (nn && !oeByName.has(nn)) oeByName.set(nn, rec);
  }

  // Group DUIDs by AEMO STATIONID.
  const stations = new Map();
  for (const [duid, r] of regs) {
    if (!r.STATIONID) continue;
    let s = stations.get(r.STATIONID);
    if (!s) {
      s = {
        station_id: r.STATIONID,
        station_name: stationNames.get(r.STATIONID) || r.STATIONID,
        network: 'NEM',
        region: r.REGIONID,
        duids: [],
      };
      stations.set(r.STATIONID, s);
    }
    s.duids.push({
      duid,
      dispatch_type: r.DISPATCHTYPE,       // GENERATOR | LOAD | BIDIRECTIONAL
      schedule_type: r.SCHEDULE_TYPE,      // SCHEDULED | SEMI-SCHEDULED | NON-SCHEDULED
      connection_point: r.CONNECTIONPOINTID,
    });
  }

  const unmatched = [];
  const records = [];

  for (const s of stations.values()) {
    const oe =
      oeByCode.get(String(s.station_id).toUpperCase()) ||
      oeByName.get(normaliseName(s.station_name));

    if (!oe) { unmatched.push(s); continue; }

    // Fueltech comes from the unit-level Open Electricity data; a station with
    // mixed units takes the fueltech carrying the most capacity.
    const byFt = new Map();
    for (const u of oe.duid_data) {
      const mapped = FUELTECH[u.fuel_tech];
      if (!mapped) continue;
      byFt.set(mapped, (byFt.get(mapped) || 0) + (u.capacity_registered || 0));
    }
    const fueltech = [...byFt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!fueltech) { unmatched.push(s); continue; }

    // Batteries: the load side is a separate DUID at some stations and the same
    // DUID at others (HPR1 registers BIDIRECTIONAL; HVWWBA1G/HVWWBA1L split).
    // Both conventions get netted at station level, and the sign convention is
    // flagged where it cannot be determined from the registration alone.
    const hasLoad = s.duids.some((d) => d.dispatch_type === 'LOAD');
    const hasBidirectional = s.duids.some((d) => d.dispatch_type === 'BIDIRECTIONAL');
    const isBattery = fueltech.startsWith('battery');

    records.push({
      station_id: s.station_id,
      station_name: s.station_name,
      network: s.network,
      region: s.region,
      fueltech,
      lat: oe.lat,
      lon: oe.lon,
      capacity_mw: oe.capacity_registered,
      unit_count: s.duids.filter((d) => d.dispatch_type !== 'LOAD').length,
      duids: s.duids,
      semi_scheduled: s.duids.some((d) => d.schedule_type === 'SEMI-SCHEDULED'),
      battery_convention: isBattery
        ? (hasBidirectional ? 'bidirectional_single_duid'
          : hasLoad ? 'split_load_generation_duids'
            : 'ambiguous')
        : null,
      source: {
        duids: `AEMO MMSDM ${y}-${m} PARTICIPANT_REGISTRATION.DUDETAILSUMMARY`,
        name: `AEMO MMSDM ${y}-${m} PARTICIPANT_REGISTRATION.STATION`,
        location: 'Open Electricity facilities GeoJSON (CC BY-NC 4.0)',
        retrieved_at: retrieved,
      },
    });
  }

  // WEM stations come from Open Electricity alone: the MMSDM registration
  // tables are NEM-only. WEM facility codes are the DUID equivalent.
  for (const oe of oeByCode.values()) {
    if (oe.network !== 'WEM') continue;
    const byFt = new Map();
    for (const u of oe.duid_data) {
      const mapped = FUELTECH[u.fuel_tech];
      if (!mapped) continue;
      byFt.set(mapped, (byFt.get(mapped) || 0) + (u.capacity_registered || 0));
    }
    const fueltech = [...byFt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!fueltech) continue;
    records.push({
      station_id: oe.station_code,
      station_name: oe.name,
      network: 'WEM',
      region: 'SWIS',
      fueltech,
      lat: oe.lat,
      lon: oe.lon,
      capacity_mw: oe.capacity_registered,
      unit_count: oe.duid_data.length,
      duids: [],   // resolved against live facility codes at ingest
      semi_scheduled: fueltech === 'wind' || fueltech === 'solar_utility',
      battery_convention: fueltech.startsWith('battery') ? 'ambiguous' : null,
      source: {
        duids: 'Open Electricity facilities GeoJSON (CC BY-NC 4.0)',
        name: 'Open Electricity facilities GeoJSON (CC BY-NC 4.0)',
        location: 'Open Electricity facilities GeoJSON (CC BY-NC 4.0)',
        retrieved_at: retrieved,
      },
    });
  }

  records.sort((a, b) => (b.capacity_mw || 0) - (a.capacity_mw || 0));

  // Every resolvable station is kept, because ingest is free: one SCADA file
  // carries all 500-odd DUIDs whether we use 60 of them or all of them, and
  // Loop F cannot reconcile regional totals to 3% against a partial fleet —
  // the top 60 stations are only 69% of resolved capacity.
  //
  // Modelling is the expensive part, so that is what the limit bounds. The
  // modelled set is chosen weather-first rather than capacity-first: taking the
  // largest 60 stations outright yields just 13 renewables, and a dashboard
  // about weather-driven forecasting needs wind and solar, not another coal
  // unit whose output weather does not explain (§2.9).
  const pick = (pred, n) => records.filter(pred).slice(0, n).map((s) => s.station_id);
  const isNem = (s) => s.network === 'NEM';
  const modelled = new Set([
    ...pick((s) => isNem(s) && s.fueltech === 'wind', Math.round(limit * 0.45)),
    ...pick((s) => isNem(s) && s.fueltech === 'solar_utility', Math.round(limit * 0.30)),
    ...pick((s) => isNem(s) && /^(coal|gas)/.test(s.fueltech), Math.round(limit * 0.15)),
    ...pick((s) => isNem(s) && s.fueltech === 'hydro', Math.round(limit * 0.05)),
    ...pick((s) => s.network === 'WEM' && /wind|solar/.test(s.fueltech), Math.round(limit * 0.05)),
  ]);
  for (const s of records) s.modelled = modelled.has(s.station_id);

  await fs.writeFile(
    out,
    JSON.stringify(
      {
        generated_at: retrieved,
        mmsdm_month: `${y}-${m}`,
        model_limit: limit,
        attribution:
          'Station coordinates, capacity and fueltech from Open Electricity ' +
          '(CC BY-NC 4.0). DUID registration and station names from AEMO MMSDM.',
        stations: records,
      },
      null,
      2,
    ) + '\n',
  );

  return { kept: records, modelled: [...modelled], total: records.length, unmatched, month: `${y}-${m}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limit = Number(process.argv[2]) || 60;
  const { kept, modelled, total, unmatched, month } = await buildRegistry({ limit });
  const cap = (a) => Math.round(a.reduce((x, s) => x + (s.capacity_mw || 0), 0));
  console.log(`MMSDM month ${month}: ${total} stations resolved (${cap(kept)} MW), ${modelled.length} modelled`);
  const byFt = {};
  for (const s of kept.filter((s) => s.modelled)) byFt[s.fueltech] = (byFt[s.fueltech] || 0) + 1;
  console.log('Modelled fueltech mix:', byFt);
  if (unmatched.length) {
    console.log(`\n${unmatched.length} stations had no location match and were dropped:`);
    for (const u of unmatched.slice(0, 20)) console.log(`  ${u.station_id}  ${u.station_name}`);
  }
}
