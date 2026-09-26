export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  /** Head/tail preview of the actual result shown to Jev when scoring result relevance. */
  resultPreview?: string;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
  /**
   * The call may have changed something outside the conversation (a file, a
   * repository, a remote service). Its record is never removed; at most its
   * result is shortened. Unknown tools count as side-effecting.
   */
  sideEffects: boolean;
  /** The result already carries a fast-jev compaction note: nothing left to shorten. */
  compacted: boolean;
  /** A later call with the same tool and target (same file, same command), by id. */
  repeatedBy?: string;
  /** A later call wrote the file this call read. */
  targetChangedBy?: string;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the result content is still relevant to continuing. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  /** The engine's id of the call, for matching a decision to the transcript. */
  tool_use_id?: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'paged_for_target';
}

export interface AssistantTextDecision {
  /** Original message index in the transcript passed to compact(). */
  index: number;
  keep: number;
  action: 'keep' | 'drop_text';
  reason: 'pinned' | 'kept' | 'text_dropped';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Character offsets when an oversized message is split across evidence shards. */
  span?: { start: number; end: number; total: number };
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  /** Full-text dialogue evidence present in this shard, chronological. */
  history: HistoryEntry[];
  /** Compact map of every text message across the whole conversation. */
  dialogue_index?: Array<{ i: number; role: Role; excerpt: string; chars: number }> | string[];
  /** Compact chronology of tool activity across the whole conversation. */
  tool_index?: string[];
  /** Tool-call ids being judged in this request; target details live in each question. */
  evaluating?: string[];
  /** Diagnostic description of which full-text slice this state contains. */
  shard?: string;
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting/sharding stage produced the state, for diagnostics. */
  stage: string;
}

export interface CompactOptions {
  /** Soft request budget; a complete evidence-shard group is always atomic. Default 16. */
  maxJevRequests?: number;
  /** Host sweep state: already-reviewed ids go after unreviewed candidates. Never authorizes deletion. */
  recentlyReviewedToolUseIds?: readonly string[];
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for one Jev state (hard-clamped to 31000, below the 32k state+question limit). Default 31000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for one whole Jev request (hard-clamped to 62000, below the 64k limit). Default 62000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /** Characters from each end of a tool result shown to Jev while scoring it. Default 1000. */
  resultPreviewChars?: number;
  /** Also score old assistant text for relevance; user text is never removed. Default false. */
  compactAssistantText?: boolean;
  /**
   * Where the full text of a shortened result can be read back, named in its
   * note: `page(tool_use_id)` is a file the host writes, `transcript` the
   * session's .jsonl. Absent, the note names neither path.
   */
  /**
   * Tokens of visible content the compaction should take out at least. Jev's
   * scores are well ordered but poorly calibrated (most sit in 0.5–0.7), so
   * a threshold alone either keeps nearly everything or nearly nothing.
   * With a target, results are paged out lowest score first until it is met;
   * paging keeps the whole output one file read away, so this loses nothing.
   */
  cutTokens?: number;
  pages?: {
    page?: (toolUseId: string) => string | undefined;
    /** The page holding the whole input of an old file-writer call; its long fields are paged out when present. */
    inputPage?: (toolUseId: string) => string | undefined;
    transcript?: string;
  };
}

export interface ResolvedCompactOptions {
  maxJevRequests: number;
  recentlyReviewedToolUseIds: readonly string[];
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  resultPreviewChars: number;
  compactAssistantText: boolean;
  pages: NonNullable<CompactOptions['pages']>;
  cutTokens: number;
}

export interface CompactResult {
  /** Calls scored against every evidence shard in this pass; for the host's sweep cursor. */
  reviewedToolUseIds: string[];
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  assistantTextDecisions: AssistantTextDecision[];
  stats: {
    /** Old file-writer inputs paged out, and the characters that took out. */
    inputsPaged: number;
    /** Results paged out beyond the threshold to reach cutTokens. */
    pagedForTarget: number;
    inputCharsSaved: number;
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    assistantTexts: number;
    assistantTextsKept: number;
    assistantTextsDropped: number;
    /** Candidates Jev was asked about; the rest had nothing left to shorten. */
    asked: number;
    /** Eligible calls safely deferred to a later pass by the request budget. */
    deferred: number;
    /** Result keep probabilities of the asked calls, bucketed: <0.1, <0.3, <0.5, <0.9, >=0.9. */
    resultScores: [number, number, number, number, number];
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  /** TypeSafe accepts string or structured JSON instructions. */
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Progress of one compaction, for a host that shows it. */
export interface CompactObserver {
  /** Requests planned once batching is done; assistant-text questions may add more. */
  planned?(requests: number): void;
  /** Before each Jev request: its 1-based index and the planned total so far. */
  request?(index: number, planned: number): void;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
