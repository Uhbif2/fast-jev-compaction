import type {
  On,
  PluginOptions,
  PromptOrigin,
  Register,
  SessionCompactResult,
  SessionMessage,
  TurnCompleteInput,
} from 'claude-code';

import { assistantTextCandidateIndices, compact, compactionCandidates, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls, goalFromMessages } from '../src/state.js';
import { buildJevRequest, DEFAULT_MODEL, OPENROUTER_SYSTEM_ONE_URL, parseJevResponse, SYSTEM_ONE_URL } from '../src/request.js';
import { callPage, longInputCalls } from '../src/inputs.js';
import { THINKING_TOKENS_PER_BLOCK, usageOrigin, usageSourceText, type UsageOrigin } from '../src/size.js';
import {
  dedupeReplayedHistory,
  collapseContextListings,
  dropCommandNoise,
  engineMessages,
  restoreQueuedPrompts,
  thinkingOnlyRows,
  TurnInProgressError,
  visibleTokens,
  type EngineMessage,
  type EngineRebuild,
  type QueuedPrompt,
} from '../src/transcript.js';
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;
declare const clearTimeout: (timer: unknown) => void;

import type {
  CompactObserver,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolCall,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  ceilingPercent: 0,
  questionVariant: 'keep_or_page' as const,
  minReductionRatio: 0,
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

/** Cancellable deadline wait. The engine adapter uses $.clock, not Node timers. */
export type DeadlineWait = (ms: number) => { expired: Promise<void>; cancel: () => void };

const timerDeadline: DeadlineWait = (ms) => {
  let timer: unknown;
  const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return { expired, cancel: () => clearTimeout(timer) };
};

export const LOCAL_BUILD = '0.3.0-local.20';

export const JEV_MAX_ATTEMPTS = 6;
const JEV_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Longest wait a Retry-After header may ask for. */
const JEV_MAX_RETRY_AFTER_MS = 30_000;
/** Wall-clock budget for all Jev requests of one compaction, retries included. */
export const JEV_TOTAL_BUDGET_MS = 150_000;

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

export type JevProvider = 'openrouter' | 'typesafe';

export type HookConfig = CompactOptions & {
  /** TypeSafe key (`provider=typesafe`), or the resolved key of the chosen provider inside `compactSession`. */
  apiKey?: string;
  /** OpenRouter key (`provider=openrouter`). */
  openrouterApiKey?: string;
  /** Where Jev is called; OpenRouter by default (the TypeSafe account ran out of credit, 12.10.2026). */
  provider: JevProvider;
  /** Endpoint override; the provider's System One URL when absent. */
  baseUrl?: string;
  compactAtPercent: number;
  /**
   * The most a compaction may leave, as a share of the window: past it more
   * old calls are collapsed. 0: two thirds of `compactAtPercent`, so an
   * auto-compaction is never followed by another one at once.
   */
  ceilingPercent: number;
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
    'maxJevRequests',
    'keepAbove',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    ceilingPercent: optionNumber(options, 'ceilingPercent', HOOK_DEFAULTS.ceilingPercent),
    questionVariant: options['questionVariant'] === 'relevance' ? 'relevance' : HOOK_DEFAULTS.questionVariant,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    provider: options['provider'] === 'typesafe' ? 'typesafe' : 'openrouter',
  };
  const compactAssistantText = options['compactAssistantText'];
  config.compactAssistantText =
    typeof compactAssistantText === 'boolean'
      ? compactAssistantText
      : HOOK_DEFAULTS.compactAssistantText;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const openrouterApiKey = optionString(options, 'openrouterApiKey');
  if (openrouterApiKey) config.openrouterApiKey = openrouterApiKey;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
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
  deadlineWait: DeadlineWait = timerDeadline,
  baseUrl?: string,
): JevAsker {
  let batchNumber = 0;
  const deadline = Date.now() + budgetMs;
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const batch = ++batchNumber;
      transport.batches += 1;

      for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Jev deadline exceeded; session unchanged');
        const label = `Jev batch ${batch} attempt ${attempt}/${JEV_MAX_ATTEMPTS}`;
        const started = Date.now();
        transport.attempts += 1;
        log(`${label}: started`);

        let failure: string;
        let retryAfter: number | undefined;
        try {
          const timer = deadlineWait(remaining);
          let response: HookFetchResponse;
          try {
            response = await Promise.race([
              fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body }),
              timer.expired.then(() => { throw new Error('Jev deadline exceeded; session unchanged'); }),
            ]);
          } finally { timer.cancel(); }
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
            throw new Error(`Jev request failed (HTTP ${response.status})`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const transportError = !/^Jev (deadline|request failed|returned|response)|^Invalid Jev/.test(message);
          if (!transportError || attempt >= JEV_MAX_ATTEMPTS) {
            const safe = transportError ? 'Jev transport unavailable' : message;
            log(`${label}: giving up (${safe})`);
            throw new Error(safe);
          }
          failure = `transport error after ${Date.now() - started}ms`;
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

/**
 * Maps the library's output onto what the engine writes. Only user text keeps
 * the engine's own object (and handle); every assistant and tool_result
 * message is rebuilt, because the engine writes kept ones with links into the
 * uncompacted history (see src/transcript.ts).
 */
export function toSessionMessages(output: readonly Message[]): EngineRebuild & { messages: SessionMessage[] } {
  const rebuild = engineMessages(output as readonly EngineMessage[]);
  return { ...rebuild, messages: rebuild.messages as SessionMessage[] };
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
  rebuild: ReturnType<typeof toSessionMessages>;
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly (SessionMessage | Message)[],
  config: HookConfig,
  fetchFn: HookFetch,
  log: (text: string) => void = () => {},
  transport: JevTransportStats = emptyTransportStats(),
  sleep: HookSleep = timerSleep,
  observer: CompactObserver = {},
  deadlineWait: DeadlineWait = timerDeadline,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('Jev API key is not configured (OPENROUTER_API_KEY or TYPESAFE_API_KEY, see provider)');
  const asker = jevAsker(fetchFn, config.apiKey, config.model, log, transport, sleep, JEV_TOTAL_BUDGET_MS, deadlineWait, config.baseUrl);
  const result = await compact(messages as readonly Message[], asker, config, observer);
  const rebuild = toSessionMessages(result.messages);
  return { result, messages: rebuild.messages, rebuild };
}

/** `/compact <text>` steers Jev on top of the default goal (the latest user prompts). */
export function compactionGoal(
  messages: readonly Message[],
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

/** What Jev decided, in counts; sizes are reported separately, in tokens. */
export function summarize(result: CompactResult): string {
  const { stats } = result;
  const asked = new Set(result.reviewedToolUseIds);
  const kept = result.decisions.filter((d) => d.reason === 'kept' && d.tool_use_id !== undefined && asked.has(d.tool_use_id)).length;
  const parts = [
    stats.resultsDropped > 0 ? `${stats.resultsDropped} result(s) truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call(s) dropped` : '',
    stats.asked > 0 ? `${kept} kept` : '',
    stats.deferred > 0 ? `${stats.deferred} left for the next pass` : '',
    stats.assistantTextsDropped > 0 ? `${stats.assistantTextsDropped} assistant text(s) dropped` : '',
  ].filter(Boolean);
  const paging = [
    stats.inputsPaged > 0 ? `${stats.inputsPaged} old call input(s) paged out` : '',
    // Any old call may be collapsed, not only those Jev was asked about.
    stats.pagedOut > 0 ? `${stats.pagedOut} old call(s) Jev did not keep collapsed to their pages` : '',
    stats.pagedForTarget > 0 ? `${stats.pagedForTarget} more collapsed to stay under the ceiling` : '',
  ].filter(Boolean).map((part) => `; ${part}`).join('');
  if (stats.asked + stats.deferred === 0) return `no Jev request needed${paging}`;
  return `Jev checked ${stats.asked} of ${stats.asked + stats.deferred} candidate(s)${
    parts.length > 0 ? ': ' + parts.join(', ') : ''
  } in ${stats.requests} request(s)${paging}`;
}

/** Desktop's saved number belongs to Claude Code, not to the plugin or a verified request. */
const ENGINE_FIGURE_NOTE =
  'engine-owned Desktop "saved N tokens" line is not controlled by the plugin and is not verified input usage';

/**
 * The size report, in Claude tokens. `before` is the real context of the
 * last request; what left is the visible messages' cut plus the thinking of
 * old steps, whose text a plugin does not see and which is estimated per
 * block. Checked on 26.09: this predicted 309k where the next request carried
 * 316.7k with a new prompt in it; Claude Code's own figure said 139k.
 */
export function sizeReport(
  before: number | undefined,
  visibleBefore: number,
  visibleAfter: number,
  thinkingRows: number,
  reloaded = false,
  overhead?: number,
  origin: UsageOrigin = 'engine',
): string {
  const cut = Math.max(0, visibleBefore - visibleAfter);
  const provenance = usageSourceText(origin);
  const end = `; last-request ${provenance} usage: ${before === undefined ? 'unavailable' : `${tokensText(before)} tokens`}` +
    `; first-request input usage pending (check the next real request); ${ENGINE_FIGURE_NOTE}`;
  // The previous request's residual is inferred from observed input minus
  // estimated visible messages; it is not an independently measured overhead.
  if (overhead !== undefined) {
    const from = before === undefined || reloaded || visibleBefore > before ? '' : `${tokensText(before)} → `;
    return `plugin estimate: context ${from}≈${tokensText(overhead + visibleAfter)} tokens ` +
      `(messages ≈${tokensText(visibleBefore)} → ≈${tokensText(visibleAfter)}, plus ≈${tokensText(overhead)} outside them inferred from observed input minus estimated messages on the previous compaction; ` +
      `first-request input usage is not yet available)${end}`;
  }
  const thinking = thinkingRows * THINKING_TOKENS_PER_BLOCK;
  const thinkingText = thinkingRows > 0 ? `, ≈−${tokensText(thinking)} of ${thinkingRows} thinking block(s)` : '';
  if (before === undefined) return `plugin estimate: ≈−${tokensText(cut + thinking)} tokens (−${tokensText(cut)} of messages${thinkingText})${end}`;
  // The last request was measured before a reload doubled the history: that
  // figure says nothing about the context now, the messages themselves do.
  if (reloaded || visibleBefore > before) {
    return `plugin estimate: messages ≈${tokensText(visibleBefore)} → ≈${tokensText(visibleAfter)} tokens${thinkingText} ` +
      `(the last context usage, ${tokensText(before)}, predates the reload that doubled the history)${end}`;
  }
  const after = Math.max(0, before - cut - thinking);
  return `plugin estimate: context ${tokensText(before)} → ≈${tokensText(after)} tokens ` +
    `(−${tokensText(cut)} of messages${thinkingText}; next request still unmeasured)${end}`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}${d.tool_use_id ? '@' + d.tool_use_id : ''}`,
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

/**
 * The key comes from the sensitive option of the chosen provider
 * (`openrouterApiKey` / `apiKey`; Claude Code keeps them in its secure
 * storage). OPENROUTER_API_KEY / TYPESAFE_API_KEY in the process environment
 * are only a fallback; settings.json is deliberately not read: a key there is
 * plain text that every child process inherits.
 */
async function getApiKey(
  $: { env: { get: (name: string) => Promise<string | undefined> } },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.provider === 'typesafe') {
    return config.apiKey || (await $.env.get('TYPESAFE_API_KEY')) || undefined;
  }
  return config.openrouterApiKey || (await $.env.get('OPENROUTER_API_KEY')) || undefined;
}

/** The System One endpoint of the chosen provider unless `baseUrl` overrides it. */
export function jevEndpoint(config: Pick<HookConfig, 'provider' | 'baseUrl'>): string {
  return config.baseUrl ?? (config.provider === 'typesafe' ? SYSTEM_ONE_URL : OPENROUTER_SYSTEM_ONE_URL);
}

type NotifyTarget = {
  ui: {
    log: (text: string) => void;
    toast: (text: string, options?: { timeoutMs?: number }) => void;
  };
  clock: { sleep: (ms: number) => Promise<void> };
};

/**
 * The engine drops a toast that comes too soon after the previous one ("within
 * N ms of the last; dropped"): a failure right after the start notice used to
 * vanish that way. Kept above the engine's gap.
 */
export const TOAST_GAP_MS = 3_000;

/** When the last toast went out; one per plugin instance, shared by its hooks. */
export type ToastGate = { last: number; now: () => number };

export function toastGate(now: () => number = Date.now): ToastGate {
  return { last: Number.NEGATIVE_INFINITY, now };
}

function logNotice($: NotifyTarget, text: string): void {
  try {
    $.ui.log(text);
  } catch {
    // The hook's answer matters more than the notice.
  }
}

function showNotice($: NotifyTarget, gate: ToastGate, text: string): void {
  logNotice($, text);
  try {
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    // As above: never let the UI fail a compaction.
  }
  gate.last = gate.now();
}

/** Toast when the last one is far enough back, else only log: for progress. */
export function progressNotice($: NotifyTarget, gate: ToastGate, text: string): void {
  if (gate.now() - gate.last >= TOAST_GAP_MS) showNotice($, gate, text);
  else logNotice($, text);
}

/** Always toasted: waits out the gap first. For the start and the outcome. */
export async function sayNotice($: NotifyTarget, gate: ToastGate, text: string): Promise<void> {
  const wait = gate.last + TOAST_GAP_MS - gate.now();
  if (wait > 0) {
    try {
      await $.clock.sleep(wait);
    } catch {
      // Shown a little early rather than not at all.
    }
  }
  showNotice($, gate, text);
}

async function skipWith($: NotifyTarget, gate: ToastGate, reason: string): Promise<SessionCompactResult> {
  await sayNotice($, gate, reason);
  return { skip: reason };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokensText(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

/** The engine's config directory, as it resolves it. */
async function configDir($: { env: { get: (name: string) => Promise<string | undefined> } }): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ||
    `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '~'}/.claude`;
  return dir.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** <config>/fast-jev-pages, or '' when the config directory cannot be told. */
async function pagesRootOf($: { env: { get: (name: string) => Promise<string | undefined> } }): Promise<string> {
  try {
    return `${await configDir($)}/${PAGES_DIR}`;
  } catch {
    return '';
  }
}

/** <config>/projects/<cwd, every character but a-z A-Z 0-9 as '-'>/<id>.jsonl, as Claude Code 2.1.280 names it. */
export function transcriptPathFor(config: string, cwd: string, sessionId: string): string {
  return `${config}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`;
}

/** Page files: `<session id, 8 chars>/<tool_use_id>.call.txt`, one per old call, with its input and result. */
export const PAGES_DIR = 'fast-jev-pages';
/** $.fs rejects over 4 MiB; UTF-8 takes up to 3 bytes a character. */
const PAGE_MAX_CHARS = 1_300_000;

export function isPagePath(path: unknown, pagesRoot: string): boolean {
  if (typeof path !== 'string' || !pagesRoot) return false;
  const norm = path.replace(/\\/g, '/').toLowerCase();
  const root = pagesRoot.replace(/\\/g, '/').toLowerCase() + '/';
  return norm.startsWith(root) && !norm.slice(root.length).split('/').includes('..');
}

/** Result text of every answered call in the engine's messages. */
function resultTextsOf(messages: readonly Message[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const message of messages) for (const tool of message.toolUses) if (tool.text !== undefined) texts.set(tool.tool_use_id, tool.text);
  for (const message of messages) for (const result of message.toolResults ?? []) texts.set(result.tool_use_id, result.text);
  return texts;
}

type PageTarget = {
  fs: {
    write: (path: string, text: string) => Promise<void>;
    list: (path?: string) => Promise<Array<{ name: string }>>;
  };
};

/** Below this many characters of input and result a call is not worth a page. */
const PAGE_MIN_CHARS = 500;

/**
 * Writes the page of every old call before Jev decides, so that a note names
 * a page only when it exists. A page is never rewritten: a later compaction
 * sees the call already shortened, and the first page is the whole one.
 * Returns the ids that have a page.
 */
export async function writeCallPages(
  $: PageTarget,
  dir: string,
  messages: readonly Message[],
  calls: readonly Pick<ToolCall, 'tool_use_id' | 'resultChars' | 'input'>[],
): Promise<Set<string>> {
  let existing = new Set<string>();
  try {
    existing = new Set((await $.fs.list(dir)).map((entry) => entry.name.toLowerCase()));
  } catch (error) {
    // A genuinely absent directory has no pages to overwrite. An unreadable
    // directory might hold immutable originals; fail closed rather than
    // overwriting one. The transcript remains the fallback source.
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : '';
    if (code !== 'ENOENT' && !/\bENOENT\b/.test(message)) return new Set();
  }
  const results = resultTextsOf(messages);
  const tools = new Map(messages.flatMap((m) => m.toolUses).map((tool) => [tool.tool_use_id, tool]));
  const paged = new Set<string>();
  for (const call of calls) {
    const id = call.tool_use_id;
    const name = `${id}.call.txt`;
    if (!/^[A-Za-z0-9_-]+$/.test(id) || JSON.stringify(call.input).length + call.resultChars < PAGE_MIN_CHARS) continue;
    if (existing.has(name.toLowerCase())) {
      paged.add(id);
      continue;
    }
    const tool = tools.get(id);
    const text = results.get(id);
    if (!tool || text === undefined) continue;
    const page = callPage(tool, { text, isError: tool.isError ?? false });
    if (page.length > PAGE_MAX_CHARS) continue;
    try {
      await $.fs.write(`${dir}/${name}`, page);
      paged.add(id);
    } catch {
      // Without a page the call stays; a truncated result names the transcript.
    }
  }
  return paged;
}

/** Origins of a message a person wrote: typed, from the phone bridge, the Desktop (SDK host), Slack. */
const HUMAN_ORIGINS = new Set<PromptOrigin['kind']>(['composer', 'bridge', 'sdk', 'slack-ping', 'channel']);
const QUEUED_KEY = 'queued-prompts';

/**
 * What the first request after a compaction carried besides its messages:
 * system prompt, tools, skill and agent listings, CLAUDE.md, attachments the
 * engine adds back, the new prompt. Measured, not estimated: on 27.09 it was
 * ~100k of a 133k context, and an estimate from thinking blocks (480 tokens
 * each, where that session averaged 705) overshot the target by 17k.
 */
const OVERHEAD_KEY = 'after-compaction-overhead';
const OVERHEAD_SAMPLES = 5;

async function measuredOverhead($: StoreTarget): Promise<number | undefined> {
  try {
    const value = await $.store.get(OVERHEAD_KEY);
    const samples = Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && n > 0) : [];
    if (samples.length === 0) return undefined;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  } catch {
    return undefined;
  }
}

async function recordOverhead($: StoreTarget, overhead: number): Promise<void> {
  try {
    const value = await $.store.get(OVERHEAD_KEY);
    const samples = Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
    await $.store.set(OVERHEAD_KEY, [...samples, overhead].slice(-OVERHEAD_SAMPLES));
  } catch {
    // Only the next target is less exact without it.
  }
}

type Effect = { before?: number; visibleAfter: number };

/**
 * The real input usage of the first request after compaction. The residual
 * outside visible messages is only inferred (observed usage minus the plugin
 * estimate of visible text), not a separately measured token count.
 */
async function reportEffect($: NotifyTarget & StoreTarget, gate: ToastGate, effect: Effect, tokens: number, origin: UsageOrigin): Promise<void> {
  const { before, visibleAfter } = effect;
  const saved = before === undefined ? 0 : before - tokens;
  const overhead = tokens - visibleAfter;
  if (overhead > 0) await recordOverhead($, overhead);
  await sayNotice(
    $,
    gate,
    `fast-jev ${LOCAL_BUILD}: first-request input usage [${usageSourceText(origin)}] ${tokensText(tokens)} tokens` +
      (before === undefined
        ? ' (the size before it was not measured after the reload)'
        : ` (before: ${tokensText(before)}; ${saved > 0 ? `−${tokensText(saved)}, −${percent(saved / before)}` : 'no reduction'}, the new prompt included)`) +
      (overhead > 0 ? `; ≈${tokensText(overhead)} inferred outside the kept messages (observed input minus plugin-estimated messages; includes system prompt, tools, listings, CLAUDE.md, attachments and the new prompt), which the next ceiling budgets for` : ''),
  );
}
const QUEUED_PER_SESSION = 50;
const QUEUED_SESSIONS = 30;

type QueuedStore = Record<string, QueuedPrompt[]>;
type StoreTarget = { store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> } };

function validQueued(entry: unknown): entry is QueuedPrompt {
  const e = entry as QueuedPrompt | undefined;
  return typeof e?.text === 'string' && typeof e.at === 'number' && (e.after === undefined || typeof e.after === 'string');
}

async function queuedStore($: StoreTarget): Promise<QueuedStore> {
  const value = await $.store.get(QUEUED_KEY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const store: QueuedStore = {};
  for (const [id, list] of Object.entries(value)) if (Array.isArray(list)) store[id] = list.filter(validQueued);
  return store;
}

/** Mid-turn user messages recorded for a session; empty when the store is unreadable. */
export async function readQueued($: StoreTarget, sessionId: string): Promise<QueuedPrompt[]> {
  try {
    return (await queuedStore($))[sessionId] ?? [];
  } catch {
    return [];
  }
}

export async function rememberQueued($: StoreTarget, sessionId: string, entry: QueuedPrompt): Promise<void> {
  const store = await queuedStore($);
  store[sessionId] = [...(store[sessionId] ?? []), entry].slice(-QUEUED_PER_SESSION);
  const newest = (list: QueuedPrompt[]) => Math.max(0, ...list.map((e) => e.at));
  const kept = Object.entries(store).sort((a, b) => newest(b[1]) - newest(a[1])).slice(0, QUEUED_SESSIONS);
  await $.store.set(QUEUED_KEY, Object.fromEntries(kept));
}

/** Drops entries now written into the transcript as user text. */
export async function forgetQueued($: StoreTarget, sessionId: string, done: readonly QueuedPrompt[]): Promise<void> {
  try {
    const store = await queuedStore($);
    const left = (store[sessionId] ?? []).filter((e) => !done.some((d) => d.at === e.at && d.text === e.text));
    if (left.length > 0) store[sessionId] = left;
    else delete store[sessionId];
    await $.store.set(QUEUED_KEY, store);
  } catch {
    // Kept entries are found as present text next time and dropped then.
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  const gate = toastGate();
  /**
   * Set when a compaction stood, to report its real effect at the next turn;
   * `before` is left out when the last measurement predates a reload;
   * `visibleAfter` measures the overhead the next target counts on.
   */
  let effectPending: Effect | undefined;
  // Only affects ordering, never a deletion decision. Later passes advance
  // through the remaining candidates instead of rescoring the same large keeps.
  const reviewedToolUseIds = new Set<string>();
  /** <config>/fast-jev-pages, once known; Read under it is a page-in. */
  let pagesRoot = '';
  /** Page-ins since the last compaction: how often the model needed what was paged out. */
  let pageIns = 0;

  // Never `next(event)`: that is the engine's own Claude summary. Whatever goes
  // wrong, the hook answers itself: the compacted messages or `{ skip }`.
  on('session.compact', async ($, event, _next): Promise<SessionCompactResult> => {
    const tag = `fast-jev ${LOCAL_BUILD} [${event.trigger}${event.agentId ? ', subagent' : ''}]`;
    const transport = emptyTransportStats();
    const main = event.agentId === undefined;
    try {
      // Repair first, then judge: a transcript the engine reloaded after an
      // earlier compaction may hold every old turn twice, and mid-turn user
      // messages live in attachments the rebuild does not carry.
      const deduped = dedupeReplayedHistory(event.messages as readonly EngineMessage[]);
      let sessionId: string | undefined;
      try {
        if (main) sessionId = await $.session.id();
      } catch {
        // Without an id, mid-turn messages are not restored this time.
      }
      const queued = sessionId ? await readQueued($, sessionId) : [];
      const restoring = restoreQueuedPrompts(deduped.messages, queued);
      const noise = dropCommandNoise(restoring.messages, resolveOptions(configured).preserveRecentMessages);
      const listings = collapseContextListings(noise.messages);
      const input = listings.messages;
      const repairs = [
        deduped.toolCalls > 0 ? `${deduped.toolCalls} duplicated call(s) removed` : '',
        deduped.texts > 0 ? `${deduped.texts} duplicated text(s) removed` : '',
        restoring.restored.length > 0 ? `${restoring.restored.length} mid-turn user message(s) kept as text` : '',
        noise.dropped > 0 ? `${noise.dropped} old command output(s) dropped` : '',
        listings.dropped > 0 ? `${listings.dropped} repeated context listing(s) dropped` : '',
      ].filter(Boolean);
      const thinkingRows = thinkingOnlyRows(input);
      // Refuses now, before any Jev request, when a call still waits for its result.
      toSessionMessages(input);

      const resolvedPreflight = resolveOptions(configured);
      const preflightCalls = collectToolCalls(
        input,
        resolvedPreflight.preserveRecentMessages,
        resolvedPreflight.resultPreviewChars,
      );
      const eligible = compactionCandidates(preflightCalls, resolvedPreflight).length;
      const pinned = preflightCalls.filter((call) => call.pinned).length;
      const assistantEligible = resolvedPreflight.compactAssistantText
        ? assistantTextCandidateIndices(input, resolvedPreflight.preserveRecentMessages).length
        : 0;
      // Every old call can be paged out whole; one with a
      // long input has it paged out in any case.
      const oldCalls = sessionId ? preflightCalls.filter((call) => !call.pinned) : [];
      const longInputs = sessionId
        ? longInputCalls(input, resolvedPreflight.preserveRecentMessages, resolvedPreflight.truncateHeadChars).length
        : 0;
      const structural = repairs.length > 0 || thinkingRows > 0 || longInputs > 0;
      if (eligible === 0 && assistantEligible === 0 && !structural && oldCalls.length === 0) {
        return await skipWith(
          $,
          gate,
          `${tag}: nothing eligible (${pinned} pinned of ${preflightCalls.length} tool call(s), no thinking, old call or duplicates to drop); session unchanged, no Jev request`,
        );
      }

      // Pages first: a note may name a page only once it exists.
      let pages: HookConfig['pages'];
      if (sessionId) {
        try {
          const root = await configDir($);
          pagesRoot = `${root}/${PAGES_DIR}`;
          // The directory is the session id's first 8 characters: every note
          // names its page, and a shorter path is paid once per note.
          const dir = `${pagesRoot}/${sessionId.slice(0, 8)}`;
          const paged = await writeCallPages($, dir, input, oldCalls);
          pages = {
            page: (id) => (paged.has(id) ? `${dir}/${id}.call.txt` : undefined),
            transcript: transcriptPathFor(root, await $.session.cwd(), sessionId),
          };
        } catch (error) {
          logNotice($, `${tag}: pages not written (${errorText(error)}); notes name the transcript`);
        }
      }

      let tokensBefore: number | undefined;
      let window: number | undefined;
      let origin: UsageOrigin = 'engine';
      if (main) {
        try {
          const { context } = await $.session.usage();
          tokensBefore = context.tokens;
          window = context.window;
          origin = usageOrigin(context);
        } catch {
          // Only the size report and the target need it.
        }
      }
      // The target, in Claude tokens of messages: what the context is over
      // it, less what leaves anyway (old thinking, duplicates, command noise).
      // After a reload that doubled the history the last measurement is
      // stale; the messages themselves are the measure then.
      // With the overhead a previous compaction measured, the target is the
      // messages' share of it: exact up to the estimate of the messages.
      const reloaded = deduped.toolCalls + deduped.texts > 0;
      const measured = reloaded ? visibleTokens(event.messages) : tokensBefore;
      const overhead = main ? await measuredOverhead($) : undefined;
      let cutTokens = 0;
      const ceilingPercent = configured.ceilingPercent > 0
        ? configured.ceilingPercent
        : (configured.compactAtPercent * 2) / 3;
      if (window && ceilingPercent > 0) {
        const target = Math.floor((window * ceilingPercent) / 100);
        if (overhead !== undefined) {
          cutTokens = Math.max(0, visibleTokens(input) - Math.max(0, target - overhead));
        } else if (measured !== undefined) {
          const leaving = thinkingRows * THINKING_TOKENS_PER_BLOCK + Math.max(0, visibleTokens(event.messages) - visibleTokens(input));
          cutTokens = Math.max(0, measured - target - leaving);
        }
      }
      const started = Date.now();
      let result: CompactResult | undefined;
      let rebuilt: ReturnType<typeof toSessionMessages>;
      if (eligible > 0 || assistantEligible > 0) {
        await sayNotice(
          $,
          gate,
          `${tag}: Jev compaction of ${eligible} tool call(s)` +
            (assistantEligible > 0 ? ` and ${assistantEligible} assistant text(s)` : '') +
            `, ${pinned} pinned; Claude summary off`,
        );
        const config: HookConfig = {
          ...configured,
          recentlyReviewedToolUseIds: [...reviewedToolUseIds],
          apiKey: await getApiKey($, configured),
          baseUrl: jevEndpoint(configured),
        };
        const goal = compactionGoal(input, configured, event.instructions);
        if (goal) config.goal = goal;
        config.cutTokens = cutTokens;
        if (pages) config.pages = pages;
        const compaction = await compactSession(
          input,
          config,
          async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
          },
          (line) => $.ui.log(line),
          transport,
          (ms) => $.clock.sleep(ms),
          {
            request: (index, planned) =>
              progressNotice($, gate, `${tag}: Jev request ${index}/${planned}, ${Math.round((Date.now() - started) / 1000)} s`),
          },
          (ms) => {
            const controller = new AbortController();
            const expired = $.clock.sleep(ms, { signal: controller.signal });
            return { expired, cancel: () => controller.abort() };
          },
        );
        result = compaction.result;
        rebuilt = compaction.rebuild;
        for (const id of result.reviewedToolUseIds) reviewedToolUseIds.add(id);
        if (result.stats.deferred === 0) reviewedToolUseIds.clear();
        for (const line of decisionLogLines(result)) $.ui.log(line);
        const cut = reductionRatio(result) > 0;
        if (!cut && !structural) {
          return await skipWith($, gate, `${tag}: Jev kept everything; session unchanged (${summarize(result)})`);
        }
        if (cut && reductionRatio(result) < config.minReductionRatio && !structural) {
          return await skipWith($, gate,
            `${tag}: reduction below the ${percent(config.minReductionRatio)} minimum; session unchanged (${summarize(result)})`,
          );
        }
      } else {
        // Nothing for Jev: only the deterministic part (old inputs) and the
        // collapsing of old calls run.
        const noJev: JevAsker = { ask: async () => { throw new Error('no Jev question expected'); } };
        result = await compact(input, noJev, { ...configured, cutTokens, ...(pages ? { pages } : {}) });
        rebuilt = toSessionMessages(result.messages);
        if (result.stats.charsAfter >= result.stats.charsBefore && !structural) {
          return await skipWith($, gate, `${tag}: nothing to take out (${pinned} pinned of ${preflightCalls.length} tool call(s), nothing old worth collapsing); session unchanged`);
        }
      }

      const visibleBefore = visibleTokens(event.messages);
      const visibleAfter = visibleTokens(rebuilt.messages as Message[]);
      const parts = [
        result ? summarize(result) : 'no Jev request needed',
        main ? `${pageIns} page-in(s) since the last compaction` : '',
        ...repairs,
        rebuilt.orphanCalls > 0 ? `${rebuilt.orphanCalls} call(s) without a result dropped` : '',
      ].filter(Boolean);
      await sayNotice(
        $,
        gate,
        `${tag}: done in ${Math.round((Date.now() - started) / 1000)} s, no summary; ` +
          `${sizeReport(tokensBefore, visibleBefore, visibleAfter, rebuilt.thinkingRows, reloaded, overhead, origin)}. ${parts.join('; ')}` +
          (result ? `; ${transportSummary(transport)}` : ''),
      );
      if (sessionId && (restoring.restored.length > 0 || restoring.present.length > 0)) {
        await forgetQueued($, sessionId, [...restoring.restored, ...restoring.present]);
      }
      if (main && event.trigger !== 'precompute') pageIns = 0;
      if (tokensBefore !== undefined && event.trigger !== 'precompute') {
        effectPending = reloaded ? { visibleAfter } : { before: tokensBefore, visibleAfter };
      }
      return { messages: rebuilt.messages };
    } catch (error) {
      if (error instanceof TurnInProgressError) {
        return await skipWith($, gate, `${tag}: ${error.message}; session unchanged, compaction runs between turns`);
      }
      return await skipWith($, gate, `${tag}: Jev compaction failed, session unchanged, no Claude summary (${errorText(error)})`);
    }
  });

  // Reading a page back is part of compaction working: never a permission
  // prompt, and counted, since how often it happens says whether compaction
  // pages out too much.
  on('tool.check', { tool: 'Read' }, async ($, event, next) => {
    pagesRoot ||= await pagesRootOf($);
    const path = (event.input as { file_path?: unknown } | undefined)?.file_path;
    if (isPagePath(path, pagesRoot)) return { decision: 'allow', reason: 'fast-jev page of a shortened tool result' };
    return next(event);
  });
  // The real size of the first request after a compaction. At the turn's
  // first tool call the last response is that request's; a turn without
  // tools reports it at its end. turn.complete alone would count the calls
  // of a long turn as overhead.
  on('tool.call', async ($, event, next) => {
    if (event.agentId !== undefined) return next(event);
    if (effectPending !== undefined) {
      try {
        const { context } = await $.session.usage();
        const effect = effectPending;
        if (context.tokens !== undefined && effect !== undefined) {
          effectPending = undefined;
          await reportEffect($, gate, effect, context.tokens, usageOrigin(context));
        }
      } catch {
        // Measured at the turn's end instead.
      }
    }
    if (event.tool === 'Read') {
      pagesRoot ||= await pagesRootOf($);
      if (isPagePath((event as { file_path?: unknown }).file_path, pagesRoot)) {
        pageIns += 1;
        logNotice($, `fast-jev ${LOCAL_BUILD}: page-in ${pageIns} since the last compaction`);
      }
    }
    return next(event);
  });

  // A message the user sends mid-turn reaches the model as an attachment of
  // the next tool result, which a rebuilt tool result does not carry. Recorded
  // here, it is put back as user text at the next compaction.
  on('prompt.submit', async ($, event, next) => {
    const answer = await next(event);
    if (event.turnId === undefined || answer.drop !== undefined || !HUMAN_ORIGINS.has(event.origin.kind)) return answer;
    try {
      const messages = await $.session.messages();
      const after = messages.flatMap((message) => message.toolUses).at(-1)?.tool_use_id;
      await rememberQueued($, await $.session.id(), { text: answer.text, ...(after ? { after } : {}), at: Date.now() });
    } catch (error) {
      logNotice($, `fast-jev ${LOCAL_BUILD}: could not record a mid-turn message (${errorText(error)})`);
    }
    return answer;
  });

  // Manual-only: NEVER call $.session.compact() from turn.complete, regardless
  // of context pressure. DISABLE_AUTO_COMPACT and the PreCompact guard remain
  // the independent engine-side safety nets; explicit /compact uses the
  // session.compact hook above, which never delegates to built-in summary.
  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    const answer = await next(event);
    if (event.agentId !== undefined || effectPending === undefined) return answer;
    try {
      const { context } = await $.session.usage();
      if (context.tokens !== undefined && effectPending !== undefined) {
        const effect = effectPending;
        effectPending = undefined;
        await reportEffect($, gate, effect, context.tokens, usageOrigin(context));
      }
    } catch {
      // Keep the pending measurement for the next eligible tool or turn.
    }
    return answer;
  });
};

export { resolveOptions };
