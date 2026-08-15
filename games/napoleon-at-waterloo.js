/* =========================================================================
   napoleon-at-waterloo.js — NAPOLEON AT WATERLOO, June 18, 1815.
   A Napoleon At War series game: the Standard (common) rules come from
   NAW_COMMON.buildScenario(); everything in this file is the battle's
   EXCLUSIVE rules — map, order of battle, the Prussian reinforcement
   schedule, demoralization levels and victory conditions.

   Exclusive rules implemented (per the game's HexWar wiki page):
   - The Allied player receives Prussian units from Game-Turn 3, entering on
     non-Woods hexes of the easternmost hex column (Bülow toward Plancenoit;
     Zieten's advance guard arrives later in the north-east).
   - Demoralization: the French army breaks at 40 eliminated Strength Points
     — but if the French have demoralized the Prussian army their own level
     rises by 10. The Anglo-Allied army breaks at 26. Prussian losses never
     count toward the Anglo-Allied level; demoralizing the Prussians alone
     does not end the game (it emboldens the French instead).
   - The French also win at the instant they hold the Mont-Saint-Jean
     crossroads (the Brussels road is cut); if night falls (end of Turn 10)
     with no army demoralized, Wellington's line has held: Allied victory.

   FIDELITY NOTE — the wiki was unreachable from this environment, so the
   order of battle and the demoralization levels are a reconstruction at the
   series' scale (1 SP = 500-1,000 men; the real armies were ~72,000 French
   vs ~68,000 Anglo-Allied plus ~50,000 arriving Prussians). Correct the
   counters/levels here if you have the published counter mix.
   Exposed as the global `NAPOLEON_AT_WATERLOO`.
   ========================================================================= */
(function (global) {
  "use strict";
  const NAW = global.NAW_COMMON;
  const u = NAW.unit;

  // Prussian counters carry their own colour so both of the Allied player's
  // armies read at a glance (demoralization tracks them separately).
  const PR = "#3f3f46";

  const NAPOLEON_AT_WATERLOO = NAW.buildScenario({
    id: "napoleon-at-waterloo",
    title: "Napoleon at Waterloo",
    blurb: "22×16 — June 18, 1815. Break Wellington before Blücher arrives.",
    brief:
      "The French must demoralize the Anglo-Allied army (26 SP lost) or seize " +
      "the Mont-Saint-Jean crossroads before nightfall (Turn 10). The Allies " +
      "win by demoralizing the French (40 SP) or simply holding on — from " +
      "Turn 3 Prussian columns arrive on the eastern edge. Napoleon at War " +
      "rules: combat between adjacent units is COMPULSORY, units that start " +
      "their Movement Phase next to the enemy are locked in place, retreats " +
      "are one hex (blocked retreat = destruction), and a victor may advance " +
      "into a hex it clears.",
    maxTurns: 10,

    // CS-MA at series scale. Artillery bombards at 2 hexes (@2).
    unitTypes: {
      inf4:  u("Line Infantry",   "I", 4, 4),
      inf3:  u("Militia",         "I", 3, 4),
      gde5:  u("Foot Guards",     "G", 5, 4),
      gdi6:  u("Guard Infantry",  "G", 6, 4),
      gd7:   u("Old Guard",       "G", 7, 4),
      cav3:  u("Cavalry",         "C", 3, 8),
      art5:  u("Grand Battery",   "A", 5, 3, { range: 2 }),
      art4:  u("Field Artillery", "A", 4, 3, { range: 2 }),
      // Prussian counters (Allied player, army "pr")
      pinf4: u("Prussian Infantry", "I", 4, 4, { color: PR }),
      pinf3: u("Landwehr",          "I", 3, 4, { color: PR }),
      pcav2: u("Prussian Cavalry",  "C", 2, 8, { color: PR }),
      part3: u("Prussian Artillery","A", 3, 3, { range: 2, color: PR }),
    },

    factions: [
      { id: "fr", name: "French", short: "FRENCH", color: "#2b5fa8", dark: "#1c3f70" },
      { id: "al", name: "Allies", short: "ALLIES", color: "#b23a3a", dark: "#7d2626" },
    ],

    // North at the top. The slope ridge is Wellington's Mont-Saint-Jean
    // position; c = Hougoumont (5,6) and La Haye Sainte (10,5); t = the
    // Mont-Saint-Jean crossroads (10,1), Papelotte (16,5), La Belle
    // Alliance (10,8) and Plancenoit (15,10); the eastern woods are the
    // Bois de Paris, through which the Prussians debouch.
    //     0         1         2
    //     0123456789012345678901
    map: [
      "......................", //  0
      "..........t...........", //  1  Mont-Saint-Jean crossroads
      "......................", //  2
      "...hhhhhhhhhhhhhhh....", //  3  the ridge
      "....hhhhhhhhhhhhh.....", //  4
      "..........c.....t.....", //  5  La Haye Sainte, Papelotte
      ".....c..............ww", //  6  Hougoumont · Bois de Paris ->
      "....ww..............ww", //  7
      "..........t.........ww", //  8  La Belle Alliance
      "....................ww", //  9
      "...............t......", // 10  Plancenoit
      "......................", // 11
      "......................", // 12
      ".....w.........w......", // 13
      "......................", // 14
      "......................", // 15
    ],

    objectives: [{ col: 10, row: 1, owner: "fr" }], // the Brussels road

    setup: [
      { faction: "al", army: "anglo", units: [
        // the ridge line
        [5, 3, "inf4"], [6, 3, "gde5"], [8, 3, "inf4"], [10, 3, "art4"],
        [11, 3, "inf4"], [13, 3, "inf4"], [14, 3, "art4"], [15, 3, "inf4"],
        [9, 4, "inf4"],
        // forward garrisons
        [5, 6, "inf3"],   // Hougoumont
        [10, 5, "inf3"],  // La Haye Sainte
        [16, 5, "inf3"],  // Papelotte
        // cavalry reserve behind the crest
        [8, 2, "cav3"], [12, 2, "cav3"],
      ] },
      { faction: "fr", units: [
        // grand battery before the line
        [9, 7, "art5"], [10, 7, "art5"], [11, 7, "art5"],
        // d'Erlon's corps (east) and Reille's corps (west)
        [12, 7, "inf4"], [13, 7, "inf4"], [14, 7, "inf4"], [15, 7, "inf4"],
        [6, 8, "inf4"], [7, 8, "inf4"], [8, 8, "inf4"],
        // Lobau's reserve corps
        [12, 8, "inf4"],
        // the cavalry
        [4, 8, "cav3"], [9, 8, "cav3"], [13, 8, "cav3"], [16, 8, "cav3"],
        // the Guard, around La Belle Alliance
        [9, 9, "gdi6"], [10, 9, "gd7"], [11, 9, "gdi6"],
      ] },
    ],

    // EXCLUSIVE RULE — the Prussians. Non-woods hexes of the easternmost
    // column, in arrival order: Bülow's IV Corps from Game-Turn 3 heading
    // for Plancenoit, Zieten's advance guard from Game-Turn 6 by Papelotte.
    reinforcements: [
      { turn: 3, faction: "al", army: "pr",
        entry: [[21, 10], [21, 11], [21, 12], [21, 13], [21, 14]],
        units: ["pinf4", "pinf4", "pinf3", "pcav2", "part3"] },
      { turn: 6, faction: "al", army: "pr",
        entry: [[21, 4], [21, 3], [21, 5]],
        units: ["pinf4"] },
    ],

    // EXCLUSIVE RULE — demoralization levels. The French level rises by 10
    // once they have demoralized the Prussian army; the Prussian entry is
    // tracked but does not end the game by itself.
    demoralization: [
      { faction: "fr", name: "French Army", short: "FR",
        level: (g) => 40 + (g.lostSP("al", "pr") >= 12 ? 10 : 0) },
      { faction: "al", army: "anglo", name: "Anglo-Allied Army", short: "ANG", level: 26 },
      { faction: "al", army: "pr", name: "Prussian Army", short: "PRU",
        level: 12, endsGame: false },
    ],

    victory(game, opts) {
      const dem = NAW.demoralizationVictory(game);
      if (dem) return dem;
      // Elimination — reserves still off-map count as alive.
      for (const f of game.factions) {
        if (!game.units.some((x) => x.alive && x.faction === f.id)) {
          const other = game.factions.find((x) => x.id !== f.id);
          return { winner: other.id, reason: `${f.name} army destroyed` };
        }
      }
      const obj = game.objectives[0];
      const holder = game.unitAt(obj.q, obj.r);
      if (holder && holder.faction === "fr")
        return { winner: "fr",
                 reason: "The French hold the Mont-Saint-Jean crossroads — the Brussels road is cut!" };
      if (opts && opts.timeout)
        return { winner: "al",
                 reason: "Night falls. Wellington's line has held, and the Prussians are on the field." };
      return null;
    },
  });

  global.NAPOLEON_AT_WATERLOO = NAPOLEON_AT_WATERLOO;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(NAPOLEON_AT_WATERLOO);
})(typeof window !== "undefined" ? window : globalThis);
