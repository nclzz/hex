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

  // The river must be crossable: each side has to be able to walk to every town.
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
  for (const f of def.factions) {
    const start = g.living(f.id)[0];
    const seenK = reaches(start);
    const all = g.objectives.every((o) => seenK.has(Hex.key(o.q, o.r)));
    ok(all, `${f.name} can reach every objective on foot (the fords work)`);
  }
  // …and the river really is a barrier, i.e. the fords are the only way over.
  const fords = def.map[8].split("").filter((c) => c === "=").length;
  ok(fords === 3, "the river row has exactly three crossings");
  ok(def.terrain["~"].passable === false, "river hexes are impassable");
}

/* --- Napoleon at Waterloo's map is sound -------------------------------- */
{
  const def = NAPOLEON_AT_WATERLOO;
  const g = new HexWar.Game(def);
  ok(def.map.every((row) => row.length === 22), "every Waterloo row is 22 hexes wide");
  ok(def.map.length === 16, "the Waterloo map is 16 rows deep");
  ok(def.map.join("").split("").every((c) => def.terrain[c]),
     "every Waterloo map character maps to a declared terrain");

  const passable = (h) => def.terrain[h.terrain].passable !== false;
  const o = g.objectives[0];
  ok(!!g.hex(o.q, o.r) && g.hex(o.q, o.r).terrain === "t",
     "the Mont-Saint-Jean objective sits on a town hex");

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
      ok(!!h && passable(h) && h.terrain !== "w" && h.col === 21,
         `entry hex ${c},${r} is a passable non-woods hex of column 21`);
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
  for (const f of def.factions) {
    const start = g.living(f.id)[0];
    ok(reaches(start).has(Hex.key(o.q, o.r)), `${f.name} can reach the crossroads on foot`);
  }
}

/* --- all three scenarios are registered for the picker ------------------ */
{
  const reg = ctx.HEX_SCENARIOS || [];
  ok(reg.length === 3, "three scenarios registered");
  ok(reg.indexOf(RIDGE_ASSAULT) >= 0 && reg.indexOf(SAMBRE_CROSSING) >= 0 &&
     reg.indexOf(NAPOLEON_AT_WATERLOO) >= 0,
     "the registry holds all three game definitions");
  ok(reg.every((d) => d.title && d.blurb && d.brief),
     "every scenario carries title/blurb/brief for the picker and help");
  ok(reg.every((d) => d.naw === true),
     "every scenario plays by the Napoleon at War common rules");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
