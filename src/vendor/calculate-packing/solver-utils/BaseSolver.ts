// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/solver-utils/BaseSolver.ts
import type { GraphicsObject } from "../local/graphics-debug.js"
import { makeNumbersRounded } from "./makeNumbersRounded.js"

export class BaseSolver {
  MAX_ITERATIONS = 100e3
  solved = false
  failed = false
  iterations = 0
  progress = 0
  error: string | null = null
  activeSubSolver?: BaseSolver | null
  failedSubSolvers?: BaseSolver[]
  timeToSolve?: number
  stats: Record<string, any> = {}
  _setupDone = false

  getSolverName(): string {
    return this.constructor.name
  }

  setup() {
    if (this._setupDone) return
    this._setup()
    this._setupDone = true
  }

  /** DO NOT OVERRIDE! Override _step() instead */
  step() {
    if (!this._setupDone) {
      this.setup()
    }
    if (this.solved) return
    if (this.failed) return
    this.iterations++
    // copperhead patch P1: no console output from library code; the error
    // stays on `this.error`
    try {
      this._step()
    } catch (e) {
      this.error = `${this.getSolverName()} error: ${e}`
      this.failed = true
      throw e
    }
    if (!this.solved && this.iterations > this.MAX_ITERATIONS) {
      this.tryFinalAcceptance()
    }
    if (!this.solved && this.iterations > this.MAX_ITERATIONS) {
      this.error = `${this.getSolverName()} ran out of iterations`
      this.failed = true
    }
    if ("computeProgress" in this) {
      // @ts-ignore
      this.progress = this.computeProgress() as number
    }
  }

  _setup() {}
  _step() {}

  getConstructorParams() {
    throw new Error("getConstructorParams not implemented")
  }

  solve() {
    const startTime = Date.now()
    while (!this.solved && !this.failed) {
      this.step()
    }
    const endTime = Date.now()
    this.timeToSolve = endTime - startTime
  }

  visualize(): GraphicsObject {
    return {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }
  }

  /**
   * Called when the solver is about to fail, but we want to see if we have an
   * "acceptable" or "passable" solution. Mostly used for optimizers that
   * have an aggressive early stopping criterion.
   */
  tryFinalAcceptance() {}

  /**
   * Override this method to return the standardized output of the solver.
   * This method should only be called after the solver has completed successfully.
   * Returns null by default - solvers with outputs should override this method.
   */
  getOutput(): any {
    return null
  }

  /**
   * A lightweight version of the visualize method that can be used to stream
   * progress
   */
  preview(): GraphicsObject {
    return {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }
  }

  noisySolve() {
    const startTime = Date.now()
    while (!this.solved && !this.failed) {
      this.step()
      console.log(JSON.stringify(makeNumbersRounded(this.visualize())))
    }
    const endTime = Date.now()
    this.timeToSolve = endTime - startTime
  }
}
