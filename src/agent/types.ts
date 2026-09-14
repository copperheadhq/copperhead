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

export interface WithheldCall {
  name: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface Turn {
  text: string | null;
  toolCalls: ToolCall[];
  withheld?: WithheldCall[];
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
   * Progress callback (5.1). A streaming provider calls it as the turn makes
   * progress, passing the cumulative streamed-output length in chars. The loop
   * uses it twice: the heartbeat shows the count, so a slow turn can be told
   * apart from a hung one, and every call restarts the turn's inactivity
   * watchdog, so a long turn that keeps producing output is not aborted as hung.
   * Call it on any progress (thinking, block boundaries), not only new text; an
   * unchanged count is fine. Providers that don't stream simply never call it
   * (the heartbeat still reports elapsed time, and the watchdog acts as a
   * whole-turn deadline). Never used for billing — real token usage is reported
   * once, on the returned Turn.
   */
  onStream?: (streamedChars: number) => void;
}

export interface Provider {
  readonly name: string;
  chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn>;
  close?(): Promise<void>;
}
