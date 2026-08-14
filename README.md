# Hex Wargame Engine

A tiny, **reusable hex-and-counter wargame engine** in the tradition of old SPI
games like *Napoleon at Waterloo*, plus two playable scenarios built on it
(hot-seat, two players, mobile browser):

- **Ridge Assault** — 9×11, a short fight for one town; fits on a phone screen.
- **Sambre Crossing** — 24×18, an army-sized battle across a river. The map is
  far bigger than any phone, so you **drag to scroll and pinch to zoom**.

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

## How to play

Both scenarios share the same rules; only the map, the armies and the goal differ.

- Each turn a side plays **Movement**, then **Combat**, then passes the device.
- **Move:** tap your unit → tap a highlighted (green) hex. Entering the six hexes
  around an enemy unit (its *Zone of Control*) stops your unit.
- **Combat:** in the Combat phase, tap an enemy adjacent to your units. Every one
  of your adjacent, unused units joins the attack. Odds + a die roll on the
  Combat Results Table decide the outcome.
- Counters read **letter + `CS·MA`** — combat strength and movement allowance.
- **Tap a hex** to inspect its terrain, and **Undo** takes back your last move.

### Save & resume

The game autosaves after every action to the browser's localStorage — one slot.
Close the tab (or the home-screen app) mid-battle and the start screen offers
**Continue** with the turn, side and phase you left; starting a new battle
abandons it. Saves never leave the device, and in private browsing the game
simply runs without persistence.

### Getting around a big map

The board can be larger than the screen. A camera handles that:

| Gesture | Does |
|---------|------|
| **Drag** (or mouse-drag) | scroll the map |
| **Pinch** (or scroll wheel) | zoom, around your fingers / the cursor |
| **Fit** button, top right | frame the whole battlefield; tap again to go back |

A tap only counts if you barely moved, so scrolling can never nudge a unit. The
map can't be dragged off into nothing, and the camera follows the action —
selecting, attacking, undoing and being handed the device all bring the relevant
hexes on screen. On a board that already fits (Ridge Assault on a phone) nothing
changes, and the **Fit** button stays out of the way.

### The scenarios

**Ridge Assault** — you are the **French (blue)** and move first. Capture the
**Town** (gold ★) by the end of **Turn 6**. The **Allies (red)** win by holding it.

**Sambre Crossing** — the French must take **three towns** beyond the river by
the end of **Turn 10**; taking all three ends it at once, and at nightfall the
side holding more towns wins (a tie favours the Allies). The **river is
impassable** and has only **three fords**, so the game is about which crossing
you commit to — and 11 units a side means the flanks are a long march away.

| Unit | CS | MA |
|------|----|----|
| **I**nfantry | 4 | 4 |
| **C**avalry | 3 | 8 |
| **A**rtillery | 5 | 3 |
| **G**uard | 6 | 4 |

| Terrain | Move cost | Defender ×  | Where |
|---------|-----------|-------------|-------|
| Clear | 1 | ×1 | both |
| Woods | 2 | ×2 | both |
| Hill  | 2 | ×3 | both |
| Town  | 1 | ×3 | both |
| Marsh | 3 | ×1 | Sambre Crossing |
| Ford  | 2 | ×1 | Sambre Crossing — the only way over the river |
| River | — | — | Sambre Crossing — impassable |

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
  renderer.js              Canvas renderer + CAMERA: draws the board (crisp on
                           retina, culled to the viewport), owns pan/zoom, and
                           picks hexes from taps
games/
  ridge-assault.js         A GAME as data: unit types, terrain, map, setup,
  sambre-crossing.js       CRT (uses engine default), and the victory goal.
                           Each file registers itself in `HEX_SCENARIOS`.
app.js                     glue for this app: gestures, HUD, overlays, combat
                           dialog, scenario picker
test/
  engine.test.js           headless rules tests (pure Node, no dependencies)
  camera.test.js           headless camera + scenario-integrity tests
```

### The camera

`Layout.center()` is affine in `size` and `origin`, so the camera needs no canvas
transform: **zoom scales `size`, pan translates `origin`**, and drawing and
hit-testing stay in one coordinate system. The renderer keeps `zoom` (1 = the
whole board fits) and `cam`, the world point at the centre of the viewport.
Panning is clamped per axis — an axis the board doesn't fill stays centred, one
it overflows can't be dragged past its edge.

### Make your own scenario
Copy `games/ridge-assault.js` and edit the data: `unitTypes`, `terrain`, the
ASCII `map`, `setup`, `maxTurns`, the `victory()` goal, and the `title`/`blurb`/
`brief` the picker and help overlay display. Add a `<script>` tag in
`index.html`, and keep the last line pushing the def onto `global.HEX_SCENARIOS`
— that's what puts it on the start screen. Any rule (movement cost, ZOC, the
whole CRT, odds mapping, die roll) can be overridden with a `rules: { ... }`
block; otherwise the engine's defaults apply.

Maps may be any size — the camera handles the rest — and may be ragged (a space
means "no hex here"). Terrain with `passable: false` is a wall, which is how
Sambre Crossing's river works. The engine is the reusable core; scenarios are
thin data plus a few callbacks.

---

## Tests

```bash
npm test          # pure Node, no install needed
```

- `engine.test.js` — the rules: movement, ZOC, combat/CRT, both victory conditions.
- `camera.test.js` — the camera, against stub canvas/container objects: pan
  clamping, zoom about a focal point, `pixelToHex` round-trips, and that `fit()`
  still frames a board exactly as it always did. It also checks the scenarios
  themselves — map dimensions, every unit and objective on a real passable hex,
  and both armies able to walk to every objective, which is what catches a typo
  in the river.

The UI is verified separately by loading `index.html` in a headless browser;
that check is optional and not required to run or hack on the game.
