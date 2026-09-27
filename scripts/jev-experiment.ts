/**
 * Live Jev on cuts of real sessions whose future is known: how well a question
 * variant tells the outputs the agent needed later from the rest. Prints and
 * writes counts and scores only, never content.
 *
 *   npx tsx scripts/jev-experiment.ts pick <out.json> <session.jsonl>...
 *   npx tsx scripts/jev-experiment.ts run <slices.json> <out.json> [variant=relevance] [preview=1000]
 *
 * `pick` chooses up to two cuts per session: after a tool result, the chain
 * a prefix of the session, at least 80 messages of future and 20 candidates.
 * `run` asks Jev (TYPESAFE_API_KEY) once per cut and stores, per candidate,
 * its score, size and the label: whether the agent later wrote a value unique
 * to that output before seeing it again (a collapse keeps none of it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { activeMessagesFromRows } from './replay.js';
import { evaluateCut } from './evaluate.js';
import { compact } from '../src/compact.js';
import { JevClient } from '../src/client.js';
import { claudeTokens } from '../src/size.js';
import type { Message } from '../src/types.js';

type Slice = { session: string; rows: number };
type Row = { id: string; tool: string; chars: number; needed: boolean; firstUseAfter?: number; score?: number };

function load(path: string): unknown[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function cut(lines: unknown[], rows: number): { prefix: Message[]; future: Message[] } | undefined {
  const prefix = activeMessagesFromRows(lines.slice(0, rows) as never);
  const full = activeMessagesFromRows(lines as never);
  const aligned = prefix.length > 0 && prefix.every((m, i) => full[i]?.role === m.role && full[i]?.text === m.text);
  return aligned ? { prefix, future: full.slice(prefix.length) } : undefined;
}

function pick(out: string, sessions: string[]): void {
  const slices: Slice[] = [];
  for (const session of sessions) {
    const lines = load(session) as Array<Record<string, any>>;
    const firstBoundary = lines.findIndex((r) => r.subtype === 'compact_boundary');
    const end = firstBoundary > 0 ? firstBoundary : lines.length;
    const found: Slice[] = [];
    for (const fraction of [0.4, 0.65]) {
      for (let rows = Math.floor(end * fraction); rows < end; rows += 1) {
        const r = lines[rows - 1];
        const isResult = r?.type === 'user' && Array.isArray(r.message?.content) &&
          r.message.content.some((b: any) => b?.type === 'tool_result');
        if (!isResult) continue;
        const c = cut(lines, rows);
        if (!c || c.future.length < 80) break;
        if (evaluateCut(c.prefix, c.future, 300, 0).length >= 20) found.push({ session, rows });
        break;
      }
    }
    slices.push(...found);
    console.log(`${session.split(/[\\/]/).pop()}: ${found.map((f) => f.rows).join(', ') || 'none'}`);
  }
  writeFileSync(out, JSON.stringify(slices, null, 1));
}

function contextTokens(messages: readonly Message[]): number {
  return claudeTokens(messages.map((m) =>
    m.text + JSON.stringify(m.toolUses) + (m.toolResults ?? []).map((r) => r.text).join('')).join(''));
}

async function run(slicesPath: string, out: string, variant: string, preview: number): Promise<void> {
  const slices = JSON.parse(readFileSync(slicesPath, 'utf8')) as Slice[];
  const results: Array<Slice & { contextTokens: number; ms: number; rows: Row[]; error?: string }> = [];
  for (const slice of slices) {
    const c = cut(load(slice.session), slice.rows)!;
    const rows: Row[] = evaluateCut(c.prefix, c.future, 300, 0).map((o) => ({
      id: o.tool_use_id, tool: o.tool, chars: o.chars, needed: o.usedFromMemory > 0,
      ...(o.firstUseAfter !== undefined ? { firstUseAfter: o.firstUseAfter } : {}),
    }));
    const started = Date.now();
    let error: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await compact(c.prefix, new JevClient(), {
          preserveRecentMessages: 12,
          questionVariant: variant as 'relevance' | 'keep_or_page',
          resultPreviewChars: preview,
        });
        const scores = new Map(result.decisions.filter((d) => d.tool_use_id).map((d) => [d.tool_use_id!, d.keepResult]));
        for (const row of rows) if (scores.has(row.id)) row.score = scores.get(row.id);
        error = undefined;
        break;
      } catch (e) {
        error = (e as Error).message;
        await new Promise((done) => setTimeout(done, 5_000));
      }
    }
    const ms = Date.now() - started;
    results.push({ ...slice, contextTokens: contextTokens(c.prefix), ms, rows, ...(error ? { error } : {}) });
    console.log(`${slice.session.split(/[\\/]/).pop()?.slice(0, 8)}@${slice.rows}: ${rows.filter((r) => r.score !== undefined).length}/${rows.length} scored, ${rows.filter((r) => r.needed).length} needed, ${Math.round(ms / 1000)} s${error ? ' ERROR ' + error : ''}`);
    writeFileSync(out, JSON.stringify({ variant, preview, results }, null, 1));
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'pick') pick(args[0]!, args.slice(1));
else if (mode === 'run') await run(args[0]!, args[1]!, args[2] ?? 'relevance', Number(args[3] ?? 1000));
else throw new Error('Usage: jev-experiment.ts pick <out> <sessions...> | run <slices> <out> [variant] [preview]');
