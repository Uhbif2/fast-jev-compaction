import { describe, expect, it } from 'vitest';
import { collectToolCalls, fitBatchStates, type Message } from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function withTarget(assistantTexts: string[]): Message[] {
  const messages: Message[] = [
    message('user', 'Keep working on the same task.'),
    message('assistant', '', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { p: 1 }, text: 'x' }] }),
    message('user', '', { toolResults: [{ tool_use_id: 'a', text: 'x' }] }),
  ];
  for (const text of assistantTexts) messages.push(message('assistant', text));
  return messages;
}

describe('shard planner limits', () => {
  it('never produces a shard over the limit, whatever the limit (final shard label is longer than the planning one)', () => {
    const texts = Array.from({ length: 30 }, (_, i) => `assistant-${i} ` + 'detail '.repeat(40 + ((i * 37) % 90)));
    const messages = withTarget(texts);
    const calls = collectToolCalls(messages, 0, 50);
    const failures: string[] = [];
    for (let limit = 2200; limit <= 3400; limit += 3) {
      try {
        const states = fitBatchStates(messages, calls, [calls[0]!], { maxStateTokens: limit, goal: '' }, limit);
        for (const state of states) if (state.tokens > limit) failures.push(`${limit}: ${state.tokens}`);
      } catch (error) {
        failures.push(`${limit}: ${(error as Error).message.slice(0, 60)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('fits one large assistant message that only fits without the optional indexes', () => {
    const texts = Array.from({ length: 40 }, (_, i) => `short note ${i} about progress and findings in module ${i}`);
    texts.push('word '.repeat(2350));
    texts.push('recent 0', 'recent 1', 'recent 2');
    const messages = withTarget(texts);
    const calls = collectToolCalls(messages, 0, 50);
    for (const limit of [4200, 4300, 4400]) {
      const states = fitBatchStates(messages, calls, [calls[0]!], { maxStateTokens: limit, goal: '' }, limit);
      expect(states.every((state) => state.tokens <= limit)).toBe(true);
      const seen = states.flatMap((state) => state.state.history.map((entry) => entry.text));
      expect(seen).toContain('word '.repeat(2350));
    }
  });
});
