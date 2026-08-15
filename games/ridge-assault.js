/* =========================================================================
   ridge-assault.js — A scenario built ON the engine, playing by the NAPOLEON
   AT WAR common rules (NAW_COMMON.buildScenario supplies the CRT, mandatory
   combat, sticky ZOC, one-hex retreats and advance-after-combat). Everything
   in this file is the scenario's exclusive content: terrain flavour, map,
   armies and the victory goal. This is the pattern for authoring new games.
   Exposed as the global `RIDGE_ASSAULT`.
   ========================================================================= */
(function (global) {
  "use strict";
  const NAW = global.NAW_COMMON;

  const RIDGE_ASSAULT = NAW.buildScenario({
    id: "ridge-assault",
    title: "Ridge Assault",
    blurb: "9×11 — a short, sharp fight for one town. Fits on a phone screen.",
    brief:
      "The French (you go first) must capture the Town objective by the end " +
      "of Turn 6. The Allies win by holding it. Napoleon at War rules: " +
      "adjacent units MUST fight, units starting next to the enemy are " +
      "locked, retreats are one hex, and a victor may advance into a hex " +
      "it clears.",
    maxTurns: 6,

    // combat = strength, move = movement allowance, range = attack reach (default 1).
    unitTypes: {
      inf: NAW.unit("Infantry",  "I", 4, 4),
      cav: NAW.unit("Cavalry",   "C", 3, 8),
      art: NAW.unit("Artillery", "A", 5, 3, { range: 2 }),
      grd: NAW.unit("Guard",     "G", 6, 4),
    },

    // Terrain comes straight from the series' standard chart (NAW_COMMON).

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

    // The common rules handle movement, ZOC, combat and the CRT; only the
    // victory goal is scenario-specific:
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
      const holder = game.unitAt(obj.q, obj.r);
      if (holder && holder.faction === "fr")
        return { winner: "fr", reason: "The French have stormed the town!" };
      // On timeout the defenders have held.
      if (opts && opts.timeout)
        return { winner: "al", reason: "The Allies held the ridge until nightfall." };
      return null;
    },
  });

  global.RIDGE_ASSAULT = RIDGE_ASSAULT;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(RIDGE_ASSAULT);
})(typeof window !== "undefined" ? window : globalThis);
