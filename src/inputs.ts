import { COMPACTION_NOTE_MARKER, isPinned } from './state.js';
import type { Message, ToolUse } from './types.js';

/**
 * A call's input is history once the call has run: a Write carries the whole
 * file it wrote, an Edit both strings, a Bash call the script it ran (agents
 * write whole programs into heredocs). On a real session (94aba319, 27.09)
 * old inputs were 170k of the 300k tokens of messages, Bash alone 88k, and
 * no Jev question covers them. So every long field of an old input is paged
 * out deterministically: it keeps its ends and a note naming the call's page,
 * which holds the input whole. Nothing is lost, so no relevance judgment is
 * needed.
 */
const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const INPUT_NOTE_PREFIX = `${COMPACTION_NOTE_MARKER}paged out `;

/** Top-level string fields of any input, and the strings of MultiEdit's edits. */
function fieldsOf(tool: ToolUse): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  for (const [key, value] of Object.entries(tool.input)) {
    if (typeof value === 'string') out.push({ path: key, value });
  }
  if (Array.isArray(tool.input['edits'])) {
    tool.input['edits'].forEach((edit, index) => {
      for (const field of ['old_string', 'new_string']) {
        const value = (edit as Record<string, unknown> | null)?.[field];
        if (typeof value === 'string') out.push({ path: `edits[${index}].${field}`, value });
      }
    });
  }
  return out;
}

function long(value: string, keep: number): boolean {
  return value.length > keep * 2 + 400 && !value.includes(INPUT_NOTE_PREFIX);
}

/**
 * The page of one call: its input and its result as the compaction first saw
 * them, readable, not JSON-escaped. A result shortened by an earlier version
 * still carries that version's note, which names where the original is.
 */
export function callPage(tool: ToolUse, result?: { text: string; isError?: boolean }): string {
  const lines = [`${tool.tool} call, tool_use_id=${tool.tool_use_id}`, '=== input ==='];
  for (const [key, value] of Object.entries(tool.input)) {
    if (typeof value === 'string') lines.push(`--- ${key} ---`, value);
    else lines.push(`--- ${key} (JSON) ---`, JSON.stringify(value, null, 1));
  }
  if (result) lines.push(`=== result (${result.isError ? 'error' : 'ok'}, ${result.text.length} chars) ===`, result.text);
  return lines.join('\n') + '\n';
}

/** Old calls with at least one long input field: what a compaction pages out anyway. */
export function longInputCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
  keepChars: number,
): string[] {
  const out: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || isPinned(index, messages.length, preserveRecentMessages)) return;
    for (const tool of message.toolUses) {
      if (fieldsOf(tool).some((f) => long(f.value, keepChars))) out.push(tool.tool_use_id);
    }
  });
  return out;
}

function shorten(value: string, keep: number, tool: ToolUse, field: string, page: string): string {
  const cut = value.length - keep * 2;
  const done = FILE_WRITERS.has(tool.tool) ? 'applied as written; the file holds the current text' : 'it ran as written';
  const note = `${INPUT_NOTE_PREFIX}${cut} of ${value.length} chars of ${field} of this ${tool.tool} input (${done}); whole call: ${page}]`;
  return [value.slice(0, keep), note, value.slice(-keep)].filter(Boolean).join('\n');
}

export type InputPaging = { messages: Message[]; paged: number; charsSaved: number };

/**
 * Replaces the long fields of old inputs whose page exists. Untouched
 * messages keep their identity; a touched one is a new object.
 */
export function pageLongInputs(
  messages: readonly Message[],
  preserveRecentMessages: number,
  keepChars: number,
  page: (toolUseId: string) => string | undefined,
): InputPaging {
  let paged = 0;
  let charsSaved = 0;
  const out = messages.map((message, index) => {
    if (message.role !== 'assistant' || isPinned(index, messages.length, preserveRecentMessages)) return message;
    let changed = false;
    const toolUses = message.toolUses.map((tool) => {
      const fields = fieldsOf(tool).filter((f) => long(f.value, keepChars));
      const where = fields.length > 0 ? page(tool.tool_use_id) : undefined;
      if (!where) return tool;
      const input: Record<string, unknown> = { ...tool.input };
      for (const { path, value } of fields) {
        const short = shorten(value, keepChars, tool, path, where);
        charsSaved += value.length - short.length;
        const edit = /^edits\[(\d+)\]\.(\w+)$/.exec(path);
        if (edit) {
          const edits = [...(input['edits'] as unknown[])];
          edits[Number(edit[1])] = { ...(edits[Number(edit[1])] as object), [edit[2]!]: short };
          input['edits'] = edits;
        } else input[path] = short;
      }
      paged += 1;
      changed = true;
      return { ...tool, input };
    });
    return changed ? { ...message, toolUses } : message;
  });
  return { messages: out, paged, charsSaved };
}

/** Longest a field of a collapsed call's input stays. */
const COLLAPSED_FIELD_CHARS = 100;

/**
 * The input a collapsed call keeps: every field, each cut to its first 100
 * characters (a Bash description, a path, a pattern survive whole). What the
 * call did stays readable; the whole input is on the page its result names.
 */
export function collapsedInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const flat = value.length > COLLAPSED_FIELD_CHARS ? value.replace(/\s+/g, ' ').trim() : value;
      out[key] = flat.length > COLLAPSED_FIELD_CHARS ? `${flat.slice(0, COLLAPSED_FIELD_CHARS)}…` : flat;
    } else {
      const json = JSON.stringify(value) ?? '';
      out[key] = json.length > COLLAPSED_FIELD_CHARS ? `[${json.length} chars]` : value;
    }
  }
  return out;
}
