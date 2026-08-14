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
       objectives:[{col,row,owner}] (optional, for victory helpers),
       setup:     [{ faction, units:[[col,row,typeKey], ...] }],
       phases:    ["move","combat"],          // per-faction, in order
       maxTurns:  number,
       crt:       { "columns":[...], table:{col:[6 results]} },   // optional override
       rules:     {  (all optional — sensible defaults provided)
         stepCost(game,unit,fromHex,toHex), canStandOn(game,unit,hex),
         isZOC(game,side,hex), attackerStrength(game,atkList),
         defenderStrength(game,def,hex), oddsColumn(game,atk,def),
         rollDie(game)->1..6, applyResult(game,code,def,atkList),
       },
       victory(game) -> { winner, reason } | null,
     }
  ------------------------------------------------------------------------ */

  const RESULT_CODES = ["Ae", "Ar", "Ex", "NE", "Dr", "De"];

  class Game {
    constructor(def) {
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
      // Objectives
      this.objectives = (this.def.objectives || []).map((o) => {
        const a = Hex.offsetToAxial(o.col, o.row, this.offsetMode);
        return { key: Hex.key(a.q, a.r), q: a.q, r: a.r, owner: o.owner };
      });
      // Units
      this.units = [];
      let id = 0;
      for (const grp of this.def.setup) {
        for (const u of grp.units) {
          const a = Hex.offsetToAxial(u[0], u[1], this.offsetMode);
          this.units.push({
            id: id++, faction: grp.faction, type: u[2],
            q: a.q, r: a.r, alive: true, moved: false, acted: false,
          });
        }
      }
      // Turn state
      this.turn = 1;
      this.sideIndex = 0;             // index into factions[] whose turn it is
      this.phaseIndex = 0;
      this.over = false;
      this.winner = null;
      this._enterPhase();
    }

    /* ------------------------------ queries ------------------------------ */
    get activeFaction() { return this.factions[this.sideIndex].id; }
    get phase() { return this.phases[this.phaseIndex]; }
    hex(q, r) { return this.board.get(Hex.key(q, r)); }
    terrainAt(q, r) { const h = this.hex(q, r); return h ? this.terrain[h.terrain] : null; }
    typeOf(u) { return this.unitTypes[u.type]; }
    unitAt(q, r) { return this.units.find((u) => u.alive && u.q === q && u.r === r); }
    living(faction) { return this.units.filter((u) => u.alive && u.faction === faction); }
    enemiesOf(faction) { return this.units.filter((u) => u.alive && u.faction !== faction); }
    isObjective(q, r) { return this.objectives.some((o) => o.q === q && o.r === r); }

    combat(u) { return this.typeOf(u).combat; }
    move(u) { return this.typeOf(u).move; }
    range(u) { return this.typeOf(u).range || 1; }

    /* ------------------------------- rules ------------------------------- */
    // Default rule implementations; a GameDef may override any via def.rules.
    _rule(name, fallback) {
      const r = this.def.rules || {};
      return r[name] ? r[name].bind(null) : fallback;
    }

    // Zone of Control: a hex is in `faction`'s enemies' ZOC if adjacent to an enemy unit.
    isEnemyZOC(faction, q, r) {
      const custom = (this.def.rules || {}).isZOC;
      if (custom) return custom(this, faction, { q, r });
      for (const nb of Hex.neighbors({ q, r })) {
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
      return t.moveCost;
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
      return Hex.reachable({
        start: { q: unit.q, r: unit.r },
        budget: this.move(unit),
        neighborsOf: (h) => Hex.neighbors(h).filter((n) => this.board.has(Hex.key(n.q, n.r))),
        stepCost: (from, to) => {
          if (this.unitAt(to.q, to.r)) return Infinity; // blocked by any unit
          return this.stepCost(unit, this.hex(from.q, from.r), this.hex(to.q, to.r));
        },
        blocked: (h) => !this.board.has(Hex.key(h.q, h.r)),
        stopAt: (h) => this.isEnemyZOC(faction, h.q, h.r), // ZOC halts movement
      });
    }

    canMove(unit) { return this.phase === "move" && unit.faction === this.activeFaction && !unit.moved; }

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
    // All active-faction units within attack range of `defender` (1 unless the
    // unit type sets `range`) that haven't acted this phase.
    attackersFor(defender) {
      return this.units.filter((u) => u.alive && u.faction === this.activeFaction &&
        !u.acted && Hex.distance(u, defender) <= this.range(u));
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
      const cols = (this.def.crt && this.def.crt.columns) || DEFAULT_CRT.columns;
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

    // Retreat a unit `steps` hexes away from `threat`. Returns false if impossible.
    retreat(unit, threat, steps, avoidZOC) {
      for (let s = 0; s < steps; s++) {
        let best = null, bestD = -1;
        for (const nb of Hex.neighbors(unit)) {
          const h = this.hex(nb.q, nb.r);
          if (!h) continue;
          if (this.unitAt(nb.q, nb.r)) continue;
          if (this.terrain[h.terrain].passable === false) continue;
          if (avoidZOC && this.isEnemyZOC(unit.faction, nb.q, nb.r)) continue;
          const d = Hex.distance(nb, threat);
          if (d > bestD) { bestD = d; best = nb; }
        }
        if (!best) return false;
        unit.q = best.q; unit.r = best.r;
      }
      return true;
    }

    applyResult(code, defender, attackers) {
      const custom = (this.def.rules || {}).applyResult;
      if (custom) return custom(this, code, defender, attackers);
      // Attackers adjacent to the defender are engaged in melee; the rest are
      // bombarding from range and never suffer adverse attacker results.
      const engaged = attackers.filter((a) => Hex.distance(a, defender) === 1);
      const threat = engaged[0] || attackers[0];
      const kill = (u) => { u.alive = false; };
      let note = "";
      switch (code) {
        case "De": kill(defender); note = "Defender destroyed"; break;
        case "Dr":
          if (!this.retreat(defender, threat, 2, true)) { kill(defender); note = "Defender trapped — destroyed"; }
          else note = "Defender retreated"; break;
        case "Ex": {
          kill(defender);
          let need = this.combat(defender);
          for (const a of engaged.slice().sort((x, y) => this.combat(x) - this.combat(y))) {
            if (need <= 0) break; kill(a); need -= this.combat(a);
          }
          note = "Exchange — losses on both sides"; break;
        }
        case "Ar":
          engaged.forEach((a) => this.retreat(a, defender, 1, false));
          note = engaged.length ? "Attackers pushed back" : "Bombardment driven off — guns unharmed";
          break;
        case "Ae": {
          const weak = engaged.slice().sort((x, y) => this.combat(x) - this.combat(y))[0];
          if (weak) { kill(weak); note = "Attacker repulsed with losses"; }
          else note = "Bombardment repulsed — no losses at range";
          break;
        }
        case "NE": note = "No effect"; break;
      }
      return note;
    }

    // Resolve an attack on `defender`. Attackers auto-gathered unless supplied.
    resolveCombat(defender, attackers) {
      if (this.phase !== "combat") return { ok: false, reason: "not combat phase" };
      attackers = attackers || this.attackersFor(defender);
      if (!attackers.length) return { ok: false, reason: "no eligible attackers" };
      const atk = this.attackerStrength(attackers);
      const def = this.defenderStrength(defender);
      const column = this.oddsColumn(atk, def);
      const die = this.rollDie();
      const table = (this.def.crt && this.def.crt.table) || DEFAULT_CRT.table;
      const code = table[column][die - 1];
      const note = this.applyResult(code, defender, attackers);
      attackers.forEach((a) => { if (a.alive) a.acted = true; });
      const result = { ok: true, attackers, defender, atk, def, column, die, code, note };
      this.events.emit("combat", result);
      this._checkVictory();
      return result;
    }

    /* --------------------------- turn / phases --------------------------- */
    _enterPhase() {
      const faction = this.activeFaction;
      this.moveLog = []; // undo history is per-phase
      if (this.phase === "move") this.living(faction).forEach((u) => (u.moved = false));
      if (this.phase === "combat") this.living(faction).forEach((u) => (u.acted = false));
      this.events.emit("phase", { turn: this.turn, faction, phase: this.phase });
    }

    endPhase() {
      if (this.over) return;
      if (this._checkVictory()) return;
      this.phaseIndex++;
      if (this.phaseIndex < this.phases.length) { this._enterPhase(); return; }
      // Advance to next faction, or next turn.
      this.phaseIndex = 0;
      this.sideIndex++;
      if (this.sideIndex >= this.factions.length) {
        this.sideIndex = 0;
        this.turn++;
        if (this.turn > this.maxTurns) { this._timeout(); return; }
      }
      this.events.emit("sideChange", { turn: this.turn, faction: this.activeFaction });
      this._enterPhase();
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
        })),
        moveLog: this.moveLog.map((m) => ({
          unitId: m.unit.id, fromQ: m.fromQ, fromR: m.fromR,
        })),
      };
    }

    // Rebuild a Game from serialize() output. Throws on anything that does not
    // match the def — a save from an edited scenario is discarded, not played.
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
        if (su.alive && !g.hex(su.q, su.r)) bad("unit off board " + su.id);
      }
      if (!Array.isArray(data.moveLog)) bad("moveLog");
      for (const m of data.moveLog) {
        if (!g.units[m.unitId]) bad("moveLog unit " + m.unitId);
      }

      for (const su of data.units) {
        const u = g.units[su.id];
        u.q = su.q; u.r = su.r;
        u.alive = !!su.alive; u.moved = !!su.moved; u.acted = !!su.acted;
      }
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
      return g;
    }
  }

  // A generic victory helper games can reuse: eliminate the enemy, or (on timeout)
  // the faction owning the most objectives / still standing wins. Games usually
  // override this with their own scenario goal.
  function defaultVictory(game, opts = {}) {
    for (const f of game.factions) {
      if (game.living(f.id).length === 0) {
        const other = game.factions.find((x) => x.id !== f.id);
        return { winner: other.id, reason: `${f.name} army destroyed` };
      }
    }
    return null;
  }

  const DEFAULT_CRT = {
    columns: ["1:2", "1:1", "2:1", "3:1", "4:1", "5:1"],
    table: {
      "1:2": ["Ae", "Ae", "Ar", "Ex", "NE", "Dr"],
      "1:1": ["Ae", "Ar", "Ex", "NE", "Dr", "Dr"],
      "2:1": ["Ar", "Ex", "NE", "Dr", "Dr", "De"],
      "3:1": ["Ex", "NE", "Dr", "Dr", "De", "De"],
      "4:1": ["NE", "Dr", "Dr", "De", "De", "De"],
      "5:1": ["Dr", "Dr", "De", "De", "De", "De"],
    },
  };

  global.HexWar = { Game, RESULT_CODES, DEFAULT_CRT, defaultVictory };
})(typeof window !== "undefined" ? window : globalThis);
