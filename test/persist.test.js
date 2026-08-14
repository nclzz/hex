/* Headless save/resume tests — no dependencies, no DOM.
   Run: node test/persist.test.js
   Exercises Game.serialize()/Game.restore(): the round trip through JSON (the
   real storage boundary), undo after restore, and the validation that discards
   a save which no longer matches its scenario. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const ctx = { Math, JSON, console };
ctx.window = undefined;                // force the "globalThis" branch
vm.createContext(ctx);
for (const f of ["src/hex.js", "src/engine.js",
                 "games/ridge-assault.js", "games/sambre-crossing.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}
const { Hex, HexWar, RIDGE_ASSAULT, SAMBRE_CROSSING } = ctx;
const { Game } = HexWar;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }
function throws(fn, msg) {
  try { fn(); fail++; console.error("  ✗ " + msg + " (did not throw)"); }
  catch (e) { pass++; }
}
// Every save crosses localStorage as a string; test through the same boundary.
const roundtrip = (g) => JSON.parse(JSON.stringify(g.serialize()));

/* --- round-trip mid-Movement ------------------------------------------- */
{
  const g = new Game(RIDGE_ASSAULT);
  const u = g.units.find((x) => x.faction === "fr" && x.type === "cav");
  const dest = [...g.reachable(u).values()][0];
  ok(g.moveUnit(u, dest.q, dest.r).ok, "setup: cavalry moved");

  const r = Game.restore(RIDGE_ASSAULT, roundtrip(g));
  ok(r.turn === g.turn && r.sideIndex === g.sideIndex && r.phaseIndex === g.phaseIndex,
     "turn/side/phase survive the round trip");
  ok(r.activeFaction === "fr" && r.phase === "move", "derived getters agree");
  const ru = r.units[u.id];
  ok(ru.q === u.q && ru.r === u.r, "moved unit is where it was left");
  // the regression for "restore must not re-run _enterPhase()":
  ok(ru.moved === true, "mid-phase moved flag survives restore");
  ok(r.units.every((x, i) => x.q === g.units[i].q && x.r === g.units[i].r &&
                             x.alive === g.units[i].alive),
     "every unit restored in place");
}

/* --- undo still works after restore ------------------------------------ */
{
  const g = new Game(RIDGE_ASSAULT);
  const u = g.units.find((x) => x.faction === "fr" && x.type === "inf");
  const from = { q: u.q, r: u.r };
  const dest = [...g.reachable(u).values()][0];
  g.moveUnit(u, dest.q, dest.r);

  const r = Game.restore(RIDGE_ASSAULT, roundtrip(g));
  ok(r.canUndo(), "canUndo true after restore");
  const undone = r.undoMove();
  ok(undone === r.units[u.id], "undo returns the RESTORED unit (reference remap)");
  ok(undone.q === from.q && undone.r === from.r && !undone.moved,
     "undo puts the restored unit back");
  ok(r.moveUnit(r.units[u.id], dest.q, dest.r).ok, "unit can move again after undo");
}

/* --- round-trip mid-Combat --------------------------------------------- */
{
  const g = new Game(RIDGE_ASSAULT);
  g.rng = () => 0.99; // die = 6, defender-loss on strong odds
  g.endPhase();
  ok(g.phase === "combat", "setup: in combat phase");
  const def = g.enemiesOf("fr")[0];
  const atk = [g.units.find((x) => x.faction === "fr")];
  const res = g.resolveCombat(def, atk);
  ok(res.ok, "setup: combat resolved");

  const r = Game.restore(RIDGE_ASSAULT, roundtrip(g));
  ok(r.phase === "combat", "combat phase survives");
  ok(r.units[atk[0].id].acted === (g.units[atk[0].id].acted),
     "acted flag survives");
  ok(r.units[def.id].alive === g.units[def.id].alive,
     "casualty state survives");
  // the restored game keeps playing
  r.rng = () => 0.99;
  const d2 = r.enemiesOf("fr").find((e) => r.attackersFor(e).length > 0);
  if (d2) ok(r.resolveCombat(d2).ok, "restored game resolves further combat");
  else ok(r.endPhase() === undefined, "restored game advances phase");
}

/* --- serialize leaks no live references --------------------------------- */
{
  const g = new Game(RIDGE_ASSAULT);
  const u = g.units[0];
  const dest = [...g.reachable(u).values()][0];
  g.moveUnit(u, dest.q, dest.r);
  const s = g.serialize();
  ok(s.moveLog[0].unit === undefined && Number.isInteger(s.moveLog[0].unitId),
     "moveLog serialized by id, not reference");
  const r = Game.restore(RIDGE_ASSAULT, JSON.parse(JSON.stringify(s)));
  r.units[0].q = -999;
  ok(s.units[0].q !== -999, "mutating a restored game does not touch the save");
}

/* --- rejection suite ----------------------------------------------------- */
{
  const g = new Game(RIDGE_ASSAULT);
  const good = () => roundtrip(g);

  throws(() => Game.restore(RIDGE_ASSAULT, null), "rejects null");
  throws(() => Game.restore(RIDGE_ASSAULT, "junk"), "rejects a non-object");

  let d = good(); d.turn = 0;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects turn below 1");
  d = good(); d.turn = RIDGE_ASSAULT.maxTurns + 1;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects turn past maxTurns");
  d = good(); d.sideIndex = 2;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects out-of-range sideIndex");
  d = good(); d.phaseIndex = -1;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects out-of-range phaseIndex");

  d = good(); d.units.pop();
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects wrong unit count");
  d = good(); d.units[0].faction = "al";
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects a unit with swapped faction");
  d = good(); d.units[0].type = "cav";
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects a unit with swapped type");
  d = good(); d.units[1].id = d.units[0].id;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects duplicate unit ids");
  d = good(); d.units[0].q = 500; d.units[0].r = 500;
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects an alive unit off the board");
  d = good(); d.moveLog = [{ unitId: 999, fromQ: 0, fromR: 0 }];
  throws(() => Game.restore(RIDGE_ASSAULT, d), "rejects a moveLog entry for an unknown unit");

  // a dead unit may sit anywhere — its position is never used
  d = good(); d.units[0].alive = false; d.units[0].q = 500;
  let r = null;
  try { r = Game.restore(RIDGE_ASSAULT, d); } catch (e) { /* fail below */ }
  ok(r !== null && r.units[0].alive === false, "a dead unit off-board is fine");
}

/* --- cross-scenario guard ------------------------------------------------ */
{
  const g = new Game(RIDGE_ASSAULT);
  throws(() => Game.restore(SAMBRE_CROSSING, roundtrip(g)),
         "a Ridge Assault save cannot restore into Sambre Crossing");
  const g2 = new Game(SAMBRE_CROSSING);
  const r2 = Game.restore(SAMBRE_CROSSING, roundtrip(g2));
  ok(r2.board.size === 24 * 18, "a Sambre save restores into Sambre");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
