// The whole system, explained from nothing.
//
// Written for a bright sixteen-year-old who has never thought about
// electricity markets: no statistics assumed, no jargon that is not built up
// from something already said, and every abstract claim attached to a small
// animation that shows the thing happening rather than asserting it.
//
// It is a separate view rather than a preamble on the aggregate page because
// the two do different jobs. The dashboard answers "is the forecast good right
// now"; this answers "what would it even mean for a forecast to be good", and
// nobody needs the second answer twice.
//
// The text is here rather than in explain-deck.js because it is prose in
// sequence — an argument with an order, not a caption attached to a panel. The
// deck's job is to label things on screen; this one's is to be read top to
// bottom once.

import { runScenes } from '../charts/scenes.js';

const SECTIONS = [
  {
    id: 'balance',
    scene: 'balance',
    title: 'Electricity is made the instant it is used',
    body: `Almost nothing else works this way. A bakery can bake before you arrive;
      a reservoir holds water for a dry month. The grid mostly cannot. At every
      moment, the power flowing out of every generator in the country has to
      equal the power being drawn by every kettle, train and aluminium smelter
      plugged into it — not on average, not by the end of the day, but now.
      <br><br>
      Get it wrong and the whole system's frequency drifts off 50 hertz, which is
      the grid's pulse. Drift far enough and equipment disconnects itself to
      survive, which makes the imbalance worse. So somebody has to know what is
      coming before it arrives — and that is the only reason forecasting the grid
      matters.`,
    caption: 'Supply chasing demand. The needle is how far out of balance they are.',
  },
  {
    id: 'weather',
    scene: 'curtailment',
    title: 'Wind and sun made the problem harder, and more interesting',
    body: `A coal station produces what it is told to produce. Ask for 400 megawatts,
      wait twenty minutes, get 400 megawatts. Its output is a decision, and you
      cannot forecast a decision from the weather.
      <br><br>
      A wind farm is the opposite. Nobody decides its output; the air does. That
      makes it forecastable in a way a coal station never is — if you know the
      wind, you can know the power — and it is why this dashboard spends its
      effort on wind and solar and openly does badly on coal.
      <br><br>
      There is a catch, and it is the single most misread thing in this data.
      Sometimes the wind is blowing hard and the farm is told to hold back
      anyway, because the network physically cannot carry the power or the price
      has gone negative. That is <strong>curtailment</strong>. If you don't know
      it happened, the farm looks like a forecast that failed. Every fit in this
      system throws those minutes away.`,
    caption: 'The wind keeps rising; the output is held flat. The shaded gap is spilled energy.',
  },
  {
    id: 'persistence',
    scene: 'persistence',
    title: 'The forecast to beat is “nothing will change”',
    body: `Before you can say a forecast is good, you need something to compare it to,
      and the honest comparison is the laziest possible guess: whatever the
      station is producing right now, assume it keeps doing that.
      <br><br>
      This sounds trivially easy to beat. It is not. Over five minutes it is
      nearly unbeatable — the world rarely changes much in five minutes. Over a
      day it is hopeless. So the same model can look brilliant at one distance
      and useless at another, which is why every score on this site is quoted at
      a stated <strong>horizon</strong>: five minutes, an hour, a day.
      <br><br>
      The number the dashboard leads with is <strong>skill</strong>: how much
      smaller the model's average error is than the lazy guess's. Zero means you
      have achieved nothing. 0.30 means your errors are 30% smaller. Below zero
      means you would have been better off doing nothing at all — and this
      dashboard prints those in red rather than hiding them.`,
    caption: 'The flat dashed line is the lazy guess. The shaded gap is what it costs.',
  },
  {
    id: 'band',
    scene: 'band',
    title: 'A number without a range is not a forecast',
    body: `“The farm will make 180 megawatts” is almost useless on its own, because it
      is certainly wrong — the only question is by how much. A forecast that is
      worth acting on says how sure it is: “between 150 and 210, and I expect to
      be right about this nine times in ten.”
      <br><br>
      That is a testable promise, and testing it is most of what this site does.
      Issue the range, wait, see where the truth landed, and keep count. If the
      truth lands inside 9 times out of 10, the range was honest. If it lands
      inside every single time, the range was uselessly wide — a forecast of
      “between zero and everything” is never wrong and never worth anything.
      <br><br>
      The model adjusts its own width continuously from its recent mistakes: too
      many escapes and it widens, too few and it tightens. Watch the band on the
      main chart breathe as the replay runs. That is the adjustment happening.`,
    caption: 'Twenty outcomes against a 90% range. About one in ten should escape — and does.',
  },
  {
    id: 'ensemble',
    scene: 'ensemble',
    title: 'Six simple guessers beat one clever one',
    body: `Instead of a single model, this system runs six deliberately simple ones and
      blends them. One assumes nothing changes. One has learnt the shape of an
      average day. One knows the physics of a turbine. One does statistics on
      recent data. One searches history for a moment that looks like now. One
      watches for a ramp and rides it.
      <br><br>
      None is best. The physics one is excellent on a clear afternoon and lost in
      strange weather; the memory one is superb once it has seen a similar day
      and helpless in its first week. So the blend is re-weighted constantly:
      whoever has been accurate lately gets more say, and a guesser having a bad
      run quietly shrinks. Nobody is ever fired, because tomorrow's weather might
      suit them.
      <br><br>
      The blend usually beats every member it is made of, which is the whole
      argument for doing it this way — and the training tab shows that claim
      being tested every few seconds.`,
    caption: 'Six weights that always add to 100%, shifting as each guesser earns or loses its share.',
  },
];

const CLOSER = {
  title: 'Why so much of this site is about being wrong',
  body: `Most dashboards show you a prediction. This one spends most of its space
    showing you how often its predictions failed, because a forecast you cannot
    check is just a confident sentence.
    <br><br>
    So: every score is measured against the lazy guess rather than against
    nothing. Every range is scored on whether reality actually landed inside it.
    Curtailed minutes are thrown out before anything is fitted, because scoring a
    model on a decision the market made is scoring the wrong thing. And the
    honest failures — coal in red, the day-ahead range that is still too narrow —
    are on the page rather than in a footnote.
    <br><br>
    One last thing worth knowing: nothing here is live. The site replays a fixed
    window of real recorded history at high speed, so you can watch a model go
    from knowing nothing to being useful in about ten minutes. Everything you see
    already happened.`,
};

export function mount(root) {
  const host = root.querySelector('#learn-body');
  if (!host) return { update() {}, destroy() {} };

  host.innerHTML = SECTIONS.map((s, i) => `
    <article class="learn-step" id="learn-${s.id}">
      <div class="learn-text">
        <span class="learn-num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${s.title}</h3>
        <p>${s.body}</p>
      </div>
      <figure class="learn-figure">
        <canvas data-scene="${s.scene}" aria-hidden="true"></canvas>
        <figcaption>${s.caption}</figcaption>
      </figure>
    </article>`).join('') + `
    <article class="learn-step learn-closer">
      <div class="learn-text">
        <h3>${CLOSER.title}</h3>
        <p>${CLOSER.body}</p>
      </div>
    </article>`;

  let scenes = runScenes(host);

  return {
    update() {},
    resize() {
      // The canvases size from their laid-out box, so a width change needs a
      // redraw rather than a rescale — a stretched bitmap would blur the text
      // drawn into it.
      scenes.stop();
      scenes = runScenes(host);
    },
    destroy() { scenes.stop(); },
  };
}
