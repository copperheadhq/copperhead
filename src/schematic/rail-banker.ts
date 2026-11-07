import { Component, Point, Pin } from './types.js';

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

export class RailBanker {
  constructor(
    private components: Component[],
    private touchesForeign: (p1: Point, p2: Point, ignoreRefs: string[]) => boolean
  ) {}

  findRailRuns(netPins: Map<string, Pin[]>): RailRun[] {
    const runs: RailRun[] = [];

    for (const [netName, pins] of netPins.entries()) {
      if (!this.isPowerNet(netName)) continue;

      const groupedByAlignment = this.groupByAlignment(pins);
      for (const alignedPins of groupedByAlignment) {
        if (alignedPins.length < 2) continue;
        alignedPins.sort((a, b) => a.pos.x - b.pos.x);

        let currentRun: Pin[] = [alignedPins[0]!];
        for (let i = 1; i < alignedPins.length; i++) {
          const prevPin = alignedPins[i - 1]!;
          const currPin = alignedPins[i]!;
          const prevStubEnd = this.getStubEnd(prevPin);
          const currStubEnd = this.getStubEnd(currPin);

          if (this.checkJoin(prevPin, currPin, prevStubEnd, currStubEnd)) {
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
    return (
      pwr.includes('VCC') ||
      pwr.includes('VDD') ||
      pwr.includes('GND') ||
      pwr.includes('VSS') ||
      pwr.startsWith('+') ||
      pwr.startsWith('-')
    );
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
    const stubLength = pin.side === 'top' ? -5.08 : 5.08;
    return { x: pin.pos.x, y: pin.pos.y + stubLength };
  }

  private checkJoin(p1: Pin, p2: Pin, s1: Point, s2: Point): boolean {
    const dist = Math.abs(p1.pos.x - p2.pos.x);
    if (dist > 15.0) return false;
    const ignoreRefs = [p1.componentRef, p2.componentRef];
    if (this.touchesForeign(s1, s2, ignoreRefs)) return false;
    if (this.touchesForeign(p1.pos, s1, [p1.componentRef])) return false;
    if (this.touchesForeign(p2.pos, s2, [p2.componentRef])) return false;
    return true;
  }

  private createRun(netName: string, pins: Pin[]): RailRun {
    const stubEnds = pins.map((p) => this.getStubEnd(p));
    const trunks: TrunkSegment[] = [];
    for (let i = 0; i < stubEnds.length - 1; i++) {
      trunks.push({
        from: stubEnds[i]!,
        to: stubEnds[i + 1]!,
        netName,
      });
    }
    return {
      netName,
      pins,
      stubEnds,
      trunks,
      hasSymbol: true,
      hasValue: false,
    };
  }
}
