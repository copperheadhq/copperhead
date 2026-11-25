// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/LargestRectOutsideOutlineFromPointSolver.ts
import { BaseSolver } from "./solver-utils/BaseSolver.js"
import type { Point, Segment } from "./geometry/types.js"
import type { Bounds } from "./local/math-utils.js"
import type { GraphicsObject } from "./local/graphics-debug.js"

export type Rect = { x: number; y: number; w: number; h: number }

export type { Point } from "./geometry/types.js"
export type GlobalBounds = Bounds

export class LargestRectOutsideOutlineFromPointSolver extends BaseSolver {
  ccwFullOutline: Point[]
  origin: Point
  globalBounds: Bounds
  largestRect: Rect | null = null
  /**
   * Mode for finding rectangles:
   * - "outside": Find rect outside the polygon (for CCW obstacle boundaries)
   * - "inside": Find rect inside the polygon (for CW free space pockets)
   */
  mode: "outside" | "inside"

  override getSolverName(): string {
    return "LargestRectOutsideOutlineFromPointSolver"
  }

  constructor(params: {
    ccwFullOutline: Point[]
    origin: Point
    globalBounds: Bounds
    /**
     * Mode for finding rectangles:
     * - "outside" (default): Find rect outside the polygon (for CCW obstacle boundaries)
     * - "inside": Find rect inside the polygon (for CW free space pockets)
     */
    mode?: "outside" | "inside"
  }) {
    super()
    this.ccwFullOutline = params.ccwFullOutline
    this.origin = params.origin
    this.globalBounds = params.globalBounds
    this.mode = params.mode ?? "outside"
  }

  override getConstructorParams() {
    return {
      ccwFullOutline: this.ccwFullOutline,
      origin: this.origin,
      globalBounds: this.globalBounds,
      mode: this.mode,
    }
  }

  override _setup() {
    // Nothing to setup
  }

  override _step() {
    this.largestRect = this.computeLargestRect()
    this.solved = true
  }

  private computeLargestRect(): Rect | null {
    const edges = this.makeEdges(this.ccwFullOutline)
    const bounds = {
      x: this.globalBounds.minX,
      y: this.globalBounds.minY,
      w: this.globalBounds.maxX - this.globalBounds.minX,
      h: this.globalBounds.maxY - this.globalBounds.minY,
    }

    return this.largestRectContainingPointRegion(
      edges,
      this.origin,
      bounds,
      this.mode,
    )
  }

  private almostEqual(a: number, b: number, eps = 1e-9): boolean {
    return Math.abs(a - b) <= eps
  }

  private makeEdges(poly: Point[]): Segment[] {
    const edges: Segment[] = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if (!a || !b) continue
      // skip zero-length
      if (this.almostEqual(a.x, b.x) && this.almostEqual(a.y, b.y)) continue
      edges.push([a, b])
    }
    return edges
  }

  private isVertical(e: Segment): boolean {
    return this.almostEqual(e[0].x, e[1].x)
  }

  private isHorizontal(e: Segment): boolean {
    return this.almostEqual(e[0].y, e[1].y)
  }

  private scanlineIntervalsAtY(
    edges: Segment[],
    y0: number,
  ): [number, number][] {
    const xs: number[] = []
    for (const e of edges) {
      if (!this.isVertical(e)) continue
      const y1 = e[0].y
      const y2 = e[1].y
      const x = e[0].x
      const ymin = Math.min(y1, y2)
      const ymax = Math.max(y1, y2)
      // half-open: include ymin <= y0 < ymax
      if (ymin <= y0 && y0 < ymax) {
        xs.push(x)
      }
    }
    xs.sort((a, b) => a - b)
    const intervals: [number, number][] = []
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x1 = xs[i]
      const x2 = xs[i + 1]
      if (x1 !== undefined && x2 !== undefined) {
        intervals.push([x1, x2])
      }
    }
    return intervals
  }

  private clipIntervals(
    intervals: [number, number][],
    a: number,
    b: number,
  ): [number, number][] {
    const out: [number, number][] = []
    for (const [L, R] of intervals) {
      const l = Math.max(a, L)
      const r = Math.min(b, R)
      if (r > l) out.push([l, r])
    }
    return out
  }

  private regionIntervalsAtY(
    edges: Segment[],
    y0: number,
    bx1: number,
    bx2: number,
    mode: "outside" | "inside",
  ): [number, number][] {
    const inside = this.clipIntervals(
      this.scanlineIntervalsAtY(edges, y0),
      bx1,
      bx2,
    )

    if (mode === "inside") {
      // For "inside" mode, return the intervals directly (inside the polygon)
      return inside
    }

    // For "outside" mode, compute complement of inside within [bx1,bx2]
    const outs: [number, number][] = []
    let prev = bx1
    for (const [L, R] of inside) {
      if (L > prev) outs.push([prev, L])
      prev = Math.max(prev, R)
    }
    if (prev < bx2) outs.push([prev, bx2])
    return outs
  }

  private largestRectContainingPointRegion(
    edges: Segment[],
    p: Point,
    bounds: { x: number; y: number; w: number; h: number },
    mode: "outside" | "inside",
  ): Rect | null {
    const BX1 = bounds.x
    const BX2 = bounds.x + bounds.w
    const BY1 = bounds.y // top
    const BY2 = bounds.y + bounds.h // bottom

    // 1) Horizontal visibility segment at y=p.y for the chosen region
    const intervals = this.regionIntervalsAtY(edges, p.y, BX1, BX2, mode)
    const interval = intervals.find(
      ([xL, xR]) => xL - 1e-9 <= p.x && p.x <= xR + 1e-9,
    )
    if (!interval) return null
    let [X_L, X_R] = interval

    // 2) Build x-slabs using ONLY vertical edges strictly inside (X_L, X_R)
    const xset = new Set<number>([X_L, X_R])
    for (const e of edges) {
      if (!this.isVertical(e)) continue
      const x = e[0].x
      if (X_L < x && x < X_R) xset.add(x)
    }
    const xs = Array.from(xset).sort((a, b) => a - b)
    const m = xs.length - 1
    if (m <= 0) return null

    // 3) For each slab, find top[i] and bot[i] via vertical shots at mid x
    const top: number[] = Array(m).fill(-Infinity)
    const bot: number[] = Array(m).fill(+Infinity)

    for (let i = 0; i < m; i++) {
      const xi = xs[i]
      const xi1 = xs[i + 1]
      if (xi === undefined || xi1 === undefined) continue

      let xm = 0.5 * (xi + xi1)
      // Nudge xm if it sits exactly on a vertical edge to avoid corner ambiguity
      if (xset.has(xm)) xm += 1e-6

      let minAbove = BY2 // bottom bound caps the upward ray in SVG coords
      let maxBelow = BY1 // top bound caps the downward ray in SVG coords

      for (const e of edges) {
        if (!this.isHorizontal(e)) continue
        const y = e[0].y
        const x1 = Math.min(e[0].x, e[1].x)
        const x2 = Math.max(e[0].x, e[1].x)
        if (x1 - 1e-9 <= xm && xm <= x2 + 1e-9) {
          if (y > p.y) minAbove = Math.min(minAbove, y)
          if (y < p.y) maxBelow = Math.max(maxBelow, y)
        }
      }

      if (!(maxBelow < minAbove)) {
        top[i] = -Infinity
        bot[i] = +Infinity
      } else {
        top[i] = minAbove
        bot[i] = maxBelow
      }
    }

    // 4) Find the slab that contains p.x
    let s0 = -1
    for (let i = 0; i < m; i++) {
      const xi = xs[i]
      const xi1 = xs[i + 1]
      if (xi === undefined || xi1 === undefined) continue
      if (xi - 1e-9 <= p.x && p.x <= xi1 + 1e-9) {
        s0 = i
        break
      }
    }
    if (s0 === -1) return null

    // 5) Enumerate runs i..j including s0; keep min(top) and max(bot)
    let best: Rect | null = null
    let bestArea = -1

    for (let i = 0; i <= s0; i++) {
      let minTop = +Infinity
      let maxBot = -Infinity
      for (let j = i; j < m; j++) {
        const topJ = top[j]
        const botJ = bot[j]
        if (topJ === undefined || botJ === undefined) continue

        minTop = Math.min(minTop, topJ)
        maxBot = Math.max(maxBot, botJ)
        if (j < s0) continue

        const height = Math.max(0, minTop - maxBot)
        if (height <= 0) continue

        const xi = xs[i]
        const xj1 = xs[j + 1]
        if (xi === undefined || xj1 === undefined) continue

        const width = xj1 - xi
        const area = width * height
        if (area > bestArea) {
          bestArea = area
          best = { x: xi, y: maxBot, w: width, h: height }
        }
      }
    }
    return best
  }

  getLargestRect(): Rect | null {
    if (!this.solved) {
      this.solve()
    }
    return this.largestRect
  }

  getLargestRectBounds(): Bounds {
    if (!this.solved) {
      this.solve()
    }
    if (!this.largestRect) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    }
    return {
      minX: this.largestRect.x,
      minY: this.largestRect.y,
      maxX: this.largestRect.x + this.largestRect.w,
      maxY: this.largestRect.y + this.largestRect.h,
    }
  }

  override visualize(): GraphicsObject {
    const graphics: GraphicsObject = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }

    // Draw global bounds as dashed rectangle
    // graphics.rects!.push({
    //   center: {
    //     x: (this.globalBounds.minX + this.globalBounds.maxX) / 2,
    //     y: (this.globalBounds.minY + this.globalBounds.maxY) / 2,
    //   },
    //   width: this.globalBounds.maxX - this.globalBounds.minX,
    //   height: this.globalBounds.maxY - this.globalBounds.minY,
    //   stroke: "#ddd",
    //   fill: "transparent",
    //   label: "Global Bounds",
    // })

    // Draw outline as lines
    for (let i = 0; i < this.ccwFullOutline.length; i++) {
      const p1 = this.ccwFullOutline[i]
      const p2 = this.ccwFullOutline[(i + 1) % this.ccwFullOutline.length]
      if (p1 && p2) {
        graphics.lines!.push({
          points: [p1, p2],
          strokeColor: "rgba(0,0,0,0.5)",
        })
      }
    }

    // Fill the outline polygon
    graphics.lines!.push({
      points: [...this.ccwFullOutline, this.ccwFullOutline[0]!],
      strokeColor: "rgba(200, 200, 200, 0.5)",
      strokeDash: [10, 5],
    })

    // Draw origin point
    graphics.circles!.push({
      center: this.origin,
      radius: 0.05,
      fill: "#f44336",
      label: "Origin",
    })

    // Draw result rectangle if found
    if (this.largestRect) {
      graphics.rects!.push({
        center: {
          x: this.largestRect.x + this.largestRect.w / 2,
          y: this.largestRect.y + this.largestRect.h / 2,
        },
        width: this.largestRect.w,
        height: this.largestRect.h,
        fill: "rgba(0, 255, 0, 0.3)",
        stroke: "#4CAF50",
        label: `Largest Rectangle (Area: ${(this.largestRect.w * this.largestRect.h).toFixed(3)})`,
      })
    }

    return graphics
  }

  override getOutput() {
    return this.largestRect ?? null
  }
}
