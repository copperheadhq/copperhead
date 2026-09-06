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
  | {
      role: 'tool';
      toolCallId: string;
      content: string;
      /**
       * The tool's handler *threw*. Set by the loop from the dispatch outcome,
       * because the text alone cannot say: a tool's error string and a file whose
       * contents happen to start the same way are indistinguishable once both are
       * just `content`. Providers ignore this field; it exists so local reasoning
       * about the conversation (history capping) can tell a thrown failure from a
       * result without guessing.
       *
       * Deliberately narrow: a handler that *returns* a rejection string rather
       * than throwing (`edit_file`'s "edit REVERTED: ...", `finish`'s "cannot
       * finish yet: ...", the U+FFFD corruption rejection) is not flagged here.
       * The only consumer is `read_file` supersession, where every real failure
       * throws, so widening this would add a classification with no caller. Read
       * it as "threw", not as "did not succeed".
       */
      failed?: boolean;
    };

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
  /**
   * True when this turn was replayed from the on-disk llm-cache rather than
   * fetched. Nothing went over the wire, so per-request accounting (history
   * capping's saving, for one) must not count it.
   */
  cached?: boolean;
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
  /**
   * Index of the lowest message history capping rewrote for this request, from
   * `HistoryCapStats.firstChanged`.
   *
   * Capping can rewrite an arbitrarily old message (a superseded read, a result
   * that just crossed out of the recent window), which invalidates any
   * provider-side prompt cache whose prefix covers that message. A provider that
   * places cache breakpoints uses this to keep one on the last message that did
   * not change, so the stable head of the conversation still hits the cache on
   * the turn a new trim first fires. Providers without a prompt cache ignore it.
   */
  stablePrefixBefore?: number;
}

export interface Provider {
  readonly name: string;
  chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn>;
  close?(): Promise<void>;
}
