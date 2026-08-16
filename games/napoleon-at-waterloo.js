/* =========================================================================
   napoleon-at-waterloo.js — NAPOLEON AT WATERLOO, June 18, 1815.
   A Napoleon At War series game: the Standard (common) rules come from
   the engine + NAW_COMMON.buildScenario(); everything in this file is the
   battle's EXCLUSIVE rules — map, order of battle, the Prussian
   reinforcement schedule, demoralization levels and victory conditions.

   The map is drawn from the published NAW Waterloo map: open farmland cut
   by the yellow road net (the Brussels highway north-south, the Nivelles
   road southwest, the lateral to Braine-l'Alleud, the eastern road by
   Ohain down to Plancenoit), with the villages in their historical places
   and the Bois de Paris massed on the eastern edge. Roads are hexside
   features (1/2 MP per road hex); there are no rivers at Waterloo.

   Exclusive rules:
   - The Allied player receives Prussian units from Game-Turn 3, entering on
     non-Woods hexes of the easternmost hex column (Bülow toward Plancenoit;
     Zieten's advance guard arrives later in the north-east).
   - Demoralization: the French army breaks at 40 eliminated Strength Points
     — but if the French have demoralized the Prussian army their own level
     rises by 10. The Anglo-Allied army breaks at 26. Prussian losses never
     count toward the Anglo-Allied level; demoralizing the Prussians alone
     does not end the game (it emboldens the French instead).
   - The French also win at the instant they hold Mont-Saint-Jean (the
     Brussels road is cut); if night falls (end of Turn 10) with no army
     demoralized, Wellington's line has held: Allied victory.

   FIDELITY NOTE — the order of battle, the demoralization levels and the
   terrain multipliers remain reconstructions at the series' scale (1 SP =
   500-1,000 men); the Standard Rules themselves are implemented from the
   published text. Exposed as the global `NAPOLEON_AT_WATERLOO`.
   ========================================================================= */
(function (global) {
  "use strict";
  const NAW = global.NAW_COMMON;
  const u = NAW.unit;

  // Prussian counters carry their own colour so both of the Allied player's
  // armies read at a glance (demoralization tracks them separately).
  const PR = "#3f3f46";

  // A road is a chain of hexes; each consecutive pair is one road hexside.
  const chain = (hexes) => {
    const pairs = [];
    for (let i = 1; i < hexes.length; i++) pairs.push([hexes[i - 1], hexes[i]]);
    return pairs;
  };
  const BRUSSELS_ROAD = chain([
    [10, 0], [10, 1], [10, 2], [10, 3], [10, 4], [10, 5], [11, 6], [11, 7],
    [12, 8], [12, 9], [12, 10], [12, 11], [12, 12], [12, 13], [12, 14],
    [12, 15], [12, 16], [12, 17], [12, 18], [12, 19], [12, 20], [12, 21],
  ]);
  const TOP_EAST_ROAD = chain([
    [10, 2], [11, 2], [12, 2], [13, 2], [14, 2], [15, 2], [16, 2], [17, 2],
    [18, 2], [19, 2], [19, 1],
  ]);
  const WEST_ROAD = chain([
    [10, 5], [9, 5], [9, 6], [8, 7], [7, 7], [7, 8], [6, 8], [5, 9], [4, 9], [3, 9],
  ]);
  const NIVELLES_ROAD = chain([
    [10, 5], [10, 6], [10, 7], [10, 8], [9, 9], [9, 10], [8, 11], [8, 12],
    [7, 13], [7, 14], [6, 15], [6, 16], [6, 17], [6, 18], [6, 19], [6, 20], [6, 21],
  ]);
  const EAST_ROAD = chain([
    [24, 4], [23, 5], [23, 6], [22, 7], [22, 8], [21, 9], [20, 9], [20, 10],
    [19, 11], [19, 12], [18, 13], [18, 14], [17, 14], [16, 14], [15, 15],
    [15, 16], [14, 16], [13, 16], [12, 16],
  ]);

  const NAPOLEON_AT_WATERLOO = NAW.buildScenario({
    id: "napoleon-at-waterloo",
    title: "Napoleon at Waterloo",
    blurb: "27×22 — June 18, 1815. Break Wellington before Blücher arrives.",
    brief:
      "The French must demoralize the Anglo-Allied army (26 SP lost) or take " +
      "Mont-Saint-Jean before nightfall (Turn 10). The Allies win by " +
      "demoralizing the French (40 SP) or simply holding on — from Turn 3 " +
      "Prussian columns arrive on the eastern edge. Napoleon at War rules: " +
      "combat between adjacent units is COMPULSORY, units starting next to " +
      "the enemy are locked, retreats are one hex (a blocked retreat " +
      "displaces a friend or destroys the unit), the victor of a hex may " +
      "advance into it, roads move you at 1/2 MP per hex, and woods or " +
      "towns block artillery lines of sight.",
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

    // North at the top, from the published map: Waterloo village (10,1) and
    // Ransbèche (19,1) on the north edge, Ohain (24,4) and Le Mesnil (6,4),
    // Mont-Saint-Jean (10,5, the objective), Merbe-Braine (7,7),
    // Braine-l'Alleud (3,9), La Haye Sainte (12,9) and Hougoumont (9,11) as
    // chateaux, La Haye (17,9) / Papelotte (17,10) / Frichermont (20,9) in
    // the east, Plancenoit (16,14), Maison du Roi (12,17), Maransart
    // (23,15); the Bois de Paris masses on the eastern flank.
    //     0         1         2
    //     012345678901234567890123456
    map: [
      "..............ww...........", //  0
      "..........t...ww...t.......", //  1  Waterloo · Ransbèche
      "...........................", //  2
      ".....................ww....", //  3
      "......t.................t..", //  4  Le Mesnil · Ohain
      "..........t................", //  5  MONT-SAINT-JEAN ★
      "..w...........w............", //  6
      ".......t................w..", //  7  Merbe-Braine
      "...........................", //  8
      "...t........c....t..t......", //  9  Braine-l'Alleud · La Haye Sainte · La Haye · Frichermont
      ".................t.........", // 10  Papelotte
      ".........c..........w......", // 11  Hougoumont
      "........Ww.........Www.....", // 12  W = Woods-Road (Nivelles rd · east rd)
      ".........w..........www....", // 13  Bois de Paris ->
      "................t....ww....", // 14  Plancenoit
      ".......................t...", // 15  Maransart
      "........................ww.", // 16
      "............t....ww......w.", // 17  Maison du Roi
      "...ww............ww........", // 18
      "....ww..........ww.........", // 19
      ".....w.....................", // 20
      "...........................", // 21
    ],

    hexsides: [
      { type: "road", pairs: [].concat(
        BRUSSELS_ROAD, TOP_EAST_ROAD, WEST_ROAD, NIVELLES_ROAD, EAST_ROAD) },
    ],

    objectives: [{ col: 10, row: 5, owner: "fr" }], // Mont-Saint-Jean

    setup: [
      { faction: "al", army: "anglo", units: [
        // Wellington's line south of Mont-Saint-Jean
        [7, 8, "inf4"], [9, 8, "inf4"], [10, 8, "gde5"], [11, 8, "inf4"],
        [13, 8, "inf4"], [15, 8, "inf4"], [16, 9, "inf4"],
        [8, 7, "art4"], [14, 7, "art4"],
        // forward garrisons
        [9, 11, "inf3"],   // Hougoumont
        [12, 9, "inf3"],   // La Haye Sainte
        [17, 10, "inf3"],  // Papelotte
        // cavalry reserve behind the crest
        [9, 6, "cav3"], [13, 6, "cav3"],
      ] },
      { faction: "fr", units: [
        // grand battery on the French ridge
        [11, 12, "art5"], [12, 12, "art5"], [13, 12, "art5"],
        // d'Erlon's corps (east) and Reille's corps (west)
        [14, 12, "inf4"], [15, 12, "inf4"], [16, 12, "inf4"], [17, 12, "inf4"],
        [10, 13, "inf4"], [11, 13, "inf4"], [12, 13, "inf4"],
        // Lobau's reserve corps
        [14, 13, "inf4"],
        // the cavalry
        [8, 14, "cav3"], [10, 14, "cav3"], [16, 13, "cav3"], [18, 12, "cav3"],
        // the Guard, up the Brussels road
        [11, 14, "gdi6"], [12, 14, "gd7"], [13, 14, "gdi6"],
      ] },
    ],

    // EXCLUSIVE RULE — the Prussians. Non-woods hexes of the easternmost
    // column, in arrival order: Bülow's IV Corps from Game-Turn 3 heading
    // for Plancenoit through the Bois de Paris, Zieten's advance guard from
    // Game-Turn 6 by Ohain.
    reinforcements: [
      { turn: 3, faction: "al", army: "pr",
        entry: [[26, 10], [26, 11], [26, 12], [26, 13], [26, 14]],
        units: ["pinf4", "pinf4", "pinf3", "pcav2", "part3"] },
      { turn: 6, faction: "al", army: "pr",
        entry: [[26, 5], [26, 6], [26, 7]],
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
                 reason: "The French hold Mont-Saint-Jean — the Brussels road is cut!" };
      if (opts && opts.timeout)
        return { winner: "al",
                 reason: "Night falls. Wellington's line has held, and the Prussians are on the field." };
      return null;
    },
  });

  global.NAPOLEON_AT_WATERLOO = NAPOLEON_AT_WATERLOO;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(NAPOLEON_AT_WATERLOO);
})(typeof window !== "undefined" ? window : globalThis);
