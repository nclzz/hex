/* =========================================================================
   sambre-crossing.js — A large scenario (24 x 18 = 432 hexes) built on the
   engine. Deliberately bigger than any phone screen: the renderer's camera
   (drag to pan, pinch/wheel to zoom) is what makes it playable.

   The river splits the map in two and is impassable — only three crossings
   let an army over, so the manoeuvre is choosing which one to force.
   Exposed as the global `SAMBRE_CROSSING`.
   ========================================================================= */
(function (global) {
  "use strict";

  const SAMBRE_CROSSING = {
    id: "sambre-crossing",
    title: "Sambre Crossing",
    blurb: "24×18 — force a river against three towns. Pan and zoom to fight it.",
    brief:
      "The French must seize the three towns beyond the river by the end of " +
      "Turn 10. The Allies win by holding two of them. The river can only be " +
      "crossed at the three fords — pick one and force it.",
    orientation: "pointy",
    offsetMode: "odd-r",
    maxTurns: 10,
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
      ".": { name: "Clear",  color: "#cfe3b8", moveCost: 1, defMult: 1 },
      "w": { name: "Woods",  color: "#5a8f4e", moveCost: 2, defMult: 2 },
      "h": { name: "Hill",   color: "#c9a36a", moveCost: 2, defMult: 3 },
      "t": { name: "Town",   color: "#b9b2a6", moveCost: 1, defMult: 3 },
      "m": { name: "Marsh",  color: "#8f9b6a", moveCost: 3, defMult: 1 },
      "=": { name: "Ford",   color: "#a89468", moveCost: 2, defMult: 1 },
      "~": { name: "River",  color: "#4a7fa8", moveCost: Infinity, defMult: 1,
             passable: false },
    },

    factions: [
      { id: "fr", name: "French", short: "FRENCH", color: "#2b5fa8", dark: "#1c3f70" },
      { id: "al", name: "Allies", short: "ALLIES", color: "#b23a3a", dark: "#7d2626" },
    ],

    //         0         1         2
    //         0123456789012345678901234
    map: [
      "....h.........h.........", //  0
      "..w...........w...w.....", //  1
      "...t................t...", //  2  towns (3,2) and (20,2)
      "..w.w.......h.......w.w.", //  3
      "............t...........", //  4  town (12,4)
      ".....h.....hhh.....h....", //  5
      "...w.........m......w...", //  6
      ".......m.......m........", //  7
      "~~~~=~~~~~~~~=~~~~~~=~~~", //  8  the river — fords at 4, 13 and 20
      "........................", //  9
      "...w....h.......h...w...", // 10
      ".......m.......m........", // 11
      "..w..........w.....w....", // 12
      ".....h........h.........", // 13
      "........................", // 14
      "...w...........w........", // 15
      "........................", // 16
      "........................", // 17
    ],

    // The three towns the French must take.
    objectives: [
      { col: 3,  row: 2, owner: "fr" },
      { col: 12, row: 4, owner: "fr" },
      { col: 20, row: 2, owner: "fr" },
    ],

    setup: [
      { faction: "fr", units: [
        [2, 16, "inf"], [4, 16, "inf"], [6, 15, "cav"], [9, 16, "inf"],
        [11, 16, "grd"], [13, 15, "inf"], [15, 16, "inf"], [18, 16, "cav"],
        [20, 15, "inf"], [8, 17, "art"], [17, 17, "art"],
      ] },
      { faction: "al", units: [
        [2, 2, "inf"], [3, 3, "inf"], [12, 3, "inf"], [11, 4, "inf"],
        [12, 5, "grd"], [20, 3, "inf"], [21, 2, "inf"], [6, 5, "cav"],
        [17, 5, "cav"], [5, 6, "art"], [18, 6, "art"],
      ] },
    ],

    // Engine defaults for the CRT, movement and ZOC; only the goal is ours.
    victory(game, opts) {
      // Win by elimination (either side).
      for (const f of game.factions) {
        if (game.living(f.id).length === 0) {
          const other = game.factions.find((x) => x.id !== f.id);
          return { winner: other.id, reason: `${f.name} army destroyed` };
        }
      }
      // Count towns held right now.
      const held = { fr: 0, al: 0 };
      for (const o of game.objectives) {
        const u = game.units.find((x) => x.alive && x.q === o.q && x.r === o.r);
        if (u) held[u.faction]++;
      }
      // Taking all three ends it on the spot.
      if (held.fr === game.objectives.length)
        return { winner: "fr", reason: "All three towns are in French hands!" };
      // At nightfall the side holding more towns wins; a tie favours the defender.
      if (opts && opts.timeout) {
        return held.fr > held.al
          ? { winner: "fr", reason: `The French hold ${held.fr} of 3 towns at nightfall.` }
          : { winner: "al", reason: "The Allies held the Sambre until nightfall." };
      }
      return null;
    },
  };

  global.SAMBRE_CROSSING = SAMBRE_CROSSING;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(SAMBRE_CROSSING);
})(typeof window !== "undefined" ? window : globalThis);
