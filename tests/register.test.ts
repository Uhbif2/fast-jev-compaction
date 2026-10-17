import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compactionGoal,
  jevAsker,
  LOCAL_BUILD,
  progressNotice,
  register,
  retryAfterMs,
  sayNotice,
  TOAST_GAP_MS,
  toastGate,
} from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };
type Handler = (...args: any[]) => Promise<any>;

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function transcript(): SessionMessage[] {
  const out = 'export const a = 1;\n'.repeat(100);
  return [
    message('user', 'Fix the failing test.', { handle: 'h0' }),
    message('assistant', '', {
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, text: out }],
      handle: 'h1',
    }),
    message('user', '', { toolResults: [{ tool_use_id: 't1', text: out, isError: false }], handle: 'h2' }),
    message('assistant', 'Done reading.', { handle: 'h3' }),
    message('user', 'go on', { handle: 'h4' }),
  ];
}

function bashTranscript(): SessionMessage[] {
  return transcript().map((m) => ({
    ...m,
    toolUses: m.toolUses.map((u) => ({ ...u, tool: 'Bash', input: { command: 'npm test' } })),
  }));
}

function jevAnswer(noul: number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
  };
}

function engine(setup: {
  failWrites?: boolean;
  sessionMessages?: SessionMessage[];
  fetch?: (url: string, init?: { body?: string }) => Promise<unknown>;
  context?: () => { tokens?: number; percent?: number; window: number };
  compact?: () => Promise<unknown>;
  options?: Record<string, unknown>;
}) {
  const handlers: Record<string, Handler> = {};
  const toasts: string[] = [];
  const order: string[] = [];
  const stored = new Map<string, unknown>();
  const written = new Map<string, string>();
  const $ = {
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => void stored.set(key, JSON.parse(JSON.stringify(value))),
    },
    ui: { log: () => {}, toast: (text: string) => void toasts.push(text) },
    env: { get: async (name: string) => (name === 'USERPROFILE' ? 'C:\\Users\\me' : name === 'CLAUDE_CONFIG_DIR' ? undefined : 'k') },
    fs: {
      write: async (path: string, text: string) => {
        if (setup.failWrites) throw new Error('EACCES');
        written.set(path, text);
      },
      list: async () => [] as { name: string }[],
    },
    settings: { read: async () => ({}) },
    clock: {
      // Synthetic/mock clock: retry delays elapse instantly, but deadline
      // sleeps stay pending until cancelled (unlike an immediate Promise).
      sleep: async (_ms: number, options?: { signal?: AbortSignal }) => {
        if (!options?.signal) return;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    http: { fetch: setup.fetch ?? jevAnswer(0.001) },
    session: {
      id: async () => 'session-1',
      cwd: async () => 'C:\\work\\proj',
      messages: async () => setup.sessionMessages ?? [],
      usage: async () => ({ context: { ...(setup.context?.() ?? { window: 1_000_000 }), measurementSource: 'synthetic/mock' }, rateLimits: [] }),
      compact: async () => {
        order.push('compact');
        return (await setup.compact?.()) ?? { skip: 'nothing' };
      },
    },
  };
  register(
    ((name: string, a: Handler | object, b?: Handler) => {
      handlers[name] = (b ?? a) as Handler;
    }) as never,
    { preserveRecentMessages: 1, compactAtPercent: 30, questionVariant: 'relevance', ...setup.options } as never,
  );
  return { handlers, toasts, order, $, stored, written };
}

describe('session.compact never hands over to the Claude summary', () => {
  const nextNeverCalled = async () => {
    throw new Error('next(event) was called: that is the Claude summary');
  };

  it('skips when nothing is eligible', async () => {
    const { handlers, $ } = engine({});
    const result = await handlers['session.compact']!(
      $,
      { trigger: 'manual', messages: [message('user', 'hi')] },
      nextNeverCalled,
    );
    expect(result.skip).toMatch(/nothing eligible/);
    expect(result.messages).toBeUndefined();
  });

  it('skips when Jev fails', async () => {
    const { handlers, $, toasts } = engine({
      fetch: async () => ({ status: 400, ok: false, text: 'bad', headers: {} }),
    });
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: transcript() }, nextNeverCalled);
    expect(result.skip).toMatch(/failed.*no Claude summary.*400/);
    expect(toasts.at(-1)).toBe(result.skip);
  });

  it('skips when Jev keeps everything', async () => {
    const { handlers, $ } = engine({ fetch: jevAnswer(0.99) });
    const result = await handlers['session.compact']!($, { trigger: 'plugin', messages: transcript() }, nextNeverCalled);
    expect(result.skip).toMatch(/kept everything/);
  });

  it('returns the compacted messages, tagged with the trigger', async () => {
    const { handlers, $, toasts } = engine({});
    const result = await handlers['session.compact']!($, { trigger: 'plugin', messages: transcript() }, nextNeverCalled);
    // User text keeps the engine's own object; assistant text is rebuilt.
    expect(result.messages.map((m: SessionMessage) => m.handle)).toEqual(['h0', undefined, 'h4']);
    expect(toasts.at(-1)).toContain(`fast-jev ${LOCAL_BUILD} [plugin]`);
  });

  it('drops old thinking even when Jev keeps every tool result, and reports the size in Claude tokens', async () => {
    const { handlers, $, toasts } = engine({ fetch: jevAnswer(0.99), context: () => ({ tokens: 400_000, percent: 40, window: 1_000_000 }) });
    const messages = transcript();
    messages.splice(1, 0, message('assistant', '', { handle: 'thinking' }));
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, nextNeverCalled);
    expect(result.messages).toBeDefined();
    expect(result.messages.some((m: SessionMessage) => m.handle === 'thinking')).toBe(false);
    expect(toasts.at(-1)).toMatch(/plugin estimate: context 400k → ≈\d+k tokens \(−\d+k? of messages, ≈−480 of 1 thinking block\(s\); next request still unmeasured\)/);
    expect(toasts.at(-1)).toContain('last-request synthetic/mock usage: 400k tokens');
    expect(toasts.at(-1)).toContain('engine-owned Desktop "saved N tokens" line is not controlled by the plugin');
  });

  it('heals a proven replay without asking Jev and removes exactly one duplicated assistant text', async () => {
    let asked = 0;
    const { handlers, $, toasts } = engine({ fetch: async () => { asked += 1; return { status: 500, ok: false, text: '', headers: {} }; } });
    const once = [
      message('user', 'Check a.ts.', { handle: 'h0' }),
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'short' }], handle: 'h1' }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'short', isError: false }], handle: 'h2' }),
      message('assistant', 'a.ts is fine.', { handle: 'h3' }),
    ];
    // The engine gave the text the SAME source handle on replay: text provenance is proven.
    const replay = once.slice(1).map((m) => ({
      ...m, handle: m.role === 'assistant' && m.text ? m.handle : `${m.handle}-copy`,
    }));
    const result = await handlers['session.compact']!($, {
      trigger: 'manual', messages: [...once, ...replay, message('user', 'next', { handle: 'h9' })],
    }, nextNeverCalled);
    expect(result.skip).toBeUndefined();
    expect(result.messages.flatMap((m: SessionMessage) => m.toolUses.map((t) => t.tool_use_id))).toEqual(['t1']);
    expect(result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.tool_use_id))).toEqual(['t1']);
    expect(result.messages.filter((m: SessionMessage) => m.role === 'assistant' && m.text === 'a.ts is fine.')).toHaveLength(1);
    expect(result.messages.filter((m: SessionMessage) => m.role === 'user' && m.text === 'Check a.ts.').map((m: SessionMessage) => m.handle)).toEqual(['h0']);
    expect(asked).toBe(0);
    expect(toasts.at(-1)).toMatch(/no Jev request needed; 0 page-in\(s\) since the last compaction; 1 duplicated call\(s\) removed; 1 duplicated text\(s\) removed/);
  });

  it('preserves both independent same-text assistant replies despite an adjacent tool replay', async () => {
    let asked = 0;
    const { handlers, $, toasts } = engine({ fetch: async () => { asked += 1; return { status: 500, ok: false, text: '', headers: {} }; } });
    const once = [
      message('user', 'Check a.ts.', { handle: 'h0' }),
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'short' }], handle: 'h1' }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'short', isError: false }], handle: 'h2' }),
      message('assistant', 'a.ts is fine.', { handle: 'h3' }),
    ];
    // A different assistant source handle is NOT proof of text replay.
    const independent = once.slice(1).map((m) => ({ ...m, handle: `${m.handle}-copy` }));
    const result = await handlers['session.compact']!($, {
      trigger: 'manual', messages: [...once, ...independent, message('user', 'next', { handle: 'h9' })],
    }, nextNeverCalled);
    expect(result.skip).toBeUndefined();
    expect(result.messages.flatMap((m: SessionMessage) => m.toolUses.map((t) => t.tool_use_id))).toEqual(['t1']);
    expect(result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.tool_use_id))).toEqual(['t1']);
    // engineMessages joins adjacent assistant rows, but must not drop either source text.
    expect(result.messages.filter((m: SessionMessage) => m.role === 'assistant' && m.text.includes('a.ts is fine.'))
      .map((m: SessionMessage) => m.text)).toEqual(['a.ts is fine.\n\na.ts is fine.']);
    expect(result.messages.filter((m: SessionMessage) => m.role === 'user' && m.text === 'Check a.ts.').map((m: SessionMessage) => m.handle)).toEqual(['h0']);
    expect(result.messages.some((m: SessionMessage) => m.role === 'user' && m.text === 'next' && m.handle === 'h9')).toBe(true);
    expect(asked).toBe(0);
    expect(toasts.at(-1)).toMatch(/no Jev request needed; 0 page-in\(s\) since the last compaction; 1 duplicated call\(s\) removed/);
    // Zero text removals are omitted from the toast rather than printed as a literal 0.
    expect(Number(toasts.at(-1)?.match(/(\d+) duplicated text\(s\) removed/)?.[1] ?? '0')).toBe(0);
  });

  it('refuses while a call still waits for its result', async () => {
    const { handlers, $ } = engine({});
    const messages = [...transcript().slice(0, 4), message('assistant', '', { toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: {} }], handle: 'h9' })];
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, nextNeverCalled);
    expect(result.skip).toMatch(/turn is in progress/);
  });

  it('keeps a message the user sent mid-turn as text at the next compaction', async () => {
    const history = transcript();
    const { handlers, $, stored } = engine({ sessionMessages: history.slice(0, 2) });
    const typed = await handlers['prompt.submit']!(
      $,
      { text: 'also look at b.ts', turnId: 'turn-1', wait: false, origin: { kind: 'sdk' } },
      async (e: { text: string }) => ({ text: e.text }),
    );
    expect(typed).toEqual({ text: 'also look at b.ts' });
    await handlers['prompt.submit']!($, { text: 'idle prompt', wait: false, origin: { kind: 'sdk' } }, async (e: { text: string }) => ({ text: e.text }));
    expect((stored.get('queued-prompts') as Record<string, unknown[]>)['session-1']).toHaveLength(1);

    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: history }, nextNeverCalled);
    const texts = result.messages.map((m: SessionMessage) => m.text);
    expect(texts.some((t: string) => t.endsWith('while you were working:\nalso look at b.ts'))).toBe(true);
    expect(stored.get('queued-prompts')).toEqual({});
  });

  it('pages a shortened result out to a file its note names, and counts reading it back', async () => {
    const { handlers, $, toasts, written } = engine({ fetch: jevAnswer(0.001) });
    const messages = bashTranscript();
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, nextNeverCalled);
    const page = 'C:/Users/me/.claude/fast-jev-pages/session-/t1.call.txt';
    expect(written.get(page)).toContain(`=== result (ok, ${messages[1]!.toolUses[0]!.text!.length} chars) ===
${messages[1]!.toolUses[0]!.text}`);
    expect(written.get(page)).toContain('--- command ---\nnpm test');
    const texts = result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts.some((t: string) => t.includes(`full text: ${page} (Read it when the missing part matters; do not re-run the call for it)`))).toBe(true);

    const allowed = await handlers['tool.check']!($, { tool: 'Read', input: { file_path: page.replaceAll('/', '\\') } }, async () => ({ decision: 'ask' }));
    expect(allowed).toMatchObject({ decision: 'allow' });
    const other = await handlers['tool.check']!($, { tool: 'Read', input: { file_path: 'C:/Users/me/.claude/fast-jev-pages/../settings.json' } }, async () => ({ decision: 'ask' }));
    expect(other).toEqual({ decision: 'ask' });
    await handlers['tool.call']!($, { tool: 'Read', file_path: page }, async () => ({ result: 'x' }));
    await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    expect(toasts.some((t) => /1 page-in\(s\) since the last compaction/.test(t))).toBe(true);
  });

  it('keep_or_page: keeps what Jev keeps, collapses every other old call, asks only about results', async () => {
    const asked: string[] = [];
    const fetch = async (_url: string, init?: { body?: string }) => {
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, { instructions: { target_call: { id: string } } }> };
      asked.push(...Object.keys(questions));
      const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) =>
        [k, { noul: q.instructions.target_call.id === 't1' ? 0.6 : 0.2 }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
    };
    const { handlers, $, toasts } = engine({ fetch, options: { questionVariant: 'keep_or_page', ceilingPercent: 90 } });
    const big = 'export const a = 1;\n'.repeat(100);
    const call = (id: string, command: string, out: string) => [
      message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command, description: `step ${id}` }, text: out }] }),
      message('user', '', { toolResults: [{ tool_use_id: id, text: out, isError: false }] }),
    ];
    const messages = [
      message('user', 'Fix it.'),
      ...call('t1', 'cat a.ts', big),
      ...call('t2', 'cat b.ts', big),
      ...call('t3', 'git status', 'On branch master, nothing to commit, working tree clean. '.repeat(10)),
      message('assistant', 'Read both.'),
      message('user', 'go on'),
    ];
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, nextNeverCalled);
    expect(asked.every((k) => k.startsWith('result_'))).toBe(true);
    const results = new Map(result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r.text])));
    expect(results.get('t1')).toBe(big);
    expect(results.get('t2')).toMatch(/^\[fast-jev-compaction paged out this Bash call/);
    expect(results.get('t3')).toMatch(/^\[fast-jev-compaction paged out this Bash call/);
    expect(toasts.at(-1)).toMatch(/2 old call\(s\) Jev did not keep collapsed to their pages/);
    expect(toasts.at(-1)).not.toMatch(/under the ceiling/);
  });

  it('pages out an old Write input to the page of its call', async () => {
    const { handlers, $, toasts, written } = engine({ fetch: jevAnswer(0.99) });
    const content = 'const x = 1;\n'.repeat(300);
    const messages = [
      message('user', 'Write it.', { handle: 'h0' }),
      message('assistant', '', { toolUses: [{ tool_use_id: 'w1', tool: 'Write', input: { file_path: 'a.ts', content }, text: 'ok' }], handle: 'h1' }),
      message('user', '', { toolResults: [{ tool_use_id: 'w1', text: 'ok', isError: false }], handle: 'h2' }),
      message('assistant', 'Written.', { handle: 'h3' }),
      message('user', 'next', { handle: 'h4' }),
    ];
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages }, nextNeverCalled);
    const page = 'C:/Users/me/.claude/fast-jev-pages/session-/w1.call.txt';
    expect(written.get(page)).toContain(content);
    const input = result.messages[1].toolUses[0].input.content as string;
    expect(input).toContain(`whole call: ${page}`);
    expect(toasts.at(-1)).toMatch(/1 old call input\(s\) paged out/);
  });

  it('collapses kept old calls to stay under the ceiling, and never rewrites a page', async () => {
    const context = () => ({ tokens: 400_000, percent: 40, window: 1_000_000 });
    const { handlers, $, toasts, written } = engine({ fetch: jevAnswer(0.99), context, options: { ceilingPercent: 15 } });
    const page = 'C:/Users/me/.claude/fast-jev-pages/session-/t1.call.txt';
    // A page an earlier compaction wrote holds the whole call; it stays.
    written.set(page, 'the earlier, whole page');
    ($.fs as Record<string, unknown>).list = async (dir: string) =>
      [...written.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) }));
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    expect(written.get(page)).toBe('the earlier, whole page');
    const input = result.messages.flatMap((m: SessionMessage) => m.toolUses).find((t: { tool_use_id: string }) => t.tool_use_id === 't1');
    expect(input.input).toEqual({ command: 'npm test' });
    const text = result.messages.flatMap((m: SessionMessage) => m.toolResults ?? []).find((r: { tool_use_id: string }) => r.tool_use_id === 't1').text;
    expect(text).toMatch(/^\[fast-jev-compaction paged out this Bash call \(input and 2000 chars of output\): C:\/Users\/me\/\.claude\/fast-jev-pages\/session-\/t1\.call\.txt\]\nexport const a = 1;/);
    expect(toasts.at(-1)).toMatch(/1 more collapsed to stay under the ceiling/);
  });

  it('measures what the context carries besides the messages, and aims the next target with it', async () => {
    let context = { tokens: 400_000, percent: 40, window: 1_000_000 };
    const { handlers, $, toasts, stored } = engine({ fetch: jevAnswer(0.99), context: () => context, options: { ceilingPercent: 15 } });
    await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    // Thinking and the engine's own additions leave the 400k far from the
    // messages: only the next request says how much the rest is.
    // Measured at the first tool call: the turn's end would count all it added.
    context = { tokens: 160_000, percent: 16, window: 1_000_000 };
    await handlers['tool.call']!($, { tool: 'Bash', command: 'ls' }, async () => ({ result: 'x' }));
    context = { tokens: 290_000, percent: 29, window: 1_000_000 };
    await handlers['turn.complete']!($, { turnId: 't' }, async () => ({ text: 'answer' }));
    expect(stored.get('after-compaction-overhead')).toHaveLength(1);
    const [overhead] = stored.get('after-compaction-overhead') as number[];
    expect(overhead).toBeGreaterThan(155_000);
    expect(overhead).toBeLessThan(160_000);
    expect(toasts.find((t) => t.includes('first-request input usage [synthetic/mock] 160k'))).toMatch(/outside the kept messages/);

    // Over the 15% target already (≈158k): every old call is collapsed, and the
    // report predicts from the measured overhead, not from 400k.
    context = { tokens: 400_000, percent: 40, window: 1_000_000 };
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    const text = result.messages.flatMap((m: SessionMessage) => m.toolResults ?? []).find((r: { tool_use_id: string }) => r.tool_use_id === 't1').text;
    expect(text).toMatch(/^\[fast-jev-compaction paged out this Bash call/);
    expect(toasts.at(-1)).toMatch(/context 400k → ≈16\dk tokens \(messages ≈/);
  });

  it('leaves the messages alone when the measured overhead leaves room under the target', async () => {
    const { handlers, $, stored } = engine({ fetch: jevAnswer(0.99), context: () => ({ tokens: 400_000, percent: 40, window: 1_000_000 }) });
    stored.set('after-compaction-overhead', [60_000]);
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    const texts = (result.messages ?? []).flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts.some((t: string) => t.startsWith('[fast-jev-compaction paged out'))).toBe(false);
  });

  it('names the transcript when a page cannot be written', async () => {
    const { handlers, $ } = engine({ fetch: jevAnswer(0.001), failWrites: true });
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    const texts = result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts.some((t: string) => t.includes('the original is in C:/Users/me/.claude/projects/C--work-proj/session-1.jsonl'))).toBe(true);
  });

  it('never writes a page when existing pages cannot be enumerated', async () => {
    const { handlers, $, written } = engine({ fetch: jevAnswer(0.001) });
    $.fs.list = async () => { throw new Error('EACCES'); };
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    expect(result.messages).toBeDefined();
    expect(written.size).toBe(0);
    const texts = result.messages.flatMap((m: SessionMessage) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts.some((t: string) => t.includes('the original is in C:/Users/me/.claude/projects/'))).toBe(true);
  });

  it('permits creating the first immutable page in an ENOENT directory', async () => {
    const { handlers, $, written } = engine({ fetch: jevAnswer(0.001) });
    $.fs.list = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    const page = 'C:/Users/me/.claude/fast-jev-pages/session-/t1.call.txt';
    expect(result.messages).toBeDefined();
    expect(written.get(page)).toContain('export const a = 1;');
  });

  it('treats existing page filenames case-insensitively (Windows immutable pages)', async () => {
    const { handlers, $, written } = engine({ fetch: jevAnswer(0.001) });
    $.fs.list = async () => [{ name: 'T1.CALL.TXT' }];
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: bashTranscript() }, nextNeverCalled);
    expect(result.messages).toBeDefined();
    expect(written.size).toBe(0);
  });

  it('never rejects, even when the UI throws', async () => {
    const { handlers, $ } = engine({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    $.ui.toast = () => {
      throw new Error('ui gone');
    };
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: transcript() }, nextNeverCalled);
    expect(result.skip).toMatch(/failed/);
  });
});

describe('manual-only compaction contract', () => {
  const nextNeverCalled = async () => { throw new Error('built-in Claude summary must never run'); };
  const next = (order: string[]) => async () => {
    order.push('next');
    return { text: 'answer' };
  };

  it.each([30, 70, 95])('at %i%% turn.complete makes zero compact or remote Jev calls', async (percent) => {
    let remoteCalls = 0;
    const { handlers, $, order } = engine({
      context: () => ({ tokens: percent * 10_000, percent, window: 1_000_000 }),
      fetch: async () => { remoteCalls += 1; throw new Error('remote Jev must not run'); },
      compact: async () => { throw new Error('session.compact must not run'); },
    });
    for (const agentId of [undefined, 'subagent']) {
      await handlers['turn.complete']!($, { turnId: '1', agentId }, next(order));
    }
    expect(order).toEqual(['next', 'next']);
    expect(remoteCalls).toBe(0);
  });

  it('allows one explicit manual /compact request without built-in fallback', async () => {
    let remoteCalls = 0;
    const { handlers, $, order } = engine({
      context: () => ({ tokens: 700_000, percent: 70, window: 1_000_000 }),
      fetch: async (url, init) => { remoteCalls += 1; return jevAnswer(0.001)(url, init); },
    });
    await handlers['turn.complete']!($, { turnId: '1' }, next(order));
    const manual = await handlers['session.compact']!($, { trigger: 'manual', messages: transcript() }, nextNeverCalled);
    expect(manual.skip).toBeUndefined();
    expect(manual.messages).toBeDefined();
    expect(order).toEqual(['next']);
    expect(remoteCalls).toBe(1);
  });

  it('keeps input intact and skips without Claude summary when Jev returns 503', async () => {
    let remoteCalls = 0;
    const original = transcript();
    const { handlers, $, order } = engine({
      fetch: async () => { remoteCalls += 1; return { status: 503, ok: false, text: 'down', headers: {} }; },
    });
    const failed = await handlers['session.compact']!($, { trigger: 'manual', messages: original }, nextNeverCalled);
    expect(failed.skip).toMatch(/session unchanged, no Claude summary/);
    expect(failed.messages).toBeUndefined();
    expect(original[1]?.toolUses[0]?.text).toContain('export const a = 1;');
    expect(remoteCalls).toBeGreaterThan(0);
    expect(remoteCalls).toBeLessThanOrEqual(6);
    expect(order).not.toContain('compact');
  });

  it('reports what the first request after a compaction really carried', async () => {
    let tokens = 400_000;
    const { handlers, $, order, toasts } = engine({
      context: () => ({ tokens, percent: tokens / 10_000, window: 1_000_000 }),
    });
    const result = await handlers['session.compact']!($, { trigger: 'manual', messages: transcript() }, async () => {
      throw new Error('next(event) was called');
    });
    expect(result.messages).toBeDefined();
    tokens = 180_000;
    await handlers['turn.complete']!($, { turnId: '2' }, next(order));
    expect(toasts.at(-1)).toMatch(/first-request input usage \[synthetic\/mock\] 180k tokens \(before: 400k; −220k, −55%/);
  });
});

describe('notices', () => {
  it('drops progress that comes too soon but always delivers the outcome', async () => {
    let clock = 0;
    const shown: string[] = [];
    const waited: number[] = [];
    const $ = {
      ui: { log: () => {}, toast: (text: string) => void shown.push(text) },
      clock: { sleep: async (ms: number) => { waited.push(ms); clock += ms; } },
    };
    const gate = toastGate(() => clock);
    await sayNotice($, gate, 'start');
    clock += 100;
    progressNotice($, gate, 'request 1/6');
    await sayNotice($, gate, 'failed');
    clock += TOAST_GAP_MS;
    progressNotice($, gate, 'request 2/6');
    expect(shown).toEqual(['start', 'failed', 'request 2/6']);
    expect(waited).toEqual([TOAST_GAP_MS - 100]);
  });
});

describe('Jev transport', () => {
  const ok = { status: 200, ok: true, text: '{"answers":{}}', headers: {} };
  const quiet = () => {};

  it('honours Retry-After on 429 and gives up at once on a permanent error', async () => {
    const waits: number[] = [];
    const replies = [{ status: 429, ok: false, text: 'slow down', headers: { 'retry-after': '2' } }, ok];
    const asker = jevAsker(async () => replies.shift()!, 'k', 'm', quiet, undefined, async (ms) => {
      waits.push(ms);
    });
    await asker.ask('s', {});
    expect(waits).toEqual([2000]);

    let calls = 0;
    const permanent = jevAsker(
      async () => {
        calls += 1;
        return { status: 400, ok: false, text: 'no', headers: {} };
      },
      'k',
      'm',
      quiet,
      undefined,
      async () => {},
    );
    await expect(permanent.ask('s', {})).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('retries transport errors and stops when the wall-clock budget is spent', async () => {
    let calls = 0;
    const flaky = jevAsker(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNRESET');
        return ok;
      },
      'k',
      'm',
      quiet,
      undefined,
      async () => {},
    );
    await flaky.ask('s', {});
    expect(calls).toBe(3);

    const down = jevAsker(
      async () => ({ status: 503, ok: false, text: 'down', headers: {} }),
      'k',
      'm',
      quiet,
      undefined,
      async () => {},
      2_500,
    );
    await expect(down.ask('s', {})).rejects.toThrow(/budget/);
  });

  it('reads Retry-After as seconds or an HTTP date, capped', () => {
    expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterMs({ 'retry-after': '999' })).toBe(30_000);
    expect(retryAfterMs({ 'retry-after': new Date(10_000).toUTCString() }, 5_000)).toBe(5000);
    expect(retryAfterMs({})).toBeUndefined();
  });
});

describe('release hygiene', () => {
  it('keeps the version the same in all four places', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const versions = [
      JSON.parse(read('../package.json')).version,
      JSON.parse(read('../.claude-plugin/plugin.json')).version,
      JSON.parse(read('../.claude-plugin/marketplace.json')).plugins[0].version,
      LOCAL_BUILD,
    ];
    expect(new Set(versions).size).toBe(1);
  });

  it('adds /compact instructions to the default goal', () => {
    const messages = transcript();
    expect(compactionGoal(messages, {}, 'keep the deploy notes')).toBe(
      'keep the deploy notes\nFix the failing test.\ngo on',
    );
    expect(compactionGoal(messages, { goal: 'g' }, '  ')).toBe('g');
  });
});
