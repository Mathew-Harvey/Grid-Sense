// The two things about AEMO's dispatch files that silently corrupt everything
// downstream if they are got wrong: the nested record format, and the fact that
// NEM time never shifts for daylight saving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAemo, splitLine, parseAemoTimestamp } from '../harvester/parse-aemo.js';

// Two tables in one file, a quoted comma inside a field, and a correct footer.
// Footer counts EVERY line: 1 C header + 2 I rows + 3 D rows + 1 C footer = 7.
const GOOD = [
  'C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,2026/08/06,22:55:13,0000000531341929,DISPATCHSCADA,0000000531341923',
  'I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE',
  'D,DISPATCH,UNIT_SCADA,1,"2026/08/06 23:00:00",BAYSW1,383.5',
  'D,DISPATCH,UNIT_SCADA,1,"2026/08/06 23:00:00",ER01,241.25',
  'I,DISPATCH,CONSTRAINT,5,SETTLEMENTDATE,CONSTRAINTID,DESCRIPTION',
  'D,DISPATCH,CONSTRAINT,5,"2026/08/06 23:00:00",N^^N_NIL_1,"Out = Nil, feedback, ratings"',
  'C,"END OF REPORT",7',
].join('\n');

test('splitLine keeps a quoted comma inside one field', () => {
  const f = splitLine('D,X,Y,1,"a, b",c');
  assert.deepEqual(f, ['D', 'X', 'Y', '1', 'a, b', 'c']);
});

test('splitLine handles a doubled quote as a literal quote', () => {
  const f = splitLine('D,X,Y,1,"say ""hi"", ok",z');
  assert.deepEqual(f, ['D', 'X', 'Y', '1', 'say "hi", ok', 'z']);
});

test('parses two tables from one file and maps D rows to their own I row', () => {
  const { tables } = parseAemo(GOOD);
  assert.equal(tables.size, 2);

  const scada = tables.get('DISPATCH.UNIT_SCADA');
  assert.equal(scada.rows.length, 2);
  assert.equal(scada.rows[0].DUID, 'BAYSW1');
  assert.equal(scada.rows[0].SCADAVALUE, 383.5);
  assert.equal(scada.rows[1].DUID, 'ER01');

  // The quoted comma must not have shifted the columns.
  const con = tables.get('DISPATCH.CONSTRAINT');
  assert.equal(con.rows[0].CONSTRAINTID, 'N^^N_NIL_1');
  assert.equal(con.rows[0].DESCRIPTION, 'Out = Nil, feedback, ratings');
});

test('a wrong END OF REPORT count throws rather than warning', () => {
  const bad = GOOD.replace('C,"END OF REPORT",7', 'C,"END OF REPORT",42');
  assert.throws(() => parseAemo(bad), /count mismatch/i);
});

test('a missing footer throws: a truncated download must not parse clean', () => {
  const truncated = GOOD.split('\n').slice(0, -1).join('\n');
  assert.throws(() => parseAemo(truncated), /END OF REPORT/i);
});

test('a data row with no preceding I row throws', () => {
  const orphan = [
    'C,NEMP.WORLD,X,AEMO,PUBLIC,2026/08/06,00:00:00,1,X,1',
    'D,DISPATCH,UNIT_SCADA,1,"2026/08/06 23:00:00",BAYSW1,383.5',
    'C,"END OF REPORT",3',
  ].join('\n');
  assert.throws(() => parseAemo(orphan), /no preceding I row/i);
});

test('an unquoted comma that lengthens a row throws instead of decoding to garbage', () => {
  const shifted = [
    'C,NEMP.WORLD,X,AEMO,PUBLIC,2026/08/06,00:00:00,1,X,1',
    'I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE',
    'D,DISPATCH,UNIT_SCADA,1,2026/08/06 23:00:00,BAYSW1,383.5,EXTRA',
    'C,"END OF REPORT",4',
  ].join('\n');
  assert.throws(() => parseAemo(shifted), /shape mismatch/i);
});

// NEM time is AEST (UTC+10) permanently and never observes daylight saving, in
// any region, on any date. Reading these stamps through a timezone library that
// knows about Australian civil time shifts half the year by an hour.
test('NEM timestamps use a fixed UTC+10 offset across the DST boundary', () => {
  // First Sunday in October 2026 is the 4th: the date NSW/VIC/SA/TAS clocks
  // would spring forward. NEM time does not.
  const before = parseAemoTimestamp('2026/10/03 14:00:00');
  const onTheDay = parseAemoTimestamp('2026/10/04 14:00:00');
  const after = parseAemoTimestamp('2026/10/05 14:00:00');

  assert.equal(before, Date.UTC(2026, 9, 3, 4, 0, 0));
  assert.equal(onTheDay, Date.UTC(2026, 9, 4, 4, 0, 0));
  assert.equal(after, Date.UTC(2026, 9, 5, 4, 0, 0));

  // Exactly 24h apart either side of the boundary — no 23h day.
  assert.equal(onTheDay - before, 86_400_000);
  assert.equal(after - onTheDay, 86_400_000);
});

test('WEM timestamps use a fixed UTC+8 offset', () => {
  assert.equal(parseAemoTimestamp('2026/08/05 08:00:00', 8), Date.UTC(2026, 7, 5, 0, 0, 0));
});
