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

   What the common rules say (implemented via engine flags + hooks below):
   - Alternating player-turns of Movement Phase then Combat Phase; night
     game-turns omit the Combat Phase.
   - Entering an enemy Zone of Control (the six adjacent hexes) stops
     movement, and a unit that STARTS its Movement Phase in an enemy ZOC may
     not move at all (flag `lockedZOC`).
   - Combat is mandatory: every enemy unit adjacent to friendly units must be
     attacked, and every friendly unit in an enemy ZOC must attack, each unit
     once per phase (flag `mandatoryCombat`). Bombardment at range is
     voluntary and never creates obligations.
   - Odds = total attacking CS vs total defending CS x terrain, rounded down
     to a CRT column; die 1-6; results Ae/Ar/Ex/Dr/De (no "no effect").
     Worse than 1-3 is an automatic Ae, better than 5-1 an automatic De.
   - Retreats are ONE hex; a unit that must retreat into an enemy ZOC, an
     occupied hex or impassable terrain is eliminated instead.
   - Advance after combat: one victorious engaged unit may occupy a hex the
     combat vacated, immediately, ignoring ZOCs (flag `advanceAfterCombat`).
   - Artillery may bombard up to two hexes away; units firing from range are
     never affected by combat results.
   - Demoralization: when an army's cumulative eliminated Strength Points
     reach its Demoralization Level the game ends at that instant and the
     other player wins.

   FIDELITY NOTE — the wiki was unreachable from this environment (network
   egress blocked), so the individual CRT cell values and the terrain chart
   below are a careful RECONSTRUCTION of the SPI system: correct in shape
   (columns, result mix, monotone in odds and die) but not guaranteed
   cell-for-cell. They are plain data — correct them here if you have the
   published chart, and every scenario inherits the fix.
   ========================================================================= */
(function (global) {
  "use strict";
  const Hex = global.Hex;

  /* ------------------------------- CRT ----------------------------------- */
  // Columns "1:4" and "6:1" are sentinels encoding the automatic bands: any
  // odds worse than 1-3 round down onto all-Ae, anything 6-1 or better lands
  // on all-De. The engine's round-down column mapping then needs no special
  // cases. Rows are die 1..6.
  const CRT = {
    columns: ["1:4", "1:3", "1:2", "1:1", "3:2", "2:1", "3:1", "4:1", "5:1", "6:1"],
    table: {
      "1:4": ["Ae", "Ae", "Ae", "Ae", "Ae", "Ae"], // auto — worse than 1-3
      "1:3": ["Ae", "Ae", "Ae", "Ar", "Ar", "Ex"],
      "1:2": ["Ae", "Ae", "Ar", "Ar", "Ex", "Ex"],
      "1:1": ["Ar", "Ar", "Ex", "Ex", "Dr", "Dr"],
      "3:2": ["Ar", "Ex", "Ex", "Dr", "Dr", "Dr"],
      "2:1": ["Ex", "Ex", "Dr", "Dr", "Dr", "De"],
      "3:1": ["Ex", "Dr", "Dr", "Dr", "De", "De"],
      "4:1": ["Dr", "Dr", "Dr", "De", "De", "De"],
      "5:1": ["Dr", "Dr", "De", "De", "De", "De"],
      "6:1": ["De", "De", "De", "De", "De", "De"], // auto — better than 5-1
    },
  };

  // Human label for a CRT column ("3:1" -> "3-1", sentinels explained).
  function columnLabel(col) {
    if (col === "1:4") return "worse than 1-3 (auto Ae)";
    if (col === "6:1") return "better than 5-1 (auto De)";
    return col.replace(":", "-");
  }

  /* --------------------------- combat results ---------------------------- */
  // NAW result application. Differences from the engine default: retreats are
  // ONE hex and strict (no legal hex, or only hexes in an enemy ZOC, means
  // elimination — for retreating attackers too), and Ae eliminates EVERY
  // engaged attacker, not just the weakest. Units firing from range (the
  // bombardment rule) are exempt from all attacker results, which is why
  // everything below acts on `engaged` (adjacent) units only.
  // Simplifications, documented: the retreat hex and the Exchange losses are
  // auto-picked (farthest-from-threat / weakest-first) instead of chosen by
  // the owning player.
  function applyResult(game, code, defenders, attackers) {
    defenders = Array.isArray(defenders) ? defenders : [defenders];
    const engaged = attackers.filter((a) => defenders.some((d) => Hex.distance(a, d) === 1));
    const threat = engaged[0] || attackers[0];
    const kill = (u) => { u.alive = false; };
    switch (code) {
      case "De":
        defenders.forEach(kill);
        return "Defender eliminated";
      case "Dr": {
        let trapped = false;
        for (const d of defenders) {
          if (!game.retreat(d, threat, 1, true)) { kill(d); trapped = true; }
        }
        return trapped ? "No retreat possible — defender eliminated" : "Defender retreats";
      }
      case "Ex": {
        defenders.forEach(kill);
        let need = defenders.reduce((s, d) => s + game.combat(d), 0);
        for (const a of engaged.slice().sort((x, y) => game.combat(x) - game.combat(y))) {
          if (need <= 0) break;
          kill(a); need -= game.combat(a);
        }
        return "Exchange — losses on both sides";
      }
      case "Ar": {
        if (!engaged.length) return "Bombardment driven off — guns unharmed";
        let lost = false;
        for (const a of engaged) {
          if (!game.retreat(a, defenders[0], 1, true)) { kill(a); lost = true; }
        }
        return lost ? "Attackers repulsed — the trapped are lost" : "Attackers retreat";
      }
      case "Ae":
        if (!engaged.length) return "Bombardment repulsed — no losses at range";
        engaged.forEach(kill);
        return "Attack shattered — engaged attackers eliminated";
    }
    return "";
  }

  /* ------------------------- common terrain chart ------------------------ */
  // The series' standard terrain (reconstruction — see FIDELITY NOTE above).
  // moveCost = MPs to ENTER; defMult = defender strength multiplier.
  // Scenarios may add codes or override any of these.
  const terrain = {
    ".": { name: "Clear",   color: "#cfe3b8", moveCost: 1, defMult: 1 },
    "w": { name: "Woods",   color: "#5a8f4e", moveCost: 2, defMult: 2 },
    "h": { name: "Slope",   color: "#c9a36a", moveCost: 2, defMult: 2 },
    "t": { name: "Town",    color: "#b9b2a6", moveCost: 1, defMult: 2 },
    "c": { name: "Chateau", color: "#9a8f9c", moveCost: 1, defMult: 3 },
    "m": { name: "Marsh",   color: "#8f9b6a", moveCost: 3, defMult: 1 },
    "=": { name: "Ford",    color: "#a89468", moveCost: 2, defMult: 1 },
    "~": { name: "River",   color: "#4a7fa8", moveCost: Infinity, defMult: 1,
           passable: false },
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
    const rules = Object.assign({
      lockedZOC: true,
      mandatoryCombat: true,
      advanceAfterCombat: true,
      applyResult,
    }, def.rules || {});
    if (def.nightTurns && !rules.skipPhase) {
      rules.skipPhase = (game, phase) =>
        phase === "combat" && def.nightTurns.includes(game.turn);
    }
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
    CRT, columnLabel, applyResult, terrain, unit,
    demoralizationVictory, demoralizationStatus, buildScenario,
  };
})(typeof window !== "undefined" ? window : globalThis);
