/* =========================================================================
   hex.js — Reusable hex-grid geometry & pathfinding (no game logic, no DOM).
   Pointy-top and flat-top axial coordinates. Pure functions + a Layout class.
   Exposed as the global `Hex`.
   ========================================================================= */
(function (global) {
  "use strict";

  // Axial neighbor directions for pointy-top hexes (same set works for flat-top,
  // only the pixel projection differs).
  const DIRS = [
    { q: +1, r: 0 }, { q: +1, r: -1 }, { q: 0, r: -1 },
    { q: -1, r: 0 }, { q: -1, r: +1 }, { q: 0, r: +1 },
  ];

  const key = (q, r) => q + "," + r;
  const parseKey = (k) => { const [q, r] = k.split(",").map(Number); return { q, r }; };

  // Offset (column,row) -> axial. "odd-r"/"even-r" for pointy, "odd-q"/"even-q" for flat.
  function offsetToAxial(col, row, mode = "odd-r") {
    switch (mode) {
      case "odd-r":  return { q: col - ((row - (row & 1)) / 2), r: row };
      case "even-r": return { q: col - ((row + (row & 1)) / 2), r: row };
      case "odd-q":  return { q: col, r: row - ((col - (col & 1)) / 2) };
      case "even-q": return { q: col, r: row - ((col + (col & 1)) / 2) };
      default: throw new Error("Unknown offset mode: " + mode);
    }
  }

  function neighbors(hex) {
    return DIRS.map((d) => ({ q: hex.q + d.q, r: hex.r + d.r }));
  }

  function distance(a, b) {
    const dq = a.q - b.q, dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
  }

  function equals(a, b) { return a.q === b.q && a.r === b.r; }

  /* ------------------------- Layout (hex <-> pixel) ---------------------- */
  // orientation: "pointy" (flat side left/right) or "flat" (flat side top/bottom).
  class Layout {
    constructor({ orientation = "pointy", size = 24, origin = { x: 0, y: 0 } } = {}) {
      this.orientation = orientation;
      this.size = size;
      this.origin = origin;
    }
    center(hex) {
      const s = this.size, o = this.origin;
      if (this.orientation === "pointy") {
        return {
          x: o.x + s * Math.sqrt(3) * (hex.q + hex.r / 2),
          y: o.y + s * 1.5 * hex.r,
        };
      }
      return {
        x: o.x + s * 1.5 * hex.q,
        y: o.y + s * Math.sqrt(3) * (hex.r + hex.q / 2),
      };
    }
    // The six polygon corners (for drawing / hit-testing).
    corners(hex) {
      const c = this.center(hex), pts = [];
      const startDeg = this.orientation === "pointy" ? -30 : 0;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i + startDeg);
        pts.push({ x: c.x + this.size * Math.cos(a), y: c.y + this.size * Math.sin(a) });
      }
      return pts;
    }
    // Bounding box (in size-units, size=1) of a set of hexes — used to auto-fit a viewport.
    static unitBounds(hexes, orientation = "pointy") {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const h of hexes) {
        const x = orientation === "pointy"
          ? Math.sqrt(3) * (h.q + h.r / 2) : 1.5 * h.q;
        const y = orientation === "pointy"
          ? 1.5 * h.r : Math.sqrt(3) * (h.r + h.q / 2);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const hexW = orientation === "pointy" ? Math.sqrt(3) : 2;
      const hexH = orientation === "pointy" ? 2 : Math.sqrt(3);
      return { minX, maxX, minY, maxY, hexW, hexH,
               spanX: (maxX - minX) + hexW, spanY: (maxY - minY) + hexH };
    }
  }

  /* --------------------------- Reachability ------------------------------ */
  // Generic weighted flood-fill (Dijkstra). Game-agnostic: caller supplies the
  // rules via callbacks, so it works for any movement model.
  //   start     : {q,r}
  //   budget    : max total cost
  //   neighborsOf(hex) -> [{q,r}]              (defaults to hex neighbors)
  //   stepCost(fromHex, toHex) -> number       (Infinity = impassable)
  //   blocked(hex) -> bool                     (cannot stand here at all)
  //   stopAt(hex) -> bool                      (can enter, but not move on from here)
  // Returns Map: key -> { q, r, cost } for every reachable hex (excludes start).
  function reachable({ start, budget, neighborsOf = neighbors, stepCost,
                       blocked = () => false, stopAt = () => false }) {
    const best = new Map();
    const startK = key(start.q, start.r);
    best.set(startK, { q: start.q, r: start.r, cost: 0 });
    const frontier = [{ q: start.q, r: start.r, cost: 0 }];
    while (frontier.length) {
      let bi = 0;
      for (let i = 1; i < frontier.length; i++)
        if (frontier[i].cost < frontier[bi].cost) bi = i;
      const cur = frontier.splice(bi, 1)[0];
      const curK = key(cur.q, cur.r);
      if (cur.cost > best.get(curK).cost) continue;
      // A hex flagged by stopAt (e.g. inside an enemy ZOC) halts further movement.
      if (curK !== startK && stopAt(cur)) continue;
      for (const nb of neighborsOf(cur)) {
        if (blocked(nb)) continue;
        const step = stepCost(cur, nb);
        if (!isFinite(step)) continue;
        const nc = cur.cost + step;
        if (nc > budget) continue;
        const nk = key(nb.q, nb.r);
        const known = best.get(nk);
        if (!known || nc < known.cost) {
          best.set(nk, { q: nb.q, r: nb.r, cost: nc });
          frontier.push({ q: nb.q, r: nb.r, cost: nc });
        }
      }
    }
    best.delete(startK);
    return best;
  }

  global.Hex = {
    DIRS, key, parseKey, offsetToAxial, neighbors, distance, equals,
    Layout, reachable,
  };
})(typeof window !== "undefined" ? window : globalThis);
