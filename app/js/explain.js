// The plain-English layer: what every panel means, for a reader who has never
// thought about electricity markets or forecasting.
//
// Two modes, toggled in the masthead and remembered per browser. Plain mode
// retitles every panel in ordinary words, adds a two-sentence caption under
// each one, marks the domain terms so a tap explains them, and keeps a
// one-sentence story line under the tabs saying what is happening right now.
// Expert mode is the original instrument, untouched.
//
// The captions live in explain-deck.js as data rather than scattered through
// the views, so the whole teaching voice can be read, reviewed and tested as
// one document. A term is written [[key|shown text]] in the deck and rendered
// as a tappable word; every key must exist in the glossary, and a test holds
// the deck to that.

import { DECK } from './explain-deck.js';
import { createCallouts } from './charts/callouts.js';

const MODE_KEY = 'gridsense-mode';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** [[key|text]] to a tappable term button; everything else escaped. */
function renderRich(text) {
  return escapeHtml(text).replace(/\[\[([\w-]+)\|([^\]]+)\]\]/g, (_, key, shown) =>
    (DECK.glossary[key]
      ? `<button type="button" class="term" data-term="${key}">${shown}</button>`
      : shown));
}

/** Glossary text is terminal: any markup left in it renders as its plain words. */
const stripMarkup = (text) => text.replace(/\[\[([\w-]+)\|([^\]]+)\]\]/g, '$2');

// ---------------------------------------------------------------------------
// Term popover
// ---------------------------------------------------------------------------

let pop = null;

function closePop() {
  pop?.remove();
  pop = null;
}

function openPop(button) {
  const key = button.dataset.term;
  const entry = DECK.glossary[key];
  if (!entry) return;
  closePop();

  pop = document.createElement('div');
  pop.className = 'term-pop';
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `<strong>${escapeHtml(entry.name)}</strong>${escapeHtml(stripMarkup(entry.plain))}`;
  document.body.appendChild(pop);

  // Fixed positioning against the viewport, clamped, flipping above the term
  // when the bottom edge would run off screen.
  const r = button.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  pop.style.left = `${left}px`;
  const below = r.bottom + 6;
  pop.style.top = `${below + pop.offsetHeight > window.innerHeight - 8
    ? Math.max(8, r.top - pop.offsetHeight - 6)
    : below}px`;
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private browsing */ }

  document.getElementById('mode-plain')?.setAttribute('aria-pressed', String(mode === 'plain'));
  document.getElementById('mode-expert')?.setAttribute('aria-pressed', String(mode === 'expert'));

  for (const panel of document.querySelectorAll('[data-explain]')) {
    const h2 = panel.querySelector('h2');
    const entry = DECK.panels[panel.dataset.explain];
    if (!h2 || !entry) continue;
    if (!h2.dataset.expertTitle) h2.dataset.expertTitle = h2.textContent;
    h2.textContent = mode === 'plain' ? entry.plainTitle : h2.dataset.expertTitle;
  }

  for (const tab of document.querySelectorAll('.views button[data-view]')) {
    if (!tab.dataset.expertLabel) tab.dataset.expertLabel = tab.textContent;
    tab.textContent = mode === 'plain'
      ? (DECK.tabs[tab.dataset.view] ?? tab.dataset.expertLabel)
      : tab.dataset.expertLabel;
  }

  const strap = document.querySelector('.masthead .strap');
  if (strap) {
    if (!strap.dataset.expertText) strap.dataset.expertText = strap.textContent;
    strap.textContent = mode === 'plain' ? DECK.strap : strap.dataset.expertText;
  }

  const story = document.getElementById('story-line');
  if (story) story.hidden = mode !== 'plain';

  closePop();
}

// ---------------------------------------------------------------------------
// Story line
// ---------------------------------------------------------------------------

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '—');

function nemClock(sec) {
  const d = new Date(sec * 1000 + 10 * 3600_000);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'am' : 'pm';
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm} ` +
    `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

let lastStory = '';

/** One sentence about the state of the world, refreshed as the replay runs. */
export function updateStory(state, ctx) {
  const el = document.getElementById('story-line');
  if (!el || document.documentElement.dataset.mode !== 'plain') return;

  const s = state.stats ?? {};
  const skillValue = s['fleet.1h.skill'];
  const skill = Number.isFinite(skillValue) ? `${Math.round(skillValue * 100)}%` : 'still warming up';

  let text;
  if (!state.frame || !Number.isFinite(state.nowSec)) {
    text = fill(DECK.story.loading, {});
  } else if (Number.isFinite(s.cursor) && Number.isFinite(s.steps) && s.cursor < s.steps) {
    // The last finite actual in the frame is "now" as the replay sees it.
    let mw = NaN;
    const a = state.frame.actual ?? [];
    for (let i = a.length - 1; i >= 0; i--) {
      if (Number.isFinite(a[i])) { mw = a[i]; break; }
    }
    text = fill(DECK.story.running, {
      time: nemClock(state.nowSec),
      gw: Number.isFinite(mw) ? (mw / 1000).toFixed(1) : '—',
      n: Number.isFinite(s.stationCount) ? String(s.stationCount) : '—',
      skill,
    });
  } else {
    text = fill(DECK.story.finished, {
      days: String(ctx.days?.length ?? '—'),
      skill,
    });
  }

  // The line updates many times a second during replay; only touching the DOM
  // when the words change keeps it from flickering under the reader.
  if (text !== lastStory) {
    lastStory = text;
    el.textContent = text;
  }
}

// ---------------------------------------------------------------------------
// "How to read this" chart callouts
// ---------------------------------------------------------------------------

const howTos = new Map();

/**
 * Views call this at mount for the charts worth annotating. The button lands
 * in the panel's header; the labels land on the chart itself.
 *
 * @param {string} key the panel's data-explain key
 * @param {HTMLElement} host the chart container the overlay covers
 * @param {() => Array<object>|null} computeItems pixel-space labels, or null
 */
export function registerHowTo(key, host, computeItems) {
  howTos.get(key)?.callouts.destroy();
  howTos.get(key)?.button.remove();

  const panel = document.querySelector(`[data-explain="${key}"]`);
  const header = panel?.querySelector('header');
  if (!header || !host) return;

  const callouts = createCallouts(host, computeItems);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'howto';
  button.textContent = 'How to read this';
  button.addEventListener('click', () => {
    callouts.toggle();
    button.setAttribute('aria-pressed', String(callouts.isOpen()));
  });
  header.appendChild(button);

  howTos.set(key, { callouts, button });
}

/** Views call this from update() so open labels track a moving chart. */
export function repositionHowTo(key) {
  howTos.get(key)?.callouts.reposition();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// The three thin strips under the conviction band share its panel and were the
// one element novice readers could not even guess a meaning for. A quiet
// corner label each, plain mode only.
const LANE_LABELS = {
  'expert-ribbon': 'trust in each of the six forecasters',
  'price-overlay': 'wholesale price, $ per MWh',
  'revenue-ribbon': 'revenue so far, $',
};

export function initExplain() {
  for (const [id, text] of Object.entries(LANE_LABELS)) {
    const host = document.getElementById(id);
    if (!host) continue;
    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = text;
    host.appendChild(label);
  }

  for (const panel of document.querySelectorAll('[data-explain]')) {
    const entry = DECK.panels[panel.dataset.explain];
    const header = panel.querySelector('header');
    if (!entry || !header) continue;
    const caption = document.createElement('p');
    caption.className = 'explain-caption';
    caption.innerHTML = renderRich(entry.caption);
    header.after(caption);
  }

  document.getElementById('mode-plain')?.addEventListener('click', () => setMode('plain'));
  document.getElementById('mode-expert')?.addEventListener('click', () => setMode('expert'));

  document.addEventListener('click', (e) => {
    const term = e.target.closest?.('.term');
    if (term) { openPop(term); e.stopPropagation(); return; }
    if (pop && !pop.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

  let stored = null;
  try { stored = localStorage.getItem(MODE_KEY); } catch { /* private browsing */ }
  setMode(stored === 'expert' ? 'expert' : 'plain');
}
