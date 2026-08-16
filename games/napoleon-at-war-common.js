/* =========================================================================
   napoleon-at-war-common.js — The NAPOLEON AT WAR common rules, as a shared
   ruleset library for scenarios. This is NOT a scenario (it never registers
   in HEX_SCENARIOS); each battle in the series is built from it with
   `NAW_COMMON.buildScenario({...exclusive rules...})`, mirroring how the
   published series splits Standard Rules from each game's Exclusive Rules.

   Source: the "Napoleon At War" Standard Rules on the HexWar wiki
   (https://www.hexwar.com/wiki/games/napoleon-at-war/common/common-rules.html
   — the classic SPI 1971-75 system). Scale: 1 hex = 400-800 m, 1 Strength
   Point = 500-1,000 men, 1 game-turn = 1-2 hours.

   The mechanics of the common rules — sticky Zones of Control, mandatory
   combat, one-hex strict retreats, advance after combat, bombardment
   immunity at range — ARE the engine's built-in behavior (src/engine.js);
   there is no other ruleset. This file layers the series' DATA on top:
   - The CRT: odds rounded down to a column, die 1-6, results Ae/Ar/Ex/Dr/De
     (no "no effect"); worse than 1-3 is an automatic Ae, better than 5-1 an
     automatic De.
   - The standard terrain chart.
   - Demoralization helpers: when an army's cumulative eliminated Strength
     Points reach its Demoralization Level the game ends at that instant and
     the other player wins.
   - buildScenario(), night-turn scheduling, and the unit-type factory.

   FIDELITY NOTE — the CRT below is the OFFICIAL published chart. The
   terrain chart's movement costs and defense multipliers remain a careful
   reconstruction (the rules text refers to a Terrain Effects Chart that is
   published separately). They are plain data — correct them here if you
   have the published chart, and every scenario inherits the fix.
   ========================================================================= */
(function (global) {
  "use strict";

  /* ------------------------------- CRT ----------------------------------- */
  // The OFFICIAL Combat Results Table (Combat Ratios, Attacker to Defender
  // Strength). Rows are die 1..6, columns 1-5 through 6-1. Per the chart's
  // note, attacks worse than 1-5 are treated as 1-5 and attacks better than
  // 6-1 as 6-1 — the engine's round-down column mapping clamps to the outer
  // columns, which encodes exactly that.
  const CRT = {
    columns: ["1:5", "1:4", "1:3", "1:2", "1:1", "2:1", "3:1", "4:1", "5:1", "6:1"],
    table: {
      //  die:   1     2     3     4     5     6
      "1:5": ["Ae", "Ae", "Ae", "Ae", "Ae", "Ae"],
      "1:4": ["Ar", "Ae", "Ae", "Ae", "Ae", "Ae"],
      "1:3": ["Ar", "Ar", "Ae", "Ae", "Ae", "Ae"],
      "1:2": ["Dr", "Ar", "Ar", "Ae", "Ar", "Ar"],
      "1:1": ["Dr", "Dr", "Dr", "Ar", "Ar", "Ar"],
      "2:1": ["Dr", "Dr", "Dr", "Dr", "Ex", "Ar"],
      "3:1": ["De", "Dr", "Dr", "Dr", "Dr", "Ex"],
      "4:1": ["De", "Dr", "Dr", "Dr", "Ex", "Ex"],
      "5:1": ["De", "De", "De", "Dr", "Ex", "Ex"],
      "6:1": ["De", "De", "De", "De", "De", "De"],
    },
  };

  // Human label for a CRT column ("3:1" -> "3-1").
  function columnLabel(col) {
    return col.replace(":", "-");
  }

  /* ------------------------- common terrain chart ------------------------ */
  // The series' standard terrain (multipliers are a reconstruction — see
  // FIDELITY NOTE above). moveCost = MPs to ENTER; defMult = defender
  // strength multiplier; losBlock marks Forest/Town as bombardment
  // Line-of-Sight blockers [8.33]; slope drives the downhill hexside
  // surcharge [5.26]. Scenarios may add codes or override any of these.
  // Rivers, streams, bridges, roads and trails are HEXSIDE features
  // (def.hexsides), not hex terrain.
  const terrain = {
    ".": { name: "Clear",   color: "#cfe3b8", moveCost: 1, defMult: 1 },
    "w": { name: "Woods",   color: "#5a8f4e", moveCost: 2, defMult: 2, losBlock: true },
    "h": { name: "Slope",   color: "#c9a36a", moveCost: 2, defMult: 2, slope: true },
    "t": { name: "Town",    color: "#b9b2a6", moveCost: 1, defMult: 2, losBlock: true },
    "c": { name: "Chateau", color: "#9a8f9c", moveCost: 1, defMult: 3, losBlock: true },
    "m": { name: "Marsh",   color: "#8f9b6a", moveCost: 3, defMult: 1 },
  };

  /* ------------------------------ helpers -------------------------------- */
  // Unit-type factory for the varied printed strengths NAW counters carry.
  // `extra` may hold { range, army, color } etc.
  function unit(name, glyph, cs, ma, extra) {
    return Object.assign({ name, glyph, combat: cs, move: ma }, extra);
  }

  // Demoralization check for a scenario's victory(). `def.demoralization` is
  // an array of { faction, army?, level, name, endsGame? }; `level` may be a
  // function (game) -> number for exclusive rules that shift a level
  // mid-game, and an entry with `endsGame: false` is tracked (HUD, other
  // rules) without deciding the game by itself. When both sides cross their
  // levels at the same instant, the phasing player wins (per the standard
  // rules).
  function demoralizationVictory(game) {
    const dem = (game.def.demoralization || []).filter((d) => d.endsGame !== false);
    const down = dem.filter((d) => {
      const lvl = typeof d.level === "function" ? d.level(game) : d.level;
      return game.lostSP(d.faction, d.army) >= lvl;
    });
    if (!down.length) return null;
    const loser = down.find((d) => d.faction !== game.activeFaction) || down[0];
    const winner = game.factions.find((f) => f.id !== loser.faction).id;
    return { winner, reason: `${loser.name} demoralized — its losses broke the army.` };
  }

  // HUD/status helper: [{ name, short, faction, army, lost, level }]
  function demoralizationStatus(game) {
    return (game.def.demoralization || []).map((d) => ({
      name: d.name, short: d.short, faction: d.faction, army: d.army,
      lost: game.lostSP(d.faction, d.army),
      level: typeof d.level === "function" ? d.level(game) : d.level,
    }));
  }

  /* ---------------------------- buildScenario ---------------------------- */
  // Merge a battle's exclusive content over the common chassis. The scenario
  // provides: id, title, blurb, brief, map, unitTypes, factions, setup,
  // maxTurns, victory(), and optionally objectives, reinforcements,
  // demoralization, nightTurns, extra terrain, rule overrides.
  function buildScenario(def) {
    // The result application, sticky ZOC, mandatory combat, advances,
    // displacement, night turns and hexside terrain are the engine's
    // built-in behavior; only series data is layered on here.
    const rules = Object.assign({}, def.rules || {});
    return Object.assign(
      {
        orientation: "pointy",
        offsetMode: "odd-r",
        phases: ["move", "combat"],
        crt: CRT,
      },
      def,
      {
        naw: true, // lets the UI switch on the series' extra affordances
        rules,
        terrain: Object.assign({}, terrain, def.terrain || {}),
      }
    );
  }

  global.NAW_COMMON = {
    CRT, columnLabel, terrain, unit,
    demoralizationVictory, demoralizationStatus, buildScenario,
  };
})(typeof window !== "undefined" ? window : globalThis);
