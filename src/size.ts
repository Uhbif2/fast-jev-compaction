/**
 * Sizes in Claude's tokens, for the ceiling and the size report. The Jev
 * estimator in state.ts is calibrated for Jev's own limits and is the wrong
 * scale here: on real Opus 5.5 requests it counts code and logs 1.3 times
 * too low and Cyrillic text 1.5 times too high. Claude Code's own
 * "compacted to" figure is characters / 4 without the system prompt and the
 * tool schemas, and it reads about half the true size.
 *
 * Calibration (27.09.2026): 422 consecutive request pairs of four Opus 5.5
 * sessions, where the growth of the input between two requests minus the
 * first one's output is exactly the tool results added in between. Two
 * characters per token fits them with a 12% median error per result and no
 * bias between Cyrillic and Latin text (1.02 / 1.00); summed over a
 * compaction the error averages out. Checked against a real compaction
 * (26.09, 430.7k → 316.7k): the report computed this way predicts 309k.
 */
export const CHARS_PER_TOKEN = 2.03;

/** Thinking an old step carried, on average, in the same sessions (440–530 per block). */
export const THINKING_TOKENS_PER_BLOCK = 480;

/**
 * Source of input usage shown to the operator. A synthetic fixture MUST be
 * labeled explicitly so replay tests cannot pass off invented token totals
 * as measurements from Claude's actual session. Both helpers are required by
 * the production hook; include them in the same sealed build as the hook.
 */
export type UsageOrigin = 'engine' | 'synthetic/mock';

export function usageOrigin(context: unknown): UsageOrigin {
  if (context && typeof context === 'object' && 'measurementSource' in context &&
      (context as { measurementSource?: unknown }).measurementSource === 'synthetic/mock') {
    return 'synthetic/mock';
  }
  return 'engine';
}

export function usageSourceText(source: UsageOrigin): string {
  return source === 'synthetic/mock' ? 'synthetic/mock' : 'observed engine';
}

export function claudeTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
