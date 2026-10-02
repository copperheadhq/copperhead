// Propose circuit-block roles from block-map context bundles (add-binding-proposals):
//
//   copperhead-tools block-map <design> [--board ...] [--parts ...] --context unbound --format json > map.json
//   npx tsx scripts/propose-bindings.ts map.json --out bindings.yaml
//   copperhead-tools block-map <design> ... --bindings bindings.yaml     # each proposed part is checked
//
// One reasoning-only Claude call (tools disabled, one turn, via the Claude Code saved login) per file
// of bundles. The output is a bindings file v1 with proposedBy; block-map treats it as untrusted.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Document } from "yaml";
import { parseJsonReply } from "../adapters/extractor-common";
import { buildPrompt, type ContextBundle, parseProposal, PROPOSER_VERSION } from "../proposals/bindings";

async function ask(prompt: string, model: string | undefined): Promise<string> {
  let text = "";
  for await (const msg of query({
    prompt,
    options: {
      ...(model ? { model } : {}),
      tools: [],
      disallowedTools: ["*"],
      canUseTool: async (toolName) => ({ behavior: "deny", message: `the bindings proposer is reasoning-only (blocked ${toolName})`, interrupt: true }),
      maxTurns: 1,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, CLAUDECODE: undefined } as Record<string, string | undefined>,
    },
  })) {
    if (msg.type === "assistant") for (const block of msg.message?.content ?? []) if (block.type === "text" && block.text) text += block.text;
  }
  return text;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const out = i >= 0 ? args[i + 1] : undefined;
  const input = args[0];
  if (!input) throw new Error("usage: scripts/propose-bindings.ts <block-map-result.json> [--out bindings.yaml]");
  const result = JSON.parse(readFileSync(input, "utf8")) as { data?: { context?: ContextBundle[] } };
  const bundles = result.data?.context ?? [];
  if (!bundles.length) throw new Error(`${input} holds no context bundles: run block-map with --context`);
  const prompt = buildPrompt(bundles);
  const model = process.env.INTAKE_EXTRACTOR_MODEL;
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  const reply = parseJsonReply(await ask(prompt, model));
  const { blocks, dropped } = parseProposal(reply, bundles);
  const doc = new Document({
    version: 1,
    proposedBy: `claude-code${model ? `:${model}` : ""} (${PROPOSER_VERSION}, prompt ${promptHash})`,
    blocks: blocks.map((b) => ({ anchor: b.anchor, kind: b.kind, roles: b.roles, notes: b.why })),
  });
  doc.commentBefore = ` Proposed by a model from block-map context bundles; block-map checks every part against its role's nets.${dropped.length ? `\n Dropped from the reply: ${dropped.join("; ")}` : ""}`;
  const text = doc.toString({ lineWidth: 0 });
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  console.error(`${blocks.length} block(s) proposed for ${bundles.length} part(s); ${dropped.length} item(s) dropped`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
