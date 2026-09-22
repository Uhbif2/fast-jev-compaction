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

function jevAnswer(noul: number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }), headers: {} };
  };
}

function engine(setup: {
  fetch?: (url: string, init?: { body?: string }) => Promise<unknown>;
  context?: () => { tokens?: number; percent?: number; window: number };
  compact?: () => Promise<unknown>;
  options?: Record<string, unknown>;
}) {
  const handlers: Record<string, Handler> = {};
  const toasts: string[] = [];
  const order: string[] = [];
  const $ = {
    ui: { log: () => {}, toast: (text: string) => void toasts.push(text) },
    env: { get: async () => 'k' },
    settings: { read: async () => ({}) },
    clock: { sleep: async () => {} },
    http: { fetch: setup.fetch ?? jevAnswer(0.001) },
    session: {
      usage: async () => ({ context: setup.context?.() ?? { window: 1_000_000 }, rateLimits: [] }),
      compact: async () => {
        order.push('compact');
        return (await setup.compact?.()) ?? { skip: 'nothing' };
      },
    },
  };
  register(
    ((name: string, fn: Handler) => {
      handlers[name] = fn;
    }) as never,
    { preserveRecentMessages: 1, compactAtPercent: 30, ...setup.options } as never,
  );
  return { handlers, toasts, order, $ };
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
    expect(result.messages.map((m: SessionMessage) => m.handle)).toEqual(['h0', 'h3', 'h4']);
    expect(toasts.at(-1)).toContain(`fast-jev ${LOCAL_BUILD} [plugin]`);
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

describe('auto-compaction from turn.complete', () => {
  const next = (order: string[]) => async () => {
    order.push('next');
    return { text: 'answer' };
  };

  it('compacts only after the turn is closed, above the threshold, on the main loop', async () => {
    const main = engine({ context: () => ({ tokens: 400_000, percent: 40, window: 1_000_000 }) });
    const answer = await main.handlers['turn.complete']!(main.$, { turnId: 't' }, next(main.order));
    expect(answer).toEqual({ text: 'answer' });
    expect(main.order).toEqual(['next', 'compact']);

    const sub = engine({ context: () => ({ tokens: 400_000, percent: 40, window: 1_000_000 }) });
    await sub.handlers['turn.complete']!(sub.$, { turnId: 't', agentId: 'a1' }, next(sub.order));
    expect(sub.order).toEqual(['next']);

    const low = engine({ context: () => ({ tokens: 200_000, percent: 20, window: 1_000_000 }) });
    await low.handlers['turn.complete']!(low.$, { turnId: 't' }, next(low.order));
    expect(low.order).toEqual(['next']);
  });

  it('waits for real growth before trying again', async () => {
    let tokens = 400_000;
    const { handlers, $, order } = engine({
      context: () => ({ tokens, percent: tokens / 10_000, window: 1_000_000 }),
    });
    await handlers['turn.complete']!($, { turnId: '1' }, next(order));
    tokens = 450_000;
    await handlers['turn.complete']!($, { turnId: '2' }, next(order));
    tokens = 510_000;
    await handlers['turn.complete']!($, { turnId: '3' }, next(order));
    expect(order.filter((o) => o === 'compact')).toHaveLength(2);
  });

  it('makes a failed auto-compaction visible once, then retries quietly', async () => {
    const { handlers, $, order, toasts } = engine({
      context: () => ({ tokens: 400_000, percent: 40, window: 1_000_000 }),
      compact: async () => {
        throw new Error('a turn is running');
      },
    });
    await handlers['turn.complete']!($, { turnId: '1' }, next(order));
    await handlers['turn.complete']!($, { turnId: '2' }, next(order));
    expect(order.filter((o) => o === 'compact')).toHaveLength(2);
    expect(toasts.filter((t) => t.includes('auto-compact did not run'))).toHaveLength(1);
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
    expect(toasts.at(-1)).toMatch(/first request after compaction carried 180k tokens \(before: 400k\)/);
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
