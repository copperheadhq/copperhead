import { Component, Point, Pin, Net, SchematicIR } from './types.js';
import { RailBanker, RailRun } from './rail-banker.js';

/**
 * Renderer handles the conversion of placed components and nets into 
 * KiCad schematic elements, implementing optimizations like rail-bank trunks.
 */
export class Renderer {
  private railRuns: RailRun[] = [];
  private bankedPins = new Set<string>(); // composite key: componentRef:pinNumber

  constructor(private ir: SchematicIR) {}

  private touchesForeign = (p1: Point, p2: Point, ignoreRefs: string[]): boolean => {
    const minX = Math.min(p1.x, p2.x) + 0.1;
    const maxX = Math.max(p1.x, p2.x) - 0.1;
    const minY = Math.min(p1.y, p2.y) + 0.1;
    const maxY = Math.max(p1.y, p2.y) - 0.1;

    for (const comp of this.ir.components) {
      if (ignoreRefs.includes(comp.ref)) continue;
      const b = comp.bbox;
      // Simple AABB intersection for the segment
      if (maxX > b.min.x && minX < b.max.x && maxY > b.min.y && minY < b.max.y) {
        return true;
      }
    }
    return false;
  };

  prepareBanking() {
    const banker = new RailBanker(this.ir.components, this.touchesForeign);
    const netPins = this.collectNetPins();
    this.railRuns = banker.findRailRuns(netPins);
    
    // Mark pins that are handled by banking to avoid drawing individual symbols
    for (const run of this.railRuns) {
      run.pins.forEach((pin, idx) => {
        // The first pin in a run still "uses" the symbol logic, but others don't
        if (idx > 0) {
          this.bankedPins.add(`${pin.componentRef}:${pin.number}`);
        }
      });
    }
  }

  private collectNetPins(): Map<string, Pin[]> {
    const map = new Map<string, Pin[]>();
    for (const comp of this.ir.components) {
      for (const pin of comp.pins) {
        if (!pin.netName) continue;
        if (!map.has(pin.netName)) map.set(pin.netName, []);
        map.get(pin.netName)!.push(pin);
      }
    }
    return map;
  }

  render() {
    this.prepareBanking();

    const lines: string[] = [];

    // 1. Render Components
    for (const comp of this.ir.components) {
      lines.push(this.renderComponent(comp));
    }

    // 2. Render standard stubs and individual power symbols
    for (const comp of this.ir.components) {
      for (const pin of comp.pins) {
        if (this.bankedPins.has(`${comp.ref}:${pin.number}`)) continue;
        lines.push(this.renderPinConnection(comp, pin));
      }
    }

    // 3. Render Rail Banks (Trunks and Junctions)
    for (const run of this.railRuns) {
      // Draw the first power symbol for the run
      const firstPin = run.pins[0]!;
      lines.push(this.renderPowerSymbol(run.stubEnds[0]!, run.netName, firstPin.componentRef));

      // Draw vertical stubs for every pin in the bank
      for (let i = 0; i < run.pins.length; i++) {
        lines.push(this.renderWire(run.pins[i]!.pos, run.stubEnds[i]!));
      }

      // Draw horizontal trunk segments
      for (const trunk of run.trunks) {
        lines.push(this.renderWire(trunk.from, trunk.to));
      }

      // Draw junctions at every stub/trunk meet point (except the very ends if isolated, 
      // but banking implies internal meets)
      for (let i = 0; i < run.stubEnds.length; i++) {
        lines.push(this.renderJunction(run.stubEnds[i]!));
      }
    }

    return lines.join('\n');
  }

  private renderComponent(comp: Component): string {
    // KiCad SYMBOL generation logic...
    return `(symbol "${comp.libId}" (at ${comp.pos.x} ${comp.pos.y}) ...)`;
  }

  private renderPinConnection(comp: Component, pin: Pin): string {
    // Standard logic for non-banked pins
    return ''; 
  }

  private renderWire(p1: Point, p2: Point): string {
    return `(polyline (pts (xy ${p1.x} ${p1.y}) (xy ${p2.x} ${p2.y})) (stroke (width 0)))`;
  }

  private renderJunction(p: Point): string {
    return `(junction (at ${p.x} ${p.y}) (diameter 0) (color 0 0 0 0))`;
  }

  private renderPowerSymbol(p: Point, netName: string, ref: string): string {
    // KiCad power symbol generation at point p
    return `(symbol "power:${netName}" (at ${p.x} ${p.y}) ...)`;
  }
}
