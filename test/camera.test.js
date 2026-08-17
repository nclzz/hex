/* Headless camera + scenario tests — no dependencies, no DOM.
   Run: node test/camera.test.js
   HexRenderer only touches canvas.getContext/width/height/style and
   container.clientWidth/Height, so a handful of stubs is enough to drive the
   camera math (fit, pan clamping, zoom about a focal point) headlessly. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const ctx = { Math, JSON, console };
ctx.window = undefined;                // force the "globalThis" branch
vm.createContext(ctx);
for (const f of ["src/hex.js", "src/engine.js", "src/renderer.js",
                 "games/napoleon-at-war-common.js",
                 "games/ridge-assault.js", "games/sambre-crossing.js",
                 "games/napoleon-at-waterloo.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}
const { Hex, HexWar, HexRenderer,
        RIDGE_ASSAULT, SAMBRE_CROSSING, NAPOLEON_AT_WATERLOO } = ctx;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* --- stubs ------------------------------------------------------------- */
function fakeCanvas() {
  const noop = () => {};
  return {
    width: 0, height: 0, style: {},
    getContext: () => ({ setTransform: noop, save: noop, restore: noop, clearRect: noop }),
  };
}
const container = (w, h) => ({ clientWidth: w, clientHeight: h });

function mount(def, w = 390, h = 600) {
  const game = new HexWar.Game(def);
  const r = new HexRenderer(fakeCanvas(), { orientation: def.orientation });
  r.setBoard([...game.board.values()]);
  r.resize(container(w, h));
  return { game, r };
}

/* --- world coordinates ------------------------------------------------- */
{
  const L = new Hex.Layout({ orientation: "pointy", size: 1, origin: { x: 0, y: 0 } });
  const h = { q: 3, r: -2 };
  const w = Hex.Layout.worldOf(h, "pointy"), c = L.center(h);
  ok(near(w.x, c.x) && near(w.y, c.y), "worldOf == center at size 1, origin 0");
  const Lf = new Hex.Layout({ orientation: "flat", size: 1, origin: { x: 0, y: 0 } });
  const wf = Hex.Layout.worldOf(h, "flat"), cf = Lf.center(h);
  ok(near(wf.x, cf.x) && near(wf.y, cf.y), "worldOf == center for flat-top too");
}

/* --- pixelToHex round-trips ------------------------------------------- */
for (const def of [RIDGE_ASSAULT, SAMBRE_CROSSING]) {
  const { game, r } = mount(def);
  let bad = 0, off = 0;
  for (const [, hex] of game.board) {
    const c = r.layout.center(hex);
    const a = r.layout.pixelToHex(c.x, c.y);
    if (a.q !== hex.q || a.r !== hex.r) bad++;
    // a point just inside the hex must round to the same hex
    const e = r.layout.pixelToHex(c.x + r.size * 0.4, c.y);
    if (Hex.distance(e, hex) > 1) off++;
  }
  ok(bad === 0, `${def.id}: pixelToHex round-trips every hex centre (${bad} bad)`);
  ok(off === 0, `${def.id}: pixelToHex stays local near a centre (${off} bad)`);
  // far outside the board -> no hex
  ok(r.pick(game, -10000, -10000) === null, `${def.id}: pick off-board returns null`);
  const anyHex = [...game.board.values()][0];
  const c0 = r.layout.center(anyHex);
  ok(r.pick(game, c0.x, c0.y) === anyHex, `${def.id}: pick returns the tapped hex`);
}

/* --- fit() still frames the board exactly as it used to ---------------- */
{
  const game = new HexWar.Game(RIDGE_ASSAULT);
  const hexes = [...game.board.values()];
  const W = 390, H = 600, PAD = 6;
  const r = new HexRenderer(fakeCanvas(), { orientation: "pointy" });
  r.fit(hexes, container(W, H));

  const b = Hex.Layout.unitBounds(hexes, "pointy");
  const size = Math.min((W - 2 * PAD) / b.spanX, (H - 2 * PAD) / b.spanY);
  const offX = (W - size * b.spanX) / 2, offY = (H - size * b.spanY) / 2;
  const ox = offX + size * Math.sqrt(3) / 2 - size * b.minX;
  const oy = offY + size - size * b.minY;

  ok(near(r.layout.size, size, 1e-9), "fit() reproduces the legacy hex size");
  ok(near(r.layout.origin.x, ox, 1e-9) && near(r.layout.origin.y, oy, 1e-9),
     "fit() reproduces the legacy board origin");
  ok(near(r.zoom, 1), "fit() leaves the camera at min zoom");
  ok(r.contentOverflows() === false, "a fitted board does not overflow");
}

/* --- opening shot: small map whole, big map zoomed in ------------------ */
{
  const ra = mount(RIDGE_ASSAULT);
  ra.r.frameDefault();
  ok(near(ra.r.zoom, 1), "Ridge Assault opens showing the whole board (zoom 1)");

  const sc = mount(SAMBRE_CROSSING);
  sc.r.frameDefault();
  ok(sc.r.zoom > 1, "Sambre Crossing opens zoomed in past the fit");
  ok(sc.r.size >= 18, "…at a legible hex size (" + sc.r.size.toFixed(1) + "px)");
  ok(sc.r.contentOverflows() === true, "…and the board extends past the viewport");
  ok(sc.r.zoom <= sc.r.maxZoom + 1e-9, "zoom never exceeds maxZoom");
}

/* --- pan clamping ------------------------------------------------------ */
{
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  const W = 390, H = 600, PAD = r.pad;

  r.panByPixels(100000, 100000); // drag the board off to the bottom-right
  let x = r._worldRange("x"), y = r._worldRange("y");
  ok(near(r.layout.origin.x + x.lo * r.size, PAD, 1e-6),
     "panning right stops with the left edge at the padding");
  ok(near(r.layout.origin.y + y.lo * r.size, PAD, 1e-6),
     "panning down stops with the top edge at the padding");

  r.panByPixels(-100000, -100000); // and off to the top-left
  ok(near(r.layout.origin.x + x.hi * r.size, W - PAD, 1e-6),
     "panning left stops with the right edge at the padding");
  ok(near(r.layout.origin.y + y.hi * r.size, H - PAD, 1e-6),
     "panning up stops with the bottom edge at the padding");
}
{
  // An axis the board does not fill stays centred no matter how hard you drag.
  const { r } = mount(RIDGE_ASSAULT);
  r.frameDefault();
  const camX = r.cam.x;
  r.panByPixels(5000, 0);
  ok(near(r.cam.x, camX), "a board narrower than the viewport stays centred");
}

/* --- zoom about a focal point ------------------------------------------ */
{
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  const fx = 120, fy = 410;
  const before = r.screenToWorld(fx, fy);
  r.zoomAt(1.6, fx, fy);
  const after = r.screenToWorld(fx, fy);
  ok(near(before.x, after.x, 1e-9) && near(before.y, after.y, 1e-9),
     "zoomAt keeps the world point under the focus fixed");

  r.zoomAt(0.0001, fx, fy);
  ok(near(r.zoom, 1), "zooming way out clamps to zoom 1");
  r.zoomAt(10000, fx, fy);
  ok(near(r.zoom, r.maxZoom), "zooming way in clamps to maxZoom");
  ok(near(r.size, 46, 1e-6), "maxZoom caps the hex size at 46px");
}

/* --- resize keeps the camera's world focus ----------------------------- */
{
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  r.panByPixels(-60, -90);
  const cam = { x: r.cam.x, y: r.cam.y }, size = r.size;
  r.resize(container(700, 420)); // rotate to landscape
  ok(near(r.size, size, 1e-9), "resize holds the on-screen hex size, not the zoom ratio");
  ok(r.zoom !== 1, "…which means the zoom ratio itself changed");
  ok(Math.abs(r.cam.x - cam.x) < 3 && Math.abs(r.cam.y - cam.y) < 3,
     "resize preserves the camera focus (re-clamped only)");
}
{
  // A board framed whole stays framed whole when the viewport changes.
  const { r } = mount(RIDGE_ASSAULT);
  r.frameAll();
  r.resize(container(700, 420));
  ok(near(r.zoom, 1), "a fitted board stays fitted across a resize");
  ok(r.contentOverflows() === false, "…and still shows the whole map");
}

/* --- ensureVisible ----------------------------------------------------- */
{
  const { game, r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  r.centerOn(game.hex(...Object.values(Hex.offsetToAxial(2, 16, "odd-r"))));
  const far = game.hex(...Object.values(Hex.offsetToAxial(20, 2, "odd-r")));
  ok(r.ensureVisible(far) === true, "ensureVisible scrolls to an off-screen hex");
  const c = r.layout.center(far);
  ok(c.x >= 0 && c.x <= r.vw && c.y >= 0 && c.y <= r.vh, "…and it lands inside the viewport");
  ok(r.ensureVisible(far) === false, "ensureVisible is a no-op once already visible");
}

/* --- viewport insets: framing dodges a docked panel -------------------- */
const off = (c, rw) => game0.hex(...Object.values(Hex.offsetToAxial(c, rw, "odd-r")));
let game0; // set per-block below
{
  // Declaring no insets changes nothing at all.
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  const size = r.size, cam = { ...r.cam };
  ok(r.setInsets({}) === false, "setInsets with no insets reports no change");
  ok(near(r.size, size) && near(r.cam.x, cam.x) && near(r.cam.y, cam.y),
     "…and leaves the camera exactly where it was");
  ok(near(r._slice("y").span, 600) && near(r._slice("x").span, 390),
     "the uncovered slice defaults to the whole canvas");
}
{
  // Opening a panel must not visibly shrink the map: the absolute hex size is
  // held, exactly as across a resize.
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  const size = r.size, zoom = r.zoom;
  ok(r.setInsets({ bottom: 220 }) === true, "setInsets reports the change");
  ok(near(r.size, size, 1e-9), "a docked panel holds the on-screen hex size");
  ok(r.zoom >= zoom, "…never by zooming the player out");
  ok(near(r._slice("y").span, 380), "the slice is the canvas minus the panel");
  ok(near(r._slice("y").mid, 190), "…and its centre sits above the panel");
  // Deep enough that the covered axis becomes the one that binds the fit: the
  // zoom ratio has to climb to keep the hexes the same size on screen.
  r.setInsets({ bottom: 380 });
  ok(near(r.size, size, 1e-9), "…still the same hex size once the panel binds the fit");
  ok(r.zoom > zoom, "…and the zoom ratio climbed to hold it");
}
{
  // Even a board framed whole must not rescale when a panel opens: the panel
  // covers part of the map, it never shrinks it. The camera is untouched, and
  // closing the panel restores the exact original view.
  const { r } = mount(RIDGE_ASSAULT);
  r.frameAll();
  const size = r.size, cam = { ...r.cam };
  r.setInsets({ bottom: 200 });
  ok(near(r.size, size, 1e-9), "a fitted board keeps its hex size when a panel opens");
  ok(r.zoom > 1, "…so the zoom ratio climbed instead of re-fitting");
  ok(near(r.cam.x, cam.x, 1e-6) && near(r.cam.y, cam.y, 1e-6),
     "…and the camera focus did not move (the panel just covers the bottom)");
  // The player can still pull the covered part out from behind the panel…
  const y = r._worldRange("y");
  r.panByPixels(0, -100000);
  ok(r.layout.origin.y + y.hi * r.size <= 400 - r.pad + 1e-6,
     "…panning up brings the board's bottom edge clear of the panel");
  r.setInsets({});
  ok(near(r.size, size, 1e-9) && near(r.zoom, 1) &&
     near(r.cam.x, cam.x, 1e-6) && near(r.cam.y, cam.y, 1e-6),
     "closing the panel restores the exact original view");
}
{
  const m = mount(SAMBRE_CROSSING); game0 = m.game;
  const r = m.r;
  r.frameDefault();
  r.setInsets({ bottom: 200 });
  const mid = off(12, 9);
  r.centerOn(mid);
  ok(near(r.layout.center(mid).y, 200, 1e-6),
     "centerOn parks the hex in the middle of the UNCOVERED strip");
  ok(near(r.layout.center(mid).x, 195, 1e-6), "…and horizontally as before");
}
{
  const m = mount(SAMBRE_CROSSING); game0 = m.game;
  const r = m.r;
  r.frameDefault();
  r.setInsets({ bottom: 200 });
  r.centerOn(off(2, 2));
  const target = off(20, 16);
  ok(r.ensureVisible(target) === true, "ensureVisible still scrolls to a far hex");
  const c = r.layout.center(target);
  ok(c.y >= 0 && c.y <= 400, "…and lands it above the panel, not behind it");
  ok(r.ensureVisible(target) === false, "…then reports nothing left to do");
}
{
  // A whole battle behind the panel is panned — never zoomed — into the strip.
  const m = mount(SAMBRE_CROSSING); game0 = m.game;
  const r = m.r;
  r.frameDefault();
  r.setInsets({ bottom: 200 });
  r.centerOn(off(4, 3));
  const zoom = r.zoom, size = r.size;
  const battle = [off(18, 14), off(19, 14), off(18, 15)];
  ok(r.ensureHexesVisible(battle) === true, "ensureHexesVisible scrolls to a far battle");
  ok(near(r.zoom, zoom) && near(r.size, size), "…without touching the zoom");
  ok(battle.every((h) => {
    const c = r.layout.center(h);
    return c.x >= 0 && c.x <= 390 && c.y >= 0 && c.y <= 400;
  }), "…and every hex lands in the uncovered strip");
  ok(r.ensureHexesVisible(battle) === false, "…then reports nothing left to do");

  // A battle wider than the strip cannot fit whole at this zoom: it is
  // centred instead — still without zooming.
  const wide = [off(1, 1), off(22, 16)];
  r.ensureHexesVisible(wide);
  ok(near(r.zoom, zoom) && near(r.size, size), "a too-wide battle still never changes the zoom");
  const cs = wide.map((h) => r.layout.center(h));
  ok(Math.abs((cs[0].x + cs[1].x) / 2 - 195) < r.size * 2 &&
     Math.abs((cs[0].y + cs[1].y) / 2 - 200) < r.size * 2,
     "…its midpoint is brought to the centre of the strip");
}
{
  // The clamp has to let the board be pulled up against the panel; otherwise a
  // battle on the southern edge can never be brought out from behind it.
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  r.setInsets({ bottom: 200 });
  const PAD = r.pad, y = r._worldRange("y");
  r.panByPixels(0, -100000); // drag the board up, revealing its bottom edge
  ok(near(r.layout.origin.y + y.hi * r.size, 600 - 200 - PAD, 1e-6),
     "panning up stops with the board's bottom edge at the panel, not the canvas");
  r.panByPixels(0, 100000);
  ok(near(r.layout.origin.y + y.lo * r.size, PAD, 1e-6),
     "…and the top edge still stops at the padding");
}
{
  const m = mount(SAMBRE_CROSSING); game0 = m.game;
  const r = m.r;
  r.frameDefault();
  r.setInsets({ bottom: 200 });
  const zoom = r.zoom;
  const battle = [off(4, 3), off(5, 3), off(4, 4)];
  r.frameHexes(battle);
  ok(r.zoom <= zoom + 1e-9, "frameHexes never zooms IN on the player");
  const inSlice = battle.every((h) => {
    const c = r.layout.center(h);
    return c.x >= 0 && c.x <= 390 && c.y >= 0 && c.y <= 400;
  });
  ok(inSlice, "…and puts every hex of the battle in the uncovered strip");

  // A battle spread across the whole map has to pull the camera back.
  const wide = [off(1, 1), off(22, 16)];
  r.frameHexes(wide);
  ok(r.zoom < zoom, "a battle wider than the strip zooms out to fit");
  ok(wide.every((h) => {
    const c = r.layout.center(h);
    return c.x >= -1 && c.x <= 391 && c.y >= -1 && c.y <= 401;
  }), "…and still fits both ends in the strip");
}
{
  // A panel that would leave no board worth looking at is ignored outright.
  const { r } = mount(SAMBRE_CROSSING);
  r.frameDefault();
  const span = r._slice("y").span;
  r.setInsets({ bottom: 590 });
  ok(near(r._slice("y").span, span), "an inset leaving no room falls back to the canvas");
}
{
  // The side rail: the same rules, on the other axis.
  const { r } = mount(SAMBRE_CROSSING, 700, 420);
  r.frameDefault();
  r.setInsets({ right: 320 });
  ok(near(r._slice("x").span, 380) && near(r._slice("x").mid, 190),
     "a side rail insets the horizontal slice");
  ok(near(r._slice("y").span, 420), "…and leaves the vertical one whole");
}

/* --- the new scenario's map is sound ----------------------------------- */
{
  const def = SAMBRE_CROSSING;
  const g = new HexWar.Game(def);
  ok(def.map.every((row) => row.length === 24), "every map row is 24 hexes wide");
  ok(def.map.length === 18, "the map is 18 rows deep");
  ok(g.board.size === 24 * 18, "board has 432 hexes");
  ok(def.map.join("").split("").every((c) => def.terrain[c]),
     "every map character maps to a declared terrain");

  const passable = (h) => def.terrain[h.terrain].passable !== false;
  // objectives
  for (const o of g.objectives) {
    const h = g.hex(o.q, o.r);
    ok(!!h && passable(h) && h.terrain === "t", `objective at ${o.q},${o.r} is a town hex`);
  }
  ok(g.objectives.length === 3, "three town objectives");
  // units
  const seen = new Set();
  let bad = 0, stacked = 0;
  for (const u of g.units) {
    const h = g.hex(u.q, u.r);
    if (!h || !passable(h)) bad++;
    const k = Hex.key(u.q, u.r);
    if (seen.has(k)) stacked++; else seen.add(k);
  }
  ok(g.units.length === 22, "22 units deployed (11 a side)");
  ok(bad === 0, "every unit starts on an existing, passable hex");
  ok(stacked === 0, "no two units start on the same hex");

  // The hexside river must be crossable at the bridges: each side has to be
  // able to walk to every town, never stepping over an unbridged river edge.
  function reaches(from) {
    const seenK = new Set([Hex.key(from.q, from.r)]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of Hex.neighbors(cur)) {
        const k = Hex.key(nb.q, nb.r);
        if (seenK.has(k)) continue;
        if (g.edgeBetween(cur, nb) === "river") continue;
        const h = g.hex(nb.q, nb.r);
        if (!h || !passable(h)) continue;
        seenK.add(k); queue.push(nb);
      }
    }
    return seenK;
  }
  for (const f of def.factions) {
    const start = g.living(f.id)[0];
    const seenK = reaches(start);
    const all = g.objectives.every((o) => seenK.has(Hex.key(o.q, o.r)));
    ok(all, `${f.name} can reach every objective on foot (the bridges work)`);
  }
  // …and the river really is a barrier: without the bridges the south bank
  // cannot reach the northern towns at all.
  const bridges = [...g.edges.values()].filter((t) => t === "bridge").length;
  const rivers = [...g.edges.values()].filter((t) => t === "river").length;
  ok(bridges === 3, "the Sambre has exactly three bridges");
  ok(rivers === 44, "the river runs the full width of the map (44 edges)");
  {
    const noBridges = new HexWar.Game(Object.assign({}, def, {
      hexsides: [{ type: "river", pairs: def.hexsides.flatMap((h) => h.pairs) }],
    }));
    const frStart = noBridges.living("fr")[0];
    const seenK = new Set([Hex.key(frStart.q, frStart.r)]);
    const queue = [frStart];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of Hex.neighbors(cur)) {
        const k = Hex.key(nb.q, nb.r);
        if (seenK.has(k)) continue;
        if (noBridges.edgeBetween(cur, nb) === "river") continue;
        const h = noBridges.hex(nb.q, nb.r);
        if (!h || def.terrain[h.terrain].passable === false) continue;
        seenK.add(k); queue.push(nb);
      }
    }
    ok(noBridges.objectives.every((o) => !seenK.has(Hex.key(o.q, o.r))),
       "with the bridges rivered over, the towns are unreachable");
  }
}

/* --- Napoleon at Waterloo's map is sound -------------------------------- */
{
  const def = NAPOLEON_AT_WATERLOO;
  const g = new HexWar.Game(def);
  ok(def.map.every((row) => row.length === 27), "every Waterloo row is 27 hexes wide");
  ok(def.map.length === 22, "the Waterloo map is 22 rows deep");
  ok(def.map.join("").split("").every((c) => def.terrain[c]),
     "every Waterloo map character maps to a declared terrain");

  const passable = (h) => def.terrain[h.terrain].passable !== false;
  // The French exit hexes all exist, on the north edge, on passable ground.
  ok(def.exitHexes.hexes.length >= 7, "at least seven exit hexes are marked");
  for (const [c, r] of def.exitHexes.hexes) {
    const a = Hex.offsetToAxial(c, r, "odd-r");
    const h = g.hex(a.q, a.r);
    ok(!!h && passable(h) && h.row === 0, `exit hex ${c},${r} is a passable north-edge hex`);
  }

  // Every deployed unit on a real, passable, un-stacked hex.
  const seen = new Set();
  let bad = 0, stacked = 0;
  for (const u of g.units.filter((x) => x.entered)) {
    const h = g.hex(u.q, u.r);
    if (!h || !passable(h)) bad++;
    const k = Hex.key(u.q, u.r);
    if (seen.has(k)) stacked++; else seen.add(k);
  }
  ok(bad === 0, "every deployed unit starts on an existing, passable hex");
  ok(stacked === 0, "no two units share a starting hex");

  // Every Prussian entry hex exists, is passable and is not woods (the
  // exclusive rule: non-woods hexes of the easternmost column).
  for (const grp of def.reinforcements) {
    for (const [c, r] of grp.entry) {
      const a = Hex.offsetToAxial(c, r, "odd-r");
      const h = g.hex(a.q, a.r);
      ok(!!h && passable(h) && h.terrain !== "w" && h.col === 26,
         `entry hex ${c},${r} is a passable non-woods hex of column 26`);
    }
  }

  // Both armies can walk to the objective.
  function reaches(from) {
    const seenK = new Set([Hex.key(from.q, from.r)]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of Hex.neighbors(cur)) {
        const k = Hex.key(nb.q, nb.r);
        if (seenK.has(k)) continue;
        const h = g.hex(nb.q, nb.r);
        if (!h || !passable(h)) continue;
        seenK.add(k); queue.push(nb);
      }
    }
    return seenK;
  }
  const gate = Hex.offsetToAxial(def.exitHexes.hexes[0][0], 0, "odd-r");
  for (const f of def.factions) {
    const start = g.living(f.id)[0];
    ok(reaches(start).has(Hex.key(gate.q, gate.r)),
       `${f.name} can reach the northern exit hexes on foot`);
  }
}

/* --- all scenarios are registered for the picker ------------------------ */
{
  const reg = ctx.HEX_SCENARIOS || [];
  ok(reg.length === 4, "four scenarios registered (incl. the Grouchy variant)");
  ok(reg.indexOf(RIDGE_ASSAULT) >= 0 && reg.indexOf(SAMBRE_CROSSING) >= 0 &&
     reg.indexOf(NAPOLEON_AT_WATERLOO) >= 0 && reg.indexOf(ctx.NAW_GROUCHY) >= 0,
     "the registry holds all four game definitions");
  ok(reg.every((d) => d.title && d.blurb && d.brief),
     "every scenario carries title/blurb/brief for the picker and help");
  ok(reg.every((d) => d.naw === true),
     "every scenario plays by the Napoleon at War common rules");
  // The pre-game wizard needs each scenario's victory conditions, and any
  // side reference must name a real faction of that scenario.
  ok(reg.every((d) => Array.isArray(d.winConditions) && d.winConditions.length >= 2 &&
       d.winConditions.every((c) => c.text && c.text.length > 10)),
     "every scenario spells out its victory conditions for the wizard");
  ok(reg.every((d) => d.winConditions.every((c) =>
       !c.side || d.factions.some((f) => f.id === c.side))),
     "every wizard condition tagged with a side names a real faction");
  ok(ctx.NAW_GROUCHY.winConditions.length === NAPOLEON_AT_WATERLOO.winConditions.length + 1,
     "the Grouchy variant adds its reinforcement-roll note to the wizard");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
