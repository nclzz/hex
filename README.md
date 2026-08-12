# Hex Wargame Engine — *Ridge Assault*

A tiny, **reusable hex-and-counter wargame engine** in the tradition of old SPI
games like *Napoleon at Waterloo*, plus a first playable scenario built on it:
**Ridge Assault** (hot-seat, two players, mobile browser).

No build step, no dependencies, no server required. It's plain HTML + Canvas +
vanilla JavaScript, so it runs by just opening a file.

---

## Play it on your phone (no deploy)

Pick whichever is easiest for you:

### Option A — Local server on your computer (recommended for phone)
The game is a few small files, so serve the folder and open it from your phone
on the **same Wi‑Fi**:

```bash
cd hex
python3 -m http.server 8000
```

Then find your computer's LAN IP (e.g. `192.168.1.23`) and open
`http://192.168.1.23:8000` in your phone's browser. This is not a "deploy" —
nothing leaves your network.

- macOS: `ipconfig getifaddr en0`
- Linux: `hostname -I`
- Windows: `ipconfig` → IPv4 Address

### Option B — Open it directly
Open `index.html` in any browser (desktop works from `file://`). To run from a
phone this way you'd need the whole `hex/` folder on the device; the local‑server
option above is usually simpler.

### Option C — GitHub Pages (a one‑click host, if you ever want a URL)
Repo **Settings → Pages → Deploy from branch**, pick this branch, root folder.
You'll get a URL you can open anywhere. (Technically a deploy, but zero infra.)

> Tip: in a mobile browser use "Add to Home Screen" to get a full‑screen,
> app‑like launcher.

---

## How to play *Ridge Assault*

- **You are the French (blue)** and move first. Capture the **Town** (gold ★) by
  the end of **Turn 6**. The **Allies (red)** win by holding it.
- Each turn a side plays **Movement**, then **Combat**, then passes the device.
- **Move:** tap your unit → tap a highlighted (green) hex. Entering the six hexes
  around an enemy unit (its *Zone of Control*) stops your unit.
- **Combat:** in the Combat phase, tap an enemy adjacent to your units. Every one
  of your adjacent, unused units joins the attack. Odds + a die roll on the
  Combat Results Table decide the outcome.
- Counters read **letter + `CS·MA`** — combat strength and movement allowance.

| Unit | CS | MA |
|------|----|----|
| **I**nfantry | 4 | 4 |
| **C**avalry | 3 | 8 |
| **A**rtillery | 5 | 3 |
| **G**uard | 6 | 4 |

| Terrain | Move cost | Defender ×  |
|---------|-----------|-------------|
| Clear | 1 | ×1 |
| Woods | 2 | ×2 |
| Hill  | 2 | ×3 |
| Town  | 1 | ×3 |

---

## Project layout — the engine vs. the game

The point of the split: **the engine knows nothing about Napoleon.** A new hex
game is mostly a new data file.

```
index.html                 markup + styles; loads the scripts below
src/
  hex.js                   hex geometry: coords, neighbors, distance,
                           pixel<->hex layout, weighted pathfinding (Dijkstra)
  engine.js                the wargame engine: board, units, turns/phases,
                           Zones of Control, movement, odds-based combat + CRT,
                           victory checks. DOM-free, headless-testable.
  renderer.js              Canvas renderer: draws the board, auto-fits the
                           viewport (crisp on retina), and picks hexes from taps
games/
  ridge-assault.js         THE GAME as data: unit types, terrain, map, setup,
                           CRT (uses engine default), and the victory goal
app.js                     glue for this app: input, HUD, overlays, combat dialog
test/
  engine.test.js           headless rules tests (pure Node, no dependencies)
```

### Make your own scenario
Copy `games/ridge-assault.js`, edit the data — `unitTypes`, `terrain`, the ASCII
`map`, `setup`, `maxTurns`, and the `victory()` goal — and point `index.html` at
your file. You can override any rule (movement cost, ZOC, the whole CRT, odds
mapping, die roll) by supplying a `rules: { ... }` block in the game definition;
otherwise the engine's sensible defaults apply.

The engine is the reusable core; scenarios are thin data + a few callbacks.

---

## Tests

```bash
npm test          # runs test/engine.test.js — pure Node, no install needed
```

These drive the engine headlessly (movement, ZOC, combat/CRT, both victory
conditions). The UI is verified separately by loading `index.html` in a headless
browser; that check is optional and not required to run or hack on the game.

---

## Roadmap (kept out of v1 on purpose)

AI opponent, unit stacking, player-chosen retreats, fog of war, more scenarios /
a scenario picker, save & resume, sound. Each is an additive change because the
rules live in one place and scenarios are just data.
