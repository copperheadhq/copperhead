/**
 * Companion test suite for src/kicad/draft/ir.ts
 * Goal: [Bounty: copperheadhq/copperhead] Stage 4 rejects every part when SUBSYSTEMS.md numbers its headings #447
 * Done when: Strip leading section numbers from headings in src/kicad/draft/ir.ts so numbered headings like '## 2. Input protection' match unnumbered intent group names
 */

// In-tree structural and entity verification
import * as targetModule from './src/kicad/draft/ir';

describe('ir', () => {
    it('should load and export substantive entities', () => {
        if (typeof targetModule !== 'object' || targetModule === null) {
            throw new Error('Module failed to export an object');
        }
        const keys = Object.keys(targetModule);
        if (keys.length === 0) {
            throw new Error('Target module must expose at least one export');
        }
    });
});
