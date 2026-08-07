// The deploy's build pipeline, checked against what each step actually reads.
//
// This exists because of a failure with no symptom at build time. `build:data`
// once ran the correlation pass before the Western Australian backfill, and
// `loadWemObservations` answered the missing directory with an empty map — so
// the build went green, every file was written, and WA silently had no fitted
// power curves. It only worked on the machine where the backfill had been run
// by hand on some earlier day. A step ordered before the step that produces its
// input is not a runtime error here; it is a quiet absence, which is exactly
// the kind of thing that has to be asserted rather than noticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

// Each entry: this step must appear before those steps, because they read what
// it writes. Derived by reading the scripts, not by copying the current order.
const PRODUCES_INPUT_FOR = {
  // Writes wem_facilities into registry.json; the WA backfill folds facility
  // rows to stations through exactly that mapping.
  'build-wem-codes.js': ['backfill-wem.js'],
  // Writes data/wem-dispatch/, which both consumers load for SWIS stations.
  'backfill-wem.js': ['correlate-run.js', 'backtest.js'],
  // Writes data/nem-dispatch/, the observation source for the eastern fleet.
  'backfill.js': ['correlate-run.js', 'backtest.js'],
  // Writes data/weather/; curves are fitted against it and the experts read it.
  'backfill-weather.js': ['correlate-run.js', 'backtest.js'],
  // Writes correlations.json — fitted curves and lags the backtest starts from.
  'correlate-run.js': ['backtest.js'],
};

function stepOrder(command) {
  const order = new Map();
  command.split('&&').forEach((part, i) => {
    const match = part.match(/harvester\/([\w-]+\.js)/);
    if (match) order.set(match[1], i);
  });
  return order;
}

test('build:data runs every step after the steps that produce its input', () => {
  const command = pkg.scripts['build:data'];
  assert.ok(command, 'package.json has no build:data script');
  const order = stepOrder(command);

  for (const [producer, consumers] of Object.entries(PRODUCES_INPUT_FOR)) {
    assert.ok(order.has(producer), `build:data is missing ${producer}`);
    for (const consumer of consumers) {
      assert.ok(order.has(consumer), `build:data is missing ${consumer}`);
      assert.ok(
        order.get(producer) < order.get(consumer),
        `${consumer} runs before ${producer}, which writes what it reads`,
      );
    }
  }
});

test('the Render blueprint defers to build:data rather than restating it', () => {
  const blueprint = fs.readFileSync(path.join(HERE, '..', 'render.yaml'), 'utf8');
  const build = blueprint.match(/buildCommand:.*/)[0];
  // A blueprint that names the steps itself is a second copy of the pipeline,
  // and the copy is what goes stale — that is the whole reason for the script.
  assert.ok(
    !build.includes('harvester/'),
    'render.yaml names pipeline steps directly; it should call npm run build:data',
  );
  assert.match(build, /npm run build:data/);
});
