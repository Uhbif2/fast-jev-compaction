import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { assistantTextCandidateIndices, compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
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
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

const LOCAL_BUILD = '0.3.0-local.7';
function diagnostic(_event: string, _fields: Record<string, unknown> = {}): void {}

const JEV_MAX_ATTEMPTS = 10;
const JEV_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  log: (text: string) => void = () => {},
  transport: JevTransportStats = emptyTransportStats(),
): JevAsker {
  let batchNumber = 0;
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const batch = ++batchNumber;
      transport.batches += 1;

      for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
        const started = Date.now();
        transport.attempts += 1;
        diagnostic('jev_http_start', { batch, attempt, maxAttempts: JEV_MAX_ATTEMPTS, questions: Object.keys(questions).length });
        log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': started');

        let response: HookFetchResponse;
        try {
          response = await fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          });
        } catch (error) {
          const elapsed = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          diagnostic('jev_transport_error', { batch, attempt, elapsedMs: elapsed, final: attempt >= JEV_MAX_ATTEMPTS, error: message });
          if (attempt >= JEV_MAX_ATTEMPTS) {
            log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': transport error after ' + elapsed + 'ms; giving up (' + message + ')');
            throw error;
          }
          const delay = JEV_RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
          transport.retries += 1;
          log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': transport error after ' + elapsed + 'ms; retry in ' + delay + 'ms (' + message + ')');
          await sleep(delay);
          continue;
        }

        const elapsed = Date.now() - started;
        diagnostic('jev_http_response', { batch, attempt, status: response.status, ok: response.ok, elapsedMs: elapsed });
        if (!response.ok && retryableStatus(response.status)) {
          const error = new Error('Jev request failed (' + response.status + '): ' + response.text.slice(0, 200));
          if (attempt >= JEV_MAX_ATTEMPTS) {
            log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': HTTP ' + response.status + ' after ' + elapsed + 'ms; giving up');
            throw error;
          }
          const delay = JEV_RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
          transport.retries += 1;
          log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': HTTP ' + response.status + ' after ' + elapsed + 'ms; retry in ' + delay + 'ms');
          await sleep(delay);
          continue;
        }

        try {
          const parsed = parseJevResponse(response.status, response.ok, response.text);
          diagnostic('jev_parse_success', { batch, attempt, status: response.status, elapsedMs: elapsed });
          log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': HTTP ' + response.status + ', success in ' + elapsed + 'ms');
          return parsed;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostic('jev_parse_error', { batch, attempt, status: response.status, elapsedMs: elapsed, error: message });
          log('Jev batch ' + batch + ' attempt ' + attempt + '/' + JEV_MAX_ATTEMPTS + ': permanent response error after ' + elapsed + 'ms (' + message + ')');
          throw error;
        }
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
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model, log, transport), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
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

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  diagnostic('register', {
    keepThreshold: configured.keepThreshold,
    preserveRecentMessages: configured.preserveRecentMessages,
    compactAtPercent: configured.compactAtPercent,
    minReductionRatio: configured.minReductionRatio,
  });
  let compacting = false;

  on('session.compact', async ($, event, next) => {
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
      diagnostic('preflight', { eligible, pinned, assistantEligible, total: preflightCalls.length, messages: event.messages.length });
      notify(
        $,
        `fast-jev ${LOCAL_BUILD} preflight: ${eligible} tool pair(s), ${assistantEligible} assistant text(s), ${pinned} pinned tool pair(s)`,
      );
      if (eligible === 0 && assistantEligible === 0) {
        diagnostic('no_op_zero_eligible');
        notify($, `fast-jev ${LOCAL_BUILD}: no eligible tool content; no-op, no Jev request, no Claude fallback`);
        return { messages: [...event.messages] };
      }

      diagnostic('jev_only_start', { eligible, assistantEligible, pinned });
      notify($, `fast-jev ${LOCAL_BUILD}: Jev-only compaction started for ${eligible} tool pair(s) and ${assistantEligible} assistant text(s); Claude fallback disabled`);
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        (line) => $.ui.log(line),
        transport,
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      // A transcript with no non-pinned tool pairs is a valid Jev no-op, not a
      // compaction failure. Falling through to Claude summary here would spend
      // Anthropic quota even though there is nothing Jev is allowed to prune.
      if (result.stats.requests === 0) {
        diagnostic('no_op_zero_requests', { reductionRatio: reductionRatio(result) });
        notify(
          $,
          `no eligible tool content to prune; kept session unchanged, no summary (${summarize(result)}; ${transportSummary(transport)})`,
        );
        return { messages };
      }
      if (reductionRatio(result) < config.minReductionRatio) {
        diagnostic('low_reduction_no_claude_fallback', {
          reductionRatio: reductionRatio(result),
          minReductionRatio: config.minReductionRatio,
          requests: result.stats.requests,
        });
        notify(
          $,
          `Jev reduction below ${percent(config.minReductionRatio)} minimum; session left unchanged, Claude fallback disabled (${summarize(result)})`,
        );
        return { messages: [...event.messages] };
      }
      diagnostic('jev_compaction_success', {
        messagesBefore: event.messages.length,
        messagesAfter: messages.length,
        reductionRatio: reductionRatio(result),
        requests: result.stats.requests,
        transport,
      });
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      diagnostic('jev_error_no_claude_fallback', {
        error: error instanceof Error ? error.message : String(error),
        transport,
      });
      notify(
        $,
        `Jev compaction failed; session unchanged, Claude fallback disabled (${error instanceof Error ? error.message : String(error)})`,
      );
      return { messages: [...event.messages] };
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
