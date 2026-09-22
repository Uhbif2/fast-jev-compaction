import { describe, expect, it, vi } from 'vitest';
import { compact, compactionCandidates, truncatedResultText } from '../src/compact.js';
import { collectToolCalls, estimateTokens, fitBatchStates, hasSideEffects } from '../src/state.js';
import { noulAnswer, parseJevResponse } from '../src/request.js';
import { jevAsker } from '../hooks/fast-jev.js';
import type { CompactionState, JevAsker, Message } from '../src/types.js';

const text = (role: Message['role'], body: string): Message => ({ role, text: body, toolUses: [] });
function pair(tool = 'Bash'): Message[] {
  const output = 'START\n' + 'historical output '.repeat(700) + '\nFINAL STATUS';
  return [
    text('user', 'Fix the current problem.'),
    { role: 'assistant', text: '', toolUses: [{ tool: tool, tool_use_id: 'target', input: { command: 'build' }, text: output }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'target', text: output }] },
  ];
}
const low: JevAsker = { async ask(_state, questions) {
  return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.001 }])) };
} };

describe('long dialogue coverage', () => {
  it('covers every character of oversized user and assistant turns and stays inside both request limits', async () => {
    const messages = pair('Read');
    messages.push(text('user', 'Требование владельца. '.repeat(1400)));
    messages.push(text('assistant', 'Результат проверки. '.repeat(1800)));
    messages.push(text('user', 'The task is still open. Keep the identifier from the build.'));
    const calls = collectToolCalls(messages, 0);
    const states = fitBatchStates(messages, calls, calls, { maxStateTokens: 4000, goal: '' });
    expect(states.length).toBeGreaterThan(2);
    for (let i = 0; i < messages.length; i++) {
      const original = messages[i]!.text;
      if (!original) continue;
      const covered = new Uint8Array(original.length);
      for (const state of states) {
        expect(state.tokens).toBeLessThanOrEqual(4000);
        for (const entry of state.state.history.filter((entry) => entry.i === i)) {
          const start = entry.span?.start ?? 0;
          const end = entry.span?.end ?? original.length;
          expect(entry.text).toBe(original.slice(start, end));
          covered.fill(1, start, end);
        }
      }
      expect(covered.every(Boolean)).toBe(true);
    }
    const before = JSON.stringify(messages);
    const outcome = await compact(messages, {
      async ask(state, questions) {
        const s = estimateTokens(JSON.stringify(state));
        const sizes = Object.values(questions).map((q) => estimateTokens(JSON.stringify(q)));
        expect(s + Math.max(...sizes)).toBeLessThan(32_000);
        expect(estimateTokens(JSON.stringify({ model: 'jev-latest', state, questions }))).toBeLessThan(64_000);
        return low.ask(state, questions);
      },
    }, { preserveRecentMessages: 0, maxStateTokens: 4000 });
    expect(outcome.messages.filter((m) => m.text).map((m) => m.text))
      .toEqual(messages.filter((m) => m.text).map((m) => m.text));
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('requires low scores across ALL user shards; a requirement in the middle preserves the result', async () => {
    const messages = pair();
    messages.push(text('user', 'старое требование '.repeat(600) + ' CRITICAL_ITEM ' + 'подробность '.repeat(600)));
    messages.push(text('assistant', 'continue '.repeat(1500)));
    let seenCritical = false;
    let requests = 0;
    const output = await compact(messages, {
      async ask(state, questions) {
        requests++;
        const critical = (state as CompactionState).history.some((e) => e.text.includes('CRITICAL_ITEM'));
        seenCritical ||= critical;
        return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: critical ? 0.99 : 0.001 }])) };
      },
    }, { preserveRecentMessages: 0, maxStateTokens: 2500 });
    expect(requests).toBeGreaterThan(2);
    expect(seenCritical).toBe(true);
    expect(output.decisions[0]?.action).toBe('keep');
    expect(output.messages).toEqual(messages);
  });

  it('leaves the entire original unchanged if a later shard fails', async () => {
    const messages = pair();
    messages.push(text('user', 'проверка '.repeat(5000)));
    const before = JSON.stringify(messages);
    let n = 0;
    await expect(compact(messages, {
      async ask(state, questions) {
        if (++n === 2) throw new Error('outage');
        return low.ask(state, questions);
      },
    }, { preserveRecentMessages: 0, maxStateTokens: 4000 })).rejects.toThrow('outage');
    expect(n).toBe(2);
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe('useful candidates and action records', () => {
  it('bounds a pass by complete shard groups and advances past earlier kept candidates', async () => {
    const messages: Message[] = [text('user', 'Keep investigating.')];
    for (let i = 0; i < 12; i++) {
      messages.push(...pair('Read').slice(1).map((m) => ({ ...m,
        toolUses: m.toolUses.map((t) => ({ ...t, tool_use_id: `u${i}` })),
        toolResults: m.toolResults?.map((r) => ({ ...r, tool_use_id: `u${i}` })),
      })));
    }
    const keep: JevAsker = { async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.99 }])) };
    } };
    const options = { preserveRecentMessages: 0, maxRequestTokens: 4000, maxJevRequests: 1 };
    const first = await compact(messages, keep, options);
    expect(first.stats.requests).toBe(1);
    expect(first.stats.deferred).toBeGreaterThan(0);
    expect(first.messages).toEqual(messages);
    const second = await compact(messages, keep, { ...options, recentlyReviewedToolUseIds: first.reviewedToolUseIds });
    expect(second.reviewedToolUseIds.every((id) => !first.reviewedToolUseIds.includes(id))).toBe(true);
    expect(second.messages).toEqual(messages);
  });

  it('retains side-effect records, retains output head and tail, and never asks about them again after truncation', async () => {
    for (const tool of ['Bash', 'Write', 'mcp__service__get_and_delete']) {
      expect(hasSideEffects(tool)).toBe(true);
      const messages = pair(tool);
      const first = await compact(messages, low, { preserveRecentMessages: 0 });
      expect(first.decisions[0]?.action).toBe('drop_result');
      expect(first.messages[1]?.toolUses[0]?.input).toEqual({ command: 'build' });
      const result = first.messages[2]?.toolResults?.[0]?.text ?? '';
      expect(result.startsWith('START')).toBe(true);
      expect(result.endsWith('FINAL STATUS')).toBe(true);
      expect(result).toContain('tool_use_id=target');
      expect(result).toContain('do not re-run');
      const second = await compact(first.messages, { ask: async () => { throw new Error('unnecessary request'); } }, { preserveRecentMessages: 0 });
      expect(second.stats.requests).toBe(0);
      expect(second.messages).toEqual(first.messages);
    }
  });

  it('does not grow an output when the note itself would be longer', () => {
    const original = 'x'.repeat(1000);
    expect(truncatedResultText(original, false, 300, { tool: 'x'.repeat(800), tool_use_id: 'u', sideEffects: true })).toBe(original);
  });

  it('does not treat different Read ranges as duplicates or failed edits as superseding evidence', () => {
    const messages = pair('Read');
    messages[1]!.toolUses[0]!.input = { file_path: 'a.ts', offset: 0, limit: 100 };
    messages.push(...pair('Read').slice(1).map((m) => ({ ...m,
      toolUses: m.toolUses.map((t) => ({ ...t, tool_use_id: 'later', input: { file_path: 'a.ts', offset: 100, limit: 100 } })),
      toolResults: m.toolResults?.map((r) => ({ ...r, tool_use_id: 'later' })),
    })));
    const calls = collectToolCalls(messages, 0);
    expect(calls[0]?.repeatedBy).toBeUndefined();
    expect(compactionCandidates(calls, { truncateHeadChars: 300 })).toHaveLength(2);
  });
});

describe('transport deadline and untrusted responses', () => {
  it('ends a hung request at the deadline, without launching overlapping retries', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(() => new Promise<never>(() => {}));
      const ask = jevAsker(fetch, 'k', 'm', undefined, undefined, undefined, 1000);
      const assertion = expect(ask.ask('s', {})).rejects.toThrow('deadline');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(ask.ask('s', {})).rejects.toThrow('deadline');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not log echoed private content and rejects probabilities outside [0,1]', () => {
    expect(() => parseJevResponse(400, false, 'secret state and authorization')).toThrow('HTTP 400');
    try { parseJevResponse(400, false, 'secret state and authorization'); }
    catch (error) { expect(String(error)).not.toContain('secret'); }
    for (const noul of [-0.1, 1.1, NaN, Infinity]) {
      expect(() => noulAnswer({ t: { noul } }, 't')).toThrow('Invalid Jev answer');
    }
  });
});
