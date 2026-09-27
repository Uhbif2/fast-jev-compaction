import { describe, expect, it } from 'vitest';
import { callPage, collapsedInput, longInputCalls, pageLongInputs } from '../src/inputs.js';
import { compact } from '../src/compact.js';
import type { Message } from '../src/types.js';

const big = 'line of the file\n'.repeat(200);
const script = `cd /repo && py -3 - <<'EOF'\n${'print("step")\n'.repeat(150)}EOF`;

function session(): Message[] {
  return [
    { role: 'user', text: 'Write the file.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'Write', input: { file_path: 'a.ts', content: big }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'w1', text: 'ok', isError: false }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: big, new_string: 'x' }] }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'ok', isError: false }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: script, description: 'Run the analysis' }, text: 'step' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: 'step', isError: false }] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
    { role: 'user', text: 'Thanks.', toolUses: [] },
  ];
}

describe('old call inputs', () => {
  it('pages out long fields of any tool only where a page exists, keeping both ends and naming the page', () => {
    const messages = session();
    expect(longInputCalls(messages, 1, 300)).toEqual(['w1', 'e1', 'b1']);
    const out = pageLongInputs(messages, 1, 300, (id) => (id === 'w1' || id === 'b1' ? `P/${id}.call.txt` : undefined));
    expect(out.paged).toBe(2);
    const content = out.messages[1]!.toolUses[0]!.input['content'] as string;
    expect(content.startsWith(big.slice(0, 300))).toBe(true);
    expect(content.endsWith(big.slice(-300))).toBe(true);
    expect(content).toContain('of content of this Write input (applied as written; the file holds the current text); whole call: P/w1.call.txt]');
    const command = out.messages[5]!.toolUses[0]!.input['command'] as string;
    expect(command.startsWith(script.slice(0, 300))).toBe(true);
    expect(command).toContain('of command of this Bash input (it ran as written); whole call: P/b1.call.txt]');
    // Short fields stay as they are.
    expect(out.messages[5]!.toolUses[0]!.input['description']).toBe('Run the analysis');
    expect(out.charsSaved).toBe(big.length - content.length + script.length - command.length);
    expect(out.messages[3]).toBe(messages[3]);
    // Paged once, never again.
    expect(longInputCalls(out.messages, 1, 300)).toEqual(['e1']);
  });

  it('pages MultiEdit strings and leaves recent calls alone', () => {
    const out = pageLongInputs(session(), 1, 300, (id) => `P/${id}.call.txt`);
    const edits = out.messages[3]!.toolUses[0]!.input['edits'] as Array<Record<string, string>>;
    expect(edits[0]!.old_string).toContain('edits[0].old_string of this MultiEdit input');
    expect(edits[0]!.new_string).toBe('x');
    expect(pageLongInputs(session(), 9, 300, (id) => `P/${id}`).paged).toBe(0);
  });

  it('writes a readable page of input and result, and runs inside compact without asking Jev', async () => {
    const tool = session()[1]!.toolUses[0]!;
    const page = callPage(tool, { text: 'ok', isError: false });
    expect(page).toContain(`--- content ---\n${big}`);
    expect(page).toContain('=== result (ok, 2 chars) ===\nok');
    const asker = { ask: async () => { throw new Error('no question expected'); } };
    const result = await compact(session(), asker, { preserveRecentMessages: 1, pages: { page: (id) => `P/${id}` } });
    expect(result.stats.inputsPaged).toBe(3);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  it('keeps short fields, and only the length of a long one a description already names', () => {
    const input = collapsedInput({ command: script, description: 'Run the analysis', timeout: 5, edits: [{ old_string: big }] });
    expect(input['description']).toBe('Run the analysis');
    expect(input['timeout']).toBe(5);
    expect(input['command']).toBe(`[${script.length} chars]`);
    expect(input['edits']).toMatch(/^\[\d+ chars\]$/);
    expect(collapsedInput({ file_path: 'src/a.ts', old_string: big, new_string: 'x' }))
      .toEqual({ file_path: 'src/a.ts', old_string: `[${big.length} chars]`, new_string: 'x' });
  });

  it('keeps the head of a long field when nothing short names the call', () => {
    const input = collapsedInput({ command: script });
    expect((input['command'] as string).length).toBe(101);
    expect(input['command']).toMatch(/^cd \/repo && py -3 - <<'EOF' print\("step"\)/);
  });
});
