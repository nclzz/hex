# Hex Wargame Engine — Napoleon at War

A tiny, **reusable hex-and-counter wargame engine** that now implements the
**Napoleon at War** system — the classic SPI ruleset published on the
[HexWar wiki](https://www.hexwar.com/wiki/games/napoleon-at-war/common/common-rules.html) —
as a shared body of *common rules*, with each battle adding its own
*exclusive rules*, exactly like the printed series. Three playable scenarios
ship on it (hot-seat, two players, mobile browser):

- **Napoleon at Waterloo** — 22×16, June 18, 1815. Break Wellington's army
  before nightfall; from Turn 3 the Prussians pour in from the east.
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
  then a **Combat Phase**. (Night game-turns, where a scenario has them, skip
  the Combat Phase.)
- **Movement & Zones of Control.** Terrain costs movement points; entering
  the six hexes around an enemy unit (its ZOC) stops a unit dead — and a unit
  that **starts** its Movement Phase in an enemy ZOC is locked in place. The
  only ways out are winning, retreating, or dying.
- **Combat is compulsory.** Every enemy unit adjacent to your units must be
  attacked, and every one of your units adjacent to an enemy must attack —
  each unit once per phase, each defender attacked once. You choose the
  groupings: tap enemies to build a battle (a unit touching two enemies
  attacks both at once as a combined defense), then pick which of your units
  join. The phase will not end while a fightable mandatory battle waits.
- **The CRT.** Total attacking CS against total defending CS × terrain,
  rounded down to a column (1-3 … 5-1); one die. Results: **Ae** (all engaged
  attackers eliminated), **Ar** (engaged attackers retreat), **Ex** (defender
  eliminated, attacker loses at least as many strength points from engaged
  units), **Dr** (defender retreats), **De** (defender eliminated). Worse than
  1-3 is an automatic Ae; better than 5-1 an automatic De. There is no
  "no effect" — every battle bites.
- **Retreats are one hex,** and strict: a unit that would retreat into an
  enemy ZOC, an occupied hex or impassable terrain is eliminated instead.
- **Advance after combat.** When a hex is vacated by combat, one victorious
  engaged unit may immediately advance into it, ignoring ZOCs.
- **Artillery** may bombard up to **two hexes** away. Bombardment is
  voluntary, and guns firing from range are never touched by the result —
  only adjacent attackers pay.
- **Demoralization.** Scenarios can give each army a Demoralization Level;
  when its cumulative eliminated strength points reach it, the army breaks and
  the game ends at that instant (the HUD tracks it live).
- **Reinforcements** arrive on schedule at their map edge, pay 1 MP for the
  entry hex, and fight the same turn.

### Exclusive rules — Napoleon at Waterloo

- Prussian columns (Bülow, then Zieten) enter on non-woods hexes of the
  easternmost column from Game-Turn 3.
- French demoralization at 40 SP, Anglo-Allied at 26. Breaking the Prussians
  (12 SP) doesn't end the game — it *raises the French level by 10*.
  Prussian losses never count against the Anglo-Allied army.
- The French also win at the instant they hold the Mont-Saint-Jean
  crossroads (★). At nightfall (end of Turn 10), the Allies have held.

The other two scenarios keep their own exclusive content — steeper hills and
stouter towns (defense ×3), and their objective-based victory conditions.

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
- **Tap a hex** to inspect its terrain; the HUD's small pill tracks each
  army's losses against its demoralization level.

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
                           Everything opt-in via GameDef flags; DOM-free.
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
Any common rule can still be overridden per scenario through `rules:{}`
(flags and function hooks) or a custom `crt`; a scenario that sets
`lockedZOC/mandatoryCombat/advanceAfterCombat` to `false` falls back to the
engine's permissive defaults.

Maps may be any size — the camera handles the rest — and may be ragged (a
space means "no hex here"). Terrain with `passable: false` is a wall, which is
how the rivers work.

---

## Tests

```bash
npm test          # pure Node, no install needed
```

267 headless assertions across the four suites above, plus an optional
browser smoke test (Playwright) that drives a real battle — mandatory combat,
the advance prompt, the Prussian arrival, save/resume — through the actual UI.

---

## Fidelity notes

The mechanics above follow the HexWar wiki's Standard Rules and the Waterloo
Exclusive Rules. A few data values could not be checked against the wiki from
the environment this was built in (the site was unreachable) and are careful
**reconstructions** of the SPI system — all plain data, one place each, easy
to true up against the published charts:

- the individual **CRT cell values** (`games/napoleon-at-war-common.js`) —
  correct in shape (columns, result mix, monotone in odds and die), not
  guaranteed cell-for-cell;
- the common **terrain chart** numbers (same file);
- the Waterloo **order of battle** and **demoralization levels**
  (`games/napoleon-at-waterloo.js`), sized to the series' scale.

Documented simplifications of the printed rules: the retreat hex and the
Exchange losses are auto-picked (farthest-from-enemy / weakest-first) rather
than chosen by the owning player; one advance per combat when several hexes
are vacated; the defender's advance after an Ae/Ar is not offered yet; and
reinforcements auto-place on the first free entry hex instead of asking.
