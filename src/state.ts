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
  'A coding-assistant conversation is being compacted. This request is one evidence shard from the same conversation. `history` contains every user text message verbatim, a verbatim recent assistant anchor, and one verbatim historical assistant slice; `dialogue_index` maps the entire text dialogue so omitted assistant slices remain globally locatable; `tool_index`, when present, is a compact chronology of tool activity. Other shards evaluate the same targets against the other assistant slices. Each question asks whether one historical tool call or result contains information relevant to correctly continuing this same conversation from its latest point.';

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
      });
    }
  });
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
 * Creates multiple evidence states for one target batch.
 *
 * Preferred mode repeats every user message verbatim in every request. All
 * assistant messages are represented in every request by dialogue_index; recent
 * assistant text is repeated verbatim, while older assistant text is partitioned
 * into verbatim shards. Thus every assistant message is seen in full by at least
 * one request for this target batch.
 *
 * If the mandatory all-user base itself exceeds the physical state limit, this
 * function fails explicitly rather than silently abridging user instructions.
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
    buildShardState(messages, calls, batch, [], options, build, 'base');

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
    throw new Error(
      'all user messages plus the minimal global dialogue index exceed the Jev state limit (~' +
        probe.tokens +
        ' tokens, limit ' +
        tokenLimit +
        '); cannot preserve every user message verbatim in each shard',
    );
  }

  const finalRecentIds = new Set(build.recentAnchor.map((entry) => entry.i));
  const historical = assistants.filter((entry) => !finalRecentIds.has(entry.i));

  // No historical assistant text: one complete state is enough.
  if (historical.length === 0) {
    probe.state.shard = '1/1: all assistant text in recent anchor';
    probe.tokens = estimateTokens(JSON.stringify(probe.state));
    return [probe];
  }

  const groups: DialogueText[][] = [];
  let current: DialogueText[] = [];

  const fitsGroup = (group: readonly DialogueText[]): FittedState =>
    buildShardState(messages, calls, batch, group, options, build, 'planning');

  for (const entry of historical) {
    const proposed = [...current, entry];
    const test = fitsGroup(proposed);
    if (stateFits(test, tokenLimit)) {
      current = proposed;
      continue;
    }

    if (current.length > 0) {
      groups.push(current);
      // One-message overlap gives local continuity across shard boundaries.
      const overlap = current.slice(-1);
      const withOverlap = [...overlap, entry];
      if (stateFits(fitsGroup(withOverlap), tokenLimit)) current = withOverlap;
      else current = [entry];
    } else {
      current = [entry];
    }

    if (!stateFits(fitsGroup(current), tokenLimit)) {
      // For one unusually large assistant message, remove every optional global
      // structure before conceding that the message itself cannot fit.
      const minimal: ShardBuildOptions = {
        indexChars: 24,
        includeToolIndex: false,
        recentAnchor: [],
      };
      const single = buildShardState(
        messages,
        calls,
        batch,
        [entry],
        options,
        minimal,
        'single-large-message',
      );
      if (!stateFits(single, tokenLimit)) {
        throw new Error(
          'one assistant text message cannot fit verbatim with all user messages in a Jev shard (~' +
            single.tokens +
            ' tokens, limit ' +
            tokenLimit +
            ')',
        );
      }
      if (groups.length === 0 || groups.at(-1) !== current) {
        groups.push([entry]);
      }
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const states = groups.map((group, index) => {
    const state = buildShardState(
      messages,
      calls,
      batch,
      group,
      options,
      build,
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

