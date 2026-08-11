export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface Turn {
  text: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /**
   * A one-line steer for a turn that produced NO tool call but clearly *intended*
   * one — e.g. a fenced ```json block that names a real tool yet fails to parse
   * (unbalanced braces). The loop surfaces it in place of the generic
   * "continue using tools" nudge so the model fixes the malformed call instead of
   * misreading the silence as a broken tool (#I10). Providers that can't detect
   * a near-miss simply never set it.
   */
  nudge?: string;
}

export interface ChatOpts {
  maxTokens?: number;
  /**
   * Liveness callback for the loop's heartbeat (5.1). A streaming provider calls
   * it as output arrives, passing the cumulative streamed-output length in chars,
   * so a slow turn can be told apart from a hung one. Providers that don't stream
   * simply never call it (the heartbeat still reports elapsed time). Never used
   * for billing — real token usage is reported once, on the returned Turn.
   */
  onStream?: (streamedChars: number) => void;
}

export interface Provider {
  readonly name: string;
  chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn>;
  close?(): Promise<void>;
  /**
   * The concrete model id this provider will actually use, when the routing
   * string does not name it. A backend that hosts whichever model the user
   * loaded (`--model lmstudio`) resolves it here so run metadata records which
   * model designed the board, and so the response-cache key distinguishes two
   * different local models instead of replaying one's turns for the other (F6).
   * Best-effort: the loop falls back to the routing string if this throws.
   *
   * `log` lets a provider surface how it arrived at the id, for the case where
   * resolution is a choice rather than a lookup (a server listing several models
   * cannot say which is loaded). Optional so existing providers are unaffected.
   */
  resolvedModelId?(log?: (line: string) => void): Promise<string>;
  /** Endpoint that identifies this backend for response-cache isolation. */
  cacheKeyEndpoint?(): string | undefined;
  /** Whether resolving the model id makes a network discovery request. */
  needsModelDiscovery?(): boolean;
}
