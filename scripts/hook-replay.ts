/**
 * The whole hook (register → session.compact) over a real session state,
 * offline: the file system is in memory, Jev answers 0.55–0.70 at random
 * (where its real scores sit), usage is the boundary's own preTokens. Checks
 * what a headless live run cannot while its OAuth is gone: the rebuild the
 * engine gets, the pages, the notice. Prints counts and the notice only.
 *
 *   npx tsx scripts/hook-replay.ts <session.jsonl> [--before N] [--live] [--overhead N] [opt:key=value]
 *
 * --live asks the real Jev (TYPESAFE_API_KEY from the environment);
 * --overhead N stands for what a previous compaction measured outside the
 * messages; opt: sets a plugin option.
 */
import { readFileSync } from 'node:fs';
import { register } from '../hooks/fast-jev.ts';
import { chainTo, toMessages } from './composition.ts';

const [path, ...rest] = process.argv.slice(2);
if (path === '--synthetic') {
  await syntheticReplay();
} else {
if (!path) throw new Error('Usage: npx tsx scripts/hook-replay.ts <session.jsonl> [--before N]');
const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const boundaries = rows.filter((r) => r.subtype === 'compact_boundary');
const at = rest.indexOf('--before');
const live = rest.includes('--live');
const overheadAt = rest.indexOf('--overhead');
const overhead = overheadAt >= 0 ? Number(rest[overheadAt + 1]) : undefined;
const extra = Object.fromEntries(rest.filter((a) => a.startsWith('opt:')).map((a) => {
  const [k, v] = a.slice(4).split('=');
  return [k!, Number.isFinite(Number(v)) ? Number(v) : v];
}));
const boundary = boundaries[(at >= 0 ? Number(rest[at + 1]) : boundaries.length) - 1];
const messages = toMessages(chainTo(rows, boundary.logicalParentUuid)).map((m, i) =>
  m.role === 'user' && !(m.toolResults?.length) ? { ...m, handle: `h${i}` } : m);

const files = new Map<string, string>();
const toasts: string[] = [];
const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
const sessionId = rows.find((r) => r.sessionId)?.sessionId ?? '00000000-0000-0000-0000-000000000000';
const $ = {
  store: { get: async (key: string) => (key === 'after-compaction-overhead' && overhead !== undefined ? [overhead] : undefined), set: async () => {} },
  ui: { log: () => {}, toast: (text: string) => void toasts.push(text) },
  env: { get: async (name: string) => (name === 'USERPROFILE' ? 'C:/Users/user' : name === 'TYPESAFE_API_KEY' ? (live ? process.env.TYPESAFE_API_KEY : 'offline') : undefined) },
  fs: {
    write: async (file: string, text: string) => void files.set(file, text),
    list: async (dir: string) => [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => ({ name: f.slice(dir.length + 1) })),
  },
  clock: {
    sleep: (ms: number, options?: { signal?: AbortSignal }) => live
      ? new Promise<void>((done) => {
        const timer = setTimeout(done, ms);
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); done(); });
      })
      : Promise.resolve(),
  },
  http: {
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (live) {
        const response = await fetch(url, init as RequestInit);
        return { status: response.status, ok: response.ok, text: await response.text(), headers: {} };
      }
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.55 + Math.random() * 0.15 }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
    },
  },
  session: {
    id: async () => sessionId,
    cwd: async () => 'C:/work',
    messages: async () => [],
    usage: async () => ({ context: { tokens: boundary.compactMetadata.preTokens, percent: 40, window: 1_000_000 } }),
  },
};
register(((name: string, a: any, b?: any) => { handlers[name] = b ?? a; }) as never,
  { keepThreshold: 0.5, preserveRecentMessages: 12, compactAtPercent: 30, ...extra } as never);

const started = Date.now();
const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, async () => {
  throw new Error('next(event) called: that is the Claude summary');
});
const out = (result.messages ?? []) as typeof messages;
let unmatched = 0;
out.forEach((m, i) => {
  if (m.role !== 'assistant' || m.toolUses.length === 0) return;
  const ids = m.toolUses.map((t) => t.tool_use_id).join();
  if ((out[i + 1]?.toolResults ?? []).map((r) => r.tool_use_id).join() !== ids) unmatched += 1;
});
const named = out.flatMap((m) => m.toolResults ?? []).flatMap((r) => [...r.text.matchAll(/(C:\/\S+?\.call\.txt)/g)].map((x) => x[1]!));
console.log(JSON.stringify({
  ms: Date.now() - started,
  skip: result.skip,
  messages: `${messages.length} -> ${out.length}`,
  userTextsKept: `${out.filter((m) => 'handle' in m && m.handle).length} of ${messages.filter((m) => 'handle' in m).length}`,
  callsWithoutTheirResults: unmatched,
  pagesWritten: files.size,
  pagesNamedButMissing: named.filter((p) => !files.has(p)).length,
  notice: toasts.at(-1),
}, null, 1));
}

/**
 * Safe CI probe: real register/compact/usage handlers, with only synthetic
 * messages, bounded fake Jev and an immutable in-memory page store. Never
 * reads a session, a key, or a network endpoint.
 */
async function syntheticReplay(): Promise<void> {
  type Row = { role: 'user' | 'assistant'; text: string; toolUses: Array<{ tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string }>; toolResults?: Array<{ tool_use_id: string; text: string; isError: boolean }>; handle?: string };
  const originalResult = 'HEAD synthetic-result\n' + 'historical output '.repeat(400) + '\nEND synthetic-result';
  const source: Row[] = [
    { role: 'user', text: 'Fix synthetic tests.', toolUses: [], handle: 'u0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'synthetic test' }, text: originalResult }], handle: 'a1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: originalResult, isError: false }], handle: 'r1' },
    { role: 'assistant', text: 'Synthetic follow-up.', toolUses: [], handle: 'a2' },
    { role: 'user', text: 'Continue synthetic work.', toolUses: [], handle: 'u3' },
  ];
  const pages = new Map<string, string>();
  const checks: Array<{ id: string; ok: boolean; reason: string }> = [];
  let requests = 0;
  let builtInCalls = 0;
  let automaticCalls = 0;
  let usageTokens = 12000;
  const initialText = source.filter((m) => m.role === 'user' && m.text).map((m) => m.text);
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const toasts: string[] = [];
  const $ = {
    store: { get: async () => undefined, set: async () => {} },
    ui: { log: () => {}, toast: (value: string) => { toasts.push(value); } },
    env: { get: async (key: string) => key === 'USERPROFILE' ? 'C:/synthetic-home' : key === 'CLAUDE_CONFIG_DIR' ? undefined : 'synthetic-key' },
    fs: {
      write: async (name: string, data: string) => { if (!pages.has(name)) pages.set(name, data); },
      list: async (dir: string) => [...pages.keys()].filter((s) => s.startsWith(dir + '/')).map((name) => ({ name: name.slice(dir.length + 1) })),
    },
    clock: { sleep: async () => {} },
    http: { fetch: async (_url: string, init?: { body?: string }) => {
      requests += 1;
      const payload = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(payload.questions ?? {}).map((key) => [key, { noul: 0.001 }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
    } },
    session: {
      id: async () => 'synthetic-session',
      cwd: async () => 'C:/synthetic-work',
      messages: async () => [],
      usage: async () => ({ context: { tokens: usageTokens, percent: usageTokens === 12000 ? 40 : 6, window: 50000, measurementSource: 'synthetic/mock' }, rateLimits: [] }),
      compact: async () => { automaticCalls += 1; return { skip: 'synthetic engine compact blocked' }; },
    },
  };
  register(((name: string, first: any, second?: any) => { handlers[name] = second ?? first; }) as never,
    { preserveRecentMessages: 1, compactAtPercent: 30, questionVariant: 'keep_or_page', provider: 'openrouter' } as never);
  const next = async () => { builtInCalls += 1; throw new Error('built-in summary forbidden'); };
  const first = await handlers['session.compact']!($, { trigger: 'manual', messages: source }, next);
  const firstMessages = (first.messages ?? []) as Row[];
  checks.push({ id: 'S1.manual_real_hook', ok: firstMessages.length > 0 && requests > 0, reason: 'manual register/compact with mocked Jev' });
  usageTokens = 3000;
  if (first.messages) await handlers['tool.call']!($, { tool: 'Bash' }, async () => ({ ok: true }));
  checks.push({ id: 'S1.measured_usage', ok: toasts.some((notice) => notice.includes('first-request input usage [synthetic/mock]') && notice.includes('3k tokens')), reason: 'post-compact input usage is labelled mock' });
  const snapshot = new Map(pages);
  const firstCall = firstMessages.find((row) => row.toolUses.some((use) => use.tool_use_id === 't1'));
  const firstResult = firstMessages.find((row) => (row.toolResults ?? []).some((use) => use.tool_use_id === 't1'));
  // Simulate the real engine replaying a call/result with the same stable
  // tool_use_id. Distinct author-written assistant prose is not duplicated:
  // equality of text alone is never proof that an authored reply was replayed.
  const secondInput: Row[] = [
    ...firstMessages.slice(0, -1),
    ...(firstCall && firstResult ? [
      { ...firstCall, handle: 'replayed-call' },
      { ...firstResult, handle: 'replayed-result' },
    ] : []),
    firstMessages.at(-1)!,
    { role: 'user', text: 'Second synthetic request.', toolUses: [], handle: 'u4' },
  ];
  const inputUses = secondInput.flatMap((row) => row.toolUses.filter((use) => use.tool_use_id === 't1')).length;
  const inputResults = secondInput.flatMap((row) => (row.toolResults ?? []).filter((use) => use.tool_use_id === 't1')).length;
  checks.push({ id: 'S2.replayed_tool_payload', ok: inputUses === 2 && inputResults === 2, reason: 'a duplicate tool-use/result is injected into the second run' });
  const second = await handlers['session.compact']!($, { trigger: 'manual', messages: secondInput }, next);
  // A no-op skip is not a missing model input: the engine retains secondInput.
  const rebuilt = (second.messages ?? secondInput) as Row[];
  const ids = rebuilt.flatMap((row) => row.toolUses.map((t) => t.tool_use_id));
  const resultIds = rebuilt.flatMap((row) => (row.toolResults ?? []).map((t) => t.tool_use_id));
  checks.push({ id: 'S2.call_result_pairing', ok: ids.length === 1 && resultIds.length === 1 && ids[0] === resultIds[0], reason: 'a single paired tool-use/result across two manual compactions' });
  checks.push({ id: 'S2.immutable_page', ok: snapshot.size > 0 && [...snapshot].every(([name, content]) => pages.get(name) === content), reason: 'page snapshots remain unchanged' });
  checks.push({ id: 'S2.user_verbatim', ok: initialText.every((value) => rebuilt.some((row) => row.role === 'user' && row.text === value)), reason: 'original user text is unchanged' });
  let continued = 0;
  await handlers['turn.complete']!($, { agentId: undefined }, async () => { continued += 1; return { ok: true }; });
  checks.push({ id: 'S3.autocompact_off', ok: continued === 1 && automaticCalls === 0 && builtInCalls === 0, reason: 'no engine automatic compact or summary' });
  const passed = checks.every((check) => check.ok);
  process.stdout.write(JSON.stringify({
    mode: 'synthetic/offline', passed, checks, jevRequests: requests,
    pageCount: pages.size, builtInCalls, automaticCalls,
  }) + '\n');
  if (!passed) process.exitCode = 1;
}
