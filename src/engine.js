/* =========================================================================
   engine.js — Reusable hex WARGAME engine (rules, turns, movement, combat).
   Game-agnostic and DOM-free, so it runs headless (tests) or under any UI.
   You describe a game with a GameDef object; the engine runs it.
   Exposed as the global `HexWar`. Depends on `Hex` (hex.js).
   ========================================================================= */
(function (global) {
  "use strict";
  const Hex = global.Hex;

  /* ------------------------------ helpers -------------------------------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function makeEmitter() {
    const map = {};
    return {
      on(ev, cb) { (map[ev] || (map[ev] = [])).push(cb); return this; },
      emit(ev, payload) { (map[ev] || []).forEach((cb) => cb(payload)); },
    };
  }

  /* ------------------------------ GameDef -------------------------------
     {
       orientation, offsetMode,               // geometry
       terrain:   { code: {name,color,moveCost,defMult,passable?} },
       unitTypes: { key:  {name,glyph,combat,move,range?, ...custom} },  // range defaults to 1
       factions:  [{ id,name,short,color,dark }],
       map:       ["...rows of terrain codes..."],
       hexsides:  [{ type: "river"|"bridge"|"stream"|"slope"|"road"|"trail",
                     pairs: [[[c,r],[c,r]], ...] }],   // optional edge features
       objectives:[{col,row,owner}] (optional, for victory helpers),
       setup:     [{ faction, army?, units:[[col,row,typeKey], ...] }],
       reinforcements: [{ turn|turnFor(game)->turn|null, faction, army?,
                          entry:[[col,row],...],
                          units:["typeKey", ...] }],   // optional, scheduled arrivals
       demoralization: { armyOrFactionId: level },     // optional, read by victory()
       exitHexes: { faction, target, hexes:[[col,row],...] }, // optional map exit
       variants:  { roll(game) -> plainJSON },  // optional pre-game random codes
       nightTurns:[n, ...],                   // optional: no combat, no ZOC entry
       phases:    ["move","combat"],          // per-faction, in order
       maxTurns:  number,
       crt:       { "columns":[...], table:{col:[6 results]} },   // REQUIRED
       rules:     {  (all optional function hooks — NAW defaults provided)
         stepCost(game,unit,fromHex,toHex), canStandOn(game,unit,hex),
         isZOC(game,side,hex), attackerStrength(game,atkList),
         defenderStrength(game,def,hex), oddsColumn(game,atk,def),
         rollDie(game)->1..6, applyResult(game,code,defenders,atkList),
         skipPhase(game,phaseName)->bool,     // e.g. night turns skip "combat"
       },
       victory(game) -> { winner, reason } | null,
     }

     The engine's built-in behavior IS the Napoleon at War common ruleset:
     sticky Zones of Control (a unit starting its Movement Phase in an enemy
     ZOC may not move), mandatory combat with endPhase gating, one-hex strict
     retreats, advance after combat, bombardment immunity at range. There is
     no legacy fallback — scenarios shape behavior through the hooks above
     and their own crt/terrain data.
  ------------------------------------------------------------------------ */

  const RESULT_CODES = ["Ae", "Ar", "Ex", "Dr", "De"];

  // Canonical key for the edge between two hexes (order-independent).
  const edgeKey = (a, b) => {
    const ka = Hex.key(a.q, a.r), kb = Hex.key(b.q, b.r);
    return ka < kb ? ka + "|" + kb : kb + "|" + ka;
  };

  class Game {
    constructor(def) {
      if (!def.crt || !def.crt.columns || !def.crt.table)
        throw new Error("GameDef needs a crt ({columns, table}) — see NAW_COMMON.CRT");
      this.def = def;
      this.orientation = def.orientation || "pointy";
      this.offsetMode = def.offsetMode || "odd-r";
      this.terrain = def.terrain;
      this.unitTypes = def.unitTypes;
      this.factions = def.factions;
      this.phases = def.phases || ["move", "combat"];
      this.maxTurns = def.maxTurns || 10;
      this.events = makeEmitter();
      this.rng = Math.random; // injectable for deterministic tests
      this.reset();
    }

    /* ------------------------------- setup ------------------------------- */
    reset() {
      // Board: key -> {q,r,terrain,col,row}
      this.board = new Map();
      const rows = this.def.map;
      for (let row = 0; row < rows.length; row++) {
        const line = rows[row];
        for (let col = 0; col < line.length; col++) {
          const code = line[col];
          if (code === " ") continue; // allow ragged maps
          const a = Hex.offsetToAxial(col, row, this.offsetMode);
          this.board.set(Hex.key(a.q, a.r), { q: a.q, r: a.r, terrain: code, col, row });
        }
      }
      // Hexside features: edge key -> type [5.22-5.26]
      this.edges = new Map();
      for (const grp of (this.def.hexsides || [])) {
        for (const [p1, p2] of grp.pairs) {
          const a = Hex.offsetToAxial(p1[0], p1[1], this.offsetMode);
          const b = Hex.offsetToAxial(p2[0], p2[1], this.offsetMode);
          this.edges.set(edgeKey(a, b), grp.type);
        }
      }
      // Objectives
      this.objectives = (this.def.objectives || []).map((o) => {
        const a = Hex.offsetToAxial(o.col, o.row, this.offsetMode);
        return { key: Hex.key(a.q, a.r), q: a.q, r: a.r, owner: o.owner };
      });
      // Map-exit hexes (a scenario victory condition, e.g. marching off north)
      this.exitKeys = new Set((this.def.exitHexes ? this.def.exitHexes.hexes : [])
        .map(([c, r]) => { const a = Hex.offsetToAxial(c, r, this.offsetMode); return Hex.key(a.q, a.r); }));
      // Units. Reinforcements are created up front too (entered:false, held
      // off-map) so unit ids and counts are stable for save/restore.
      this.units = [];
      let id = 0;
      for (const grp of this.def.setup) {
        for (const u of grp.units) {
          const a = Hex.offsetToAxial(u[0], u[1], this.offsetMode);
          this.units.push({
            id: id++, faction: grp.faction, army: grp.army, type: u[2],
            q: a.q, r: a.r, alive: true, moved: false, acted: false,
            entered: true, locked: false, freshArrival: false,
          });
        }
      }
      (this.def.reinforcements || []).forEach((grp, gi) => {
        for (const type of grp.units) {
          const e = grp.entry[0];
          const a = Hex.offsetToAxial(e[0], e[1], this.offsetMode);
          this.units.push({
            id: id++, faction: grp.faction, army: grp.army, type,
            q: a.q, r: a.r, alive: true, moved: false, acted: false,
            entered: false, locked: false, freshArrival: false, rgroup: gi,
          });
        }
      });
      // Pre-game variant codes (e.g. secret reinforcement schedules)
      this.variant = this.def.variants ? this.def.variants.roll(this) : null;
      this.scenarioState = null; // optional scenario-owned JSON blob (persisted)
      // Turn state
      this.turn = 1;
      this.sideIndex = 0;             // index into factions[] whose turn it is
      this.phaseIndex = 0;
      this.over = false;
      this.winner = null;
      this.pendingAdvance = null;     // {hexes:[{q,r}], faction, unitIds} while a
                                      // post-combat advance awaits a decision
      this.attackedIds = new Set();       // defenders already fought this phase
      this.mustAttackIds = new Set();     // mandatory-combat obligations,
      this.mustBeAttackedIds = new Set(); // computed at combat-phase entry
      this._enterPhase();
    }

    /* ------------------------------ queries ------------------------------ */
    get activeFaction() { return this.factions[this.sideIndex].id; }
    get phase() { return this.phases[this.phaseIndex]; }
    hex(q, r) { return this.board.get(Hex.key(q, r)); }
    terrainAt(q, r) { const h = this.hex(q, r); return h ? this.terrain[h.terrain] : null; }
    typeOf(u) { return this.unitTypes[u.type]; }
    // A unit that exists on the board right now (reinforcements not yet
    // entered are alive but invisible to every board query).
    onMap(u) { return u.alive && u.entered !== false; }
    unitAt(q, r) { return this.units.find((u) => this.onMap(u) && u.q === q && u.r === r); }
    living(faction) { return this.units.filter((u) => this.onMap(u) && u.faction === faction); }
    enemiesOf(faction) { return this.units.filter((u) => this.onMap(u) && u.faction !== faction); }
    isObjective(q, r) { return this.objectives.some((o) => o.q === q && o.r === r); }

    combat(u) { return this.typeOf(u).combat; }
    move(u) { return this.typeOf(u).move; }
    range(u) { return this.typeOf(u).range || 1; }
    edgeBetween(a, b) { return this.edges.get(edgeKey(a, b)); }
    // Melee contact: adjacency, except through an unbridged river hexside —
    // no ZOC [6.6] and no normal combat [8.45] ever cross one.
    meleeAdjacent(a, b) {
      return Hex.distance(a, b) === 1 && this.edgeBetween(a, b) !== "river";
    }
    // Tinted game-turns: no Combat Phase [10.1], no entering enemy ZOC [10.2].
    isNight(turn) { return !!(this.def.nightTurns || []).includes(turn == null ? this.turn : turn); }
    // Bombardment Line of Sight [8.3]: for a two-hex shot the intervening
    // hexes are the common neighbors of firer and target — one hex on a
    // straight line, two when the line runs along a hexside, in which case
    // BOTH must block to spoil the shot [8.32]. Firer/target hexes and
    // units never block [8.34/8.35]. Terrain with `losBlock` blocks [8.33].
    lineOfSight(from, to) {
      if (Hex.distance(from, to) <= 1) return true;
      const nbTo = new Set(Hex.neighbors(to).map((n) => Hex.key(n.q, n.r)));
      const between = Hex.neighbors(from).filter((n) => nbTo.has(Hex.key(n.q, n.r)));
      const blocks = (n) => {
        const t = this.terrainAt(n.q, n.r);
        return !!(t && t.losBlock);
      };
      if (between.length === 0) return true;
      if (between.length === 1) return !blocks(between[0]);
      return !(blocks(between[0]) && blocks(between[1]));
    }

    // Cumulative eliminated Strength Points — derived, nothing to serialize.
    // `army` narrows to a tagged army within the faction (e.g. Prussians).
    // Units that marched off the map are NOT destroyed and never count.
    lostSP(faction, army) {
      return this.units
        .filter((u) => !u.alive && u.faction === faction && (army == null || u.army === army))
        .reduce((s, u) => s + this.combat(u), 0);
    }

    /* ----------------------------- map exit ------------------------------- */
    // Some scenarios let one side win by marching units off designated edge
    // hexes during its own Movement Phases. Exited units are alive but gone.
    isExitHex(q, r) { return this.exitKeys.has(Hex.key(q, r)); }
    exitedCount(faction) {
      return this.units.filter((u) => u.exited && u.faction === faction).length;
    }
    canExit(unit) {
      const ex = this.def.exitHexes;
      return !!ex && this.phase === "move" && unit.faction === this.activeFaction &&
        unit.faction === ex.faction && this.onMap(unit) &&
        !unit.locked && this.isExitHex(unit.q, unit.r);
    }
    exitUnit(unit) {
      if (!this.canExit(unit)) return { ok: false, reason: "cannot exit here" };
      this.moveLog = this.moveLog.filter((m) => m.unit !== unit);
      unit.exited = true;
      unit.entered = false; // off the map: no ZOC, no queries, but not destroyed
      this.events.emit("exit", { unit, count: this.exitedCount(unit.faction) });
      this._checkVictory();
      return { ok: true };
    }

    /* ------------------------------- rules ------------------------------- */
    // Default rule implementations; a GameDef may override any via def.rules.
    _rule(name, fallback) {
      const r = this.def.rules || {};
      return r[name] ? r[name].bind(null) : fallback;
    }

    // Zone of Control: a hex is in `faction`'s enemies' ZOC if adjacent to an
    // enemy unit — but ZOC never extends through an unbridged river hexside [6.6].
    isEnemyZOC(faction, q, r) {
      const custom = (this.def.rules || {}).isZOC;
      if (custom) return custom(this, faction, { q, r });
      for (const nb of Hex.neighbors({ q, r })) {
        if (this.edgeBetween({ q, r }, nb) === "river") continue;
        const u = this.unitAt(nb.q, nb.r);
        if (u && u.faction !== faction) return true;
      }
      return false;
    }

    stepCost(unit, fromHex, toHex) {
      const custom = (this.def.rules || {}).stepCost;
      if (custom) return custom(this, unit, fromHex, toHex);
      const t = this.terrainAt(toHex.q, toHex.r);
      if (!t || t.passable === false) return Infinity;
      const edge = this.edgeBetween(fromHex, toHex);
      if (edge === "river") return Infinity; // crossable only at bridges [5.24]
      // Woods-Road hexes may be entered or exited only through a hexside
      // crossed by a road (Terrain Key).
      const ft0 = this.terrainAt(fromHex.q, fromHex.r);
      if (((ft0 && ft0.roadOnly) || t.roadOnly) && edge !== "road") return Infinity;
      if (edge === "road") return 0.5;       // regardless of terrain [5.22]
      if (edge === "trail") return 1;        // regardless of terrain [5.23]
      let cost = t.moveCost;                 // bridge: no surcharge [5.24]
      if (edge === "stream") cost += 2;      // [5.25]
      if (edge === "slope") {                // +1 leaving a slope hex downhill [5.26]
        const ft = this.terrainAt(fromHex.q, fromHex.r);
        if (ft && ft.slope && !t.slope) cost += 1;
      }
      return cost;
    }

    canStandOn(unit, hex) {
      const custom = (this.def.rules || {}).canStandOn;
      if (custom) return custom(this, unit, hex);
      const t = this.terrain[hex.terrain];
      if (!t || t.passable === false) return false;
      const occ = this.unitAt(hex.q, hex.r);
      return !occ; // one unit per hex
    }

    /* ----------------------------- movement ------------------------------ */
    reachable(unit) {
      const faction = unit.faction;
      const night = this.isNight();
      // A freshly arrived reinforcement has already paid 1 MP for its entry hex.
      const budget = this.move(unit) - (unit.freshArrival ? 1 : 0);
      const reach = Hex.reachable({
        start: { q: unit.q, r: unit.r },
        budget,
        neighborsOf: (h) => Hex.neighbors(h).filter((n) => this.board.has(Hex.key(n.q, n.r))),
        stepCost: (from, to) => {
          const occ = this.unitAt(to.q, to.r);
          if (occ && occ.faction !== faction) return Infinity; // never enter enemy hexes [5.12]
          // friendly-occupied hexes are passed through at normal cost [5.31/5.33]
          if (night && this.isEnemyZOC(faction, to.q, to.r)) return Infinity; // [10.2]
          return this.stepCost(unit, this.hex(from.q, from.r), this.hex(to.q, to.r));
        },
        blocked: (h) => !this.board.has(Hex.key(h.q, h.r)),
        stopAt: (h) => this.isEnemyZOC(faction, h.q, h.r), // ZOC halts movement [6.0]
      });
      // A unit may end a phase only in an empty hex [5.32] — occupied hexes
      // were path, not destination.
      for (const [k, cell] of reach) {
        if (this.unitAt(cell.q, cell.r)) reach.delete(k);
      }
      return reach;
    }

    canMove(unit) {
      return this.phase === "move" && unit.faction === this.activeFaction &&
        this.onMap(unit) && !unit.moved && !unit.locked;
    }

    moveUnit(unit, q, r) {
      if (!this.canMove(unit)) return { ok: false, reason: "cannot move now" };
      const reach = this.reachable(unit);
      const target = reach.get(Hex.key(q, r));
      if (!target) return { ok: false, reason: "unreachable" };
      this.moveLog.push({ unit, fromQ: unit.q, fromR: unit.r }); // for undo
      unit.q = q; unit.r = r; unit.moved = true;
      this.events.emit("move", { unit });
      return { ok: true };
    }

    // Undo the most recent move of the current Movement phase. Returns the
    // restored unit, or null if there is nothing to undo.
    canUndo() { return this.phase === "move" && this.moveLog.length > 0; }
    undoMove() {
      if (!this.canUndo()) return null;
      const last = this.moveLog.pop();
      last.unit.q = last.fromQ; last.unit.r = last.fromR; last.unit.moved = false;
      this.events.emit("undo", { unit: last.unit });
      return last.unit;
    }

    /* ------------------------------ combat ------------------------------- */
    // All active-faction units that could attack `defender` this phase:
    // melee contact at distance 1 (never across an unbridged river [8.45]),
    // or bombardment within range — which requires a clear Line of Sight
    // [8.3] and a firing unit NOT in an enemy ZOC [8.41]. A gun adjacent
    // only across a river still fires per the bombardment rules [8.45].
    attackersFor(defender) {
      return this.units.filter((u) => {
        if (!this.onMap(u) || u.faction !== this.activeFaction || u.acted) return false;
        const d = Hex.distance(u, defender);
        if (d < 1 || d > Math.max(1, this.range(u))) return false;
        if (this.meleeAdjacent(u, defender)) return true;
        if (this.range(u) < 2) return false; // river-adjacent foot may not fight across
        if (this.isEnemyZOC(u.faction, u.q, u.r)) return false;   // [8.41]
        return this.lineOfSight(u, defender);                     // [8.3]
      });
    }

    attackerStrength(list) {
      const custom = (this.def.rules || {}).attackerStrength;
      if (custom) return custom(this, list);
      return list.reduce((s, u) => s + this.combat(u), 0);
    }

    defenderStrength(def) {
      const custom = (this.def.rules || {}).defenderStrength;
      const hex = this.hex(def.q, def.r);
      if (custom) return custom(this, def, hex);
      const t = this.terrain[hex.terrain];
      return this.combat(def) * (t.defMult || 1);
    }

    oddsColumn(atk, def) {
      const custom = (this.def.rules || {}).oddsColumn;
      if (custom) return custom(this, atk, def);
      const cols = this.def.crt.columns;
      const ratio = atk / def;
      // Map ratio to the nearest defined column, rounding down.
      // Columns are labelled "a:b"; compute numeric value and pick highest not exceeding ratio.
      let chosen = cols[0];
      for (const c of cols) {
        const [a, b] = c.split(":").map(Number);
        if (ratio + 1e-9 >= a / b) chosen = c;
      }
      // Below the weakest column, still use the weakest.
      return chosen;
    }

    rollDie() {
      const custom = (this.def.rules || {}).rollDie;
      if (custom) return custom(this);
      return 1 + Math.floor(this.rng() * 6);
    }

    // Retreat `unit` one hex so it is no longer enemy-controlled [7.71].
    // Legal hexes: on-map, passable, not across a prohibited hexside, not in
    // an enemy ZOC and never enemy-occupied [7.72]. Vacant hexes come first
    // [7.73] (auto-picked farthest from the threat — a documented
    // simplification of owner choice); with no vacant hex the unit DISPLACES
    // a friendly occupant, which retreats in turn — chains allowed [7.8]. If
    // nobody can be placed, returns false and the caller eliminates the
    // RETREATER, never the displaced units [7.82/7.72]. A displaced
    // artillery unit that has not fought loses its fire for the phase [7.82].
    retreat(unit, threat, _depth) {
      const depth = _depth || 0;
      if (depth > 8) return false; // chain sanity bound
      const from = this.hex(unit.q, unit.r);
      const options = [];
      for (const nb of Hex.neighbors(unit)) {
        const h = this.hex(nb.q, nb.r);
        if (!h) continue;
        // prohibited hexes and hexsides bind retreats exactly like movement
        // (impassable terrain, rivers, road-bound Woods-Road hexes) [7.72]
        if (!Number.isFinite(this.stepCost(unit, from, h))) continue;
        if (this.isEnemyZOC(unit.faction, nb.q, nb.r)) continue;   // [7.71/7.72]
        const occ = this.unitAt(nb.q, nb.r);
        if (occ && occ.faction !== unit.faction) continue;         // [5.12]
        options.push({ nb, occ });
      }
      const byDist = (a, b) => Hex.distance(b.nb, threat) - Hex.distance(a.nb, threat);
      const vacant = options.filter((o) => !o.occ).sort(byDist);
      if (vacant.length) {
        unit.q = vacant[0].nb.q; unit.r = vacant[0].nb.r;
        return true;
      }
      // Displacement — only when no vacant path exists [7.81].
      for (const o of options.filter((x) => x.occ).sort(byDist)) {
        const saved = { q: o.occ.q, r: o.occ.r };
        if (this.retreat(o.occ, threat, depth + 1)) {
          unit.q = o.nb.q; unit.r = o.nb.r;
          if (this.phase === "combat" && this.range(o.occ) > 1 && !o.occ.acted) {
            o.occ.acted = true; // displaced artillery may not fire this phase [7.82]
          }
          return true;
        }
        o.occ.q = saved.q; o.occ.r = saved.r; // failed chain: roll back
      }
      return false;
    }

    // Result application — the Napoleon at War semantics. `defenders` may
    // hold several units (attacked as one combined battle); results hit
    // every one of them. Retreats are ONE hex and strict: a unit whose only
    // exits are enemy-ZOC, occupied or impassable hexes is eliminated —
    // attackers included. Only ENGAGED (adjacent) attackers ever pay;
    // bombarding units at range are immune to every result.
    // Documented simplifications: the retreat hex and the Exchange losses
    // are auto-picked (farthest-from-threat / weakest-first) instead of
    // chosen by the owning player. Override via rules.applyResult.
    applyResult(code, defenders, attackers) {
      defenders = Array.isArray(defenders) ? defenders : [defenders];
      const custom = (this.def.rules || {}).applyResult;
      if (custom) return custom(this, code, defenders, attackers);
      const engaged = attackers.filter((a) => defenders.some((d) => this.meleeAdjacent(a, d)));
      const threat = engaged[0] || attackers[0];
      const kill = (u) => { u.alive = false; };
      switch (code) {
        case "De":
          defenders.forEach(kill);
          return "Defender eliminated";
        case "Dr": {
          let trapped = false;
          for (const d of defenders) {
            if (!this.retreat(d, threat)) { kill(d); trapped = true; }
          }
          return trapped ? "No retreat possible — defender eliminated" : "Defender retreats";
        }
        case "Ex": {
          defenders.forEach(kill);
          let need = defenders.reduce((s, d) => s + this.combat(d), 0);
          for (const a of engaged.slice().sort((x, y) => this.combat(x) - this.combat(y))) {
            if (need <= 0) break;
            kill(a); need -= this.combat(a);
          }
          return "Exchange — losses on both sides";
        }
        case "Ar": {
          if (!engaged.length) return "Bombardment driven off — guns unharmed";
          let lost = false;
          for (const a of engaged) {
            if (!this.retreat(a, defenders[0])) { kill(a); lost = true; }
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

    // Resolve an attack on `defenders` (a unit or an array of units fought as
    // one combined battle). Attackers auto-gathered unless supplied.
    // opts.lower: the attacker may deliberately fight at a LOWER combat
    // ratio, announced before the roll [6.2]; the column steps down the CRT,
    // never up.
    resolveCombat(defenders, attackers, opts) {
      if (this.phase !== "combat") return { ok: false, reason: "not combat phase" };
      if (this.pendingAdvance) return { ok: false, reason: "advance pending" };
      defenders = Array.isArray(defenders) ? defenders.slice() : [defenders];
      if (!defenders.length) return { ok: false, reason: "no defenders" };
      for (const d of defenders) {
        if (!this.onMap(d) || d.faction === this.activeFaction)
          return { ok: false, reason: "invalid defender" };
        if (this.attackedIds.has(d.id))
          return { ok: false, reason: "already attacked this phase" };
      }
      const explicit = !!attackers;
      if (!attackers) {
        attackers = [];
        for (const d of defenders)
          for (const a of this.attackersFor(d))
            if (!attackers.includes(a)) attackers.push(a);
      }
      if (!attackers.length) return { ok: false, reason: "no eligible attackers" };
      if (explicit) {
        for (const a of attackers) {
          if (!this.onMap(a) || a.faction !== this.activeFaction || a.acted)
            return { ok: false, reason: "invalid attacker" };
          // Melee contact with any defender qualifies; otherwise the unit is
          // bombarding and needs range + LOS to at least one defending hex
          // [8.22], from outside any enemy ZOC [8.41].
          if (!defenders.some((d) => this.meleeAdjacent(a, d))) {
            if (this.isEnemyZOC(a.faction, a.q, a.r))
              return { ok: false, reason: "artillery in an enemy ZOC may not bombard" };
            const canFire = defenders.some((d) =>
              Hex.distance(a, d) <= this.range(a) && this.lineOfSight(a, d));
            if (!canFire) return { ok: false, reason: "no range or line of sight" };
          }
        }
      }
      // In a combined battle every defender must be engaged by an adjacent
      // attacker [7.21]; only a single-defender battle may be a pure
      // bombardment [8.13].
      if (defenders.length > 1) {
        for (const d of defenders) {
          if (!attackers.some((a) => this.meleeAdjacent(a, d)))
            return { ok: false, reason: "defender not engaged" };
        }
      }
      const atk = this.attackerStrength(attackers);
      const def = defenders.reduce((s, d) => s + this.defenderStrength(d), 0);
      let column = this.oddsColumn(atk, def);
      const lower = opts && opts.lower ? Math.max(0, Math.floor(opts.lower)) : 0;
      if (lower) {
        const cols = this.def.crt.columns;
        column = cols[Math.max(0, cols.indexOf(column) - lower)];
      }
      const die = this.rollDie();
      const code = this.def.crt.table[column][die - 1];
      const defHexes = defenders.map((d) => ({ q: d.q, r: d.r }));
      const atkHexes = attackers.map((a) => ({ q: a.q, r: a.r }));
      const note = this.applyResult(code, defenders, attackers);
      attackers.forEach((a) => { if (a.alive) a.acted = true; });
      defenders.forEach((d) => this.attackedIds.add(d.id));
      // Advance after combat [7.74/7.75]: whenever a hex is vacated by the
      // combat, ONE victorious participating unit may claim it, immediately.
      // Defender hexes vacated -> an engaged attacker advances; attacker
      // hexes vacated (Ar/Ae) -> a surviving DEFENDER may advance instead.
      let advance = null;
      {
        const empty = (h) => !this.unitAt(h.q, h.r);
        let hexes = defHexes.filter(empty);
        let side = this.activeFaction;
        let winners = attackers;
        if (!hexes.length) {
          hexes = atkHexes.filter(empty);
          side = defenders[0].faction;
          winners = defenders;
        }
        const unitIds = winners
          .filter((u) => u.alive && hexes.some((h) => this.meleeAdjacent(u, h)))
          .map((u) => u.id);
        if (hexes.length && unitIds.length) {
          this.pendingAdvance = { hexes, faction: side, unitIds };
          advance = { hexes, faction: side, candidates: unitIds.map((i) => this.units[i]) };
        }
      }
      const result = { ok: true, attackers, defenders, defender: defenders[0],
                       atk, def, column, die, code, note, advance };
      this.events.emit("combat", result);
      if (this._checkVictory()) { this.pendingAdvance = null; result.advance = null; }
      return result;
    }

    // Move one eligible unit into a hex vacated by the combat just resolved.
    // Costs no MPs and ignores Zones of Control (per the advance rule).
    advanceAfterCombat(unit, q, r) {
      const p = this.pendingAdvance;
      if (!p) return { ok: false, reason: "no advance pending" };
      if (!unit || !p.unitIds.includes(unit.id) || !this.onMap(unit))
        return { ok: false, reason: "unit not eligible" };
      const hx = (q == null && p.hexes.length === 1)
        ? p.hexes[0]
        : p.hexes.find((h) => h.q === q && h.r === r);
      if (!hx) return { ok: false, reason: "not a vacated hex" };
      if (this.unitAt(hx.q, hx.r)) return { ok: false, reason: "hex occupied" };
      if (!this.meleeAdjacent(unit, hx)) return { ok: false, reason: "unit not adjacent" };
      // The step itself must be crossable (no rivers, no road-bound woods
      // without the road) — advances ignore only ZOCs [7.74].
      if (!Number.isFinite(this.stepCost(unit, this.hex(unit.q, unit.r), this.hex(hx.q, hx.r))))
        return { ok: false, reason: "hexside prohibited" };
      unit.q = hx.q; unit.r = hx.r;
      this.pendingAdvance = null;
      this.events.emit("advance", { unit });
      return { ok: true };
    }

    declineAdvance() {
      if (!this.pendingAdvance) return { ok: false, reason: "no advance pending" };
      this.pendingAdvance = null;
      this.events.emit("advance", { unit: null });
      return { ok: true };
    }

    /* ------------------------ mandatory combat --------------------------- */
    // Obligations fixed by positions at the start of the Combat Phase:
    // every phasing unit adjacent to an enemy must attack; every enemy unit
    // adjacent to a phasing unit must be attacked. (Bombardment range does
    // not create obligations — only adjacency does.)
    _computeObligations() {
      this.mustAttackIds = new Set();
      this.mustBeAttackedIds = new Set();
      const faction = this.activeFaction;
      for (const u of this.living(faction)) {
        for (const nb of Hex.neighbors(u)) {
          if (!this.meleeAdjacent(u, nb)) continue; // no contact across rivers [6.6]
          const e = this.unitAt(nb.q, nb.r);
          if (e && e.faction !== faction) {
            this.mustAttackIds.add(u.id);
            this.mustBeAttackedIds.add(e.id);
          }
        }
      }
    }

    // Obligations still unsatisfied AND still satisfiable. Obligations the
    // player's own groupings/results have made impossible are excused, so the
    // phase can never deadlock; anything still fightable must be fought.
    unresolvedCombat() {
      const mustAttack = [], mustBeAttacked = [];
      if (this.phase !== "combat") return { mustAttack, mustBeAttacked };
      const faction = this.activeFaction;
      for (const id of this.mustBeAttackedIds) {
        const d = this.units[id];
        if (!this.onMap(d) || this.attackedIds.has(id)) continue;
        if (this.attackersFor(d).length) mustBeAttacked.push(d);
      }
      for (const id of this.mustAttackIds) {
        const u = this.units[id];
        if (!this.onMap(u) || u.acted) continue;
        const hasTarget = Hex.neighbors(u).some((nb) => {
          if (!this.meleeAdjacent(u, nb)) return false;
          const e = this.unitAt(nb.q, nb.r);
          return e && e.faction !== faction && !this.attackedIds.has(e.id);
        });
        if (hasTarget) mustAttack.push(u);
      }
      return { mustAttack, mustBeAttacked };
    }

    /* --------------------------- turn / phases --------------------------- */
    _enterPhase() {
      const faction = this.activeFaction;
      this.moveLog = []; // undo history is per-phase
      if (this.phase === "move") {
        this.living(faction).forEach((u) => { u.moved = false; u.freshArrival = false; });
        this._placeReinforcements(faction);
        // Sticky ZOC: a unit starting its Movement Phase in an enemy Zone of
        // Control may not move this phase.
        this.living(faction).forEach((u) => {
          u.locked = this.isEnemyZOC(faction, u.q, u.r);
        });
      }
      if (this.phase === "combat") {
        this.living(faction).forEach((u) => (u.acted = false));
        this.attackedIds = new Set();
        this._computeObligations();
      }
      this.events.emit("phase", { turn: this.turn, faction, phase: this.phase });
    }

    // Scheduled arrivals: each due unit takes the first free, passable hex in
    // its group's ordered entry list; the blocked stay off-map and retry next
    // turn. (Auto-placement approximates "enter at the nearest available hex".)
    _placeReinforcements(faction) {
      const groups = this.def.reinforcements || [];
      const placed = [];
      for (const u of this.units) {
        if (!u.alive || u.entered !== false || u.exited) continue;
        const grp = groups[u.rgroup];
        if (!grp || grp.faction !== faction) continue;
        // A variant schedule may move a group's arrival — or cancel it (null).
        const due = grp.turnFor ? grp.turnFor(this) : grp.turn;
        if (due == null || due > this.turn) continue;
        const spot = grp.entry
          .map(([c, r]) => Hex.offsetToAxial(c, r, this.offsetMode))
          .find((a) => {
            const h = this.hex(a.q, a.r);
            return h && this.terrain[h.terrain].passable !== false &&
              !this.unitAt(a.q, a.r) &&
              !this.isEnemyZOC(faction, a.q, a.r); // never into an enemy ZOC [7.2]
          });
        if (!spot) continue;
        u.q = spot.q; u.r = spot.r;
        u.entered = true; u.freshArrival = true; u.moved = false;
        placed.push(u);
      }
      if (placed.length) this.events.emit("reinforce", { faction, units: placed, turn: this.turn });
    }

    endPhase() {
      if (this.over) return { ok: false, reason: "game over" };
      if (this.pendingAdvance) return { ok: false, reason: "advance pending" };
      if (this.phase === "combat") {
        const un = this.unresolvedCombat();
        if (un.mustAttack.length || un.mustBeAttacked.length) {
          return { ok: false, reason: "mandatory battles remain", unresolved: un };
        }
      }
      if (this._checkVictory()) return { ok: true };
      const skip = (this.def.rules || {}).skipPhase;
      const skipped = () => {
        const ph = this.phases[this.phaseIndex];
        if (ph === "combat" && this.isNight()) return true; // no combat at night [10.1]
        return !!(skip && skip(this, ph));
      };
      do {
        this.phaseIndex++;
        if (this.phaseIndex >= this.phases.length) {
          // Advance to next faction, or next turn.
          this.phaseIndex = 0;
          this.sideIndex++;
          if (this.sideIndex >= this.factions.length) {
            this.sideIndex = 0;
            this.turn++;
            if (this.turn > this.maxTurns) { this._timeout(); return { ok: true }; }
          }
          this.events.emit("sideChange", { turn: this.turn, faction: this.activeFaction });
        }
      } while (skipped());
      this._enterPhase();
      return { ok: true };
    }

    /* ------------------------------ victory ------------------------------ */
    _checkVictory() {
      if (this.over) return true;
      const v = this.def.victory ? this.def.victory(this) : defaultVictory(this);
      if (v && v.winner != null) { this._end(v.winner, v.reason); return true; }
      return false;
    }
    _timeout() {
      const v = this.def.victory ? this.def.victory(this, { timeout: true }) : defaultVictory(this, { timeout: true });
      if (v && v.winner != null) this._end(v.winner, v.reason);
      else this._end(null, "Time expired — draw");
    }
    _end(winner, reason) {
      this.over = true; this.winner = winner;
      this.events.emit("gameover", { winner, reason });
    }

    snapshot() {
      return {
        turn: this.turn, faction: this.activeFaction, phase: this.phase,
        over: this.over, winner: this.winner,
        units: this.units.map(clone),
      };
    }

    /* --------------------------- save / resume --------------------------- */
    // The full mutable state as a JSON-safe object. Board and objectives are
    // derived from the def and not included; moveLog entries hold live unit
    // references, so they are stored by unit id and remapped in restore().
    serialize() {
      return {
        turn: this.turn, sideIndex: this.sideIndex, phaseIndex: this.phaseIndex,
        over: this.over, winner: this.winner,
        units: this.units.map((u) => ({
          id: u.id, faction: u.faction, type: u.type,
          q: u.q, r: u.r, alive: u.alive, moved: u.moved, acted: u.acted,
          entered: u.entered, locked: u.locked, freshArrival: u.freshArrival,
          exited: !!u.exited,
        })),
        variant: this.variant,
        scenarioState: this.scenarioState,
        moveLog: this.moveLog.map((m) => ({
          unitId: m.unit.id, fromQ: m.fromQ, fromR: m.fromR,
        })),
        attackedIds: [...this.attackedIds],
        mustAttackIds: [...this.mustAttackIds],
        mustBeAttackedIds: [...this.mustBeAttackedIds],
        pendingAdvance: this.pendingAdvance
          ? { hexes: this.pendingAdvance.hexes.map((h) => ({ q: h.q, r: h.r })),
              faction: this.pendingAdvance.faction,
              unitIds: [...this.pendingAdvance.unitIds] }
          : null,
      };
    }

    // Rebuild a Game from serialize() output. Throws on anything that does not
    // match the def — a save from an edited scenario is discarded, not played.
    // Fields introduced after a save was written default leniently.
    static restore(def, data) {
      const bad = (why) => { throw new Error("bad save: " + why); };
      if (!data || typeof data !== "object") bad("not an object");

      // The constructor's _enterPhase() emits into an emitter that has no
      // listeners yet, so it is unobservable; everything it touches is
      // overwritten below. Reusing it keeps board/unit setup in one place.
      const g = new Game(def);

      if (!Number.isInteger(data.turn) || data.turn < 1 || data.turn > g.maxTurns) bad("turn");
      if (!Number.isInteger(data.sideIndex) || data.sideIndex < 0 || data.sideIndex >= g.factions.length) bad("sideIndex");
      if (!Number.isInteger(data.phaseIndex) || data.phaseIndex < 0 || data.phaseIndex >= g.phases.length) bad("phaseIndex");
      if (!Array.isArray(data.units) || data.units.length !== g.units.length) bad("unit count");

      // Unit ids are assigned in def.setup order, so g.units[id] is the same
      // soldier the save knew — as long as faction and type still agree.
      const seen = new Set();
      for (const su of data.units) {
        const u = g.units[su.id];
        if (!u || u.id !== su.id || seen.has(su.id)) bad("unit id " + su.id);
        seen.add(su.id);
        if (u.faction !== su.faction || u.type !== su.type) bad("unit identity " + su.id);
        if (su.alive && su.entered !== false && !g.hex(su.q, su.r)) bad("unit off board " + su.id);
        if (su.exited && su.entered !== false) bad("exited unit still on map " + su.id);
        if (su.entered === false && !su.exited && (su.moved || su.acted)) bad("unentered unit acted " + su.id);
      }
      if (!Array.isArray(data.moveLog)) bad("moveLog");
      for (const m of data.moveLog) {
        if (!g.units[m.unitId]) bad("moveLog unit " + m.unitId);
      }
      const idSet = (arr, what) => {
        const s = new Set();
        for (const id of arr || []) {
          if (!g.units[id]) bad(what + " unit " + id);
          s.add(id);
        }
        return s;
      };

      for (const su of data.units) {
        const u = g.units[su.id];
        u.q = su.q; u.r = su.r;
        u.alive = !!su.alive; u.moved = !!su.moved; u.acted = !!su.acted;
        u.entered = su.entered !== false; // absent in old saves -> on-map
        u.locked = !!su.locked;
        u.freshArrival = !!su.freshArrival;
        u.exited = !!su.exited;
      }
      g.variant = data.variant != null ? data.variant : g.variant;
      g.scenarioState = data.scenarioState != null ? data.scenarioState : null;
      g.turn = data.turn;
      g.sideIndex = data.sideIndex;
      g.phaseIndex = data.phaseIndex;
      g.over = !!data.over;
      g.winner = data.winner != null ? data.winner : null;
      // Remap the undo log back to live references. Do NOT run _enterPhase():
      // it would clear this log, reset the active side's mid-phase flags and
      // emit a phantom "phase" event.
      g.moveLog = data.moveLog.map((m) => ({
        unit: g.units[m.unitId], fromQ: m.fromQ, fromR: m.fromR,
      }));
      g.attackedIds = idSet(data.attackedIds, "attacked");
      g.mustAttackIds = idSet(data.mustAttackIds, "mustAttack");
      g.mustBeAttackedIds = idSet(data.mustBeAttackedIds, "mustBeAttacked");
      // A pre-feature save restored mid-combat-phase has no obligation sets;
      // recompute them from current positions (lenient, slightly forgiving).
      if (data.mustAttackIds == null && g.phase === "combat") g._computeObligations();
      if (data.pendingAdvance) {
        const p = data.pendingAdvance;
        if (!Array.isArray(p.hexes) || !p.hexes.length || !Array.isArray(p.unitIds)) bad("pendingAdvance");
        for (const h of p.hexes) {
          if (!g.hex(h.q, h.r)) bad("pendingAdvance hex off board");
          if (g.unitAt(h.q, h.r)) bad("pendingAdvance hex occupied");
        }
        const units = idSet(p.unitIds, "pendingAdvance");
        for (const id of units) {
          const u = g.units[id];
          if (!g.onMap(u) || u.faction !== p.faction) bad("pendingAdvance unit " + id);
        }
        g.pendingAdvance = { hexes: p.hexes.map((h) => ({ q: h.q, r: h.r })),
                             faction: p.faction, unitIds: [...units] };
      } else {
        g.pendingAdvance = null;
      }
      return g;
    }
  }

  // A generic victory helper games can reuse: eliminate the enemy, or (on timeout)
  // the faction owning the most objectives / still standing wins. Games usually
  // override this with their own scenario goal.
  // NOTE: counts every living unit, including scheduled reinforcements that
  // have not entered yet — an army is not "destroyed" while its reserves live.
  function defaultVictory(game, opts = {}) {
    for (const f of game.factions) {
      if (game.units.filter((u) => u.alive && u.faction === f.id).length === 0) {
        const other = game.factions.find((x) => x.id !== f.id);
        return { winner: other.id, reason: `${f.name} army destroyed` };
      }
    }
    return null;
  }

  global.HexWar = { Game, RESULT_CODES, defaultVictory };
})(typeof window !== "undefined" ? window : globalThis);
