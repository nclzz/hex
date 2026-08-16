/* =========================================================================
   renderer.js — Reusable Canvas renderer for a hex board + units.
   Knows how to draw hexes and pick a hex from a screen point; delegates unit
   appearance to a game-supplied callback. DOM-aware but game-agnostic.
   Exposed as the global `HexRenderer`. Depends on `Hex` (hex.js).

   The renderer owns a CAMERA, so the board may be larger than the viewport.
   Because Layout.center() is affine in `size` and `origin`, the camera is
   folded straight into the layout: zoom scales `size`, pan translates
   `origin`. Nothing else — drawing, hit-testing — needs to know it exists.

   Camera state:
     zoom  1 = the whole board fits (the old auto-fit); higher = closer in.
     cam   the WORLD point (size-1 hex units) sitting at the viewport centre.
   ========================================================================= */
(function (global) {
  "use strict";
  const Hex = global.Hex;

  const MAX_HEX_PX = 46;      // don't zoom in past this hex circumradius
  const DEFAULT_HEX_PX = 30;  // comfortable counter size when we must zoom in
  const MIN_LEGIBLE_PX = 18;  // below this, a fitted board is too small to play

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  class HexRenderer {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.orientation = opts.orientation || "pointy";
      this.pad = opts.pad != null ? opts.pad : 6;
      this.layout = new Hex.Layout({ orientation: this.orientation, size: 24 });
      this.dpr = 1;
      // Viewport (CSS px) and camera.
      this.vw = 0; this.vh = 0;
      this.bounds = null;   // Hex.Layout.unitBounds of the current board
      this.fitSize = 24;    // hex size at which the whole board fits
      this.zoom = 1;
      this.cam = { x: 0, y: 0 };
      // Drawing hooks supplied by the app:
      this.terrainColor = opts.terrainColor || (() => "#ccc");
      this.drawUnit = opts.drawUnit || (() => {});
      this.decorateHex = opts.decorateHex || null; // (ctx, hex, center, size) after fill
    }

    /* ------------------------------- camera ------------------------------- */

    // Adopt a board: cache its extent and recompute the zoom limits.
    setBoard(hexes) {
      this.bounds = Hex.Layout.unitBounds(hexes, this.orientation);
      this._recomputeFit();
      this.cam = { x: this._worldMid("x"), y: this._worldMid("y") };
      this._applyCamera();
    }

    // Measure the container, size the canvas (crisp on retina), keep the camera.
    // A resize (rotation, toolbar, window drag) changes what "fits", so we hold
    // the absolute hex size rather than the zoom ratio — counters stay the size
    // the player chose. A board that was framed whole stays framed whole.
    resize(container) {
      const availW = container.clientWidth, availH = container.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      const oldSize = this.size, wasFitted = this.isAtMinZoom();
      this.vw = availW; this.vh = availH;

      this.dpr = global.devicePixelRatio || 1;
      this.canvas.width = Math.round(availW * this.dpr);
      this.canvas.height = Math.round(availH * this.dpr);
      this.canvas.style.width = availW + "px";
      this.canvas.style.height = availH + "px";
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this._recomputeFit();
      this.zoom = wasFitted ? 1 : clamp(oldSize / this.fitSize, 1, this.maxZoom);
      this._applyCamera();
    }

    // Back-compat: adopt the board, size the canvas, frame the whole map.
    fit(hexes, container) {
      this.setBoard(hexes);
      this.resize(container);
      this.frameAll();
    }

    get maxZoom() { return Math.max(1, MAX_HEX_PX / this.fitSize); }
    get size() { return this.fitSize * this.zoom; }
    isAtMinZoom() { return this.zoom <= 1 + 1e-9; }

    // Zoom the whole board back into view.
    frameAll() { this.setZoom(1); }

    // Opening shot for a new game. A board that already fits legibly is shown
    // whole (the classic look); a board too big for that opens zoomed in to a
    // comfortable counter size, and the player pans from there.
    frameDefault() {
      this.setZoom(this.fitSize >= MIN_LEGIBLE_PX ? 1 : DEFAULT_HEX_PX / this.fitSize);
    }

    setZoom(z, fx, fy) {
      const z1 = clamp(z, 1, this.maxZoom);
      if (fx == null) { this.zoom = z1; this._applyCamera(); return; }
      this.zoomAt(z1 / this.zoom, fx, fy);
    }

    // Zoom by `factor` while keeping the world point under (fx,fy) in place.
    zoomAt(factor, fx, fy) {
      const s0 = this.size;
      const z1 = clamp(this.zoom * factor, 1, this.maxZoom);
      const s1 = this.fitSize * z1;
      if (s1 === s0) return;
      const wx = this.cam.x + (fx - this.vw / 2) / s0;
      const wy = this.cam.y + (fy - this.vh / 2) / s0;
      this.zoom = z1;
      this.cam.x = wx - (fx - this.vw / 2) / s1;
      this.cam.y = wy - (fy - this.vh / 2) / s1;
      this._applyCamera();
    }

    // Drag the board with the pointer: content follows the finger.
    panByPixels(dx, dy) {
      const s = this.size;
      this.cam.x -= dx / s;
      this.cam.y -= dy / s;
      this._applyCamera();
    }

    screenToWorld(px, py) {
      const s = this.size;
      return { x: this.cam.x + (px - this.vw / 2) / s, y: this.cam.y + (py - this.vh / 2) / s };
    }

    centerOn(hex) {
      const w = Hex.Layout.worldOf(hex, this.orientation);
      this.cam.x = w.x; this.cam.y = w.y;
      this._applyCamera();
    }

    // Scroll the minimum amount needed to bring `hex` inside the viewport,
    // keeping `margin` hex-widths of context around it.
    ensureVisible(hex, margin = 1.2) {
      if (!this.vw || !this.vh) return false;
      const c = this.layout.center(hex), s = this.size, m = s * margin;
      let dx = 0, dy = 0;
      if (c.x - m < 0) dx = c.x - m;
      else if (c.x + m > this.vw) dx = c.x + m - this.vw;
      if (c.y - m < 0) dy = c.y - m;
      else if (c.y + m > this.vh) dy = c.y + m - this.vh;
      if (!dx && !dy) return false;
      this.cam.x += dx / s; this.cam.y += dy / s;
      this._applyCamera();
      return true;
    }

    // Does the board extend past the viewport at the current zoom?
    contentOverflows() {
      if (!this.bounds) return false;
      const s = this.size, b = this.bounds;
      return b.spanX * s > this.vw + 0.5 || b.spanY * s > this.vh + 0.5;
    }

    /* --------------------------- camera internals ------------------------- */

    _recomputeFit() {
      if (!this.bounds || !this.vw || !this.vh) return;
      const b = this.bounds;
      this.fitSize = Math.max(1, Math.min(
        (this.vw - 2 * this.pad) / b.spanX,
        (this.vh - 2 * this.pad) / b.spanY
      ));
    }

    // World-space extent of the board along an axis, hex corners included.
    _worldRange(axis) {
      const b = this.bounds;
      const half = (axis === "x" ? b.hexW : b.hexH) / 2;
      return axis === "x"
        ? { lo: b.minX - half, hi: b.maxX + half }
        : { lo: b.minY - half, hi: b.maxY + half };
    }
    _worldMid(axis) { const r = this._worldRange(axis); return (r.lo + r.hi) / 2; }

    // Keep the board anchored: centred on an axis it doesn't fill, otherwise
    // clamped so its edge can never be dragged inside the viewport edge.
    _clampCam() {
      if (!this.bounds) return;
      const s = this.size;
      for (const axis of ["x", "y"]) {
        const view = axis === "x" ? this.vw : this.vh;
        const { lo, hi } = this._worldRange(axis);
        if ((hi - lo) * s + 2 * this.pad <= view) {
          this.cam[axis] = (lo + hi) / 2;
        } else {
          const slack = (view / 2 - this.pad) / s;
          this.cam[axis] = clamp(this.cam[axis], lo + slack, hi - slack);
        }
      }
    }

    _applyCamera() {
      if (!this.bounds || !this.vw || !this.vh) return;
      this._clampCam();
      const s = this.size;
      this.layout.size = s;
      this.layout.origin = {
        x: this.vw / 2 - this.cam.x * s,
        y: this.vh / 2 - this.cam.y * s,
      };
    }

    /* ------------------------------ drawing ------------------------------- */

    _hexPath(center, size) {
      const ctx = this.ctx;
      const start = this.orientation === "pointy" ? -30 : 0;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i + start);
        const x = center.x + size * Math.cos(a), y = center.y + size * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    // Is this hex centre near enough to the viewport to be worth drawing?
    _visible(c, size) {
      return c.x >= -size && c.x <= this.vw + size &&
             c.y >= -size && c.y <= this.vh + size;
    }

    // highlights: array of { hex:{q,r}, fill?, stroke?, lineWidth?, scale? }
    render(game, { highlights = [], selected = null } = {}) {
      const ctx = this.ctx, L = this.layout, size = L.size;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();

      // terrain
      for (const [, hex] of game.board) {
        const c = L.center(hex);
        if (!this._visible(c, size)) continue;
        this._hexPath(c, size);
        ctx.fillStyle = this.terrainColor(game, hex);
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(60,52,36,.55)"; ctx.stroke();
      }

      // hexside features (roads under, waterways over)
      this._drawEdges(game);

      // hex decorations (objective stars, …) sit above roads
      if (this.decorateHex) {
        for (const [, hex] of game.board) {
          const c = L.center(hex);
          if (!this._visible(c, size)) continue;
          this.decorateHex(ctx, game, hex, c, size);
        }
      }

      // highlights (movement range, targets, …)
      for (const h of highlights) {
        const hx = game.hex(h.hex.q, h.hex.r); if (!hx) continue;
        const c = L.center(hx);
        if (!this._visible(c, size)) continue;
        this._hexPath(c, size * (h.scale || 0.94));
        if (h.fill) { ctx.fillStyle = h.fill; ctx.fill(); }
        if (h.stroke) {
          ctx.setLineDash(h.dash || []);
          ctx.lineWidth = h.lineWidth || 2; ctx.strokeStyle = h.stroke; ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // units (reinforcements that have not entered the map yet don't exist)
      for (const u of game.units) {
        if (!u.alive || u.entered === false) continue;
        const c = L.center(u);
        if (!this._visible(c, size)) continue;
        this.drawUnit(ctx, game, u, c, size);
      }

      // selection ring
      if (selected) {
        const c = L.center(selected);
        this._hexPath(c, size * 0.99);
        ctx.lineWidth = 3; ctx.strokeStyle = "#f4d23a"; ctx.stroke();
      }
    }

    // Hexside features from game.edges ("q,r|q,r" -> type). Roads and trails
    // run centre-to-centre beneath everything; rivers, streams, bridges and
    // slope marks sit on the shared edge itself.
    _drawEdges(game) {
      if (!game.edges || !game.edges.size) return;
      const ctx = this.ctx, L = this.layout, size = L.size;
      ctx.save();
      ctx.lineCap = "round";
      const centers = (key) => {
        const [k1, k2] = key.split("|");
        const A = Hex.parseKey(k1), B = Hex.parseKey(k2);
        return [L.center(A), L.center(B)];
      };
      // pass 1: roads/trails
      for (const [key, type] of game.edges) {
        if (type !== "road" && type !== "trail") continue;
        const [ca, cb] = centers(key);
        if (!this._visible(ca, size) && !this._visible(cb, size)) continue;
        ctx.beginPath(); ctx.moveTo(ca.x, ca.y); ctx.lineTo(cb.x, cb.y);
        ctx.lineWidth = size * (type === "road" ? 0.22 : 0.12);
        ctx.strokeStyle = type === "road" ? "#d8b95c" : "#c9b47e";
        ctx.stroke();
      }
      // pass 2: edge features
      for (const [key, type] of game.edges) {
        if (type === "road" || type === "trail") continue;
        const [ca, cb] = centers(key);
        if (!this._visible(ca, size) && !this._visible(cb, size)) continue;
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
        const dx = cb.x - ca.x, dy = cb.y - ca.y;
        const dl = Math.hypot(dx, dy) || 1;
        const px = -dy / dl, py = dx / dl; // along the shared edge
        const half = size * 0.5;
        if (type === "river" || type === "stream" || type === "bridge") {
          ctx.beginPath();
          ctx.moveTo(mx - px * half, my - py * half);
          ctx.lineTo(mx + px * half, my + py * half);
          ctx.lineWidth = size * (type === "stream" ? 0.14 : 0.26);
          ctx.strokeStyle = type === "stream" ? "#7aa7c4" : "#4a7fa8";
          ctx.stroke();
          if (type === "bridge") {
            ctx.beginPath();
            const bl = size * 0.3;
            ctx.moveTo(mx - (dx / dl) * bl, my - (dy / dl) * bl);
            ctx.lineTo(mx + (dx / dl) * bl, my + (dy / dl) * bl);
            ctx.lineWidth = size * 0.24;
            ctx.strokeStyle = "#8a6b3d";
            ctx.stroke();
          }
        } else if (type === "slope") {
          ctx.beginPath();
          ctx.moveTo(mx - px * half * 0.8, my - py * half * 0.8);
          ctx.lineTo(mx + px * half * 0.8, my + py * half * 0.8);
          ctx.lineWidth = size * 0.1;
          ctx.strokeStyle = "rgba(150,110,60,.8)";
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Screen point (relative to canvas) -> hex, or null.
    pick(game, px, py) {
      const a = this.layout.pixelToHex(px, py);
      return game.hex(a.q, a.r) || null;
    }
  }

  global.HexRenderer = HexRenderer;
})(typeof window !== "undefined" ? window : globalThis);
