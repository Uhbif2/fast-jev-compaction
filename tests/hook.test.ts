import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  jevEndpoint,
  resolveHookConfig,
  sizeReport,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('separates the plugin estimate from observed usage and the engine-owned Desktop figure', () => {
    const report = sizeReport(400_000, 20_000, 10_000, 1, false);
    expect(report).toContain('plugin estimate');
    expect(report).toContain('last-request observed engine usage');
    expect(report).toContain('first-request input usage pending');
    expect(report).toContain('engine-owned');
    expect(report).toContain('not controlled by the plugin');
  });

  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, ceilingPercent: 0, questionVariant: 'keep_or_page', minReductionRatio: 0, compactAssistantText: false, model: 'jev-latest', provider: 'openrouter' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      ceilingPercent: 0,
      questionVariant: 'keep_or_page',
      minReductionRatio: 0,
      compactAssistantText: false,
      provider: 'openrouter',
    });
  });

  it('picks the Jev endpoint by provider', () => {
    expect(jevEndpoint(resolveHookConfig({}))).toBe('https://openrouter.ai/api/v1/systemone');
    expect(jevEndpoint(resolveHookConfig({ provider: 'typesafe' }))).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpoint(resolveHookConfig({ baseUrl: 'http://x/y' }))).toBe('http://x/y');
    expect(resolveHookConfig({ provider: 'nope' }).provider).toBe('openrouter');
    expect(resolveHookConfig({ openrouterApiKey: 'o', apiKey: 't' })).toMatchObject({ openrouterApiKey: 'o', apiKey: 't' });
  });
});

describe('session message mapping', () => {
  it('keeps the engine objects only for user text and rebuilds every tool and assistant message', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const { messages: out } = toSessionMessages(applyDecisions(messages, decisions, calls, 300));
    expect(out.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, undefined, undefined, 'h-6']);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toEqual({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'tool-1', tool: 'Read', input: { file_path: 'src/a.ts' } }] });
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1400 of 2000 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toEqual({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'tool-2', tool: 'Bash', input: { command: 'npm test' } }] });
    expect(out[4]?.toolResults).toEqual([{ tool_use_id: 'tool-2', text: 'FAIL b.test.ts: expected 2 to be 3', isError: true }]);
    expect(out[5]).toEqual({ role: 'assistant', text: 'Fixing now.', toolUses: [] });
    expect(out[6]).toBe(messages[6]);
  });
});

describe('compactSession', () => {
  it('compacts an inline-only tool outcome when Claude supplies no toolResults entry', async () => {
    const output = 'HEAD\n' + 'old shell output '.repeat(900) + '\nTAIL';
    const messages: SessionMessage[] = [
      message('user', 'Continue.', { handle: 'h-inline-0' }),
      call('inline-bash', 'Bash', { command: 'npm test' }, output),
      message('user', 'The shell output is historical now.', { handle: 'h-inline-2' }),
    ];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 0, compactAssistantText: false, questionVariant: 'relevance' }), apiKey: 'k' };
    const { result: compacted, messages: after } = await compactSession(messages, config, jevFetch(() => 0.1));

    expect(compacted.decisions[0]?.action).toBe('drop_result');
    expect(compacted.stats.charsAfter).toBeLessThan(compacted.stats.charsBefore);
    // The engine gave the outcome only on the call: it comes back as a real result.
    expect(after[1]?.handle).toBeUndefined();
    expect(after[2]?.toolResults?.[0]?.tool_use_id).toBe('inline-bash');
    expect(after[2]?.toolResults?.[0]?.text).toContain('[fast-jev-compaction truncated ');
    expect(after[2]?.toolResults?.[0]?.text.length).toBeLessThan(output.length);
  });

  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, compactAssistantText: false, questionVariant: 'relevance' }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, 'h-6']);
    expect(messages[3]).toEqual({ role: 'assistant', text: 'Fixing now.', toolUses: [] });
    expect(summarize(output)).toBe('Jev checked 1 of 1 candidate(s): 1 call(s) dropped, 0 kept in 1 request(s)');
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10@tool-1 t2:Bash:keep/call=1.00/result=1.00@tool-2');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, compactAssistantText: false, questionVariant: 'relevance' }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 70);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10@tool-1',
      'decisions (2/2): t2:Bash:keep/call=1.00/result=1.00@tool-2',
    ]);
    expect(lines.every((line) => line.length <= 70)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests; the hook then skips', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 400, ok: false, text: 'x' })),
    ).rejects.toThrow(/400/);
  });
});
