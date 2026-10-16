import { describe, it, expect } from 'vitest';
import { STAGES } from '../src/commands/create.js';
import { TOOLS } from '../src/agent/tools.js';

/**
 * Issue #228: the outputs stage asked for a fabrication package while naming
 * only `export_svg`, which renders and cannot produce gerbers, drill, DXF or
 * STEP. `export_outputs` does exist and wraps `exportFab`, but it is an edit
 * tool, so it stays out of the advertised list until a proposal validates —
 * the stage never mentioned it, so nothing told the agent it was reachable.
 *
 * These pin the contract rather than the wording: whatever artifacts the stage
 * demands, it must name a tool that can actually produce them.
 */

const outputsStage = STAGES.find((s) => s.name === 'outputs');

describe('outputs stage tooling (issue #228)', () => {
  it('the stage exists and asks for a fabrication package', () => {
    expect(outputsStage, 'the outputs stage should exist').toBeDefined();
    const prompt = outputsStage!.prompt();
    expect(prompt).toMatch(/gerber/i);
    expect(prompt).toMatch(/drill/i);
  });

  it('names a tool that can produce the artifacts it demands', () => {
    const prompt = outputsStage!.prompt();
    // export_svg renders only; the fab package comes from export_outputs.
    expect(prompt).toContain('export_outputs');
  });

  it('export_outputs is a real registered tool', () => {
    const tool = TOOLS.find((t) => t.schema.name === 'export_outputs');
    expect(tool, 'export_outputs should be registered').toBeDefined();
    expect(tool!.schema.description).toMatch(/gerber/i);
  });

  it('tells the agent how to reach an unlock-gated export tool', () => {
    const tool = TOOLS.find((t) => t.schema.name === 'export_outputs');
    // If the tool is unlock-gated, the prompt has to say how to unlock it,
    // otherwise naming it is not enough to make it reachable.
    if (tool!.requiresUnlock) {
      expect(outputsStage!.prompt()).toMatch(/validate/i);
    }
  });
});
