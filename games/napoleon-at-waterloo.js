/* =========================================================================
   napoleon-at-waterloo.js — NAPOLEON AT WATERLOO, June 18, 1815.
   A Napoleon At War series game: the Standard (common) rules come from
   the engine + NAW_COMMON.buildScenario(); everything in this file is the
   battle's OFFICIAL EXCLUSIVE rules — map, order of battle, the Prussian
   reinforcement schedule, victory conditions and the Grouchy variant.

   Exclusive rules implemented (by case number of the game's rulebook):
   - [7.0] The Allied player receives the Prussians during the Movement
     Phase of GAME-TURN TWO, on non-woods hexes of the easternmost column;
     entry costs 1 MP [7.1] and never lands in an enemy ZOC [7.2].
   - [8.0] Victory: each side races to destroy 40 enemy Strength Points.
     * [8.1] The Allies win the instant 40 French SP are destroyed while
       fewer than 40 Allied SP have been lost.
     * [8.2] Losing 40 SP DEMORALIZES the Allies: the game continues, but
       every Allied attack drops one ratio column and every French attack
       rises one. French losses reaching 40 afterwards changes nothing.
     * [8.3] The French win the instant the Allies are demoralized AND
       seven French units have marched off the indicated north-edge hexes
       during French Movement Phases (exited units are not destroyed).
     * [8.4] Anything else is a draw at the end of Game-Turn TEN. If both
       sides hit 40 at the same instant (an Ee), the French win only if the
       seven units are already off; otherwise the Allies do.
   - [5.9] At Waterloo only WOODS block artillery lines of sight — towns do
     not (they override the common chart's losBlock).
   - [6.2] The attacker may deliberately lower the combat ratio before
     rolling (engine `opts.lower`, offered in the combat card).
   - [9.0] The Grouchy Variant (second picker entry): a random code per
     side, rolled at setup, schedules extra French forces under Grouchy
     and a greater/lesser/later Prussian contingent — all entering by the
     same eastern edge [9.1].

   FIDELITY NOTE — cavalry (x-5) and artillery (3-3) movement/values and the
   Grouchy contingent (5-4, 4-4, 4-4, 2-5, 3-3) follow the counters named in
   the rulebook; the full order of battle, the guard values and the exact
   Prussian counts remain reconstructions at the series' scale.
   Simplifications: reinforcements auto-place at their earliest turn (the
   voluntary delay of [7.3] is not offered), variant codes are rolled openly
   at setup, and [6.5]'s required-bombardment displacement exception and
   [6.8]'s voluntary gun fallback are not modeled.
   Exposed as the globals `NAPOLEON_AT_WATERLOO` / `NAW_GROUCHY`.
   ========================================================================= */
(function (global) {
  "use strict";
  const NAW = global.NAW_COMMON;
  const u = NAW.unit;

  // Prussian counters carry their own colour so the Allied player's armies
  // read at a glance.
  const PR = "#3f3f46";

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

  // Shared exclusive content; `grouchy` switches on the [9.0] variant.
  function makeWaterloo(grouchy) {
    const def = {
      id: grouchy ? "napoleon-at-waterloo-grouchy" : "napoleon-at-waterloo",
      title: grouchy ? "Waterloo — Grouchy Variant" : "Napoleon at Waterloo",
      blurb: grouchy
        ? "27×22 — the same battle with secret reinforcement rolls: will Grouchy come?"
        : "27×22 — June 18, 1815. Break Wellington before Blücher arrives.",
      brief:
        "Each side races to destroy 40 enemy Strength Points. The Allies win " +
        "the instant they get there first; the French must instead break the " +
        "Allies AND march SEVEN units off the marked north-edge hexes (▲) " +
        "during their Movement Phases. A broken army fights on at shifted " +
        "odds: its attacks drop one column, the enemy's rise one. Anything " +
        "else is a draw at nightfall (Turn 10). The Prussians reach the " +
        "eastern edge on Turn 2" +
        (grouchy ? " — unless the pre-game reinforcement rolls say otherwise, " +
                   "and Grouchy's French corps may appear behind them" : "") +
        ". Only woods block artillery sight lines here; an attacker may also " +
        "deliberately lower his combat odds before rolling.",
      // [8.0] shown by the pre-game wizard.
      winConditions: [
        { side: "al", text: "Destroy 40 French Strength Points before losing " +
          "40 of your own — the game stops the instant you do. Prussian " +
          "losses count against you." },
        { side: "fr", text: "Demoralize the Allies (destroy 40 of their " +
          "Strength Points), then march SEVEN units off the north-edge ▲ " +
          "hexes during your Movement Phases." },
        { label: "DRAW", text: "Anything else at nightfall (end of Turn 10) " +
          "is a draw. A demoralized army fights on with every attack one CRT " +
          "column worse — and its enemy's one better." },
      ].concat(grouchy ? [
        { label: "ROLLS", text: "Before play each side draws a secret code: " +
          "it decides whether Grouchy's corps returns for France and how " +
          "much of Blücher's army comes for the Allies." },
      ] : []),
      maxTurns: 10,

      // CS-MA per the rulebook's counters where named (cavalry x-5,
      // artillery 3-3 @2); guards remain a reconstruction.
      unitTypes: {
        inf5:  u("Line Infantry",   "I", 5, 4),
        inf4:  u("Line Infantry",   "I", 4, 4),
        inf3:  u("Militia",         "I", 3, 4),
        gde5:  u("Foot Guards",     "G", 5, 4),
        gdi6:  u("Guard Infantry",  "G", 6, 4),
        gd7:   u("Old Guard",       "G", 7, 4),
        cav3:  u("Cavalry",         "C", 3, 5),
        cav2:  u("Light Cavalry",   "C", 2, 5),
        art4:  u("Grand Battery",   "A", 4, 3, { range: 2 }),
        art3:  u("Field Artillery", "A", 3, 3, { range: 2 }),
        // Prussian counters (Allied player, army "pr")
        pinf5: u("Prussian Infantry", "I", 5, 4, { color: PR }),
        pinf4: u("Prussian Infantry", "I", 4, 4, { color: PR }),
        pcav3: u("Prussian Cavalry",  "C", 3, 5, { color: PR }),
        part3: u("Prussian Artillery","A", 3, 3, { range: 2, color: PR }),
      },

      factions: [
        { id: "fr", name: "French", short: "FRENCH", color: "#2b5fa8", dark: "#1c3f70" },
        { id: "al", name: "Allies", short: "ALLIES", color: "#b23a3a", dark: "#7d2626" },
      ],

      // [5.9] Exclusive override: at Waterloo towns do NOT block artillery
      // lines of sight — only woods (and woods-road) do.
      terrain: {
        "t": { name: "Building", color: "#b9b2a6", moveCost: 1, defMult: 2 },
        "c": { name: "Chateau",  color: "#9a8f9c", moveCost: 1, defMult: 2 },
      },

      // North at the top, from the published map (see the map comment in
      // earlier revisions for the named places).
      //     0         1         2
      //     012345678901234567890123456
      map: [
        "..............ww...........", //  0  ▲ exit hexes westward of the woods
        "..........t...ww...t.......", //  1  Waterloo · Ransbèche
        "...........................", //  2
        ".....................ww....", //  3
        "......t.................t..", //  4  Le Mesnil · Ohain
        "..........t................", //  5  Mont-Saint-Jean
        "..w...........w............", //  6
        ".......t................w..", //  7  Merbe-Braine
        "...........................", //  8
        "...t........c....t..t......", //  9  Braine-l'Alleud · La Haye Sainte · La Haye · Frichermont
        ".................t.........", // 10  Papelotte
        ".........c..........w......", // 11  Hougoumont
        "........Ww.........Www.....", // 12  W = Woods-Road
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

      // [8.3] The French exit: the arrowed hexes of the north edge.
      exitHexes: { faction: "fr", target: 7,
                   hexes: [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
                           [8, 0], [9, 0], [10, 0]] },

      setup: [
        { faction: "al", army: "anglo", units: [
          // Wellington's line south of Mont-Saint-Jean
          [7, 8, "inf4"], [9, 8, "inf4"], [10, 8, "gde5"], [11, 8, "inf4"],
          [13, 8, "inf4"], [15, 8, "inf4"], [16, 9, "inf4"],
          [8, 7, "art3"], [14, 7, "art3"],
          // forward garrisons
          [9, 11, "inf3"],   // Hougoumont
          [12, 9, "inf3"],   // La Haye Sainte
          [17, 10, "inf3"],  // Papelotte
          // cavalry reserve behind the crest
          [9, 6, "cav3"], [13, 6, "cav3"],
        ] },
        { faction: "fr", units: [
          // grand battery on the French ridge
          [11, 12, "art4"], [12, 12, "art4"], [13, 12, "art4"],
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

      // [8.2]-style ticker data only — neither level ends the game by itself.
      demoralization: [
        { faction: "fr", name: "French Army", short: "FR", level: 40, endsGame: false },
        { faction: "al", name: "Allied Armies", short: "ALL", level: 40, endsGame: false },
      ],

      rules: {
        // [8.2] Once the Allies have lost 40 SP their attacks drop one ratio
        // column and French attacks rise one. (Base mapping = round down.)
        oddsColumn(game, atk, def) {
          const cols = game.def.crt.columns;
          let col = cols[0];
          const ratio = atk / def;
          for (const c of cols) {
            const [a, b] = c.split(":").map(Number);
            if (ratio + 1e-9 >= a / b) col = c;
          }
          if (game.lostSP("al") >= 40) {
            col = NAW.shiftColumn(game, col, game.activeFaction === "fr" ? 1 : -1);
          }
          return col;
        },
      },

      victory(game, opts) {
        const frL = game.lostSP("fr"), alL = game.lostSP("al");
        const st = game.scenarioState || (game.scenarioState = {});
        // Remember whether the Allies broke while the French were whole —
        // afterwards, French losses reaching 40 mean nothing [8.2].
        if (alL >= 40 && frL < 40 && !st.alliedBrokeFirst) st.alliedBrokeFirst = true;
        const out = game.exitedCount("fr");
        if (frL >= 40) {
          if (alL < 40)
            return { winner: "al",
                     reason: "Forty French Strength Points destroyed — the Grande Armée breaks first." }; // [8.1]
          if (!st.alliedBrokeFirst) // both hit 40 at the same instant [8.4]
            return out >= 7
              ? { winner: "fr", reason: "Both armies break together — but seven French units are already on the Brussels road." }
              : { winner: "al", reason: "Both armies break together — and the road north is still barred." };
        }
        if (alL >= 40 && out >= 7)
          return { winner: "fr",
                   reason: "The Allies are broken and seven French units have marched off north — the road to Brussels is open." }; // [8.3]
        // Total elimination still decides (exited units are not destroyed).
        for (const f of game.factions) {
          if (!game.units.some((x) => x.alive && !x.exited && x.faction === f.id)) {
            const other = game.factions.find((x) => x.id !== f.id);
            return { winner: other.id, reason: `${f.name} army destroyed` };
          }
        }
        if (opts && opts.timeout)
          return { winner: null,
                   reason: "Nightfall, Turn 10 — a draw, and in the history books an Allied moral victory." }; // [8.4]
        return null;
      },
    };

    // Reinforcements. The regular Prussian contingent [7.0] splits into an
    // advance guard + the rest so the [9.4] variant codes can stagger them.
    const east = (rows) => rows.map((r) => [26, r]);
    const advanceGuard = { faction: "al", army: "pr",
      entry: east([10, 11, 12, 13, 14]),
      units: ["pinf5", "pinf4", "pcav3", "part3"] };
    const restOfCorps = { faction: "al", army: "pr",
      entry: east([9, 10, 11, 12, 13, 14, 15]),
      units: ["pinf5", "pinf4"] };
    if (!grouchy) {
      def.reinforcements = [
        Object.assign({ turn: 2 }, advanceGuard),
        Object.assign({ turn: 2 }, restOfCorps),
      ];
    } else {
      // [9.0] Pre-game codes, one per side, rolled at setup.
      def.variants = { roll: (g) => ({
        fr: 1 + Math.floor(g.rng() * 6),
        pr: 1 + Math.floor(g.rng() * 6),
      }) };
      const pr = (g) => g.variant.pr;
      def.reinforcements = [
        // [9.4] 1: turn 2 · 2: never · 3: turn 4 · 4: reduced turn 2 ·
        //       5: turn 2 (+extras turn 4) · 6: everything turns 2 and 4
        Object.assign({ turnFor: (g) =>
          ({ 1: 2, 2: null, 3: 4, 4: 2, 5: 2, 6: 2 })[pr(g)] }, advanceGuard),
        Object.assign({ turnFor: (g) =>
          ({ 1: 2, 2: null, 3: 4, 4: null, 5: 2, 6: 2 })[pr(g)] }, restOfCorps),
        // extra Prussians for codes 5 and 6 (entering north of the first wave)
        { faction: "al", army: "pr", entry: east([4, 5, 6, 7, 8]),
          units: ["pinf5", "pinf4", "pcav3", "part3"],
          turnFor: (g) => (pr(g) >= 5 ? 4 : null) },
        // [9.2] Grouchy's French: codes 4-6 arrive on Game-Turn FOUR with the
        // rulebook's counters (5-4, two 4-4, 2-5, 3-3), by the same edge [9.1].
        { faction: "fr", entry: east([16, 17, 18, 19, 20]),
          units: ["inf5", "inf4", "inf4", "cav2", "art3"],
          turnFor: (g) => (g.variant.fr >= 4 ? 4 : null) },
      ];
    }
    return NAW.buildScenario(def);
  }

  const NAPOLEON_AT_WATERLOO = makeWaterloo(false);
  const NAW_GROUCHY = makeWaterloo(true);

  global.NAPOLEON_AT_WATERLOO = NAPOLEON_AT_WATERLOO;
  global.NAW_GROUCHY = NAW_GROUCHY;
  (global.HEX_SCENARIOS = global.HEX_SCENARIOS || []).push(NAPOLEON_AT_WATERLOO, NAW_GROUCHY);
})(typeof window !== "undefined" ? window : globalThis);
