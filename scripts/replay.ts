/** Offline diagnosis: no network, no transcript content or secrets in output. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compact, messageChars } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import type { Message, JevAsker } from '../src/types.js';

type Row = { uuid?: string; parentUuid?: string; type?: string; subtype?: string;
  isSidechain?: boolean; message?: { role: string; content: any; usage?: any }; compactMetadata?: any };

export function activeMessages(path: string, beforeBoundary = false): Message[] {
  let rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
  if (beforeBoundary) {
    const index = rows.findLastIndex((row) => row.subtype === 'compact_boundary');
    if (index >= 0) rows = rows.slice(0, index);
  }
  const byId = new Map(rows.filter((row) => row.uuid).map((row) => [row.uuid!, row]));
  const leaf = rows.findLast((row) => !row.isSidechain && ['user', 'assistant'].includes(row.type ?? ''));
  const chain: Row[] = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor?.uuid && !visited.has(cursor.uuid)) {
    visited.add(cursor.uuid); chain.push(cursor);
    cursor = cursor.parentUuid ? byId.get(cursor.parentUuid) : undefined;
  }
  chain.reverse();
  const contentText = (content: any): string => typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join('') : '';
  const messages: Message[] = [];
  for (const row of chain) {
    if (!row.message || !['user', 'assistant'].includes(row.type ?? '')) continue;
    const content = row.message.content;
    const blocks = Array.isArray(content) ? content : [];
    const message: Message = { role: row.type as Message['role'], text: contentText(content),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ tool_use_id: b.id, tool: b.name, input: b.input })) };
    const results = blocks.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id, text: contentText(b.content), isError: !!b.is_error }));
    if (results.length) message.toolResults = results;
    messages.push(message);
  }
  const results = new Map(messages.flatMap((m) => m.toolResults ?? []).map((r) => [r.tool_use_id, r]));
  for (const message of messages) for (const tool of message.toolUses) {
    const result = results.get(tool.tool_use_id);
    if (result) { tool.text = result.text; tool.isError = result.isError; }
  }
  return messages;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npx tsx scripts/replay.ts <transcript.jsonl> [--before-boundary] [--baseline <root>]');
  const messages = activeMessages(path, process.argv.includes('--before-boundary'));
  const calls = collectToolCalls(messages, 12);
  const sizes: Record<string, number> = {};
  for (const call of calls) sizes[call.tool] = (sizes[call.tool] ?? 0) + call.resultChars;
  console.log(JSON.stringify({ messages: messages.length, calls: calls.length,
    userChars: messages.filter((m) => m.role === 'user').reduce((sum, m) => sum + m.text.length, 0),
    assistantChars: messages.filter((m) => m.role === 'assistant').reduce((sum, m) => sum + m.text.length, 0),
    totalChars: messages.reduce((sum, m) => sum + messageChars(m), 0),
    resultChars: Object.values(sizes).reduce((a, b) => a + b, 0),
    largestTools: Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 6),
  }));
  const baselineIndex = process.argv.indexOf('--baseline');
  const runs: Array<[string, typeof compact]> = [['working', compact]];
  if (baselineIndex >= 0) {
    const module = await import(pathToFileURL(resolve(process.argv[baselineIndex + 1]!, 'src/compact.ts')).href);
    runs.unshift(['installed', module.compact]);
  }
  for (const [version, run] of runs) {
    let firstRequestMs = 0;
    let askedQuestions = 0;
    const start = performance.now();
    const fake: JevAsker = { async ask(_state, questions) {
      if (!firstRequestMs) firstRequestMs = performance.now() - start;
      askedQuestions += Object.keys(questions).length;
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.001 }])) };
    } };
    try {
      const result = await run(messages, fake, { preserveRecentMessages: 12, keepThreshold: 0.5, compactAssistantText: false });
      console.log(JSON.stringify({ version, fakeScorer: true, firstRequestMs: Math.round(firstRequestMs),
        cpuMs: Math.round(performance.now() - start), requests: result.stats.requests, askedQuestions,
        maximumReductionPercent: Math.round(100 * (1 - result.stats.charsAfter / result.stats.charsBefore)),
        stateTokens: result.stats.stateTokens, stage: result.stats.stateStage }));
    } catch (error) { console.log(JSON.stringify({ version, error: String(error) })); }
  }
}
