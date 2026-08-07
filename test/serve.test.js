// The server's routing, tested against the routes the app actually asks for.
//
// This exists because of a failure that every other test suite was blind to.
// The first cloud deploy built its data successfully — dispatch, weather,
// prices, curves, backtest all written — and then served a dead page, because
// the app's very first fetch is `/data/registry.json` and nothing in the build
// produces that file. It had only ever worked on the machine where someone had
// once made a symlink by hand. Unit tests over parsing and models cannot see a
// gap like that; only asking the server for the URL can.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../harvester/serve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Port 0: the OS picks a free one, so the suite cannot fail because a
// development server happens to be running on the usual port.
const listening = new Promise((resolve) => server.listen(0, resolve));
after(() => server.close());

async function get(pathname) {
  await listening;
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${pathname}`);
}

test('the registry serves from /data even though no build step writes it there', async () => {
  const res = await get('/data/registry.json');
  assert.equal(res.status, 200, 'the app cannot start without this file');

  const registry = await res.json();
  assert.ok(Array.isArray(registry.stations) && registry.stations.length > 0,
    'the registry must carry stations, not merely exist');
  // The fields the loader filters on. A registry that parsed but had none of
  // these would leave the dashboard empty with no error to show.
  const modelled = registry.stations.filter((s) => s.modelled && s.located && s.capacity_mw > 0);
  assert.ok(modelled.length > 0, 'no station survives the loader\'s filter');
});

// Committed source the app fetches at boot. Neither is harvester output, so
// neither is rebuilt by a deploy — if one is missing from the repository it is
// missing from production, and the only symptom is a panel that does not draw.
// This is the second time that has happened: the registry was a hand-made
// symlink, and the map's coastline sat under app/data/, which an unanchored
// `data/` line in .gitignore quietly excluded.
test('every committed file the app boots from is tracked in git', () => {
  const tracked = execSync('git ls-files', { cwd: path.join(HERE, '..'), encoding: 'utf8' })
    .split('\n');
  for (const file of ['harvester/registry.json', 'app/data/au-states.json']) {
    assert.ok(tracked.includes(file),
      `${file} is fetched by the app but is not in the repository, so no deploy can serve it`);
  }
});

test('the map geometry serves and carries the states the map draws', async () => {
  const res = await get('/data/au-states.json');
  assert.equal(res.status, 200, 'the map cannot draw a coastline without this');
  const { states } = await res.json();
  const names = states.map((s) => s.name);
  for (const required of ['New South Wales', 'Queensland', 'Victoria', 'South Australia',
    'Tasmania', 'Western Australia']) {
    assert.ok(names.includes(required), `no geometry for ${required}`);
    const state = states.find((s) => s.name === required);
    assert.ok(state.rings?.[0]?.length > 20, `${required} has no usable outline`);
  }
});

test('the app shell serves at the root', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

test('data routes carry the header that lets a static site on another origin read them', async () => {
  const res = await get('/data/registry.json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('a missing data file is a 404 rather than a hang or a 500', async () => {
  const res = await get('/data/nem-dispatch/1970-01-01.json');
  assert.equal(res.status, 404);
});

test('an escape from the data root is refused', async () => {
  // Encoded, because fetch normalises a literal ".." out of the path before it
  // ever reaches the server — the guard has to hold against what arrives after
  // decoding, not against what a well-behaved client would send.
  const res = await get('/data/%2e%2e/harvester/serve.js');
  assert.equal(res.status, 404);
});

test('a percent-encoded station id resolves to the file the harvester wrote', async () => {
  // Gladstone registers as "G/STONE", so safeFileName writes G%2FSTONE.json and
  // the app asks for exactly that. Decoding the path first looked for
  // STONE.json inside a directory named G, and the station lost its weather
  // with no visible symptom beyond a slightly worse forecast.
  const res = await get('/data/weather/G%2FSTONE.json');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).station_id, 'G/STONE');
});

test('the data index lists what each day-keyed directory holds', async () => {
  const res = await get('/data/index.json');
  assert.equal(res.status, 200);
  const index = await res.json();
  for (const dir of ['nem-dispatch', 'wem-dispatch', 'prices', 'flows']) {
    assert.ok(Array.isArray(index[dir]), `${dir} must be listed, even if empty`);
    for (const iso of index[dir]) assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(index[dir], [...index[dir]].sort(), `${dir} must be sorted`);
  }
});

test('a path cannot climb out of the directory it names', async () => {
  for (const attempt of ['/data/../package.json', '/data/%2e%2e/package.json']) {
    const res = await get(attempt);
    assert.notEqual(res.status, 200, `${attempt} must not be served`);
  }
});
