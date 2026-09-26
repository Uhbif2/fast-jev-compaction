import { estimateTokens } from './state.js';
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

/**
 * Removes what a reload of a damaged transcript doubled: a repeated tool_use
 * id and its repeated result (the first occurrence stays), and an assistant
 * text repeated verbatim within the same user turn. User text is never
 * touched. Untouched messages keep their identity.
 */
export function dedupeReplayedHistory<T extends Message>(messages: readonly T[]): Dedupe<T> {
  const uses = new Set<string>();
  const results = new Set<string>();
  let turnTexts = new Set<string>();
  let toolCalls = 0;
  let texts = 0;
  const out: T[] = [];
  for (const message of messages) {
    if (message.role === 'user' && !isToolResultRow(message) && message.text.trim().length > 0) {
      turnTexts = new Set();
    }
    if (message.role === 'assistant') {
      const toolUses = message.toolUses.filter((tool) => !uses.has(tool.tool_use_id));
      for (const tool of toolUses) uses.add(tool.tool_use_id);
      toolCalls += message.toolUses.length - toolUses.length;
      const text = message.text.trim();
      const repeated = text.length > 0 && turnTexts.has(text);
      if (text.length > 0) turnTexts.add(text);
      if (repeated) texts += 1;
      if (toolUses.length === message.toolUses.length && !repeated) {
        out.push(message);
        continue;
      }
      if (toolUses.length === 0 && (repeated || text.length === 0)) continue;
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
  const resultsById = new Map<string, EngineToolResult>();
  for (const message of output) for (const result of message.toolResults ?? []) {
    if (!resultsById.has(result.tool_use_id)) resultsById.set(result.tool_use_id, result);
  }
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
      const explicit = resultsById.get(tool.tool_use_id);
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
 * Tokens of what a message list shows the model, by the Jev estimator: text,
 * tool inputs and results (an inline outcome only where no result row
 * exists). It misses the system prompt, tool schemas, attachments and
 * thinking, so it measures a change, not the context itself.
 */
export function visibleTokens(messages: readonly Message[]): number {
  const explicit = new Set(messages.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id));
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message.text);
    for (const tool of message.toolUses) {
      tokens += estimateTokens(JSON.stringify(tool.input) ?? '');
      if (!explicit.has(tool.tool_use_id) && tool.text !== undefined) tokens += estimateTokens(tool.text);
    }
    for (const result of message.toolResults ?? []) tokens += estimateTokens(result.text);
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
