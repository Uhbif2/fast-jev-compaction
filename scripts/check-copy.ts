/** Live compact on a FORK; the original transcript is hash-checked, never written. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { activeMessages } from './replay.js';
import { messageChars } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';

const [binary, source] = process.argv.slice(2);
if (!binary || !source) throw new Error('Usage: npx tsx scripts/check-copy.ts <bundled-claude.exe> <transcript.jsonl>');
const hash = (): string => createHash('sha256').update(readFileSync(source)).digest('hex');
const beforeHash = hash();
const before = activeMessages(source);
const settings = resolve('.git/fastjev-smoke/settings.json');
let resumePath = resolve(source);
if (process.argv.includes('--normalized')) {
  const sessionId = randomUUID();
  let parentUuid: string | null = null;
  const rows = before.map((m, index) => {
    const uuid = randomUUID();
    const content: object[] = m.text ? [{ type: 'text', text: m.text }] : [];
    content.push(...m.toolUses.map((t) => ({ type: 'tool_use', id: t.tool_use_id, name: t.tool, input: t.input })));
    content.push(...(m.toolResults ?? []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text, is_error: !!r.isError })));
    const row = { uuid, parentUuid, type: m.role, isSidechain: false, sessionId, cwd: process.cwd(),
      timestamp: new Date(Date.now() - before.length * 1000 + index * 1000).toISOString(), version: '2.1.275', userType: 'external',
      message: { role: m.role, content, ...(m.role === 'assistant' ? { id: `msg_${uuid}`, type: 'message', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } : {}) } };
    parentUuid = uuid;
    return JSON.stringify(row);
  });
  resumePath = resolve(`.git/fastjev-smoke/${sessionId}.jsonl`);
  writeFileSync(resumePath, rows.join('\n') + '\n');
}
const args = ['-p', '/compact', '--resume', resumePath, '--fork-session', '--setting-sources', 'user', '--settings', settings,
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1', '--output-format', 'stream-json', '--verbose'];
const started = Date.now();
const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let stderr = '';
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { stderr += data; });
const timer = setTimeout(() => child.kill(), 175000);
child.on('close', (code) => {
  clearTimeout(timer);
  const events = output.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.find((e) => e.type === 'result');
  const boundary = events.find((e) => e.subtype === 'compact_boundary');
  const project = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const sessionPath = result?.session_id ? join(process.env.USERPROFILE!, '.claude/projects', project, `${result.session_id}.jsonl`) : undefined;
  let verification;
  if (boundary && sessionPath) {
    const loaded = activeMessages(sessionPath, true);
    const after = activeMessages(sessionPath);
    const callsBefore = collectToolCalls(loaded, 12);
    const callsAfter = new Set(collectToolCalls(after, 0).map((call) => call.tool_use_id));
    const textsAfter = after.map((m) => m.text);
    // Ordered subsequence tolerates new command notices but never missing dialogue.
    let index = 0;
    let allDialoguePreserved = true;
    for (const message of loaded.filter((m) => m.text)) {
      index = textsAfter.indexOf(message.text, index);
      if (index < 0) { allDialoguePreserved = false; break; }
      index++;
    }
    const saved = readFileSync(sessionPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const at = saved.findLastIndex((row) => row.subtype === 'compact_boundary');
    verification = {
      originalUnchanged: hash() === beforeHash,
      sourceMessages: before.length,
      loadedMessages: loaded.length,
      allDialoguePreserved,
      actionRecordsPreserved: callsBefore.filter((call) => call.sideEffects || call.pinned).every((call) => callsAfter.has(call.tool_use_id)),
      noClaudeSummary: !saved.slice(at).some((row) => row.isCompactSummary) && !saved[at]?.compactMetadata?.preservedSegment,
      charsBefore: loaded.reduce((n, m) => n + messageChars(m), 0),
      charsAfter: after.reduce((n, m) => n + messageChars(m), 0),
      callsBefore: callsBefore.length,
      callsAfter: callsAfter.size,
    };
  }
  const passed = code === 0 && verification?.originalUnchanged && verification.allDialoguePreserved && verification.actionRecordsPreserved && verification.noClaudeSummary;
  console.log(JSON.stringify({ code, elapsedMs: Date.now() - started, passed: !!passed, verification,
    sessionId: result?.session_id, compact: boundary?.compact_metadata, result: result?.result,
    stderr: stderr.slice(-500) }, null, 2));
  if (!passed) process.exitCode = 1;
});
