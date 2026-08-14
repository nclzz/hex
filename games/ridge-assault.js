/* =========================================================================
   ridge-assault.js — A scenario built ON the engine. Pure data + a few small
   callbacks. This is the pattern for authoring new hex games: describe the
   terrain, units, map, setup, CRT and victory goal — the engine does the rest.
   Exposed as the global `RIDGE_ASSAULT`.
   ========================================================================= */
(function (global) {
  "use strict";

  const RIDGE_ASSAULT = {
    id: "ridge-assault",
    title: "Ridge Assault",
    blurb: "9×11 — a short, sharp fight for one town. Fits on a phone screen.",
    brief:
      "The French (you go first) must capture the Town objective by the end " +
      "of Turn 6. The Allies win by holding it.",
    orientation: "pointy",
    offsetMode: "odd-r",
    maxTurns: 6,
    phases: ["move", "combat"],

    // combat = strength, move = movement allowance, range = attack reach (default 1).
    unitTypes: {
      inf: { name: "Infantry",  glyph: "I", combat: 4, move: 4 },
      cav: { name: "Cavalry",   glyph: "C", combat: 3, move: 8 },
      art: { name: "Artillery", glyph: "A", combat: 5, move: 3, range: 2 },
      grd: { name: "Guard",     glyph: "G", combat: 6, move: 4 },
    },

    // moveCost = points to ENTER; defMult = defender strength multiplier.
    terrain: {
      ".": { name: "Clear", color: "#cfe3b8", moveCost: 1, defMult: 1 },
      "w": { name: "Woods", color: "#5a8f4e", moveCost: 2, defMult: 2 },
      "h": { name: "Hill",  color: "#c9a36a", moveCost: 2, defMult: 3 },
      "t": { name: "Town",  color: "#b9b2a6", moveCost: 1, defMult: 3 },
    },

    factions: [
      { id: "fr", name: "French", short: "FRENCH", color: "#2b5fa8", dark: "#1c3f70" },
      { id: "al", name: "Allies", short: "ALLIES", color: "#b23a3a", dark: "#7d2626" },
    ],

    map: [
      ".........",
      "....t....",
      "..w.h.w..",
      "..w...w..",
      "....h....",
      ".w.....w.",
      "...h.h...",
      ".........",
      "..w...w..",
      ".........",
      ".........",
    ],

    objectives: [{ col: 4, row: 1, owner: "fr" }], // the Town the French must take

    setup: [
      { faction: "fr", units: [ [4, 9, "grd"], [2, 9, "inf"], [6, 9, "inf"], [1, 10, "cav"], [7, 10, "art"] ] },
      { faction: "al", units: [ [4, 1, "inf"], [4, 4, "grd"], [3, 3, "art"], [5, 3, "inf"], [6, 4, "cav"] ] },
    ],

    // Uses the engine's default CRT (omit `crt` to accept it), default movement,
    // ZOC and combat rules. Only the victory goal is scenario-specific:
    victory(game, opts) {
      // Win by elimination (either side).
      for (const f of game.factions) {
        if (game.living(f.id).length === 0) {
          const other = game.factions.find((x) => x.id !== f.id);
          return { winner: other.id, reason: `${f.name} army destroyed` };
        }
      }
      // French win the instant they occupy the objective town.
      const obj = game.objectives[0];
      const holder = game.units.find((u) => u.alive && u.q === obj.q && u.r === obj.r);
      if (holder && holder.faction === "fr")
        return { winner: "fr", reason: "The French have stormed the town!" };
      // On timeout the defenders have held.
      if (opts && opts.timeout)
        return { winner: "al", reason: "The Allies held the ridge until nightfall." };
      return null;
    },
  };

  global.RIDGE_ASSAULT = RIDGE_ASSAULT;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(RIDGE_ASSAULT);
})(typeof window !== "undefined" ? window : globalThis);
