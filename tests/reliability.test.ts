import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { compact, compactionCandidates, messageChars, transcriptChars, truncatedResultText } from '../src/compact.js';
import { collectToolCalls, estimateTokens, fitBatchStates, hasSideEffects, isCompactedResult } from '../src/state.js';
import { noulAnswer, parseJevResponse } from '../src/request.js';
import { jevAsker, register } from '../hooks/fast-jev.js';
import { collapseContextListings } from '../src/transcript.js';
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

describe('production context listing provenance', () => {
  it('does not discard isolated prefixes, changed payloads or independent user turns', () => {
    const messages = [
      text('user', 'first question'),
      text('assistant', 'instructions: one answer'),
      text('user', 'second question'),
      text('assistant', 'instructions: one answer'),
      text('assistant', 'instructions: a different answer'),
      text('assistant', 'explanation first\n\ninstructions: quoted within my answer'),
    ];
    const result = collapseContextListings(messages);
    expect(result.dropped).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('recognizes the two-kind same-turn listing replay but keeps changed source text', () => {
    const messages = [
      text('user', 'start'),
      text('assistant', 'skill_listing: injected tools\n\ninstructions: injected rules'),
      text('assistant', 'skill_listing: injected tools\n\ninstructions: injected rules'),
      text('assistant', 'instructions: separate authored guidance'),
      text('user', 'continue'),
      text('assistant', 'instructions: new turn'),
    ];
    const result = collapseContextListings(messages);
    expect(result.dropped).toBe(2);
    expect(result.messages.map(m => m.text)).toEqual([
      'start',
      'skill_listing: injected tools\n\ninstructions: injected rules',
      'instructions: separate authored guidance',
      'continue',
      'instructions: new turn',
    ]);
  });


  it('preserves distinct assistant instructions across user turns during real session.compact', async () => {
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    register(((name: string, one: unknown, two?: unknown) => {
      handlers[name] = (two ?? one) as (...args: any[]) => Promise<any>;
    }) as never, { preserveRecentMessages: 1, compactAssistantText: false, questionVariant: 'keep_or_page' } as never);
    const originalResult = 'synthetic tool result '.repeat(200);
    const messages = [
      { ...text('user', 'First task'), handle: 'user-1' },
      { ...text('assistant', 'instructions: Answer to first task'), handle: 'assistant-1' },
      { ...text('assistant', ''), toolUses: [{ tool_use_id: 'one-tool', tool: 'Bash', input: { command: 'mock' }, text: originalResult }], handle: 'call' },
      { ...text('user', ''), toolResults: [{ tool_use_id: 'one-tool', text: originalResult, isError: false }], handle: 'result' },
      { ...text('user', 'Second task'), handle: 'user-2' },
      { ...text('assistant', 'instructions: Different answer to second task'), handle: 'assistant-2' },
      { ...text('user', 'Please continue'), handle: 'user-3' },
    ];
    const written = new Map<string, string>();
    let jevRequests = 0;
    const $ = {
      store: { get: async () => undefined, set: async () => {} },
      ui: { log: () => {}, toast: () => {} },
      env: { get: async (name: string) => name === 'USERPROFILE' ? 'C:/synthetic-home' : 'synthetic-key' },
      fs: { write: async (path: string, body: string) => { written.set(path, body); }, list: async () => [] },
      settings: { read: async () => ({}) },
      clock: { sleep: async () => {} },
      http: { fetch: async (_url: string, init?: { body?: string }) => {
        jevRequests += 1;
        const questions = Object.keys((JSON.parse(init?.body ?? '{}') as { questions?: object }).questions ?? {});
        return { status: 200, ok: true, text: JSON.stringify({
          answers: Object.fromEntries(questions.map(k => [k, { noul: 0.001 }])),
        }), headers: {} };
      } },
      session: {
        id: async () => 'synthetic-session',
        cwd: async () => 'C:/synthetic-work',
        messages: async () => [],
        usage: async () => ({ context: { tokens: 12_000, percent: 40, window: 50_000, measurementSource: 'synthetic/mock' }, rateLimits: [] }),
        compact: async () => ({ skip: 'unused mock' }),
      },
    };
    const next = async () => { throw Error('built-in summary must never be invoked'); };
    const outcome = await handlers['session.compact']!($, { trigger: 'manual', messages }, next);
    expect(outcome.skip).toBeUndefined();
    const textAfter = outcome.messages.map((m: Message) => m.text).join('\n');
    expect(textAfter).toContain('instructions: Answer to first task');
    expect(textAfter).toContain('instructions: Different answer to second task');
    expect(textAfter).toContain('First task');
    expect(textAfter).toContain('Second task');
    expect(jevRequests).toBeGreaterThan(0);
    expect(written.size).toBeGreaterThan(0);
  });
});

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
  it('uses an inline toolUse outcome when Claude omits a separate tool_result message', async () => {
    const output = 'START\n' + 'historical inline output '.repeat(700) + '\nFINAL STATUS';
    const messages: Message[] = [
      text('user', 'Continue the current task.'),
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool: 'Read', tool_use_id: 'inline-only', input: { file_path: 'old.log' }, text: output }],
      },
      text('user', 'The useful conclusion is already recorded later.'),
    ];
    const calls = collectToolCalls(messages, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_use_id: 'inline-only', resultChars: output.length, resultIndex: 1 });
    expect(transcriptChars(messages)).toBe(messages.reduce((sum, message) => sum + messageChars(message), 0) + output.length);

    const result = await compact(messages, low, { preserveRecentMessages: 0 });
    expect(result.decisions[0]?.action).toBe('drop_call');
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
    expect(result.messages.some((message) => message.toolUses.some((tool) => tool.tool_use_id === 'inline-only'))).toBe(false);
  });

  it('does not double-count an outcome when both inline text and tool_result are present', () => {
    const messages = pair('Read');
    expect(transcriptChars(messages)).toBe(messages.reduce((sum, message) => sum + messageChars(message), 0));
  });

  it('does not mistake plugin source code or another call\'s note for a shortened result', () => {
    expect(isCompactedResult("const marker = '[fast-jev-compaction ';", 'u')).toBe(false);
    expect(isCompactedResult('[fast-jev-compaction truncated ${cut} of ${total} chars of this Read result]', 'u')).toBe(false);
    const note = truncatedResultText('x'.repeat(4000), false, 300, { tool: 'Read', tool_use_id: 'other', sideEffects: false });
    expect(isCompactedResult(note, 'u')).toBe(false);
    expect(isCompactedResult(note, 'other')).toBe(true);
    expect(isCompactedResult('head\n[fast-jev-compaction truncated 1234 chars of this tool result; re-run the tool if needed]', 'u')).toBe(true);
  });

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

describe('TZ-703 synthetic hook replay on real production register', () => {
  function runOfflineReplay() {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/hook-replay.ts'), '--synthetic'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    return { stdout, report: JSON.parse(stdout) as {
      mode: string; passed: boolean; checks: Array<{ id: string; ok: boolean; reason: string }>;
      jevRequests: number; pageCount: number; builtInCalls: number; automaticCalls: number;
    } };
  }

  it('executes synthetic manual and repeated compaction with literal, immutable pages and no Claude fallback', () => {
    const { stdout, report } = runOfflineReplay();
    expect(report.mode).toBe('synthetic/offline');
    expect(report.passed).toBe(true);
    expect(report.checks.map(({ id, ok }) => [id, ok])).toEqual([
      ['S1.manual_real_hook', true],
      ['S1.measured_usage', true],
      ['S2.replayed_tool_payload', true],
      ['S2.call_result_pairing', true],
      ['S2.immutable_page', true],
      ['S2.user_verbatim', true],
      ['S3.autocompact_off', true],
    ]);
    expect(report.jevRequests).toBeGreaterThan(0);
    expect(report.pageCount).toBeGreaterThan(0);
    expect(report.builtInCalls).toBe(0);
    expect(report.automaticCalls).toBe(0);
    // The harness emits sanitized counts/reasons only, not even its fake auth.
    expect(stdout).not.toContain('synthetic-key');
    expect(stdout).not.toContain('HEAD synthetic-result');
    expect(stdout).not.toMatch(/Authorization|apiKey|\.claude\/credentials|historical output/i);
  });

  it('is deterministic across two independent offline executions', () => {
    const first = runOfflineReplay();
    const second = runOfflineReplay();
    expect(second.report).toEqual(first.report);
  });

  it('honours a synthetic Retry-After while sending Jev requests sequentially with no sensitive logging', async () => {
    let attempts = 0;
    let inFlight = 0;
    let peak = 0;
    const delays: number[] = [];
    const logs: string[] = [];
    const metrics = { batches: 0, attempts: 0, retries: 0 };
    const fetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      attempts += 1;
      try {
        if (attempts === 1) return { status: 429, ok: false, text: 'synthetic PRIVATE_SENTINEL', headers: { 'retry-after': '2' } };
        return { status: 200, ok: true, text: '{"answers":{}}', headers: {} };
      } finally {
        inFlight -= 1;
      }
    };
    const ask = jevAsker(fetch, 'synthetic-private-key', 'jev-test',
      (line) => logs.push(line), metrics, async (ms) => { delays.push(ms); }, 15_000);
    expect((await ask.ask({ session: 'synthetic' }, {})).answers).toEqual({});
    expect((await ask.ask({ session: 'synthetic' }, {})).answers).toEqual({});
    expect(peak).toBe(1);
    expect(delays).toEqual([2_000]);
    expect(metrics).toEqual({ batches: 2, attempts: 3, retries: 1 });
    expect(logs.join(' ')).not.toMatch(/PRIVATE_SENTINEL|synthetic-private-key|Authorization/);
  });
});
