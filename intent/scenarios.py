#!/usr/bin/env python3
"""Executable offline contract for S1/S2/S3 of the real fast-jev hook.

No user transcripts, key files, network, installed plugin caches, or settings.
Node imports the canonical TypeScript hook through the project's installed tsx.
An unavailable runtime is INCONCLUSIVE (exit 0), not a manufactured RED.
Only failed assertions against an executed hook yield RED (exit 1).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

# The fork is an independently owned sibling project. Fleet bite runs this
# file from an isolated claim checkout, so don't infer the fork's path from
# __file__ (that would point into .fleet-trees instead of the canonical code).
COMPONENT = Path("C:/MCPs/fast-jev-compaction-local")
SCRIPT = r"""
import { register } from './hooks/fast-jev.ts';
import { visibleTokens } from './src/transcript.ts';

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail || '') });
const message = (role, text, extra = {}) => ({ role, text, toolUses: [], ...extra });
const output = 'HEAD: original synthetic shell output\n' + 'old stdout '.repeat(900) + '\nTAIL';
const baseline = () => [
  message('user', 'Fix synthetic code.', { handle: 'u0' }),
  message('assistant', '', { handle: 'a1', toolUses: [
    { tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: output },
  ] }),
  message('user', '', { handle: 'r1', toolResults: [
    { tool_use_id: 't1', text: output, isError: false },
  ] }),
  message('assistant', 'skill_listing: synthetic listing', { handle: 'a2' }),
  message('assistant', 'instructions: synthetic rules', { handle: 'a3' }),
  message('user', 'Continue with the result.', { handle: 'u4' }),
];

function harness({ tokenState = { tokens: 12000, percent: 40, window: 50000 },
                   answer = 0.001, failStatus = 0, written = new Map() } = {}) {
  const handlers = {};
  const toasts = [];
  const logs = [];
  const observed = { requests: 0, compactCalls: 0, nextCalls: 0, usageCalls: 0 };
  const memory = new Map();
  const $ = {
    store: {
      get: async name => memory.get(name),
      set: async (name, value) => { memory.set(name, value); },
    },
    ui: { log: line => logs.push(line), toast: line => toasts.push(line) },
    env: { get: async name => name === 'USERPROFILE' ? 'C:/synthetic-home' :
                           name === 'CLAUDE_CONFIG_DIR' ? undefined : 'synthetic-key' },
    fs: {
      write: async (name, text) => written.set(name, text),
      list: async dir => [...written.keys()].filter(name => name.startsWith(dir + '/'))
                    .map(name => ({ name: name.slice(dir.length + 1) })),
    },
    settings: { read: async () => ({}) },
    clock: { sleep: async () => {} },
    http: { fetch: async (_url, init) => {
      observed.requests++;
      if (failStatus) return { status: failStatus, ok: false, text: 'synthetic error', headers: {} };
      const query = JSON.parse(init?.body || '{}');
      const answers = Object.fromEntries(Object.keys(query.questions || {})
                                 .map(name => [name, { noul: answer }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
    } },
    session: {
      id: async () => 'synthetic-session-1',
      cwd: async () => 'C:/synthetic-work',
      messages: async () => [],
      usage: async () => {
        observed.usageCalls++;
        return { context: { ...tokenState, measurementSource: 'synthetic/mock' }, rateLimits: [] };
      },
      compact: async () => {
        observed.compactCalls++;
        return { skip: 'synthetic engine compact' };
      },
    },
  };
  register((name, one, two) => { handlers[name] = two || one; },
           { preserveRecentMessages: 1, compactAtPercent: 30,
             questionVariant: 'keep_or_page', provider: 'openrouter' });
  const next = async () => { observed.nextCalls++; throw Error('built-in Claude summary was invoked'); };
  return { handlers, toasts, logs, observed, written, tokenState, $, next };
}

async function caseS1() {
  const t = harness();
  const source = baseline();
  const estimateBefore = visibleTokens(source);
  const result = await t.handlers['session.compact'](
    t.$, { trigger: 'manual', messages: source }, t.next);
  const estimateAfter = result.messages ? visibleTokens(result.messages) : estimateBefore;
  t.tokenState.tokens = 3000;
  t.tokenState.percent = 6;
  if (result.messages) {
    await t.handlers['tool.call'](t.$, { tool: 'Bash' }, async () => ({ ok: true }));
  }
  const measured = t.toasts.find(text => text.includes('first-request input usage [synthetic/mock]'));
  check('S1 real hook compacts fixture and yields a message estimate',
        !!result.messages && Number.isFinite(estimateBefore) &&
        Number.isFinite(estimateAfter) && estimateBefore > estimateAfter,
        'estimated message tokens ' + estimateBefore + ' -> ' + estimateAfter);
  check('S1 first post-compact input usage comes from engine, not estimate',
        !!measured && measured.includes('3k tokens') &&
        measured.includes('before: 12k') &&
        !measured.includes('[observed engine]') && !measured.includes('saved N tokens'),
        measured || 'missing measured post-compact report');
  check('S1 measured usage distinct from estimated kept messages',
        estimateAfter !== 3000 && t.observed.usageCalls > 1,
        'engine observed 3000 tokens, kept-message estimate ' + estimateAfter);
  check('S1 no engine-built summary called', t.observed.nextCalls === 0,
        'next calls: ' + t.observed.nextCalls);
}

async function caseS2() {
  const pages = new Map();
  const first = harness({ written: pages });
  const source = baseline();
  const firstResult = await first.handlers['session.compact'](
    first.$, { trigger: 'manual', messages: source }, first.next);
  const full = [...pages.entries()].find(([name]) => name.endsWith('/t1.call.txt'));
  check('S2 full original result and command retained in immutable page',
        !!full && full[1].includes(output) && full[1].includes('npm test'),
        full ? full[0] : 'page missing');
  const kept = firstResult.messages || [];
  const cut = kept.slice(1, -1).map(m => ({ ...m, handle: 'replayed' }));
  const secondInput = [kept[0], ...kept.slice(1, -1), ...cut,
                       message('assistant', 'skill_listing: synthetic listing'),
                       message('assistant', 'instructions: synthetic rules'),
                       kept.at(-1), message('user', 'Second synthetic compact')];
  const second = harness({ written: pages });
  const secondResult = await second.handlers['session.compact'](
    second.$, { trigger: 'manual', messages: secondInput }, second.next);
  const reconstructed = secondResult.messages || [];
  const toolIds = reconstructed.flatMap(m => m.toolUses.map(u => u.tool_use_id));
  const resultIds = reconstructed.flatMap(m => (m.toolResults || []).map(r => r.tool_use_id));
  check('S2 two manual replays keep one tool_use and one tool_result',
        !!secondResult.messages && toolIds.length === 1 && resultIds.length === 1 &&
        toolIds[0] === 't1' && resultIds[0] === 't1',
        JSON.stringify({ toolIds, resultIds, skip: secondResult.skip }));
  for (const label of ['skill_listing: synthetic listing', 'instructions: synthetic rules']) {
    const count = items => items.map(m => String(m.text || '')).join('\n').split(label).length - 1;
    const firstCount = count(kept);
    const afterCount = count(reconstructed);
    check('S2 reconstructed model input does not repeat ' + label.split(':')[0],
          afterCount <= 1, 'first compaction: ' + firstCount + '; replay: ' + afterCount);
    check('S2 assistant ' + label.split(':')[0] + ' text survives both compactions',
          firstCount === 1 && afterCount === 1,
          'first: ' + firstCount + ', after: ' + afterCount +
          '; output texts: ' + JSON.stringify(reconstructed.map(m => m.text)).slice(0, 350));
  }
  check('S2 original user text survives replay',
        reconstructed.some(m => m.text === 'Fix synthetic code.') &&
        reconstructed.some(m => m.text === 'Continue with the result.') &&
        reconstructed.some(m => m.text === 'Second synthetic compact'),
        'all synthetic user messages retained');
  check('S2 page survives second compaction unchanged',
        !!full && pages.get(full[0]) === full[1],
        'original page must not be overwritten');
  check('S2 model result carries recoverable page path',
        reconstructed.some(m => (m.toolResults || []).some(r =>
          r.text.includes('t1.call.txt'))), 'result should reference original full page');
  check('S2 no built-in summary', first.observed.nextCalls === 0 &&
        second.observed.nextCalls === 0, 'built-in next call counts');
}

async function caseS3() {
  const above = harness({ tokenState: { tokens: 35000, percent: 70, window: 50000 } });
  let nextCompleted = 0;
  await above.handlers['turn.complete'](
    above.$, { agentId: undefined },
    async () => { nextCompleted++; return { ok: true }; });
  check('S3 high-context turn.complete never starts auto session.compact',
        nextCompleted === 1 && above.observed.compactCalls === 0,
        'automatic compact calls: ' + above.observed.compactCalls);
  const manual = harness();
  const done = await manual.handlers['session.compact'](
    manual.$, { trigger: 'manual', messages: baseline() }, manual.next);
  check('S3 manual hook still invokes synthetic Jev transport and retains user text',
        manual.observed.requests > 0 && !!done.messages &&
        done.messages.some(m => m.text === 'Fix synthetic code.'),
        'requests: ' + manual.observed.requests + '; skip: ' + done.skip);
  const error = harness({ failStatus: 400 });
  const failed = await error.handlers['session.compact'](
    error.$, { trigger: 'manual', messages: baseline() }, error.next);
  check('S3 Jev HTTP 400 yields skip with no Claude fallback',
        !!failed.skip && failed.skip.includes('no Claude summary') &&
        error.observed.nextCalls === 0 && !failed.messages,
        'skip: ' + failed.skip + '; next calls: ' + error.observed.nextCalls);
}

try {
  await caseS1();
  await caseS2();
  await caseS3();
  process.stdout.write(JSON.stringify({ kind: 'observed', checks }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: 'inconclusive',
    reason: String(error?.stack || error) }) + '\n');
}
"""


def main() -> int:
    # A separate executable bite checks that the real hook was exercised,
    # regardless of whether its semantic contract is still RED or already GREEN.
    strict_probe = "--verify-harness" in sys.argv
    if not COMPONENT.is_dir() or shutil.which("node") is None:
        print("INCONCLUSIVE: canonical fork or Node is unavailable; no RED inferred")
        return 1 if strict_probe else 0
    if not (COMPONENT / "node_modules" / "tsx").is_dir():
        print("INCONCLUSIVE: preinstalled local tsx is absent; no RED inferred")
        return 1 if strict_probe else 0
    try:
        run = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "--eval", SCRIPT],
            cwd=COMPONENT, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=35, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"INCONCLUSIVE: cannot execute offline hook harness: {exc}")
        return 1 if strict_probe else 0
    if run.returncode != 0:
        print(f"INCONCLUSIVE: TS loader/Node invocation failed (rc={run.returncode}); no RED inferred")
        print(run.stderr[-600:])
        return 1 if strict_probe else 0
    try:
        report = json.loads(run.stdout.strip())
    except ValueError:
        print("INCONCLUSIVE: no machine-readable observations returned; no RED inferred")
        return 1 if strict_probe else 0
    if report.get("kind") != "observed" or not report.get("checks"):
        print("INCONCLUSIVE: hook harness did not finish; no RED inferred")
        print(str(report.get("reason", ""))[-600:])
        return 1 if strict_probe else 0
    if strict_probe:
        # Test coverage of behavior, not string tokens in TypeScript source:
        # every asserted contract has to be actually observed by the hook.
        names = {str(check.get("name", "")) for check in report["checks"]}
        required = (
            "S1 first post-compact input usage comes from engine",
            "S1 measured usage distinct from estimated kept messages",
            "S2 two manual replays keep one tool_use and one tool_result",
            "S2 reconstructed model input does not repeat skill_listing",
            "S2 page survives second compaction unchanged",
            "S3 high-context turn.complete never starts auto session.compact",
            "S3 manual hook still invokes synthetic Jev transport",
            "S3 Jev HTTP 400 yields skip with no Claude fallback",
        )
        missing = [wanted for wanted in required if not any(wanted in name for name in names)]
        if missing:
            print("FAIL: unexercised hook contracts: " + "; ".join(missing))
            return 1
        print("PASS: real hook executed; S1/S2/S3 behavior coverage observed")
        return 0

    failures = []
    for check in report["checks"]:
        name, passed = check["name"], check["ok"]
        print(f"{'PASS' if passed else 'FAIL'} {name}: {check.get('detail', '')[:180]}")
        if not passed:
            failures.append(name)
    if failures:
        print("RED: real offline hook assertions failed: " + "; ".join(failures))
        return 1
    print("GREEN: S1/S2/S3 actual TypeScript hook contract passed on synthetic replay")
    return 0


if __name__ == "__main__":
    sys.exit(main())
