/**
 * The whole hook (register → session.compact) over a real session state,
 * offline: the file system is in memory, Jev answers 0.55–0.70 at random
 * (where its real scores sit), usage is the boundary's own preTokens. Checks
 * what a headless live run cannot while its OAuth is gone: the rebuild the
 * engine gets, the pages, the notice. Prints counts and the notice only.
 *
 *   npx tsx scripts/hook-replay.ts <session.jsonl> [--before N]
 */
import { readFileSync } from 'node:fs';
import { register } from '../hooks/fast-jev.ts';
import { chainTo, toMessages } from './composition.ts';

const [path, ...rest] = process.argv.slice(2);
if (!path) throw new Error('Usage: npx tsx scripts/hook-replay.ts <session.jsonl> [--before N]');
const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const boundaries = rows.filter((r) => r.subtype === 'compact_boundary');
const at = rest.indexOf('--before');
const boundary = boundaries[(at >= 0 ? Number(rest[at + 1]) : boundaries.length) - 1];
const messages = toMessages(chainTo(rows, boundary.logicalParentUuid)).map((m, i) =>
  m.role === 'user' && !(m.toolResults?.length) ? { ...m, handle: `h${i}` } : m);

const files = new Map<string, string>();
const toasts: string[] = [];
const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
const sessionId = rows.find((r) => r.sessionId)?.sessionId ?? '00000000-0000-0000-0000-000000000000';
const $ = {
  store: { get: async () => undefined, set: async () => {} },
  ui: { log: () => {}, toast: (text: string) => void toasts.push(text) },
  env: { get: async (name: string) => (name === 'USERPROFILE' ? 'C:/Users/user' : name === 'TYPESAFE_API_KEY' ? 'offline' : undefined) },
  fs: {
    write: async (file: string, text: string) => void files.set(file, text),
    list: async (dir: string) => [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => ({ name: f.slice(dir.length + 1) })),
  },
  clock: { sleep: async () => {} },
  http: {
    fetch: async (_url: string, init?: { body?: string }) => {
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
  { keepThreshold: 0.5, preserveRecentMessages: 12, compactAtPercent: 30 } as never);

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
