// The plain-English deck, held to its own rules.
//
// The teaching layer is data, which means it can rot in ways code cannot: a
// panel added to the page with no caption, a term marked in a caption that no
// glossary entry backs, a story template whose placeholder the app never
// fills. Each of those degrades quietly — the reader just meets a hole where
// an explanation should be — so the deck is tested like an interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECK } from '../app/js/explain-deck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const termKeys = (text) => [...text.matchAll(/\[\[([\w-]+)\|[^\]]+\]\]/g)].map((m) => m[1]);

test('every panel on the page has a caption, and no caption is orphaned', async () => {
  const html = await fs.readFile(path.join(HERE, '..', 'app', 'index.html'), 'utf8');
  const onPage = [...html.matchAll(/data-explain="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(onPage.length >= 15, `expected the full panel inventory, found ${onPage.length}`);

  for (const key of onPage) {
    assert.ok(DECK.panels[key], `panel "${key}" is on the page with no deck entry`);
  }
  for (const key of Object.keys(DECK.panels)) {
    assert.ok(onPage.includes(key), `deck entry "${key}" matches no panel on the page`);
  }
});

test('every marked term resolves to a glossary entry', () => {
  const texts = [
    ...Object.values(DECK.panels).map((p) => p.caption),
    ...Object.values(DECK.story),
  ];
  for (const text of texts) {
    for (const key of termKeys(text)) {
      assert.ok(DECK.glossary[key], `[[${key}|…]] is marked but "${key}" is not in the glossary`);
    }
  }
});

test('glossary entries are terminal: no term markup, no empty text', () => {
  for (const [key, entry] of Object.entries(DECK.glossary)) {
    assert.ok(entry.name?.length > 0 && entry.plain?.length > 20,
      `glossary "${key}" is too thin to explain anything`);
  }
});

test('captions and titles stay caption-sized', () => {
  for (const [key, p] of Object.entries(DECK.panels)) {
    assert.ok(p.plainTitle.length > 0 && p.plainTitle.length <= 44,
      `plainTitle for "${key}" is ${p.plainTitle.length} chars`);
    assert.ok(p.caption.length > 40 && p.caption.length <= 480,
      `caption for "${key}" is ${p.caption.length} chars`);
  }
});

test('story templates carry the placeholders the app fills', () => {
  assert.match(DECK.story.running, /\{time\}/);
  assert.match(DECK.story.running, /\{gw\}/);
  assert.match(DECK.story.finished, /\{days\}/);
  for (const text of Object.values(DECK.story)) {
    // A template with an unknown placeholder renders a literal dash where a
    // number should be, which reads as broken rather than merely missing.
    for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
      assert.ok(['time', 'gw', 'n', 'skill', 'days', 'status'].includes(name),
        `story placeholder {${name}} is not one the app fills`);
    }
  }
});

test('the fuel vocabulary the charts use is covered', () => {
  for (const ft of ['coal_black', 'coal_brown', 'hydro', 'wind', 'solar_utility']) {
    assert.ok(DECK.fueltechs[ft]?.length > 10, `fueltech "${ft}" has no plain description`);
  }
});
