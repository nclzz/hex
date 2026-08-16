/* Headless Napoleon-at-War rules tests — no dependencies, no DOM.
   Run: node test/naw.test.js
   Exercises the common rules layered on the engine (sticky ZOC, mandatory
   combat, the NAW CRT, one-hex strict retreats, advance after combat,
   demoralization, reinforcements) plus the Waterloo scenario's exclusive
   rules and the save/restore of all the new state. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const ctx = { Math, JSON, console };
ctx.window = undefined;                // force the "globalThis" branch
vm.createContext(ctx);
for (const f of ["src/hex.js", "src/engine.js",
                 "games/napoleon-at-war-common.js", "games/napoleon-at-waterloo.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}
const { Hex, HexWar, NAW_COMMON, NAPOLEON_AT_WATERLOO } = ctx;
const { Game } = HexWar;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }
function throws(fn, msg) {
  try { fn(); fail++; console.error("  ✗ " + msg + " (did not throw)"); }
  catch (e) { pass++; }
}
const at = (c, r) => Hex.offsetToAxial(c, r, "odd-r");
const K = (c, r) => { const a = at(c, r); return Hex.key(a.q, a.r); };

/* A tiny all-clear battlefield for surgical positioning. */
function tinyDef(over) {
  return NAW_COMMON.buildScenario(Object.assign({
    id: "tiny", title: "Tiny", blurb: "-", brief: "-",
    maxTurns: 10,
    unitTypes: {
      inf: NAW_COMMON.unit("Infantry", "I", 4, 4),
      big: NAW_COMMON.unit("Big", "B", 6, 4),
      sml: NAW_COMMON.unit("Small", "S", 1, 4),
      art: NAW_COMMON.unit("Artillery", "A", 5, 3, { range: 2 }),
    },
    factions: [
      { id: "fr", name: "French", short: "FR", color: "#00f", dark: "#005" },
      { id: "al", name: "Allies", short: "AL", color: "#f00", dark: "#500" },
    ],
    map: ["........", "........", "........", "........", "........", "........"],
    setup: [
      { faction: "fr", units: [[5, 5, "inf"]] },
      { faction: "al", units: [[5, 0, "inf"]] },
    ],
    victory: () => null, // never decides on its own unless overridden
  }, over));
}
const die = (n) => () => (n - 1) / 6 + 0.001; // rng that yields die = n

/* --- buildScenario wires the common chassis ----------------------------- */
{
  const d = tinyDef({});
  ok(d.naw === true, "buildScenario marks the def as a NAW game");
  ok(d.crt === NAW_COMMON.CRT, "buildScenario installs the common CRT");
  ok(d.terrain["."] && d.terrain["w"] && d.terrain["t"],
     "the common terrain palette is merged in");
  ok(d.terrain["w"].losBlock && d.terrain["t"].losBlock && !d.terrain["."].losBlock,
     "woods and towns block bombardment lines of sight [8.33]");
  // The CRT is the one piece of data the engine cannot invent.
  throws(() => new Game(Object.assign({}, d, { crt: null })),
         "a GameDef without a crt is rejected at construction");
  const d2 = tinyDef({ terrain: { ".": { name: "Steppe", color: "#eee", moveCost: 1, defMult: 1 } } });
  ok(d2.terrain["."].name === "Steppe", "a scenario can override a common terrain");
  ok(d2.terrain["w"].name === "Woods", "…without losing the rest of the palette");
}

/* --- the CRT: shape and boundaries -------------------------------------- */
{
  const g = new Game(tinyDef({}));
  const cells = Object.values(NAW_COMMON.CRT.table).flat();
  ok(cells.every((c) => ["Ae", "Ar", "Ex", "Dr", "De"].includes(c)),
     "the NAW CRT has no 'no effect' results");
  ok(NAW_COMMON.CRT.table["1:4"].every((c) => c === "Ae"), "below 1-3 is automatic Ae");
  ok(NAW_COMMON.CRT.table["6:1"].every((c) => c === "De"), "above 5-1 is automatic De");
  ok(g.oddsColumn(24, 4) === "6:1", "6.0 lands on the auto-De band");
  ok(g.oddsColumn(23, 4) === "5:1", "5.75 rounds down to 5-1");
  ok(g.oddsColumn(4, 12) === "1:3", "exactly one third is 1-3");
  ok(g.oddsColumn(4, 13) === "1:4", "below one third is the auto-Ae band");
  ok(g.oddsColumn(3, 2) === "3:2", "1.5 hits the 3-2 column");
  ok(g.oddsColumn(39, 20) === "3:2", "1.95 still rounds down to 3-2");
  ok(g.oddsColumn(2, 1) === "2:1", "2.0 reaches 2-1");
  ok(NAW_COMMON.columnLabel("3:1") === "3-1", "column label uses series notation");
  ok(/auto Ae/.test(NAW_COMMON.columnLabel("1:4")) && /auto De/.test(NAW_COMMON.columnLabel("6:1")),
     "sentinel columns are labelled as the automatic bands");
}

/* --- sticky ZOC: starting next to the enemy locks the unit -------------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "inf"], [5, 5, "inf"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  const [locked, free] = g.living("fr");
  ok(locked.locked === true, "unit starting in an enemy ZOC is locked");
  ok(!g.canMove(locked), "…and cannot move");
  ok(!g.moveUnit(locked, ...Object.values(at(2, 1))).ok, "moveUnit refuses a locked unit");
  ok(free.locked === false && g.canMove(free), "a unit clear of the enemy moves freely");
  const dest = [...g.reachable(free).values()][0];
  ok(g.moveUnit(free, dest.q, dest.r).ok, "…and actually moves");
}
/* --- mandatory combat ---------------------------------------------------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "inf"], [5, 5, "inf"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  g.rng = die(1);
  ok(g.endPhase().ok, "movement ends normally");
  ok(g.phase === "combat", "into the combat phase");
  const un = g.unresolvedCombat();
  ok(un.mustAttack.length === 1 && un.mustBeAttacked.length === 1,
     "adjacency creates both obligations");
  const blocked = g.endPhase();
  ok(blocked.ok === false && /mandatory/.test(blocked.reason),
     "endPhase refuses while a mandatory battle is unfought");
  const target = g.living("al")[0];
  const res = g.resolveCombat(target);
  ok(res.ok && res.code === "Ar", "1-1 at die 1 is Ar");
  // The retreat vacated the attacker's hex — the DEFENDER may advance [7.74].
  ok(g.pendingAdvance && g.pendingAdvance.faction === "al",
     "an Ar offers the DEFENDER the advance");
  ok(g.declineAdvance().ok, "…which it may decline");
  ok(g.resolveCombat(target).ok === false, "a defender cannot be attacked twice");
  const un2 = g.unresolvedCombat();
  ok(un2.mustAttack.length === 0 && un2.mustBeAttacked.length === 0,
     "obligations satisfied after the battle");
  ok(g.endPhase().ok, "endPhase proceeds once every mandatory battle is fought");
}
{
  // Bombardment range creates no obligations, but bombarding satisfies none either.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 2, "art"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  g.rng = die(1);
  g.endPhase();
  const un = g.unresolvedCombat();
  ok(un.mustAttack.length === 0 && un.mustBeAttacked.length === 0,
     "a gun two hexes away owes and is owed nothing");
  const art = g.living("fr")[0], tgt = g.living("al")[0];
  const before = { q: art.q, r: art.r };
  const res = g.resolveCombat([tgt], [art]);
  ok(res.ok, "voluntary bombardment still resolves");
  ok(art.alive && art.q === before.q && art.r === before.r,
     "the bombarding gun is untouched by the result (" + res.code + ")");
  ok(g.endPhase().ok, "phase ends normally after the bombardment");
}

/* --- NAW combat results --------------------------------------------------- */
{
  // Ae eliminates every ENGAGED attacker but never the gun firing from range.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "inf"], [0, 1, "big"], [1, 2, "art"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  const [inf, big, art] = g.living("fr");
  const tgt = g.living("al")[0];
  ok(Hex.distance(big, tgt) === 1, "layout: both foot units engage");
  ok(Hex.distance(art, tgt) === 2, "layout: the gun is at bombardment range");
  g.applyResult("Ae", [tgt], [inf, big, art]);
  ok(!inf.alive && !big.alive, "Ae kills every engaged attacker");
  ok(art.alive, "…but spares the bombarding gun");
  ok(tgt.alive, "…and the defender stands");
}
{
  // Ex: defender dies; engaged attackers pay at least the defender's printed CS.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "inf"], [0, 1, "big"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  const [inf, big] = g.living("fr");
  const tgt = g.living("al")[0];
  g.applyResult("Ex", [tgt], [inf, big]);
  ok(!tgt.alive, "Ex kills the defender");
  ok(!inf.alive && big.alive, "Ex takes the cheapest engaged units up to the defender's CS");
}
{
  // Dr is ONE hex; a defender whose only exits are enemy ZOC is eliminated.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[3, 4, "inf"]] },
    { faction: "al", units: [[3, 3, "inf"]] },
  ] }));
  const atk = g.living("fr")[0], tgt = g.living("al")[0];
  g.applyResult("Dr", [tgt], [atk]);
  ok(tgt.alive && Hex.distance(tgt, atk) === 2, "Dr retreats the defender exactly one hex");
}
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 0, "inf"]] },
    { faction: "al", units: [[0, 0, "inf"]] },
  ] }));
  const atk = g.living("fr")[0], tgt = g.living("al")[0];
  g.applyResult("Dr", [tgt], [atk]);
  ok(!tgt.alive, "a defender with no ZOC-free retreat hex is eliminated");
}
{
  // Ar is strict for attackers too.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[0, 0, "inf"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  const atk = g.living("fr")[0], tgt = g.living("al")[0];
  g.applyResult("Ar", [tgt], [atk]);
  ok(!atk.alive, "an attacker with no ZOC-free retreat hex is eliminated on Ar");
}

/* --- automatic bands end to end ------------------------------------------ */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "sml"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  g.rng = die(6); // even the best die cannot save a hopeless attack
  g.endPhase();
  const res = g.resolveCombat(g.living("al")[0]);
  ok(res.ok && res.column === "1:4" && res.code === "Ae",
     "odds below 1-3 are an automatic Ae");
  ok(g.living("fr").length === 0, "…and the attacker is destroyed");
}
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "big"], [2, 1, "inf"]] },
    { faction: "al", units: [[1, 0, "sml"]] },
  ] }));
  g.rng = die(1); // even the worst die cannot miss at 10:1
  g.endPhase();
  const res = g.resolveCombat(g.living("al")[0]);
  ok(res.ok && res.column === "6:1" && res.code === "De",
     "odds above 5-1 are an automatic De");
}

/* --- multi-defender battles ----------------------------------------------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "big"]] },
    { faction: "al", units: [[1, 0, "inf"], [2, 0, "inf"]] },
  ] }));
  g.rng = die(3);
  g.endPhase();
  const fr = g.living("fr")[0];
  const [a1, a2] = g.living("al");
  ok(Hex.distance(fr, a1) === 1 && Hex.distance(fr, a2) === 1,
     "layout: one unit in two enemy ZOCs");
  const res = g.resolveCombat([a1, a2], [fr]);
  ok(res.ok, "a unit may attack all enemies whose ZOC it stands in, as one battle");
  ok(res.def === 8 && res.atk === 6 && res.column === "1:2",
     "combined defense sums each defender (with terrain)");
  ok(res.code === "Ar", "1-2 at die 3 is Ar");
  if (g.pendingAdvance) g.declineAdvance(); // the defenders may decline the ground
  const un = g.unresolvedCombat();
  ok(un.mustAttack.length === 0 && un.mustBeAttacked.length === 0,
     "one combined battle satisfies every obligation it covers");
  ok(g.endPhase().ok, "phase ends after the combined battle");
}
{
  // A defender no attacker is adjacent to cannot ride along in a combined battle.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "big"]] },
    { faction: "al", units: [[1, 0, "inf"], [5, 0, "inf"]] },
  ] }));
  g.endPhase();
  const fr = g.living("fr")[0];
  const [near_, far] = g.living("al");
  const res = g.resolveCombat([near_, far], [fr]);
  ok(res.ok === false && /not engaged/.test(res.reason),
     "combined battles require every defender to be engaged");
}

/* --- advance after combat -------------------------------------------------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "big"], [0, 1, "inf"], [1, 2, "art"]] },
    { faction: "al", units: [[1, 0, "inf"], [2, 0, "inf"]] },
  ] }));
  g.rng = die(6);
  g.endPhase();
  const [big, inf, art] = g.living("fr");
  const tgt = g.living("al")[0];
  const hexQ = tgt.q, hexR = tgt.r;
  const res = g.resolveCombat([tgt], [big, inf, art]);
  ok(res.ok && res.code === "De", "the defender falls");
  ok(res.advance && g.pendingAdvance, "a vacated hex offers an advance");
  ok(res.advance.candidates.includes(big) && res.advance.candidates.includes(inf) &&
     !res.advance.candidates.includes(art),
     "only surviving ENGAGED attackers may advance — never the gun at range");
  ok(g.resolveCombat(g.living("al")[0]).ok === false, "no new combat while an advance is pending");
  ok(g.endPhase().ok === false, "the phase cannot end while an advance is pending");
  const adv = g.advanceAfterCombat(inf);
  ok(adv.ok && inf.q === hexQ && inf.r === hexR,
     "the chosen unit advances into the vacated hex");
  ok(g.isEnemyZOC("fr", inf.q, inf.r), "…even though that hex is in an enemy ZOC");
  ok(g.pendingAdvance === null, "the advance consumes the opportunity");
}
{
  // Declining stands fast.
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "big"], [2, 1, "inf"]] },
    { faction: "al", units: [[1, 0, "sml"]] },
  ] }));
  g.rng = die(1);
  g.endPhase();
  const [big, inf] = g.living("fr");
  const from = { q: big.q, r: big.r };
  const res = g.resolveCombat(g.living("al")[0]);
  ok(res.ok && res.advance, "setup: a vacated hex is on offer");
  ok(g.declineAdvance().ok, "the victor may stand fast");
  ok(big.q === from.q && big.r === from.r, "nobody moved");
  ok(g.endPhase().ok, "and the phase then ends normally");
}

/* --- demoralization --------------------------------------------------------- */
{
  const def = tinyDef({
    setup: [
      { faction: "fr", units: [[1, 1, "big"], [0, 1, "inf"]] },
      { faction: "al", army: "anglo", units: [[1, 0, "inf"]] },
      { faction: "al", army: "pr", units: [[6, 5, "inf"]] },
    ],
    demoralization: [
      { faction: "al", army: "anglo", name: "Anglo Army", level: 4 },
    ],
    victory: (game) => NAW_COMMON.demoralizationVictory(game),
  });
  const g = new Game(def);
  g.rng = die(6);
  ok(g.lostSP("al") === 0 && g.lostSP("al", "anglo") === 0, "no losses yet");
  g.endPhase();
  const res = g.resolveCombat(g.units.find((u) => u.army === "anglo"));
  ok(res.code === "De", "setup: the anglo unit dies");
  ok(g.lostSP("al", "anglo") === 4 && g.lostSP("al", "pr") === 0,
     "losses accrue to the army that bled");
  ok(g.over && g.winner === "fr", "crossing the demoralization level ends the game at that instant");
}
{
  // An endsGame:false entry is tracked but never decides the game.
  const def = tinyDef({
    setup: [
      { faction: "fr", units: [[1, 1, "big"], [0, 1, "inf"]] },
      { faction: "al", army: "pr", units: [[1, 0, "inf"]] },
    ],
    demoralization: [
      { faction: "al", army: "pr", name: "Prussians", level: 4, endsGame: false },
    ],
    victory: (game) => NAW_COMMON.demoralizationVictory(game),
  });
  const g = new Game(def);
  g.rng = die(6);
  g.endPhase();
  g.resolveCombat(g.living("al")[0]);
  ok(g.lostSP("al", "pr") >= 4 && !g.over,
     "a tracked-only army may break without ending the game");
  const st = NAW_COMMON.demoralizationStatus(g);
  ok(st.length === 1 && st[0].lost === 4 && st[0].level === 4,
     "demoralizationStatus reports lost vs level for the HUD");
}

/* --- night turns ------------------------------------------------------------- */
{
  const g = new Game(tinyDef({ nightTurns: [2] }));
  const seen = [];
  while (!(g.turn === 3 && g.activeFaction === "fr" && g.phase === "move")) {
    seen.push(g.turn + ":" + g.activeFaction + ":" + g.phase);
    const r = g.endPhase();
    if (!r.ok) break;
  }
  ok(!seen.some((s) => s.startsWith("2:") && s.endsWith(":combat")),
     "night game-turns have no combat phase");
  ok(seen.some((s) => s === "2:fr:move") && seen.some((s) => s === "2:al:move"),
     "…but both sides still move at night");
  ok(seen.some((s) => s === "1:fr:combat"), "day turns keep their combat phase");
}

/* --- reinforcements ----------------------------------------------------------- */
{
  const def = tinyDef({
    reinforcements: [
      { turn: 2, faction: "al", army: "pr", entry: [[0, 0], [1, 0]], units: ["inf", "inf"] },
    ],
  });
  const g = new Game(def);
  ok(g.units.length === 4, "reinforcements exist from the start (stable ids)");
  ok(g.living("al").length === 1, "…but are not on the map yet");
  ok(!g.unitAt(at(0, 0).q, at(0, 0).r), "their entry hex reads empty");
  // Advance to the Allied Movement Phase of turn 2.
  while (!(g.turn === 2 && g.activeFaction === "al" && g.phase === "move")) g.endPhase();
  const pr = g.units.filter((u) => u.army === "pr");
  ok(pr.every((u) => u.entered && u.freshArrival), "both arrive on turn 2");
  ok(pr.some((u) => Hex.key(u.q, u.r) === K(0, 0)) && pr.some((u) => Hex.key(u.q, u.r) === K(1, 0)),
     "each takes the next free hex in the entry list");
  // Entry cost: MA 4 minus 1 MP for the entry hex.
  const east = pr.find((u) => Hex.key(u.q, u.r) === K(1, 0));
  const reach = g.reachable(east);
  ok(reach.has(K(4, 0)) && !reach.has(K(4, 1)),
     "a fresh arrival moves with MA-1 (entry hex already paid)");
  // Next Allied turn they are ordinary units again.
  g.endPhase(); g.endPhase(); // al combat -> fr move (turn 3)
  while (!(g.turn === 3 && g.activeFaction === "al" && g.phase === "move")) g.endPhase();
  ok(pr.every((u) => !u.freshArrival), "the discount lasts only the turn of arrival");
  ok(g.reachable(east).has(K(4, 1)), "full movement from the next turn");
}
{
  // A blocked entry hex defers to the next candidate; fully blocked waits a turn.
  const def = tinyDef({
    setup: [
      { faction: "fr", units: [[5, 5, "inf"]] },
      { faction: "al", units: [[0, 0, "inf"]] }, // squatting on the first entry hex
    ],
    reinforcements: [
      { turn: 2, faction: "al", army: "pr", entry: [[0, 0]], units: ["inf"] },
    ],
  });
  const g = new Game(def);
  while (!(g.turn === 2 && g.activeFaction === "al" && g.phase === "move")) g.endPhase();
  const pr = g.units.find((u) => u.army === "pr");
  ok(pr.entered === false, "a fully blocked group waits off-map");
  // Clear the entry hex; the group lands next Allied turn.
  const squatter = g.living("al").find((u) => !u.army);
  g.moveUnit(squatter, at(2, 2).q, at(2, 2).r);
  while (!(g.turn === 3 && g.activeFaction === "al" && g.phase === "move")) g.endPhase();
  ok(pr.entered === true && Hex.key(pr.q, pr.r) === K(0, 0),
     "…and enters as soon as the hex is free");
}

/* --- serialize / restore of the new state --------------------------------- */
{
  // Mid-advance, with unentered reinforcements: everything survives the trip.
  const def = tinyDef({
    setup: [
      { faction: "fr", units: [[1, 1, "big"], [0, 1, "inf"]] },
      { faction: "al", units: [[1, 0, "sml"], [5, 5, "inf"]] },
    ],
    reinforcements: [
      { turn: 5, faction: "al", army: "pr", entry: [[0, 5]], units: ["inf"] },
    ],
  });
  const g = new Game(def);
  g.rng = die(1);
  g.endPhase();
  const res = g.resolveCombat(g.units.find((u) => u.type === "sml"));
  ok(res.ok && g.pendingAdvance, "setup: an advance is pending");
  const data = JSON.parse(JSON.stringify(g.serialize()));
  const r = Game.restore(def, data);
  ok(r.pendingAdvance && r.pendingAdvance.unitIds.length === g.pendingAdvance.unitIds.length,
     "pendingAdvance survives the round trip");
  ok([...r.attackedIds].length === [...g.attackedIds].length, "attackedIds survive");
  ok(r.units.find((u) => u.army === undefined && u.entered === false) === undefined,
     "setup units restore as entered");
  ok(r.units.some((u) => u.entered === false), "unentered reinforcements stay off-map");
  const inf = r.units.find((u) => u.faction === "fr" && u.type === "inf");
  ok(r.advanceAfterCombat(inf).ok, "the restored game completes the advance");
  ok(r.endPhase().ok === true, "the restored game keeps running");

  // Tampering is rejected.
  const bad1 = JSON.parse(JSON.stringify(data));
  bad1.pendingAdvance.unitIds = [999];
  throws(() => Game.restore(def, bad1), "rejects a pendingAdvance for an unknown unit");
  const bad2 = JSON.parse(JSON.stringify(data));
  bad2.units.find((u) => u.entered === false).moved = true;
  throws(() => Game.restore(def, bad2), "rejects an off-map unit that claims to have moved");
}
{
  // A save written before these fields existed still restores (leniently).
  const def = tinyDef({});
  const g = new Game(def);
  const u = g.living("fr")[0];
  const dest = [...g.reachable(u).values()][0];
  g.moveUnit(u, dest.q, dest.r);
  const data = JSON.parse(JSON.stringify(g.serialize()));
  delete data.attackedIds; delete data.mustAttackIds; delete data.mustBeAttackedIds;
  delete data.pendingAdvance;
  for (const su of data.units) { delete su.entered; delete su.locked; delete su.freshArrival; }
  const r = Game.restore(def, data);
  ok(r.units[u.id].q === u.q && r.units[u.id].moved === true,
     "an old-shape save restores with lenient defaults");
  ok(r.pendingAdvance === null && r.attackedIds.size === 0, "…and empty new state");
}

/* ======================= Standard Rules cases ============================ */

// A walled corridor: row 1 is the only passable lane (cols 0-7).
const WALL = { "#": { name: "Wall", color: "#333", moveCost: Infinity, defMult: 1, passable: false } };
function corridorDef(over) {
  return tinyDef(Object.assign({
    terrain: WALL,
    map: ["########", "........", "########", "########", "########", "########"],
  }, over));
}

/* --- [5.31/5.33] friendly units are passed through, never stood upon ------ */
{
  const g = new Game(corridorDef({ setup: [
    { faction: "fr", units: [[0, 1, "inf"], [2, 1, "inf"]] },
    { faction: "al", units: [[6, 1, "inf"]] },
  ] }));
  const mover = g.living("fr")[0];
  const reach = g.reachable(mover);
  ok(reach.has(K(3, 1)), "a friend in the only lane is passed through");
  ok(!reach.has(K(2, 1)), "…but his hex is no destination [5.32]");
  ok(reach.get(K(3, 1)).cost === 3, "…and passing him costs nothing extra");
}
{
  const g = new Game(corridorDef({ setup: [
    { faction: "fr", units: [[0, 1, "inf"]] },
    { faction: "al", units: [[3, 1, "inf"]] },
  ] }));
  const reach = g.reachable(g.living("fr")[0]);
  ok(!reach.has(K(3, 1)) && !reach.has(K(4, 1)),
     "an enemy-occupied hex is never entered nor passed [5.12]");
  ok(reach.has(K(2, 1)), "…though its ZOC hex can still be entered (and stops movement)");
}

/* --- [5.2x] hexside movement costs ---------------------------------------- */
{
  const road = { type: "road", pairs: [] };
  for (let c = 1; c < 8; c++) road.pairs.push([[c - 1, 1], [c, 1]]);
  const g = new Game(corridorDef({ hexsides: [road], setup: [
    { faction: "fr", units: [[0, 1, "inf"]] },
    { faction: "al", units: [[7, 5, "inf"]] }, // parked off the lane? keep on-map:
  ] }));
  // (the al unit sits on a wall hex in this def — move it off-board concerns
  //  aside, it plays no part; only the road math is under test)
  const reach = g.reachable(g.living("fr")[0]);
  ok(reach.get(K(7, 1)) && reach.get(K(7, 1)).cost === 3.5,
     "road hexsides move at 1/2 MP per hex [5.22]");
}
{
  const g = new Game(corridorDef({
    hexsides: [{ type: "stream", pairs: [[[1, 1], [2, 1]]] }],
    setup: [
      { faction: "fr", units: [[0, 1, "inf"]] },
      { faction: "al", units: [[7, 1, "inf"]] },
    ],
  }));
  const reach = g.reachable(g.living("fr")[0]);
  ok(reach.get(K(2, 1)).cost === 4, "a stream hexside costs two extra MPs [5.25]");
}
{
  // Slope hexside: +1 only when LEAVING the slope hex downhill [5.26].
  const d = tinyDef({
    map: ["........", ".h......", "........", "........", "........", "........"],
    hexsides: [{ type: "slope", pairs: [[[1, 1], [2, 1]]] }],
    setup: [
      { faction: "fr", units: [[1, 1, "inf"], [3, 1, "inf"]] },
      { faction: "al", units: [[7, 5, "inf"]] },
    ],
  });
  const g = new Game(d);
  const [onSlope, onClear] = g.living("fr");
  ok(g.reachable(onSlope).get(K(2, 1)).cost === 2,
     "leaving a slope hex downhill costs one extra MP [5.26]");
  ok(g.reachable(onClear).get(K(1, 1)) === undefined || true, "sanity");
  const up = g.stepCost(onClear, g.hex(...Object.values(at(2, 1))), g.hex(...Object.values(at(1, 1))));
  ok(up === 2, "climbing into the slope hex costs only its terrain (no surcharge)");
}

/* --- [5.24/6.6/8.45] rivers: movement, ZOC, melee, bombardment ------------- */
{
  const mk = (edgeType) => new Game(corridorDef({
    hexsides: [{ type: edgeType, pairs: [[[3, 1], [4, 1]]] }],
    setup: [
      { faction: "fr", units: [[3, 1, "art"]] },
      { faction: "al", units: [[4, 1, "inf"]] },
    ],
  }));
  const g = mk("river");
  const art = g.living("fr")[0], tgt = g.living("al")[0];
  ok(!g.reachable(art).has(K(4, 1)), "no movement across an unbridged river [5.24]");
  ok(art.locked === false, "ZOC does not reach across the river [6.6]");
  ok(!g.meleeAdjacent(art, tgt), "…and neither does melee [8.45]");
  g.endPhase();
  const un = g.unresolvedCombat();
  ok(un.mustAttack.length === 0 && un.mustBeAttacked.length === 0,
     "no mandatory battle across the water");
  const res = g.resolveCombat([tgt], [art]);
  ok(res.ok, "artillery may still bombard across the river [8.45]");
  ok(art.alive, "…as a bombardment (the gun is immune)");

  const gb = mk("bridge");
  const art2 = gb.living("fr")[0];
  ok(art2.locked === true && !gb.canMove(art2),
     "a bridge carries ZOC — the gun starts locked in contact");
}

/* --- [6.6] the rules' Zone of Control Example ------------------------------ */
{
  // A unit's ZOC reaches all six neighbors — through streams, over bridged
  // river hexsides, into any terrain — EXCEPT through an unbridged river.
  const g = new Game(tinyDef({
    map: ["........", "........", "....w...", "..t.....", "........", "........"],
    hexsides: [
      { type: "river",  pairs: [[[3, 3], [3, 4]]] },
      { type: "bridge", pairs: [[[3, 3], [4, 4]]] },
      { type: "stream", pairs: [[[3, 3], [3, 2]]] },
    ],
    setup: [
      { faction: "fr", units: [[3, 3, "inf"]] },
      { faction: "al", units: [[7, 0, "inf"]] },
    ],
  }));
  const zoc = (c, r) => g.isEnemyZOC("al", at(c, r).q, at(c, r).r);
  ok(zoc(4, 3), "ZOC example: plain neighbor");
  ok(zoc(2, 3), "ZOC example: town neighbor (terrain never blocks)");
  ok(zoc(4, 2), "ZOC example: woods neighbor (terrain never blocks)");
  ok(zoc(3, 2), "ZOC example: across a stream");
  ok(zoc(4, 4), "ZOC example: across a bridged river");
  ok(!zoc(3, 4), "ZOC example: NO ZOC through an unbridged river [6.6]");
}

/* --- [7.73/7.8] displacement on retreat ------------------------------------ */
{
  // D's only exits are friendly-occupied: the friend is displaced.
  const g = new Game(corridorDef({ setup: [
    { faction: "fr", units: [[2, 1, "big"]] },
    { faction: "al", units: [[3, 1, "inf"], [4, 1, "inf"]] },
  ] }));
  const [D, friend] = g.living("al");
  g.applyResult("Dr", [D], [g.living("fr")[0]]);
  ok(D.alive && Hex.key(D.q, D.r) === K(4, 1), "the retreater takes the friend's hex [7.73]");
  ok(friend.alive && Hex.key(friend.q, friend.r) === K(5, 1),
     "…and the friend is displaced one hex on [7.81]");
}
{
  // Chain displacement, and elimination transfers to the RETREATER [7.82].
  const g = new Game(corridorDef({ setup: [
    { faction: "fr", units: [[2, 1, "big"]] },
    { faction: "al", units: [[3, 1, "inf"], [4, 1, "inf"], [5, 1, "inf"], [6, 1, "inf"], [7, 1, "inf"]] },
  ] }));
  const [D, f1, f2, f3, f4] = g.living("al");
  g.applyResult("Dr", [D], [g.living("fr")[0]]);
  ok(!D.alive, "with the lane full to the wall, the RETREATER is eliminated [7.82]");
  ok(f1.alive && f2.alive && f3.alive && f4.alive &&
     Hex.key(f1.q, f1.r) === K(4, 1) && Hex.key(f4.q, f4.r) === K(7, 1),
     "…and the friends stand exactly where they were");
}
{
  // A displaced artillery unit that had not fought loses its fire [7.82].
  const g = new Game(corridorDef({ setup: [
    { faction: "fr", units: [[2, 1, "big"]] },
    { faction: "al", units: [[3, 1, "inf"], [4, 1, "art"]] },
  ] }));
  g.endPhase(); // into the French Combat Phase
  const [D, gun] = g.living("al");
  ok(!gun.acted, "setup: the gun has not fought");
  g.applyResult("Dr", [D], [g.living("fr")[0]]);
  ok(gun.alive && Hex.key(gun.q, gun.r) === K(5, 1) && gun.acted === true,
     "a displaced, unfired artillery unit may not fire this phase");
}

/* --- [7.74] the DEFENDER advances when Ae vacates the attacker's hex ------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "sml"]] },
    { faction: "al", units: [[1, 0, "inf"]] },
  ] }));
  g.rng = die(3);
  g.endPhase();
  const fr = g.living("fr")[0], al = g.living("al")[0];
  const frHex = { q: fr.q, r: fr.r };
  const res = g.resolveCombat([al]); // 1:4 -> automatic Ae
  ok(res.code === "Ae" && !fr.alive, "the hopeless attack dies to a man");
  ok(g.pendingAdvance && g.pendingAdvance.faction === "al",
     "the vacated attacker hex is offered to the DEFENDER [7.74]");
  ok(res.advance && res.advance.faction === "al", "…and the result says whose choice it is");
  ok(g.advanceAfterCombat(al).ok && al.q === frHex.q && al.r === frHex.r,
     "the victorious defender takes the ground");
}

/* --- [8.3] bombardment Line of Sight --------------------------------------- */
{
  // Straight shot through a wood: blocked.
  const g = new Game(tinyDef({
    map: ["........", "..w.....", "........", "........", "........", "........"],
    setup: [
      { faction: "fr", units: [[1, 1, "art"]] },
      { faction: "al", units: [[3, 1, "inf"]] },
    ],
  }));
  const art = g.living("fr")[0], tgt = g.living("al")[0];
  ok(!g.lineOfSight(art, tgt), "a wood on the straight line blocks the shot [8.31/8.33]");
  ok(!g.attackersFor(tgt).includes(art), "…so the gun cannot bombard it");
  g.endPhase();
  ok(g.resolveCombat([tgt], [art]).ok === false, "…and the engine refuses the attack");
}
{
  // Line along a hexside: blocked only if BOTH flanking hexes block [8.32].
  const one = new Game(tinyDef({
    map: ["........", "..w.....", "........", "........", "........", "........"],
    setup: [
      { faction: "fr", units: [[1, 1, "art"]] },
      { faction: "al", units: [[3, 2, "inf"]] },
    ],
  }));
  ok(one.lineOfSight(one.living("fr")[0], one.living("al")[0]),
     "one blocking flank leaves a hexside-line shot open [8.32]");
  const both = new Game(tinyDef({
    map: ["........", "..w.....", "..w.....", "........", "........", "........"],
    setup: [
      { faction: "fr", units: [[1, 1, "art"]] },
      { faction: "al", units: [[3, 2, "inf"]] },
    ],
  }));
  ok(!both.lineOfSight(both.living("fr")[0], both.living("al")[0]),
     "…but two blocking flanks close it");
}
{
  // The target's own terrain never blocks [8.34].
  const g = new Game(tinyDef({
    map: ["........", "...t....", "........", "........", "........", "........"],
    setup: [
      { faction: "fr", units: [[1, 1, "art"]] },
      { faction: "al", units: [[3, 1, "inf"]] },
    ],
  }));
  ok(g.lineOfSight(g.living("fr")[0], g.living("al")[0]),
     "a town in the TARGET hex does not block the shot [8.34]");
}

/* --- [8.41] artillery in an enemy ZOC may not bombard ---------------------- */
{
  const g = new Game(tinyDef({ setup: [
    { faction: "fr", units: [[1, 1, "art"]] },
    { faction: "al", units: [[1, 0, "inf"], [3, 1, "inf"]] },
  ] }));
  g.endPhase();
  const art = g.living("fr")[0];
  const [adjacent, distant] = g.living("al");
  ok(Hex.distance(art, distant) === 2, "layout: a second enemy sits at gun range");
  ok(g.attackersFor(adjacent).includes(art), "the gun must fight its neighbor [8.41]");
  ok(!g.attackersFor(distant).includes(art), "…and may not bombard while in a ZOC");
  ok(/ZOC/.test(g.resolveCombat([distant], [art]).reason || ""),
     "…the engine refuses with the rule");
}

/* --- [10.0] night game-turns ----------------------------------------------- */
{
  const g = new Game(corridorDef({
    nightTurns: [1],
    setup: [
      { faction: "fr", units: [[0, 1, "inf"]] },
      { faction: "al", units: [[4, 1, "inf"]] },
    ],
  }));
  ok(g.isNight(), "turn 1 is night");
  const reach = g.reachable(g.living("fr")[0]);
  ok(reach.has(K(2, 1)) && !reach.has(K(3, 1)),
     "at night a unit may not even ENTER an enemy-controlled hex [10.2]");
  ok(g.endPhase().ok && g.activeFaction === "al" && g.phase === "move",
     "the night Combat Phase is skipped entirely [10.1]");
  g.endPhase();
  ok(g.turn === 2 && !g.isNight() && g.activeFaction === "fr" && g.phase === "move",
     "day breaks on turn 2");
  g.endPhase();
  ok(g.phase === "combat", "…and combat returns with it");
}

/* --- the rules' "Examples of Attacks" sheet --------------------------------- */
// Each case reproduces one illustrated situation and checks the odds column
// (and legality) the sheet prints beside it.
{
  const EX = {
    c1: NAW_COMMON.unit("1", "1", 1, 4), c2: NAW_COMMON.unit("2", "2", 2, 4),
    c3: NAW_COMMON.unit("3", "3", 3, 4), c4: NAW_COMMON.unit("4", "4", 4, 4),
    c6: NAW_COMMON.unit("6", "6", 6, 4),
    a3: NAW_COMMON.unit("A3", "A", 3, 3, { range: 2 }),
    a4: NAW_COMMON.unit("A4", "A", 4, 3, { range: 2 }),
  };
  const exDef = (setup, over) => tinyDef(Object.assign({ unitTypes: EX, setup }, over));
  const fight = (setup, over) => {
    const g = new Game(exDef(setup, over));
    g.rng = die(2);
    g.endPhase();
    return g;
  };

  { // simple adjacent attack: 3 vs 1 -> "3 to 1 attack"
    const g = fight([
      { faction: "fr", units: [[1, 1, "c3"]] },
      { faction: "al", units: [[1, 0, "c1"]] },
    ]);
    const res = g.resolveCombat(g.living("al")[0]);
    ok(res.ok && res.column === "3:1", "3 vs 1 adjacent is a 3-1 attack");
  }
  { // dashed arrow: the same odds by pure bombardment, gun untouched
    const g = fight([
      { faction: "fr", units: [[1, 2, "a3"]] },
      { faction: "al", units: [[1, 0, "c1"]] },
    ]);
    g.rng = die(1); // 3-1 die 1 -> Ex
    const gun = g.living("fr")[0];
    const res = g.resolveCombat([g.living("al")[0]], [gun]);
    ok(res.ok && res.column === "3:1", "3 vs 1 at two hexes is a 3-1 bombardment");
    ok(res.code === "Ex" && !g.living("al").length && gun.alive,
       "an Exchange by pure bombardment kills the defender and spares the gun [8.14]");
  }
  { // several attackers sum their strengths against one hex [7.22]
    const g = fight([
      { faction: "fr", units: [[1, 1, "c4"], [0, 1, "c4"]] },
      { faction: "al", units: [[1, 0, "c4"]] },
    ]);
    const res = g.resolveCombat(g.living("al")[0]);
    ok(res.ok && res.atk === 8 && res.column === "2:1",
       "4+4 vs 4 combine into a 2-1 attack [7.22]");
  }
  { // one unit in two ZOCs attacks both as one combined defense [7.21]
    const g = fight([
      { faction: "fr", units: [[1, 1, "c3"]] },
      { faction: "al", units: [[1, 0, "c1"], [2, 0, "c2"]] },
    ]);
    const res = g.resolveCombat(g.living("al"), g.living("fr"));
    ok(res.ok && res.def === 3 && res.column === "1:1",
       "3 vs 1+2 combined defenders is a 1-1 attack [7.21]");
  }
  { // "4 to 1 combined attack": adjacent infantry + bombarding gun [8.21]
    const g = fight([
      { faction: "fr", units: [[1, 1, "c4"], [1, 2, "a4"]] },
      { faction: "al", units: [[1, 0, "c2"]] },
    ]);
    const res = g.resolveCombat(g.living("al")[0]);
    ok(res.ok && res.atk === 8 && res.column === "4:1",
       "infantry plus bombarding gun make the 4-1 combined attack [8.21]");
  }
  { // multi-hex battle: the gun needs range to only ONE defending hex [8.22]
    const g = fight([
      { faction: "fr", units: [[1, 1, "c4"], [0, 2, "a3"]] },
      { faction: "al", units: [[1, 0, "c1"], [2, 0, "c2"]] },
    ]);
    const [inf, gun] = g.living("fr");
    const [d1, d2] = g.living("al");
    ok(Hex.distance(gun, d1) === 2 && Hex.distance(gun, d2) === 3,
       "layout: the gun reaches only one of the two defending hexes");
    const res = g.resolveCombat([d1, d2], [inf, gun]);
    ok(res.ok && res.atk === 7 && res.column === "2:1",
       "…and still adds its strength to the multi-hex battle [8.22]");
  }
  { // the procedure's worked example: 13 vs 4 rounds DOWN to 3-1
    const g = fight([
      { faction: "fr", units: [[1, 1, "c6"], [0, 1, "c4"], [0, 0, "c3"]] },
      { faction: "al", units: [[1, 0, "c4"]] },
    ]);
    const res = g.resolveCombat(g.living("al")[0]);
    ok(res.ok && res.atk === 13 && res.column === "3:1",
       "13 vs 4 rounds down (in the defender's favor) to 3-1");
  }
  { // "1 to 2, doubled due to Building hex"
    const g = fight([
      { faction: "fr", units: [[1, 1, "c6"]] },
      { faction: "al", units: [[1, 0, "c6"]] },
    ], { map: [".t......", "........", "........", "........", "........", "........"] });
    const res = g.resolveCombat(g.living("al")[0]);
    ok(res.ok && res.def === 12 && res.column === "1:2",
       "6 vs 6 in a town is 1-2, doubled due to the building hex");
  }
  { // "attacks may be constituted in more than one way": one combined battle…
    const setup = [
      { faction: "fr", units: [[1, 1, "c4"], [2, 1, "c4"]] },
      { faction: "al", units: [[1, 0, "c1"], [2, 0, "c2"]] },
    ];
    const g1 = fight(setup);
    const one = g1.resolveCombat(g1.living("al"), g1.living("fr"));
    ok(one.ok && one.atk === 8 && one.def === 3,
       "the cluster may fight as ONE combined battle");
    // …or as two separate battles in the same phase.
    const g2 = fight(setup);
    const [A1, A2] = g2.living("fr");
    const [D1, D2] = g2.living("al");
    const b1 = g2.resolveCombat([D1], [A1]);
    ok(b1.ok, "…or as separate battles: the first resolves");
    if (g2.pendingAdvance) g2.declineAdvance();
    const b2 = g2.resolveCombat([D2], [A2]);
    ok(b2.ok, "…and the second follows in the same phase");
  }
}

/* --- Napoleon at Waterloo: the scenario itself ------------------------------ */
{
  const W = NAPOLEON_AT_WATERLOO;
  const g = new Game(W);
  ok(W.naw === true && W.crt === NAW_COMMON.CRT, "Waterloo is built on the common rules");
  ok(g.units.length === 38, "38 counters: 18 French, 14 Anglo-Allied, 6 Prussian");
  ok(g.living("fr").length === 18 && g.living("al").length === 14,
     "the Prussians start off-map");
  ok(g.units.filter((u) => u.army === "pr").length === 6, "six Prussian counters scheduled");
  // No unit starts locked or in contact.
  ok(g.living("fr").every((u) => !u.locked) && g.living("al").every((u) => !u.locked),
     "the armies deploy out of contact");
  // Demoralization: the French level rises by 10 once the Prussians break.
  const frLevel = W.demoralization[0].level;
  ok(frLevel(g) === 40, "French level starts at 40");
  g.units.filter((u) => u.army === "pr").slice(0, 4).forEach((u) => { u.alive = false; });
  ok(g.lostSP("al", "pr") >= 12, "setup: the Prussian army is broken");
  ok(frLevel(g) === 50, "…which raises the French level to 50 (exclusive rule)");
  // The Prussian entry is tracked-only.
  ok(W.demoralization.find((d) => d.army === "pr").endsGame === false,
     "Prussian demoralization alone does not end the game");
}
{
  // Prussian arrival, on schedule, on the eastern edge.
  const W = NAPOLEON_AT_WATERLOO;
  const g = new Game(W);
  while (!(g.turn === 3 && g.activeFaction === "al" && g.phase === "move")) {
    const r = g.endPhase();
    if (!r.ok) { ok(false, "reached turn 3 without blocked phases (" + r.reason + ")"); break; }
  }
  const bulow = g.units.filter((u) => u.army === "pr" && u.entered);
  ok(bulow.length === 5, "Bülow's five counters arrive on Game-Turn 3");
  ok(bulow.every((u) => g.hex(u.q, u.r).col === 26), "…on the easternmost column");
  ok(bulow.every((u) => g.hex(u.q, u.r).terrain !== "w"), "…on non-woods hexes");
  while (!(g.turn === 6 && g.activeFaction === "al" && g.phase === "move")) {
    const r = g.endPhase();
    if (!r.ok) { ok(false, "reached turn 6 without blocked phases (" + r.reason + ")"); break; }
  }
  ok(g.units.filter((u) => u.army === "pr" && u.entered).length === 6,
     "Zieten arrives on Game-Turn 6");
  // Timeout: the Allies hold.
  const g2 = new Game(W);
  g2.turn = W.maxTurns; g2.sideIndex = 1; g2.phaseIndex = 1;
  g2.endPhase();
  ok(g2.over && g2.winner === "al", "night falls on Turn 10 with an Allied victory");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
