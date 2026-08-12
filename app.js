/* =========================================================================
   app.js — Application layer: wires the engine + renderer to the DOM UI for
   the Ridge Assault scenario (hot-seat, two players). Handles input, HUD,
   overlays and the combat dialog. Depends on Hex, HexWar, HexRenderer + a game.
   ========================================================================= */
(function (global) {
  "use strict";
  const { Game } = global.HexWar;
  const DEF = global.RIDGE_ASSAULT;

  // ------------------------------- DOM refs --------------------------------
  const $ = (id) => document.getElementById(id);
  const boardWrap = $("boardWrap"), canvas = $("cv");

  // ------------------------------- game/renderer ---------------------------
  let game, renderer;
  let selected = null, reachable = new Map();
  let inspected = null; // hex {q,r} shown in the terrain inspector
  const factionById = (id) => DEF.factions.find((f) => f.id === id);

  renderer = new global.HexRenderer(canvas, {
    orientation: DEF.orientation,
    terrainColor: (g, hex) => DEF.terrain[hex.terrain].color,
    decorateHex: (ctx, g, hex, c, size) => {
      if (g.isObjective(hex.q, hex.r)) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 180) * (60 * i - 30);
          const x = c.x + size * 0.72 * Math.cos(a), y = c.y + size * 0.72 * Math.sin(a);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.lineWidth = 2; ctx.strokeStyle = "#c9a227"; ctx.stroke();
        ctx.fillStyle = "#7a5c00"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `bold ${Math.max(9, size * 0.5)}px sans-serif`;
        ctx.fillText("★", c.x, c.y);
      }
    },
    drawUnit: (ctx, g, u, c, size) => {
      const s = size * 0.66, t = g.typeOf(u), fac = factionById(u.faction);
      const rad = s * 0.9, x = c.x - rad, y = c.y - rad * 0.86, w = rad * 2, hh = rad * 1.72, br = Math.max(3, s * 0.18);
      roundRect(ctx, x, y, w, hh, br);
      const dimmed = g.phase === "move" && u.faction === g.activeFaction && u.moved;
      ctx.fillStyle = dimmed ? fac.dark : fac.color;
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `bold ${Math.max(10, s * 0.95)}px Georgia, serif`;
      ctx.fillText(t.glyph, c.x, c.y - s * 0.16);
      ctx.font = `${Math.max(7, s * 0.5)}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(`${t.combat}·${t.move}`, c.x, c.y + s * 0.62);
      if (g.phase === "combat" && u.faction === g.activeFaction && u.acted) {
        ctx.fillStyle = "rgba(0,0,0,.28)"; roundRect(ctx, x, y, w, hh, br); ctx.fill();
      }
    },
  });

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ------------------------------- rendering -------------------------------
  function highlights() {
    const hs = [];
    if (game.phase === "move" && selected) {
      for (const [, cell] of reachable) hs.push({ hex: cell, fill: "rgba(60,150,60,.32)" });
    }
    if (game.phase === "combat") {
      for (const e of game.enemiesOf(game.activeFaction)) {
        if (game.attackersFor(e).length > 0)
          hs.push({ hex: e, stroke: "rgba(210,40,40,.9)", lineWidth: 3, scale: 0.96 });
      }
    }
    if (inspected) hs.push({ hex: inspected, stroke: "rgba(255,255,255,.85)", lineWidth: 2, scale: 0.9 });
    return hs;
  }
  function draw() {
    renderer.render(game, { highlights: highlights(), selected });
  }
  function fitAndDraw() {
    renderer.fit([...game.board.values()], boardWrap);
    draw();
  }

  // ------------------------------- input -----------------------------------
  canvas.addEventListener("pointerdown", (ev) => {
    if (game.over || anyOverlay()) return;
    const rect = canvas.getBoundingClientRect();
    const hex = renderer.pick(game, ev.clientX - rect.left, ev.clientY - rect.top);
    if (!hex) { selected = null; reachable = new Map(); inspected = null; renderInspector(); draw(); syncSel(); return; }
    onHex(hex.q, hex.r);
  });

  function onHex(q, r) {
    inspected = { q, r }; // every board tap inspects the hex
    const u = game.unitAt(q, r);
    if (game.phase === "move") {
      if (selected && reachable.has(global.Hex.key(q, r))) {
        game.moveUnit(selected, q, r);
        selected = null; reachable = new Map(); renderInspector(); draw(); syncSel(); syncUndo(); return;
      }
      if (u && u.faction === game.activeFaction && !u.moved) {
        selected = u; reachable = game.reachable(u);
      } else { selected = null; reachable = new Map(); }
      renderInspector(); draw(); syncSel();
    } else { // combat
      if (u && u.faction !== game.activeFaction) {
        const atk = game.attackersFor(u);
        if (atk.length) openCombat(u, atk);
      } else { selected = null; }
      renderInspector(); draw(); syncSel();
    }
  }

  // --------------------------- hex inspector -------------------------------
  function renderInspector() {
    const el = $("hexInfo");
    if (!inspected) { el.classList.add("hidden"); return; }
    const { q, r } = inspected;
    const hx = game.hex(q, r);
    if (!hx) { el.classList.add("hidden"); return; }
    const t = DEF.terrain[hx.terrain];
    el.querySelector(".hiSwatch").style.background = t.color;
    el.querySelector(".hiName").textContent = t.name;
    const plural = t.moveCost === 1 ? "" : "s";
    el.querySelector(".hiStats").textContent =
      `Enter: ${t.moveCost} MP · Defense ×${t.defMult}`;
    const effect = t.passable === false
      ? "Impassable — units cannot enter."
      : `Costs ${t.moveCost} movement point${plural} to enter. ` +
        (t.defMult === 1 ? "No defensive bonus here." : `Units defending here fight at ×${t.defMult} strength.`);
    el.querySelector(".hiEffect").textContent = effect;

    const objEl = el.querySelector(".hiObj");
    if (game.isObjective(q, r)) {
      const owner = factionById((game.objectives.find((o) => o.q === q && o.r === r) || {}).owner);
      objEl.textContent = `★ Objective — ${owner ? owner.name : "a side"} wins by holding this hex.`;
      objEl.hidden = false;
    } else objEl.hidden = true;

    const unitEl = el.querySelector(".hiUnit");
    const u = game.unitAt(q, r);
    if (u) {
      const fac = factionById(u.faction), ut = game.typeOf(u);
      let tag = "";
      if (game.phase === "move" && u.faction === game.activeFaction && u.moved) tag = " (moved)";
      else if (game.phase === "combat" && u.faction === game.activeFaction && u.acted) tag = " (attacked)";
      unitEl.innerHTML = `${fac.name} ${ut.name} · CS ${ut.combat} · MA ${ut.move}` +
        (tag ? `<span class="tag">${tag}</span>` : "");
      unitEl.hidden = false;
    } else unitEl.hidden = true;

    el.classList.remove("hidden");
  }
  $("hexInfoClose").onclick = () => { inspected = null; renderInspector(); draw(); };

  // --------------------------- combat dialog -------------------------------
  let pending = null;
  function openCombat(defender, attackers) {
    const atk = game.attackerStrength(attackers);
    const def = game.defenderStrength(defender);
    const col = game.oddsColumn(atk, def);
    const t = game.terrainAt(defender.q, defender.r);
    pending = { defender, attackers };
    $("cbAtk").textContent = `${atk}  (${attackers.length} unit${attackers.length > 1 ? "s" : ""})`;
    $("cbDef").textContent = `${factionById(defender.faction).name} ${game.typeOf(defender).name} — CS ${game.combat(defender)}`;
    $("cbTer").textContent = `${t.name} (×${t.defMult}) → def ${def}`;
    $("odds").textContent = col;
    $("dieBox").textContent = "";
    $("cbBtns").style.display = "flex";
    $("contBtn").style.display = "none";
    $("resolveBtn").disabled = false;
    show("cbOv");
  }
  $("cancelBtn").onclick = () => { pending = null; hide("cbOv"); };
  $("resolveBtn").onclick = () => {
    if (!pending) return;
    $("resolveBtn").disabled = true;
    let ticks = 0; const box = $("dieBox");
    const spin = setInterval(() => {
      box.textContent = "🎲 " + (1 + Math.floor(Math.random() * 6));
      if (++ticks >= 8) { clearInterval(spin); resolve(); }
    }, 55);
  };
  $("contBtn").onclick = () => { hide("cbOv"); draw(); syncSel(); };

  function resolve() {
    const res = game.resolveCombat(pending.defender, pending.attackers);
    $("dieBox").innerHTML = `Die <b>${res.die}</b> → <b>${res.code}</b> — ${res.note}`;
    flash(`${res.column} · roll ${res.die} → ${res.note}`);
    pending = null;
    $("cbBtns").style.display = "none";
    $("contBtn").style.display = "block";
    draw();
  }

  // ------------------------------ overlays ---------------------------------
  const OVERLAYS = ["passOv", "cbOv", "winOv", "helpOv"];
  const show = (id) => $(id).classList.add("show");
  const hide = (id) => $(id).classList.remove("show");
  const anyOverlay = () => OVERLAYS.some((id) => $(id).classList.contains("show"));

  function showPass() {
    const fac = factionById(game.activeFaction);
    const el = $("passSide"); el.textContent = fac.short; el.style.background = fac.color;
    $("passTurn").textContent = `Turn ${game.turn} of ${DEF.maxTurns}`;
    show("passOv");
  }
  $("passOv").addEventListener("pointerdown", () => { hide("passOv"); syncHud(); draw(); syncSel(); });
  $("help").onclick = () => show("helpOv");
  $("helpClose").onclick = () => hide("helpOv");
  $("newBtn").onclick = () => startGame();
  $("winBtn").onclick = () => startGame();

  // ------------------------------- HUD -------------------------------------
  const actBtn = $("actBtn"), undoBtn = $("undoBtn");
  actBtn.onclick = () => { if (!game.over && !anyOverlay()) game.endPhase(); };
  undoBtn.onclick = () => {
    if (game.over || anyOverlay()) return;
    const u = game.undoMove();
    if (u) { selected = u; reachable = game.reachable(u); inspected = { q: u.q, r: u.r }; renderInspector(); }
    else { selected = null; }
    draw(); syncSel(); syncUndo();
  };

  function syncUndo() {
    const inMove = game.phase === "move";
    undoBtn.classList.toggle("hidden", !inMove);
    undoBtn.disabled = !game.canUndo();
  }
  function syncHud() {
    const fac = factionById(game.activeFaction);
    $("turnPill").textContent = `Turn ${game.turn}/${DEF.maxTurns}`;
    const sp = $("sidePill"); sp.textContent = fac.short; sp.style.background = fac.color;
    $("phaseTxt").textContent = game.phase === "move" ? "Movement" : "Combat";
    actBtn.textContent = game.phase === "move" ? "End Movement" : "End Combat";
    actBtn.style.background = fac.dark;
    syncUndo();
    syncSel();
  }
  function syncSel() {
    const el = $("sel");
    if (game.phase === "combat") {
      const n = game.enemiesOf(game.activeFaction).filter((u) => game.attackersFor(u).length > 0).length;
      el.innerHTML = n > 0
        ? `<b>Combat.</b> Tap a highlighted enemy to attack. <span class="muted">(${n} target${n > 1 ? "s" : ""})</span>`
        : `<b>Combat.</b> <span class="muted">No targets in range — end combat.</span>`;
      return;
    }
    if (selected) {
      el.innerHTML = reachable.size
        ? `<b>Move.</b> Tap a highlighted hex. <span class="muted">(${reachable.size} option${reachable.size > 1 ? "s" : ""})</span>`
        : `<b>Move.</b> <span class="muted">This unit has no available moves.</span>`;
    } else {
      const left = game.living(game.activeFaction).filter((u) => !u.moved).length;
      el.innerHTML = `<span class="muted">Movement. Tap one of your units to move it. (${left} unmoved)</span>`;
    }
  }
  function flash(msg) {
    const log = $("log"); log.innerHTML = `<span>${msg}</span>`;
    clearTimeout(flash._t); flash._t = setTimeout(() => (log.innerHTML = ""), 3200);
  }

  // ------------------------------- lifecycle -------------------------------
  function startGame() {
    game = new Game(DEF);
    selected = null; reachable = new Map(); inspected = null; renderInspector();
    game.events.on("sideChange", () => { selected = null; showPass(); });
    game.events.on("phase", () => { selected = null; reachable = new Map(); inspected = null; renderInspector(); syncHud(); draw(); });
    game.events.on("gameover", ({ winner, reason }) => {
      const fac = winner ? factionById(winner) : null;
      $("winTitle").textContent = fac ? fac.name + " Victory" : "Draw";
      $("winTitle").style.color = fac ? fac.color : "#fff";
      $("winSub").textContent = reason;
      show("winOv");
    });
    hide("cbOv"); hide("winOv");
    fitAndDraw(); syncHud(); showPass();
    global.__game = game; global.__renderer = renderer; // for smoke-testing
  }

  global.addEventListener("resize", () => { if (game) fitAndDraw(); });
  startGame();
})(typeof window !== "undefined" ? window : globalThis);
