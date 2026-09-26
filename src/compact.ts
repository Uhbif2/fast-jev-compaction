import { noulAnswer } from './request.js';
import { pageWriterInputs } from './inputs.js';
import {
  collectToolCalls,
  COMPACTION_NOTE_MARKER,
  estimateTokens,
  fitBatchStates,
  hasSideEffects,
} from './state.js';
import type {
  AssistantTextDecision,
  CallAnswer,
  CallDecision,
  CompactObserver,
  CompactOptions,
  CompactResult,
  CompactionState,
  FittedState,
  JevAsker,
  JevQuestion,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  maxJevRequests: 16,
  recentlyReviewedToolUseIds: [],
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 31_000,
  maxRequestTokens: 62_000,
  truncateHeadChars: 300,
  resultPreviewChars: 1_000,
  compactAssistantText: false,
  pages: {},
  cutTokens: 0,
};

/** TypeSafe Jev 1.13 physical limits. */
const JEV_TOTAL_REQUEST_TOKENS = 64_000;
const JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS = 32_000;
/** Conservative room for model/key/envelope fields and estimator error. */
const REQUEST_OVERHEAD_TOKENS = 100;
const CONTEXT_SAFETY_MARGIN_TOKENS = 400;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    maxJevRequests: Math.max(1, Math.floor(finite(options.maxJevRequests, DEFAULT_OPTIONS.maxJevRequests))),
    recentlyReviewedToolUseIds: options.recentlyReviewedToolUseIds ?? [],
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    maxStateTokens: Math.min(
      31_000,
      Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    ),
    maxRequestTokens: Math.min(
      62_000,
      Math.max(1, finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    resultPreviewChars: Math.max(
      0,
      Math.floor(finite(options.resultPreviewChars, DEFAULT_OPTIONS.resultPreviewChars)),
    ),
    compactAssistantText:
      typeof options.compactAssistantText === 'boolean'
        ? options.compactAssistantText
        : DEFAULT_OPTIONS.compactAssistantText,
    pages: options.pages ?? DEFAULT_OPTIONS.pages,
    cutTokens: Math.max(0, finite(options.cutTokens, DEFAULT_OPTIONS.cutTokens)),
  };
}

function boundedInput(input: Record<string, unknown>, limit = 1_000): string {
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    text = '[unserializable input]';
  }
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

/** What later calls tell about this one, for the question. */
function laterEvidence(call: ToolCall): Record<string, string> {
  const evidence: Record<string, string> = {};
  if (call.repeatedBy) evidence.same_target_called_again_by = call.repeatedBy;
  if (call.targetChangedBy) evidence.file_modified_later_by = call.targetChangedBy;
  return evidence;
}

/**
 * Atomic Noul judgments on informational relevance to a correct continuation,
 * not on reproducibility or retention strategy. The criteria say what stays
 * either way (the call record and a short head and tail of its output), so a
 * probability measures the information that removing the rest would lose.
 * A side-effecting call's record is never removed, so it gets only the
 * result question.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  const targetCall = {
    id: call.id,
    tool: call.tool,
    input: boundedInput(call.input),
    ...laterEvidence(call),
  };
  const questions: JevQuestions = {
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: {
        question:
          'Does this historical tool result contain information still needed to correctly continue this conversation at its latest point?',
        target_call: targetCall,
        result: {
          chars: call.resultChars,
          is_error: call.isError,
          preview: call.resultPreview ?? '',
        },
      },
      criteria: {
        true:
          'A specific value, identifier, error, observation, constraint or evidence is needed for unfinished work, an open question, a still-applicable user requirement, or understanding the current state, and later messages do not preserve it. Uncertainty about missing preview content is not evidence that it is irrelevant.',
        false:
          'The information is fully superseded, duplicated in later dialogue, or unrelated to continuation. A completed subtask or later read/edit is evidence to consider, not sufficient by itself: no unique detail from this output is still needed.',
      },
    },
  };
  if (call.sideEffects) return questions;
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: {
        question:
          'Is the record that this historical lookup happened (tool, target, input) still needed to correctly continue the current conversation from its latest point?',
        target_call: targetCall,
      },
      criteria: {
        true:
          'Later reasoning relies on this lookup having been done on this target, or its target is still being worked on and nothing later covers it, so forgetting it would mislead the continuation or cause the same lookup to be repeated needlessly.',
        false:
          'The lookup no longer matters: its target was looked up again or changed later, it belongs to a finished subtask, or its outcome is fully stated in later messages.',
      },
    },
    ...questions,
  };
}

function questionTokenStats(batch: readonly ToolCall[]): {
  questions: JevQuestions;
  total: number;
  longest: number;
} {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const sizes = Object.values(questions).map((q: JevQuestion) =>
    estimateTokens(JSON.stringify(q)),
  );
  return {
    questions,
    total: sizes.reduce((sum, n) => sum + n, 0),
    longest: sizes.length > 0 ? Math.max(...sizes) : 0,
  };
}

export function assistantTextQuestion(index: number): JevQuestion {
  return {
    type: 'noul',
    instructions: {
      question:
        'Does this historical assistant message contain information relevant to correctly continuing the current conversation from its latest point?',
      target_message_index: index,
      location:
        'The complete target text is the assistant entry in state.history whose i equals target_message_index.',
    },
    criteria: {
      true:
        'The message contributes at least one still-applicable fact, observed state, decision, constraint, commitment, unresolved task, rationale, causal link, warning, result interpretation, path/value, or other information that can affect a correct continuation of this same conversation.',
      false:
        'The message is purely transient narration or acknowledgement, or every informative part is fully superseded, duplicated, invalidated, or otherwise irrelevant to every still-applicable user requirement and to the current state; its text adds no information needed for a correct continuation.',
    },
  };
}

function assistantQuestionTokenStats(indices: readonly number[]): {
  questions: JevQuestions;
  total: number;
  longest: number;
} {
  const questions: JevQuestions = Object.fromEntries(
    indices.map((index) => [`assistant_${index}`, assistantTextQuestion(index)]),
  );
  const sizes = Object.values(questions).map((q: JevQuestion) =>
    estimateTokens(JSON.stringify(q)),
  );
  return {
    questions,
    total: sizes.reduce((sum, n) => sum + n, 0),
    longest: sizes.length > 0 ? Math.max(...sizes) : 0,
  };
}

export function assistantTextCandidateIndices(
  messages: readonly Message[],
  preserveRecentMessages: number,
): number[] {
  const preserveStart = Math.max(0, messages.length - Math.max(0, preserveRecentMessages));
  const indices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (index === 0 || index >= preserveStart) continue;
    if (message.role !== 'assistant' || message.text.trim().length === 0) continue;
    indices.push(index);
  }
  return indices;
}

function batchAssistantIndices(
  indices: readonly number[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
  baseQuestionTokens = 0,
): number[][] {
  const requestLimit = Math.min(options.maxRequestTokens, JEV_TOTAL_REQUEST_TOKENS);
  const batches: number[][] = [];
  let current: number[] = [];
  for (const index of indices) {
    const single = assistantQuestionTokenStats([index]);
    if (
      stateTokens + single.longest + REQUEST_OVERHEAD_TOKENS >
      JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS
    ) {
      throw new Error(
        'assistant-text state plus longest question exceeds Jev 32k limit (~' +
          (stateTokens + single.longest) +
          ' tokens)',
      );
    }
    const proposed = [...current, index];
    const stats = assistantQuestionTokenStats(proposed);
    if (
      current.length > 0 &&
      stateTokens + baseQuestionTokens + stats.total + REQUEST_OVERHEAD_TOKENS > requestLimit
    ) {
      batches.push(current);
      current = [index];
    } else {
      current = proposed;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function askAssistantBatch(
  asker: JevAsker,
  state: CompactionState,
  indices: readonly number[],
): Promise<Map<number, number>> {
  const questions = assistantQuestionTokenStats(indices).questions;
  const { answers } = await asker.ask(state, questions);
  return new Map(
    indices.map((index) => [index, noulAnswer(answers, `assistant_${index}`)]),
  );
}

/**
 * Legacy helper retained for library users. It now enforces both Jev limits:
 * 64k total request and 32k for state + the longest individual question.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const requestLimit = Math.min(options.maxRequestTokens, JEV_TOTAL_REQUEST_TOKENS);
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  for (const call of calls) {
    const single = questionTokenStats([call]);
    if (
      stateTokens + single.longest + REQUEST_OVERHEAD_TOKENS >
      JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS
    ) {
      throw new Error(
        'state plus longest question exceeds Jev 32k limit (~' +
          (stateTokens + single.longest) +
          ' tokens)',
      );
    }
    const proposed = [...current, call];
    const stats = questionTokenStats(proposed);
    if (
      current.length > 0 &&
      stateTokens + stats.total + REQUEST_OVERHEAD_TOKENS > requestLimit
    ) {
      batches.push(current);
      current = [call];
    } else {
      current = proposed;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'> & Partial<Pick<ToolCall, 'sideEffects' | 'tool_use_id'>>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, ...(call.tool_use_id ? { tool_use_id: call.tool_use_id } : {}), tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  // A call that may have changed the world keeps its record: without it the
  // continuation cannot know the change happened (and may repeat it).
  if (call.sideEffects || answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

type BatchAnswers = {
  calls: Map<string, CallAnswer>;
  assistantTexts: Map<number, number>;
};

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  assistantIndices: readonly number[] = [],
): Promise<BatchAnswers> {
  const questions: JevQuestions = {
    ...questionTokenStats(batch).questions,
    ...assistantQuestionTokenStats(assistantIndices).questions,
  };
  if (Object.keys(questions).length === 0) {
    return { calls: new Map(), assistantTexts: new Map() };
  }
  const { answers } = await asker.ask(state, questions);
  return {
    calls: new Map(
      batch.map((call) => [
        call.id,
        {
          keepCall: call.sideEffects ? 1 : noulAnswer(answers, `call_${call.id}`),
          keepResult: noulAnswer(answers, `result_${call.id}`),
        },
      ]),
    ),
    assistantTexts: new Map(
      assistantIndices.map((index) => [
        index,
        noulAnswer(answers, `assistant_${index}`),
      ]),
    ),
  };
}

type BatchPlan = {
  batch: ToolCall[];
  states: FittedState[];
};

/** The same shard with `evaluating` narrowed to one batch; never larger than the layout. */
function stateForBatch(layout: FittedState, batch: readonly ToolCall[]): FittedState {
  const state: CompactionState = { ...layout.state, evaluating: batch.map((call) => call.id) };
  return { state, tokens: estimateTokens(JSON.stringify(state)), stage: layout.stage };
}

/**
 * Plans every request in one pass. The shard layout does not depend on the
 * batch except for `evaluating`, so it is fitted once with every candidate
 * listed there (no batch lists more) and under the longest question of all;
 * questions are then packed greedily against the largest shard. Linear in the
 * candidates, where fitting shards per growing batch was quadratic.
 */
function planBatches(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  candidates: readonly ToolCall[],
  options: ResolvedCompactOptions,
): BatchPlan[] {
  const sized = candidates.map((call) => {
    const sizes = Object.values(questionsFor(call)).map((q) => estimateTokens(JSON.stringify(q)));
    return { call, total: sizes.reduce((sum, n) => sum + n, 0), longest: Math.max(0, ...sizes) };
  });
  const longest = Math.max(0, ...sized.map((entry) => entry.longest));
  const stateLimit = Math.min(
    options.maxStateTokens,
    JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS -
      longest -
      REQUEST_OVERHEAD_TOKENS -
      CONTEXT_SAFETY_MARGIN_TOKENS,
  );
  if (stateLimit < 1) {
    throw new Error('a Jev question is too large to leave room for conversation state');
  }
  // `evaluating` is reserved rather than laid out: fitted with every candidate
  // id, the layout's soft 75% base target would drop the tool index for the
  // sake of a list no single request carries.
  const evaluatingReserve = estimateTokens(JSON.stringify(candidates.map((call) => call.id)));
  if (stateLimit - evaluatingReserve < 1) {
    throw new Error('too many Jev candidates to list in one state');
  }
  const layout = fitBatchStates(messages, calls, [], options, stateLimit - evaluatingReserve);
  const stateTokens = Math.max(...layout.map((state) => state.tokens)) + evaluatingReserve;
  if (stateTokens + longest + REQUEST_OVERHEAD_TOKENS > JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS) {
    throw new Error('batch shard exceeds Jev 32k state+longest-question limit');
  }
  const requestLimit = Math.min(options.maxRequestTokens, JEV_TOTAL_REQUEST_TOKENS);

  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let used = 0;
  for (const { call, total } of sized) {
    if (stateTokens + total + REQUEST_OVERHEAD_TOKENS > requestLimit) {
      throw new Error('one Jev candidate cannot fit within the request limits');
    }
    if (current.length > 0 && stateTokens + used + total + REQUEST_OVERHEAD_TOKENS > requestLimit) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(call);
    used += total;
  }
  if (current.length > 0) batches.push(current);
  return batches.map((batch) => ({
    batch,
    states: layout.map((state) => stateForBatch(state, batch)),
  }));
}

/**
 * A shortened result: head and tail of the output around a note. The note
 * says where the whole text can be read back, a page file first, so that
 * shortening is paging out, not losing; it never suggests a re-run, which for
 * a side-effecting call would repeat its effect.
 */
export function truncatedResultText(
  text: string,
  isError: boolean,
  keepChars: number,
  call: Pick<ToolCall, 'tool' | 'tool_use_id' | 'sideEffects'>,
  pages: ResolvedCompactOptions['pages'] = {},
): string {
  const head = Math.max(0, keepChars);
  const tail = Math.max(0, keepChars);
  if (text.length <= head + tail + 200) return text;
  const cut = text.length - head - tail;
  const page = pages.page?.(call.tool_use_id);
  const where = page
    ? `the full text is in ${page} (Read it, with offset/limit if long, whenever the missing part matters)`
    : `the original is in ${pages.transcript || "this session's transcript (.jsonl)"}`;
  const advice = call.sideEffects
    ? 'do not re-run the call just to see its output: that may repeat its side effect'
    : page ? 'or look it up again' : 'look it up again if the details are needed';
  const note =
    `${COMPACTION_NOTE_MARKER}truncated ${cut} of ${text.length} chars of this ${call.tool} result` +
    `${isError ? ' (error)' : ''}; ${where}, tool_use_id=${call.tool_use_id}; ${advice}]`;
  const shortened = [head > 0 ? text.slice(0, head) : '', note, tail > 0 ? text.slice(-tail) : '']
    .filter(Boolean)
    .join('\n');
  return shortened.length < text.length ? shortened : text;
}

/**
 * Meets `cutTokens` by paging out more results, lowest Jev score first (on a
 * tie the larger first): Jev's order is informative where its absolute
 * scores are not. Only answered candidates qualify, only their result body
 * goes (the call record stays), and a pinned call never does. Returns how
 * many decisions it changed; they are changed in place.
 */
function pageForTarget(
  decisions: CallDecision[],
  calls: readonly ToolCall[],
  answers: ReadonlyMap<string, CallAnswer>,
  options: ResolvedCompactOptions,
): number {
  if (options.cutTokens <= 0) return 0;
  const byId = new Map(calls.map((call) => [call.id, call]));
  const keep = options.truncateHeadChars * 2 + 250;
  const saving = (call: ToolCall): number => Math.max(0, call.resultChars - keep);
  let cut = 0;
  for (const decision of decisions) {
    const call = byId.get(decision.id)!;
    if (decision.action === 'drop_call') cut += call.resultChars + JSON.stringify(call.input).length;
    else if (decision.action === 'drop_result') cut += saving(call);
  }
  // Tool output runs about 3 characters to a token (code, logs, paths).
  const target = options.cutTokens * 3;
  if (cut >= target) return 0;
  const open = decisions
    .filter((d) => d.action === 'keep' && d.reason === 'kept' && answers.has(d.id) && saving(byId.get(d.id)!) > MIN_SAVING_CHARS)
    .sort((a, b) => a.keepResult - b.keepResult || saving(byId.get(b.id)!) - saving(byId.get(a.id)!));
  let changed = 0;
  for (const decision of open) {
    if (cut >= target) break;
    decision.action = 'drop_result';
    decision.reason = 'paged_for_target';
    cut += saving(byId.get(decision.id)!);
    changed += 1;
  }
  return changed;
}

/** Below this many characters a removable call is not worth a Jev question. */
const MIN_SAVING_CHARS = 400;

/**
 * The calls worth asking Jev about: not pinned, not already shortened, and
 * with something to gain. A side-effecting call can only lose its result
 * body, so a short result leaves nothing to gain; a lookup can also lose its
 * record, which pays only when record and result are not tiny.
 */
export function compactionCandidates(
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars'>,
): ToolCall[] {
  const keep = Math.max(0, options.truncateHeadChars) * 2 + 200;
  return calls.filter((call) => {
    if (call.pinned || call.compacted) return false;
    const shortenable = call.resultChars > keep + MIN_SAVING_CHARS / 2;
    if (call.sideEffects) return shortenable;
    return shortenable || call.resultChars + boundedInput(call.input).length >= MIN_SAVING_CHARS;
  });
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  dropAssistantTextIndices: ReadonlySet<number> = new Set<number>(),
  pages: ResolvedCompactOptions['pages'] = {},
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const byUseId = new Map(calls.map((call) => [call.tool_use_id, call]));
  const shorten = (text: string, isError: boolean, useId: string, tool: string): string =>
    truncatedResultText(
      text,
      isError,
      headChars,
      byUseId.get(useId) ?? { tool, tool_use_id: useId, sideEffects: hasSideEffects(tool) },
      pages,
    );
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    const dropAssistantText =
      message.role === 'assistant' && dropAssistantTextIndices.has(messageIndex);
    const touched =
      dropAssistantText ||
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = shorten(tool.text ?? '', tool.isError ?? false, tool.tool_use_id, tool.tool);
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = shorten(
          result.text,
          result.isError ?? false,
          result.tool_use_id,
          byUseId.get(result.tool_use_id)?.tool ?? 'tool',
        );
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      ) &&
      !dropAssistantText
    ) {
      kept.push(message);
      continue;
    }
    const text = dropAssistantText ? '' : message.text;
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and explicit tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

/**
 * Characters represented by a whole transcript. Claude Code may expose a
 * completed tool result twice (toolUse.text and a later toolResults entry) or
 * only inline on toolUse.text. Count the inline copy only when no explicit
 * tool_result exists anywhere in the transcript.
 */
export function transcriptChars(messages: readonly Message[]): number {
  const explicitResultIds = new Set(
    messages.flatMap((message) => message.toolResults ?? []).map((result) => result.tool_use_id),
  );
  let total = messages.reduce((sum, message) => sum + messageChars(message), 0);
  for (const message of messages) {
    for (const tool of message.toolUses) {
      if (!explicitResultIds.has(tool.tool_use_id) && tool.text !== undefined) {
        total += tool.text.length;
      }
    }
  }
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts tool history and, in the local fork, old assistant text.
 *
 * User text is never removed. Recent messages are pinned. Old assistant text
 * is scored only in shards where that exact message is present verbatim; the
 * dialogue index gives each shard a map of the rest of the conversation.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
  observer: CompactObserver = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(
    messages,
    resolved.preserveRecentMessages,
    resolved.resultPreviewChars,
  );
  const reviewed = new Set(resolved.recentlyReviewedToolUseIds);
  const potential = (call: ToolCall): number => call.resultChars + (call.sideEffects ? 0 : JSON.stringify(call.input).length);
  const toolCandidates = compactionCandidates(calls, resolved).sort((a, b) =>
    Number(reviewed.has(a.tool_use_id)) - Number(reviewed.has(b.tool_use_id)) || potential(b) - potential(a));
  const assistantCandidates = resolved.compactAssistantText
    ? assistantTextCandidateIndices(messages, resolved.preserveRecentMessages)
    : [];
  const assistantCandidateSet = new Set(assistantCandidates);
  const charsBefore = transcriptChars(messages);

  const stages = new Set<string>();
  let maxStateTokens = 0;
  let maxShards = 0;
  let requestCount = 0;
  let plannedRequests = 0;
  const nextRequest = (): void => {
    requestCount += 1;
    plannedRequests = Math.max(plannedRequests, requestCount);
    observer.request?.(requestCount, plannedRequests);
  };
  const answers = new Map<string, CallAnswer>();
  const assistantScores = new Map<number, number>();

  const mergeCallAnswers = (answered: Map<string, CallAnswer>): void => {
    for (const [id, answer] of answered) {
      const previous = answers.get(id);
      answers.set(id, {
        keepCall: Math.max(previous?.keepCall ?? 0, answer.keepCall),
        keepResult: Math.max(previous?.keepResult ?? 0, answer.keepResult),
      });
    }
  };
  const mergeAssistantAnswers = (answered: Map<number, number>): void => {
    for (const [index, keep] of answered) {
      assistantScores.set(index, Math.max(assistantScores.get(index) ?? 0, keep));
    }
  };
  const assistantIndicesInState = (state: FittedState): number[] =>
    state.state.history
      .filter(
        (entry) =>
          entry.role === 'assistant' &&
          assistantCandidateSet.has(entry.i) &&
          entry.text.trim().length > 0,
      )
      .map((entry) => entry.i);

  if (toolCandidates.length > 0) {
    const allPlans = planBatches(messages, calls, toolCandidates, resolved);
    const plans: BatchPlan[] = [];
    let budget = 0;
    for (const plan of allPlans) {
      // A partial shard group must never authorize removal. At least one
      // complete group is processed, even if its coverage exceeds the soft cap.
      if (plans.length > 0 && budget + plan.states.length > resolved.maxJevRequests) break;
      plans.push(plan);
      budget += plan.states.length;
    }
    // Assistant-text questions, when enabled, may add requests to this count.
    plannedRequests = plans.reduce((sum, plan) => sum + plan.states.length, 0);
    observer.planned?.(plannedRequests);
    for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
      const plan = plans[planIndex]!;
      maxShards = Math.max(maxShards, plan.states.length);
      for (const state of plan.states) {
        stages.add(state.stage);
        maxStateTokens = Math.max(maxStateTokens, state.tokens);

        // Score assistant text only on the first tool plan. Its shards already
        // cover every old assistant message verbatim, so later tool plans do
        // not need to repeat those questions.
        const assistantIndices =
          planIndex === 0 ? assistantIndicesInState(state) : [];
        const toolStats = questionTokenStats(plan.batch);
        const assistantBatches = batchAssistantIndices(
          assistantIndices,
          state.tokens,
          resolved,
          toolStats.total,
        );

        if (assistantBatches.length === 0) {
          nextRequest();
          const answered = await askBatch(asker, state.state, plan.batch);
          mergeCallAnswers(answered.calls);
          continue;
        }

        for (let groupIndex = 0; groupIndex < assistantBatches.length; groupIndex += 1) {
          const group = assistantBatches[groupIndex]!;
          nextRequest();
          const answered = await askBatch(
            asker,
            state.state,
            groupIndex === 0 ? plan.batch : [],
            group,
          );
          mergeCallAnswers(answered.calls);
          mergeAssistantAnswers(answered.assistantTexts);
        }
      }
    }
  } else if (assistantCandidates.length > 0) {
    const q = assistantQuestionTokenStats(assistantCandidates);
    const stateLimit = Math.min(
      resolved.maxStateTokens,
      JEV_STATE_PLUS_LONGEST_QUESTION_TOKENS -
        q.longest -
        REQUEST_OVERHEAD_TOKENS -
        CONTEXT_SAFETY_MARGIN_TOKENS,
    );
    if (stateLimit < 1) {
      throw new Error('assistant relevance question is too large to leave room for conversation state');
    }
    const states = fitBatchStates(messages, calls, [], resolved, stateLimit);
    maxShards = states.length;
    plannedRequests = states.length;
    observer.planned?.(plannedRequests);
    for (const state of states) {
      stages.add(state.stage);
      maxStateTokens = Math.max(maxStateTokens, state.tokens);
      const assistantIndices = assistantIndicesInState(state);
      const groups = batchAssistantIndices(assistantIndices, state.tokens, resolved);
      for (const group of groups) {
        nextRequest();
        const answered = await askBatch(asker, state.state, [], group);
        mergeAssistantAnswers(answered.assistantTexts);
      }
    }
  }

  for (const index of assistantCandidates) {
    if (!assistantScores.has(index)) {
      throw new Error(
        'assistant message ' + index + ' was not visible verbatim in any Jev evidence shard',
      );
    }
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const pagedForTarget = pageForTarget(decisions, calls, answers, resolved);
  const resultScores: CompactResult['stats']['resultScores'] = [0, 0, 0, 0, 0];
  for (const call of toolCandidates) {
    const score = answers.get(call.id)?.keepResult;
    if (score === undefined) continue;
    const bucket = score < 0.1 ? 0 : score < 0.3 ? 1 : score < 0.5 ? 2 : score < 0.9 ? 3 : 4;
    resultScores[bucket] += 1;
  }
  const assistantTextDecisions: AssistantTextDecision[] = assistantCandidates.map((index) => {
    const keep = assistantScores.get(index) ?? 1;
    return keep >= resolved.keepThreshold
      ? { index, keep, action: 'keep', reason: 'kept' }
      : { index, keep, action: 'drop_text', reason: 'text_dropped' };
  });
  const dropAssistantTextIndices = new Set(
    assistantTextDecisions
      .filter((decision) => decision.action === 'drop_text')
      .map((decision) => decision.index),
  );
  const writers = resolved.pages.inputPage
    ? pageWriterInputs(messages, resolved.preserveRecentMessages, resolved.truncateHeadChars, resolved.pages.inputPage)
    : { messages: [...messages], paged: 0, charsSaved: 0 };
  const kept = applyDecisions(
    writers.messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
    dropAssistantTextIndices,
    resolved.pages,
  );
  return {
    reviewedToolUseIds: toolCandidates.filter((call) => answers.has(call.id)).map((call) => call.tool_use_id),
    messages: kept,
    decisions,
    assistantTextDecisions,
    stats: {
      inputsPaged: writers.paged,
      pagedForTarget,
      inputCharsSaved: writers.charsSaved,
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: transcriptChars(kept),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      assistantTexts: assistantTextDecisions.length,
      assistantTextsKept: assistantTextDecisions.filter((d) => d.action === 'keep').length,
      assistantTextsDropped: assistantTextDecisions.filter((d) => d.action === 'drop_text').length,
      asked: answers.size,
      deferred: toolCandidates.length - answers.size,
      resultScores,
      stateTokens: maxStateTokens,
      stateStage:
        requestCount > 0
          ? 'max-over-shards; up to ' +
            maxShards +
            ' evidence shard(s); ' +
            [...stages].join(' | ')
          : '',
      requests: requestCount,
      ms: Date.now() - started,
    },
  };
}
