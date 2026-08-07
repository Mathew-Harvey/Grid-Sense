// The plain-English copy deck: every caption, glossary entry and story
// template the explain layer renders. One file so the whole teaching voice can
// be read top to bottom, reviewed as a document, and held to its rules by
// test/explain.test.js.
//
// Written for a reader who has never thought about electricity markets.
// Conventions: [[key|shown text]] marks a tappable term that must exist in the
// glossary; story templates carry {placeholders} the app fills at render time.

export const DECK = {
  "strap": "Watch a forecast model learn 21 days of Australia's power grid at high speed — and mark its own homework as it goes.",
  "tabs": {
    "aggregate": "Whole market",
    "station": "One station",
    "training": "Watch it learn"
  },
  "panels": {
    "skill": {
      "plainTitle": "Better than guessing",
      "caption": "The headline number is [[skill|skill]] at one hour ahead: how much better the [[forecast|forecast]] is than [[persistence|assuming nothing will change]] — 0.16 means 16% better, below zero worse. The table repeats the test at each [[horizon|horizon]], with the error score ([[crps|CRPS]], in megawatts) and [[coverage|Cover 90]]. Red cells are the model failing that test, and it says so rather than hiding them."
    },
    "market": {
      "plainTitle": "Actual versus predicted power",
      "caption": "The white line is what all tracked stations actually made; the dashed line is the model's hour-ahead [[forecast|forecast]]. The [[band|grey band]] is its uncertainty — a courier's 'between 2 and 4 pm' window. That width is a promise, and the Cover 90 column beside this chart scores whether it was kept. Below sit the [[expert|experts]] it trusts, the wholesale [[price|price]] and running [[revenue|revenue]]."
    },
    "fuelmix": {
      "plainTitle": "What's making the power",
      "caption": "Each colour is one [[fueltech|fuel type]], stacked so the top edge is total output. The grey base is black coal and the brown band above it brown coal — the steady workhorses. Yellow is the sun, rising and setting each day; teal is wind, drifting with the weather; blue is water behind dams."
    },
    "regions": {
      "plainTitle": "State by state",
      "caption": "One row per [[region|region]] of Australia's eastern electricity market — roughly one per state. Each shows how many [[gw|gigawatts]] its tracked stations are making at this point in the [[replay|replay]], and its share of the total — a scoreboard of who's carrying the load."
    },
    "quality": {
      "plainTitle": "Where the data ends",
      "caption": "Plain numbers about the data itself: how many days loaded, how many stations tracked, where the record stops, and any gaps. This dashboard is a [[replay|replay]] of history, not a live feed — this strip says so up front. Counts can differ honestly between panels: a station is only counted as tracked once it has enough history to score."
    },
    "series": {
      "plainTitle": "One station's three weeks",
      "caption": "The solid line is what this station actually made. The dashed line is what the weather said it could have made ([[uigf|UIGF]]); the thin line is what the market asked for ([[dispatch|dispatch]]). Red-tinted spans are [[curtailment|curtailment]] — the wind was blowing, but the grid said hold back."
    },
    "powercurve": {
      "plainTitle": "Wind in, power out",
      "caption": "Each grey dot is five minutes of real life: wind speed across, power out up. The white S-curve is the machine's fitted [[powercurve|power curve]] — nothing in light air, a steep climb, then flat at full power. Red crosses were [[curtailment|held back on purpose]], so the fit ignores them."
    },
    "lag": {
      "plainTitle": "Does weather arrive first",
      "caption": "Each curve tests how strongly one weather variable [[correlation|moves with]] this station's output, shifted in time up to six hours either way. The marked peak says which leads, and by how many minutes. Like rain on the radar, a change in the weather often shows up in the measurements before the turbines feel it."
    },
    "pit": {
      "plainTitle": "The honesty check",
      "caption": "For every [[forecast|forecast]], mark where the truth landed inside the predicted spread — bottom, middle or top. An honest model fills this [[pit|histogram]] evenly, like a fair die. A U shape means overconfidence; a middle hump, a [[band|band]] wider than needed; everything piled at one end means the truth kept escaping that side — the check failing, and the chart's own caption says which."
    },
    "reliability": {
      "plainTitle": "When it says 70%",
      "caption": "Each dot compares stated confidence with how often the model was actually right. On the diagonal, promises kept: said 70% sure, right 70% of the time. Below the line it claimed more certainty than it had; above the line, less — too shy. That's [[reliability|reliability]], drawn as a picture."
    },
    "analogue": {
      "plainTitle": "Forecasting by memory",
      "caption": "One [[expert|expert]] works the way you do when you say 'this feels like last Tuesday'. It searches the [[replay|replay's]] past for the moment that most resembles conditions an hour ahead, then predicts the station will repeat itself. This panel shows its current best [[analogue|match]]."
    },
    "replay": {
      "plainTitle": "Play history at speed",
      "caption": "These controls — play, pause, speed, scrub — drive the 21-day [[replay|replay]], a video player for recorded grid history. The speed slider sets a target; the line beside it reports the true pace and counts the five-minute intervals scored so far. Nothing here is live; you're watching it learn from the past."
    },
    "experts": {
      "plainTitle": "Six forecasters compete",
      "caption": "One row per [[expert|expert]] — six simple forecasters with different habits — showing each one's recent average error in megawatts; lower is better. The last row is the combined [[forecast|forecast]], which usually beats every member it is built from, the way several friends' guesses of a trip time tend to average out better than most of them."
    },
    "coverage": {
      "plainTitle": "Nine times out of ten",
      "caption": "Each row tests one [[horizon|horizon]] against two promises: the 90% [[band|band]] and a tighter 80% one. A delivery window should contain the knock nine times in ten — no more, no fewer. Red is a promise broken, in either direction: too few catches, or 100%, a window so wide it stopped saying anything. That's [[coverage|coverage]], and it should settle near its target as the model learns; red rows mean it hasn't."
    },
    "matrix": {
      "plainTitle": "Where the model wins",
      "caption": "Every station crossed with every [[horizon|horizon]], each cell coloured by [[skill|skill]]. Green means the model beats 'assume nothing changes' there; red means it doesn't. Coal often runs red — its output follows human decisions rather than weather, like trying to forecast when someone will put the kettle on."
    }
  },
  "glossary": {
    "forecast": {
      "name": "Forecast",
      "plain": "A prediction made before the fact about what a station will produce — like the weather segment on the evening news. Here every forecast comes as a range, not a single number."
    },
    "band": {
      "name": "Uncertainty band",
      "plain": "The shaded range around a forecast — the model promises the truth should land inside it 90% of the time. Like a courier saying 'between 2 and 4 pm': the wider the window, the less certain they are."
    },
    "persistence": {
      "name": "Persistence",
      "plain": "The laziest possible forecast: assume the next hour looks exactly like right now. It's surprisingly hard to beat, which is why everything else is measured against it."
    },
    "skill": {
      "name": "Skill",
      "plain": "How much better the forecast is than assuming nothing will change. Zero means no better than that lazy guess; 0.16 means 16% better; below zero means worse."
    },
    "crps": {
      "name": "CRPS",
      "plain": "The error score used here, measured in megawatts. It rewards forecasts that are both close to the truth and honest about how unsure they were — smaller is better."
    },
    "coverage": {
      "name": "Coverage",
      "plain": "How often reality actually landed inside the range the model promised. A 90% band should catch the true value nine times out of ten, like a delivery window that usually contains the knock at the door."
    },
    "horizon": {
      "name": "Horizon",
      "plain": "How far ahead a forecast looks — five minutes, an hour, a day. The further out, the harder it gets, so the range gets wider."
    },
    "curtailment": {
      "name": "Curtailment",
      "plain": "Moments the grid told a station to hold back even though it could have made more. Like a bakery told to stop baking because the delivery vans are already full."
    },
    "uigf": {
      "name": "UIGF",
      "plain": "The market operator's published estimate of what a wind or solar farm could have made from the weather alone, before any instruction to hold back."
    },
    "dispatch": {
      "name": "Dispatch",
      "plain": "The instruction each station receives about how much to produce right now — the grid's roster, updated every five minutes."
    },
    "capacity": {
      "name": "Capacity",
      "plain": "The most a station can produce flat out — its size on paper, like a car's top speed rather than how fast it's going right now."
    },
    "mw": {
      "name": "Megawatt (MW)",
      "plain": "A unit of power, roughly enough for a few hundred homes at once. A large power station is hundreds of megawatts."
    },
    "gw": {
      "name": "Gigawatt (GW)",
      "plain": "A thousand megawatts — the scale of whole states. The eastern market swings between roughly 15 and 35 GW over a day."
    },
    "expert": {
      "name": "Expert",
      "plain": "One of six simple forecasters inside the model, each with a single idea — habit, physics, memory, and so on. The model blends their opinions, trusting whoever has been right lately."
    },
    "replay": {
      "name": "Replay",
      "plain": "A fast-forward re-run of 21 days of recorded grid history. Nothing is live — you're watching the model learn from the past, like reviewing game tape after the match."
    },
    "pit": {
      "name": "PIT histogram",
      "plain": "A self-check asking, for every forecast, where the truth landed inside the predicted range. If the model is honest, the answers spread out evenly, like a fair die."
    },
    "reliability": {
      "name": "Reliability",
      "plain": "Whether stated confidence matches reality: when the model said it was 70% sure, it should have been right about 70% of the time."
    },
    "analogue": {
      "name": "Analogue",
      "plain": "A past moment whose conditions closely resemble what's coming. One forecaster works purely by finding these look-alikes and assuming history will rhyme."
    },
    "powercurve": {
      "name": "Power curve",
      "plain": "The relationship between wind speed and a turbine's output: nothing in light air, a steep climb, then flat at full power. Each machine has its own version, like a car's fuel-economy curve."
    },
    "region": {
      "name": "Region",
      "plain": "One of five zones in the eastern electricity market, roughly one per state: New South Wales, Queensland, South Australia, Tasmania and Victoria."
    },
    "price": {
      "name": "Wholesale price",
      "plain": "What a chunk of electricity sells for, set every five minutes. It can go negative when there's more solar than anyone needs — sellers effectively paying buyers to take it."
    },
    "revenue": {
      "name": "Revenue",
      "plain": "A running total of what the tracked stations have earned: output multiplied by the going price at the time."
    },
    "fueltech": {
      "name": "Fuel type",
      "plain": "The fuel or technology a station uses to make power — coal, gas, water, wind, sun or batteries. Each keeps its own colour in the charts."
    },
    "correlation": {
      "name": "Correlation",
      "plain": "How closely two things move together. High correlation between wind speed and output means the turbines dance to the weather's tune."
    }
  },
  "fueltechs": {
    "coal_black": "Black coal — the wide, steady base: runs day and night and takes no notice of the weather.",
    "coal_brown": "Brown coal — Victoria's slow burners: cheap, constant, and even less inclined to move.",
    "gas_ccgt": "Combined-cycle gas — the efficient middle-distance runner: happy to run for hours when the market calls.",
    "gas_ocgt": "Open-cycle gas — the sprinter: fires up fast for the expensive moments, then shuts straight down.",
    "hydro": "Hydro — stored rain in the mountains: on tap within minutes, saved for when it's worth the most.",
    "wind": "Wind — comes and goes with the weather, which is exactly why it's worth forecasting.",
    "solar_utility": "Utility solar — the yellow daily hump: up with the sun, peaks at midday, gone by dinner.",
    "battery_discharging": "Batteries (sending) — a short, sharp burst of stored power, sold back in the expensive evenings.",
    "battery_charging": "Batteries (filling) — the same boxes drinking cheap midday solar, drawn as negative because they're taking power, not making it.",
    "bioenergy": "Bioenergy — a quiet, steady trickle from burning waste and crop leftovers.",
    "distillate": "Distillate — diesel of last resort: the emergency spare tyre, rarely used and never cheap."
  },
  "story": {
    "loading": "Loading a fixed 21-day slice of grid history — {status}.",
    "running": "Replaying {time}: {n} tracked stations were making {gw} GW, and the hour-ahead forecast is running {skill} better than guessing nothing would change.",
    "finished": "Replay complete: across {days} days of history, the hour-ahead forecast finished {skill} better than assuming nothing ever changes."
  }
};
