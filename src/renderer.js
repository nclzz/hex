/* =========================================================================
   renderer.js — Reusable Canvas renderer for a hex board + units.
   Knows how to draw hexes and pick a hex from a screen point; delegates unit
   appearance to a game-supplied callback. DOM-aware but game-agnostic.
   Exposed as the global `HexRenderer`. Depends on `Hex` (hex.js).
   ========================================================================= */
(function (global) {
  "use strict";
  const Hex = global.Hex;

  class HexRenderer {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.orientation = opts.orientation || "pointy";
      this.pad = opts.pad != null ? opts.pad : 6;
      this.layout = new Hex.Layout({ orientation: this.orientation, size: 24 });
      this.dpr = 1;
      // Drawing hooks supplied by the app:
      this.terrainColor = opts.terrainColor || (() => "#ccc");
      this.drawUnit = opts.drawUnit || (() => {});
      this.decorateHex = opts.decorateHex || null; // (ctx, hex, center, size) after fill
    }

    // Fit the whole board into the canvas's container and set up crisp DPR scaling.
    fit(hexes, container) {
      const availW = container.clientWidth, availH = container.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      const b = Hex.Layout.unitBounds(hexes, this.orientation);
      const size = Math.min(
        (availW - 2 * this.pad) / b.spanX,
        (availH - 2 * this.pad) / b.spanY
      );
      const boardW = size * b.spanX, boardH = size * b.spanY;
      const offX = (availW - boardW) / 2, offY = (availH - boardH) / 2;
      const origin = this.orientation === "pointy"
        ? { x: offX + size * Math.sqrt(3) / 2 - size * b.minX, y: offY + size - size * b.minY }
        : { x: offX + size - size * b.minX, y: offY + size * Math.sqrt(3) / 2 - size * b.minY };
      this.layout.size = size;
      this.layout.origin = origin;

      this.dpr = global.devicePixelRatio || 1;
      this.canvas.width = Math.round(availW * this.dpr);
      this.canvas.height = Math.round(availH * this.dpr);
      this.canvas.style.width = availW + "px";
      this.canvas.style.height = availH + "px";
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

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

    // highlights: array of { hex:{q,r}, fill?, stroke?, lineWidth?, scale? }
    render(game, { highlights = [], selected = null } = {}) {
      const ctx = this.ctx, L = this.layout, size = L.size;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      // terrain
      for (const [, hex] of game.board) {
        const c = L.center(hex);
        this._hexPath(c, size);
        ctx.fillStyle = this.terrainColor(game, hex);
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(60,52,36,.55)"; ctx.stroke();
        if (this.decorateHex) this.decorateHex(ctx, game, hex, c, size);
      }

      // highlights (movement range, targets, …)
      for (const h of highlights) {
        const hx = game.hex(h.hex.q, h.hex.r); if (!hx) continue;
        const c = L.center(hx);
        this._hexPath(c, size * (h.scale || 0.94));
        if (h.fill) { ctx.fillStyle = h.fill; ctx.fill(); }
        if (h.stroke) { ctx.lineWidth = h.lineWidth || 2; ctx.strokeStyle = h.stroke; ctx.stroke(); }
      }

      // units
      for (const u of game.units) {
        if (!u.alive) continue;
        this.drawUnit(ctx, game, u, L.center(u), size);
      }

      // selection ring
      if (selected) {
        const c = L.center(selected);
        this._hexPath(c, size * 0.99);
        ctx.lineWidth = 3; ctx.strokeStyle = "#f4d23a"; ctx.stroke();
      }
    }

    // Screen point (relative to canvas) -> hex, or null.
    pick(game, px, py) {
      const L = this.layout;
      let best = null, bd = Infinity;
      for (const [, hex] of game.board) {
        const c = L.center(hex);
        const d = (c.x - px) ** 2 + (c.y - py) ** 2;
        if (d < bd) { bd = d; best = hex; }
      }
      if (best && Math.sqrt(bd) <= L.size * 1.05) return best;
      return null;
    }
  }

  global.HexRenderer = HexRenderer;
})(typeof window !== "undefined" ? window : globalThis);
