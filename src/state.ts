import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
} from './types.js';

export const STATE_CONTEXT =
  'Judge relevance to continuing this conversation at its LATEST point, not relevance to the historical task when a call was made. History holds verbatim dialogue evidence; dialogue_index locates other text, tool_index locates calls. Other shards cover the remaining dialogue; removal requires low scores across ALL shards. Recent context and goal describe the current task; old requirements remain applicable unless superseded. A finished subtask can still supply needed evidence. Missing evidence is not proof of irrelevance.';

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * against the usage Jev reports for real transcripts, where it lands 2–18%
 * above the true count; a plain characters-per-token ratio undercounts the
 * JSON-heavy states by up to 40%.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/** Head and tail of a tool result, whitespace collapsed, for a relevance question. */
export function resultPreview(text: string, chars: number): string {
  if (chars <= 0) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= chars * 2 + 20) return flat;
  return `${flat.slice(0, chars)} … ${flat.slice(-chars)}`;
}

/** The marker every fast-jev truncation note starts with. */
export const COMPACTION_NOTE_MARKER = '[fast-jev-compaction ';

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'TaskOutput',
  'TaskList',
  'TaskGet',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'NotebookRead',
]);

/**
 * Whether a tool may have changed something outside the conversation. Only
 * known lookups are read-only; Bash, PowerShell, edits, agents and every
 * unknown tool count as side-effecting.
 */
export function hasSideEffects(tool: string): boolean {
  // A name such as get_and_delete is not a read-only contract. Unknown MCP
  // tools retain their action record just like shell commands and edits.
  return !READ_ONLY_TOOLS.has(tool);
}

const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** What a call looks at, so a later call on the same target can be recognised. */
function targetKey(tool: string, input: Record<string, unknown>): string | undefined {
  const path = stringField(input, 'file_path', 'notebook_path', 'path');
  // Different ranges of one file are not duplicate reads. Case is significant
  // on some hosts, so exact input equality is the conservative signal.
  if (tool === 'Read') return path ? `Read:${JSON.stringify(input)}` : undefined;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = stringField(input, 'command');
    return command ? `${tool}:${command.trim()}` : undefined;
  }
  try {
    return `${tool}:${JSON.stringify(input)}`;
  } catch {
    return undefined;
  }
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
  previewChars = 0,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        ...(previewChars > 0
          ? { resultPreview: resultPreview(found.result.text, previewChars) }
          : {}),
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
        sideEffects: hasSideEffects(tool.tool),
        compacted: found.result.text.includes(COMPACTION_NOTE_MARKER),
      });
    }
  });

  // Later calls on the same target: the newest wins, walking backwards.
  const latestByTarget = new Map<string, string>();
  const latestWriteByFile = new Map<string, string>();
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    const key = targetKey(call.tool, call.input);
    if (key) {
      const later = latestByTarget.get(key);
      if (later) call.repeatedBy = later;
      latestByTarget.set(key, call.id);
    }
    const path = stringField(call.input, 'file_path', 'notebook_path');
    if (!path) continue;
    const file = path;
    if (call.tool === 'Read') {
      const writer = latestWriteByFile.get(file);
      if (writer) call.targetChangedBy = writer;
    } else if (FILE_WRITERS.has(call.tool) && !call.isError) {
      latestWriteByFile.set(file, call.id);
    }
  }
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string';
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note, then old tool calls shrink to one line each, then old
 * messages that carry no call are left out, then runs of old call-only
 * messages are folded into one entry. Throws when even that is too big.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, 'full');

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}



type DialogueText = {
  i: number;
  role: Message['role'];
  text: string;
};

function dialogueTexts(messages: readonly Message[]): DialogueText[] {
  const out: DialogueText[] = [];
  messages.forEach((message, i) => {
    if (message.text.trim().length === 0) return;
    out.push({ i, role: message.role, text: message.text });
  });
  return out;
}

function indexExcerpt(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (chars <= 0 || flat.length <= chars) return chars <= 0 ? '' : flat;
  const head = Math.max(1, Math.ceil(chars * 0.6));
  const tail = Math.max(1, chars - head);
  return flat.slice(0, head) + ' … ' + flat.slice(-tail);
}

function dialogueIndex(
  dialogue: readonly DialogueText[],
  chars: number,
): Array<{ i: number; role: Message['role']; excerpt: string; chars: number }> {
  return dialogue.map((entry) => ({
    i: entry.i,
    role: entry.role,
    excerpt: indexExcerpt(entry.text, chars),
    chars: entry.text.length,
  }));
}

function toolIndex(calls: readonly ToolCall[]): string[] {
  return calls.map((call) => compactCall(call));
}

function textEntry(entry: DialogueText): HistoryEntry {
  return { i: entry.i, role: entry.role, text: entry.text };
}

function recentAssistantAnchor(
  assistants: readonly DialogueText[],
  tokenBudget: number,
): DialogueText[] {
  const picked: DialogueText[] = [];
  let used = 0;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const entry = assistants[i]!;
    const cost = estimateTokens(JSON.stringify(textEntry(entry))) + 1;
    if (picked.length > 0 && used + cost > tokenBudget) break;
    picked.push(entry);
    used += cost;
    if (used >= tokenBudget) break;
  }
  return picked.reverse();
}

type ShardBuildOptions = {
  indexChars: number;
  includeToolIndex: boolean;
  recentAnchor: readonly DialogueText[];
};

function buildShardState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  batch: readonly ToolCall[],
  selectedHistoricalAssistant: readonly DialogueText[],
  options: Pick<ResolvedCompactOptions, 'goal'>,
  build: ShardBuildOptions,
  shardLabel: string,
): FittedState {
  const dialogue = dialogueTexts(messages);
  const users = dialogue.filter((entry) => entry.role === 'user');
  const selected = new Map<number, DialogueText>();
  for (const entry of users) selected.set(entry.i, entry);
  for (const entry of build.recentAnchor) selected.set(entry.i, entry);
  for (const entry of selectedHistoricalAssistant) selected.set(entry.i, entry);

  const history = [...selected.values()]
    .sort((a, b) => a.i - b.i)
    .map(textEntry);
  const state: CompactionState = {
    context: STATE_CONTEXT,
    goal: options.goal || goalFromMessages(messages),
    history,
    dialogue_index: dialogueIndex(dialogue, build.indexChars),
    evaluating: batch.map((call) => call.id),
    shard: shardLabel,
  };
  if (build.includeToolIndex) state.tool_index = toolIndex(calls);
  return {
    state,
    tokens: estimateTokens(JSON.stringify(state)),
    stage:
      'all-user verbatim + recent assistant + assistant shard' +
      (build.includeToolIndex ? ' + tool index' : '') +
      ' + dialogue index',
  };
}

function stateFits(state: FittedState, tokenLimit: number): boolean {
  return state.tokens <= tokenLimit;
}

/**
 * Shards are planned under a label that costs at least as much as any final
 * one ('N/M: historical assistant slice', '1/1: all assistant text in recent
 * anchor'), so relabelling a planned shard can never push it over the limit.
 */
const PLANNING_SHARD_LABEL =
  '9999/9999: historical assistant slice; all assistant text in recent anchor';

type ShardGroup = {
  entries: DialogueText[];
  build: ShardBuildOptions;
};

/**
 * Overflow path: cover BOTH roles, including oversized individual messages,
 * verbatim across shards. Only the evidence sent to Jev is partitioned; the
 * output conversation is never shortened here. Scores still merge with MAX.
 * The common index and recent anchor are built once, not once per candidate.
 */
function fitDialogueShards(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  batch: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'goal'>,
  tokenLimit: number,
): FittedState[] {
  const dialogue = dialogueTexts(messages);
  const state: CompactionState = {
    context: STATE_CONTEXT,
    goal: options.goal || goalFromMessages(messages),
    history: [],
    dialogue_index: dialogue.map((entry) => `${entry.i} ${entry.role === 'user' ? 'u' : 'a'} ${entry.text.length}ch: ${indexExcerpt(entry.text, 72)}`),
    evaluating: batch.map((call) => call.id),
    shard: PLANNING_SHARD_LABEL,
    tool_index: toolIndex(calls),
  };
  const size = (): number => estimateTokens(JSON.stringify(state));
  if (size() > tokenLimit * 0.20) delete state.tool_index;
  for (const chars of [36, 0]) {
    if (size() <= tokenLimit * 0.20) break;
    state.dialogue_index = dialogue.map((entry) => `${entry.i} ${entry.role === 'user' ? 'u' : 'a'} ${entry.text.length}ch${chars ? ': ' + indexExcerpt(entry.text, chars) : ''}`);
  }
  const baseTokens = size();
  // Per-entry estimates round up. Reserve punctuation/label overhead as well.
  const cost = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 2;
  const anchors: HistoryEntry[] = [];
  let anchorTokens = 0;
  const anchorBudget = Math.min(4_000, Math.floor(tokenLimit * 0.18));
  for (const entry of dialogue.slice(-6).reverse()) {
    let anchor: HistoryEntry = textEntry(entry);
    if (cost(anchor) > anchorBudget) {
      // A marked verbatim tail anchors the latest point of an oversized turn.
      const count = Math.max(40, Math.floor(anchorBudget / 2));
      const start = Math.max(0, entry.text.length - count);
      anchor = { ...anchor, text: entry.text.slice(start), span: { start, end: entry.text.length, total: entry.text.length } };
    }
    const n = cost(anchor);
    if (anchorTokens + n > anchorBudget) continue;
    anchors.push(anchor);
    anchorTokens += n;
  }
  const capacity = tokenLimit - baseTokens - anchorTokens - 64;
  if (capacity < 128) throw new Error('Jev state limit leaves no room for full dialogue evidence');
  const anchorIds = new Set(anchors.filter((entry) => !entry.span).map((entry) => entry.i));
  const pieces: HistoryEntry[] = [];
  for (const entry of dialogue) {
    if (anchorIds.has(entry.i)) continue;
    const whole = textEntry(entry);
    if (cost(whole) <= capacity) {
      pieces.push(whole);
      continue;
    }
    let start = 0;
    while (start < entry.text.length) {
      const piece = (end: number): HistoryEntry => ({
        ...whole, text: entry.text.slice(start, end),
        span: { start, end, total: entry.text.length },
      });
      let low = start + 1;
      let high = entry.text.length;
      let end = start;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (cost(piece(mid)) <= capacity) { end = mid; low = mid + 1; }
        else high = mid - 1;
      }
      if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1] ?? '')) end -= 1;
      if (end <= start) throw new Error('Jev state limit cannot fit a dialogue fragment');
      pieces.push(piece(end));
      start = end;
    }
  }
  const groups: HistoryEntry[][] = [];
  let group: HistoryEntry[] = [];
  let used = 0;
  for (const entry of pieces) {
    const n = cost(entry);
    if (group.length > 0 && used + n > capacity) {
      groups.push(group); group = []; used = 0;
    }
    group.push(entry); used += n;
  }
  if (group.length > 0 || groups.length === 0) groups.push(group);
  return groups.map((entries, index) => {
    const output: CompactionState = {
      ...state,
      history: [...entries, ...anchors].sort((a, b) => a.i - b.i || (a.span?.start ?? 0) - (b.span?.start ?? 0)),
      shard: `${index + 1}/${groups.length}: full dialogue evidence`,
    };
    const tokens = estimateTokens(JSON.stringify(output));
    if (tokens > tokenLimit) throw new Error('internal dialogue shard planner exceeded Jev state limit');
    return { state: output, tokens, stage: 'user + assistant verbatim across dialogue shards' };
  });
}

/**
 * Creates multiple evidence states for one target batch.
 *
 * Preferred mode repeats every user message verbatim in every request. All
 * assistant messages are represented in every request by dialogue_index; recent
 * assistant text is repeated verbatim, while older assistant text is partitioned
 * into verbatim shards. Thus every assistant message is seen in full by at least
 * one request for this target batch.
 *
 * When repeating all users would crowd out evidence, both roles are covered
 * across verbatim shards instead. Oversized messages are split with offsets.
 */
export function fitBatchStates(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  batch: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'goal'>,
  tokenLimit: number = options.maxStateTokens,
): FittedState[] {
  const dialogue = dialogueTexts(messages);
  const assistants = dialogue.filter((entry) => entry.role === 'assistant');

  const userTokens = dialogue.filter((entry) => entry.role === 'user')
    .reduce((sum, entry) => sum + estimateTokens(JSON.stringify(textEntry(entry))) + 1, 0);
  if (userTokens > tokenLimit * 0.4 || dialogue.some((entry) => estimateTokens(entry.text) > tokenLimit * 0.65)) {
    return fitDialogueShards(messages, calls, batch, options, tokenLimit);
  }

  // Keep a useful fresh assistant anchor in every shard, but leave most of the
  // state budget available for one historical full-text slice.
  const anchorBudget = Math.max(1_000, Math.min(6_000, Math.floor(tokenLimit * 0.22)));
  const recent = recentAssistantAnchor(assistants, anchorBudget);

  // Start rich, then remove only global indexes/anchor detail when necessary.
  let build: ShardBuildOptions = {
    indexChars: 120,
    includeToolIndex: true,
    recentAnchor: recent,
  };

  const base = (): FittedState =>
    buildShardState(messages, calls, batch, [], options, build, PLANNING_SHARD_LABEL);

  // Aim to leave at least ~25% of state capacity for a historical full-text
  // slice; this is a soft target, not a content deletion rule.
  const desiredBase = Math.floor(tokenLimit * 0.75);
  let probe = base();
  if (probe.tokens > desiredBase) {
    build = { ...build, includeToolIndex: false };
    probe = base();
  }
  if (probe.tokens > desiredBase) {
    build = { ...build, indexChars: 72 };
    probe = base();
  }
  while (probe.tokens > desiredBase && build.recentAnchor.length > 1) {
    build = { ...build, recentAnchor: build.recentAnchor.slice(1) };
    probe = base();
  }
  if (probe.tokens > tokenLimit) {
    build = { ...build, indexChars: 36, includeToolIndex: false };
    probe = base();
  }
  while (probe.tokens > tokenLimit && build.recentAnchor.length > 0) {
    build = { ...build, recentAnchor: build.recentAnchor.slice(1) };
    probe = base();
  }
  if (probe.tokens > tokenLimit) {
    return fitDialogueShards(messages, calls, batch, options, tokenLimit);
  }

  const finalRecentIds = new Set(build.recentAnchor.map((entry) => entry.i));
  const historical = assistants.filter((entry) => !finalRecentIds.has(entry.i));

  // No historical assistant text: one complete state is enough.
  if (historical.length === 0) {
    probe.state.shard = '1/1: all assistant text in recent anchor';
    probe.tokens = estimateTokens(JSON.stringify(probe.state));
    return [probe];
  }

  const groups: ShardGroup[] = [];
  let current: DialogueText[] = [];

  const planned = (
    group: readonly DialogueText[],
    groupBuild: ShardBuildOptions = build,
  ): FittedState =>
    buildShardState(messages, calls, batch, group, options, groupBuild, PLANNING_SHARD_LABEL);

  for (const entry of historical) {
    const proposed = [...current, entry];
    if (stateFits(planned(proposed), tokenLimit)) {
      current = proposed;
      continue;
    }

    if (current.length > 0) {
      groups.push({ entries: current, build });
      // One-message overlap gives local continuity across shard boundaries.
      const withOverlap = [...current.slice(-1), entry];
      current = stateFits(planned(withOverlap), tokenLimit) ? withOverlap : [entry];
    } else {
      current = [entry];
    }

    if (!stateFits(planned(current), tokenLimit)) {
      // For one unusually large assistant message, remove every optional global
      // structure before conceding that the message itself cannot fit. The
      // shard keeps that minimal build: the final state is built from it too.
      const minimal: ShardBuildOptions = {
        indexChars: 24,
        includeToolIndex: false,
        recentAnchor: [],
      };
      const single = planned([entry], minimal);
      if (!stateFits(single, tokenLimit)) {
        return fitDialogueShards(messages, calls, batch, options, tokenLimit);
      }
      groups.push({ entries: [entry], build: minimal });
      current = [];
    }
  }
  if (current.length > 0) groups.push({ entries: current, build });

  const states = groups.map((group, index) => {
    const state = buildShardState(
      messages,
      calls,
      batch,
      group.entries,
      options,
      group.build,
      String(index + 1) + '/' + String(groups.length) + ': historical assistant slice',
    );
    if (!stateFits(state, tokenLimit)) {
      throw new Error(
        'internal shard planner exceeded Jev state limit (~' +
          state.tokens +
          ' tokens, limit ' +
          tokenLimit +
          ')',
      );
    }
    return state;
  });

  return states;
}

/** Backward-compatible single-state helper for short conversations. */
export function fitBatchState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  batch: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'goal'>,
  tokenLimit: number = options.maxStateTokens,
): FittedState {
  const states = fitBatchStates(messages, calls, batch, options, tokenLimit);
  if (states.length !== 1) {
    throw new Error(
      'conversation requires ' +
        states.length +
        ' Jev evidence shards; use fitBatchStates() instead of fitBatchState()',
    );
  }
  return states[0]!;
}

