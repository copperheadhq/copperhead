import { Component, Point, Pin, Net } from './types.js';

export interface TrunkSegment {
  from: Point;
  to: Point;
  netName: string;
}

export interface RailRun {
  netName: string;
  pins: Pin[];
  stubEnds: Point[];
  trunks: TrunkSegment[];
  hasSymbol: boolean;
  hasValue: boolean;
}

/**
 * RailBanker identifies groups of adjacent passive components (like decoupling capacitors)
 * that share the same power/ground nets and can be connected via a shared trunk line
 * to save space and reduce the number of power symbols.
 */
export class RailBanker {
  constructor(
    private components: Component[],
    private touchesForeign: (p1: Point, p2: Point, ignoreRefs: string[]) => boolean
  ) {}

  /**
   * Processes components to find runs of pins that can be banked together on a single trunk.
   */
  findRailRuns(netPins: Map<string, Pin[]>): RailRun[] {
    const runs: RailRun[] = [];

    for (const [netName, pins] of netPins.entries()) {
      // Only consider power/ground nets (typically those that would have a rail symbol)
      if (!this.isPowerNet(netName)) continue;

      // Group pins by their Y coordinate (horizontal alignment) and side (top/bottom of component)
      const groupedByAlignment = this.groupByAlignment(pins);

      for (const alignedPins of groupedByAlignment) {
        if (alignedPins.length < 2) continue;

        // Sort by X coordinate
        alignedPins.sort((a, b) => a.pos.x - b.pos.x);

        let currentRun: Pin[] = [alignedPins[0]!];

        for (let i = 1; i < alignedPins.length; i++) {
          const prevPin = alignedPins[i - 1]!;
          const currPin = alignedPins[i]!;

          const prevStubEnd = this.getStubEnd(prevPin);
          const currStubEnd = this.getStubEnd(currPin);

          // Check if these two can be joined by a trunk segment
          const canJoin = this.checkJoin(prevPin, currPin, prevStubEnd, currStubEnd);

          if (canJoin) {
            currentRun.push(currPin);
          } else {
            if (currentRun.length >= 2) {
              runs.push(this.createRun(netName, currentRun));
            }
            currentRun = [currPin];
          }
        }

        if (currentRun.length >= 2) {
          runs.push(this.createRun(netName, currentRun));
        }
      }
    }

    return runs;
  }

  private isPowerNet(netName: string): boolean {
    const pwr = netName.toUpperCase();
    return pwr.includes('VCC') || pwr.includes('VDD') || pwr.includes('GND') || 
           pwr.includes('VSS') || pwr.startsWith('+') || pwr.startsWith('-');
  }

  private groupByAlignment(pins: Pin[]): Pin[][] {
    const groups = new Map<string, Pin[]>();
    for (const pin of pins) {
      const stubEnd = this.getStubEnd(pin);
      const key = `${stubEnd.y.toFixed(3)}_${pin.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(pin);
    }
    return Array.from(groups.values());
  }

  private getStubEnd(pin: Pin): Point {
    // Stubs are vertical; length is usually fixed (e.g., 2.54mm or 5.08mm)
    const stubLength = pin.side === 'top' ? -5.08 : 5.08;
    return { x: pin.pos.x, y: pin.pos.y + stubLength };
  }

  private checkJoin(p1: Pin, p2: Pin, s1: Point, s2: Point): boolean {
    // 1. Must be adjacent in the decap row (reasonable distance check)
    const dist = Math.abs(p1.pos.x - p2.pos.x);
    if (dist > 15.0) return false; // Maximum gap for banking

    // 2. Horizontal segment check: does the trunk touch any other component?
    const ignoreRefs = [p1.componentRef, p2.componentRef];
    if (this.touchesForeign(s1, s2, ignoreRefs)) return false;

    // 3. Vertical stub checks: do the stubs cross any component bodies?
    if (this.touchesForeign(p1.pos, s1, [p1.componentRef])) return false;
    if (this.touchesForeign(p2.pos, s2, [p2.componentRef])) return false;

    return true;
  }

  private createRun(netName: string, pins: Pin[]): RailRun {
    const stubEnds = pins.map(p => this.getStubEnd(p));
    const trunks: TrunkSegment[] = [];
    for (let i = 0; i < stubEnds.length - 1; i++) {
      trunks.push({
        from: stubEnds[i]!,
        to: stubEnds[i + 1]!,
        netName
      });
    }

    return {
      netName,
      pins,
      stubEnds,
      trunks,
      hasSymbol: true, // Will only draw symbol at first stubEnd
      hasValue: true
    };
  }
}
