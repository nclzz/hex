/* =========================================================================
   app.js — Application layer: wires the engine + renderer to the DOM UI for
   whichever scenario the player picks (hot-seat, two players). Handles input
   (tap, drag-to-pan, pinch/wheel-to-zoom), HUD, overlays and the combat
   dialog. Depends on Hex, HexWar, HexRenderer + the registered games.
   ========================================================================= */
(function (global) {
  "use strict";
  const { Game } = global.HexWar;

  // ------------------------------- DOM refs --------------------------------
  const $ = (id) => document.getElementById(id);
  const boardWrap = $("boardWrap"), canvas = $("cv");

  // ------------------------------ persistence ------------------------------
  // One autosave slot in localStorage. Every access is guarded: Safari private
  // mode throws on write, and some contexts throw on merely touching
  // localStorage — failure just means the game runs without persistence.
  const SAVE_KEY = "hexwar.save.v1";
  const lsGet = (k) => { try { return global.localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { global.localStorage.setItem(k, v); } catch (e) { /* no persistence */ } };
  const lsDel = (k) => { try { global.localStorage.removeItem(k); } catch (e) { /* no persistence */ } };

  function save() {
    if (!game || game.over) return; // a finished game never claims the slot
    lsSet(SAVE_KEY, JSON.stringify({
      v: 1, scenarioId: DEF.id, game: game.serialize(),
      camera: { zoom: renderer.zoom, cam: { x: renderer.cam.x, y: renderer.cam.y } },
    }));
  }
  function clearSave() { lsDel(SAVE_KEY); }

  // The stored save, or null. Trial-restores the game so the Continue card is
  // only ever offered for a save that will actually load.
  function loadSave() {
    const raw = lsGet(SAVE_KEY);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || data.v !== 1) return null;
      const def = (global.HEX_SCENARIOS || []).find((d) => d.id === data.scenarioId);
      if (!def) return null;
      Game.restore(def, data.game);
      return { def, data };
    } catch (e) { clearSave(); return null; }
  }

  // ------------------------------- game/renderer ---------------------------
  let DEF = null;               // the scenario currently being played
  let game = null, renderer = null;
  let selected = null, reachable = new Map();
  let inspected = null; // hex {q,r} shown in the terrain inspector
  const factionById = (id) => DEF.factions.find((f) => f.id === id);

  // Below these hex sizes the counter glyphs would be smaller than they are
  // legible, so we drop detail instead of drawing unreadable text.
  const LOD_STATS = 14, LOD_GLYPH = 9, LOD_STAR = 12;

  function makeRenderer() {
    return new global.HexRenderer(canvas, {
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
          if (size < LOD_STAR) return;
          ctx.fillStyle = "#7a5c00"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = `bold ${size * 0.5}px sans-serif`;
          ctx.fillText("★", c.x, c.y);
        }
      },
      drawUnit: (ctx, g, u, c, size) => {
        const s = size * 0.66, t = g.typeOf(u), fac = factionById(u.faction);
        const rad = s * 0.9, x = c.x - rad, y = c.y - rad * 0.86, w = rad * 2, hh = rad * 1.72, br = Math.max(2, s * 0.18);
        roundRect(ctx, x, y, w, hh, br);
        const dimmed = g.phase === "move" && u.faction === g.activeFaction && u.moved;
        ctx.fillStyle = dimmed ? fac.dark : fac.color;
        ctx.fill();
        ctx.lineWidth = size < LOD_GLYPH ? 1 : 1.5;
        ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.stroke();
        if (size >= LOD_GLYPH) {
          const stats = size >= LOD_STATS;
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = `bold ${s * 0.95}px Georgia, serif`;
          ctx.fillText(t.glyph, c.x, c.y - (stats ? s * 0.16 : 0));
          if (stats) {
            const ranged = (t.range || 1) > 1;
            ctx.font = `${s * (ranged ? 0.45 : 0.5)}px sans-serif`;
            ctx.fillStyle = "rgba(255,255,255,.92)";
            ctx.fillText(`${t.combat}·${t.move}${ranged ? `·${t.range}` : ""}`, c.x, c.y + s * 0.62);
          }
        }
        if (g.phase === "combat" && u.faction === g.activeFaction && u.acted) {
          ctx.fillStyle = "rgba(0,0,0,.28)"; roundRect(ctx, x, y, w, hh, br); ctx.fill();
        }
      },
    });
  }

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
    if (!game || !renderer) return;
    renderer.render(game, { highlights: highlights(), selected });
  }
  // Coalesce the redraws a 60 fps pan/pinch would otherwise trigger.
  let rafPending = false;
  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    global.requestAnimationFrame(() => { rafPending = false; draw(); });
  }

  // Re-measure after a resize / rotation; the renderer keeps the camera's
  // world focus and the on-screen hex size across the change.
  function relayout() {
    if (!game || !renderer) return;
    renderer.resize(boardWrap);
    draw(); syncFit();
  }

  // Bring a hex on screen if it isn't; used so the action is never off-camera.
  function focus(hex) { if (hex && renderer) renderer.ensureVisible(hex); }
  // Open on the active side's centre of mass, so a player handed the device
  // is looking at their own army rather than at empty terrain.
  function focusActive() {
    if (!game || !renderer) return;
    const list = game.living(game.activeFaction);
    if (!list.length) return;
    const q = list.reduce((s, u) => s + u.q, 0) / list.length;
    const r = list.reduce((s, u) => s + u.r, 0) / list.length;
    renderer.centerOn({ q, r });
  }

  // ------------------------------- camera UI -------------------------------
  const fitBtn = $("fitBtn");
  let zoomBeforeFit = null; // set while the player is looking at the whole map

  function syncFit() {
    if (!renderer) return;
    const over = renderer.contentOverflows();
    boardWrap.classList.toggle("overflowing", over);
    const zoomedOut = renderer.isAtMinZoom() && zoomBeforeFit != null;
    fitBtn.classList.toggle("hidden", !over && !zoomedOut);
    fitBtn.textContent = zoomedOut ? "Zoom in" : "Fit";
  }
  fitBtn.onclick = () => {
    if (!game || !renderer) return;
    if (renderer.isAtMinZoom() && zoomBeforeFit != null) {
      renderer.setZoom(zoomBeforeFit); zoomBeforeFit = null;
    } else {
      zoomBeforeFit = renderer.zoom; renderer.frameAll();
    }
    draw(); syncFit();
  };

  // ------------------------------- input -----------------------------------
  // A tap selects/moves; a drag pans; two fingers (or the wheel) zoom. The tap
  // only commits on pointerup, once we know the pointer never became a drag.
  const TAP_SLOP = 10; // CSS px of travel still counted as a tap
  const pointers = new Map(); // pointerId -> {x,y}
  let drag = null;   // {id, downX, downY, lastX, lastY, moved}
  let pinch = null;  // {ids, dist, midX, midY}

  function localPt(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function boardBusy() { return !game || game.over || anyOverlay(); }

  function startPinch() {
    const ids = [...pointers.keys()].slice(0, 2);
    const a = pointers.get(ids[0]), b = pointers.get(ids[1]);
    pinch = {
      ids, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
    };
    drag = null;
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (boardBusy()) return;
    const p = localPt(ev);
    pointers.set(ev.pointerId, p);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not captureable */ }
    if (pointers.size === 1) {
      drag = { id: ev.pointerId, downX: p.x, downY: p.y, lastX: p.x, lastY: p.y, moved: false };
    } else if (pointers.size === 2) {
      startPinch();
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId) || !renderer) return;
    const p = localPt(ev);
    pointers.set(ev.pointerId, p);

    if (pinch) {
      const a = pointers.get(pinch.ids[0]), b = pointers.get(pinch.ids[1]);
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      renderer.zoomAt(dist / pinch.dist, midX, midY);
      renderer.panByPixels(midX - pinch.midX, midY - pinch.midY);
      pinch.dist = dist; pinch.midX = midX; pinch.midY = midY;
      requestDraw(); syncFit();
      return;
    }
    if (drag && drag.id === ev.pointerId) {
      if (!drag.moved && Math.hypot(p.x - drag.downX, p.y - drag.downY) > TAP_SLOP) drag.moved = true;
      if (drag.moved) { renderer.panByPixels(p.x - drag.lastX, p.y - drag.lastY); requestDraw(); }
      drag.lastX = p.x; drag.lastY = p.y;
    }
  });

  function endPointer(ev) {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* already gone */ }

    if (pinch) {
      if (pointers.size >= 2) { startPinch(); return; }
      pinch = null;
      // Lifting one finger hands the gesture back to the other one as a pan —
      // never as a tap, which would fire a stray move at the end of a pinch.
      const id = [...pointers.keys()][0];
      if (id != null) {
        const q = pointers.get(id);
        drag = { id, downX: q.x, downY: q.y, lastX: q.x, lastY: q.y, moved: true };
      }
      syncFit();
      return;
    }
    const d = drag;
    if (d && d.id === ev.pointerId) {
      drag = null;
      if (!d.moved && ev.type === "pointerup") commitTap(d.downX, d.downY);
      else syncFit();
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (ev) => {
    if (boardBusy() || !renderer) return;
    ev.preventDefault();
    const p = localPt(ev);
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY; // lines -> px
    renderer.zoomAt(Math.exp(-dy * 0.0015), p.x, p.y);
    requestDraw(); syncFit();
  }, { passive: false });

  function commitTap(x, y) {
    if (boardBusy()) return;
    const hex = renderer.pick(game, x, y);
    if (!hex) {
      selected = null; reachable = new Map(); inspected = null;
      renderInspector(); draw(); syncSel(); return;
    }
    onHex(hex.q, hex.r);
  }

  function onHex(q, r) {
    inspected = { q, r }; // every board tap inspects the hex
    const u = game.unitAt(q, r);
    if (game.phase === "move") {
      if (selected && reachable.has(global.Hex.key(q, r))) {
        game.moveUnit(selected, q, r);
        selected = null; reachable = new Map();
        focus({ q, r });
        renderInspector(); draw(); syncSel(); syncUndo(); return;
      }
      if (u && u.faction === game.activeFaction && !u.moved) {
        selected = u; reachable = game.reachable(u); focus(u);
      } else { selected = null; reachable = new Map(); }
      renderInspector(); draw(); syncSel();
    } else { // combat
      if (u && u.faction !== game.activeFaction) {
        const atk = game.attackersFor(u);
        if (atk.length) { focus(u); openCombat(u, atk); }
      } else { selected = null; }
      renderInspector(); draw(); syncSel();
    }
  }

  // --------------------------- hex inspector -------------------------------
  function renderInspector() {
    const el = $("hexInfo");
    if (!inspected || !game) { el.classList.add("hidden"); return; }
    const { q, r } = inspected;
    const hx = game.hex(q, r);
    if (!hx) { el.classList.add("hidden"); return; }
    const t = DEF.terrain[hx.terrain];
    el.querySelector(".hiSwatch").style.background = t.color;
    el.querySelector(".hiName").textContent = t.name;
    const plural = t.moveCost === 1 ? "" : "s";
    el.querySelector(".hiStats").textContent = t.passable === false
      ? "Impassable"
      : `Enter: ${t.moveCost} MP · Defense ×${t.defMult}`;
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
        ((ut.range || 1) > 1 ? ` · Range ${ut.range}` : "") +
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
    const bomb = attackers.filter((a) => global.Hex.distance(a, defender) >= 2).length;
    $("cbAtk").textContent = `${atk}  (${attackers.length} unit${attackers.length > 1 ? "s" : ""}` +
      `${bomb ? `, ${bomb} bombarding` : ""})`;
    $("cbBomb").hidden = bomb === 0;
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
  const OVERLAYS = ["startOv", "passOv", "cbOv", "winOv", "helpOv"];
  const show = (id) => $(id).classList.add("show");
  const hide = (id) => $(id).classList.remove("show");
  const anyOverlay = () => OVERLAYS.some((id) => $(id).classList.contains("show"));

  function showPass() {
    const fac = factionById(game.activeFaction);
    const el = $("passSide"); el.textContent = fac.short; el.style.background = fac.color;
    $("passTurn").textContent = `Turn ${game.turn} of ${DEF.maxTurns}`;
    show("passOv");
  }
  $("passOv").addEventListener("pointerdown", () => {
    hide("passOv");
    // On a resumed game the first dismissal must not recenter the camera the
    // player left behind; every later turn hand-off refocuses as usual.
    if (resumedCamera) resumedCamera = false; else focusActive();
    syncHud(); draw(); syncSel(); syncFit();
  });
  $("help").onclick = () => show("helpOv");
  $("helpClose").onclick = () => hide("helpOv");
  $("newBtn").onclick = () => showStart();
  $("winBtn").onclick = () => { hide("winOv"); startGame(DEF); };
  $("winPickBtn").onclick = () => { hide("winOv"); showStart(); };

  // --------------------------- scenario picker -----------------------------
  function showStart() {
    const list = $("scenList");
    list.innerHTML = "";
    const s = loadSave();
    if (s) {
      const b = document.createElement("button");
      b.className = "scenBtn cont";
      const t = document.createElement("div"); t.className = "t";
      t.textContent = `Continue — ${s.def.title}`;
      const d = document.createElement("div"); d.className = "b";
      const side = s.def.factions[s.data.game.sideIndex].short;
      const phase = s.def.phases[s.data.game.phaseIndex] === "move" ? "Movement" : "Combat";
      d.textContent = `Turn ${s.data.game.turn} of ${s.def.maxTurns} · ${side} · ${phase}`;
      b.appendChild(t); b.appendChild(d);
      b.onclick = () => { hide("startOv"); startGame(s.def, s.data); };
      list.appendChild(b);
    }
    for (const def of (global.HEX_SCENARIOS || [])) {
      const b = document.createElement("button");
      b.className = "scenBtn";
      const t = document.createElement("div"); t.className = "t"; t.textContent = def.title;
      const d = document.createElement("div"); d.className = "b"; d.textContent = def.blurb || "";
      b.appendChild(t); b.appendChild(d);
      b.onclick = () => { hide("startOv"); startGame(def); };
      list.appendChild(b);
    }
    hide("cbOv"); hide("winOv");
    document.body.classList.add("nogame");
    show("startOv");
  }

  // Help text is per-scenario: goal from the game def, legend from its terrain.
  function populateHelp() {
    $("helpTitle").textContent = `${DEF.title} — How to play`;
    $("helpBrief").textContent = DEF.brief || "";
    const p = $("helpTerrain");
    p.innerHTML = "";
    for (const code of Object.keys(DEF.terrain)) {
      const t = DEF.terrain[code];
      const sw = document.createElement("span");
      sw.className = "k"; sw.style.background = t.color;
      const label = document.createElement("span");
      const note = t.passable === false ? " (impassable)"
        : t.defMult > 1 ? ` (×${t.defMult} def)` : "";
      label.textContent = `${t.name}${note} `;
      p.appendChild(sw); p.appendChild(label);
    }
  }

  // ------------------------------- HUD -------------------------------------
  const actBtn = $("actBtn"), undoBtn = $("undoBtn");
  actBtn.onclick = () => { if (game && !game.over && !anyOverlay()) game.endPhase(); };
  undoBtn.onclick = () => {
    if (!game || game.over || anyOverlay()) return;
    const u = game.undoMove();
    if (u) { selected = u; reachable = game.reachable(u); inspected = { q: u.q, r: u.r }; focus(u); renderInspector(); }
    else { selected = null; }
    draw(); syncSel(); syncUndo();
  };

  function syncUndo() {
    const inMove = game && game.phase === "move";
    undoBtn.classList.toggle("hidden", !inMove);
    undoBtn.disabled = !game || !game.canUndo();
  }
  function syncHud() {
    if (!game) {
      $("turnPill").textContent = "—";
      $("sidePill").textContent = ""; $("sidePill").style.background = "transparent";
      $("phaseTxt").textContent = "Choose a scenario";
      actBtn.textContent = "End Movement";
      undoBtn.classList.add("hidden");
      $("sel").innerHTML = `<span class="muted">Pick a battle to begin.</span>`;
      return;
    }
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
    if (!game) return;
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
  let resumedCamera = false; // suppress the first focusActive() after a resume

  function startGame(def, saved) {
    DEF = def;
    document.body.classList.remove("nogame"); // the board needs its real size
    if (saved) {
      try { game = Game.restore(DEF, saved.game); }
      catch (e) { clearSave(); saved = null; game = new Game(DEF); }
    } else {
      game = new Game(DEF);
    }
    selected = null; reachable = new Map(); inspected = null; pending = null;
    pointers.clear(); drag = null; pinch = null; zoomBeforeFit = null;
    resumedCamera = false;
    renderInspector();
    populateHelp();

    renderer = makeRenderer();
    renderer.setBoard([...game.board.values()]);
    renderer.resize(boardWrap);
    const c = saved && saved.camera;
    if (c && Number.isFinite(c.zoom) && c.cam &&
        Number.isFinite(c.cam.x) && Number.isFinite(c.cam.y)) {
      // cam first, then setZoom: setZoom clamps the zoom and re-clamps cam for
      // the CURRENT viewport, so a phone save opens sanely on a tablet.
      renderer.cam = { x: c.cam.x, y: c.cam.y };
      renderer.setZoom(c.zoom);
      resumedCamera = true;
    } else {
      renderer.frameDefault();
    }

    game.events.on("sideChange", () => { selected = null; showPass(); });
    game.events.on("phase", () => {
      selected = null; reachable = new Map(); inspected = null;
      focusActive(); renderInspector(); syncHud(); draw(); syncFit();
    });
    game.events.on("gameover", ({ winner, reason }) => {
      const fac = winner ? factionById(winner) : null;
      $("winTitle").textContent = fac ? fac.name + " Victory" : "Draw";
      $("winTitle").style.color = fac ? fac.color : "#fff";
      $("winSub").textContent = reason;
      show("winOv");
    });
    // Autosave. "phase" also covers side changes (every sideChange is followed
    // by a phase emit); "gameover" frees the slot — a finished game is done.
    game.events.on("move", save);
    game.events.on("undo", save);
    game.events.on("combat", save);
    game.events.on("phase", save);
    game.events.on("gameover", clearSave);

    hide("cbOv"); hide("winOv");
    if (!resumedCamera) focusActive();
    draw(); syncHud(); syncFit(); showPass();
    global.__game = game; global.__renderer = renderer; // for smoke-testing
    save(); // starting (or resuming) a game claims the one slot immediately
  }

  if (global.ResizeObserver) new global.ResizeObserver(relayout).observe(boardWrap);
  global.addEventListener("resize", relayout);
  global.addEventListener("orientationchange", relayout);
  // Catch camera-only changes (panning saves nothing per frame): persist when
  // the app goes to the background — the pair of events that actually fires on
  // iOS home-screen web apps, where beforeunload does not.
  global.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });

  syncHud();
  showStart();
})(typeof window !== "undefined" ? window : globalThis);
