/** Engine + Jev smoke check on a synthetic session; never reads credentials. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the bundled claude.exe path');
const root = resolve('.git/fastjev-smoke');
mkdirSync(root, { recursive: true });
const id = randomUUID();
const transcript = join(root, `${id}.jsonl`);
const rows = [];
let parentUuid = null;
function add(type, content) {
  const uuid = randomUUID();
  const message = type === 'user' ? { role: type, content }
    : { role: type, content, id: `msg_${uuid}`, model: 'claude-sonnet-4-6', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 30000, output_tokens: 20 } };
  rows.push({ type, uuid, parentUuid, isSidechain: false, message, timestamp: new Date().toISOString(), cwd: process.cwd(), sessionId: id, version: '2.1.275', userType: 'external' });
  parentUuid = uuid;
}
add('user', 'We are comparing old sample reports. Preserve my requirement: never edit production. The next task will need the exact release identifier.');
for (let i = 0; i < 18; i++) {
  const use = `toolu_smoke_${i}`;
  add('assistant', [{ type: 'tool_use', id: use, name: 'Read', input: { file_path: `C:/synthetic/archive/report-${i}.txt` } }]);
  add('user', [{ type: 'tool_result', tool_use_id: use, content: `Historical sample ${i}.\n` + 'Obsolete sample data, already checked and superseded.\n'.repeat(100) + '\nNo errors.' }]);
  add('assistant', `Finished reviewing sample ${i}. It contains no unique finding. All conclusions are recorded here: the sample was obsolete; no action remains on it.`);
}
const keyCall = 'toolu_smoke_pending';
add('assistant', [{ type: 'tool_use', id: keyCall, name: 'Read', input: { file_path: 'C:/synthetic/current-release.txt' } }]);
add('user', [{ type: 'tool_result', tool_use_id: keyCall, content: 'The exact release identifier still needed for the next task is RELEASE-ORION-7392.\n' + 'Current release details remain relevant.\n'.repeat(100) }]);
add('assistant', 'The next reply must use the exact release identifier from the latest tool output; it is deliberately not repeated here.');
add('user', 'All old sample reviews are finished. Now give me the exact current release identifier and the production constraint.');
const expectedTexts = rows.map((row) => row.message.content).flatMap((content) => typeof content === 'string' ? [content]
  : content.filter((block) => block.type === 'text').map((block) => block.text));
writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const settings = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.claude/settings.json'), 'utf8').replace(/^\uFEFF/, ''));
const plugin = 'fast-jev-compaction-local@fast-jev-compaction-local';
const config = {
  env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_AUTO_COMPACT: '1' },
  enabledPlugins: Object.fromEntries([...Object.keys(settings.enabledPlugins ?? {}).map((name) => [name, false]), [plugin, true]]),
  extraKnownMarketplaces: { 'fast-jev-compaction-local': { source: { source: 'directory', path: process.cwd() } } },
  pluginConfigs: { [plugin]: { options: { compactAtPercent: 30, keepThreshold: 0.5, preserveRecentMessages: 12, minReductionRatio: 0, compactAssistantText: false } } },
  hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `node "${resolve('guard/block-builtin-compact.mjs').replaceAll('\\', '/')}"`, timeout: 10 }] }] },
};
const settingsPath = join(root, 'settings.json');
writeFileSync(settingsPath, JSON.stringify(config, null, 2));
const args = ['-p', '/compact', '--resume', transcript, '--fork-session', '--setting-sources', 'user', '--settings', settingsPath,
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1', '--output-format', 'stream-json', '--verbose'];
if (process.argv.includes('--source')) args.push('--plugin-dir', process.cwd());
const started = Date.now();
const child = spawn(binary, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', (data) => { stdout += data; });
child.stderr.on('data', (data) => { stderr += data; });
const timeout = setTimeout(() => child.kill(), 180000);
child.on('close', (code) => {
  clearTimeout(timeout);
  writeFileSync(join(root, 'last-run.jsonl'), stdout);
  // The fixture is synthetic; only plugin notices and the command's result are printed.
  const messages = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const boundary = messages.find((m) => m.subtype === 'compact_boundary');
  const session = messages.find((m) => m.type === 'result')?.session_id;
  const project = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const sessionPath = session ? join(process.env.USERPROFILE, '.claude/projects', project, `${session}.jsonl`) : '';
  let verification;
  if (sessionPath && existsSync(sessionPath)) {
    const saved = readFileSync(sessionPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const edge = saved.findLastIndex((row) => row.subtype === 'compact_boundary');
    const active = edge >= 0 ? saved.slice(edge + 1) : [];
    const plain = active.flatMap((row) => typeof row.message?.content === 'string' ? [row.message.content]
      : Array.isArray(row.message?.content) ? row.message.content.filter((b) => b.type === 'text').map((b) => b.text) : []);
    const outputs = active.flatMap((row) => Array.isArray(row.message?.content) ? row.message.content.filter((b) => b.type === 'tool_result') : []);
    verification = {
      allDialoguePreserved: expectedTexts.every((value) => plain.includes(value)),
      requiredResultPreserved: outputs.some((b) => b.tool_use_id === keyCall && JSON.stringify(b.content).includes('RELEASE-ORION-7392')),
      noClaudeSummary: !active.some((row) => row.isCompactSummary) && !saved[edge]?.compactMetadata?.preservedSegment,
      resultCharsBefore: rows.flatMap((row) => Array.isArray(row.message.content) ? row.message.content.filter((b) => b.type === 'tool_result') : []).reduce((n, b) => n + b.content.length, 0),
      resultCharsAfter: outputs.reduce((n, b) => n + (typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content).length), 0),
    };
  }
  const passed = code === 0 && boundary && verification?.allDialoguePreserved && verification.requiredResultPreserved && verification.noClaudeSummary && verification.resultCharsAfter < verification.resultCharsBefore;
  if (!passed) process.exitCode = 1;
  console.log(JSON.stringify({ code, elapsedMs: Date.now() - started, fixture: transcript,
    passed: !!passed, verification,
    events: messages.filter((m) => m.type === 'result' || m.compact_result || m.compact_metadata || JSON.stringify(m).includes('fast-jev ')).map((m) => ({
      type: m.type, subtype: m.subtype, result: m.result, message: m.message, text: m.text, content: m.content,
      sessionId: m.session_id, usage: m.usage, error: m.error,
      compactResult: m.compact_result, compactMetadata: m.compact_metadata,
    })), stderr: stderr.slice(-1200) }, null, 2));
});
