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
for (const f of ["src/hex.js", "src/engine.js", "games/ridge-assault.js"]) {
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
// Force a known 5:1 attack to guarantee a defender-loss result at die=6.
const def = g.enemiesOf("fr")[0];
const atkList = [g.units.find((u) => u.faction === "fr")];
const before = g.living("al").length;
g.rng = () => 0.99; // die = 6
const res = g.resolveCombat(def, atkList);
ok(res.ok, "combat resolves");
ok(["Ae", "Ar", "Ex", "NE", "Dr", "De"].includes(res.code), "valid CRT code: " + res.code);

/* --- odds column mapping --- */
ok(g.oddsColumn(10, 2) === "5:1", "10:2 -> 5:1 column");
ok(g.oddsColumn(4, 4) === "1:1", "4:4 -> 1:1 column");
ok(g.oddsColumn(1, 3) === "1:2", "weak attack clamps to 1:2");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
