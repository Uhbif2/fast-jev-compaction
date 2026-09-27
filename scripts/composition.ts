/**
 * Where a context goes after a compaction, and what a compaction of it would
 * leave, measured on a real transcript without a network. Prints sizes only,
 * never content.
 *
 *   npx tsx scripts/composition.ts <session.jsonl> [--before N] [opt:key=value ...]
 *
 * --before N simulates the hook on the state just before the N-th boundary
 * (1-based; default the last) with a scorer that keeps everything (0.6), so
 * only the size target and the deterministic rules decide what goes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compact, resolveOptions } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { claudeTokens, THINKING_TOKENS_PER_BLOCK } from '../src/size.js';
import { dedupeReplayedHistory, dropCommandNoise, engineMessages, type EngineMessage } from '../src/transcript.js';
import type { JevAsker, Message } from '../src/types.js';

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string; is_error?: boolean };
type Row = {
  uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null; type?: string; subtype?: string;
  isSidechain?: boolean; message?: { content?: string | Block[] }; compactMetadata?: Record<string, number>;
};

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b: Block) => b?.type === 'text').map((b: Block) => b.text ?? '').join('') : '';

/** The chain ending at `leaf`, first occurrence of every uuid (the file repeats them). */
export function chainTo(rows: readonly Row[], leaf: string | undefined): Row[] {
  const byId = new Map<string, Row>();
  for (const row of rows) if (row.uuid && !byId.has(row.uuid)) byId.set(row.uuid, row);
  const chain: Row[] = [];
  const seen = new Set<string>();
  for (let row = leaf ? byId.get(leaf) : undefined; row?.uuid && !seen.has(row.uuid); row = row.parentUuid ? byId.get(row.parentUuid) : undefined) {
    seen.add(row.uuid);
    chain.push(row);
  }
  return chain.reverse();
}

export function toMessages(chain: readonly Row[]): Message[] {
  const messages: Message[] = [];
  for (const row of chain) {
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const content = row.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const message: Message = {
      role: row.type, text: textOf(content),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ tool_use_id: b.id!, tool: b.name!, input: b.input ?? {} })),
    };
    const results = blocks.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id!, text: textOf(b.content), isError: !!b.is_error }));
    if (results.length) message.toolResults = results;
    messages.push(message);
  }
  const byId = new Map(messages.flatMap((m) => m.toolResults ?? []).map((r) => [r.tool_use_id, r]));
  for (const m of messages) for (const t of m.toolUses) {
    const r = byId.get(t.tool_use_id);
    if (r) { t.text = r.text; t.isError = r.isError; }
  }
  return messages;
}

/** Characters and Claude tokens by kind; tool_use inputs also by tool. */
export function composition(messages: readonly Message[]) {
  const kinds: Record<string, { n: number; chars: number; tokens: number }> = {};
  const add = (kind: string, text: string) => {
    const k = (kinds[kind] ??= { n: 0, chars: 0, tokens: 0 });
    k.n += 1; k.chars += text.length; k.tokens += claudeTokens(text);
  };
  for (const m of messages) {
    if (m.text.trim()) add(`${m.role} text`, m.text);
    for (const t of m.toolUses) add(`input ${t.tool}`, JSON.stringify(t.input));
    for (const r of m.toolResults ?? []) add('tool results', r.text);
  }
  const total = Object.values(kinds).reduce((s, k) => ({ chars: s.chars + k.chars, tokens: s.tokens + k.tokens }), { chars: 0, tokens: 0 });
  return { total, kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1].tokens - a[1].tokens)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path) throw new Error('Usage: npx tsx scripts/composition.ts <session.jsonl> [--before N] [opt:key=value]');
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Row);
  const boundaries = rows.flatMap((r, i) => (r.subtype === 'compact_boundary' ? [i] : []));
  const at = rest.indexOf('--before');
  const n = at >= 0 ? Number(rest[at + 1]) : boundaries.length;
  const boundary = rows[boundaries[n - 1]!]!;
  const before = toMessages(chainTo(rows, boundary.logicalParentUuid ?? undefined));

  const options: Record<string, unknown> = { keepThreshold: 0.5, preserveRecentMessages: 12, targetPercent: 15, compactAssistantText: false };
  for (const arg of rest.filter((a) => a.startsWith('opt:'))) {
    const [key, value] = arg.slice(4).split('=');
    options[key!] = Number.isFinite(Number(value)) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
  }
  const resolved = resolveOptions(options);
  const deduped = dedupeReplayedHistory(before as EngineMessage[]);
  const input = dropCommandNoise(deduped.messages, resolved.preserveRecentMessages).messages;
  const calls = collectToolCalls(input, resolved.preserveRecentMessages, resolved.resultPreviewChars);
  const dir = 'C:/Users/user/.claude/fast-jev-pages/00000000';
  // As the hook writes them: every old call with something to page out.
  const pageable = new Set(calls.filter((c) => !c.pinned && JSON.stringify(c.input).length + c.resultChars >= 500).map((c) => c.tool_use_id));
  const preTokens = boundary.compactMetadata?.preTokens ?? 0;
  const thinking = before.filter((m) => m.role === 'assistant' && !m.text.trim() && m.toolUses.length === 0).length;
  const window = 1_000_000;
  const keepAll: JevAsker = {
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.6 }])) };
    },
  };
  const result = await compact(input, keepAll, {
    ...options,
    cutTokens: Math.max(0, preTokens - Math.floor((window * Number(options.targetPercent)) / 100) - thinking * THINKING_TOKENS_PER_BLOCK),
    pages: {
      page: (id) => (pageable.has(id) ? `${dir}/${id}.call.txt` : undefined),
      transcript: `C:/Users/user/.claude/projects/x/${'0'.repeat(36)}.jsonl`,
    },
  });
  const after = engineMessages(result.messages as EngineMessage[]).messages as Message[];
  const cut = composition(input).total.tokens - composition(after).total.tokens + thinking * THINKING_TOKENS_PER_BLOCK;
  console.log(JSON.stringify({
    boundary: n, preTokens, thinkingBlocks: thinking, estimatedAfter: preTokens - cut, engineCompactMetadata: boundary.compactMetadata,
    before: composition(input), after: composition(after),
    stats: { ...result.stats, resultScores: undefined, stateStage: undefined },
  }, null, 1));
}
