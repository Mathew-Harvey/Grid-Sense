// Joining Western Australia's SCADA facilities to the station registry.
//
// The two sides name things differently. Open Electricity lists a WEM station
// by a short code — ALBANY, BLUEWATERS, COLLIE. AEMO's WEM SCADA reports at
// facility level, and a facility code is the station's code with unit and
// owner decoration around it: ALBANY_WF1, BW1_BLUEWATERS_G2, COLLIE_ESR4.
// There is no published crosswalk, so the join is inferred — and inferring a
// join is exactly the kind of step that quietly attaches a wind farm's output
// to a coal station and shows up as a skill score rather than an error.
//
// The rule is therefore the narrowest one that works: a station matches when
// its code appears as a run of *whole* underscore-delimited tokens inside the
// facility code. Substring matching would join GREENOUGH to GREENOUGH_RIVER
// and also to anything that merely contains those letters; token-run matching
// cannot, because a token boundary is a real separator in this vocabulary.
//
// Measured against a full trading day (2026-08-01, 76 facilities, 54 stations):
// exact-or-prefix alone reaches 67 facilities and 90.8% of registered capacity;
// the token run reaches 70 facilities, 48 stations and 97.7% of capacity, and
// the difference is stations like Bluewaters whose owner prefix sits in front
// of the station name. The six facilities that never match are recorded by the
// runner rather than force-fitted.

/**
 * Which facility codes belong to which station code.
 *
 * @param {string[]} stationCodes registry/Open Electricity station codes
 * @param {string[]} facilityCodes codes as they appear in WEM SCADA
 * @returns {{matched: Map<string, string[]>, unmatched: string[]}}
 */
export function matchWemFacilities(stationCodes, facilityCodes) {
  const tokenised = stationCodes.map((code) => ({ code, tokens: code.split('_') }));
  const matched = new Map();
  const unmatched = [];

  for (const facility of facilityCodes) {
    const tokens = facility.split('_');
    // Longest station code first: COLLIE and COLLIE_BESS would both run inside
    // COLLIE_BESS2, and the more specific one is the right owner.
    const hit = tokenised
      .filter((s) => containsRun(tokens, s.tokens))
      .sort((a, b) => b.code.length - a.code.length)[0];

    if (!hit) {
      unmatched.push(facility);
      continue;
    }
    if (!matched.has(hit.code)) matched.set(hit.code, []);
    matched.get(hit.code).push(facility);
  }

  for (const list of matched.values()) list.sort();
  return { matched, unmatched };
}

/** Do `needle`'s tokens appear consecutively inside `haystack`'s? */
function containsRun(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// WEM's registered classes for storage: BESS is a battery energy storage
// system, ESR an Electric Storage Resource. Both appear as their own facilities
// under a host station's name — COLLIE_ESR1 alongside COLLIE_G1 — and Open
// Electricity carries no separate entry for most of them, so a code-based join
// sweeps them into whatever station shares the name.
//
// That is not a cosmetic mis-attribution. Collie is a 318 MW coal station in
// the registry; folding four storage facilities into it produced a 907 MW
// "coal station", three times its nameplate, whose output no longer describes
// any physical machine. Storage is excluded from a host station that is not
// itself registered as storage, and the exclusion is reported rather than
// applied silently.
const STORAGE_TOKEN = /^(BESS|ESR)\d*$/;

/**
 * Is this facility a storage unit sitting under another station's name?
 *
 * @param {string} facilityCode
 * @returns {boolean}
 */
export function isStorageFacility(facilityCode) {
  return facilityCode.split('_').some((t) => STORAGE_TOKEN.test(t));
}

/**
 * Megawatts from a WEM SCADA quantity.
 *
 * `quantity` is energy over the five-minute interval in MWh, not average power,
 * post-reform as well as pre-reform — the trap FLAGS F2 documents. Read as MW
 * it puts every WA station at a twelfth of its real output, which looks like a
 * plausible capacity factor rather than like a bug.
 *
 * @param {number} quantityMwh energy in the interval
 * @returns {number} MW
 */
export function wemQuantityToMw(quantityMwh) {
  return quantityMwh * 12;
}

/**
 * WEM dispatch intervals are stamped in AWST with an explicit offset, and the
 * stamp is the interval's end — the same convention the NEM uses. Everything
 * downstream keys on UTC epoch milliseconds.
 *
 * @param {string} dispatchInterval e.g. "2026-08-01T08:05:00+08:00"
 * @returns {number} UTC epoch ms
 */
export function wemIntervalMs(dispatchInterval) {
  const ms = Date.parse(dispatchInterval);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`unparseable WEM dispatch interval: ${dispatchInterval}`);
  }
  return ms;
}
