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
       setup:     [{ faction, army?, units:[[col,row,typeKey], ...] }],
       reinforcements: [{ turn, faction, army?, entry:[[col,row],...],
                          units:["typeKey", ...] }],   // optional, scheduled arrivals
       demoralization: { armyOrFactionId: level },     // optional, read by victory()
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
      // Objectives
      this.objectives = (this.def.objectives || []).map((o) => {
        const a = Hex.offsetToAxial(o.col, o.row, this.offsetMode);
        return { key: Hex.key(a.q, a.r), q: a.q, r: a.r, owner: o.owner };
      });
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

    // Cumulative eliminated Strength Points — derived, nothing to serialize.
    // `army` narrows to a tagged army within the faction (e.g. Prussians).
    lostSP(faction, army) {
      return this.units
        .filter((u) => !u.alive && u.faction === faction && (army == null || u.army === army))
        .reduce((s, u) => s + this.combat(u), 0);
    }

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
      // A freshly arrived reinforcement has already paid 1 MP for its entry hex.
      const budget = this.move(unit) - (unit.freshArrival ? 1 : 0);
      return Hex.reachable({
        start: { q: unit.q, r: unit.r },
        budget,
        neighborsOf: (h) => Hex.neighbors(h).filter((n) => this.board.has(Hex.key(n.q, n.r))),
        stepCost: (from, to) => {
          if (this.unitAt(to.q, to.r)) return Infinity; // blocked by any unit
          return this.stepCost(unit, this.hex(from.q, from.r), this.hex(to.q, to.r));
        },
        blocked: (h) => !this.board.has(Hex.key(h.q, h.r)),
        stopAt: (h) => this.isEnemyZOC(faction, h.q, h.r), // ZOC halts movement
      });
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
    // All active-faction units within attack range of `defender` (1 unless the
    // unit type sets `range`) that haven't acted this phase.
    attackersFor(defender) {
      return this.units.filter((u) => this.onMap(u) && u.faction === this.activeFaction &&
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
            if (!this.retreat(d, threat, 1, true)) { kill(d); trapped = true; }
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
            if (!this.retreat(a, defenders[0], 1, true)) { kill(a); lost = true; }
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
    resolveCombat(defenders, attackers) {
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
          if (!defenders.some((d) => Hex.distance(a, d) <= this.range(a)))
            return { ok: false, reason: "attacker out of range" };
        }
      }
      // In a combined battle every defender must be engaged by an adjacent
      // attacker; only a single-defender battle may be a pure bombardment.
      if (defenders.length > 1) {
        for (const d of defenders) {
          if (!attackers.some((a) => Hex.distance(a, d) === 1))
            return { ok: false, reason: "defender not engaged" };
        }
      }
      const atk = this.attackerStrength(attackers);
      const def = defenders.reduce((s, d) => s + this.defenderStrength(d), 0);
      const column = this.oddsColumn(atk, def);
      const die = this.rollDie();
      const code = this.def.crt.table[column][die - 1];
      const defHexes = defenders.map((d) => ({ q: d.q, r: d.r }));
      const note = this.applyResult(code, defenders, attackers);
      attackers.forEach((a) => { if (a.alive) a.acted = true; });
      defenders.forEach((d) => this.attackedIds.add(d.id));
      // Advance after combat: hexes the defenders no longer hold may be
      // claimed by ONE surviving engaged attacker, immediately.
      let advance = null;
      {
        const hexes = defHexes.filter((h) => !this.unitAt(h.q, h.r));
        const unitIds = attackers
          .filter((a) => a.alive && hexes.some((h) => Hex.distance(a, h) === 1))
          .map((a) => a.id);
        if (hexes.length && unitIds.length) {
          this.pendingAdvance = { hexes, faction: this.activeFaction, unitIds };
          advance = { hexes, candidates: unitIds.map((i) => this.units[i]) };
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
      if (Hex.distance(unit, hx) !== 1) return { ok: false, reason: "unit not adjacent" };
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
        if (!u.alive || u.entered !== false) continue;
        const grp = groups[u.rgroup];
        if (!grp || grp.faction !== faction || grp.turn > this.turn) continue;
        const spot = grp.entry
          .map(([c, r]) => Hex.offsetToAxial(c, r, this.offsetMode))
          .find((a) => {
            const h = this.hex(a.q, a.r);
            return h && this.terrain[h.terrain].passable !== false && !this.unitAt(a.q, a.r);
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
      } while (skip && skip(this, this.phases[this.phaseIndex]));
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
        })),
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
        if (su.alive && !g.hex(su.q, su.r)) bad("unit off board " + su.id);
        if (su.entered === false && (su.moved || su.acted)) bad("unentered unit acted " + su.id);
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
