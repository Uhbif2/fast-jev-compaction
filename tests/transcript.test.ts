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
import { claudeTokens } from '../src/size.js';

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
  it('keeps distinct assistant rows even when they reconstruct the text of an earlier joined row', () => {
    const input = [
      user('Start', 'u-independent'),
      assistant('alpha\n\nbeta', [], 'a-combined'),
      assistant('alpha', [], 'a-independent-1'),
      assistant('beta', [], 'a-independent-2'),
    ];
    const out = dedupeReplayedHistory(input);
    expect(out.messages).toEqual(input);
    expect(out.texts).toBe(0);
  });

  it('does not delete identical legitimate assistant text without replay provenance', () => {
    const input = [
      user('Start', 'u-independent'),
      assistant('Acknowledged.', [], 'a-independent-1'),
      assistant('Acknowledged.', [], 'a-independent-2'),
    ];
    const out = dedupeReplayedHistory(input);
    expect(out.messages).toEqual(input);
    expect(out.texts).toBe(0);
  });

  it('preserves independent equal assistant replies despite an unrelated replayed tool ID', () => {
    const first = assistant('Confirmed.', [], 'unique-assistant-1');
    const second = assistant('Confirmed.', [], 'unique-assistant-2');
    const call = assistant('', [['id1', 'Bash', 'synthetic output']], 'original-call');
    const result = results([['id1', '[full output: C:/synthetic-pages/id1.call.txt]']]);
    const replayCall = assistant('', [['id1', 'Bash', 'synthetic output']], 'replay-call');
    const replayResult = results([['id1', '[full output: C:/synthetic-pages/id1.call.txt]']]);
    const input = [user('Start', 'u1'), first, call, result, replayCall, replayResult, second];
    const out = dedupeReplayedHistory(input);
    expect(out.messages).toEqual([input[0], first, call, result, second]);
    expect(out.toolCalls).toBe(1);
    expect(out.texts).toBe(0);
  });

  it('keeps separate equal assistant replies immediately before a duplicate tool call', () => {
    const first = assistant('Checking.', [], 'statement-first');
    const second = assistant('Checking.', [], 'statement-independent');
    const input = [
      user('Start', 'u1'),
      first,
      assistant('', [['same-id', 'Read', 'output']], 'call-first'),
      results([['same-id', '[full output: C:/synthetic-pages/same.call.txt]']], '', 'result-first'),
      second,
      assistant('', [['same-id', 'Read', 'output']], 'call-replay'),
      results([['same-id', '[full output: C:/synthetic-pages/same.call.txt]']], '', 'result-replay'),
    ];
    const repaired = dedupeReplayedHistory(input);
    expect(repaired.messages.filter((m) => m.role === 'assistant' && m.text === 'Checking.'))
      .toEqual([first, second]);
    expect(repaired.toolCalls).toBe(1);
    expect(repaired.texts).toBe(0);
  });

  it('keeps separate equal assistant replies immediately after a duplicate tool result', () => {
    const first = assistant('Done.', [], 'genuine-first');
    const second = assistant('Done.', [], 'genuine-second');
    const input = [
      user('Start', 'u1'),
      assistant('', [['same-id', 'Bash', 'output']], 'call-first'),
      results([['same-id', '[full output: C:/synthetic-pages/same.call.txt]']], '', 'result-first'),
      first,
      assistant('', [['same-id', 'Bash', 'output']], 'call-replay'),
      results([['same-id', '[full output: C:/synthetic-pages/same.call.txt]']], '', 'result-replay'),
      second,
    ];
    const repaired = dedupeReplayedHistory(input);
    expect(repaired.messages.filter((m) => m.role === 'assistant' && m.text === 'Done.'))
      .toEqual([first, second]);
    expect(engineMessages(repaired.messages).messages
      .filter((m) => m.role === 'assistant' && m.text.includes('Done.'))
      .map((m) => m.text)).toEqual(['Done.\n\nDone.']);
    expect(repaired.toolCalls).toBe(1);
    expect(repaired.texts).toBe(0);
  });

  it('does not erase aligned whole-text or split replies with different source identities', () => {
    const sourceText = assistant('alpha\n\nbeta', [], 'source-whole');
    const sourceA = assistant('alpha', [], 'source-alpha');
    const sourceB = assistant('beta', [], 'source-beta');
    const independentText = assistant('alpha\n\nbeta', [], 'independent-whole');
    const independentA = assistant('alpha', [], 'independent-alpha');
    const independentB = assistant('beta', [], 'independent-beta');
    const input = [
      user('Start', 'u1'),
      assistant('', [['t1', 'Read', 'x']], 'call-original'),
      results([['t1', '[full output: C:/synthetic-pages/t1.call.txt]']], '', 'result-original'),
      sourceText, sourceA, sourceB,
      assistant('', [['t1', 'Read', 'x']], 'call-replayed'),
      results([['t1', '[full output: C:/synthetic-pages/t1.call.txt]']], '', 'result-replayed'),
      independentText, independentA, independentB,
    ];
    const repaired = dedupeReplayedHistory(input);
    expect(repaired.messages).toEqual([
      input[0], input[1], input[2],
      sourceText, sourceA, sourceB,
      independentText, independentA, independentB,
    ]);
    expect(repaired.toolCalls).toBe(1);
    expect(repaired.texts).toBe(0);
  });

  it('preserves identical aligned replies without any source handle', () => {
    const first = { ...assistant('Ready.', [], 'old-handle'), handle: undefined };
    const second = { ...assistant('Ready.', [], 'new-handle'), handle: undefined };
    const input = [
      user('Start', 'u1'),
      assistant('', [['id', 'Read', 'data']], 'call-original'),
      results([['id', '[full output: C:/synthetic-pages/id.call.txt]']]),
      first,
      assistant('', [['id', 'Read', 'data']], 'call-replayed'),
      results([['id', '[full output: C:/synthetic-pages/id.call.txt]']]),
      second,
    ];
    const repaired = dedupeReplayedHistory(input);
    expect(repaired.messages.filter((m) => m.role === 'assistant' && m.text === 'Ready.'))
      .toEqual([first, second]);
    expect(repaired.texts).toBe(0);
  });

  it('preserves independently authored joined and split assistant prose around a tool replay', () => {
    const original = assistant('Confirmed.\n\nReady.', [], 'unique-whole-1');
    const following = assistant('Confirmed.\n\nReady.', [], 'unique-whole-2');
    const firstFragment = assistant('Confirmed.', [], 'unique-fragment-1');
    const secondFragment = assistant('Ready.', [], 'unique-fragment-2');
    const call = assistant('', [['id1', 'Bash', 'synthetic output']], 'original-call');
    const result = results([['id1', '[full output: C:/synthetic-pages/id1.call.txt]']]);
    const replayCall = assistant('', [['id1', 'Bash', 'synthetic output']], 'replay-call');
    const replayResult = results([['id1', '[full output: C:/synthetic-pages/id1.call.txt]']]);
    const input = [
      user('Start', 'u1'), original, call, result, replayCall, replayResult,
      following, firstFragment, secondFragment,
    ];
    const out = dedupeReplayedHistory(input);
    expect(out.messages).toEqual([
      input[0], original, call, result, following, firstFragment, secondFragment,
    ]);
    expect(out.toolCalls).toBe(1);
    expect(out.texts).toBe(0);
  });

  it('does not treat unrelated duplicated tool IDs as provenance for unique assistant fragments', () => {
    const call = assistant('', [['same-tool', 'Bash', 'output']], 'first-call');
    const seen = results([['same-tool', '[full output: C:/synthetic-pages/same.call.txt]']]);
    const duplicateCall = assistant('', [['same-tool', 'Bash', 'output']], 'replayed-call');
    const duplicateResult = results([['same-tool', '[full output: C:/synthetic-pages/same.call.txt]']]);
    const joined = assistant('alpha\n\nbeta', [], 'unique-joined');
    const first = assistant('alpha', [], 'unique-first');
    const second = assistant('beta', [], 'unique-second');
    const input = [user('Start', 'u1'), call, seen, duplicateCall, duplicateResult, joined, first, second];
    const out = dedupeReplayedHistory(input);
    expect(out.messages).toEqual([input[0], call, seen, joined, first, second]);
    expect(out.toolCalls).toBe(1);
    expect(out.texts).toBe(0);
  });

  it('removes what a reload of a damaged transcript doubled, never user text', () => {
    const original = assistant('Looking.');
    const input = [
      user('task', 'u0'),
      original,
      assistant('', [['t1', 'Read', 'A']]),
      results([['t1', 'A']]),
      assistant('Looking.', [], original.handle),
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

  it('recognizes a replay of complete assistant rows previously joined, without splitting original prose', () => {
    const joined = assistant('skill_listing: old tools\n\ninstructions: old rules');
    const call = assistant('', [['replayed-tool', 'Bash', 'synthetic output']], 'call-original');
    const result = results([['replayed-tool', '[full output: C:/synthetic-pages/one.call.txt]']]);
    const replayedCall = assistant('', [['replayed-tool', 'Bash', 'synthetic output']], 'call-replayed');
    const replayedResult = results([['replayed-tool', '[full output: C:/synthetic-pages/one.call.txt]']]);
    const originalUser = user('Keep these literal paragraphs:\n\nskill_listing: old tools', 'user-original');
    const newUser = user('Keep these literal paragraphs:\n\nskill_listing: old tools', 'user-new-turn');
    const repeated = [
      originalUser,
      call,
      result,
      joined,
      replayedCall,
      replayedResult,
      assistant('skill_listing: old tools\n\ninstructions: old rules', [], joined.handle),
      assistant('skill_listing: old tools', [], joined.handle),
      assistant('instructions: old rules', [], joined.handle),
      newUser,
      assistant('skill_listing: old tools', [], 'legitimate-next-turn'),
      assistant('a normal paragraph\n\nskill_listing: old tools\n\na final paragraph'),
    ];
    const out = dedupeReplayedHistory(repeated);
    expect(out.messages).toEqual([originalUser, call, result, joined, newUser, repeated[10], repeated[11]]);
    expect(out.texts).toBe(3);
    expect(out.toolCalls).toBe(1);
    expect(out.messages.filter((message) => message.role === 'user' && message.text.trim().length > 0))
      .toEqual([originalUser, newUser]);
    expect(out.messages[6]?.text).toContain('a normal paragraph\n\nskill_listing: old tools\n\na final paragraph');
  });

  it('does not drop an isolated matching paragraph or skip over a new tool call', () => {
    const joined = assistant('first\n\nsecond');
    const isolated = assistant('first');
    const call = assistant('', [['new-call', 'Bash', 'actual result']]);
    const final = assistant('second');
    const input = [user('question'), joined, isolated, call, results([['new-call', 'actual result']]), final];
    expect(dedupeReplayedHistory(input).messages).toEqual(input);
  });

  it('preserves a repeated tool ID in a new user turn and maps each page to its call', () => {
    const call = (handle: string, file: string) => ({
      ...assistant('', [['same-id', 'Read', file]], handle),
      toolUses: [{ tool_use_id: 'same-id', tool: 'Read', input: { file_path: file } }],
    });
    const first = results([['same-id', '[full output: C:/pages/one.txt]']]);
    const second = results([['same-id', '[full output: C:/pages/two.txt]']]);
    const original = user('repeat', 'user-first');
    const next = user('repeat', 'user-next');
    const input = [original, call('call-first', 'one.txt'), first, next, call('call-next', 'two.txt'), second];
    const repair = dedupeReplayedHistory(input);
    expect(repair.messages).toEqual(input);
    expect(repair.toolCalls).toBe(0);
    const rebuilt = engineMessages(repair.messages).messages;
    expect(rebuilt.filter((m) => m.role === 'user' && m.text === 'repeat')).toEqual([original, next]);
    expect(rebuilt.flatMap((m) => m.toolUses.map((u) => u.input['file_path']))).toEqual(['one.txt', 'two.txt']);
    expect(rebuilt.flatMap((m) => (m.toolResults ?? []).map((r) => r.text)))
      .toEqual(['[full output: C:/pages/one.txt]', '[full output: C:/pages/two.txt]']);
  });

  it('keeps equal tool payloads with different IDs and their distinct page references', () => {
    const input = [
      user('run this', 'first-user'),
      assistant('', [['first-id', 'Bash', 'result one']]),
      results([['first-id', '[full output: C:/synthetic-pages/first-id.call.txt]']]),
      user('run it again', 'second-user'),
      assistant('', [['second-id', 'Bash', 'result two']]),
      results([['second-id', '[full output: C:/synthetic-pages/second-id.call.txt]']]),
    ];
    const repaired = dedupeReplayedHistory(input);
    expect(repaired.toolCalls).toBe(0);
    expect(repaired.messages).toEqual(input);
    expect(engineMessages(repaired.messages).messages.flatMap((message) =>
      message.toolResults ?? []).map((result) => result.text)).toEqual([
      '[full output: C:/synthetic-pages/first-id.call.txt]',
      '[full output: C:/synthetic-pages/second-id.call.txt]',
    ]);
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
    expect(visibleTokens(input)).toBe(claudeTokens('task') + claudeTokens('{"id":"t1"}') + claudeTokens('abc'));
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
