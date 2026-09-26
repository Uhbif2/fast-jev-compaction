import { describe, expect, it } from 'vitest';
import { pageWriterInputs, writerInputCandidates, writerInputPage } from '../src/inputs.js';
import { compact } from '../src/compact.js';
import type { Message } from '../src/types.js';

const big = 'line of the file\n'.repeat(200);

function session(): Message[] {
  return [
    { role: 'user', text: 'Write the file.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'Write', input: { file_path: 'a.ts', content: big }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'w1', text: 'ok', isError: false }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: big, new_string: 'x' }] }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
    { role: 'user', text: 'Thanks.', toolUses: [] },
  ];
}

describe('old file-writer inputs', () => {
  it('pages out long fields only where a page exists, keeping both ends and naming the page', () => {
    const messages = session();
    expect(writerInputCandidates(messages, 1, 300).map((c) => c.tool_use_id)).toEqual(['w1', 'e1']);
    const out = pageWriterInputs(messages, 1, 300, (id) => (id === 'w1' ? 'P/w1.input.txt' : undefined));
    expect(out.paged).toBe(1);
    const content = out.messages[1]!.toolUses[0]!.input['content'] as string;
    expect(content.startsWith(big.slice(0, 300))).toBe(true);
    expect(content.endsWith(big.slice(-300))).toBe(true);
    expect(content).toContain('the whole input is in P/w1.input.txt, tool_use_id=w1');
    expect(out.charsSaved).toBe(big.length - content.length);
    expect(out.messages[3]).toBe(messages[3]);
    // Paged once, never again.
    expect(writerInputCandidates(out.messages, 1, 300).map((c) => c.tool_use_id)).toEqual(['e1']);
  });

  it('pages MultiEdit strings and leaves recent calls alone', () => {
    const out = pageWriterInputs(session(), 1, 300, (id) => `P/${id}.input.txt`);
    const edits = out.messages[3]!.toolUses[0]!.input['edits'] as Array<Record<string, string>>;
    expect(edits[0]!.old_string).toContain('edits[0].old_string of this MultiEdit input');
    expect(edits[0]!.new_string).toBe('x');
    expect(pageWriterInputs(session(), 6, 300, (id) => `P/${id}`).paged).toBe(0);
  });

  it('writes a readable page and runs inside compact without asking Jev', async () => {
    expect(writerInputPage(session()[1]!.toolUses[0]!)).toContain(`=== content ===\n${big}`);
    const asker = { ask: async () => { throw new Error('no question expected'); } };
    const result = await compact(session(), asker, { preserveRecentMessages: 1, pages: { inputPage: (id) => `P/${id}` } });
    expect(result.stats.inputsPaged).toBe(2);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });
});
