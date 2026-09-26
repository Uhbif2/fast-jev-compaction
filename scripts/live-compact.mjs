/**
 * Live /compact on a COPY of a real session, through the engine and the
 * plugin as the marketplace installs it; no model request (only Jev), no
 * change to the source session or to settings.json. Prints the plugin's own
 * notices (counts, scores, sizes) and the integrity check, never content.
 *
 *   node scripts/live-compact.mjs <bundled claude.exe> <session.jsonl> [--rows N] [opt:keepThreshold=0.65 ...]
 *
 * --rows N keeps the first N lines, e.g. the state just before a boundary.
 * opt:key=value overrides a plugin option for this run only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const [binary, source, ...rest] = process.argv.slice(2);
if (!binary || !source) throw new Error('Usage: node scripts/live-compact.mjs <claude.exe> <session.jsonl> [--rows N] [opt:key=value]');
const root = resolve('.git/fastjev-live');
mkdirSync(root, { recursive: true });
const rowsArg = rest.indexOf('--rows');
const limit = rowsArg >= 0 ? Number(rest[rowsArg + 1]) : Infinity;
const id = randomUUID();
const lines = readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, limit);
const copy = join(root, `${id}.jsonl`);
writeFileSync(copy, lines.map((line) => {
  const row = JSON.parse(line);
  if ('sessionId' in row) row.sessionId = id;
  return JSON.stringify(row);
}).join('\n') + '\n');

const settings = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.claude/settings.json'), 'utf8').replace(/^﻿/, ''));
const plugin = 'fast-jev-compaction-local@fast-jev-compaction-local';
const options = { ...(settings.pluginConfigs?.[plugin]?.options ?? {}) };
for (const arg of rest.filter((a) => a.startsWith('opt:'))) {
  const [key, value] = arg.slice(4).split('=');
  options[key] = Number.isFinite(Number(value)) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
}
const settingsPath = join(root, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({
  env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_AUTO_COMPACT: '1' },
  enabledPlugins: Object.fromEntries([...Object.keys(settings.enabledPlugins ?? {}).map((n) => [n, false]), [plugin, true]]),
  pluginConfigs: { [plugin]: { options } },
  hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `node "${resolve('guard/block-builtin-compact.mjs').replaceAll('\\', '/')}"`, timeout: 10 }] }] },
}, null, 2));
const debugFile = join(root, 'debug.log');
writeFileSync(debugFile, '');
const args = ['-p', '/compact', '--resume', copy, '--fork-session', '--setting-sources', 'user', '--settings', settingsPath,
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1',
  '--output-format', 'stream-json', '--verbose', '--debug-file', debugFile];
const child = spawn(binary, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', (d) => { stdout += d; });
const timeout = setTimeout(() => child.kill(), 300_000);
child.on('close', (code) => {
  clearTimeout(timeout);
  const session = stdout.split(/\r?\n/).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .find((m) => m.type === 'result')?.session_id;
  const notices = [...readFileSync(debugFile, 'utf8').matchAll(/\$\.ui\.log: (fast-jev [^\n"]*|decisions[^\n"]*)/g)]
    .map((m) => m[1]).filter((line) => !/Jev request \d/.test(line));
  console.log(JSON.stringify({ code, rows: lines.length, copy, session, notices }, null, 1));
  if (!session) return void (process.exitCode = 1);
  const project = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const written = join(process.env.USERPROFILE, '.claude/projects', project, `${session}.jsonl`);
  const check = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/verify-transcript.ts', written], { encoding: 'utf8' });
  process.stdout.write(check.stdout);
  process.exitCode = check.status ?? 1;
});
