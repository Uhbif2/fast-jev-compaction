import { claudeTokens } from './size.js';
import type { Message, ToolResult, ToolUse } from './types.js';

/**
 * How Claude Code (2.1.280) writes a compaction a hook hands back, and why
 * this module exists. Checked against the engine bundle and transcripts of
 * 25–26.09.2026.
 *
 * A message kept with its `handle` is written as the engine's own entries
 * under a fresh uuid, but two fields are copied unchanged:
 * - an assistant entry keeps its API `message.id`;
 * - a tool_result entry keeps `sourceToolAssistantUUID`, and the writer makes
 *   that its `parentUuid` whenever the uuid exists in the file, which is
 *   always true: it is the original assistant entry before the boundary.
 * On the next load of the session (Desktop reopening it, a new runtime) the
 * chain walks from such a result back into the uncompacted history, and the
 * loader's parallel-result recovery pulls in every entry of the file that
 * shares a `message.id` with one in the chain. The compaction is undone and
 * old turns come back twice, three times after a second compaction.
 *
 * A message without a handle is built from `role`, `text` and tool blocks:
 * a new synthetic id, no source link, a linear parent. So every assistant
 * message and every tool_result message goes back rebuilt. Only user text
 * keeps its handle; with it go the attachments the engine files under it
 * (CLAUDE.md, images of the prompt). What a rebuilt message does not carry:
 * thinking blocks (the engine drops them after a compaction anyway, reason
 * `prefix_mismatch`), images inside tool results, `tool_reference` blocks of
 * ToolSearch (replaced by a note) and attachments filed under tool rows
 * (reminders, file-change notices, mid-turn user messages, which the hook
 * restores itself).
 */

export type EngineToolUse = ToolUse & { result?: unknown };
export type EngineToolResult = ToolResult & { result?: unknown };

/** A message as `session.compact` receives it; `handle` marks the engine's own. */
export type EngineMessage = Omit<Message, 'toolUses' | 'toolResults'> & {
  toolUses: EngineToolUse[];
  toolResults?: EngineToolResult[];
  handle?: string;
};

export type RebuiltMessage = {
  role: Message['role'];
  text: string;
  toolUses: Array<{ tool_use_id: string; tool: string; input: Record<string, unknown> }>;
  toolResults?: Array<{ tool_use_id: string; text: string; isError: boolean }>;
};

export class TurnInProgressError extends Error {
  constructor(id: string) {
    super(`tool call ${id} has no result yet: a turn is in progress`);
  }
}

function isToolResultRow(message: Message): boolean {
  return message.role === 'user' && (message.toolResults?.length ?? 0) > 0;
}

/** Messages the engine may keep as its own: user text, never a tool row. */
function keepsHandle(message: EngineMessage): boolean {
  return message.role === 'user' && !isToolResultRow(message) && message.handle !== undefined;
}

export type Dedupe<T> = { messages: T[]; toolCalls: number; texts: number };

/** Consecutive assistant text rows adjacent to an anchored tool call/result. */
function adjacentAssistantText<T extends Message>(
  messages: readonly T[], anchor: number, direction: -1 | 1,
): number[] {
  const indices: number[] = [];
  for (let index = anchor + direction; index >= 0 && index < messages.length; index += direction) {
    const row = messages[index]!;
    if (row.role !== 'assistant' || row.toolUses.length > 0 || row.text.trim().length === 0) break;
    if (direction === -1) indices.unshift(index);
    else indices.push(index);
  }
  return indices;
}

/**
 * A duplicate tool ID proves only the tool was replayed, NOT that every equal
 * assistant statement in the user turn was replayed. Text is removable only
 * when a complete matching response is aligned next to that repeated call or
 * result AND all its parts retain the original assistant source handle.
 * Rebuilt responses without a stable handle are ambiguous and stay intact,
 * even when their text is identical to older prose.
 */
function replayedAssistantTextIndices<T extends Message>(messages: readonly T[]): Set<number> {
  const repeated = new Set<number>();
  let firstUse = new Map<string, number>();
  let firstResult = new Map<string, number>();

  function matchAnchoredRuns(original: number[], duplicate: number[]): void {
    if (!original.length || !duplicate.length) return;
    const originalTexts = original.map((index) => ({
      text: messages[index]!.text.trim(),
      // A text row can only be attributed to a replay when the source
      // identity is stable. Equal prose next to a repeated tool ID is not
      // enough: independently authored replies may occupy that position.
      handle: (messages[index] as Message & { handle?: unknown }).handle,
    }));
    let duplicateCursor = 0;
    // A joined row may appear twice on reload: once joined and once as its
    // original consecutive fragments. Consume only whole, aligned responses.
    for (const expected of originalTexts) {
      while (duplicateCursor < duplicate.length) {
        let joined = '';
        let found = false;
        for (let next = duplicateCursor; next < duplicate.length; next += 1) {
          joined = joinText(joined, messages[duplicate[next]!]!.text).trim();
          if (joined === expected.text) {
            // An assistant message has provenance only if all its replayed
            // pieces carry the SAME non-empty engine source handle.
            if (typeof expected.handle === 'string' && expected.handle.length > 0 &&
                duplicate.slice(duplicateCursor, next + 1).every((i) =>
                  (messages[i] as Message & { handle?: unknown }).handle === expected.handle)) {
              for (let i = duplicateCursor; i <= next; i += 1) repeated.add(duplicate[i]!);
            }
            duplicateCursor = next + 1;
            found = true;
            break;
          }
          if (!expected.text.startsWith(`${joined}\n\n`)) break;
        }
        if (!found) return;
        // Another exact copy of the same complete response can immediately
        // follow the first one, reconstructed from individual original rows.
        if (duplicateCursor >= duplicate.length ||
            !expected.text.startsWith(messages[duplicate[duplicateCursor]!]!.text.trim())) break;
      }
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user' && !isToolResultRow(message) && message.text.trim().length > 0) {
      firstUse = new Map();
      firstResult = new Map();
    }
    if (message.role === 'assistant') {
      for (const call of message.toolUses) {
        const initial = firstUse.get(call.tool_use_id);
        if (initial === undefined) firstUse.set(call.tool_use_id, index);
        else matchAnchoredRuns(
          adjacentAssistantText(messages, initial, -1),
          adjacentAssistantText(messages, index, -1),
        );
      }
    }
    for (const result of message.toolResults ?? []) {
      const initial = firstResult.get(result.tool_use_id);
      if (initial === undefined) firstResult.set(result.tool_use_id, index);
      else matchAnchoredRuns(
        adjacentAssistantText(messages, initial, 1),
        adjacentAssistantText(messages, index, 1),
      );
    }
  }
  return repeated;
}

/**
 * Removes what a reload of a damaged transcript doubled: a repeated tool_use
 * id and its repeated result (the first occurrence stays). Tool ID equality
 * alone does not prove that an unrelated assistant message was duplicated;
 * only anchored matching text sequences may be removed. User text is untouched.
 */
export function dedupeReplayedHistory<T extends Message>(messages: readonly T[]): Dedupe<T> {
  const replayedTexts = replayedAssistantTextIndices(messages);
  const uses = new Set<string>();
  const results = new Set<string>();
  let toolCalls = 0;
  let texts = 0;
  const out: T[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    // Tool IDs only identify calls within a user turn. A new, independently
    // submitted user message may legitimately reuse an earlier tool ID.
    if (message.role === 'user' && !isToolResultRow(message) && message.text.trim().length > 0) {
      uses.clear();
      results.clear();
    }
    if (message.role === 'assistant') {
      const toolUses = message.toolUses.filter((tool) => !uses.has(tool.tool_use_id));
      for (const tool of toolUses) uses.add(tool.tool_use_id);
      toolCalls += message.toolUses.length - toolUses.length;
      const repeated = replayedTexts.has(index);
      if (repeated) texts += 1;
      if (toolUses.length === message.toolUses.length && !repeated) {
        out.push(message);
        continue;
      }
      if (toolUses.length === 0 && (repeated || message.text.trim().length === 0)) continue;
      out.push({ ...message, text: repeated ? '' : message.text, toolUses, handle: undefined });
      continue;
    }
    const own = message.toolResults ?? [];
    const kept = own.filter((result) => !results.has(result.tool_use_id));
    for (const result of kept) results.add(result.tool_use_id);
    if (kept.length === own.length) {
      out.push(message);
      continue;
    }
    if (kept.length === 0 && message.text.trim().length === 0) continue;
    out.push({ ...message, toolResults: kept, handle: undefined });
  }
  return { messages: out, toolCalls, texts };
}

/**
 * Context listings the engine re-injects on every compaction (skill listing,
 * instructions, agent listing, CLAUDE.md memory) are not conversation: each
 * replay appends one more copy, which the owner sees as old messages doubling.
 * They are recognised by their kind prefix, never by text equality, so equal
 * ordinary replies stay untouched. Only the latest copy of each kind is kept.
 */
const CONTEXT_LISTING = /^(skill_listing|instructions|agent_listing|nested_memory|claude_md)\s*:/;

export function collapseContextListings<T extends Message>(messages: readonly T[]): { messages: T[]; dropped: number } {
  const split = messages.map((m) => (m.role === 'assistant' ? m.text.split(/\n{2,}/) : null));
  const last = new Map<string, [number, number]>();
  split.forEach((parts, i) => parts?.forEach((part, j) => {
    const kind = CONTEXT_LISTING.exec(part.trim())?.[1];
    if (kind) last.set(kind, [i, j]);
  }));
  let dropped = 0;
  const out: T[] = [];
  messages.forEach((message, i) => {
    const parts = split[i];
    if (!parts) { out.push(message); return; }
    const kept = parts.filter((part, j) => {
      const kind = CONTEXT_LISTING.exec(part.trim())?.[1];
      if (!kind) return true;
      const [li, lj] = last.get(kind)!;
      if (li === i && lj === j) return true;
      dropped += 1;
      return false;
    });
    if (kept.length === parts.length) { out.push(message); return; }
    const text = kept.join('\n\n');
    if (!text.trim() && message.toolUses.length === 0) return;
    out.push({ ...message, text });
  });
  return { messages: out, dropped };
}

/** Local commands whose invocation and output carry nothing for the model once they are old. */
const NOISE_COMMANDS = new Set([
  '/compact', '/reload-plugins', '/context', '/cost', '/usage', '/model', '/effort', '/fast', '/status',
  '/config', '/permissions', '/doctor', '/hooks', '/plugins', '/plugin', '/mcp', '/help', '/clear',
]);
const OUTPUT_BLOCK = /<(local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const INVOCATION = /^\s*<command-name>(\/[\w:-]+)<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>\s*$/;

/**
 * Engine text that is not the user's: the caveat, stdout and stderr of local
 * commands, and the bare invocation of a built-in one (`/compact` without
 * instructions). An old one only misleads: a "compaction blocked" from an
 * hour ago reads as the verdict on the compaction just made.
 */
export function isCommandNoise(message: Message): boolean {
  if (message.role !== 'user' || isToolResultRow(message)) return false;
  const text = message.text.trim();
  if (!text) return false;
  if (text.replace(OUTPUT_BLOCK, '').trim() === '') return true;
  const invocation = INVOCATION.exec(text);
  return !!invocation && NOISE_COMMANDS.has(invocation[1]!) && invocation[2]!.trim() === '';
}

/** Drops old command noise; the newest messages stay as they are. */
export function dropCommandNoise<T extends Message>(messages: readonly T[], preserveRecentMessages: number): { messages: T[]; dropped: number } {
  const keepFrom = messages.length - Math.max(0, preserveRecentMessages);
  const out = messages.filter((message, index) => index >= keepFrom || !isCommandNoise(message));
  return { messages: out, dropped: messages.length - out.length };
}

/** Assistant rows with no text and no tool call: thinking the engine keeps as a row of its own. */
export function thinkingOnlyRows(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === 'assistant' && m.text.trim().length === 0 && m.toolUses.length === 0).length;
}

function toolSearchNote(tool: EngineToolUse, result: EngineToolResult | undefined): string | undefined {
  if (tool.tool !== 'ToolSearch') return undefined;
  const record = result?.result as { matches?: unknown } | undefined;
  let names = Array.isArray(record?.matches) ? record.matches.filter((n): n is string => typeof n === 'string') : [];
  if (names.length === 0) {
    const query = typeof tool.input['query'] === 'string' ? tool.input['query'] : '';
    names = query.startsWith('select:') ? query.slice(7).split(',').map((n) => n.trim()).filter(Boolean) : [];
  }
  if (names.length === 0) return undefined;
  return `[fast-jev-compaction: this search had loaded the tools ${names.join(', ')}; loaded definitions may not survive compaction. If one of them is needed, load it again with ToolSearch "select:${names.join(',')}" first.]`;
}

export type EngineRebuild = {
  messages: Array<EngineMessage | RebuiltMessage>;
  /** Thinking-only assistant rows left out. */
  thinkingRows: number;
  /** tool_use blocks without any result, left out (not the in-flight one). */
  orphanCalls: number;
  /** Results built from an inline outcome the engine gave only on the tool_use. */
  inlineResults: number;
};

type Carrier = RebuiltMessage & { toolResults: NonNullable<RebuiltMessage['toolResults']> };
type Assistant = RebuiltMessage & { engineUses: EngineToolUse[] };
type Slot = { own: EngineMessage } | { assistant: Assistant } | { carrier: Carrier } | { text: RebuiltMessage };

/**
 * Turns the library's output into what the engine can write safely: user
 * text keeps its handle, every assistant and tool_result message is rebuilt.
 * Adjacent assistant rows merge into one message, as do adjacent tool_result
 * rows, and every tool call is followed by exactly its results: from the
 * result rows, else from the inline outcome on the call. A call with no
 * result anywhere is dropped, unless nothing but its results can follow it:
 * then the turn is still running and the compaction is refused.
 */
export function engineMessages(output: readonly EngineMessage[]): EngineRebuild {
  // Tool IDs can recur in a later user turn. Preserve result occurrence order
  // rather than binding every call with an ID to the first result in history.
  const resultsById = new Map<string, EngineToolResult[]>();
  for (const message of output) for (const result of message.toolResults ?? []) {
    const occurrences = resultsById.get(result.tool_use_id) ?? [];
    occurrences.push(result);
    resultsById.set(result.tool_use_id, occurrences);
  }
  const resultCursor = new Map<string, number>();
  let thinkingRows = 0;
  const slots: Slot[] = [];
  for (const message of output) {
    const last = slots.at(-1);
    if (keepsHandle(message)) {
      slots.push({ own: message });
    } else if (message.role === 'assistant') {
      if (message.text.trim().length === 0 && message.toolUses.length === 0) {
        thinkingRows += 1;
        continue;
      }
      const toolUses = message.toolUses.map((tool) => ({ tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input }));
      if (last && 'assistant' in last) {
        last.assistant.text = joinText(last.assistant.text, message.text);
        last.assistant.toolUses.push(...toolUses);
        last.assistant.engineUses.push(...message.toolUses);
      } else {
        slots.push({ assistant: { role: 'assistant', text: message.text, toolUses, engineUses: [...message.toolUses] } });
      }
    } else if (isToolResultRow(message)) {
      // Results are re-derived below; only the row's own text travels here.
      if (last && 'carrier' in last) last.carrier.text = joinText(last.carrier.text, message.text);
      else slots.push({ carrier: { role: 'user', text: message.text, toolUses: [], toolResults: [] } });
    } else if (message.text.trim().length > 0) {
      slots.push({ text: { role: 'user', text: message.text, toolUses: [] } });
    }
  }

  let orphanCalls = 0;
  let inlineResults = 0;
  const messages: Array<EngineMessage | RebuiltMessage> = [];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    if ('own' in slot) {
      messages.push(slot.own);
      continue;
    }
    if ('text' in slot) {
      messages.push(slot.text);
      continue;
    }
    if ('carrier' in slot) {
      // Not right after calls: its results are orphans, its text stays.
      if (slot.carrier.text.trim().length > 0) messages.push({ role: 'user', text: slot.carrier.text, toolUses: [] });
      continue;
    }
    const { engineUses, ...assistant } = slot.assistant;
    const next = slots[index + 1];
    const carrier: Carrier = { role: 'user', text: '', toolUses: [], toolResults: [] };
    if (next && 'carrier' in next) {
      carrier.text = next.carrier.text;
      index += 1;
    }
    const lastCall = slots.slice(index + 1).every((s) => 'carrier' in s);
    const keptUses: RebuiltMessage['toolUses'] = [];
    for (const [position, tool] of assistant.toolUses.entries()) {
      const engineUse = engineUses[position];
      const offset = resultCursor.get(tool.tool_use_id) ?? 0;
      const explicit = resultsById.get(tool.tool_use_id)?.[offset];
      if (explicit) resultCursor.set(tool.tool_use_id, offset + 1);
      let result: { tool_use_id: string; text: string; isError: boolean } | undefined;
      if (explicit) result = { tool_use_id: explicit.tool_use_id, text: explicit.text, isError: explicit.isError ?? false };
      else if (engineUse?.text !== undefined) {
        result = { tool_use_id: tool.tool_use_id, text: engineUse.text, isError: engineUse.isError ?? false };
        inlineResults += 1;
      }
      if (!result) {
        if (lastCall) throw new TurnInProgressError(tool.tool_use_id);
        orphanCalls += 1;
        continue;
      }
      const note = engineUse ? toolSearchNote(engineUse, explicit) : undefined;
      if (note) result.text = joinText(result.text, note);
      keptUses.push(tool);
      carrier.toolResults.push(result);
    }
    assistant.toolUses = keptUses;
    if (assistant.text.trim().length > 0 || keptUses.length > 0) messages.push(assistant);
    if (carrier.toolResults.length > 0) messages.push(carrier);
    else if (carrier.text.trim().length > 0) messages.push({ role: 'user', text: carrier.text, toolUses: [] });
  }
  return { messages, thinkingRows, orphanCalls, inlineResults };
}

function joinText(a: string, b: string): string {
  if (a.trim().length === 0) return b;
  if (b.trim().length === 0) return a;
  return `${a}\n\n${b}`;
}

/**
 * Claude tokens of what a message list shows the model: text, tool inputs
 * and results (an inline outcome only where no result row exists). It misses
 * the system prompt, tool schemas, attachments and thinking, so it measures a
 * change, not the context itself.
 */
export function visibleTokens(messages: readonly Message[]): number {
  const explicit = new Set(messages.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id));
  let tokens = 0;
  for (const message of messages) {
    tokens += claudeTokens(message.text);
    for (const tool of message.toolUses) {
      tokens += claudeTokens(JSON.stringify(tool.input) ?? '');
      if (!explicit.has(tool.tool_use_id) && tool.text !== undefined) tokens += claudeTokens(tool.text);
    }
    for (const result of message.toolResults ?? []) tokens += claudeTokens(result.text);
  }
  return tokens;
}

/** A user message sent mid-turn, recorded by the hook; `after` is the last call it saw. */
export type QueuedPrompt = { text: string; after?: string; at: number };

export const QUEUED_PREFIX = 'The user sent a new message while you were working:\n';

/**
 * Puts mid-turn user messages back as text of the tool_result message that
 * follows the call they arrived after. The engine files them as attachments
 * under that row, which the rebuild does not carry. A message already present
 * as user text is left alone; one without a place stays recorded.
 */
export function restoreQueuedPrompts<T extends Message & { handle?: string }>(
  messages: readonly T[],
  queued: readonly QueuedPrompt[],
): { messages: T[]; restored: QueuedPrompt[]; present: QueuedPrompt[] } {
  const out = [...messages];
  const restored: QueuedPrompt[] = [];
  const present: QueuedPrompt[] = [];
  // Present: sent as a prompt of its own (after the turn ended), or restored before.
  const isPresent = (text: string) =>
    out.some((m) => m.role === 'user' && (m.text.trim() === text || m.text.includes(QUEUED_PREFIX + text)));
  for (const entry of queued) {
    const text = entry.text.trim();
    if (!text) continue;
    if (isPresent(text)) {
      present.push(entry);
      continue;
    }
    const callAt = entry.after === undefined ? -1 : out.findIndex((m) => m.role === 'assistant' && m.toolUses.some((u) => u.tool_use_id === entry.after));
    if (callAt < 0) continue;
    const exact = out.findIndex((m, i) => i > callAt && (m.toolResults ?? []).some((r) => r.tool_use_id === entry.after));
    const target = exact >= 0 ? exact : out.findIndex((m, i) => i > callAt && isToolResultRow(m));
    if (target < 0) continue;
    const row = out[target]!;
    out[target] = { ...row, text: joinText(row.text, QUEUED_PREFIX + text), handle: undefined };
    restored.push(entry);
  }
  return { messages: out, restored, present };
}
