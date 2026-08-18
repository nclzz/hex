/* Headless engine tests — no dependencies, no DOM. Run: node test/engine.test.js
   Loads the browser globals (hex.js, engine.js, ridge-assault.js) into this
   process and exercises the rules. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const ctx = { Math, JSON, console };
ctx.window = undefined;                // force the "globalThis" branch
vm.createContext(ctx);
for (const f of ["src/hex.js", "src/engine.js",
                 "games/napoleon-at-war-common.js", "games/ridge-assault.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}
const { Hex, HexWar, RIDGE_ASSAULT } = ctx;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }

/* --- hex math --- */
ok(Hex.distance({ q: 0, r: 0 }, { q: 2, r: -1 }) === 2, "distance");
ok(Hex.neighbors({ q: 0, r: 0 }).length === 6, "six neighbors");

/* --- setup --- */
let g = new HexWar.Game(RIDGE_ASSAULT);
g.rng = () => 0.99; // deterministic high rolls
ok(g.board.size === 9 * 11, "board has 99 hexes");
ok(g.living("fr").length === 5 && g.living("al").length === 5, "5 units per side");
ok(g.turn === 1 && g.activeFaction === "fr" && g.phase === "move", "starts French move");

/* --- movement + ZOC --- */
const cav = g.units.find((u) => u.type === "cav" && u.faction === "fr");
const reach = g.reachable(cav);
ok(reach.size > 0, "cavalry has moves");
// cannot move onto an occupied friendly hex
const friend = g.units.find((u) => u.faction === "fr" && u !== cav);
ok(!reach.has(Hex.key(friend.q, friend.r)), "cannot enter occupied hex");
// move it somewhere reachable, flag flips
const dest = [...reach.values()][0];
ok(g.moveUnit(cav, dest.q, dest.r).ok && cav.moved, "move flips moved flag");
ok(!g.moveUnit(cav, cav.q, cav.r).ok, "cannot move twice");

/* --- ZOC stop: a hex adjacent to an enemy should halt movement --- */
const anyEnemy = g.enemiesOf("fr")[0];
for (const nb of Hex.neighbors(anyEnemy)) {
  ok(g.isEnemyZOC("fr", nb.q, nb.r) === true, "enemy ZOC detected");
  break;
}

/* --- undo move (fresh game so the log starts empty) --- */
{
  const gu = new HexWar.Game(RIDGE_ASSAULT);
  ok(!gu.canUndo(), "canUndo false at start (empty log)");
  ok(gu.undoMove() === null, "undo with empty log returns null");
  const inf = gu.units.find((u) => u.type === "inf" && u.faction === "fr");
  const from = { q: inf.q, r: inf.r };
  const to = [...gu.reachable(inf).values()][0];
  ok(gu.moveUnit(inf, to.q, to.r).ok, "infantry moved for undo test");
  ok(gu.canUndo(), "canUndo true after a move");
  const restored = gu.undoMove();
  ok(restored === inf && inf.q === from.q && inf.r === from.r && !inf.moved, "undo restores position and flag");
  ok(!gu.canUndo(), "nothing left to undo after undoing the only move");
  ok(gu.moveUnit(inf, to.q, to.r).ok, "unit can move again after undo");
  // undo history resets when the phase changes
  gu.endPhase();
  ok(!gu.canUndo(), "undo unavailable outside the move phase");
}

/* --- combat resolution + CRT --- */
g.endPhase(); // move -> combat
ok(g.phase === "combat", "advanced to combat phase");
// Put an attacker adjacent to the defender (explicit lists are validated
// for range) and resolve at die=6.
const def = g.enemiesOf("fr")[0];
const atk1 = g.units.find((u) => u.faction === "fr");
{
  const nb = Hex.neighbors(def).find((n) => g.hex(n.q, n.r) &&
    g.terrain[g.hex(n.q, n.r).terrain].passable !== false && !g.unitAt(n.q, n.r));
  Object.assign(atk1, nb);
}
const before = g.living("al").length;
g.rng = () => 0.99; // die = 6
const res = g.resolveCombat(def, [atk1]);
ok(res.ok, "combat resolves");
ok(["Ae", "Ar", "Ex", "Dr", "De"].includes(res.code), "valid CRT code: " + res.code);

/* --- odds column mapping --- */
ok(g.oddsColumn(10, 2) === "5:1", "10:2 -> 5:1 column");
ok(g.oddsColumn(4, 4) === "1:1", "4:4 -> 1:1 column");
ok(g.oddsColumn(1, 3) === "1:3", "weak attack lands on the 1-3 column");

/* --- ranged artillery: target eligibility --- */
{
  const at = (c, r) => Hex.offsetToAxial(c, r);
  const gr = new HexWar.Game(RIDGE_ASSAULT);
  gr.endPhase(); // French move -> combat
  const D = gr.enemiesOf("fr")[0];
  const art = gr.units.find((u) => u.faction === "fr" && u.type === "art");
  const inf = gr.units.find((u) => u.faction === "fr" && u.type === "inf");
  ok(gr.range(art) === 2 && gr.range(inf) === 1, "artillery range 2, others default to 1");
  Object.assign(D, at(4, 7));
  Object.assign(art, at(2, 7)); // distance 2 — in gun range
  Object.assign(inf, at(3, 7)); // distance 1 — engaged
  ok(Hex.distance(art, D) === 2 && Hex.distance(inf, D) === 1, "ranged test layout holds");
  const atk = gr.attackersFor(D);
  ok(atk.includes(art), "artillery can attack at distance 2");
  ok(atk.includes(inf), "adjacent unit still attacks");
  Object.assign(art, at(1, 7)); // distance 3 — beyond range
  ok(!gr.attackersFor(D).includes(art), "artillery excluded at distance 3");
  Object.assign(inf, at(2, 7)); // infantry at distance 2
  ok(!gr.attackersFor(D).includes(inf), "range 1 unit excluded at distance 2");
  ok(gr.attackerStrength([art]) === 5, "strength undiminished at range");
}

/* --- ranged artillery: end-to-end bombardment via resolveCombat --- */
{
  const at = (c, r) => Hex.offsetToAxial(c, r);
  const gr = new HexWar.Game(RIDGE_ASSAULT);
  gr.rng = () => 0.99; // die = 6
  gr.endPhase();
  const D = gr.enemiesOf("fr")[0];
  const art = gr.units.find((u) => u.faction === "fr" && u.type === "art");
  const inf = gr.units.find((u) => u.faction === "fr" && u.type === "inf");
  Object.assign(D, at(4, 7)); Object.assign(art, at(2, 7)); Object.assign(inf, at(3, 7));
  gr.rng = () => 0.7; // die = 5
  const res = gr.resolveCombat(D); // attackers auto-gathered
  ok(res.ok && res.attackers.includes(art) && res.attackers.includes(inf), "auto-gather includes the gun at range");
  ok(res.atk === 9, "combined strength 5+4 regardless of distance");
  ok(res.code === "Ex" && !D.alive, "2:1 at die 5 is an Exchange — the defender falls");
  ok(!inf.alive && art.alive, "the exchange costs the engaged foot, never the gun");
  ok(art.acted, "bombarding spends the gun's attack");
}

/* --- bombardment safety: adverse results spare units firing at range --- */
{
  const at = (c, r) => Hex.offsetToAxial(c, r);
  // D at (4,7); the gun bombards from (6,7), distance 2; each case adds its
  // own engaged unit adjacent at (3,7).
  const fresh = () => {
    const t = new HexWar.Game(RIDGE_ASSAULT);
    const D = t.enemiesOf("fr")[0];
    const art = t.units.find((u) => u.faction === "fr" && u.type === "art");
    Object.assign(D, at(4, 7)); Object.assign(art, at(6, 7));
    return { t, D, art };
  };
  const adjacent = (t, type) => {
    const u = t.units.find((x) => x.faction === "fr" && x.type === type);
    Object.assign(u, at(3, 7));
    return u;
  };

  { // Ae, pure bombardment: no engaged unit to lose
    const { t, D, art } = fresh();
    const note = t.applyResult("Ae", D, [art]);
    ok(art.alive && D.alive, "Ae costs a lone bombarding gun nothing");
    ok(/no losses/i.test(note), "Ae bombardment note explains it");
  }
  { // Ae, mixed: the weakest ENGAGED unit dies, even though the gun is cheaper
    const { t, D, art } = fresh();
    const grd = adjacent(t, "grd"); // CS 6 > art's 5
    t.applyResult("Ae", D, [art, grd]);
    ok(!grd.alive && art.alive, "Ae kills the engaged unit, never the bombarding gun");
  }
  { // Ar, mixed: only the engaged unit is pushed back
    const { t, D, art } = fresh();
    const inf = adjacent(t, "inf");
    const gunPos = { q: art.q, r: art.r };
    t.applyResult("Ar", D, [art, inf]);
    ok(Hex.distance(inf, D) === 2, "Ar retreats the engaged unit");
    ok(art.q === gunPos.q && art.r === gunPos.r, "Ar leaves the bombarding gun in place");
  }
  { // Ar, pure bombardment: nobody moves
    const { t, D, art } = fresh();
    const gunPos = { q: art.q, r: art.r };
    const note = t.applyResult("Ar", D, [art]);
    ok(art.q === gunPos.q && art.r === gunPos.r, "Ar on a pure bombardment moves no one");
    ok(/unharmed/i.test(note), "Ar bombardment note explains it");
  }
  { // Ex, mixed: losses come from engaged units only
    const { t, D, art } = fresh();
    const inf = adjacent(t, "inf");
    t.applyResult("Ex", D, [art, inf]);
    ok(!D.alive, "Ex kills the defender");
    ok(!inf.alive && art.alive, "Ex losses fall on the engaged unit, not the gun");
  }
  { // Ex, pure bombardment: defender still dies, gun pays nothing
    const { t, D, art } = fresh();
    t.applyResult("Ex", D, [art]);
    ok(!D.alive && art.alive, "Ex on a pure bombardment still kills the defender");
  }
  { // Dr, mixed with the gun listed first: retreat is away from the ENGAGED unit
    const { t, D, art } = fresh();
    const inf = adjacent(t, "inf"); // west of D; the gun is east of D
    t.applyResult("Dr", D, [art, inf]);
    ok(D.alive && Hex.distance(D, inf) === 2,
       "Dr retreats the defender one hex, away from the engaged unit");
  }
  { // Dr, pure bombardment: falls back to retreating from the gun
    const { t, D, art } = fresh();
    t.applyResult("Dr", D, [art]);
    ok(D.alive && Hex.distance(D, art) === 3, "Dr on a pure bombardment retreats from the gun");
  }
}

/* --- victory by objective --- */
let g2 = new HexWar.Game(RIDGE_ASSAULT);
const obj = g2.objectives[0];
const anyFr = g2.living("fr")[0];
// teleport a French unit onto the town and re-check
anyFr.q = obj.q; anyFr.r = obj.r;
ok(g2._checkVictory() === true && g2.winner === "fr", "French win by taking the town");

/* --- victory by timeout --- */
let g3 = new HexWar.Game(RIDGE_ASSAULT);
g3.turn = g3.maxTurns; g3.sideIndex = g3.factions.length - 1;
g3.phaseIndex = g3.phases.length - 1;
g3.endPhase(); // should roll past maxTurns -> timeout
ok(g3.over && g3.winner === "al", "Allies win on timeout");
ok(g3.turn === g3.maxTurns, "the clock never shows a turn past the last");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
