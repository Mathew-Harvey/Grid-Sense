// Western Australian dispatch in the shape the rest of the pipeline expects.
//
// The correlation pass and the backtest both consume per-station observations
// with a resolved instant, an output, an available-energy figure and a
// curtailment mask. The NEM path derives those from unit-level rows; WA has a
// simpler feed and two genuine absences, and this is the one place that
// difference is expressed so neither consumer has to know about it:
//
//   uigf_mw is null, because the WEM publishes no available-energy figure.
//   Everything downstream that would forecast against available energy falls
//   back to actual output, which is what `chooseTarget` already does.
//
//   capped is null, not false. The WEM publishes no semi-dispatch cap, so
//   whether a farm was held back is unknown — and the whole pipeline's rule is
//   that an unknown mask must never read as "not curtailed". Consumers test
//   `capped === false` before admitting an interval, so null excludes WA from
//   curtailment-sensitive fits by construction rather than by remembering to.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedAt } from '../app/js/align.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEM_DIR = path.join(HERE, '..', 'data', 'wem-dispatch');

/**
 * Per-station observations from the most recent `days` of WA dispatch.
 *
 * @param {Array<object>} stations registry stations; only SWIS ones are read
 * @param {number} days most recent trading days to load
 * @param {object} [opts]
 * @param {boolean} [opts.admitUnknownMask=false] treat the unknown curtailment
 *        mask as `false` so WA can take part in fits that require an explicitly
 *        uncurtailed interval. The caller is asserting it has stated the
 *        limitation to the reader; nothing here assumes that on its behalf.
 * @returns {Promise<Map<string, Array<object>>>} station_id -> observations
 */
export async function loadWemObservations(stations, days, { admitUnknownMask = false } = {}) {
  const swis = stations.filter((s) => s.region === 'SWIS');
  const wanted = new Set(swis.map((s) => s.station_id));
  const capacityOf = new Map(swis.map((s) => [s.station_id, s.capacity_mw]));
  const byStation = new Map();
  if (wanted.size === 0) return byStation;

  // An absent directory used to return an empty map in silence, which reads
  // downstream as "Western Australia has no stations" rather than "the WA
  // backfill has not run" — the failure this warning exists to name.
  let files;
  try {
    files = (await fs.readdir(WEM_DIR)).sort().slice(-days);
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.warn(
      `No Western Australian dispatch in ${WEM_DIR} — ${wanted.size} SWIS stations ` +
      'will be skipped. Run harvester/backfill-wem.js before this step.',
    );
    return byStation;
  }

  for (const file of files) {
    const day = JSON.parse(await fs.readFile(path.join(WEM_DIR, file), 'utf8'));
    for (const row of day.rows) {
      if (!wanted.has(row.station_id)) continue;
      let list = byStation.get(row.station_id);
      if (!list) byStation.set(row.station_id, (list = []));
      list.push({
        station_id: row.station_id,
        capacity_mw: capacityOf.get(row.station_id) ?? null,
        observed_at: observedAt(row.settlement_ms, 'WEM_QUANTITY'),
        output_mw: row.mw,
        uigf_mw: null,
        cleared_mw: null,
        available_mw: null,
        curtailed_mw: 0,
        capped: admitUnknownMask ? false : null,
        quality: row.quality ?? 'ok',
        units_online: row.facilities ?? 0,
      });
    }
  }

  for (const list of byStation.values()) list.sort((a, b) => a.observed_at - b.observed_at);
  return byStation;
}
