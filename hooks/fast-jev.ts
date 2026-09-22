import type {
  On,
  PluginOptions,
  Register,
  SessionCompactResult,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { assistantTextCandidateIndices, compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls, goalFromMessages } from '../src/state.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;

import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  compactAssistantText: false,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
  headers?: Record<string, string>;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

/** Waits between retries; the hook passes `$.clock.sleep`, tests pass an instant one. */
export type HookSleep = (ms: number) => Promise<void>;

export const LOCAL_BUILD = '0.3.0-local.8';

export const JEV_MAX_ATTEMPTS = 6;
const JEV_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Longest wait a Retry-After header may ask for. */
const JEV_MAX_RETRY_AFTER_MS = 30_000;
/** Wall-clock budget for all Jev requests of one compaction, retries included. */
export const JEV_TOTAL_BUDGET_MS = 150_000;
/** After an auto-compaction attempt, the next one waits until the context grows this share of the window. */
const AUTO_RECOMPACT_GROWTH = 0.1;

export type JevTransportStats = {
  batches: number;
  attempts: number;
  retries: number;
};

function emptyTransportStats(): JevTransportStats {
  return { batches: 0, attempts: 0, retries: 0 };
}

function transportSummary(stats: JevTransportStats): string {
  return 'transport ' + stats.batches + ' batch(es), ' + stats.attempts + ' attempt(s), ' + stats.retries + ' retries';
}

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After in seconds or as an HTTP date, capped; undefined when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  const value = headers?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, JEV_MAX_RETRY_AFTER_MS);
}

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'resultPreviewChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const compactAssistantText = options['compactAssistantText'];
  config.compactAssistantText =
    typeof compactAssistantText === 'boolean'
      ? compactAssistantText
      : HOOK_DEFAULTS.compactAssistantText;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/**
 * A `JevAsker` over the engine's `$.http.fetch`. Transport errors, 429 and 5xx
 * are retried (honouring Retry-After); every request of one compaction shares
 * one wall-clock budget, so a Jev outage cannot hold the session for minutes.
 */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  log: (text: string) => void = () => {},
  transport: JevTransportStats = emptyTransportStats(),
  sleep: HookSleep = timerSleep,
  budgetMs: number = JEV_TOTAL_BUDGET_MS,
): JevAsker {
  let batchNumber = 0;
  const deadline = Date.now() + budgetMs;
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const batch = ++batchNumber;
      transport.batches += 1;

      for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
        const label = `Jev batch ${batch} attempt ${attempt}/${JEV_MAX_ATTEMPTS}`;
        const started = Date.now();
        transport.attempts += 1;
        log(`${label}: started`);

        let failure: string;
        let retryAfter: number | undefined;
        try {
          const response = await fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          });
          const elapsed = Date.now() - started;
          if (response.ok || !retryableStatus(response.status)) {
            // Success, or a permanent error (4xx, malformed body): no retry.
            const parsed = parseJevResponse(response.status, response.ok, response.text);
            log(`${label}: HTTP ${response.status}, success in ${elapsed}ms`);
            return parsed;
          }
          failure = `HTTP ${response.status} after ${elapsed}ms`;
          retryAfter = retryAfterMs(response.headers);
          if (attempt >= JEV_MAX_ATTEMPTS) {
            throw new Error(`Jev request failed (${response.status}): ${response.text.slice(0, 200)}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const transportError = !/^Jev (request failed|returned|response)|^Invalid Jev/.test(message);
          if (!transportError || attempt >= JEV_MAX_ATTEMPTS) {
            log(`${label}: giving up (${message})`);
            throw error;
          }
          failure = `transport error after ${Date.now() - started}ms (${message})`;
        }

        const delay = retryAfter ?? JEV_RETRY_DELAYS_MS[attempt - 1] ?? JEV_MAX_RETRY_AFTER_MS;
        if (Date.now() + delay > deadline) {
          log(`${label}: ${failure}; no time left in the ${budgetMs}ms budget`);
          throw new Error(`Jev unavailable: ${failure}; retry budget of ${Math.round(budgetMs / 1000)}s exhausted`);
        }
        transport.retries += 1;
        log(`${label}: ${failure}; retry in ${delay}ms`);
        await sleep(delay);
      }

      throw new Error('Jev retry loop exhausted unexpectedly');
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  log: (text: string) => void = () => {},
  transport: JevTransportStats = emptyTransportStats(),
  sleep: HookSleep = timerSleep,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const asker = jevAsker(fetchFn, config.apiKey, config.model, log, transport, sleep);
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/** `/compact <text>` steers Jev on top of the default goal (the latest user prompts). */
export function compactionGoal(
  messages: readonly SessionMessage[],
  config: Pick<HookConfig, 'goal'>,
  instructions?: string,
): string | undefined {
  const extra = instructions?.trim();
  if (!extra) return config.goal;
  return `${extra}\n${config.goal || goalFromMessages(messages)}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.assistantTextsDropped > 0 ? `${stats.assistantTextsDropped} assistant text(s) dropped` : '',
    stats.assistantTextsKept > 0 ? `${stats.assistantTextsKept} assistant text(s) kept` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

type NotifyTarget = {
  ui: {
    log: (text: string) => void;
    toast: (text: string, options?: { timeoutMs?: number }) => void;
  };
};

/** Log and toast; never throws, so a failing UI cannot turn into a failing compaction. */
function notify($: NotifyTarget, text: string): void {
  try {
    $.ui.log(text);
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    // The hook's answer matters more than the notice.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokensText(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  /** Context size when auto-compaction last ran; the next run waits for real growth. */
  let lastAutoTokens: number | undefined;
  /** Context size before the last compaction that stood, to report its real effect. */
  let effectPending: number | undefined;
  let lastAutoError = '';

  // Never `next(event)`: that is the engine's own Claude summary. Whatever goes
  // wrong, the hook answers itself: the compacted messages or `{ skip }`.
  on('session.compact', async ($, event, _next): Promise<SessionCompactResult> => {
    const tag = `fast-jev ${LOCAL_BUILD} [${event.trigger}${event.agentId ? ', subagent' : ''}]`;
    const transport = emptyTransportStats();
    try {
      const resolvedPreflight = resolveOptions(configured);
      const preflightCalls = collectToolCalls(
        event.messages,
        resolvedPreflight.preserveRecentMessages,
        resolvedPreflight.resultPreviewChars,
      );
      const eligible = preflightCalls.filter((call) => !call.pinned).length;
      const pinned = preflightCalls.length - eligible;
      const assistantEligible = resolvedPreflight.compactAssistantText
        ? assistantTextCandidateIndices(event.messages, resolvedPreflight.preserveRecentMessages).length
        : 0;
      if (eligible === 0 && assistantEligible === 0) {
        const reason = `${tag}: nothing eligible (${pinned} pinned tool pair(s)); session unchanged, no Jev request`;
        notify($, reason);
        return { skip: reason };
      }

      notify(
        $,
        `${tag}: Jev compaction of ${eligible} tool pair(s)` +
          (assistantEligible > 0 ? ` and ${assistantEligible} assistant text(s)` : '') +
          `, ${pinned} pinned`,
      );
      const config: HookConfig = {
        ...configured,
        apiKey: await getApiKey($, configured),
      };
      const goal = compactionGoal(event.messages, configured, event.instructions);
      if (goal) config.goal = goal;
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
        },
        (line) => $.ui.log(line),
        transport,
        (ms) => $.clock.sleep(ms),
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (result.stats.requests === 0 || reductionRatio(result) <= 0) {
        const reason = `${tag}: Jev kept everything; session unchanged (${summarize(result)})`;
        notify($, reason);
        return { skip: reason };
      }
      if (reductionRatio(result) < config.minReductionRatio) {
        const reason = `${tag}: reduction below the ${percent(config.minReductionRatio)} minimum; session unchanged (${summarize(result)})`;
        notify($, reason);
        return { skip: reason };
      }
      notify(
        $,
        `${tag}: kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)}; ${transportSummary(transport)})`,
      );
      return { messages };
    } catch (error) {
      const reason = `${tag}: Jev compaction failed, session unchanged, no Claude summary (${errorText(error)})`;
      notify($, reason);
      return { skip: reason };
    }
  });

  // Auto-compaction through Jev. The engine's own auto-compact (a Claude
  // summary) is meant to be off: DISABLE_AUTO_COMPACT=1. The call goes after
  // `next(event)`: until core has closed the turn, `$.session.compact()` rejects
  // with "a turn is running". Subagent turns never trigger it.
  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    const answer = await next(event);
    if (compacting || event.agentId !== undefined) return answer;
    try {
      const { context } = await $.session.usage();
      if (context.tokens === undefined || context.percent === undefined) return answer;
      if (effectPending !== undefined) {
        notify(
          $,
          `fast-jev ${LOCAL_BUILD}: first request after compaction carried ${tokensText(context.tokens)} tokens (before: ${tokensText(effectPending)})`,
        );
        effectPending = undefined;
      }
      if (context.percent < configured.compactAtPercent) return answer;
      if (
        lastAutoTokens !== undefined &&
        context.tokens < lastAutoTokens + context.window * AUTO_RECOMPACT_GROWTH
      ) {
        return answer;
      }
      compacting = true;
      $.ui.log(
        `fast-jev ${LOCAL_BUILD}: context ${context.percent}% >= ${configured.compactAtPercent}%, auto-compacting`,
      );
      const outcome = await $.session.compact();
      lastAutoTokens = context.tokens;
      lastAutoError = '';
      if (outcome.messages) effectPending = context.tokens;
    } catch (error) {
      const text = errorText(error);
      if (text !== lastAutoError) notify($, `fast-jev ${LOCAL_BUILD}: auto-compact did not run (${text})`);
      else $.ui.log(`fast-jev ${LOCAL_BUILD}: auto-compact did not run (${text})`);
      lastAutoError = text;
    } finally {
      compacting = false;
    }
    return answer;
  });
};

export { resolveOptions };
