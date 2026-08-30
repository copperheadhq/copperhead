import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';
import { vertexDatedIdError, type VertexSettings } from '../../config.js';
import { DEFAULT_CLAUDE_MODEL, sendAnthropic, type AnthropicLikeClient } from './anthropic-wire.js';

/**
 * Claude via Google Cloud Vertex AI. Authenticates with Application Default
 * Credentials (a service account, `gcloud auth application-default login`, or
 * a metadata server) — never `ANTHROPIC_API_KEY`, which this route neither
 * reads nor sends. The credential itself is held and refreshed by the Google
 * auth library inside the SDK; copperhead handles only project and region.
 *
 * The request/response shape is shared with the first-party provider via
 * anthropic-wire.ts (design D4). `name` is 'vertex', not 'anthropic', so
 * `otherProvider()`'s keyed failover can never move a governed GCP run onto a
 * personal API key on a 429 (design D5).
 */
export class VertexProvider implements Provider {
  readonly name = 'vertex';
  private readonly model: string;
  private readonly project: string;
  private readonly region: string;

  constructor(
    model: string | undefined,
    settings: VertexSettings,
    /** Test seam: bypass the lazy SDK import. */
    private readonly client?: AnthropicLikeClient,
  ) {
    this.model = model ?? DEFAULT_CLAUDE_MODEL;
    // Same rule doctor's preflight applies, from one definition (design D3).
    const dated = vertexDatedIdError(this.model);
    if (dated) throw new Error(dated);
    if (!settings.project) {
      throw new Error(
        'vertex requires a GCP project: set COPPERHEAD_VERTEX_PROJECT, "vertexProject" in .copperhead/config.json, or ANTHROPIC_VERTEX_PROJECT_ID. There is no default project.',
      );
    }
    this.project = settings.project;
    this.region = settings.region;
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const client = this.client ?? (await this.makeClient());
    return sendAnthropic(client, this.model, messages, tools, opts);
  }

  private async makeClient(): Promise<AnthropicLikeClient> {
    // Non-literal `import()` on purpose, same as claude-code.ts: the SDK is an
    // optionalDependency, so a literal specifier would make tsc resolve its
    // types and break the build on an install without it. The client type is
    // held locally (AnthropicLikeClient), so nothing needs the SDK's types.
    const specifier = '@anthropic-ai/vertex-sdk';
    const mod = (await import(/* @vite-ignore */ specifier).catch((err: unknown) => {
      throw new Error(
        'Vertex provider requires the optional @anthropic-ai/vertex-sdk package; install it alongside Copperhead before using --model vertex',
        { cause: err },
      );
    })) as { AnthropicVertex: new (opts: { projectId: string; region: string }) => AnthropicLikeClient };
    if (typeof mod.AnthropicVertex !== 'function') {
      throw new Error('@anthropic-ai/vertex-sdk did not export AnthropicVertex; the installed version may be incompatible');
    }
    return new mod.AnthropicVertex({ projectId: this.project, region: this.region });
  }
}
