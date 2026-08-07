// Attach WEM facility codes to the SWIS stations already in the registry.
//
// `build-registry.js` resolves the NEM side from AEMO's MMSDM registration
// tables, which have no Western Australian rows at all, so the 54 SWIS stations
// it takes from Open Electricity arrive with coordinates, capacity and fueltech
// but an empty `duids` list — nothing that names them in the WEM SCADA feed.
// This pass fills that in from a live trading day and writes the result back
// into registry.json, so the mapping is a stored fact with a recorded match
// rate rather than something re-derived at every read.
//
// It runs separately from build-registry because rebuilding the NEM side means
// re-downloading the MMSDM archive; there is no reason to disturb 427 stations
// to annotate 54.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchWemFacilities, isStorageFacility } from './wem-registry.js';
import { listArchiveDays, fetchDay } from './backfill-wem.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(HERE, 'registry.json');

// Below this a station has too little of itself in the SCADA feed to model.
const MIN_CAPACITY_MW = 5;

export async function run({ write = true } = {}) {
  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  const swis = registry.stations.filter((s) => s.region === 'SWIS');
  if (swis.length === 0) throw new Error('registry has no SWIS stations');

  const archive = await listArchiveDays();
  const iso = [...archive.keys()].sort().at(-1);
  const rows = await fetchDay(iso, archive.get(iso));
  const facilities = [...new Set(rows.map((r) => r.code))].sort();

  const { matched, unmatched } = matchWemFacilities(swis.map((s) => s.station_id), facilities);

  const BATTERY = /^battery/;
  let capMatched = 0;
  let capTotal = 0;
  let modelled = 0;
  const droppedStorage = [];
  for (const s of swis) {
    capTotal += s.capacity_mw ?? 0;
    let codes = matched.get(s.station_id);
    // A battery co-located with a coal unit is not part of the coal unit.
    if (codes && !BATTERY.test(s.fueltech ?? '')) {
      const keep = codes.filter((c) => !isStorageFacility(c));
      for (const c of codes) if (isStorageFacility(c)) droppedStorage.push(`${c} (from ${s.station_id})`);
      codes = keep.length ? keep : undefined;
    }
    s.wem_facilities = codes ?? [];
    // Weather modelling needs a location and a nameplate to scale against, and
    // a facility in the feed to be scored on. Anything short of all three is
    // ingested where possible but not modelled.
    const eligible = Boolean(codes?.length) && s.located && (s.capacity_mw ?? 0) >= MIN_CAPACITY_MW;
    s.modelled = eligible;
    if (eligible) { modelled++; capMatched += s.capacity_mw ?? 0; }
  }

  console.log(`WEM facility join, against ${iso}`);
  console.log(`  ${facilities.length} facilities in the feed, ${swis.length} SWIS stations in the registry`);
  console.log(`  matched ${facilities.length - unmatched.length} facilities onto ${matched.size} stations`);
  console.log(`  ${modelled} stations modelled, covering ${capMatched.toFixed(0)} MW of ${capTotal.toFixed(0)} MW ` +
    `(${(100 * capMatched / capTotal).toFixed(1)}%)`);
  if (droppedStorage.length) {
    console.log(`  storage excluded from non-storage hosts (${droppedStorage.length}): ${droppedStorage.join(', ')}`);
  }
  if (unmatched.length) {
    // Named, not silently dropped: each is a real WA generator whose output is
    // absent from every WA figure this dashboard shows.
    console.log(`  unmatched facilities (${unmatched.length}): ${unmatched.join(', ')}`);
  }

  if (write) {
    registry.wem = {
      joined_against: iso,
      facilities_in_feed: facilities.length,
      facilities_matched: facilities.length - unmatched.length,
      unmatched_facilities: unmatched,
      storage_excluded: droppedStorage,
      stations_modelled: modelled,
    };
    await fs.writeFile(REGISTRY, JSON.stringify(registry, null, 2));
    console.log(`\nWritten to ${path.relative(process.cwd(), REGISTRY)}`);
  }
  return { matched, unmatched, modelled };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run({ write: !process.argv.includes('--dry-run') });
}
