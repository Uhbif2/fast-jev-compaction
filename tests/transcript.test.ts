import { describe, expect, it } from 'vitest';
import {
  dedupeReplayedHistory,
  dropCommandNoise,
  engineMessages,
  QUEUED_PREFIX,
  restoreQueuedPrompts,
  thinkingOnlyRows,
  TurnInProgressError,
  visibleTokens,
  type EngineMessage,
} from '../src/transcript.js';
import { estimateTokens } from '../src/state.js';

function user(text: string, handle?: string): EngineMessage {
  return { role: 'user', text, toolUses: [], ...(handle ? { handle } : {}) };
}

function assistant(text: string, uses: Array<[string, string, string?]> = [], handle = `a-${text}-${uses.map((u) => u[0]).join()}`): EngineMessage {
  return {
    role: 'assistant',
    text,
    toolUses: uses.map(([id, tool, out]) => ({ tool_use_id: id, tool, input: { id }, ...(out !== undefined ? { text: out } : {}) })),
    handle,
  };
}

function results(pairs: Array<[string, string]>, text = '', handle = `r-${pairs.map((p) => p[0]).join()}`): EngineMessage {
  return { role: 'user', text, toolUses: [], toolResults: pairs.map(([id, out]) => ({ tool_use_id: id, text: out, isError: false })), handle };
}

describe('engineMessages', () => {
  it('lets only user text keep the engine handle', () => {
    const input = [user('task', 'u0'), assistant('', [['t1', 'Read', 'x']]), results([['t1', 'x']]), assistant('done'), user('next', 'u4')];
    const { messages } = engineMessages(input);
    expect(messages[0]).toBe(input[0]);
    expect(messages.at(-1)).toBe(input[4]);
    for (const message of messages.slice(1, -1)) expect('handle' in message).toBe(false);
  });

  it('drops thinking-only rows and merges the rows of one response', () => {
    const input = [
      user('task', 'u0'),
      assistant(''), // thinking
      assistant('Reading both.'),
      assistant('', [['t1', 'Read', 'A']]),
      assistant('', [['t2', 'Read', 'B']]),
      results([['t1', 'A']]),
      results([['t2', 'B']]),
      assistant(''), // thinking
      assistant('Both read.'),
    ];
    const out = engineMessages(input);
    expect(out.thinkingRows).toBe(2);
    expect(out.messages).toEqual([
      input[0],
      { role: 'assistant', text: 'Reading both.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { id: 't1' } }, { tool_use_id: 't2', tool: 'Read', input: { id: 't2' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'A', isError: false }, { tool_use_id: 't2', text: 'B', isError: false }] },
      { role: 'assistant', text: 'Both read.', toolUses: [] },
    ]);
  });

  it('turns an outcome given only on the call into a real result', () => {
    const out = engineMessages([user('go', 'u0'), assistant('', [['t1', 'Bash', 'ok']]), assistant('fine')]);
    expect(out.inlineResults).toBe(1);
    expect(out.messages[2]).toEqual({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] });
  });

  it('drops an old call that never got a result but refuses while the last one waits', () => {
    const old = engineMessages([user('go', 'u0'), assistant('', [['t1', 'Bash']]), user('stop that', 'u2'), assistant('ok')]);
    expect(old.orphanCalls).toBe(1);
    expect(old.messages.map((m) => m.text)).toEqual(['go', 'stop that', 'ok']);
    expect(() => engineMessages([user('go', 'u0'), assistant('', [['t1', 'Bash']])])).toThrow(TurnInProgressError);
  });

  it('keeps the text of a tool_result row and orders results before it', () => {
    const out = engineMessages([user('go', 'u0'), assistant('', [['t1', 'Bash', 'ok']]), results([['t1', 'ok']], 'hook note')]);
    expect(out.messages[2]).toEqual({ role: 'user', text: 'hook note', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] });
  });

  it('says which tools a rebuilt ToolSearch had loaded', () => {
    const search: EngineMessage = {
      role: 'assistant', text: '', handle: 'a1',
      toolUses: [{ tool_use_id: 's1', tool: 'ToolSearch', input: { query: 'select:mcp__x__a,mcp__x__b' }, text: '' }],
    };
    const found: EngineMessage = {
      role: 'user', text: '', toolUses: [], handle: 'r1',
      toolResults: [{ tool_use_id: 's1', text: '', isError: false, result: { matches: ['mcp__x__a', 'mcp__x__b'] } }],
    };
    const out = engineMessages([user('go', 'u0'), search, found, assistant('ok')]);
    expect(out.messages[2]?.toolResults?.[0]?.text).toContain('ToolSearch "select:mcp__x__a,mcp__x__b"');
  });
});

describe('dedupeReplayedHistory', () => {
  it('removes what a reload of a damaged transcript doubled, never user text', () => {
    const input = [
      user('task', 'u0'),
      assistant('Looking.'),
      assistant('', [['t1', 'Read', 'A']]),
      results([['t1', 'A']]),
      assistant('Looking.', [], 'copy-1'),
      assistant('', [['t1', 'Read', 'A']], 'copy-2'),
      results([['t1', 'A']], '', 'copy-3'),
      user('task', 'u7'),
      assistant('Looking.'),
    ];
    const out = dedupeReplayedHistory(input);
    expect(out.toolCalls).toBe(1);
    expect(out.texts).toBe(1);
    expect(out.messages).toEqual([input[0], input[1], input[2], input[3], input[7], input[8]]);
  });
});

describe('restoreQueuedPrompts', () => {
  it('puts a mid-turn message back after the call it arrived during', () => {
    const input = [user('task', 'u0'), assistant('', [['t1', 'Bash', 'x']]), results([['t1', 'x']]), assistant('', [['t2', 'Bash', 'y']]), results([['t2', 'y']]), assistant('ok')];
    const queued = [{ text: 'also check the logs', after: 't1', at: 1 }, { text: 'task', at: 2 }];
    const out = restoreQueuedPrompts(input, queued);
    expect(out.restored).toEqual([queued[0]]);
    expect(out.present).toEqual([queued[1]]);
    expect(out.messages[2]?.text).toBe(QUEUED_PREFIX + 'also check the logs');
    expect(out.messages[2]?.handle).toBeUndefined();
    expect(out.messages[4]).toBe(input[4]);
    // Once written as text it is not added again.
    expect(restoreQueuedPrompts(out.messages, queued).restored).toEqual([]);
  });
});

describe('measures', () => {
  it('counts thinking rows and visible tokens', () => {
    const input = [user('task', 'u0'), assistant(''), assistant('', [['t1', 'Read', 'abc']]), results([['t1', 'abc']])];
    expect(thinkingOnlyRows(input)).toBe(1);
    // An inline outcome with a result row is not counted twice.
    expect(visibleTokens(input)).toBe(estimateTokens('task') + estimateTokens('{"id":"t1"}') + estimateTokens('abc'));
  });
});

describe('dropCommandNoise', () => {
  const caveat = '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>';
  it('drops old command output and bare built-in invocations, never typed text', () => {
    const input = [
      user('task', 'u0'),
      user(caveat, 'c1'),
      user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', 'c2'),
      user('<local-command-stderr>Compaction blocked by PreCompact hook</local-command-stderr>', 'c3'),
      user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the API notes</command-args>', 'c4'),
      user('<command-name>/memory-load</command-name>\n<command-message>memory-load</command-message>\n<command-args></command-args>', 'c5'),
      user('please look at <local-command-stdout>x</local-command-stdout> above', 'c6'),
      assistant('ok'),
      user('<local-command-stdout>Compacted</local-command-stdout>', 'c8'),
    ];
    const out = dropCommandNoise(input, 1);
    expect(out.dropped).toBe(3);
    expect(out.messages.map((m) => m.handle)).toEqual(['u0', 'c4', 'c5', 'c6', input[7]!.handle, 'c8']);
  });
});
