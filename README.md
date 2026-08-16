# Hex Wargame Engine — Napoleon at War

A tiny, **reusable hex-and-counter wargame engine** that now implements the
**Napoleon at War** system — the classic SPI ruleset published on the
[HexWar wiki](https://www.hexwar.com/wiki/games/napoleon-at-war/common/common-rules.html) —
as a shared body of *common rules*, with each battle adding its own
*exclusive rules*, exactly like the printed series. Four playable scenarios
ship on it (hot-seat, two players, mobile browser):

- **Napoleon at Waterloo** — 27×22, June 18, 1815. A race to destroy 40
  enemy strength points; from Turn 2 the Prussians pour in from the east,
  and the French can still win by marching seven units off toward Brussels.
- **Waterloo — Grouchy Variant** — the same battle with the official
  optional rule: a secret die roll per side decides whether Grouchy's
  detachment returns and how much of Blücher's army shows up.
- **Ridge Assault** — 9×11, a short fight for one town; fits on a phone screen.
- **Sambre Crossing** — 24×18, an army-sized battle across a river. Drag to
  scroll and pinch to zoom.

You pick one on the start screen.

No build step, no dependencies, no server required. It's plain HTML + Canvas +
vanilla JavaScript, so it runs by just opening a file.

---

## Play it on your phone (no deploy)

Serve the folder and open it from your phone on the **same Wi‑Fi** — nothing
leaves your network:

```bash
cd hex && python3 -m http.server 8000
```

Then open `http://<your-LAN-IP>:8000` on the phone. Find the IP with
`ipconfig getifaddr en0` (macOS), `hostname -I` (Linux) or `ipconfig` → IPv4
Address (Windows).

On a desktop you can skip the server and open `index.html` from `file://`. For a
real URL, **Settings → Pages → Deploy from branch** gives you GitHub Pages off
this repo's root, with no other infrastructure.

> Tip: in a mobile browser use "Add to Home Screen" to get a full‑screen,
> app‑like launcher.

---

## The Napoleon at War common rules

Every scenario plays by the series' Standard Rules (scale: 1 hex ≈ 400–800 m,
1 Strength Point ≈ 500–1,000 men, 1 game-turn ≈ 1–2 hours):

- **Sequence of play.** Alternating player-turns, each a **Movement Phase**
  then a **Combat Phase**. Night game-turns have no Combat Phase at all, and
  at night nobody may even enter an enemy ZOC.
- **Movement & Zones of Control.** Terrain costs movement points; friendly
  units are moved *through* freely (never ended upon); entering the six
  hexes around an enemy unit (its ZOC) stops a unit dead — and a unit that
  **starts** its Movement Phase in an enemy ZOC is locked in place. The only
  ways out are winning, retreating, or dying.
- **Terrain (the official key).** Clear costs 1 MP; **woods are prohibited
  to movement** and block artillery lines of sight; **Woods-Road** hexes may
  be entered or exited only through a road hexside; **buildings double the
  defender**. Roads move you at **½ MP per hex** (trails at 1), streams cost
  +2 MP to cross, and **rivers** can be crossed only at bridges — an
  unbridged river hexside also blocks ZOCs and all combat except
  bombardment.
- **Combat is compulsory.** Every enemy unit adjacent to your units must be
  attacked, and every one of your units adjacent to an enemy must attack —
  each unit once per phase, each defender attacked once. You choose the
  groupings: tap enemies to build a battle (a unit touching two enemies
  attacks both at once as a combined defense), then pick which of your units
  join. The phase will not end while a fightable mandatory battle waits.
- **The CRT** (the official chart). Total attacking CS against total
  defending CS × terrain, rounded down to a column (1-5 … 6-1); one die.
  Results: **Ae** (all engaged attackers eliminated), **Ar** (engaged
  attackers retreat), **Ex** (defender eliminated, attacker loses at least
  as many strength points from engaged units), **Dr** (defender retreats),
  **De** (defender eliminated). Attacks worse than 1-5 are treated as 1-5,
  better than 6-1 as 6-1. There is no "no effect" — every battle bites.
- **Retreats are one hex,** never into an enemy ZOC. A retreater with no
  vacant hex **displaces** a friendly neighbour, who retreats in turn (chains
  allowed); only when nobody can make room does the retreater die — and a
  displaced, unfired artillery unit loses its shot for the phase.
- **Advance after combat.** When a hex is vacated by combat, one victorious
  unit — the attacker's or, after Ar/Ae, the **defender's** — may immediately
  advance into it, ignoring ZOCs.
- **Artillery** may bombard up to **two hexes** away. Bombardment is
  voluntary, never allowed from inside an enemy ZOC, and needs a clear **line
  of sight** — woods and towns block it (a shot along a hexside is spoiled
  only if both flanking hexes block). Guns firing from range are never
  touched by the result — only adjacent attackers pay.
- **Demoralization.** Scenarios can give each army a Demoralization Level;
  when its cumulative eliminated strength points reach it, the army breaks.
  What that means is the scenario's call — instant defeat, or fighting on
  under a penalty, as at Waterloo (the HUD tracks the totals live).
- **Reinforcements** arrive on schedule at their map edge, pay 1 MP for the
  entry hex, and fight the same turn.

### Exclusive rules — Napoleon at Waterloo

Implemented from the game's official **Exclusive Rules** sheet (they layer
on top of the Standard Rules; the app enforces all of them):

- **Prussians arrive on Game-Turn 2** on non-woods hexes of the easternmost
  column — and never on an entry hex inside a French Zone of Control.
- **Victory is a race to 40.** Each side tries to destroy 40 enemy strength
  points (Prussian losses count against the Allied total). The Allies win
  the instant the French lose 40 while the Allies are still under 40.
- **Losing 40 SP demoralizes the Allies but doesn't end the game** — from
  then on every Allied attack is resolved one CRT column worse and every
  French attack one column better (the battle card shows the shift).
- **The French win by exiting.** With the Allies demoralized, the French
  must also march **seven units off the north-edge exit hexes** (the road
  to Brussels, marked ▲ on the map) during their Movement Phases. Exited
  units are safely off the map — they don't count as losses. Anything less
  by nightfall (end of Turn 10) is a draw; if both armies cross 40, the
  side that broke first loses.
- **Only woods block artillery lines of sight here** — the stone farms of
  La Haye Sainte and Hougoumont do not (a per-scenario override of the
  common Terrain Key).
- **The attacker may voluntarily lower the combat ratio** before rolling
  (the "Lower odds" control on the battle card), e.g. to fish for an
  Exchange.
- **The Grouchy Variant** (its own entry on the start screen): each side
  secretly rolls a code 1–6 before play. The French code decides whether
  Grouchy's five counters (5-4, 4-4, 4-4, 2-5, 3-3) arrive on Turn 4 from
  the south-east; the Prussian code cancels, delays or reduces Blücher's
  columns per the official table.
- The map follows the published NAW Waterloo map: open farmland, the
  villages in their historical places, the Bois de Paris on the eastern
  flank, and the yellow road net (the Brussels highway, the Nivelles road,
  the lateral to Braine-l'Alleud, the eastern road by Ohain) as ½-MP road
  hexsides.

The other two scenarios keep their own exclusive content — maps, armies and
their objective-based victory conditions — on the same standard terrain
chart. Sambre Crossing's river is a true hexside river with three bridges.

## How to play (the app)

- **Move:** tap your unit → tap a highlighted (green) hex. Locked and moved
  units are dimmed; **Undo** takes back your last move.
- **Fight:** tap enemies to group a battle (mandatory targets glow bright
  red, your obligated units amber), press **Attack**, toggle the attacker
  chips if you want to hold units back, and roll. Answer the advance prompt
  when you clear a hex.
- Counters read **letter + `CS·MA`** — combat strength and movement
  allowance. Artillery adds a third number, its **range**. Prussian counters
  are slate-dark so the Allied player can tell their armies apart.
- **Press and hold a hex** (right-click on desktop) to inspect it — terrain,
  its unit, and why a unit can't move; any tap dismisses the panel. The
  HUD's small pill tracks each army's losses against its demoralization
  level.

### Save & resume

The game autosaves after every action to the browser's localStorage — one slot.
Close the tab (or the home-screen app) mid-battle and the start screen offers
**Continue** with the turn, side and phase you left (even mid-advance);
starting a new battle abandons it. Saves never leave the device, and in
private browsing the game simply runs without persistence.

### Getting around a big map

The board can be larger than the screen. A camera handles that:

| Gesture | Does |
|---------|------|
| **Drag** (or mouse-drag) | scroll the map |
| **Pinch** (or scroll wheel) | zoom, around your fingers / the cursor |
| **Fit** button, top right | frame the whole battlefield; tap again to go back |

A tap only counts if you barely moved, so scrolling can never nudge a unit. The
map can't be dragged off into nothing, and the camera follows the action.

---

## Project layout — the engine, the common rules, the games

Three layers, each thinner than the last:

```
index.html                 markup + styles; loads the scripts below
src/
  hex.js                   hex geometry: coords, neighbors, distance,
                           pixel<->hex layout, weighted pathfinding (Dijkstra)
  engine.js                the wargame engine: board, units, turns/phases,
                           ZOC (incl. locking), movement, odds-based combat,
                           mandatory-combat bookkeeping, advance after combat,
                           reinforcements, per-army loss tracking, save/restore.
                           The NAW common rules ARE the engine; DOM-free.
  renderer.js              Canvas renderer + camera: drawing, pan/zoom, picking
games/
  napoleon-at-war-common.js  the SERIES: the NAW CRT, terrain chart, combat
                           results, demoralization helpers, buildScenario().
                           Not a scenario — a ruleset library.
  napoleon-at-waterloo.js  a GAME: map, order of battle, Prussian schedule,
  ridge-assault.js         demoralization levels, victory — the exclusive
  sambre-crossing.js       rules. Each registers itself in `HEX_SCENARIOS`.
app.js                     glue for this app: gestures, HUD, overlays, the
                           battle dialog (attacker chips, advance prompt)
test/
  engine.test.js           core rules: movement, ZOC, combat, victory
  naw.test.js              the NAW layer: locking, mandatory combat, CRT
                           bands, strict retreats, advances, demoralization,
                           reinforcements, save/restore of it all
  camera.test.js           camera math + scenario-integrity checks
  persist.test.js          save/resume round trips and rejection of bad saves
```

### Make your own scenario

Copy `games/ridge-assault.js` and edit the data inside
`NAW_COMMON.buildScenario({...})`: `unitTypes` (via `NAW.unit(name, glyph,
CS, MA, {range, army, color})`), extra `terrain`, the ASCII `map`, `setup`,
`maxTurns`, `victory()`, and optionally `reinforcements`, `demoralization`
and `nightTurns` — that's a battle's exclusive rules. Add a `<script>` tag in
`index.html` and keep the last line pushing the def onto `HEX_SCENARIOS`.
Any common rule can still be overridden per scenario through the `rules:{}`
function hooks (`applyResult`, `oddsColumn`, `skipPhase`, …) or a custom
`crt` — but there is no legacy fallback ruleset: sticky ZOC, mandatory
combat, one-hex retreats and advances are the engine's only behavior, and a
`crt` is required.

Maps may be any size — the camera handles the rest — and may be ragged (a
space means "no hex here"). Terrain with `passable: false` is a wall, which is
how the rivers work.

---

## Tests

```bash
npm test          # pure Node, no install needed
```

393 headless assertions across the four suites above, plus an optional
browser smoke test (Playwright) that drives a real battle — mandatory combat,
the advance prompt, the Prussian arrival, save/resume — through the actual UI.

---

## Fidelity notes

The mechanics are implemented from the published **Napoleon At War Standard
Rules text** (sections 4.0–10.0: sequence, movement incl. friendly
pass-through and hexside costs, Zones of Control incl. rivers, mandatory and
multi-hex combat, retreats with displacement, advances for either victor,
the artillery rules with Line of Sight, and night game-turns). The
**Combat Results Table and the Terrain Key are the official charts**
(clear / woods-prohibited / road-bound Woods-Road / doubling buildings),
the Waterloo map is drawn from the published game map, and the Waterloo
scenario follows the game's official **Exclusive Rules** (Turn-2 Prussians,
the 40-SP race, demoralization column shifts, the seven-unit exit, the
Grouchy Variant tables, towns-don't-block-LOS). Still **reconstructions**,
all plain data in one place each:

- the **Slope and Marsh** terrain values
  (`games/napoleon-at-war-common.js`) — used by the two non-Waterloo
  scenarios, not part of the game's key;
- parts of the Waterloo **order of battle**
  (`games/napoleon-at-waterloo.js`): the Guard units' values and the exact
  Prussian counter mix are sized to the series' scale (the Grouchy
  detachment itself uses the counter values named in the official variant
  table).

Documented simplifications of the printed rules: the retreat/displacement
hex and the Exchange losses are auto-picked (farthest-from-enemy /
weakest-first) rather than chosen by the owning player; one advance per
combat when several hexes are vacated; reinforcements auto-place on the
first free entry hex instead of asking, and the voluntary hold-back option
([7.3]) isn't offered; the required-bombardment displacement exception
([6.5]) and the voluntary gun fallback before melee ([6.8]) are not
modeled; and Grouchy-variant codes are rolled at setup and visible to both
players rather than kept secret until the arrival turn.
