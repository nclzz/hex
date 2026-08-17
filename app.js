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
  // v2: Napoleon at War state (mandatory combat, advances, reinforcements).
  const SAVE_KEY = "hexwar.save.v2";
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
  let targets = [];             // combat phase: enemy units grouped into the next battle
  let inspected = null; // hex {q,r} shown in the terrain inspector
  const factionById = (id) => DEF.factions.find((f) => f.id === id);
  // Is this enemy unit still a legal target this phase?
  function attackable(u) {
    if (game.attackedIds && game.attackedIds.has(u.id)) return false;
    return game.attackersFor(u).length > 0;
  }

  // Below these hex sizes the counter glyphs would be smaller than they are
  // legible, so we drop detail instead of drawing unreadable text.
  const LOD_STATS = 14, LOD_GLYPH = 9, LOD_STAR = 12;

  function makeRenderer() {
    return new global.HexRenderer(canvas, {
      orientation: DEF.orientation,
      terrainColor: (g, hex) => DEF.terrain[hex.terrain].color,
      decorateHex: (ctx, g, hex, c, size) => {
        if (g.isExitHex && g.isExitHex(hex.q, hex.r)) {
          // Exit hexes: an upward chevron in the exiting side's colour.
          const fac = factionById(DEF.exitHexes.faction);
          ctx.strokeStyle = fac.color; ctx.lineWidth = Math.max(2, size * 0.12);
          ctx.lineCap = "round";
          const w = size * 0.34, h = size * 0.3;
          for (const dy of [-size * 0.12, size * 0.24]) {
            ctx.beginPath();
            ctx.moveTo(c.x - w, c.y + dy + h / 2);
            ctx.lineTo(c.x, c.y + dy - h / 2);
            ctx.lineTo(c.x + w, c.y + dy + h / 2);
            ctx.stroke();
          }
          return;
        }
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
        // A unit type may carry its own counter colour (e.g. Prussians within
        // the Allied faction); the faction colour is the default.
        ctx.fillStyle = t.color || fac.color;
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
        // Spent units dim: moved (or ZOC-locked) in Movement, attacked in
        // Combat, and enemies whose battle has already been fought.
        const mine = u.faction === g.activeFaction;
        const dim =
          (g.phase === "move" && mine && (u.moved || u.locked)) ||
          (g.phase === "combat" && mine && u.acted) ||
          (g.phase === "combat" && !mine && game.attackedIds && game.attackedIds.has(u.id));
        if (dim) {
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
  // The battle just fought, and the advances it opened. `targets` is emptied
  // the moment the dice land, so without these the board would go blank exactly
  // when the advance prompt asks the player to read it.
  let lastBattle = null;      // {attackers:[{q,r}], defenders:[{q,r}]}
  let advanceCandidates = []; // [{unitId, from, to, accent}] — one per button
  let activeCandidate = null; // unitId being previewed from its button
  // Hues that read against the terrain palette and don't collide with the gold
  // grouping ring, the mandatory red or the amber "still owes an attack".
  const ADV_ACCENTS = ["#4fd1e0", "#e07ad1", "#9ee04f", "#f0913e"];
  const accentA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  function highlights() {
    const hs = [];
    if (game.phase === "move" && selected) {
      for (const [, cell] of reachable) hs.push({ hex: cell, fill: "rgba(60,150,60,.32)" });
    }
    if (game.phase === "combat") {
      const un = game.unresolvedCombat ? game.unresolvedCombat() : { mustAttack: [], mustBeAttacked: [] };
      const mustIds = new Set(un.mustBeAttacked.map((u) => u.id));
      for (const e of game.enemiesOf(game.activeFaction)) {
        if (!attackable(e)) continue;
        // Mandatory battles burn brighter than merely available ones.
        hs.push(mustIds.has(e.id)
          ? { hex: e, stroke: "rgba(230,30,30,.95)", lineWidth: 4, scale: 0.96 }
          : { hex: e, stroke: "rgba(210,40,40,.55)", lineWidth: 2, scale: 0.96 });
      }
      // Your own units that still owe an attack.
      for (const u of un.mustAttack)
        hs.push({ hex: u, stroke: "rgba(240,180,40,.9)", lineWidth: 2.5, scale: 0.9 });
      // The battle being grouped right now.
      for (const t of targets)
        hs.push({ hex: t, fill: "rgba(244,210,58,.3)", stroke: "#f4d23a", lineWidth: 3, scale: 0.93 });
      // …and every friendly unit that will join it — the live chip selection
      // once the dialog is open, everyone eligible before that. A dashed ring
      // is a gun firing from range.
      if (targets.length) {
        const joining = pending
          ? pending.eligible.filter((a) => pending.chosen.has(a.id))
          : eligibleFor(targets);
        for (const a of joining) {
          const bombarding = targets.every((d) => Hx().distance(a, d) >= 2);
          hs.push({ hex: a, stroke: "rgba(255,255,255,.95)", lineWidth: 3,
                    scale: 0.88, dash: bombarding ? [5, 4] : null });
        }
      }
      // The battle just resolved: keep its ground marked while the result line
      // and the advance prompt are being read.
      if (lastBattle) {
        for (const d of lastBattle.defenders)
          hs.push({ hex: d, fill: "rgba(226,64,44,.26)", stroke: "rgba(226,64,44,.85)",
                    lineWidth: 3, scale: 0.93 });
        for (const a of lastBattle.attackers)
          hs.push({ hex: a, stroke: "rgba(255,255,255,.6)", lineWidth: 2, scale: 0.86 });
      }
      // Every advance on offer, tied by colour to the button that takes it: a
      // dashed ring on the unit, the cleared hex it would move into filled.
      for (const c of advanceCandidates) {
        const on = activeCandidate === c.unitId;
        hs.push({ hex: c.to, fill: accentA(c.accent, on ? 0.5 : 0.3),
                  stroke: c.accent, lineWidth: on ? 5 : 3, scale: 0.94 });
        hs.push({ hex: c.from, stroke: c.accent, lineWidth: on ? 5 : 3,
                  scale: 0.86, dash: [6, 4] });
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
    // A rotation can flip the sheet between the bottom edge and the side rail,
    // which moves which margin the camera has to keep clear.
    if (combatSheetOpen()) syncSheetInsets();
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

  // ----------------------- the battle sheet's geometry ----------------------
  // The battle card docks to an edge of the board rather than covering it. Tell
  // the camera WHICH edge and how much, so every bit of framing it does happens
  // in the strip the player can actually see. Landscape on a phone has no
  // vertical room to give away, so there the card becomes a side rail — the
  // media query below must stay in step with the one in index.html.
  const RAIL_MQ = "(orientation: landscape) and (max-height: 560px)";
  const combatSheetOpen = () => $("cbOv").classList.contains("show");
  const railMode = () => !!(global.matchMedia && global.matchMedia(RAIL_MQ).matches);

  // The Fit and ? buttons sit over the top of the board permanently, and the
  // toast lane runs just below them — a battle framed up there reads no better
  // than one framed behind the card. Reserve the button row; the toast is
  // transient enough not to be worth the board space it would cost.
  const TOP_CHROME_PX = 40;

  function syncSheetInsets() {
    if (!renderer) return;
    const card = $("cbCard");
    let ins = { top: 0, right: 0, bottom: 0, left: 0 };
    if (combatSheetOpen())
      ins = railMode()
        ? { top: TOP_CHROME_PX, right: card.offsetWidth, bottom: 0, left: 0 }
        : { top: TOP_CHROME_PX, right: 0, bottom: card.offsetHeight, left: 0 };
    renderer.setInsets(ins);
    // The hex inspector lives in the bottom-left corner; lift it clear.
    document.documentElement.style.setProperty("--cb-inset-bottom", ins.bottom + "px");
    draw(); syncFit();
  }

  // ------------------------------- input -----------------------------------
  // A tap selects/moves; a drag pans; two fingers (or the wheel) zoom. The tap
  // only commits on pointerup, once we know the pointer never became a drag.
  const TAP_SLOP = 10; // CSS px of travel still counted as a tap
  const LONG_PRESS_MS = 500; // hold this long (without moving) to inspect a hex
  const pointers = new Map(); // pointerId -> {x,y}
  let drag = null;   // {id, downX, downY, lastX, lastY, moved}
  let pinch = null;  // {ids, dist, midX, midY}
  let longPress = null; // {timer, fired} — pending press-and-hold inspection

  function cancelLongPress() {
    if (longPress) { clearTimeout(longPress.timer); longPress = null; }
  }
  // Open the inspector on the hex under (x,y) — the press-and-hold payoff.
  function inspectAt(x, y) {
    const hex = renderer && renderer.pick(game, x, y);
    if (!hex) return false;
    inspected = { q: hex.q, r: hex.r };
    renderInspector(); draw();
    if (global.navigator && global.navigator.vibrate) {
      try { global.navigator.vibrate(15); } catch (e) { /* no haptics */ }
    }
    return true;
  }

  function localPt(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  // The battle sheet is deliberately NOT in this list: it docks to an edge and
  // leaves the board live, so the player can look around before committing to a
  // battle or an advance. Board taps stay suppressed (see commitTap) — only
  // panning, zooming and press-and-hold inspection remain. A finished game is
  // treated the same way: the victory dialog blocks while shown, and once
  // dismissed the board stays live for studying the final position.
  function boardBusy() { return !game || anyBlockingOverlay(); }

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
    if (ev.button != null && ev.button !== 0) return; // right/middle: contextmenu handles it
    const p = localPt(ev);
    pointers.set(ev.pointerId, p);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not captureable */ }
    if (pointers.size === 1) {
      drag = { id: ev.pointerId, downX: p.x, downY: p.y, lastX: p.x, lastY: p.y, moved: false };
      cancelLongPress();
      longPress = { fired: false, timer: setTimeout(() => {
        if (longPress) { longPress.fired = true; inspectAt(p.x, p.y); }
      }, LONG_PRESS_MS) };
    } else if (pointers.size === 2) {
      cancelLongPress();
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
      if (!drag.moved && Math.hypot(p.x - drag.downX, p.y - drag.downY) > TAP_SLOP) {
        drag.moved = true;
        cancelLongPress(); // a drag is a pan, not a hold
      }
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
      const held = longPress && longPress.fired; // the hold already inspected
      cancelLongPress();
      if (!d.moved && !held && ev.type === "pointerup") commitTap(d.downX, d.downY);
      else syncFit();
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  // Desktop shortcut: right-click inspects the hex under the cursor (and the
  // suppressed menu also keeps mobile long-press from popping a context menu).
  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (boardBusy()) return;
    const p = localPt(ev);
    cancelLongPress();
    inspectAt(p.x, p.y);
  });

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
    // The battle is decided: nothing left to play, so a plain tap inspects
    // the final position (tapping the inspected hex again dismisses it).
    if (game.over) {
      const hex = renderer.pick(game, x, y);
      if (hex && !(inspected && inspected.q === hex.q && inspected.r === hex.r)) {
        inspectAt(x, y);
      } else if (inspected) {
        inspected = null; renderInspector(); draw();
      }
      return;
    }
    // With the battle sheet open the board is for reading, not for regrouping:
    // openCombat() already snapshotted the battle being fought.
    if (combatSheetOpen()) {
      if (inspected) { inspected = null; renderInspector(); draw(); }
      return;
    }
    const hex = renderer.pick(game, x, y);
    if (!hex) {
      selected = null; reachable = new Map(); inspected = null;
      renderInspector(); draw(); syncSel(); return;
    }
    onHex(hex.q, hex.r);
  }

  function onHex(q, r) {
    // A plain tap plays the game; inspecting is press-and-hold (or
    // right-click). Any tap dismisses an open inspector.
    if (inspected) { inspected = null; renderInspector(); }
    const u = game.unitAt(q, r);
    if (game.phase === "move") {
      if (selected && reachable.has(global.Hex.key(q, r))) {
        game.moveUnit(selected, q, r);
        selected = null; reachable = new Map();
        focus({ q, r });
        draw(); syncSel(); syncUndo(); syncExit(); return;
      }
      if (u && game.canMove(u)) {
        selected = u; reachable = game.reachable(u); focus(u);
      } else {
        if (u && u.faction === game.activeFaction && u.locked)
          flash("Locked in enemy ZOC — must stand and fight. (Hold a hex to inspect it.)");
        selected = null; reachable = new Map();
      }
      draw(); syncSel(); syncExit();
    } else { // combat: taps on enemies group the next battle
      if (u && u.faction !== game.activeFaction) {
        const i = targets.indexOf(u);
        if (i >= 0) targets.splice(i, 1);
        else if (attackable(u)) { targets.push(u); focus(u); }
        else flash(game.attackedIds && game.attackedIds.has(u.id)
          ? "That unit has already been attacked this phase."
          : "No friendly unit is in range of that enemy.");
      } else if (!u) {
        targets = []; selected = null;
      }
      draw(); syncSel(); syncAttack();
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
    if (game.isExitHex && game.isExitHex(q, r)) {
      const ex = DEF.exitHexes;
      objEl.textContent = `▲ ${factionById(ex.faction).name} exit hex — march ` +
        `${ex.target} units off the map edge to fulfil the victory conditions.`;
      objEl.hidden = false;
    } else if (game.isObjective(q, r)) {
      const owner = factionById((game.objectives.find((o) => o.q === q && o.r === r) || {}).owner);
      objEl.textContent = `★ Objective — ${owner ? owner.name : "a side"} wins by holding this hex.`;
      objEl.hidden = false;
    } else objEl.hidden = true;

    const unitEl = el.querySelector(".hiUnit");
    const u = game.unitAt(q, r);
    if (u) {
      const fac = factionById(u.faction), ut = game.typeOf(u);
      let tag = "", tagClass = "tag";
      if (game.phase === "move" && u.faction === game.activeFaction) {
        if (u.locked) { tag = " Locked in enemy ZOC — must stand and fight."; tagClass = "tag warn"; }
        else if (u.moved) tag = " (moved)";
      } else if (game.phase === "combat" && u.faction === game.activeFaction && u.acted) {
        tag = " (attacked)";
      }
      unitEl.innerHTML = `${fac.name} ${ut.name} · CS ${ut.combat} · MA ${ut.move}` +
        ((ut.range || 1) > 1 ? ` · Range ${ut.range}` : "") +
        (tag ? `<span class="${tagClass}">${tag}</span>` : "");
      unitEl.hidden = false;
    } else unitEl.hidden = true;

    el.classList.remove("hidden");
  }
  $("hexInfoClose").onclick = () => { inspected = null; renderInspector(); draw(); };

  // --------------------------- combat dialog -------------------------------
  // pending: { defenders:[units], eligible:[units], chosen:Set<unitId> }
  let pending = null;
  const Hx = () => global.Hex;
  const colLabel = (col) =>
    global.NAW_COMMON ? global.NAW_COMMON.columnLabel(col) : col;
  // Rule [6.2] puts no floor on the announced ratio, and the engine honours
  // that, but every column below even odds is strictly worse for the attacker
  // — no result the higher columns can't already give, and Ae taking over —
  // so the "Lower odds" control stops here.
  const LOWER_FLOOR_COLUMN = "1:1";

  // The five CRT results from the attacker's point of view: the colour class
  // shared by the odds strip and the verdict banner, a battle-cry headline,
  // and whether the result is dramatic enough to shake the banner.
  const CODES = {
    De: { cls: "good",  head: "Defenders destroyed!", big: true  },
    Dr: { cls: "good",  head: "Defenders fall back!", big: false },
    Ex: { cls: "mixed", head: "Bloody exchange!",     big: true  },
    Ar: { cls: "bad",   head: "Attack repulsed!",     big: false },
    Ae: { cls: "bad",   head: "Attack shattered!",    big: true  },
  };
  let rolling = false; // a die is tumbling: the card's inputs are committed

  // The die face: pips on a 3×3 grid, indexed row-major.
  const PIP_FACES = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
  const dieEl = $("die");
  for (let i = 0; i < 9; i++) {
    const p = document.createElement("span"); p.className = "pip"; dieEl.appendChild(p);
  }
  function setDieFace(n) {
    const on = PIP_FACES[n - 1];
    for (let i = 0; i < 9; i++) dieEl.children[i].classList.toggle("on", on.includes(i));
  }

  // Haptics, where the device offers them (same guard as the hex inspector).
  const buzz = (pattern) => {
    if (global.navigator && global.navigator.vibrate) {
      try { global.navigator.vibrate(pattern); } catch (e) { /* no haptics */ }
    }
  };
  // A pocket sound kit (WebAudio, no assets): a woody tick per tumble, a thud
  // on landing, a short rise or fall as the verdict pops. Created lazily
  // inside the Attack! gesture, so autoplay policies are satisfied; every
  // call is guarded — no audio support just means a silent roll.
  let audio = null;
  function sfx(kind) {
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      if (!audio) audio = new AC();
      if (audio.state === "suspended") audio.resume();
      const t = audio.currentTime;
      const note = (type, f0, f1, vol, dur, at) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.connect(g); g.connect(audio.destination);
        o.type = type;
        o.frequency.setValueAtTime(f0, t + at);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
        g.gain.setValueAtTime(vol, t + at);
        g.gain.exponentialRampToValueAtTime(0.001, t + at + dur);
        o.start(t + at); o.stop(t + at + dur + 0.02);
      };
      if (kind === "tick") note("square", 1900 + Math.random() * 700, 1400, 0.04, 0.045, 0);
      else if (kind === "land") note("triangle", 170, 70, 0.22, 0.16, 0);
      else if (kind === "good") { note("triangle", 392, 392, 0.12, 0.09, 0); note("triangle", 587, 587, 0.12, 0.14, 0.09); }
      else if (kind === "bad") { note("triangle", 311, 311, 0.12, 0.09, 0); note("triangle", 208, 208, 0.12, 0.16, 0.09); }
      else if (kind === "mixed") note("triangle", 330, 294, 0.12, 0.18, 0);
    } catch (e) { /* silence is fine */ }
  }

  // Eligible attackers for a battle: every unacted friendly unit in range of
  // at least one of the defenders.
  function eligibleFor(defenders) {
    const list = [];
    for (const d of defenders)
      for (const a of game.attackersFor(d))
        if (!list.includes(a)) list.push(a);
    return list;
  }
  // Mirrors the engine's battle validation so the Attack! button can grey out.
  function battleValid(defenders, chosen) {
    if (!chosen.length) return false;
    if (defenders.length > 1) {
      for (const d of defenders)
        if (!chosen.some((a) => Hx().distance(a, d) === 1)) return false;
    }
    return true;
  }

  function openCombat(defenders) {
    pending = {
      defenders,
      eligible: eligibleFor(defenders),
      chosen: null,
      lower: 0, // voluntary ratio reduction, announced before the roll [6.2]
    };
    pending.chosen = new Set(pending.eligible.map((a) => a.id)); // all in by default
    // Attacker chips (the player picks who joins the battle).
    const strip = $("cbUnits");
    strip.innerHTML = "";
    strip.hidden = pending.eligible.length <= 1;
    for (const a of pending.eligible) {
      const t = game.typeOf(a);
      const b = document.createElement("button");
      b.className = "cbChip";
      const bombarding = defenders.every((d) => Hx().distance(a, d) >= 2);
      b.innerHTML = `${t.glyph} ${t.combat}·${t.move}` +
        (bombarding ? ` <span class="r">@${Hx().distance(a, defenders[0])}</span>` : "");
      b.onclick = () => {
        if (rolling) return; // the die is in the air — the battle is committed
        if (pending.chosen.has(a.id)) pending.chosen.delete(a.id);
        else pending.chosen.add(a.id);
        b.classList.toggle("off", !pending.chosen.has(a.id));
        refreshCombatCard();
        draw(); // the board rings track the chips live behind the dialog
      };
      strip.appendChild(b);
    }
    $("cbTitle").textContent = "Resolve Combat";
    $("cbInfo").style.display = "";
    $("dieBox").textContent = "";
    rolling = false;
    $("rollZone").hidden = true;
    $("verdict").hidden = true;
    $("die").classList.remove("landed");
    $("cancelBtn").disabled = false;
    $("cbBtns").style.display = "flex";
    $("advBox").hidden = true;
    $("contBtn").style.display = "none";
    lastBattle = null;
    refreshCombatCard();
    $("cbCard").classList.toggle("collapsed", cbCollapsed);
    $("cbCard").scrollTop = 0;
    show("cbOv");
    // The sheet docks over the map without touching the zoom: it tells the
    // camera which strip is still uncovered, then pans — never rescales — the
    // least amount that keeps the battle out from behind the card.
    syncSheetInsets();
    if (renderer && renderer.ensureHexesVisible([...defenders, ...pending.eligible])) {
      draw(); syncFit();
    }
  }

  function refreshCombatCard() {
    const { defenders, eligible, chosen } = pending;
    const picked = eligible.filter((a) => chosen.has(a.id));
    const atk = picked.length ? game.attackerStrength(picked) : 0;
    const def = defenders.reduce((s, d) => s + game.defenderStrength(d), 0);
    const bomb = picked.filter((a) => defenders.every((d) => Hx().distance(a, d) >= 2)).length;
    $("cbAtk").textContent = `${atk}  (${picked.length} unit${picked.length === 1 ? "" : "s"}` +
      `${bomb ? `, ${bomb} bombarding` : ""})`;
    $("cbBomb").hidden = bomb === 0;
    if (defenders.length === 1) {
      const d = defenders[0], t = game.terrainAt(d.q, d.r);
      $("cbDef").textContent = `${factionById(d.faction).name} ${game.typeOf(d).name} — CS ${game.combat(d)}`;
      $("cbTer").textContent = `${t.name} (×${t.defMult}) → def ${def}`;
    } else {
      $("cbDef").textContent = `${defenders.length} units — one combined battle`;
      $("cbTer").textContent = `combined defense (with terrain) → ${def}`;
    }
    const valid = battleValid(defenders, picked);
    let column = null, canLower = false;
    if (valid) {
      const cols = game.def.crt.columns;
      column = game.oddsColumn(atk, def);
      let i = cols.indexOf(column);
      const floor = Math.max(0, cols.indexOf(LOWER_FLOOR_COLUMN));
      // never below even odds — and nothing to lower if we start there or worse
      pending.lower = Math.max(0, Math.min(pending.lower, i - floor));
      i -= pending.lower;
      column = cols[i];
      canLower = i > floor;
    }
    $("odds").textContent = valid
      ? colLabel(column) + (pending.lower ? " (lowered)" : "")
      : "—";
    // No greyed-out button: the control only appears when there is actually
    // a column to step down to (the reset stays while a lowering is active).
    $("lowerBtn").hidden = !valid || !canLower;
    $("lowerReset").hidden = !pending.lower;
    $("dieBox").textContent = valid ? ""
      : "Not legal: every defender needs an adjacent attacker in the battle.";
    $("resolveBtn").disabled = !valid;
    renderCrtStrip(valid ? column : null);
  }

  // The odds strip: the current CRT column laid flat, one cell per die face,
  // coloured by what that face would do to the attacker. It updates live as
  // chips and "Lower odds" change the column — the stakes are visible before
  // the die is ever thrown.
  function renderCrtStrip(column) {
    const strip = $("crtStrip");
    strip.hidden = $("crtCap").hidden = !column;
    if (!column) { strip.innerHTML = ""; return; }
    strip.innerHTML = "";
    for (const [i, code] of game.def.crt.table[column].entries()) {
      const cell = document.createElement("div");
      cell.className = `crtCell ${(CODES[code] || { cls: "mixed" }).cls}`;
      cell.innerHTML = `<span class="d">${i + 1}</span><span class="c">${code}</span>`;
      strip.appendChild(cell);
    }
  }

  // The attacker may deliberately fight at lower odds [6.2].
  $("lowerBtn").onclick = () => { if (pending) { pending.lower++; refreshCombatCard(); } };
  $("lowerReset").onclick = () => { if (pending) { pending.lower = 0; refreshCombatCard(); } };
  $("cancelBtn").onclick = () => { pending = null; closeCombatSheet(); draw(); syncSel(); syncAttack(); };
  // Attack! throws the die: it tumbles with decelerating ticks — random faces,
  // a wobble, a click per bounce — then resolve() lands it on the real face.
  $("resolveBtn").onclick = () => {
    if (!pending || rolling) return;
    rolling = true;
    $("resolveBtn").disabled = true;
    $("cancelBtn").disabled = true;
    $("lowerBtn").hidden = true; // committed: the odds can no longer change
    $("lowerReset").hidden = true;
    $("rollZone").hidden = false;
    dieEl.classList.remove("landed");
    syncSheetInsets(); // the die grew the card
    let ticks = 0, delay = 45;
    const tumble = () => {
      setDieFace(1 + Math.floor(Math.random() * 6));
      dieEl.style.transform = `rotate(${(Math.random() * 36 - 18).toFixed(1)}deg)`;
      sfx("tick");
      if (++ticks < 9) { delay *= 1.28; setTimeout(tumble, delay); }
      else resolve();
    };
    tumble();
  };
  // The sheet has said everything it had to: close it and hand back the board.
  function dismissBattle() { closeCombatSheet(); draw(); syncSel(); syncAttack(); syncHud(); }
  $("contBtn").onclick = dismissBattle;

  function resolve() {
    const picked = pending.eligible.filter((a) => pending.chosen.has(a.id));
    // Snapshot the ground BEFORE the engine moves anyone: the result line and
    // the advance prompt are read against where the battle was fought.
    const ground = {
      attackers: picked.map((a) => ({ q: a.q, r: a.r })),
      defenders: pending.defenders.map((d) => ({ q: d.q, r: d.r })),
    };
    const res = game.resolveCombat(pending.defenders, picked, { lower: pending.lower });
    pending = null;
    targets = [];
    if (!res.ok) { // the engine refused (should be rare — the card validates)
      rolling = false;
      closeCombatSheet(); flash(res.reason); draw(); syncSel(); syncAttack();
      return;
    }
    lastBattle = ground;
    // Land the die on the face the engine actually rolled: settle bounce,
    // thud, and the matching cell of the odds strip lights while the misses
    // fade — the strip the player has been staring at explains the outcome.
    setDieFace(res.die);
    dieEl.style.transform = "";
    dieEl.classList.add("landed");
    sfx("land"); buzz(30);
    for (const [i, cell] of [...$("crtStrip").children].entries())
      cell.classList.add(i === res.die - 1 ? "hit" : "dud");
    flash(`${colLabel(res.column)} · roll ${res.die} → ${res.note}`);
    $("cbBtns").style.display = "none";
    draw(); syncHud();
    // The verdict pops a beat after the die settles — land, then the news.
    setTimeout(() => {
      rolling = false;
      if (!combatSheetOpen()) return; // e.g. the battle ended the game
      showVerdict(res);
      if (res.advance && game.pendingAdvance) showAdvance();
      else { $("contBtn").style.display = "block"; syncSheetInsets(); }
      // On a short screen the card overflows: keep the die and the lit strip
      // cell in view, right above the docked verdict.
      $("cbCard").scrollTop = $("cbCard").scrollHeight;
      draw(); syncHud();
    }, 450);
  }

  // The outcome in plain words, coloured from the roller's point of view.
  function showVerdict(res) {
    const meta = CODES[res.code] || { cls: "mixed", head: res.code, big: false };
    let head = meta.head, big = meta.big;
    // The engine's note outranks the code where they diverge: a bombardment
    // shrugged off costs the guns nothing, and a defender with no way out is
    // destroyed, not merely pushed back.
    if ((res.code === "Ae" || res.code === "Ar") && /^Bombardment/.test(res.note)) {
      head = "Bombardment fails"; big = false;
    }
    if (res.code === "Dr" && /eliminated/.test(res.note)) {
      head = "Defenders trapped!"; big = true;
    }
    const v = $("verdict");
    v.className = meta.cls + (big ? " big" : "");
    v.querySelector(".vHead").textContent = head;
    v.querySelector(".vSub").textContent =
      `Die ${res.die} at ${colLabel(res.column)} — ${res.note}`;
    v.hidden = false;
    sfx(meta.cls);
    if (big) buzz([20, 40, 30]);
  }

  // ----------------------- advance after combat -----------------------------
  function showAdvance() {
    const p = game.pendingAdvance;
    // Since Ar/Ae results, the DEFENDER may be the one advancing — say whose
    // decision this is (the device may need a quick hand-over).
    const fac = factionById(p.faction);
    $("advBox").querySelector(".advLabel").textContent =
      `${fac.name}: a hex was cleared — advance into it?`;
    const box = $("advBtns");
    box.innerHTML = "";
    advanceCandidates = [];
    activeCandidate = null;
    for (const id of p.unitIds) {
      const u = game.units[id], t = game.typeOf(u);
      const hex = p.hexes.find((h) => Hx().distance(u, h) === 1);
      if (!hex) continue;
      // Colour ties the button to a place on the map: "Advance A 5·3" says
      // nothing about WHICH way, and that is the whole decision.
      const accent = ADV_ACCENTS[advanceCandidates.length % ADV_ACCENTS.length];
      advanceCandidates.push({
        unitId: u.id, from: { q: u.q, r: u.r }, to: { q: hex.q, r: hex.r }, accent,
      });
      const b = document.createElement("button");
      b.innerHTML = `<i style="background:${accent}"></i>Advance ${t.glyph} ${t.combat}·${t.move}`;
      b.onclick = () => { game.advanceAfterCombat(u, hex.q, hex.r); finishAdvance(); };
      // Touch (or hover) a button to preview that move on the board first.
      const preview = (on) => {
        activeCandidate = on ? u.id : null;
        b.classList.toggle("on", on);
        draw();
      };
      b.addEventListener("pointerenter", () => preview(true));
      b.addEventListener("pointerleave", () => preview(false));
      b.addEventListener("pointerdown", () => preview(true));
      box.appendChild(b);
    }
    const hold = document.createElement("button");
    hold.className = "hold";
    hold.textContent = "Stand fast";
    hold.onclick = () => { game.declineAdvance(); finishAdvance(); };
    box.appendChild(hold);
    $("advBox").hidden = false;
    // The card grew (the advance buttons appeared): re-measure the covered
    // strip, then pan just enough to keep the cleared hexes and every unit
    // that could take one in view — the zoom stays the player's.
    syncSheetInsets();
    if (renderer && renderer.ensureHexesVisible(
          [...p.hexes, ...advanceCandidates.map((c) => c.from)])) {
      draw(); syncFit();
    }
  }
  // Advance taken or declined — that was the last decision on the card, so
  // it closes right away (closeCombatSheet clears the advance highlights).
  function finishAdvance() { dismissBattle(); }
  // A save made mid-prompt restores with the advance still pending: reopen it.
  function reopenAdvance() {
    $("cbTitle").textContent = "Advance After Combat";
    $("cbInfo").style.display = "none";
    $("rollZone").hidden = true;
    $("verdict").hidden = true;
    $("dieBox").textContent = "The last battle cleared a hex.";
    $("cbBtns").style.display = "none";
    $("contBtn").style.display = "none";
    $("cbCard").classList.toggle("collapsed", cbCollapsed);
    show("cbOv"); // shown first: showAdvance() measures the card to inset the camera
    showAdvance();
  }

  // ------------------------ the sheet's own controls ------------------------
  // Collapsing folds the reference rows away and hands the map the space; the
  // decision row (the buttons, the result) always stays. Instant, like every
  // other state change in this app.
  let cbCollapsed = false;
  function closeCombatSheet() {
    hide("cbOv");
    lastBattle = null;
    advanceCandidates = [];
    activeCandidate = null;
    syncSheetInsets();
  }
  (function wireSheetHandle() {
    const h = $("cbHandle");
    let downY = null;
    h.addEventListener("pointerdown", (ev) => {
      downY = ev.clientY;
      try { h.setPointerCapture(ev.pointerId); } catch (e) { /* not captureable */ }
    });
    h.addEventListener("pointerup", (ev) => {
      if (downY == null) return;
      const dy = ev.clientY - downY;
      downY = null;
      // A tap toggles; a deliberate drag says which way.
      cbCollapsed = Math.abs(dy) <= TAP_SLOP ? !cbCollapsed : dy > 0;
      $("cbCard").classList.toggle("collapsed", cbCollapsed);
      syncSheetInsets();
    });
    h.addEventListener("pointercancel", () => { downY = null; });
  })();

  // ------------------------------ overlays ---------------------------------
  const OVERLAYS = ["startOv", "wizOv", "passOv", "cbOv", "winOv", "helpOv"];
  const show = (id) => $(id).classList.add("show");
  const hide = (id) => $(id).classList.remove("show");
  // Every overlay blocks the HUD buttons; only the modal ones block the board.
  const anyOverlay = () => OVERLAYS.some((id) => $(id).classList.contains("show"));
  const anyBlockingOverlay = () =>
    OVERLAYS.some((id) => id !== "cbOv" && $(id).classList.contains("show"));

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
    // A save written mid-advance resumes with the decision still owed.
    if (game && game.pendingAdvance) reopenAdvance();
  });
  $("help").onclick = () => show("helpOv");
  $("helpClose").onclick = () => hide("helpOv");
  $("newBtn").onclick = () => showStart();
  // The victory screen closes (× or a tap on the scrim) so the final position
  // can be studied; the Result pill on the board brings it back.
  const closeWin = () => {
    hide("winOv");
    $("resultBtn").classList.remove("hidden");
    draw(); syncFit();
  };
  $("winClose").onclick = closeWin;
  $("winOv").addEventListener("pointerdown", (ev) => {
    if (ev.target === $("winOv")) closeWin();
  });
  $("resultBtn").onclick = () => { $("resultBtn").classList.add("hidden"); show("winOv"); };
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
      b.onclick = () => showWizard(def);
      list.appendChild(b);
    }
    closeCombatSheet(); hide("winOv"); hide("wizOv");
    $("resultBtn").classList.add("hidden");
    document.body.classList.add("nogame");
    document.body.classList.remove("over");
    show("startOv");
  }

  // ------------------------- pre-game wizard -------------------------------
  // Before a new battle begins, one card spells out how this scenario is won
  // — a row per condition from def.winConditions (def.brief is the fallback).
  // Resuming a saved game skips it; the players already know their goal.
  let wizDef = null;
  function showWizard(def) {
    wizDef = def;
    $("wizTitle").textContent = def.title;
    $("wizMeta").textContent =
      `${def.maxTurns} game-turns · ${def.factions[0].name} moves first`;
    const list = $("wizList");
    list.innerHTML = "";
    const conds = def.winConditions || [{ text: def.brief || "" }];
    for (const c of conds) {
      const row = document.createElement("div"); row.className = "wizCond";
      const who = document.createElement("span"); who.className = "who";
      const fac = c.side && def.factions.find((f) => f.id === c.side);
      who.textContent = fac ? fac.short : (c.label || "DRAW");
      if (fac) who.style.background = fac.color;
      const tx = document.createElement("div"); tx.className = "tx";
      tx.textContent = c.text;
      row.appendChild(who); row.appendChild(tx);
      list.appendChild(row);
    }
    hide("startOv");
    show("wizOv");
  }
  $("wizStart").onclick = () => { hide("wizOv"); startGame(wizDef); };
  $("wizBack").onclick = () => showStart();

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
  const actBtn = $("actBtn"), undoBtn = $("undoBtn"), attackBtn = $("attackBtn");
  actBtn.onclick = () => {
    if (!game || game.over || anyOverlay()) return;
    const r = game.endPhase();
    if (r && r.ok === false) {
      const un = r.unresolved;
      if (un) {
        const n = un.mustBeAttacked.length || un.mustAttack.length;
        flash(`Combat is compulsory — ${n} mandatory battle${n === 1 ? "" : "s"} left. ` +
              "Tap the highlighted enemies.");
        focus(un.mustBeAttacked[0] || un.mustAttack[0]);
      } else flash(r.reason);
      draw(); syncSel();
    }
  };
  attackBtn.onclick = () => {
    if (!game || game.over || anyOverlay() || game.phase !== "combat") return;
    if (targets.length) openCombat(targets.slice()); // openCombat frames the battle
  };
  const exitBtn = $("exitBtn");
  exitBtn.onclick = () => {
    if (!game || game.over || anyOverlay() || !selected) return;
    const u = selected;
    const res = game.exitUnit(u);
    if (!res.ok) { flash(res.reason); return; }
    const ex = DEF.exitHexes;
    flash(`${factionById(ex.faction).short} marches off — ${game.exitedCount(ex.faction)}/${ex.target}.`);
    selected = null; reachable = new Map();
    draw(); syncHud();
  };
  function syncExit() {
    exitBtn.classList.toggle("hidden",
      !(game && !game.over && selected && game.canExit && game.canExit(selected)));
  }
  function syncAttack() {
    const on = game && !game.over && game.phase === "combat" && targets.length > 0;
    attackBtn.classList.toggle("hidden", !on);
    if (on) {
      // A combined battle is only legal if every defender has an adjacent
      // attacker available — a gun at range bombards a single hex.
      attackBtn.disabled = !battleValid(targets, eligibleFor(targets));
      attackBtn.textContent =
        targets.length === 1 ? "Attack" : `Attack (${targets.length})`;
    }
  }
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
      $("sidePill").textContent = ""; $("sidePill").style.background = "transparent";
      $("phaseTxt").textContent = "Choose a scenario";
      $("demPill").hidden = true;
      actBtn.textContent = "End Movement";
      undoBtn.classList.add("hidden");
      attackBtn.classList.add("hidden");
      $("sel").innerHTML = `<span class="muted">Pick a battle to begin.</span>`;
      return;
    }
    const fac = factionById(game.activeFaction);
    // One pill says who is acting and where the clock stands: "ALLIES 2/10".
    const sp = $("sidePill");
    sp.innerHTML = `${fac.short} <span class="tn">${game.turn}/${DEF.maxTurns}</span>`;
    sp.style.background = fac.color;
    const night = game.isNight && game.isNight();
    $("phaseTxt").textContent = game.over ? "Battle over"
      : night ? "Night — Movement" : game.phase === "move" ? "Movement" : "Combat";
    actBtn.textContent = game.phase === "move" ? "End Movement" : "End Combat";
    actBtn.style.background = fac.dark;
    // Demoralization ticker: eliminated SP vs each army's breaking point
    // ("!" marks a broken army), plus the exit count where a side must
    // march units off the map.
    const dp = $("demPill");
    const hasDem = !!(DEF.demoralization && global.NAW_COMMON);
    document.body.classList.toggle("hasDem", hasDem);
    if (hasDem) {
      dp.hidden = false;
      let txt = global.NAW_COMMON.demoralizationStatus(game)
        .map((s) => `${s.short || s.name} ${s.lost}/${s.level}${s.lost >= s.level ? "!" : ""}`)
        .join(" · ");
      if (DEF.exitHexes) {
        txt += ` · OUT ${game.exitedCount(DEF.exitHexes.faction)}/${DEF.exitHexes.target}`;
      }
      dp.textContent = txt;
    } else dp.hidden = true;
    syncUndo();
    syncAttack();
    syncExit();
    syncSel();
  }
  function syncSel() {
    const el = $("sel");
    if (!game) return;
    if (game.phase === "combat") {
      if (targets.length) {
        const joining = eligibleFor(targets);
        const ranged = joining.filter((a) => targets.every((d) => Hx().distance(a, d) >= 2)).length;
        if (!battleValid(targets, joining)) {
          el.innerHTML = `<b>Battle:</b> not legal — every defender needs an ` +
            `<b>adjacent</b> attacker. <span class="muted">A gun at range bombards ` +
            `one hex at a time; drop a defender.</span>`;
          return;
        }
        el.innerHTML = `<b>Battle:</b> ${targets.length} defender${targets.length > 1 ? "s" : ""} · ` +
          `${joining.length} unit${joining.length === 1 ? "" : "s"} join${ranged ? ` (${ranged} at range)` : ""}. ` +
          `<span class="muted">Add more, or press Attack.</span>`;
        return;
      }
      const un = game.unresolvedCombat ? game.unresolvedCombat()
                                       : { mustAttack: [], mustBeAttacked: [] };
      if (un.mustBeAttacked.length || un.mustAttack.length) {
        const n = Math.max(un.mustBeAttacked.length, 1);
        el.innerHTML = `<b>Combat is compulsory.</b> ` +
          `<span class="muted">${n} mandatory battle${n > 1 ? "s" : ""} — tap enemies to group one.</span>`;
        return;
      }
      const n = game.enemiesOf(game.activeFaction).filter(attackable).length;
      el.innerHTML = n > 0
        ? `<b>Combat.</b> Tap enemies to group a battle. <span class="muted">(${n} possible target${n > 1 ? "s" : ""})</span>`
        : `<b>Combat.</b> <span class="muted">No targets in range — end combat.</span>`;
      return;
    }
    if (selected) {
      el.innerHTML = reachable.size
        ? `<b>Move.</b> Tap a highlighted hex. <span class="muted">(${reachable.size} option${reachable.size > 1 ? "s" : ""})</span>`
        : `<b>Move.</b> <span class="muted">This unit has no available moves.</span>`;
    } else {
      const mine = game.living(game.activeFaction);
      const left = mine.filter((u) => !u.moved && !u.locked).length;
      const locked = mine.filter((u) => u.locked).length;
      el.innerHTML = `<span class="muted">Movement. Tap one of your units to move it. ` +
        `(${left} unmoved${locked ? `, ${locked} locked in ZOC` : ""})</span>`;
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
    document.body.classList.remove("over");   // the action bar is back in play
    $("resultBtn").classList.add("hidden");
    if (saved) {
      try { game = Game.restore(DEF, saved.game); }
      catch (e) { clearSave(); saved = null; game = new Game(DEF); }
    } else {
      game = new Game(DEF);
    }
    selected = null; reachable = new Map(); inspected = null; pending = null;
    targets = [];
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

    game.events.on("sideChange", () => { selected = null; targets = []; showPass(); });
    game.events.on("phase", () => {
      selected = null; targets = []; reachable = new Map(); inspected = null;
      focusActive(); renderInspector(); syncHud(); draw(); syncFit();
    });
    game.events.on("reinforce", ({ units }) => {
      const grp = units[0];
      flash(`Reinforcements — ${units.length} unit${units.length > 1 ? "s" : ""} arrive!`);
      if (grp) focus(grp);
    });
    game.events.on("gameover", ({ winner, reason }) => {
      const fac = winner ? factionById(winner) : null;
      $("winTitle").textContent = fac ? fac.name + " Victory" : "Draw";
      $("winTitle").style.color = fac ? fac.color : "#fff";
      $("winSub").textContent = reason;
      // The action bar and any docked battle card have nothing left to say;
      // the board becomes the record of the battle. The HUD stays (New).
      closeCombatSheet();
      document.body.classList.add("over");
      syncHud();
      show("winOv");
    });
    // Autosave. "phase" also covers side changes (every sideChange is followed
    // by a phase emit); "gameover" frees the slot — a finished game is done.
    game.events.on("move", save);
    game.events.on("undo", save);
    game.events.on("combat", save);
    game.events.on("advance", save);
    game.events.on("exit", save);
    game.events.on("reinforce", save);
    game.events.on("phase", save);
    game.events.on("gameover", clearSave);

    closeCombatSheet(); hide("winOv");
    if (!resumedCamera) focusActive();
    draw(); syncHud(); syncFit(); showPass();
    global.__game = game; global.__renderer = renderer; // for smoke-testing
    save(); // starting (or resuming) a game claims the one slot immediately
  }

  if (global.ResizeObserver) {
    new global.ResizeObserver(relayout).observe(boardWrap);
    // The sheet grows and shrinks as its content changes — chips appearing, the
    // die result, the advance buttons. Re-inset the camera whenever it does.
    new global.ResizeObserver(() => { if (combatSheetOpen()) syncSheetInsets(); })
      .observe($("cbCard"));
  }
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
