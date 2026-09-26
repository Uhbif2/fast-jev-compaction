import { COMPACTION_NOTE_MARKER, isPinned } from './state.js';
import type { Message, ToolUse } from './types.js';

/**
 * File writers carry the whole text they wrote in their input: a Write its
 * content, an Edit both strings. Once written, that text is history (the file
 * on disk holds the current version, and after a hook's compaction the engine
 * makes the model read a file again before editing it). About an eighth of a
 * long agent session is such input and no Jev question covers it, so old
 * writer inputs are paged out deterministically: each long field keeps its
 * ends and a note naming the page that holds the whole input. Nothing is
 * lost, so no relevance judgment is needed.
 */
const WRITER_FIELDS: Record<string, readonly string[]> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  NotebookEdit: ['new_source'],
};

const NOTE_PREFIX = `${COMPACTION_NOTE_MARKER}paged out `;

function fieldsOf(tool: ToolUse): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  for (const field of WRITER_FIELDS[tool.tool] ?? []) {
    const value = tool.input[field];
    if (typeof value === 'string') out.push({ path: field, value });
  }
  if (tool.tool === 'MultiEdit' && Array.isArray(tool.input['edits'])) {
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
  return value.length > keep * 2 + 400 && !value.includes(NOTE_PREFIX);
}

/** The whole input as a page: every field, readable, not JSON-escaped. */
export function writerInputPage(tool: ToolUse): string {
  const lines = [`${tool.tool} input of tool_use_id=${tool.tool_use_id}`];
  for (const [key, value] of Object.entries(tool.input)) {
    if (typeof value === 'string') lines.push(`=== ${key} ===`, value);
    else lines.push(`=== ${key} (JSON) ===`, JSON.stringify(value, null, 1));
  }
  return lines.join('\n') + '\n';
}

export type WriterInputCandidate = { tool_use_id: string; page: string };

/** Old writer calls with at least one long field: what a compaction would page out. */
export function writerInputCandidates(
  messages: readonly Message[],
  preserveRecentMessages: number,
  keepChars: number,
): WriterInputCandidate[] {
  const out: WriterInputCandidate[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || isPinned(index, messages.length, preserveRecentMessages)) return;
    for (const tool of message.toolUses) {
      if (fieldsOf(tool).some((f) => long(f.value, keepChars))) out.push({ tool_use_id: tool.tool_use_id, page: writerInputPage(tool) });
    }
  });
  return out;
}

function shorten(value: string, keep: number, tool: ToolUse, field: string, page: string): string {
  const cut = value.length - keep * 2;
  const note = `${NOTE_PREFIX}${cut} of ${value.length} chars of ${field} of this ${tool.tool} input (it was applied as written); ` +
    `the whole input is in ${page}, tool_use_id=${tool.tool_use_id}; the file itself holds the current text]`;
  return [value.slice(0, keep), note, value.slice(-keep)].filter(Boolean).join('\n');
}

export type WriterPaging = { messages: Message[]; paged: number; charsSaved: number };

/**
 * Replaces the long fields of old writer inputs whose page exists. Untouched
 * messages keep their identity; a touched one is a new object.
 */
export function pageWriterInputs(
  messages: readonly Message[],
  preserveRecentMessages: number,
  keepChars: number,
  page: (toolUseId: string) => string | undefined,
): WriterPaging {
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
