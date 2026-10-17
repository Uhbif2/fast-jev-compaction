import { describe, expect, it } from 'vitest';
import { activeMessagesFromRows } from '../scripts/replay.js';
import { dedupeReplayedHistory, engineMessages, type EngineMessage } from '../src/transcript.js';

const message = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string) => ({
  uuid,
  parentUuid: parentUuid ?? undefined,
  type: role,
  isSidechain: false,
  message: { role, content: [{ type: 'text', text }] },
});

describe('transcript branch reconstruction', () => {
  it('retains two independent identical assistant replies in rebuilt model input despite tool replay', () => {
    const page = 'C:/synthetic-pages/replayed/one.call.txt';
    const one = (role: EngineMessage['role'], text: string, handle: string): EngineMessage => ({
      role, text, handle, toolUses: [],
    });
    const call = (handle: string): EngineMessage => ({
      role: 'assistant', text: '', handle,
      toolUses: [{ tool_use_id: 'same-id', tool: 'Bash', input: { command: 'printf test' } }],
    });
    const result = (handle: string): EngineMessage => ({
      role: 'user', text: '', handle, toolUses: [], toolResults: [{
        tool_use_id: 'same-id', text: '[full output: ' + page + ']', isError: false,
      }],
    });
    const repaired = dedupeReplayedHistory([
      one('user', 'Start', 'user-1'),
      one('assistant', 'Confirmed.', 'unique-assistant-1'),
      call('original-call'), result('original-result'),
      call('replayed-call'), result('replayed-result'),
      one('assistant', 'Confirmed.', 'unique-assistant-2'),
    ]);
    const rebuilt = engineMessages(repaired.messages).messages;
    expect(repaired.texts).toBe(0);
    expect(repaired.toolCalls).toBe(1);
    expect(rebuilt.filter((row) => row.role === 'assistant' && row.text === 'Confirmed.'))
      .toHaveLength(2);
    expect(rebuilt.flatMap((row) => row.toolUses).map((tool) => tool.tool_use_id))
      .toEqual(['same-id']);
    expect(rebuilt.flatMap((row) => row.toolResults ?? []).map((row) => row.text))
      .toEqual(['[full output: ' + page + ']']);
  });

  it('uses compact_boundary.parentUuid instead of a later sibling branch', () => {
    const rows: any[] = [
      message('root', null, 'user', 'root'),
      message('kept-assistant', 'root', 'assistant', 'kept assistant'),
      message('kept-user', 'kept-assistant', 'user', 'kept user'),
      message('wrong-assistant', 'root', 'assistant', 'wrong assistant'),
      message('wrong-user', 'wrong-assistant', 'user', 'wrong user'),
      { uuid: 'boundary', parentUuid: 'kept-user', type: 'system', subtype: 'compact_boundary' },
    ];

    expect(activeMessagesFromRows(rows, true).map((m) => m.text))
      .toEqual(['root', 'kept assistant', 'kept user']);
  });

  it('retains one tool/result/page through two synthetic replays, and preserves a repeated new user turn', () => {
    const page = 'C:/synthetic-pages/session/t1.call.txt';
    const fullOutput = 'synthetic tool output '.repeat(300);
    const userText = 'Please preserve my words\n\nincluding paragraphs.';
    const one = (role: EngineMessage['role'], text: string, handle: string): EngineMessage => ({
      role, text, handle, toolUses: [],
    });
    const source: EngineMessage[] = [
      one('user', userText, 'u1'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash',
        input: { command: 'npm test' }, text: fullOutput }], handle: 'a1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{
        tool_use_id: 't1', text: '[full result: ' + page + ']', isError: false,
      }], handle: 'r1' },
      one('assistant', 'skill_listing: original', 'a2'),
      one('assistant', 'instructions: original', 'a3'),
      one('user', 'Follow up', 'u2'),
    ];
    // First compaction is rebuildable and preserves the full immutable page.
    expect(engineMessages(source).messages.flatMap((row) => row.toolResults ?? [])
      .map((row) => row.text)).toContain('[full result: ' + page + ']');
    // Simulate two loader replays whose assistant source handles are known.
    // Different, independently authored handles are never dedupe evidence.
    const originalTurn = source.slice(1, -1);
    const secondInput: EngineMessage[] = [
      source[0]!,
      ...originalTurn,
      ...originalTurn.map((m) => ({ ...m })),
      ...originalTurn.map((m) => ({ ...m })),
      source.at(-1)!,
      one('user', userText, 'u3-new-legitimate-turn'),
      one('assistant', 'skill_listing: original', 'a4-new-legitimate-turn'),
    ];
    const repair = dedupeReplayedHistory(secondInput);
    const second = engineMessages(repair.messages).messages;
    const calls = second.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    const results = second.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(calls).toEqual(['t1']);
    expect(results).toEqual(['t1']);
    expect(second.filter((m) => m.role === 'user' && m.text === userText)).toHaveLength(2);
    expect(second.some((m) => m.text === 'Follow up')).toBe(true);
    const beforeNewTurn = second.slice(0, second.findIndex((m) => m.text === 'Follow up'));
    expect(beforeNewTurn.map((m) => m.text).join('\n').match(/skill_listing: original/g)).toHaveLength(1);
    expect(beforeNewTurn.map((m) => m.text).join('\n').match(/instructions: original/g)).toHaveLength(1);
    expect(second.filter((m) => m.text.includes('skill_listing: original'))).toHaveLength(2);
    expect(second.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 't1')?.text).toContain(page);
    expect(fullOutput).toHaveLength('synthetic tool output '.length * 300);
  });
});
