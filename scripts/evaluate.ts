/**
 * Offline quality measure of a compaction decision on a real session whose
 * future is known. Prints counts only, never content.
 *
 *   npx tsx scripts/evaluate.ts <session.jsonl> --rows N [--decisions <debug.log>]
 *
 * The session is cut after its first N lines, as `live-compact.mjs --rows N`
 * cuts it. For every candidate the planner would ask Jev about, the part a
 * truncation removes (all but the kept head and tail) is searched for
 * distinctive values: identifiers, paths, numbers that appear nowhere else in
 * the context at the cut. Walking the rest of the session, such a value that
 * the agent writes (in its text or in a tool input) before any later tool
 * result shows it again was taken from memory: removing that body would have
 * cost the continuation something. That is a regret.
 *
 * The measure is a proxy. It misses information used without copying a
 * distinctive value (a conclusion, an absence) and the thinking the plugin
 * cannot see; it counts a value used by coincidence. It is good at ranking
 * policies against each other on the same cut, not at absolute truth.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeMessagesFromRows } from './replay.js';
import { collectToolCalls } from '../src/state.js';
import { compactionCandidates, resolveOptions } from '../src/compact.js';
import type { Message, ToolCall } from '../src/types.js';

const TOKEN = /[\p{L}\p{N}_][\p{L}\p{N}_.\-/\\:]{5,}/gu;

/** Values worth tracking: not plain words. */
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const [raw] of text.matchAll(TOKEN)) {
    const token = raw.replace(/[.:\-/\\]+$/, '');
    if (token.length < 6) continue;
    if (/\d/.test(token) || /[_./\\:-]/.test(token) || /\p{Ll}\p{Lu}/u.test(token)) out.add(token);
  }
  return out;
}

function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function resultText(messages: readonly Message[], call: ToolCall): string {
  const row = messages[call.resultIndex]!;
  const explicit = row.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
  if (explicit) return explicit.text;
  return messages[call.callIndex]!.toolUses.find((u) => u.tool_use_id === call.tool_use_id)?.text ?? '';
}

export type CandidateOutcome = {
  tool_use_id: string;
  tool: string;
  chars: number;
  bodyTokens: number;
  /** Distinct body values the agent later wrote before seeing them again. */
  usedFromMemory: number;
  /** Messages from the cut to the first such use. */
  firstUseAfter?: number;
};

export function evaluateCut(prefix: readonly Message[], future: readonly Message[], headChars = 300): CandidateOutcome[] {
  const options = resolveOptions({ preserveRecentMessages: 12, truncateHeadChars: headChars });
  const calls = collectToolCalls(prefix, options.preserveRecentMessages);
  const candidates = compactionCandidates(calls, options);
  const bodies = new Map<string, Set<string>>();
  const elsewhere = new Map<string, number>();
  const count = (tokens: Set<string>) => { for (const t of tokens) elsewhere.set(t, (elsewhere.get(t) ?? 0) + 1); };
  const candidateIds = new Set(candidates.map((c) => c.tool_use_id));
  for (const message of prefix) {
    count(distinctiveTokens(message.text));
    for (const use of message.toolUses) count(distinctiveTokens(inputText(use.input)));
  }
  for (const call of calls) {
    const text = resultText(prefix, call);
    if (!candidateIds.has(call.tool_use_id) || text.length <= headChars * 2 + 200) {
      count(distinctiveTokens(text));
      continue;
    }
    count(distinctiveTokens(text.slice(0, headChars) + '\n' + text.slice(-headChars)));
    bodies.set(call.tool_use_id, distinctiveTokens(text.slice(headChars, -headChars)));
  }
  // A body value counts only when nothing else at the cut holds it; two
  // bodies sharing it make each of them look replaceable, which it is not.
  const bodyOwners = new Map<string, number>();
  for (const tokens of bodies.values()) for (const t of tokens) bodyOwners.set(t, (bodyOwners.get(t) ?? 0) + 1);
  const unique = new Map<string, Set<string>>();
  for (const [id, tokens] of bodies) {
    unique.set(id, new Set([...tokens].filter((t) => !elsewhere.has(t) && bodyOwners.get(t) === 1)));
  }

  const reacquired = new Set<string>();
  const used = new Map<string, Set<string>>();
  const firstUse = new Map<string, number>();
  const owner = new Map<string, string>();
  for (const [id, tokens] of unique) for (const t of tokens) owner.set(t, id);
  future.forEach((message, step) => {
    const writes = message.role === 'assistant'
      ? [message.text, ...message.toolUses.map((u) => inputText(u.input))]
      : [];
    for (const text of writes) for (const t of distinctiveTokens(text)) {
      const id = owner.get(t);
      if (!id || reacquired.has(t)) continue;
      const set = used.get(id) ?? new Set<string>();
      set.add(t);
      used.set(id, set);
      if (!firstUse.has(id)) firstUse.set(id, step);
    }
    const reads = message.role === 'user'
      ? [message.text, ...(message.toolResults ?? []).map((r) => r.text)]
      : message.toolUses.map((u) => u.text ?? '');
    for (const text of reads) for (const t of distinctiveTokens(text)) if (owner.has(t)) reacquired.add(t);
  });
  return candidates.map((call) => ({
    tool_use_id: call.tool_use_id,
    tool: call.tool,
    chars: call.resultChars,
    bodyTokens: unique.get(call.tool_use_id)?.size ?? 0,
    usedFromMemory: used.get(call.tool_use_id)?.size ?? 0,
    ...(firstUse.has(call.tool_use_id) ? { firstUseAfter: firstUse.get(call.tool_use_id)! } : {}),
  }));
}

export type Decision = { action: 'keep' | 'drop_result' | 'drop_call'; keepResult: number; keepCall: number };

/** Parses the plugin's `decisions:` lines (ui.log, debug log) keyed by tool_use_id. */
export function parseDecisions(text: string): Map<string, Decision> {
  const out = new Map<string, Decision>();
  for (const m of text.matchAll(/t\d+:[^:\s]+:(keep|drop_result|drop_call)\/call=([\d.]+)\/result=([\d.]+)@([A-Za-z0-9_-]+)/g)) {
    out.set(m[4]!, { action: m[1] as Decision['action'], keepCall: Number(m[2]), keepResult: Number(m[3]) });
  }
  return out;
}

export type PolicyScore = { policy: string; removed: number; savedChars: number; regrets: number; regretChars: number };

/** Saving counts the body of a truncated result; a dropped call also loses its head and tail. */
export function scorePolicy(policy: string, outcomes: readonly CandidateOutcome[], removes: (o: CandidateOutcome) => boolean, headChars = 300): PolicyScore {
  let removed = 0, savedChars = 0, regrets = 0, regretChars = 0;
  for (const o of outcomes) {
    if (!removes(o)) continue;
    removed += 1;
    savedChars += Math.max(0, o.chars - headChars * 2 - 250);
    if (o.usedFromMemory > 0) {
      regrets += 1;
      regretChars += o.chars;
    }
  }
  return { policy, removed, savedChars, regrets, regretChars };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  const rowsAt = process.argv.indexOf('--rows');
  if (!path || rowsAt < 0) throw new Error('Usage: npx tsx scripts/evaluate.ts <session.jsonl> --rows N [--decisions <log>]');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const n = Number(process.argv[rowsAt + 1]);
  const prefix = activeMessagesFromRows(lines.slice(0, n));
  const full = activeMessagesFromRows(lines);
  const aligned = prefix.every((m, i) => full[i]?.role === m.role && full[i]?.text === m.text);
  if (!aligned) throw new Error('the cut is not a prefix of the session chain (branches or a boundary in between)');
  const outcomes = evaluateCut(prefix, full.slice(prefix.length));
  const decisionsAt = process.argv.indexOf('--decisions');
  const decisions = decisionsAt >= 0 ? parseDecisions(readFileSync(process.argv[decisionsAt + 1]!, 'utf8')) : undefined;
  const needed = outcomes.filter((o) => o.usedFromMemory > 0);
  const policies: PolicyScore[] = [
    scorePolicy('truncate every candidate', outcomes, () => true),
    scorePolicy('oracle: truncate what was not needed', outcomes, (o) => o.usedFromMemory === 0),
  ];
  if (decisions) {
    policies.push(scorePolicy('jev decisions', outcomes, (o) => (decisions.get(o.tool_use_id)?.action ?? 'keep') !== 'keep'));
    for (const threshold of [0.5, 0.6, 0.7, 0.8]) {
      policies.push(scorePolicy(`jev score < ${threshold}`, outcomes, (o) => (decisions.get(o.tool_use_id)?.keepResult ?? 1) < threshold));
    }
  }
  const scored = decisions ? outcomes.filter((o) => decisions.has(o.tool_use_id)) : [];
  const mean = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : undefined);
  console.log(JSON.stringify({
    messagesAtCut: prefix.length,
    futureMessages: full.length - prefix.length,
    candidates: outcomes.length,
    candidateChars: outcomes.reduce((s, o) => s + o.chars, 0),
    neededLater: needed.length,
    ...(decisions ? {
      matchedDecisions: scored.length,
      meanScoreNeeded: mean(scored.filter((o) => o.usedFromMemory > 0).map((o) => decisions!.get(o.tool_use_id)!.keepResult)),
      meanScoreNotNeeded: mean(scored.filter((o) => o.usedFromMemory === 0).map((o) => decisions!.get(o.tool_use_id)!.keepResult)),
    } : {}),
    policies,
  }, null, 1));
}
